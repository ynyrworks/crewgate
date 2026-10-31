'use strict';

// Board API: routes are plain functions of (params, query, body). The HTTP layer (server.js)
// owns security, parsing and serialisation; nothing here touches sockets.
const fs = require('fs');
const path = require('path');
const paths = require('../lib/core/paths');
const projects = require('../lib/core/project');
const config = require('../lib/core/config');
const tasks = require('../lib/core/tasks');
const store = require('../lib/core/store');
const gates = require('../lib/core/gates');
const plans = require('../lib/core/plans');
const planReview = require('../lib/core/plan-review');
const hookseen = require('../lib/core/hookseen');
const accountLib = require('../lib/core/account');
const { CrewError } = require('../lib/core/errors');
const { t } = require('../lib/core/i18n');
const { createWatcher } = require('./watcher');
const { createSessionEnds } = require('./session-ends');
const { createUsage } = require('./usage');
const { createSessionStats, sumStats, topTools } = require('./session-stats');
const { timeline: buildTimeline, crewEventsIn, KINDS: TIMELINE_KINDS } = require('./session-timeline');
const { hashId } = require('./watcher');
const { createHistory, dayTotals, dayOf } = require('./history');

class ApiError extends Error {
  constructor(status, key, vars, extra) {
    super(key);
    this.status = status;
    this.key = key;
    this.vars = vars || {};
    this.extra = extra || {};
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SRC = { src: 'board' };
const EVENT_TAIL_BYTES = 256 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------- small readers (read-only)
function readDirJson(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    try { out.push({ name: n, data: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }); } catch { /* unreadable or corrupt: skipped */ }
  }
  return out;
}

// Newest `limit` events from the end of events.jsonl without reading the whole file.
function tailEvents(projectId, limit) {
  const file = paths.eventsFile(projectId);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - EVENT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (e && typeof e.type === 'string') out.push(e); } catch { /* malformed line */ }
    }
    return out.slice(-limit);
  } catch { return []; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Newest-first events of the given types, read backwards from the end of events.jsonl in chunks. Bounded in work
// (`maxBytes`) and in result (`want(type)` says how many of each type are still wanted), so a merge far back is found
// without reading the whole file and without depending on the 40-event tail the page also gets.
const ACTIVITY_SCAN_BYTES = 8 * 1024 * 1024;
function scanBack(projectId, quota, maxBytes) {
  const left = { ...quota };
  const out = [];
  const open = () => Object.values(left).some((n) => n > 0);
  let fd;
  try {
    fd = fs.openSync(paths.eventsFile(projectId), 'r');
    const size = fs.fstatSync(fd).size;
    const CH = 256 * 1024;
    let pos = size;
    let rest = Buffer.alloc(0);
    while (pos > 0 && size - pos < maxBytes && open()) {
      const len = Math.min(CH, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      rest = Buffer.concat([buf, rest]);
      let cut = rest.indexOf(10);
      if (pos > 0 && cut < 0) continue;            // one very long line: read more before judging it
      const head = pos > 0 ? rest.subarray(0, cut) : null; // incomplete first line, completed by the next chunk
      const body = pos > 0 ? rest.subarray(cut + 1) : rest;
      rest = head || Buffer.alloc(0);
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && open(); i--) {
        if (!lines[i]) continue;
        try {
          const e = JSON.parse(lines[i]);
          if (e && typeof e.type === 'string' && left[e.type] > 0) { left[e.type]--; out.push(e); }
        } catch { /* malformed line */ }
      }
    }
  } catch { /* no events yet */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return out;
}

function findingsOf(list) {
  if (Array.isArray(list)) return list;
  if (isObj(list) && Array.isArray(list.findings)) return list.findings;
  return [];
}

// Review statistics per task from findings/*.json (formats: DESIGN section 9).
function reviewStats(projectId, taskId) {
  const dir = path.join(paths.taskDir(projectId, taskId), 'findings');
  const stats = { rounds: 0, raw: 0, filtered: 0, final: 0, upheld: 0, uncertain: 0, refuted: 0, by_category: {} };
  const rounds = new Set();
  for (const { name, data } of readDirJson(dir)) {
    let m = /^(.+)\.raw\.json$/.exec(name);
    if (m) { rounds.add(m[1]); stats.raw += findingsOf(data).length; continue; }
    m = /^(.+)\.filtered\.json$/.exec(name);
    if (m) { rounds.add(m[1]); stats.filtered += findingsOf(data).length; continue; }
    m = /^([^.]+)\.json$/.exec(name); // N.json only: N.kept.json and N.refutations.json are intermediate
    if (!m) continue;
    rounds.add(m[1]);
    for (const f of findingsOf(data)) {
      if (!isObj(f)) continue;
      stats.final++;
      const v = f.verdict || f.refutation;
      if (v === 'uncertain') stats.uncertain++; else if (v === 'refuted') stats.refuted++; else stats.upheld++;
      const c = typeof f.category === 'string' ? f.category : 'other';
      stats.by_category[c] = (stats.by_category[c] || 0) + 1;
    }
  }
  stats.rounds = rounds.size;
  return stats;
}

const LESSON_RE = /^- (\d{4}-\d{2}-\d{2}) \[([\w-]+)\] ([^:]+?): (.*)$/;

// Lessons from <repo>/.crew/LESSONS.md with promotion-candidate counts.
function lessonsOf(root, promoteAfterDays) {
  const out = { exists: false, total: 0, candidates: 0, keys: [], recent: [] };
  let raw;
  try {
    const file = path.join(root, '.crew', 'LESSONS.md');
    if (fs.statSync(file).size > 1024 * 1024) return out;
    raw = fs.readFileSync(file, 'utf8');
  } catch { return out; }
  out.exists = true;
  const byKey = new Map();
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = LESSON_RE.exec(line);
    if (!m) continue;
    const e = { date: m[1], kind: m[2], key: m[3].trim(), text: m[4] };
    entries.push(e);
    let k = byKey.get(e.key);
    if (!k) { k = { key: e.key, count: 0, days: new Set(), first: e.date, last: e.date }; byKey.set(e.key, k); }
    k.count++;
    k.days.add(e.date);
    if (e.date < k.first) k.first = e.date;
    if (e.date > k.last) k.last = e.date;
  }
  out.total = entries.length;
  out.keys = [...byKey.values()].map((k) => ({ key: k.key, count: k.count, days: k.days.size, first: k.first, last: k.last, candidate: k.days.size >= promoteAfterDays }))
    .sort((a, b) => b.days - a.days || b.count - a.count || (a.key < b.key ? -1 : 1));
  out.candidates = out.keys.filter((k) => k.candidate).length;
  out.recent = entries.slice(-10).reverse();
  return out;
}

// Plans from <repo>/.crew/plans/*.md, read on every request (small, capped; see plans.js).
function plansOf(root, projectId) {
  const states = plans.taskStates(projectId);
  const out = [];
  for (const slug of plans.slugs(root)) {
    const doc = plans.readCapped(root, slug);
    if (!doc) continue;
    const d = plans.derive(doc, states);
    out.push({ slug, title: d.title, ...d.summary, pending: d.summary.proposed, updated: doc.mtime, truncated: d.truncated });
  }
  return out;
}

// The plan page: the derived tree, the proposals waiting for a decision (with what the review rounds said about
// them) and the round history. The reviewer's claim, evidence and the refuter's reasoning are free text from a model:
// they follow board.show_text like other snippets (opts.showText); step text and the commands are not hidden here
// (private mode hides them in the page).
function planOf(root, projectId, slug, opts = {}) {
  if (!plans.SLUG_RE.test(String(slug))) throw new ApiError(404, 'api.notFound');
  const doc = plans.readCapped(root, slug);
  if (!doc) throw new ApiError(404, 'api.notFound');
  const show = opts.showText === true;
  const proposals = planReview.proposalsOf(projectId, slug, doc).map((p) => (show ? p : {
    ...p, claim: null, evidence: [], refutation: null, better: null,
  }));
  return {
    slug, ...plans.derive(doc, plans.taskStates(projectId)), updated: doc.mtime, show_text: show,
    proposals, rounds: planReview.roundsOf(projectId, slug),
  };
}

function handoffsOf(projectId) {
  const out = {};
  for (const state of paths.HANDOFF_STATES) {
    out[state] = readDirJson(paths.handoffDir(projectId, state)).map(({ name, data }) => ({
      id: name.replace(/\.json$/, ''),
      title: typeof data.title === 'string' ? data.title : '',
      task: typeof data.task === 'string' ? data.task : null,
      created: typeof data.created === 'string' ? data.created : null,
    }));
  }
  return out;
}

function checkKeys(v, where = '') {
  if (Array.isArray(v)) { v.forEach((x, i) => checkKeys(x, `${where}[${i}]`)); return; }
  if (!isObj(v)) return;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) throw new ApiError(400, 'api.badKey', { path: where ? `${where}.${k}` : k });
    checkKeys(v[k], where ? `${where}.${k}` : k);
  }
}

function str(body, key, max = 2000) {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, 'api.fieldRequired', { field: key });
  if (v.length > max) throw new ApiError(400, 'api.fieldTooLong', { field: key, max });
  return v;
}

// ---------------------------------------------------------------- the API
// opts: { version, watcher, usage, stats }
function createApi(opts = {}) {
  // one shared index (session.end + session.start account ids): the watcher and the API read the same instance
  const accountIndex = opts.sessionEnds || createSessionEnds(() => projects.list().map((p) => paths.eventsFile(p.id)));
  const watcher = opts.watcher || createWatcher({ sessionEnds: accountIndex });
  const usage = opts.usage || createUsage();
  const sessionStats = opts.stats || createSessionStats();
  const history = opts.history || createHistory({ claudeRoot: watcher.claudeRoot, codexRoot: watcher.codexRoot });
  const version = opts.version || '0.0.0';
  const rootCache = new Map();   // cwd -> { at, id }

  const globalCfg = () => config.loadGlobal().config;
  const showText = () => { const c = globalCfg(); return !!(c.board && c.board.show_text === true); };

  function norm(p) {
    let r = paths.canonical(p);
    if (process.platform === 'win32') r = r.toLowerCase();
    return r.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  // Registered project owning a working directory: by path prefix, else (linked worktree) via git.
  function resolveProject(cwd) {
    const list = projects.list();
    const key = norm(cwd);
    let best = null;
    for (const p of list) {
      const r = norm(p.path);
      if ((key === r || key.startsWith(`${r}/`)) && (!best || r.length > best.len)) best = { p, len: r.length };
    }
    if (best) return best.p;
    const hit = rootCache.get(cwd);
    const now = Date.now();
    if (hit && now - hit.at < 5 * 60 * 1000) return hit.id ? list.find((p) => p.id === hit.id) || null : null;
    let id = null;
    try {
      if (fs.existsSync(cwd) && [...rootCache.values()].filter((x) => now - x.at < 1000).length < 4) {
        const root = projects.inspect(cwd).root;
        if (root) id = projects.projectId(root);
      }
    } catch { /* not a repo */ }
    rootCache.set(cwd, { at: now, id });
    return id ? list.find((p) => p.id === id) || null : null;
  }

  // Title of a crewgate task for the sessions list (cached for a few seconds).
  const titleCache = new Map();   // "project:task" -> { at, title }
  function taskTitle(projectId, taskId) {
    const key = `${projectId}:${taskId}`;
    const hit = titleCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < 10000) return hit.title;
    let title = null;
    try { const tk = tasks.load(projectId, taskId); title = tk && typeof tk.title === 'string' ? tk.title : null; } catch { /* unknown task */ }
    titleCache.set(key, { at: now, title });
    if (titleCache.size > 1000) titleCache.delete(titleCache.keys().next().value);
    return title;
  }

  // withStats: adds row.stats (and row.totals, a parent plus its subagents) from the incremental per-file cache.
  function sessionRows({ withStats = false } = {}) {
    const b = globalCfg().board || {};
    const rows = watcher.sessions({
      showText: showText(),
      resolveProject,
      detectClosed: b.detect_closed_transcripts === true,
      idleMs: Number.isInteger(b.session_idle_minutes) ? b.session_idle_minutes * 60 * 1000 : undefined,
      doneMs: Number.isInteger(b.session_done_hours) ? b.session_done_hours * 60 * 60 * 1000 : undefined,
    });
    for (const r of rows) {
      if (r.task && r.project) r.task = { id: r.task.id, title: taskTitle(r.project, r.task.id) };
      else if (r.task) r.task = { id: r.task.id, title: null };
    }
    attachAccounts(rows);
    if (withStats) attachStats(rows);
    return rows;
  }

  // row.account = { id, plan, email, organization } from the session.start event and <home>/accounts.json; absent when unknown.
  function attachAccounts(rows) {
    try {
      accountIndex.refresh();
      const names = accountLib.labels();
      for (const r of rows) {
        const a = r && r.session ? accountIndex.account(r.session) : null;
        if (a) r.account = { id: a.id, plan: a.plan, ...(names[a.id] || {}) };
      }
    } catch { /* the account label is optional */ }
  }

  function attachStats(rows, fileFor = watcher.fileFor) {
    const entries = [];
    for (const r of rows) {
      const f = fileFor ? fileFor(r.id) : null;
      if (f) entries.push({ id: r.id, ...f });
    }
    const g = globalCfg();
    const stats = sessionStats.collect(entries, { prices: isObj(g.prices) ? g.prices : {} });
    const kids = new Map();
    for (const r of rows) if (r.parent) (kids.get(r.parent) || kids.set(r.parent, []).get(r.parent)).push(r.id);
    for (const r of rows) {
      const own = stats.get(r.id);
      if (!own) continue;
      const mine = (kids.get(r.id) || []).map((id) => stats.get(id)).filter(Boolean);
      r.stats = { ...own, tools: topTools(own.tools) };
      if (mine.length) {
        const all = sumStats([own, ...mine]);
        r.totals = { ...all, tools: topTools(all.tools), sessions: mine.length + 1 };
      }
    }
  }

  function publicSession(s) {
    const { cwd, session, ...rest } = s;   // the full path and the raw session id never leave the server
    return rest;
  }

  function projectOr404(id) {
    if (!paths.ID_RE.test(String(id))) throw new ApiError(404, 'api.notFound');
    const p = projects.list().find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'api.notFound');
    return p;
  }

  function lastActivity(id, taskList, sessions) {
    let best = null;
    const bump = (v) => { const ms = Date.parse(v); if (Number.isFinite(ms) && (best === null || ms > best)) best = ms; };
    const ev = tailEvents(id, 1);
    if (ev.length) bump(ev[0].ts);
    for (const tk of taskList) bump(tk.updated);
    for (const s of sessions) bump(s.lastActivity);
    return best === null ? null : new Date(best).toISOString();
  }

  // ---- reads
  function overview() {
    const sessions = sessionRows();
    return {
      projects: projects.list().map((p) => {
        const list = tasks.list(p.id);
        const states = {};
        for (const tk of list) states[tk.state] = (states[tk.state] || 0) + 1;
        const mine = sessions.filter((s) => s.project === p.id);
        const cfg = config.load(p.path);
        return {
          id: p.id,
          name: p.name,
          tasks: states,
          tasks_open: list.filter((tk) => !['merged', 'cancelled'].includes(tk.state)).length,
          needs: store.needList(p.id).length,
          live: {
            sessions: mine.filter((s) => !s.subagent && ['working', 'tool', 'waiting'].includes(s.status)).length,
            subagents: mine.filter((s) => s.subagent && ['working', 'tool'].includes(s.status)).length,
          },
          last_activity: lastActivity(p.id, list, mine),
          config_errors: cfg.errors.length,
        };
      }),
    };
  }

  // Free text a subagent produced (`last`) is shown only when board.show_text is on.
  function publicData(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || showText() || !('last' in d)) return d;
    const { last, ...rest } = d;
    return rest;
  }

  // What the project page can say by itself when the hand-kept cards are empty: the latest merges and pushes (10) and
  // the latest steps of the task flow (15), newest first. Only a few named fields of each event, through publicData.
  // The scan is kept per project while the events file keeps its size and mtime, so the 4 s poll does not redo it.
  const activityCache = new Map();
  function scanCached(projectId, q) {
    let key = '';
    try { const st = fs.statSync(paths.eventsFile(projectId)); key = st.size + ':' + st.mtimeMs; } catch { /* no events yet */ }
    const hit = activityCache.get(projectId);
    if (hit && hit.key === key) return hit.all;
    const all = scanBack(projectId, q, ACTIVITY_SCAN_BYTES);
    activityCache.set(projectId, { key, all });
    return all;
  }

  function activityOf(projectId, taskList) {
    const titles = new Map(taskList.map((tk) => [tk.id, tk.title]));
    const merges = ['task.merged', 'git.push'];
    const steps = ['task.created', 'task.returned', 'task.sent_back', 'task.accepted', 'gate.answered', 'plan.created'];
    const q = {};
    for (const ty of merges) q[ty] = 10;
    for (const ty of steps) q[ty] = 15;
    const all = scanCached(projectId, q);
    const shape = (e) => {
      const d = publicData(e) || {};
      const data = {};
      for (const k of ['branch', 'note', 'remote', 'refs', 'gate', 'answer', 'slug', 'head']) {
        if (d[k] !== undefined && d[k] !== null && d[k] !== '' && (k !== 'note' || e.type === 'task.merged')) data[k] = d[k];
      }
      return { ts: e.ts, type: e.type, task: e.task || null, title: (e.task && titles.get(e.task)) || null, data };
    };
    const byTime = (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
    const pick = (types, n) => all.filter((e) => types.includes(e.type)).sort(byTime).slice(0, n).map(shape);
    return [...pick(merges, 10), ...pick(steps, 15)].sort(byTime);
  }

  function projectDetail({ id }) {
    const p = projectOr404(id);
    const cfg = config.load(p.path);
    const taskList = tasks.list(p.id).map((tk) => ({
      id: tk.id, title: tk.title, role: tk.role, branch: tk.branch, state: tk.state, returns: tk.returns || 0,
      created: tk.created, updated: tk.updated, history: Array.isArray(tk.history) ? tk.history : [],
      review: reviewStats(p.id, tk.id),
    }));
    const mineRows = sessionRows().filter((s) => s.project === p.id);
    attachStats(mineRows);
    const sessions = mineRows.map(publicSession);
    const days = cfg.config.lessons && Number.isInteger(cfg.config.lessons.promote_after_days) ? cfg.config.lessons.promote_after_days : 3;
    return {
      project: { id: p.id, name: p.name, added: p.added },
      config_errors: cfg.errors.map((e) => ({ path: e.path, message: e.message })),
      tasks: taskList,
      sessions,
      needs: { open: store.needList(p.id), done: store.needList(p.id, { all: true }).filter((n) => n.done).slice(-5).reverse() },
      work: store.workList(p.id),
      log: store.logList(p.id, 30),
      mrs: store.mrList(p.id),
      validation: store.validateList(p.id),
      handoffs: handoffsOf(p.id),
      lessons: lessonsOf(p.path, days),
      plans: plansOf(p.path, p.id),
      gates: gates.history(p.id, 30),
      hook_seen: hookseen.read(p.id),
      show_text: showText(),
      events: tailEvents(p.id, 40).reverse().map((e) => ({ ts: e.ts, type: e.type, src: e.src, task: e.task, agent: e.agent, data: publicData(e) })),
      activity: activityOf(p.id, taskList),
      last_activity: lastActivity(p.id, taskList, sessions),
    };
  }

  function sessionsList() {
    const projectNames = new Map(projects.list().map((p) => [p.id, p.name]));
    return { show_text: showText(), sessions: sessionRows({ withStats: true }).map((s) => ({ ...publicSession(s), project_name: s.project ? projectNames.get(s.project) || null : null })) };
  }

  // One session in detail: its row with statistics, and a page of its activity timeline.
  function sessionDetail({ id, query }) {
    if (!/^[0-9a-f]{12}$/.test(String(id))) throw new ApiError(404, 'api.notFound');
    const rows = sessionRows();
    let row = rows.find((r) => r.id === id);
    let f = row && watcher.fileFor ? watcher.fileFor(id) : null;
    let kids = rows.filter((r) => r.parent === id);
    let fileFor = watcher.fileFor;
    const old = !f;
    if (old) {
      // older than the 24-hour list: look it up in the history
      const hs = history.session(id, { showText: showText(), resolveProject });
      if (!hs) throw new ApiError(404, 'api.notFound');
      row = hs.row;
      f = hs.file;
      kids = hs.kids;
      fileFor = history.fileFor;
    }
    if (old) attachAccounts([row, ...kids]);
    attachStats([row, ...kids], fileFor);
    const uint = (v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : undefined);
    const kinds = typeof query.kinds === 'string' ? query.kinds.split(',').filter((k) => TIMELINE_KINDS.includes(k)) : [];
    const agentId = (/[\/]subagents[\/]agent-([^\/]+)\.jsonl$/.exec(f.file) || [])[1] || null;
    // crewgate events of this session inside the span of the page, read backwards from the project's log (bounded)
    let crewEvents = [];
    if (row.project && (row.session || agentId)) {
      const mine = (e) => (agentId ? e.agent === agentId : e.session === row.session);
      crewEvents = (lo, hi) => crewEventsIn(paths.eventsFile(row.project), lo, hi, mine);
    }
    const link = (agent) => {
      if (row.subagent || f.engine !== 'claude' || !/^[\w.-]{1,80}$/.test(agent)) return null;
      const child = hashId(path.join(path.dirname(f.file), path.basename(f.file, '.jsonl'), 'subagents', `agent-${agent}.jsonl`));
      return fileFor(child) ? child : null;
    };
    const tl = buildTimeline({
      file: f.file, engine: f.engine, cwd: row.cwd, showText: showText(), before: uint(query.before), beforeTs: uint(query.before_ts),
      limit: uint(query.limit), kinds, crewEvents, link,
    });
    const names = new Map(projects.list().map((p) => [p.id, p.name]));
    return {
      show_text: showText(),
      session: { ...publicSession(row), project_name: row.project ? names.get(row.project) || null : null },
      children: kids.map(publicSession),
      kinds: TIMELINE_KINDS,
      ...(old ? { history: true } : {}),
      ...tl,
    };
  }

  // Sessions older than the 24-hour list, newest first, one page at a time (cursor = ms mtime, see history.js).
  function historyList({ query }) {
    const uint = (v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : undefined);
    const days = uint(query.days);
    const tzAsked = /^-?\d{1,4}$/.test(String(query.tz)) ? Number(query.tz) : 0;
    const tz = Math.abs(tzAsked) <= 14 * 60 ? tzAsked : 0;
    const project = typeof query.project === 'string' && (query.project === '-' || paths.ID_RE.test(query.project)) ? query.project : '';
    const pg = history.page({ days: days || undefined, before: typeof query.before === 'string' ? query.before : undefined, project, size: uint(query.limit), showText: showText(), resolveProject });
    const rows = [];
    for (const g of pg.groups) rows.push(g.row, ...g.kids);
    attachStats(rows, history.fileFor);
    const names = new Map(projects.list().map((p) => [p.id, p.name]));
    const sessions = pg.groups.map((g) => {
      const r = g.row;
      const first = (r.totals || r.stats || {}).first_ts;
      return {
        ...publicSession(r),
        project_name: r.project ? names.get(r.project) || null : null,
        started: Number.isFinite(first) ? new Date(first).toISOString() : null,
        day: dayOf(Date.parse(r.lastActivity), tz),
      };
    });
    const pub = pg.groups.map((g) => g.row);
    return {
      show_text: showText(),
      days: Math.min(history.options.maxDays, Math.max(1, days || history.options.defaultDays)),
      sessions,
      day_totals: dayTotals(pub, tz),
      next: pg.next,
      truncated: pg.truncated,
    };
  }

  function usageReport({ query }) {
    const g = globalCfg();
    const asked = parseInt(query.days, 10);
    const days = Number.isInteger(asked) && asked >= 1 && asked <= 365 ? asked : g.usage_days;
    return usage.report({ days, prices: isObj(g.prices) ? g.prices : {} });
  }

  const meta = () => ({ name: 'crewgate', version, language: globalCfg().language, show_text: showText() });

  // ---- config
  function configView(res, extra) {
    return { config: res.config, exists: res.exists, errors: res.errors.map((e) => ({ path: e.path, message: e.message })), warnings: (res.warnings || []).map((e) => ({ path: e.path, message: e.message })), ...extra };
  }

  function saveWith(body, lang, saver, loader) {
    if (!isObj(body) || !isObj(body.config)) throw new ApiError(400, 'api.fieldRequired', { field: 'config' });
    checkKeys(body.config);
    try {
      saver(body.config);
    } catch (e) {
      if (e instanceof CrewError && Array.isArray(e.errors)) {
        const errors = e.errors.map((x) => ({ path: x.path, message: t(lang, x.key, { path: x.path, ...x.vars }) }));
        throw new ApiError(400, 'api.configInvalid', { count: errors.length }, { errors });
      }
      throw e;
    }
    return { ok: true, ...configView(loader()) };
  }

  const routes = [
    ['GET', /^\/api\/meta$/, () => meta()],
    ['GET', /^\/api\/overview$/, () => overview()],
    ['GET', /^\/api\/project\/([^/]+)$/, (a) => projectDetail({ id: a[0] })],
    ['GET', /^\/api\/project\/([^/]+)\/plans$/, (a) => { const p = projectOr404(a[0]); return { plans: plansOf(p.path, p.id) }; }],
    ['GET', /^\/api\/project\/([^/]+)\/plan\/([^/]+)$/, (a) => { const p = projectOr404(a[0]); return planOf(p.path, p.id, a[1], { showText: showText() }); }],
    ['GET', /^\/api\/sessions$/, () => sessionsList()],
    ['GET', /^\/api\/session\/([^/]+)$/, (a, q) => sessionDetail({ id: a[0], query: q })],
    ['GET', /^\/api\/history$/, (a, q) => historyList({ query: q })],
    ['GET', /^\/api\/usage$/, (a, q) => usageReport({ query: q })],
    ['GET', /^\/api\/schema$/, () => ({ project: config.SCHEMA, global: config.GLOBAL_SCHEMA })],
    ['GET', /^\/api\/config$/, () => configView(config.loadGlobal())],
    ['POST', /^\/api\/config$/, (a, q, body, lang) => saveWith(body, lang, (c) => config.saveGlobal(c, { src: 'board' }), () => config.loadGlobal())],
    ['GET', /^\/api\/project\/([^/]+)\/config$/, (a) => configView(config.load(projectOr404(a[0]).path))],
    ['POST', /^\/api\/project\/([^/]+)\/config$/, (a, q, body, lang) => {
      const p = projectOr404(a[0]);
      return saveWith(body, lang, (c) => config.save(p.path, c, { src: 'board' }), () => config.load(p.path));
    }],
    // store writes
    ['POST', /^\/api\/project\/([^/]+)\/need$/, (a, q, b) => ({ ok: true, need: store.needAdd(projectOr404(a[0]).id, str(b, 'text'), SRC) })],
    ['POST', /^\/api\/project\/([^/]+)\/need\/done$/, (a, q, b) => ({ ok: true, need: store.needDone(projectOr404(a[0]).id, b.id, SRC) })],
    ['POST', /^\/api\/project\/([^/]+)\/work$/, (a, q, b) => ({
      ok: true,
      item: store.workSet(projectOr404(a[0]).id, { stream: str(b, 'stream', 200), title: str(b, 'title', 300), state: b.state, note: typeof b.note === 'string' ? b.note : undefined }, SRC),
    })],
    ['POST', /^\/api\/project\/([^/]+)\/work\/rm$/, (a, q, b) => {
      store.workRm(projectOr404(a[0]).id, str(b, 'stream', 200), str(b, 'title', 300), SRC);
      return { ok: true };
    }],
    ['POST', /^\/api\/project\/([^/]+)\/log$/, (a, q, b) => ({ ok: true, entry: store.logAdd(projectOr404(a[0]).id, typeof b.who === 'string' && b.who.trim() ? b.who : 'board', str(b, 'text'), SRC) })],
  ];

  // handle({ method, path, query, body, lang }) -> { status, data }. Never throws.
  function handle({ method, path: pathname, query = {}, body = {}, lang = 'en' }) {
    let methodMismatch = false;
    for (const [m, re, fn] of routes) {
      const hit = re.exec(pathname);
      if (!hit) continue;
      if (m !== method) { methodMismatch = true; continue; }
      try {
        return { status: 200, data: fn(hit.slice(1).map(decodeURIComponent), query, isObj(body) ? body : {}, lang) };
      } catch (e) {
        if (e instanceof URIError) return { status: 404, data: { ok: false, error: { key: 'api.notFound', message: t(lang, 'api.notFound') } } };
        if (e instanceof ApiError) {
          return { status: e.status, data: { ok: false, error: { key: e.key, message: t(lang, e.key, e.vars) }, ...e.extra } };
        }
        if (e instanceof CrewError) {
          return { status: 400, data: { ok: false, error: { key: e.key, message: t(lang, e.key, e.vars) } } };
        }
        return { status: 500, data: { ok: false, error: { key: 'api.internal', message: t(lang, 'api.internal') } } };
      }
    }
    return methodMismatch
      ? { status: 405, data: { ok: false, error: { key: 'api.method', message: t(lang, 'api.method') } } }
      : { status: 404, data: { ok: false, error: { key: 'api.notFound', message: t(lang, 'api.notFound') } } };
  }

  return { handle, meta, resolveProject, watcher };
}

module.exports = { createApi, ApiError, lessonsOf, plansOf, planOf, reviewStats, tailEvents };
