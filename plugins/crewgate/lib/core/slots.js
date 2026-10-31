'use strict';

// Machine-wide slots for heavy commands (a build jobserver): <home>/slots/slot-<i>.json is created exclusively
// and holds { pid, started } (no command line). One slot by default, so only one full test run happens at a time
// across worktrees and projects. Rules that keep it from ever hanging work for good:
//   - a holder whose pid is dead frees its slot (the file is taken over);
//   - the wait has a maximum; after it the command runs anyway (onTimeout is called, a line is printed);
//   - any failure in the slot code runs the command anyway;
//   - exit code, output and stdin of the command pass through (stdio is inherited).
// Nesting: the holder puts CREWGATE_SLOT_HELD=<pid>:<index> into the environment of its command. A process that
// finds it, with that slot file still holding that live pid, runs at once, so children share the holder's slot.
// When the command runs anyway (timeout or failure) the marker is `free:<pid>` (the wrapper's pid, valid while it lives).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const ENV_HELD = 'CREWGATE_SLOT_HELD';
const DEFAULT_SLOTS = 1;
const DEFAULT_MAX_WAIT_S = 600;
const NOTE_MS = 30000;
const POLL_MS = 500;
const HALF_WRITTEN_MS = 5000;   // a slot file that cannot be parsed is a holder still writing it: stale only after this

function slotsDir() { return path.join(paths.home(), 'slots'); }
function slotFile(i) { return path.join(slotsDir(), `slot-${i}.json`); }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> { pid, started } | null (missing) | 'half' (exists, not parseable yet)
function readSlot(i) {
  let raw;
  try { raw = fs.readFileSync(slotFile(i), 'utf8'); } catch { return null; }
  try {
    const o = JSON.parse(raw);
    if (o && Number.isInteger(o.pid)) return { pid: o.pid, started: o.started };
  } catch { /* fall through */ }
  return 'half';
}

// Tries to take slot i. -> true | { pid, since } of a live holder | false (could not decide, try again)
function tryTake(i, now) {
  const f = slotFile(i);
  for (let round = 0; round < 2; round++) {
    try {
      const fd = fs.openSync(f, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date(now()).toISOString() })); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const cur = readSlot(i);
    if (cur === null) continue;   // freed meanwhile
    if (cur === 'half') {
      let age = 0;
      try { age = now() - fs.statSync(f).mtimeMs; } catch { continue; }
      if (age <= HALF_WRITTEN_MS) return { pid: 0, since: now() };
    } else if (alive(cur.pid)) {
      const t = Date.parse(cur.started);
      return { pid: cur.pid, since: Number.isFinite(t) ? t : now() };
    }
    // dead holder: take over, but only if the file is still the one we read
    if (JSON.stringify(readSlot(i)) !== JSON.stringify(cur)) continue;
    try { fs.unlinkSync(f); } catch { /* somebody else did */ }
  }
  return false;
}

function release(i) {
  try {
    const cur = readSlot(i);
    if (cur && cur !== 'half' && cur.pid === process.pid) fs.unlinkSync(slotFile(i));
  } catch { /* nothing to free */ }
}

// Is this process already inside a slot (its parent holds one)?
function held(env) {
  const v = (env && env[ENV_HELD]) || '';
  const f = /^free:(\d+)$/.exec(v);   // set when the command ran anyway: valid while that wrapper lives
  if (f) return alive(Number(f[1]));
  const m = /^(\d+):(\d+)$/.exec(v);
  if (!m) return false;
  const cur = readSlot(Number(m[2]));
  return !!cur && cur !== 'half' && cur.pid === Number(m[1]) && alive(cur.pid);
}

// Waits for a slot. -> { index } | { timedOut: true }. Throws when the slot folder cannot be used.
// opts: slots, maxWaitMs, noteMs, pollMs, onWait({ pid, heldMs }), now
async function acquire(opts = {}) {
  const n = Math.max(1, opts.slots || DEFAULT_SLOTS);
  const now = opts.now || Date.now;
  const maxWait = opts.maxWaitMs === undefined ? DEFAULT_MAX_WAIT_S * 1000 : opts.maxWaitMs;
  const noteMs = opts.noteMs || NOTE_MS;
  const pollMs = opts.pollMs || POLL_MS;
  fs.mkdirSync(slotsDir(), { recursive: true });
  const start = now();
  let lastNote = -Infinity;
  for (;;) {
    let holder = null;
    for (let i = 0; i < n; i++) {
      const r = tryTake(i, now);
      if (r === true) return { index: i };
      if (r && !holder) holder = r;
    }
    const t = now();
    if (t - start >= maxWait) return { timedOut: true };
    if (holder && opts.onWait && t - lastNote >= noteMs) {
      lastNote = t;
      try { opts.onWait({ pid: holder.pid, heldMs: Math.max(0, t - holder.since) }); } catch { /* a note is optional */ }
    }
    await sleep(Math.min(pollMs, Math.max(1, maxWait - (t - start))));
  }
}

function quote(a) { return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`; }

// Starts the command with the caller's stdio. -> Promise of its exit code (1 when it died on a signal, 127 when it did not start).
function exec(argv, env, say, killRef) {
  return new Promise((resolve) => {
    let child;
    const cmd = argv[0];
    try {
      // npm, npx and .cmd files are batch scripts on Windows: they need a shell, given as one quoted line
      if (process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$|\.(cmd|bat)$/i.test(cmd)) child = spawn(argv.map(quote).join(' '), { stdio: 'inherit', env, shell: true });
      else child = spawn(cmd, argv.slice(1), { stdio: 'inherit', env });
    } catch (e) { say('slot.spawnFailed', { command: cmd, reason: e.message }); resolve(127); return; }
    killRef.kill = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
    child.on('error', (e) => { say('slot.spawnFailed', { command: cmd, reason: e.message }); resolve(127); });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

// Runs argv under a slot. -> exit code of the command. Never fails because of the slot code.
// opts: slots, maxWaitSeconds, say(key, vars) for the lines on stderr, onTimeout({ waitedSeconds }), env, plus the acquire options.
async function run(argv, opts = {}) {
  const say = opts.say || (() => {});
  const env = opts.env || process.env;
  const maxWaitMs = opts.maxWaitSeconds === undefined ? DEFAULT_MAX_WAIT_S * 1000 : opts.maxWaitSeconds * 1000;
  let got = null;
  let ranAnyway = false;
  const killRef = { kill: null };
  const onSig = (sig) => () => {
    if (killRef.kill) killRef.kill(sig);
    else { if (got) release(got.index); process.exit(sig === 'SIGINT' ? 130 : 143); }
  };
  const handlers = { SIGINT: onSig('SIGINT'), SIGTERM: onSig('SIGTERM') };
  for (const s of Object.keys(handlers)) process.on(s, handlers[s]);
  try {
    try {
      if (!held(env)) {
        got = await acquire({
          ...opts,
          maxWaitMs,
          onWait: ({ pid, heldMs }) => say('slot.waiting', { pid: pid || '?', seconds: Math.round(heldMs / 1000) }),
        });
        if (got.timedOut) {
          say('slot.timeout', { seconds: Math.round(maxWaitMs / 1000) });
          try { if (opts.onTimeout) opts.onTimeout({ waitedSeconds: Math.round(maxWaitMs / 1000) }); } catch { /* best effort */ }
          got = null;
          ranAnyway = true;
        }
      }
    } catch (e) {
      say('slot.failed', { reason: e && e.message });
      got = null;
      ranAnyway = true;
    }
    // No slot (timeout or failure): mark the command as running anyway so a nested caller does not wait again.
    // Set here and only here; an inherited marker (nested case, held) is passed on unchanged.
    const childEnv = got ? { ...env, [ENV_HELD]: `${process.pid}:${got.index}` } : (ranAnyway ? { ...env, [ENV_HELD]: `free:${process.pid}` } : env);
    return await exec(argv, childEnv, say, killRef);
  } finally {
    for (const s of Object.keys(handlers)) process.removeListener(s, handlers[s]);
    if (got) release(got.index);
  }
}

module.exports = { run, acquire, release, held, alive, slotsDir, slotFile, ENV_HELD, DEFAULT_MAX_WAIT_S };
