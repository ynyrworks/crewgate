'use strict';

// <home>/hook-errors.jsonl: one line per hook failure that would otherwise be silent
// ({ ts, event, kind: 'error' | 'guard' | 'worker_exit', msg, version }). Capped near 1 MiB.
// Nothing here may throw: a hook must answer even when its own logging is broken.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { clean } = require('./redact');

const MAX_BYTES = 1024 * 1024;
const KEEP_BYTES = 512 * 1024;
const MSG_MAX = 300;
const KINDS = ['error', 'guard', 'worker_exit'];

const file = () => path.join(paths.home(), 'hook-errors.jsonl');

let versionCache = null;
function pluginVersion() {
  if (versionCache) return versionCache;
  const root = path.join(__dirname, '..', '..');
  for (const f of [path.join(root, '.claude-plugin', 'plugin.json'), path.join(root, '..', '..', 'package.json'), path.join(root, 'package.json')]) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (typeof v === 'string') return (versionCache = v); } catch { /* next */ }
  }
  return (versionCache = '0.0.0');
}

// Drops the oldest half once the file passes the cap (cut at a line start).
function trim(f) {
  const st = fs.statSync(f);
  if (st.size <= MAX_BYTES) return;
  const fd = fs.openSync(f, 'r');
  let tail;
  try {
    const len = Math.min(st.size, KEEP_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    tail = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  const nl = tail.indexOf('\n');
  fs.writeFileSync(f, nl >= 0 ? tail.slice(nl + 1) : '');
}

// log(event, kind, msg) -> true when a line was written. `now` is for tests.
function log(event, kind, msg, now) {
  try {
    if (!event || !KINDS.includes(kind)) return false;
    const text = msg && msg.message !== undefined ? msg.message : msg;
    const line = JSON.stringify({
      ts: (now instanceof Date ? now : new Date()).toISOString(), event: String(event), kind,
      msg: clean(String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim(), MSG_MAX), version: pluginVersion(),
    });
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${line}\n`);
    try { trim(f); } catch { /* keep the line anyway */ }
    return true;
  } catch { return false; }
}

// counts(now) -> { h24: {total, by: {'<event>/<kind>': n}}, d7: {...} }; a missing file gives zeros.
function counts(now = new Date()) {
  const out = { h24: { total: 0, by: {} }, d7: { total: 0, by: {} } };
  let raw = '';
  try { raw = fs.readFileSync(file(), 'utf8'); } catch { return out; }
  const t = now.getTime();
  for (const l of raw.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(e && e.ts);
    if (!Number.isFinite(ts) || ts > t + 60000) continue;
    const age = t - ts;
    const key = `${e.event}/${e.kind}`;
    if (age <= 7 * 86400000) { out.d7.total++; out.d7.by[key] = (out.d7.by[key] || 0) + 1; }
    if (age <= 86400000) { out.h24.total++; out.h24.by[key] = (out.h24.by[key] || 0) + 1; }
  }
  return out;
}

module.exports = { log, counts, file, MAX_BYTES };
