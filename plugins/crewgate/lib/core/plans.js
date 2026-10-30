'use strict';

// Plans: a tree of steps kept as Markdown in <repo>/.crew/plans/<slug>.md (DESIGN section 13).
// Leaves link to crewgate tasks; progress is derived from the linked tasks. The parser is tolerant
// (never throws on a bad line) and a rewrite keeps the user's text, order and untouched lines byte for byte.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const json = require('./json');
const events = require('./events');
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
const KINDS = ['missing-step', 'wrong-order', 'too-big', 'risk', 'vague-done', 'redundant'];
const ACTIONS = ['add', 'split', 'change', 'drop'];
const hex = (c) => { const n = c.codePointAt(0); return n > 0xff ? `%u${n.toString(16).toUpperCase().padStart(4, '0')}` : `%${n.toString(16).toUpperCase().padStart(2, '0')}`; };
const encodeToken = (s) => String(s).replace(/[%<>\s]/gu, hex);
const decodeToken = (s) => String(s || '').replace(/%u([0-9A-F]{4})|%([0-9A-F]{2})/g, (m, u, b) => String.fromCharCode(parseInt(u || b, 16)));

const planDir = (root) => path.join(root, '.crew', 'plans');
const planFile = (root, slug) => path.join(planDir(root), `${slug}.md`);

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new CrewError('plan.badSlug', { slug: String(slug) });
  return slug;
}

const widthOf = (indent) => indent.replace(/\t/g, '    ').length;

// ---------------------------------------------------------------- parsing
// parse(text, { maxNodes }) -> doc { eol, final, lines, nodes, title, goal, truncated }
// lines: [{ raw } | { node }] in file order; nodes: item nodes in file order. A node holds
// { box, boxChar, text, meta, junk, indent, bullet, depth, parent, children, lineNo, dirty, raw }.
function parse(text, opts = {}) {
  const max = Number.isInteger(opts.maxNodes) ? opts.maxNodes : Infinity;
  const src = String(text || '').replace(/^﻿/, '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const parts = src.split(/\r?\n/);
  const final = parts.length > 1 && parts[parts.length - 1] === '';
  if (final) parts.pop();
  const doc = { eol, final, lines: [], nodes: [], title: '', goal: '', truncated: false };
  const stack = [];
  const goal = [];
  let seenItem = false;
  parts.forEach((raw, i) => {
    const m = ITEM_RE.exec(raw);
    if (!m) {
      if (/^#{1,6}[ \t]/.test(raw)) {
        stack.length = 0;
        if (!doc.title && /^#[ \t]/.test(raw)) doc.title = raw.replace(/^#[ \t]+/, '').replace(/[ \t]+#*[ \t]*$/, '').trim();
      } else if (!seenItem && doc.title && raw.trim()) goal.push(raw.trim());
      doc.lines.push({ raw });
      return;
    }
    if (doc.nodes.length >= max) { doc.truncated = true; doc.lines.push({ raw }); return; }
    seenItem = true;
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
    // no items yet: append, with a blank line between any text above and the list
    const last = doc.lines[doc.lines.length - 1];
    if (last && last.raw.trim()) doc.lines.push({ raw: '' });
    at = doc.lines.length;
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
    title: doc.title, goal: doc.goal, truncated: doc.truncated, duplicates: duplicateIds(doc),
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

function create(root, projectId, slug, { title, goal }) {
  checkSlug(slug);
  const t = clean(String(title || '').replace(/\s+/g, ' ').trim(), 120);
  if (!t) throw new CrewError('plan.noTitle');
  const file = planFile(root, slug);
  return json.withLock(file, () => {
    if (fs.existsSync(file)) throw new CrewError('plan.exists', { slug });
    const g = clean(String(goal || '').replace(/\s+/g, ' ').trim(), 500);
    json.saveRaw(file, `# ${t}\n${g ? `${g}\n` : ''}\n`);
    record(projectId, 'plan.created', { slug, title: t });
    return { slug, title: t, file };
  });
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
  KINDS, ACTIONS, encodeToken, decodeToken, proposalMeta, record, setBox, touch, BOX_STATE, cleanText, MAX_TEXT,
  derive, taskStates, slugs, readCapped, update, create, addTo, linkTo: linkTask, setState, removeFrom, deepNodes, duplicateNodes, duplicateIds, exists, today, refOf,
};
