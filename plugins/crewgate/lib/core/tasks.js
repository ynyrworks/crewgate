'use strict';

// Task model and state machine (DESIGN section 7). Pure data layer: no printing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const json = require('./json');
const events = require('./events');
const { redact, clean } = require('./redact');
const { CrewError } = require('./errors');

const STATES = ['created', 'dispatched', 'returned', 'reviewing', 'accepted', 'merged', 'cancelled'];
const TRANSITIONS = {
  created: ['dispatched', 'cancelled'],
  dispatched: ['returned', 'cancelled'],
  returned: ['reviewing', 'accepted', 'dispatched', 'cancelled'],   // returned -> dispatched is a send-back
  reviewing: ['accepted', 'dispatched', 'returned', 'cancelled'],
  accepted: ['merged', 'cancelled'],
  merged: [],
  cancelled: [],
};
const DEFAULT_MAX_RETURNS = 2;
const DEFAULT_REPORT_TOKENS = 1500;

// Section definitions: key, English label, accepted heading prefixes (lower case).
const BRIEF_SECTIONS = [
  { key: 'goal', label: 'Goal', names: ['goal', '目標'] },
  { key: 'scope', label: 'Scope', names: ['scope', '範圍'] },
  { key: 'must_not_regress', label: 'Must not regress', names: ['must not regress', '不可退化', '不得退化'] },
  { key: 'acceptance', label: 'Acceptance', names: ['acceptance', '驗收'] },
  { key: 'context', label: 'Context', names: ['context', '脈絡', '背景'] },
];
const REPORT_SECTIONS = [
  { key: 'branch', label: 'Branch & commits', names: ['branch', '分支'] },
  { key: 'changes', label: 'What changed and why', names: ['what changed', '改了什麼', '變更'] },
  { key: 'tests', label: 'Tests run', names: ['tests run', 'tests', '測試'] },
  { key: 'assumptions', label: 'Assumptions & unfinished', names: ['assumptions', '假設'] },
  { key: 'realenv', label: 'Needs real-environment check', names: ['needs real', '需要實機', '實機'] },
];

const MARKER_RE = /crew-task:[ \t]*(t-\d{8}-[0-9a-z]{4})\b/;

function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }

// Splits markdown into sections matched by heading. -> { key: body } for the defs that were found.
function parseSections(text, defs) {
  const lines = String(text || '').split(/\r?\n/);
  const found = {};
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s*(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    const title = m[2].replace(/^[\d.)\s*_]+/, '').replace(/[*_`]/g, '').trim().toLowerCase();
    const def = defs.find((s) => s.names.some((n) => title.startsWith(n)));
    if (!def || def.key in found) continue;
    const level = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const h = /^(#{1,6})\s/.exec(lines[j]);
      if (h && h[1].length <= level) break;
      body.push(lines[j]);
    }
    found[def.key] = body.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  }
  return found;
}

// validateBrief(text) -> { ok, missing: [label], empty: [label], sections }
function validateBrief(text) {
  const sections = parseSections(text, BRIEF_SECTIONS);
  const missing = BRIEF_SECTIONS.filter((s) => !(s.key in sections)).map((s) => s.label);
  const empty = BRIEF_SECTIONS.filter((s) => s.key in sections && !sections[s.key]).map((s) => s.label);
  return { ok: !missing.length && !empty.length, missing, empty, sections };
}

// validateReport(text, { maxTokens }) -> { ok, tokens, errors: [{ code, section? }], sections }
// codes: missing_section, empty_section, too_long
function validateReport(text, opts = {}) {
  const maxTokens = opts.maxTokens || DEFAULT_REPORT_TOKENS;
  const sections = parseSections(text, REPORT_SECTIONS);
  const errors = [];
  for (const s of REPORT_SECTIONS) {
    if (!(s.key in sections)) errors.push({ code: 'missing_section', section: s.label });
    else if (!sections[s.key]) errors.push({ code: 'empty_section', section: s.label });
  }
  const tokens = estimateTokens(text);
  if (tokens > maxTokens) errors.push({ code: 'too_long', tokens, max: maxTokens });
  return { ok: !errors.length, tokens, errors, sections };
}

function newId(now, projectId) {
  const p2 = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  for (let i = 0; i < 50; i++) {
    const id = `t-${day}-${crypto.randomInt(0, 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!fs.existsSync(paths.taskDir(projectId, id))) return id;
  }
  throw new CrewError('task.idExhausted');
}

const strList = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

// createTask(projectId, { title, brief, role, branch, worktree, scope: {allow, deny}, acceptance, repro },
//            { src, session, now }) -> task. Throws CrewError task.briefInvalid (err.missing / err.empty).
function createTask(projectId, input, opts = {}) {
  const i = input || {};
  const title = typeof i.title === 'string' ? i.title.trim() : '';
  if (!title) throw new CrewError('task.titleRequired');
  const brief = typeof i.brief === 'string' ? i.brief : '';
  const check = validateBrief(brief);
  if (!check.ok) {
    const err = new CrewError('task.briefInvalid', { missing: check.missing.join(', ') || '-', empty: check.empty.join(', ') || '-' });
    err.missing = check.missing;
    err.empty = check.empty;
    throw err;
  }
  const now = opts.now || new Date();
  const id = newId(now, projectId);
  const dir = paths.taskDir(projectId, id);
  const ts = now.toISOString();
  const task = {
    id,
    title: clean(title, 200),
    role: i.role || 'worker',
    branch: i.branch || '',
    worktree: i.worktree || '',
    scope: { allow: strList(i.scope && i.scope.allow), deny: strList(i.scope && i.scope.deny) },
    acceptance: strList(i.acceptance).map((x) => clean(x, 500)),
    repro: clean(i.repro || '', 1000),
    state: 'created',
    returns: 0,
    created: ts,
    updated: ts,
    history: [{ state: 'created', ts, note: '' }],
  };
  const body = brief.replace(/^crew-task:.*(\r?\n)?/gm, '').replace(/^\s+/, '');
  json.saveRaw(path.join(dir, 'brief.md'), `crew-task: ${id}\n\n${redact(body)}${body.endsWith('\n') ? '' : '\n'}`);
  json.save(path.join(dir, 'task.json'), task);
  events.append(projectId, {
    type: 'task.created', src: opts.src || 'cli', session: opts.session, task: id,
    data: { title: task.title, role: task.role }, key: id,
  });
  return task;
}

function taskFile(projectId, taskId) { return path.join(paths.taskDir(projectId, taskId), 'task.json'); }

// load(projectId, taskId) -> task. Throws CrewError task.notFound.
function load(projectId, taskId) {
  const r = json.readJson(taskFile(projectId, taskId), {});
  if (r.status !== 'ok' || !r.data.id) throw new CrewError('task.notFound', { id: taskId });
  return r.data;
}

// list(projectId, { state }) -> tasks sorted by created. state: string or array. Unreadable tasks are skipped.
function list(projectId, opts = {}) {
  let names = [];
  try { names = fs.readdirSync(paths.tasksDir(projectId)); } catch { return []; }
  const want = opts.state ? [].concat(opts.state) : null;
  const out = [];
  for (const n of names) {
    if (!paths.TASK_ID_RE.test(n)) continue;
    const r = json.readJson(taskFile(projectId, n), {});
    if (r.status !== 'ok' || !r.data.id) continue;
    if (want && !want.includes(r.data.state)) continue;
    out.push(r.data);
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
}

// Finds the task named by a "crew-task: <id>" marker in a prompt/brief; returns the id or null.
function findMarker(text) {
  const m = MARKER_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

function eventType(from, to) {
  if (to === 'dispatched') return from === 'created' ? 'task.dispatched' : 'task.sent_back';
  return { returned: 'task.returned', reviewing: 'task.reviewed', accepted: 'task.accepted', merged: 'task.merged', cancelled: 'task.cancelled' }[to];
}

// transition(projectId, taskId, to, { note, src, session, agent, maxReturns, fields, data }) -> task
// data: extra keys merged into the event data (they never override from/to/returns/note).
// Moving to the state a task is already in is a no-op (hooks may fire twice).
// returned/reviewing -> dispatched is a send-back: returns++ and, once returns >= maxReturns
// (default 2), CrewError task.takeover is thrown instead. fields: { branch, worktree } to record.
function transition(projectId, taskId, to, opts = {}) {
  if (!STATES.includes(to)) throw new CrewError('task.badState', { state: String(to) });
  let ev = null;
  const task = json.update(taskFile(projectId, taskId), {}, (t) => {
    if (!t.id) throw new CrewError('task.notFound', { id: taskId });
    const from = t.state;
    if (from === to) return t;
    if (!(TRANSITIONS[from] || []).includes(to)) throw new CrewError('task.badTransition', { id: taskId, from, to });
    const max = Number.isInteger(opts.maxReturns) ? opts.maxReturns : DEFAULT_MAX_RETURNS;
    const type = eventType(from, to);
    if (type === 'task.sent_back') {
      if ((t.returns || 0) >= max) throw new CrewError('task.takeover', { id: taskId, returns: t.returns || 0, max });
      t.returns = (t.returns || 0) + 1;
    }
    const ts = new Date().toISOString();
    t.state = to;
    t.updated = ts;
    if (opts.fields) for (const k of ['branch', 'worktree']) if (typeof opts.fields[k] === 'string') t[k] = opts.fields[k];
    t.history = Array.isArray(t.history) ? t.history : [];
    t.history.push({ state: to, ts, note: clean(opts.note || '', 500) });
    ev = { type, data: { ...(opts.data && typeof opts.data === 'object' ? opts.data : {}), from, to, returns: t.returns || 0, note: opts.note || '' }, key: `${t.id}:${t.history.length}` };
    return t;
  });
  if (ev) events.append(projectId, { ...ev, src: opts.src || 'cli', session: opts.session, task: taskId, agent: opts.agent });
  return task;
}

// setFields(projectId, taskId, { branch, worktree }) -> task. Records where the task's work lives, without a state change.
function setFields(projectId, taskId, fields) {
  return json.update(taskFile(projectId, taskId), {}, (t) => {
    if (!t.id) throw new CrewError('task.notFound', { id: taskId });
    for (const k of ['branch', 'worktree']) if (fields && typeof fields[k] === 'string') t[k] = fields[k];
    t.updated = new Date().toISOString();
    return t;
  });
}

const sendBack = (projectId, taskId, opts) => transition(projectId, taskId, 'dispatched', opts);

// recordReport(projectId, taskId, { report, packet }, { maxTokens, ...transition opts })
// Validates report.md, stores report.md (and packet.md), then moves dispatched -> returned.
// -> { task, tokens }. Throws CrewError task.reportInvalid (err.errors) without writing anything.
function recordReport(projectId, taskId, input, opts = {}) {
  load(projectId, taskId);
  const text = redact(String((input && input.report) || ''));
  const v = validateReport(text, { maxTokens: opts.maxTokens });
  if (!v.ok) {
    const err = new CrewError('task.reportInvalid', { problems: v.errors.map((e) => (e.code === 'too_long' ? `too long (${e.tokens} > ${e.max} tokens)` : `${e.code.replace('_', ' ')}: ${e.section}`)).join('; ') });
    err.errors = v.errors;
    throw err;
  }
  const dir = paths.taskDir(projectId, taskId);
  json.saveRaw(path.join(dir, 'report.md'), text.endsWith('\n') ? text : `${text}\n`);
  if (input && typeof input.packet === 'string' && input.packet) json.saveRaw(path.join(dir, 'packet.md'), redact(input.packet));
  const cur = load(projectId, taskId);
  const task = cur.state === 'dispatched' ? transition(projectId, taskId, 'returned', opts) : cur;
  return { task, tokens: v.tokens };
}

function readReport(projectId, taskId) {
  try { return fs.readFileSync(path.join(paths.taskDir(projectId, taskId), 'report.md'), 'utf8'); } catch { return null; }
}

function readBrief(projectId, taskId) {
  try { return fs.readFileSync(path.join(paths.taskDir(projectId, taskId), 'brief.md'), 'utf8'); } catch { return null; }
}

module.exports = {
  STATES, TRANSITIONS, BRIEF_SECTIONS, REPORT_SECTIONS,
  estimateTokens, validateBrief, validateReport, createTask, load, list, findMarker,
  transition, setFields, sendBack, recordReport, readReport, readBrief,
};
