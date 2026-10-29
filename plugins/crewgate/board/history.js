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
  pageSize: 50,          // sessions per page
  maxPageSize: 100,
  maxScan: 40000,        // directory opens and entries read per request; the rest is ignored (truncated: true)
  maxExamined: 300,      // candidates whose head/tail are read per request (a project filter may skip many)
  maxKids: 100,          // subagent files per session
  maxIds: 20000,         // remembered id -> file entries
  maxInfos: 2000,        // remembered head/tail reads
  tailBytes: 32 * 1024,
};

const SUBAGENT_RE = /([^\\/]+)[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/;

// Reads a directory entry by entry (never the whole listing at once); the open and every entry are charged to
// state.left, and state.truncated is set when the budget ran out.
function eachEntry(dir, state, fn) {
  if (state.left <= 0) { state.truncated = true; return; }
  state.left--;
  let d;
  try { d = fs.opendirSync(dir); } catch { return; }
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (state.left <= 0) { state.truncated = true; return; }
      state.left--;
      fn(e);
    }
  } catch { /* unreadable directory */ } finally { try { d.closeSync(); } catch { /* ignore */ } }
}

const isJsonl = (e) => e.isFile() && e.name.endsWith('.jsonl');

// Claude layout: <root>/<project>/<session>.jsonl and <root>/<project>/<session>/subagents/agent-*.jsonl.
function listClaude(root, out, state) {
  eachEntry(root, state, (e) => {
    const p = path.join(root, e.name);
    if (isJsonl(e)) out.push(p);
    else if (e.isDirectory()) {
      eachEntry(p, state, (s) => {
        const sp = path.join(p, s.name);
        if (isJsonl(s)) out.push(sp);
        else if (s.isDirectory()) {
          const sub = path.join(sp, 'subagents');
          eachEntry(sub, state, (k) => { if (isJsonl(k) && k.name.startsWith('agent-')) out.push(path.join(sub, k.name)); });
        }
      });
    }
  });
}

// Codex layout: <root>/YYYY/MM/DD/rollout-*.jsonl. Date folders that end before `from` (a day of slack for time zones)
// are not opened. Other folders directly under the root are read one level deep, files only.
function listCodex(root, out, state, from) {
  const leaf = (dir) => eachEntry(dir, state, (e) => { if (isJsonl(e)) out.push(path.join(dir, e.name)); });
  const walk = (dir, level, y, m) => eachEntry(dir, state, (e) => {
    const p = path.join(dir, e.name);
    if (isJsonl(e)) { out.push(p); return; }
    if (!e.isDirectory()) return;
    if (level === 0 && !/^\d{4}$/.test(e.name)) { leaf(p); return; }
    if (!/^\d{1,4}$/.test(e.name) || level > 2) return;
    const n = Number(e.name);
    const end = level === 0 ? Date.UTC(n + 1, 0, 1) : level === 1 ? Date.UTC(y, n, 1) : Date.UTC(y, m - 1, n + 1);
    if (from > 0 && end + DAY < from) return;
    if (level === 2) leaf(p); else walk(p, level + 1, level === 0 ? n : y, level === 1 ? n : 0);
  });
  walk(root, 0, 0, 0);
}

function listTree(root, engine, state, from) {
  const out = [];
  if (engine === 'claude') listClaude(root, out, state); else listCodex(root, out, state, from);
  return out;
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

// "<ms>-<12 hex id>" or a bare "<ms>" -> { ms, id }, else null (no cursor).
function parseCursor(v) {
  const m = /^(\d{1,15})(?:-([0-9a-f]{12}))?$/.exec(String(v === undefined || v === null ? '' : v));
  return m ? { ms: Number(m[1]), id: m[2] || '' } : null;
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
  function scan(from) {
    const out = [];
    const state = { left: o.maxScan, truncated: false };
    for (const [root, engine] of roots()) {
      for (const file of listTree(root, engine, state, from)) {
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
  // `activityMs` is the newest time of the session including its subagents (default: the file's own).
  function describe(file, engine, st, { showText = false, activityMs = st.mtimeMs } = {}) {
    const info = infoOf(file, engine, st);
    const id = remember(file, engine, st);
    const row = {
      id,
      engine,
      status: 'done',
      activity: { kind: 'done' },
      lastActivity: new Date(activityMs).toISOString(),
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
    const names = [];
    eachEntry(dir, { left: o.maxKids * 2, truncated: false }, (e) => { if (isJsonl(e) && e.name.startsWith('agent-') && names.length < o.maxKids) names.push(e.name); });
    const out = [];
    for (const n of names.sort()) {
      const f = path.join(dir, n);
      try { out.push({ file: f, st: fs.statSync(f) }); } catch { /* vanished */ }
    }
    return out;
  }

  // page({ days, before, project, size, showText, resolveProject }) ->
  //   { groups: [{ row, kids: [{ id, parent }] }], next, truncated }
  // Sessions (top-level, newest first) whose newest file (own or a subagent's) was touched within `days`.
  // Order is (whole-millisecond mtime, session id) descending. `next` is the cursor of the last session looked at,
  // "<ms>-<id>", or null at the end; `before` takes it back (a bare "<ms>" means strictly older than that
  // millisecond), so a tie of any size is never skipped or repeated, wherever a page ends.
  function page({ days = o.defaultDays, before, project = '', size = o.pageSize, showText = false, resolveProject = null } = {}) {
    const d = Math.min(o.maxDays, Math.max(1, Math.floor(days) || o.defaultDays));
    const want = Math.min(o.maxPageSize, Math.max(1, Math.floor(size) || o.pageSize));
    const from = now() - d * DAY;
    const { files, truncated } = scan(from);
    const cut = parseCursor(before);

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
    for (const g of cands) { g.ms = Math.floor(g.mtime); g.cid = hashId(g.file); }
    cands.sort((a, b) => b.ms - a.ms || (a.cid < b.cid ? 1 : a.cid > b.cid ? -1 : 0));

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
      if (cut && !(g.ms < cut.ms || (g.ms === cut.ms && g.cid < cut.id))) continue;
      if (picked.length >= want || examined >= o.maxExamined) break;
      examined++;
      const row = describe(g.file, g.engine, g.st, { showText, activityMs: g.mtime });
      row.project = projectOf(row.cwd);
      if (project === '-' ? row.project : project && row.project !== project) continue;
      picked.push({ g, row });
    }
    const next = i < cands.length && i > 0 ? `${cands[i - 1].ms}-${cands[i - 1].cid}` : null;

    return {
      groups: picked.map(({ g, row }) => {
        const kids = g.engine === 'claude' && !row.subagent
          ? kidsOf(g.file).map((k) => ({ id: remember(k.file, 'claude', k.st), parent: row.id }))
          : [];
        return { row, kids };
      }),
      next,
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
      for (const file of listTree(root, engine, state, 0)) {
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
    const mk = (file, engine, st, activityMs) => {
      const row = describe(file, engine, st, { showText, activityMs });
      if (resolveProject && row.cwd) { try { const p = resolveProject(row.cwd); if (p) row.project = p.id; } catch { /* unresolved */ } }
      return row;
    };
    const kidFiles = f.engine === 'claude' && !/[\\/]subagents[\\/]/.test(f.file) ? kidsOf(f.file) : [];
    const activityMs = kidFiles.reduce((m, k) => Math.max(m, k.st.mtimeMs), f.st.mtimeMs);
    const row = mk(f.file, f.engine, f.st, activityMs);
    if (row.parent) { try { fs.statSync(parentOf(f.file)); } catch { row.parent = null; } }
    const kids = kidFiles.map((k) => mk(k.file, 'claude', k.st));
    return { row, kids, file: ids.get(id) };
  }

  return { page, session, fileFor, options: o };
}

module.exports = { createHistory, dayTotals, dayOf, parseCursor, DEFAULTS };
