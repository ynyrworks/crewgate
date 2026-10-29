'use strict';

// Atomic JSON files, safe reads and a small cross-process lock for read-modify-write.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CrewError } = require('./errors');
const { t } = require('./i18n');

const lockWaitMs = () => Number(process.env.CREWGATE_LOCK_WAIT_MS) || 10000;
const LOCK_STALE_MS = 30000;
const RELEASE_RETRY_MS = 1000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const p2 = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

// ---------------------------------------------------------------- reading
// -> { status: 'ok' | 'missing' | 'corrupt', data }. Pure: never touches the file.
// A wrong top-level type (list where an object is expected) counts as corrupt.
// Only a missing file is "missing"; other read errors (EACCES, EISDIR ...) throw.
function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { status: 'missing', data: clone(fallback) };
    throw new CrewError('json.readFailed', { file: path.basename(file), code: e.code || e.name });
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const data = JSON.parse(raw);
    const wantArray = Array.isArray(fallback);
    if (data === null || typeof data !== 'object' || Array.isArray(data) !== wantArray) return { status: 'corrupt', data: clone(fallback) };
    return { status: 'ok', data };
  } catch {
    return { status: 'corrupt', data: clone(fallback) };
  }
}

// Safe read: a corrupt file is moved aside to <name>.corrupt-<ts> and the default is returned
// together with a warning. -> { data, status, warning }
function read(file, fallback) {
  const r = readJson(file, fallback);
  if (r.status !== 'corrupt') return { data: r.data, status: r.status, warning: null };
  let warning;
  try {
    const moved = backupCorrupt(file);
    warning = t('en', 'json.corruptMoved', { file: path.basename(file), moved: path.basename(moved) });
  } catch {
    warning = t('en', 'json.corruptKept', { file: path.basename(file) });
  }
  return { data: r.data, status: 'corrupt', warning };
}

// ---------------------------------------------------------------- writing
function save(file, obj) {
  saveRaw(file, JSON.stringify(obj, null, 2) + '\n');
}

// Atomic write of exact text/bytes: temp file in the same folder, then rename.
function saveRaw(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        // Windows: the target can be briefly held open by a reader
        if (i < 20 && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY')) sleep(10);
        else throw e;
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// Move a damaged file aside (<name>.corrupt-<YYYYMMDD-HHMMSS>); returns the new path.
function backupCorrupt(file) {
  const base = `${file}.corrupt-${stamp()}`;
  for (let i = 0; i < 100; i++) {
    const target = i === 0 ? base : `${base}-${i}`;
    if (fs.existsSync(target)) continue;
    fs.renameSync(file, target);
    return target;
  }
  throw new CrewError('json.backupFailed', { file: path.basename(file) });
}

// ---------------------------------------------------------------- locks
const held = new Map();   // lock path -> token
let handlersOn = false;

function pidGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function readLock(lock) {
  try {
    const raw = fs.readFileSync(lock, 'utf8');
    const mtimeMs = fs.statSync(lock).mtimeMs;
    try {
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') return { info: d, mtimeMs };
    } catch { /* unreadable content: age only */ }
    return { info: null, mtimeMs };
  } catch {
    return null;
  }
}

// Stale only when older than 30 s AND the owner process is gone; a lock without readable
// content (crash between create and write) falls back to its age alone.
function isStale(l) {
  if (!l) return false;
  if (l.info && typeof l.info.created === 'number') return Date.now() - l.info.created > LOCK_STALE_MS && pidGone(l.info.pid);
  return Date.now() - l.mtimeMs > LOCK_STALE_MS;
}

function unlinkRetry(file) {
  const start = Date.now();
  for (;;) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      if ((e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && Date.now() - start < RELEASE_RETRY_MS) { sleep(25); continue; }
      return false;
    }
  }
}

// A short-lived ".breaker" file serializes stale-lock removal so two processes cannot delete
// each other's fresh lock; the lock is re-checked under the breaker.
function removeStale(lock, seen) {
  const breaker = `${lock}.breaker`;
  let fd;
  try {
    fd = fs.openSync(breaker, 'wx');
  } catch {
    try { if (Date.now() - fs.statSync(breaker).mtimeMs > LOCK_STALE_MS) unlinkRetry(breaker); } catch { /* ignore */ }
    return;
  }
  try {
    const cur = readLock(lock);
    const same = cur && ((cur.info && seen.info && cur.info.token === seen.info.token) || (!cur.info && !seen.info));
    if (same && isStale(cur)) {
      const tmp = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try { fs.renameSync(lock, tmp); unlinkRetry(tmp); } catch { /* lost the race: fine */ }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    unlinkRetry(breaker);
  }
}

function release(lock, token) {
  const cur = readLock(lock);
  if (cur && cur.info && cur.info.token === token) unlinkRetry(lock);
  held.delete(lock);
}

function releaseAll() {
  for (const [lock, token] of [...held]) release(lock, token);
}

const onSignal = (sig, code) => () => {
  releaseAll();
  if (process.listenerCount(sig) <= 1) process.exit(code);
};
const onSigint = onSignal('SIGINT', 130);
const onSigterm = onSignal('SIGTERM', 143);
const onExit = () => releaseAll();

function setHandlers(on) {
  if (on === handlersOn) return;
  handlersOn = on;
  const f = on ? 'on' : 'off';
  process[f]('SIGINT', onSigint);
  process[f]('SIGTERM', onSigterm);
  process[f]('exit', onExit);
}

// Runs fn() while holding <file>.lock; waits up to CREWGATE_LOCK_WAIT_MS (default 10 s)
// with jittered retries, then throws CrewError json.lockTimeout.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, created: Date.now() })); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      const seen = readLock(lock);
      if (isStale(seen)) removeStale(lock, seen);
      if (Date.now() - start > lockWaitMs()) throw new CrewError('json.lockTimeout', { file: path.basename(lock) });
      sleep(20 + Math.floor(Math.random() * 60));
    }
  }
  held.set(lock, token);
  setHandlers(true);
  try {
    return fn();
  } finally {
    release(lock, token);
    if (!held.size) setHandlers(false);
  }
}

// Locked read-modify-write. fn(data) mutates data in place and returns the result; if it
// throws, nothing is written. A corrupt file is moved aside first (warn(msg) says where);
// a file that cannot be read at all aborts without writing.
function update(file, fallback, fn, warn = (m) => process.stderr.write(`${m}\n`)) {
  return withLock(file, () => {
    const r = readJson(file, fallback);
    const out = fn(r.data);
    if (r.status === 'corrupt') {
      const moved = backupCorrupt(file);
      warn(t('en', 'json.corruptMoved', { file: path.basename(file), moved: path.basename(moved) }));
    }
    save(file, r.data);
    return out;
  });
}

module.exports = { readJson, read, save, saveRaw, stamp, withLock, update, backupCorrupt, LOCK_STALE_MS };
