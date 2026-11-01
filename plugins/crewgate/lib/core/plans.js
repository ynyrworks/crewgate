'use strict';

// Plans: a tree of steps kept as Markdown in <repo>/.crew/plans/<slug>.md (DESIGN section 13).
// Leaves link to crewgate tasks; progress is derived from the linked tasks. The parser is tolerant
// (never throws on a bad line) and a rewrite keeps the user's text, order and untouched lines byte for byte.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const json = require('./json');
const events = require('./events');
const paths = require('./paths');
const gates = require('./gates');
const tasks = require('./tasks');
const { clean } = require('./redact');
const { CrewError } = require('./errors');

const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const ORIGINS = ['plan', 'user', 'review', 'refute', 'implementation', 'send-back'];
const MAX_DEPTH = 3;
const MAX_BYTES = 256 * 1024;
const MAX_NODES = 500;
const MAX_TEXT = 300;
const ITEM_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX~?])\][ \t]+(\S.*)$/;
const COMMENT_RE = /[ \t]*<!--((?:(?!-->).)*)-->[ \t]*$/;
const KEY_RE = /^([A-Za-z][\w-]*):(\S*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOX_STATE = { ' ': 'open', x: 'done', '~': 'dropped', '?': 'proposed' };
const STATE_BOX = { open: ' ', done: 'x', dropped: '~', proposed: '?' };

// Proposals from a plan review carry round, kind, action, done_when and for (the step they are about) in the comment.
// A comment token cannot hold whitespace, and "-->" would end the comment: encodeToken escapes %, < > and every
// whitespace character as %HH (%uHHHH above 0xFF), decodeToken reverses it exactly.
const CLARIFIED_RE = /^##[ \t]+clarified[ \t]*$/i;
const KINDS = ['off-goal', 'missing-step', 'wrong-order', 'too-big', 'risk', 'vague-done', 'redundant'];
const ACTIONS = ['add', 'split', 'change', 'drop'];
const hex = (c) => { const n = c.codePointAt(0); return n > 0xff ? `%u${n.toString(16).toUpperCase().padStart(4, '0')}` : `%${n.toString(16).toUpperCase().padStart(2, '0')}`; };
const encodeToken = (s) => String(s).replace(/[%<>\s]/gu, hex);
const decodeToken = (s) => String(s || '').replace(/%u([0-9A-F]{4})|%([0-9A-F]{2})/g, (m, u, b) => String.fromCharCode(parseInt(u || b, 16)));

// A plan has a state: the first line after the title says draft, final, done or parked; no such line is a legacy plan.
// The project's data folder keeps a record of the state too (plans/<slug>.json) and wins over the file: the model can edit
// .crew/**, so a hand-edited file must not make a plan final. Only the user's reply (a gate) moves draft to final.
const STATES = ['draft', 'final', 'done', 'parked'];
const STATE_RE = /^<!--[ \t]*crew-plan[ \t]+state:([\w-]*)[ \t]*-->[ \t]*$/;
const stateLineOf = (state) => `<!-- crew-plan state:${state} -->`;
const NOT_DOING_RE = /^##[ \t]+(?:not doing|不做什麼)[ \t]*$/i;
const DONE_WHEN_RE = /^##[ \t]+(?:done when|完成條件)[ \t]*$/i;
const PARTS = { 'not-doing': { head: '## Not doing', re: NOT_DOING_RE, key: 'notDoing' }, 'done-when': { head: '## Done when', re: DONE_WHEN_RE, key: 'doneWhen' } };

const planDir = (root) => path.join(root, '.crew', 'plans');
const planFile = (root, slug) => path.join(planDir(root), `${slug}.md`);

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new CrewError('plan.badSlug', { slug: String(slug) });
  return slug;
}

const widthOf = (indent) => indent.replace(/\t/g, '    ').length;

// ---------------------------------------------------------------- parsing
// parse(text, { maxNodes }) -> doc { eol, final, lines, nodes, title, goal, notDoing, doneWhen, clarified, truncated, fileState, stateLine, titleLine }
// (fileState: the state line in the header, before the first step or ## section, names, or null; stateLine and titleLine: indexes into lines, -1 when absent)
// lines: [{ raw } | { node }] in file order; nodes: item nodes in file order. A node holds
// { box, boxChar, text, meta, junk, indent, bullet, depth, parent, children, lineNo, dirty, raw }.
function parse(text, opts = {}) {
  const max = Number.isInteger(opts.maxNodes) ? opts.maxNodes : Infinity;
  const src = String(text || '').replace(/^﻿/, '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const parts = src.split(/\r?\n/);
  const final = parts.length > 1 && parts[parts.length - 1] === '';
  if (final) parts.pop();
  const doc = { eol, final, lines: [], nodes: [], title: '', goal: '', notDoing: '', doneWhen: '', clarified: [], truncated: false, fileState: null, stateLine: -1, titleLine: -1 };
  const stack = [];
  const goal = [];
  const part = { notDoing: [], doneWhen: [] };
  let section = null;
  let seenItem = false;
  let inClarified = false;
  let headerEnded = false;   // the state line may sit anywhere before the first step or ## section
  parts.forEach((raw, i) => {
    const m = ITEM_RE.exec(raw);
    if (!m) {
      const st = doc.titleLine >= 0 && doc.stateLine < 0 && !headerEnded ? STATE_RE.exec(raw) : null;
      if (st) {
        doc.stateLine = doc.lines.length;
        doc.fileState = STATES.includes(st[1]) ? st[1] : null;
      } else if (/^#{1,6}[ \t]/.test(raw)) {
        if (/^#{2,6}[ \t]/.test(raw)) headerEnded = true;
        stack.length = 0;
        if (doc.title) seenItem = true;   // the goal is the text right under the title
        inClarified = CLARIFIED_RE.test(raw);
        section = NOT_DOING_RE.test(raw) ? 'notDoing' : DONE_WHEN_RE.test(raw) ? 'doneWhen' : null;
        if (!doc.title && /^#[ \t]/.test(raw)) { doc.title = raw.replace(/^#[ \t]+/, '').replace(/[ \t]+#*[ \t]*$/, '').trim(); doc.titleLine = doc.lines.length; }
      } else if (inClarified) {
        if (raw.trim()) doc.clarified.push(raw.trim().replace(/^[-*][ \t]+/, ''));
      } else if (section) {
        if (raw.trim()) part[section].push(raw.trim().replace(/^[-*][ \t]+/, ''));
      } else if (!seenItem && doc.title && raw.trim()) goal.push(raw.trim());
      doc.lines.push({ raw });
      return;
    }
    if (doc.nodes.length >= max) { doc.truncated = true; doc.lines.push({ raw }); return; }
    seenItem = true;
    headerEnded = true;
    section = null;
    let body = m[4];
    const meta = {};
    const junk = [];
    const c = COMMENT_RE.exec(body);
    if (c) {
      body = body.slice(0, c.index);
      for (const tok of c[1].split(/\s+/).filter(Boolean)) {
        const k = KEY_RE.exec(tok);
        if (k && !Object.prototype.hasOwnProperty.call(meta, k[1])) meta[k[1]] = k[2]; else junk.push(tok);
      }
    }
    const w = widthOf(m[1]);
    while (stack.length && stack[stack.length - 1].w >= w) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : null;
    const node = {
      box: BOX_STATE[m[3].toLowerCase()] ? m[3].toLowerCase() : ' ', boxChar: m[3], text: body.trim(), meta, junk,
      indent: m[1], bullet: m[2], depth: stack.length + 1, parent, children: [], lineNo: i + 1, dirty: false, raw,
    };
    if (parent) parent.children.push(node);
    stack.push({ w, node });
    doc.nodes.push(node);
    doc.lines.push({ node });
  });
  doc.goal = goal.join(' ');
  doc.notDoing = part.notDoing.join(' ');
  doc.doneWhen = part.doneWhen.join(' ');
  return doc;
}

function commentOf(node) {
  const toks = Object.keys(node.meta).map((k) => `${k}:${node.meta[k]}`).concat(node.junk);
  return toks.length ? ` <!-- ${toks.join(' ')} -->` : '';
}

function renderNode(node) {
  if (!node.dirty) return node.raw;
  return `${node.indent}${node.bullet} [${node.boxChar}] ${node.text}${commentOf(node)}`;
}

function serialize(doc) {
  const out = doc.lines.map((l) => (l.node ? renderNode(l.node) : l.raw)).join(doc.eol);
  return out + (doc.final ? doc.eol : '');
}

// ---------------------------------------------------------------- nodes
const refOf = (n) => n.meta.id || `L${n.lineNo}`;
const originOf = (n) => (ORIGINS.includes(n.meta.origin) ? n.meta.origin : 'plan');
const addedOf = (n) => (DATE_RE.test(n.meta.added || '') ? n.meta.added : null);

function touch(node) { node.dirty = true; }

function setBox(node, box) {
  node.box = box;
  node.boxChar = box;
  touch(node);
}

// Free ids: n<k> above the largest safe numeric part, never one already used (a hand-written id may be huge).
function idPool(doc) {
  const used = new Set(doc.nodes.map((n) => n.meta.id).filter(Boolean));
  let top = 0;
  for (const id of used) { const m = /^n(\d{1,15})$/.exec(id); if (m) top = Math.max(top, Number(m[1])); }
  return { next() { let id; do { id = `n${++top}`; } while (used.has(id)); used.add(id); return id; } };
}

// Ids used by more than one node (the first one wins for commands): [id].
function duplicateIds(doc) {
  const seen = new Set();
  const dup = new Set();
  for (const n of doc.nodes) { if (!n.meta.id) continue; if (seen.has(n.meta.id)) dup.add(n.meta.id); seen.add(n.meta.id); }
  return [...dup];
}

// Gives every node without a (unique) id a new one. Returns true when something changed.
function assignIds(doc) {
  const pool = idPool(doc);
  const seen = new Set();
  let changed = false;
  for (const n of doc.nodes) {
    if (n.meta.id && !seen.has(n.meta.id)) { seen.add(n.meta.id); continue; }
    const id = pool.next();
    seen.add(id);
    n.meta = { id, ...Object.fromEntries(Object.entries(n.meta).filter(([k]) => k !== 'id')) };
    touch(n);
    changed = true;
  }
  return changed;
}

// Node by id, or by Lnn (line number) for a hand-written line that has no id yet.
function find(doc, ref) {
  const r = String(ref || '');
  const hit = doc.nodes.find((n) => n.meta.id === r) || (/^L\d+$/.test(r) ? doc.nodes.find((n) => !n.meta.id && `L${n.lineNo}` === r) : null);
  if (!hit) throw new CrewError('plan.noNode', { node: r });
  return hit;
}

function lastDescendant(node) {
  let n = node;
  while (n.children.length) n = n.children[n.children.length - 1];
  return n;
}

function cleanText(text) {
  const s = clean(String(text || '').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim(), MAX_TEXT);
  if (!s) throw new CrewError('plan.noText');
  return s;
}

// Adds a node (under `under`, else at the top level, after everything else). `meta` adds more comment keys. -> node
function clarifiedLine(doc) { return doc.lines.findIndex((l) => !l.node && CLARIFIED_RE.test(l.raw)); }

function addNode(doc, { text, under, task, origin = 'plan', proposed = false, date, meta: extra }) {
  if (!ORIGINS.includes(origin)) throw new CrewError('plan.badOrigin', { origin: String(origin), origins: ORIGINS.join(', ') });
  if (doc.nodes.length >= MAX_NODES) throw new CrewError('plan.tooMany', { max: MAX_NODES });
  const body = cleanText(text);
  const parent = under ? find(doc, under) : null;
  if (parent && parent.depth >= MAX_DEPTH) throw new CrewError('plan.tooDeep', { max: MAX_DEPTH });
  assignIds(doc);
  const meta = { id: idPool(doc).next() };
  if (task) meta.task = task;
  meta.added = date;
  meta.origin = origin;
  if (extra) for (const [k, v] of Object.entries(extra)) if (!(k in meta)) meta[k] = String(v);
  const tab = parent && parent.indent.includes('\t');
  const node = {
    box: proposed ? '?' : ' ', boxChar: proposed ? '?' : ' ', text: body, meta, junk: [],
    indent: parent ? parent.indent + (tab ? '\t' : '  ') : '', bullet: parent ? parent.bullet : '-',
    depth: parent ? parent.depth + 1 : 1, parent, children: [], lineNo: 0, dirty: true, raw: '',
  };
  const after = parent ? lastDescendant(parent) : (doc.nodes.length ? lastDescendant(doc.nodes.filter((n) => !n.parent).pop()) : null);
  let at;
  if (after) at = doc.lines.findIndex((l) => l.node === after) + 1;
  else {
    // no items yet: at the end, or above the answers, which stay last, with a blank line between any text above and the list
    const section = clarifiedLine(doc);
    at = section < 0 ? doc.lines.length : section;
    const last = doc.lines[at - 1];
    if (last && last.raw.trim()) doc.lines.splice(at++, 0, { raw: '' });
    if (section >= 0) doc.lines.splice(at, 0, { raw: '' });
  }
  doc.lines.splice(at, 0, { node });
  doc.nodes.splice(after ? doc.nodes.indexOf(after) + 1 : doc.nodes.length, 0, node);
  if (parent) parent.children.push(node);
  doc.final = true;
  return node;
}

function removeNode(doc, node) {
  if (node.children.length) throw new CrewError('plan.hasChildren', { node: refOf(node) });
  doc.lines = doc.lines.filter((l) => l.node !== node);
  doc.nodes = doc.nodes.filter((n) => n !== node);
  if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
}

// Review metadata of a node, or null when it did not come from a plan review.
function proposalMeta(n) {
  if (!ACTIONS.includes(n.meta.action)) return null;
  return {
    round: Number(n.meta.round) || null, kind: KINDS.includes(n.meta.kind) ? n.meta.kind : null, action: n.meta.action,
    done_when: n.meta.done_when ? decodeToken(n.meta.done_when) : null, for: n.meta.for || null, uncertain: n.meta.uncertain === '1',
  };
}

// ---------------------------------------------------------------- derived state
// taskState(id) -> the task's state, or null when the task is unknown.
// -> { title, goal, truncated, summary, nodes: [tree of { id, line, text, depth, box, state, task, origin, added, done, total, pct, children }] }
function leafState(n, taskState) {
  if (n.box === '~') return { state: 'dropped' };
  if (n.box === '?') return { state: 'proposed' };
  const id = n.meta.task || null;
  const ts = id ? taskState(id) : null;
  const link = id ? { id, state: ts || null, missing: !ts } : null;
  let state = 'todo';
  if (n.box === 'x' || ts === 'merged' || ts === 'accepted') state = 'done';
  else if (ts === 'returned' || ts === 'reviewing') state = 'review';
  else if (ts === 'dispatched') state = 'doing';
  else if (ts === 'cancelled') state = 'blocked';
  return { state, task: link };
}

function deriveNode(n, taskState) {
  const kids = n.children.map((c) => deriveNode(c, taskState));
  const base = {
    id: refOf(n), line: n.lineNo, text: n.text, depth: n.depth, box: n.box, origin: originOf(n), added: addedOf(n), children: kids,
  };
  const pm = proposalMeta(n);
  if (pm) base.proposal = pm;
  const leaf = leafState(n, taskState);
  const counted = kids.filter((k) => k.state !== 'dropped' && k.state !== 'proposed');
  if (n.box === '~' || n.box === '?' || !counted.length) {
    // dropped, proposed, or a leaf (a parent whose children are all excluded counts as a leaf)
    const counts = leaf.state === 'dropped' || leaf.state === 'proposed' ? 0 : 1;
    return { ...base, state: leaf.state, task: leaf.task || null, done: leaf.state === 'done' ? 1 : 0, total: counts, pct: leaf.state === 'done' ? 100 : 0 };
  }
  let done = counted.reduce((s, k) => s + k.done, 0);
  const total = counted.reduce((s, k) => s + k.total, 0);
  let state;
  if (n.box === 'x') { state = 'done'; done = total; }
  else if (done === total) state = 'done';
  else if (counted.some((k) => k.state === 'blocked')) state = 'blocked';
  else if (counted.some((k) => k.state !== 'todo')) state = 'doing';
  else state = 'todo';
  const own = n.meta.task ? leafState(n, taskState).task : null;
  return { ...base, state, task: own, done, total, pct: total ? Math.round((100 * done) / total) : 0 };
}

function derive(doc, taskState) {
  const nodes = doc.nodes.filter((n) => !n.parent).map((n) => deriveNode(n, taskState));
  const flat = [];
  const walk = (list) => list.forEach((x) => { flat.push(x); walk(x.children); });
  walk(nodes);
  const counted = nodes.filter((k) => k.state !== 'dropped' && k.state !== 'proposed');
  const done = counted.reduce((s, k) => s + k.done, 0);
  const total = counted.reduce((s, k) => s + k.total, 0);
  const count = (st) => flat.filter((x) => x.state === st).length;
  return {
    title: doc.title, goal: doc.goal, not_doing: doc.notDoing, done_when: doc.doneWhen, clarified: doc.clarified, truncated: doc.truncated, duplicates: duplicateIds(doc),
    summary: { done, total, pct: total ? Math.round((100 * done) / total) : 0, nodes: flat.length, proposed: count('proposed'), dropped: count('dropped'), blocked: count('blocked') },
    nodes,
  };
}

// id -> state for every task of the project
function taskStates(projectId) {
  const m = new Map();
  for (const tk of tasks.list(projectId)) m.set(tk.id, tk.state);
  return (id) => m.get(id) || null;
}

// ---------------------------------------------------------------- files
function exists(root, slug) { return fs.existsSync(planFile(root, checkSlug(slug))); }

function slugs(root) {
  let names = [];
  try { names = fs.readdirSync(planDir(root)); } catch { return []; }
  return names.sort().map((n) => /^([a-z0-9-]{1,40})\.md$/.exec(n)).filter(Boolean).map((m) => m[1]);
}

// The slug of the plan whose nodes carry `task:<taskId>`, or null. One directory read when there are no plans; each
// plan is read capped (256 KiB, 500 nodes).
function planOfTask(root, taskId) {
  for (const slug of slugs(root)) {
    const doc = readCapped(root, slug);
    if (doc && doc.nodes.some((n) => n.meta.task === taskId)) return slug;
  }
  return null;
}

// The slug of a draft plan that links the task, or null. A task linked in several plans counts as draft if any one is.
function draftPlanOfTask(root, projectId, taskId) {
  for (const slug of slugs(root)) {
    const doc = readCapped(root, slug);
    if (doc && doc.nodes.some((n) => n.meta.task === taskId) && stateOf(root, projectId, slug) === 'draft') return slug;
  }
  return null;
}

// Reads for display: capped at 256 KiB and 500 nodes (doc.truncated says so). null when missing.
function readCapped(root, slug) {
  checkSlug(slug);
  const file = planFile(root, slug);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const doc = parse(buf.toString('utf8'), { maxNodes: MAX_NODES });
    if (st.size > MAX_BYTES) doc.truncated = true;
    doc.mtime = st.mtime.toISOString();
    return doc;
  } finally { fs.closeSync(fd); }
}

// Runs fn(doc) on the plan under a file lock, assigns missing ids and writes atomically. -> fn's result.
function update(root, slug, fn) {
  checkSlug(slug);
  const file = planFile(root, slug);
  return json.withLock(file, () => {
    let text;
    try {
      if (fs.statSync(file).size > MAX_BYTES) throw new CrewError('plan.tooBig', { slug, max: MAX_BYTES / 1024 });
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e instanceof CrewError) throw e;
      throw new CrewError('plan.notFound', { slug });
    }
    const doc = parse(text);
    const res = fn(doc);
    assignIds(doc);
    json.saveRaw(file, serialize(doc));
    return res;
  });
}

const rid = () => crypto.randomBytes(4).toString('hex');
function record(projectId, type, data) {
  if (projectId) events.append(projectId, { type, src: 'cli', data, key: `${type}:${data.slug}:${data.node || ''}:${Date.now()}:${rid()}` });
}

// A part (not doing, done when) is one line of text: no comment marks, no line breaks.
function partText(text) { return clean(String(text || '').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim(), 500); }

function create(root, projectId, slug, { title, goal, notDoing, doneWhen }) {
  checkSlug(slug);
  const t = clean(String(title || '').replace(/\s+/g, ' ').trim(), 120);
  if (!t) throw new CrewError('plan.noTitle');
  const file = planFile(root, slug);
  return json.withLock(file, () => {
    if (fs.existsSync(file)) throw new CrewError('plan.exists', { slug });
    const g = clean(String(goal || '').replace(/\s+/g, ' ').trim(), 500);
    const nd = partText(notDoing);
    const dw = partText(doneWhen);
    json.saveRaw(file, `# ${t}\n${stateLineOf('draft')}\n${g ? `${g}\n` : ''}\n${nd ? `${PARTS['not-doing'].head}\n${nd}\n\n` : ''}${dw ? `${PARTS['done-when'].head}\n${dw}\n\n` : ''}`);
    writeRecord(projectId, slug, { state: 'draft', hash: null, pending: null });
    record(projectId, 'plan.created', { slug, title: t });
    return { slug, title: t, file, state: 'draft' };
  });
}

// ---------------------------------------------------------------- state
const recordFile = (projectId, slug) => path.join(paths.projectDir(projectId), 'plans', `${checkSlug(slug)}.json`);

function readRecord(projectId, slug) {
  if (!projectId) return null;
  const r = json.readJson(recordFile(projectId, slug), {});
  return r.status === 'ok' && STATES.includes(r.data.state) ? r.data : null;
}

function writeRecord(projectId, slug, patch) {
  if (!projectId) return;
  json.update(recordFile(projectId, slug), {}, (data) => { Object.assign(data, patch, { slug, updated: new Date().toISOString() }); });
}

// The plan's text without its state line: what a user approves, so a change of state does not change the hash.
function contentHash(text) {
  const doc = parse(text);
  if (doc.stateLine >= 0) doc.lines.splice(doc.stateLine, 1);
  return crypto.createHash('sha256').update(serialize(doc)).digest('hex');
}
// What the user approved: the title, goal, ## Not doing, ## Done when, and each step's text and nesting. Not the box, the comment,
// the state line, ## Drift or ## Clarified, and not a proposed [?] step (a plan review's proposal is not part of the plan until accepted).
function approvedHash(text) {
  const doc = parse(text);
  const steps = doc.nodes.filter((n) => n.box !== '?').map((n) => [n.depth, n.text]);
  return crypto.createHash('sha256').update(JSON.stringify([doc.title, doc.goal, doc.notDoing, doc.doneWhen, steps])).digest('hex');
}
function fileApprovedHash(root, slug) {
  try { return approvedHash(fs.readFileSync(planFile(root, checkSlug(slug)), 'utf8')); } catch { return null; }
}
// True when a final plan's file no longer matches what was approved. A record without `approved` (finalized before it was kept) stores the
// current hash and says false. A plan that is not final, or has no record, is never changed.
function changedSinceApproved(root, projectId, slug) {
  const rec = readRecord(projectId, slug);
  if (!rec || rec.state !== 'final') return false;
  const cur = fileApprovedHash(root, slug);
  if (!cur) return false;
  if (!rec.approved) { writeRecord(projectId, slug, { approved: cur }); return false; }
  return cur !== rec.approved;
}
function approveNow(root, projectId, slug) {
  const cur = fileApprovedHash(root, slug);
  if (cur) writeRecord(projectId, slug, { approved: cur });
}
// The first final plan linked to the task whose file differs from what was approved, or null.
function changedPlanOfTask(root, projectId, taskId) {
  for (const slug of slugs(root)) {
    const doc = readCapped(root, slug);
    if (doc && doc.nodes.some((n) => n.meta.task === taskId) && changedSinceApproved(root, projectId, slug)) return slug;
  }
  return null;
}
function fileHash(root, slug) {
  try { return contentHash(fs.readFileSync(planFile(root, checkSlug(slug)), 'utf8')); } catch { return null; }
}

// -> { state, file_state, record_state, conflict } or null when there is neither a file nor a record.
// file_state: the state line, or 'legacy' for a file without one. The record, where there is one, wins.
function stateInfo(root, projectId, slug) {
  const doc = readCapped(root, slug);
  const rec = readRecord(projectId, slug);
  if (!doc && !rec) return null;
  const fileState = doc ? (doc.fileState || 'legacy') : null;
  const recState = rec ? rec.state : null;
  return { state: recState || fileState, file_state: fileState, record_state: recState, conflict: !!(rec && doc && recState !== fileState) };
}
function stateOf(root, projectId, slug) {
  const i = stateInfo(root, projectId, slug);
  return i ? i.state : null;
}

// Writes the state line into the file (replacing it, or adding it right under the title) and nothing else.
function writeFileState(root, slug, state) {
  const file = planFile(root, checkSlug(slug));
  json.withLock(file, () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { throw new CrewError('plan.notFound', { slug }); }
    const doc = parse(text);
    if (doc.stateLine >= 0) doc.lines[doc.stateLine] = { raw: stateLineOf(state) };
    else doc.lines.splice(doc.titleLine + 1, 0, { raw: stateLineOf(state) });
    json.saveRaw(file, serialize(doc));
  });
}

function transition(root, projectId, slug, state, extra = {}) {
  writeFileState(root, slug, state);
  writeRecord(projectId, slug, { state, pending: null, ...extra });
}

// setPart(root, projectId, slug, 'not-doing' | 'done-when', text): sets the section before the steps, or replaces its text.
function setPart(root, projectId, slug, which, text) {
  if (!Object.prototype.hasOwnProperty.call(PARTS, which)) throw new CrewError('plan.badPart', { part: String(which) });
  const body = partText(text);
  if (!body) throw new CrewError('plan.partEmpty');
  const { head, re } = PARTS[which];
  update(root, slug, (doc) => {
    const h = doc.lines.findIndex((l) => !l.node && re.test(l.raw));
    if (h >= 0) {
      let end = h + 1;
      while (end < doc.lines.length && !doc.lines[end].node && !/^#{1,6}[ \t]/.test(doc.lines[end].raw)) end++;
      while (end > h + 1 && !doc.lines[end - 1].raw.trim()) end--;
      doc.lines.splice(h + 1, end - h - 1, { raw: body });
    } else {
      const firstNode = doc.lines.findIndex((l) => l.node);
      const section = clarifiedLine(doc);
      let at = firstNode >= 0 ? firstNode : (section >= 0 ? section : doc.lines.length);
      if (firstNode >= 0) {
        // keep a heading that sits right above the steps (such as "## Steps") with them
        let k = at;
        while (k > 0 && !doc.lines[k - 1].node && !doc.lines[k - 1].raw.trim()) k--;
        if (k > 0 && !doc.lines[k - 1].node && /^#{2,6}[ \t]/.test(doc.lines[k - 1].raw)) at = k - 1;
      }
      const add = [{ raw: head }, { raw: body }];
      if (at < doc.lines.length) add.push({ raw: '' });
      const prev = doc.lines[at - 1];
      if (prev && (prev.node || prev.raw.trim())) add.unshift({ raw: '' });
      doc.lines.splice(at, 0, ...add);
    }
  });
  record(projectId, 'plan.part_set', { slug, part: which });
  return { slug, part: which };
}

// What stops a plan from being final, as codes: goal, not_doing, done_when, steps, assumed.
function readyProblems(doc) {
  const out = [];
  if (!doc.goal.trim()) out.push('goal');
  if (!doc.notDoing.trim()) out.push('not_doing');
  if (!doc.doneWhen.trim()) out.push('done_when');
  if (!doc.nodes.some((n) => n.box !== '~' && n.box !== '?')) out.push('steps');
  if (doc.clarified.some((l) => /\(assumed\)\s*$/.test(l))) out.push('assumed');
  return out;
}

// Finalizing and closing ask the user through the gate plan_final: the model shows the plan, ends its turn, and answers with
// --gate after the user's reply. The gate is always asked (never auto or never), whatever the project's `gates` say.
const askCfg = (cfg) => ({ ...cfg, gates: { ...((cfg && cfg.gates) || {}), plan_final: 'ask' } });

function mustBe(root, projectId, slug, want, errKey) {
  const info = stateInfo(root, projectId, slug);
  if (!info) throw new CrewError('plan.notFound', { slug });
  if (!want.includes(info.state)) throw new CrewError(errKey, { slug, state: info.state });
  return info;
}

// finalizeAsk -> { slug, gate_id, hash }; throws plan.notReady (naming each problem), plan.isLegacy or plan.notDraft.
// opts: session, t (translates the problem names).
function finalizeAsk(root, projectId, cfg, slug, opts = {}) {
  const info = stateInfo(root, projectId, slug);
  if (!info) throw new CrewError('plan.notFound', { slug });
  if (!readCapped(root, slug).title) throw new CrewError('plan.noTitleLine', { slug });
  if (info.state === 'legacy') throw new CrewError('plan.isLegacy', { slug });
  if (info.state !== 'draft') throw new CrewError('plan.notDraft', { slug, state: info.state });
  const problems = readyProblems(readCapped(root, slug));
  if (problems.length) {
    const tt = opts.t || ((k, v) => require('./i18n').t('en', k, v));
    throw new CrewError('plan.notReady', { slug, list: problems.map((p) => `  - ${tt(`plan.problem.${p}`)}`).join('\n') });
  }
  const hash = fileHash(root, slug);
  const g = gates.ask(projectId, askCfg(cfg), { gate: 'plan_final', detail: `finalize plan ${slug}` }, { src: 'cli', session: opts.session });
  writeRecord(projectId, slug, { state: 'draft', pending: { gate_id: g.id, kind: 'finalize', hash } });
  return { slug, gate_id: g.id, hash };
}

// closeAsk -> { slug, gate_id, to }
function closeAsk(root, projectId, cfg, slug, to, opts = {}) {
  if (to !== 'done' && to !== 'parked') throw new CrewError('plan.badClose', { to: String(to) });
  mustBe(root, projectId, slug, ['final'], 'plan.notFinal');
  const g = gates.ask(projectId, askCfg(cfg), { gate: 'plan_final', detail: `close plan ${slug} as ${to}` }, { src: 'cli', session: opts.session });
  writeRecord(projectId, slug, { pending: { gate_id: g.id, kind: 'close', to } });
  return { slug, gate_id: g.id, to };
}

// The pending ask of this kind, and nothing else: another plan's gate, an old one or a made-up one is refused.
function pendingOf(projectId, slug, gateId, kind) {
  const rec = readRecord(projectId, slug);
  const pend = rec && rec.pending;
  if (!pend || pend.kind !== kind || pend.gate_id !== String(gateId)) throw new CrewError('plan.badGate', { slug, id: String(gateId) });
  return pend;
}

// The user's reply, whatever `gates.require_user_turn` says: the yes is recorded with requireUserTurn: true, and the stored
// verdict must be true or 'project'. A gate already answered through `crew gate answer` is judged by what is stored.
// answerOpts are built like commands/gate.js builds them (src, session, prompts, promptsOf, projectPrompts).
function takeReply(projectId, slug, gateId, answerOpts) {
  const prior = events.read(projectId, { types: ['gate.answered'] }).find((e) => e.data && e.data.id === gateId);
  const ans = prior ? prior.data : gates.answer(projectId, gateId, 'yes', '', { ...answerOpts, requireUserTurn: true });
  if (ans.answer !== 'yes') throw new CrewError('plan.gateNo', { slug });
  if (ans.user_turn !== true && ans.user_turn !== 'project') throw new CrewError('plan.noUserTurn', { slug, id: gateId });
}

// finalizeAnswer -> { slug, hash, gate_id }
function finalizeAnswer(root, projectId, slug, gateId, answerOpts) {
  const pend = pendingOf(projectId, slug, gateId, 'finalize');
  if (fileHash(root, slug) !== pend.hash) throw new CrewError('plan.changedSinceAsk', { slug });
  takeReply(projectId, slug, gateId, answerOpts);
  transition(root, projectId, slug, 'final', { hash: pend.hash, approved: fileApprovedHash(root, slug), gate_id: gateId, finalized: new Date().toISOString() });
  record(projectId, 'plan.finalized', { slug, hash: pend.hash, gate: gateId });
  return { slug, hash: pend.hash, gate_id: gateId };
}

// closeAnswer -> { slug, state, gate_id }
function closeAnswer(root, projectId, slug, gateId, answerOpts) {
  const pend = pendingOf(projectId, slug, gateId, 'close');
  mustBe(root, projectId, slug, ['final'], 'plan.notFinal');
  takeReply(projectId, slug, gateId, answerOpts);
  transition(root, projectId, slug, pend.to);
  record(projectId, 'plan.closed', { slug, state: pend.to, gate: gateId });
  return { slug, state: pend.to, gate_id: gateId };
}

function reopen(root, projectId, slug) {
  mustBe(root, projectId, slug, ['final', 'done', 'parked'], 'plan.notReopenable');
  transition(root, projectId, slug, 'draft', { hash: null });
  record(projectId, 'plan.reopened', { slug });
  return { slug, state: 'draft' };
}

function adopt(root, projectId, slug) {
  mustBe(root, projectId, slug, ['legacy'], 'plan.notLegacy');
  if (!readCapped(root, slug).title) throw new CrewError('plan.noTitleLine', { slug });
  transition(root, projectId, slug, 'draft', { hash: null });
  record(projectId, 'plan.adopted', { slug });
  return { slug, state: 'draft' };
}

// clarify(root, projectId, slug, { question, answer, by }): one settled question, as a plain line under ## Clarified at
// the end of the file. A later session reads it; it is not a step.
function clarify(root, projectId, slug, { question, answer, by = 'user' }) {
  const one = (s) => clean(String(s || '').replace(/\s+/g, ' ').trim(), 500);
  const q = one(question);
  const a = one(answer);
  if (!q || !a) throw new CrewError('plan.clarifyEmpty');
  const line = `- Q: ${q} A: ${a} (${by})`;
  update(root, slug, (doc) => {
    let at = clarifiedLine(doc);
    if (at < 0) {
      const last = doc.lines[doc.lines.length - 1];
      if (last && (last.node || last.raw.trim())) doc.lines.push({ raw: '' });
      doc.lines.push({ raw: '## Clarified' });
      at = doc.lines.length - 1;
    }
    let end = at + 1;
    while (end < doc.lines.length && !doc.lines[end].node && !/^#{1,6}[ \t]/.test(doc.lines[end].raw)) end++;
    while (end > at + 1 && !doc.lines[end - 1].node && !doc.lines[end - 1].raw.trim()) end--;
    doc.lines.splice(end, 0, { raw: line });
    doc.final = true;
  });
  record(projectId, 'plan.clarified', { slug, by });
  return { slug, line, by };
}

function addTo(root, projectId, slug, input) {
  const date = input.date || today();
  const out = update(root, slug, (doc) => {
    const n = addNode(doc, { ...input, date });
    return { node: n };
  });
  const n = out.node;
  record(projectId, 'plan.node_added', { slug, node: n.meta.id, origin: n.meta.origin, ...(n.box === '?' ? { proposed: true } : {}), ...(n.meta.task ? { task: n.meta.task } : {}) });
  return { id: n.meta.id, depth: n.depth, origin: n.meta.origin, added: n.meta.added, state: BOX_STATE[n.box], task: n.meta.task || null };
}

function linkTask(root, projectId, slug, ref, taskId) {
  const out = update(root, slug, (doc) => {
    const n = find(doc, ref);
    n.meta.task = taskId;
    touch(n);
    return { node: n, kids: n.children.length };
  });
  record(projectId, 'plan.node_changed', { slug, node: out.node.meta.id, change: 'linked', task: taskId });
  return { id: out.node.meta.id, task: taskId };
}

function setState(root, projectId, slug, ref, action) {
  const out = update(root, slug, (doc) => {
    const n = find(doc, ref);
    if (action === 'accept') {
      if (n.box !== '?') throw new CrewError('plan.notProposed', { node: refOf(n) });
      setBox(n, ' ');
    } else setBox(n, STATE_BOX[{ open: 'open', done: 'done', dropped: 'dropped' }[action]]);
    return { node: n };
  });
  record(projectId, 'plan.node_changed', { slug, node: out.node.meta.id, change: action });
  return { id: out.node.meta.id, state: BOX_STATE[out.node.box] };
}

function removeFrom(root, projectId, slug, ref) {
  const out = update(root, slug, (doc) => {
    const n = find(doc, ref);
    removeNode(doc, n);
    return { id: refOf(n) };
  });
  record(projectId, 'plan.node_changed', { slug, node: out.id, change: 'removed' });
  return out;
}

function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Plans (slug) with ids used twice: [{ slug, ids }] for doctor.
function duplicateNodes(root) {
  const out = [];
  for (const slug of slugs(root)) {
    const doc = readCapped(root, slug);
    const ids = doc ? duplicateIds(doc) : [];
    if (ids.length) out.push({ slug, ids });
  }
  return out;
}

// Hand-edited files may nest deeper than MAX_DEPTH: [{ slug, line, depth }] for doctor.
function deepNodes(root) {
  const out = [];
  for (const slug of slugs(root)) {
    const doc = readCapped(root, slug);
    if (doc) for (const n of doc.nodes) if (n.depth > MAX_DEPTH) out.push({ slug, line: n.lineNo, depth: n.depth });
  }
  return out;
}

module.exports = {
  SLUG_RE, ORIGINS, MAX_DEPTH, MAX_BYTES, MAX_NODES, planDir, planFile, checkSlug, parse, serialize, assignIds, find, addNode, removeNode,
  STATES, PARTS, planOfTask, draftPlanOfTask, stateOf, stateInfo, contentHash, fileHash, approvedHash, fileApprovedHash, changedSinceApproved, approveNow, changedPlanOfTask, readRecord, setPart, readyProblems, finalizeAsk, finalizeAnswer, closeAsk, closeAnswer, reopen, adopt, takeReply, writeRecord,
  KINDS, ACTIONS, encodeToken, decodeToken, proposalMeta, record, setBox, touch, BOX_STATE, cleanText, MAX_TEXT,
  derive, taskStates, slugs, readCapped, update, create, clarify, addTo, linkTo: linkTask, setState, removeFrom, deepNodes, duplicateNodes, duplicateIds, exists, today, refOf,
};
