'use strict';

// Cross-session handoffs (DESIGN section 11). Whoever creates open/<id>.claim exclusively (flag "wx",
// EEXIST for everyone else, on every platform) owns the handoff and then moves open/ -> accepted|cancelled/.
// A plain rename is not enough: on Windows two processes can both succeed in renaming the same file.
// A claim left behind by a crashed winner is broken after STALE_CLAIM_MS if the open file still exists.
const fs = require('fs');
const crypto = require('crypto');
const paths = require('../core/paths');
const json = require('../core/json');
const events = require('../core/events');
const { clean, redact } = require('../core/redact');
const { CrewError } = require('../core/errors');

const MAX_BODY = 64 * 1024;
const STATES = ['open', 'accepted', 'cancelled'];
const STALE_CLAIM_MS = 30 * 1000;

function newId(pid) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  for (let i = 0; i < 50; i++) {
    const id = `h-${day}-${crypto.randomInt(0, 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!STATES.some((s) => fs.existsSync(paths.handoffFile(pid, s, id)))) return id;
  }
  throw new CrewError('wf.handoff.idExhausted');
}

function create(pid, { title, body, task }, opts = {}) {
  const t = clean(String(title || '').trim(), 200);
  if (!t) throw new CrewError('wf.handoff.noTitle');
  const text = redact(String(body || ''));
  if (!text.trim()) throw new CrewError('wf.handoff.noBody');
  if (Buffer.byteLength(text) > MAX_BODY) throw new CrewError('wf.handoff.tooBig', { max: MAX_BODY });
  const id = newId(pid);
  const h = { id, title: t, task: task || null, body: text, state: 'open', created: new Date().toISOString() };
  json.save(paths.handoffFile(pid, 'open', id), h);
  events.append(pid, { type: 'handoff.created', src: opts.src || 'cli', session: opts.session, task: task || undefined, data: { id, title: t }, key: id });
  return h;
}

function readOne(pid, state, id) {
  const r = json.readJson(paths.handoffFile(pid, state, id), {});
  return r.status === 'ok' && r.data.id ? r.data : null;
}

// -> handoff with its state, searched in all three folders; throws wf.handoff.notFound.
function find(pid, id) {
  for (const s of STATES) {
    const h = readOne(pid, s, id);
    if (h) return { ...h, state: s };
  }
  throw new CrewError('wf.handoff.notFound', { id });
}

function list(pid, { all = false } = {}) {
  const out = [];
  for (const s of all ? STATES : ['open']) {
    let names = [];
    try { names = fs.readdirSync(paths.handoffDir(pid, s)); } catch { continue; }
    for (const n of names) {
      const m = /^(.+)\.json$/.exec(n);
      if (!m || !paths.SAFE_ID_RE.test(m[1])) continue;
      const h = readOne(pid, s, m[1]);
      if (h) out.push({ ...h, state: s });
    }
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
}

function claimFile(pid, id) { return paths.handoffFile(pid, 'open', id).replace(/.json$/, '.claim'); }

// Takes the claim -> true, or false when somebody else holds it (a stale one is broken first).
function takeClaim(file, openFile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.closeSync(fs.openSync(file, 'wx')); return true; } catch (e) {
      if (e.code === 'ENOENT') return false; // no open/ folder: nothing to claim
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      let st;
      try { st = fs.statSync(file); } catch { continue; } // released meanwhile: try again
      if (Date.now() - st.mtimeMs < STALE_CLAIM_MS || !fs.existsSync(openFile)) return false;
      try { fs.unlinkSync(file); } catch { /* somebody else broke it */ }
    }
  }
  return false;
}

function move(pid, id, to, opts) {
  const from = paths.handoffFile(pid, 'open', id);
  const dest = paths.handoffFile(pid, to, id);
  const claim = claimFile(pid, id);
  const notOpen = () => {
    const cur = STATES.find((s) => s !== 'open' && readOne(pid, s, id));
    if (cur) return new CrewError('wf.handoff.notOpen', { id, state: cur });
    if (fs.existsSync(from)) return new CrewError('wf.handoff.alreadyClaimed', { id });
    return new CrewError('wf.handoff.notFound', { id });
  };
  if (!takeClaim(claim, from)) throw notOpen();
  try {
    fs.mkdirSync(paths.handoffDir(pid, to), { recursive: true });
    try {
      fs.renameSync(from, dest);
    } catch (e) {
      if (e.code === 'ENOENT') throw notOpen();
      throw e;
    }
    let h = readOne(pid, to, id) || { id };
    h = { ...h, state: to, [`${to}_at`]: new Date().toISOString() };
    json.save(dest, h);
    events.append(pid, {
      type: `handoff.${to}`, src: opts.src || 'cli', session: opts.session, task: h.task || undefined,
      data: { id }, key: `${id}:${to}`,
    });
    return h;
  } finally {
    try { fs.unlinkSync(claim); } catch { /* already gone */ }
  }
}

const accept = (pid, id, opts = {}) => move(pid, id, 'accepted', opts);
const cancel = (pid, id, opts = {}) => move(pid, id, 'cancelled', opts);

module.exports = { STATES, MAX_BODY, create, find, list, accept, cancel };
