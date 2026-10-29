'use strict';

// Append-only event log: one JSON object per line (DESIGN section 6).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { clean } = require('./redact');

const MAX_FIELD = 2000;        // chars per free-text field, after redaction
const MAX_LINE_BYTES = 4000;   // keep each line under 4 KiB
const DEDUP_LINES = 500;
const TAIL_BYTES = 512 * 1024;

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

// Redacts, then truncates, every string inside a value.
function cleanValue(v) {
  if (typeof v === 'string') return clean(v, MAX_FIELD);
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = cleanValue(x);
    return o;
  }
  return v;
}

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

// id = sha256(type|session|tool_use_id or agent|task|key)[0..16]; `key` defaults to the
// stable JSON of data, so a hook that fires twice with the same payload dedups.
function eventId(ev) {
  const key = ev.key !== undefined ? String(ev.key) : stableStringify(ev.data === undefined ? null : ev.data);
  const raw = [ev.type, ev.session || '', ev.tool_use_id || ev.toolUseId || ev.agent || '', ev.task || '', key].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function lastLines(file, n) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // first line may be cut
    return lines.filter(Boolean).slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

function recentIds(file) {
  const ids = new Set();
  for (const line of lastLines(file, DEDUP_LINES)) {
    const m = /^{"v":1,"ts":"[^"]*","id":"([0-9a-f]{16})"/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// A torn previous write leaves no trailing newline; start a fresh line so the new event survives.
function endsWithoutNewline(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 10;
  } finally {
    fs.closeSync(fd);
  }
}

// Shrinks the largest string inside data until the serialized line fits.
function fit(obj) {
  let line = JSON.stringify(obj);
  for (let i = 0; i < 40 && Buffer.byteLength(line) > MAX_LINE_BYTES; i++) {
    let best = null;
    const walk = (parent, key) => {
      const v = parent[key];
      if (typeof v === 'string') { if (!best || v.length > best.len) best = { parent, key, len: v.length }; }
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v, k);
    };
    walk(obj, 'data');
    if (!best || best.len <= 40) { obj.data = { truncated: true }; line = JSON.stringify(obj); break; }
    best.parent[best.key] = clean(best.parent[best.key], Math.floor(best.len / 2));
    line = JSON.stringify(obj);
  }
  return line;
}

// append(projectId, { type, src, session, task, agent, data, key, tool_use_id })
// -> { written: boolean, id, event }  (written=false when an identical id is among the last 500 lines)
function append(projectId, event) {
  const ev = event || {};
  if (!ev.type || typeof ev.type !== 'string') throw new TypeError('event.type is required');
  const file = paths.eventsFile(projectId);
  const obj = {
    v: 1,
    ts: new Date().toISOString(),
    id: eventId(ev),
    type: ev.type,
    src: ev.src || 'cli',
    session: str(ev.session),
    task: str(ev.task),
    agent: str(ev.agent),
    data: cleanValue(ev.data === undefined ? {} : ev.data),
  };
  if (recentIds(file).has(obj.id)) return { written: false, id: obj.id, event: obj };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${endsWithoutNewline(file) ? '\n' : ''}${fit(obj)}\n`);
  return { written: true, id: obj.id, event: obj };
}

function typeMatcher(types) {
  const list = (Array.isArray(types) ? types : types ? [types] : []).filter(Boolean);
  if (!list.length) return null;
  return (t) => list.some((x) => (x.endsWith('*') ? t.startsWith(x.slice(0, -1)) : t === x));
}

// read(projectId, { since, types, limit }) -> events in file order. since: Date | ISO string | ms.
// types: string or array, exact or "prefix.*". limit: keep the newest N. Malformed lines are skipped.
function read(projectId, opts = {}) {
  const file = paths.eventsFile(projectId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const since = opts.since === undefined || opts.since === null ? null : new Date(opts.since).getTime();
  const match = typeMatcher(opts.types);
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    if (since !== null && !(Date.parse(e.ts) >= since)) continue;
    if (match && !match(e.type)) continue;
    out.push(e);
  }
  return opts.limit > 0 ? out.slice(-opts.limit) : out;
}

module.exports = { append, read, eventId, MAX_FIELD, MAX_LINE_BYTES };
