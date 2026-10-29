'use strict';

// Session history: transcripts older than the 24-hour list window of the watcher. Files are found by
// mtime (a directory walk plus one stat per file, capped), never read whole: a page row needs the head
// and tail of its file (cwd, model, branch) and the statistics come from session-stats with its own
// byte budget. Ids are hashId(file), the same scheme as the Sessions page, so #/s/<id> works for a
// history session too: the module keeps a bounded id -> file map and can find an id again by hashing
// the paths of the roots.
const fs = require('fs');
const path = require('path');
const { hashId, readInfo, snippet, DEFAULTS: WATCH } = require('./watcher');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  defaultDays: 7,
  maxDays: 90,
  pageSize: 50,          // sessions per page (a tie on the last mtime may add a few)
  maxPageSize: 100,
  maxScan: 20000,        // transcript files looked at per request; more are ignored (truncated: true)
  maxExamined: 300,      // candidates whose head/tail are read per request (a project filter may skip many)
  maxKids: 100,          // subagent files per session
  maxIds: 20000,         // remembered id -> file entries
  maxInfos: 2000,        // remembered head/tail reads
  tailBytes: 32 * 1024,
};

const SUBAGENT_RE = /([^\\/]+)[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/;

// .jsonl files under a root, at most state.left of them in total (state.truncated tells when more existed).
function listFiles(dir, out, state, depth = 0) {
  if (depth > 6 || state.left <= 0) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(f, out, state, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      if (state.left <= 0) { state.truncated = true; return; }
      state.left--;
      out.push(f);
    }
  }
}

const parentOf = (file) => {
  const m = SUBAGENT_RE.exec(file);
  return m ? path.join(path.dirname(path.dirname(path.dirname(file))), `${m[1]}.jsonl`) : null;
};

// Calendar day (YYYY-MM-DD) of a time for a viewer `tz` minutes east of UTC.
const dayOf = (ms, tz) => new Date(ms + tz * 60000).toISOString().slice(0, 10);

// Per-day totals of rows that carry stats (totals when the row has subagents). Rows are newest first, so are the days.
function dayTotals(rows, tz = 0) {
  const days = new Map();
  for (const r of rows) {
    const day = dayOf(Date.parse(r.lastActivity), tz);
    let d = days.get(day);
    if (!d) { d = { day, sessions: 0, duration_ms: 0, prompts: 0, tool_calls: 0, tokens: 0, cost: null, cost_complete: true, partial: false }; days.set(day, d); }
    const s = r.totals || r.stats;
    d.sessions++;
    if (!s) { d.partial = true; continue; }
    d.duration_ms += s.duration_ms;
    d.prompts += s.prompts;
    d.tool_calls += s.tool_calls;
    d.tokens += s.tokens.input + s.tokens.output + s.tokens.cache_write + s.tokens.cache_read;
    if (s.cost !== null) d.cost = (d.cost || 0) + s.cost;
    if (!s.cost_complete) d.cost_complete = false;
    if (s.partial) d.partial = true;
  }
  for (const d of days.values()) if (d.cost !== null) d.cost = Math.round(d.cost * 1e6) / 1e6;
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

// opts: { claudeRoot, codexRoot, now } plus the DEFAULTS above. A missing root is simply not listed.
function createHistory(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const ids = new Map();     // id -> { file, engine, size, mtimeMs }
  const infos = new Map();   // file -> { key, info }
  const reads = { ...WATCH, tailBytes: o.tailBytes };

  const roots = () => [[o.claudeRoot, 'claude'], [o.codexRoot, 'codex']].filter((r) => r[0]);

  function remember(file, engine, st) {
    const id = hashId(file);
    ids.delete(id);
    ids.set(id, { file, engine, size: st.size, mtimeMs: st.mtimeMs });
    while (ids.size > o.maxIds) ids.delete(ids.keys().next().value);
    return id;
  }
  const fileFor = (id) => ids.get(String(id)) || null;

  // Every transcript with its stat: [{ file, engine, st }], and whether the cap cut the list.
  function scan() {
    const out = [];
    const state = { left: o.maxScan, truncated: false };
    for (const [root, engine] of roots()) {
      const list = [];
      listFiles(root, list, state);
      for (const file of list) {
        try { out.push({ file, engine, st: fs.statSync(file) }); } catch { /* vanished */ }
      }
    }
    return { files: out, truncated: state.truncated };
  }

  function infoOf(file, engine, st) {
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = infos.get(file);
    if (hit && hit.key === key) return hit.info;
    const info = readInfo(file, engine, st.size, reads);
    infos.set(file, { key, info });
    while (infos.size > o.maxInfos) infos.delete(infos.keys().next().value);
    return info;
  }

  // A row shaped like the watcher's (the API strips cwd/session). Text snippets only with showText.
  function describe(file, engine, st, { showText = false } = {}) {
    const info = infoOf(file, engine, st);
    const id = remember(file, engine, st);
    const row = {
      id,
      engine,
      status: 'done',
      activity: { kind: 'done' },
      lastActivity: new Date(st.mtimeMs).toISOString(),
      model: info.model,
      subagent: info.subagent,
      session: info.sessionId,
      parent: info.parentFile ? hashId(info.parentFile) : null,
      role: null,
      task: null,
      cwd: info.cwd,
      folder: info.cwd ? path.basename(info.cwd.replace(/[\/]+$/, '')) : null,
      project: null,
      branch: info.gitBranch || null,
      detached: false,
      worktree: null,
    };
    if (showText === true) {
      if (info.text) row.last_reply = snippet(info.text);
      if (info.prompt) row.last_prompt = snippet(info.prompt);
      if (info.title) row.title = snippet(info.title);
    }
    return row;
  }

  // The subagent transcripts of a Claude session file: [{ file, st }].
  function kidsOf(file) {
    const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names.sort()) {
      if (out.length >= o.maxKids) break;
      if (!/^agent-.+\.jsonl$/.test(n)) continue;
      const f = path.join(dir, n);
      try { out.push({ file: f, st: fs.statSync(f) }); } catch { /* vanished */ }
    }
    return out;
  }

  // page({ days, before, project, size, showText, resolveProject }) ->
  //   { groups: [{ row, kids: [{ id, parent }] }], next, truncated }
  // Sessions (top-level, newest first) whose newest file was touched within `days` and before `before` (ms).
  // `next` is the cursor for the following page (the mtime of the last session looked at) or null.
  function page({ days = o.defaultDays, before, project = '', size = o.pageSize, showText = false, resolveProject = null } = {}) {
    const d = Math.min(o.maxDays, Math.max(1, Math.floor(days) || o.defaultDays));
    const want = Math.min(o.maxPageSize, Math.max(1, Math.floor(size) || o.pageSize));
    const from = now() - d * DAY;
    const { files, truncated } = scan();

    // group by session: a subagent file belongs to its parent session's file
    const groups = new Map();   // session file -> { file, engine, st, mtime, kids }
    for (const f of files) {
      if (f.st.mtimeMs < from) continue;
      const par = f.engine === 'claude' ? parentOf(f.file) : null;
      const key = par || f.file;
      let g = groups.get(key);
      if (!g) { g = { file: key, engine: f.engine, st: null, mtime: 0, loose: [] }; groups.set(key, g); }
      g.mtime = Math.max(g.mtime, f.st.mtimeMs);
      if (par) g.loose.push(f); else g.st = f.st;
    }
    const cands = [];
    for (const g of groups.values()) {
      if (!g.st && g.loose.length) {
        try { g.st = fs.statSync(g.file); } catch { /* parent gone: the subagent files stand alone */ }
      }
      if (g.st) cands.push(g);
      else for (const f of g.loose) cands.push({ file: f.file, engine: f.engine, st: f.st, mtime: f.st.mtimeMs, loose: [] });
    }
    cands.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1));

    const known = new Map();   // cwd -> project id
    const projectOf = (cwd) => {
      if (!resolveProject || !cwd) return null;
      if (!known.has(cwd)) {
        let id = null;
        try { const p = resolveProject(cwd); if (p) id = p.id; } catch { /* unresolved */ }
        known.set(cwd, id);
      }
      return known.get(cwd);
    };

    const picked = [];
    let i = 0;
    let examined = 0;
    for (; i < cands.length; i++) {
      const g = cands[i];
      if (before !== undefined && g.mtime >= before) continue;
      // fill the page, but never split sessions that share the last mtime (the cursor is a strict "older than")
      if (picked.length >= want && g.mtime !== picked[picked.length - 1].mtime) break;
      if (examined >= o.maxExamined) break;
      examined++;
      const row = describe(g.file, g.engine, g.st, { showText });
      row.project = projectOf(row.cwd);
      if (project === '-' ? row.project : project && row.project !== project) continue;
      picked.push({ g, row, mtime: g.mtime });
    }
    const next = i < cands.length ? cands[i - 1].mtime : null;

    return {
      groups: picked.map(({ g, row }) => {
        const kids = g.engine === 'claude' && !row.subagent
          ? kidsOf(g.file).map((k) => ({ id: remember(k.file, 'claude', k.st), parent: row.id }))
          : [];
        return { row, kids };
      }),
      next: next === null || next === undefined ? null : next,
      truncated,
    };
  }

  // The file of an id: remembered, else found by hashing the paths under the roots (so a bookmarked
  // #/s/<id> works after a restart). Never takes a path from the caller.
  function locate(id) {
    const hit = ids.get(id);
    if (hit) { try { const st = fs.statSync(hit.file); return { file: hit.file, engine: hit.engine, st }; } catch { ids.delete(id); } }
    const state = { left: o.maxScan, truncated: false };
    for (const [root, engine] of roots()) {
      const list = [];
      listFiles(root, list, state);
      for (const file of list) {
        if (hashId(file) !== id) continue;
        try { return { file, engine, st: fs.statSync(file) }; } catch { return null; }
      }
    }
    return null;
  }

  // session(id, { showText, resolveProject }) -> { row, kids: [row], file } or null.
  function session(id, { showText = false, resolveProject = null } = {}) {
    if (!/^[0-9a-f]{12}$/.test(String(id))) return null;
    const f = locate(id);
    if (!f) return null;
    const mk = (file, engine, st) => {
      const row = describe(file, engine, st, { showText });
      if (resolveProject && row.cwd) { try { const p = resolveProject(row.cwd); if (p) row.project = p.id; } catch { /* unresolved */ } }
      return row;
    };
    const row = mk(f.file, f.engine, f.st);
    if (row.parent) { try { fs.statSync(parentOf(f.file)); } catch { row.parent = null; } }
    const kids = f.engine === 'claude' && !row.subagent ? kidsOf(f.file).map((k) => mk(k.file, 'claude', k.st)) : [];
    return { row, kids, file: ids.get(id) };
  }

  return { page, session, fileFor, options: o };
}

module.exports = { createHistory, dayTotals, dayOf, DEFAULTS };
