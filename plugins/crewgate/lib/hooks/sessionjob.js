'use strict';

// Windows only: put the Claude Code process in one Job Object, cap its total CPU, and clean up what is left when it
// exits. A holder process (scripts/session-job.ps1) does the work, so SessionStart never waits. Nothing here can
// hurt the session: no kill-on-close, no TerminateJobObject, every failure is an event and the session goes on.
// Also a tiny CLI for the holder: `node sessionjob.js --record <projectId> <type> key=value ...` appends an event.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'session-job.ps1');

function pidFile(projectId, claudePid) {
  return path.join(require('../core/paths').runtimeDir(projectId), `session-job-${claudePid}.pid`);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const CLAIM_MS = 30000;   // a claim whose holder never wrote its pid is stale after this long

// The runtime file holds the holder's pid (written by the holder). Before spawning, Node claims it exclusively (flag wx,
// as takeLock in board.js does), so two SessionStart hooks for one Claude pid start one holder. A file naming a live
// pid, or a claim younger than CLAIM_MS, means taken; anything older is stale and replaced. -> true when claimed.
function claim(projectId, claudePid) {
  const f = pidFile(projectId, claudePid);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { return false; }
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, `claim:${process.pid}`, { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const n = Number(fs.readFileSync(f, 'utf8').trim());
        if (Number.isInteger(n) && n > 0 && pidAlive(n)) return false;
        if (Date.now() - fs.statSync(f).mtimeMs <= CLAIM_MS) return false;
        fs.unlinkSync(f);
      } catch { return false; }
    }
  }
  return false;
}

// A live pid in the runtime file means a holder already runs for this Claude Code process.
function held(projectId, claudePid) {
  try {
    const n = Number(fs.readFileSync(pidFile(projectId, claudePid), 'utf8').trim());
    return Number.isInteger(n) && n > 0 && pidAlive(n);
  } catch { return false; }
}

function note(projectId, type, data) {
  try { require('../core/events').append(projectId, { type, src: 'hook', data, key: `${Date.now()}:${process.pid}` }); } catch { /* logging only */ }
}

// start(projectId, limits, claudePid, deps) -> short status string. deps: describe, spawn, platform, shell (tests).
function start(projectId, limits, claudePid = process.ppid, deps = {}) {
  try {
    if ((deps.platform || process.platform) !== 'win32') return 'not-windows';
    const cap = Number(limits && limits.session_cpu_percent === undefined ? 60 : limits && limits.session_cpu_percent);
    if (!Number.isInteger(cap) || cap < 10 || cap > 100) return 'bad-cap';
    if (!Number.isInteger(claudePid) || claudePid <= 1) return 'no-parent';
    if (held(projectId, claudePid)) return 'already';   // before describe (a tasklist): compact and clear are free
    const pri = require('./priority');
    if (!pri.isClaude((deps.describe || pri.describe)(claudePid))) return 'not-claude';
    const shell = deps.shell || findShell();
    if (!shell) { note(projectId, 'session.job.error', { reason: 'no-powershell' }); return 'no-shell'; }
    const hookStart = Date.now();
    const cleanup = limits && limits.session_cleanup === 'off' ? 'off' : 'on';
    const file = pidFile(projectId, claudePid);
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.script || SCRIPT,
      '-ClaudePid', String(claudePid), '-ProjectId', projectId, '-PidFile', file, '-CrewHome', require('../core/paths').home(),
      '-NodeExe', process.execPath, '-RecordScript', __filename, '-CapPercent', String(cap), '-Cleanup', cleanup, '-HookStart', String(hookStart)];
    if (!claim(projectId, claudePid)) return 'already';
    // Node's own children die with it (libuv puts them in a kill-on-close job) and a `detached` PowerShell exits at
    // once (measured), so the holder is started by `cmd /c start /b` from a detached cmd: it is then outside both.
    // The holder writes its own pid to the runtime file. Arguments are quoted by hand (cmd re-parses the line).
    if (args.some((x) => /["%]/.test(x))) { try { fs.unlinkSync(file); } catch { /* none */ } note(projectId, 'session.job.error', { reason: 'bad-path' }); return 'bad-path'; }
    const q = (x) => `"${x}"`;
    const line = `"start "" /b ${q(shell)} ${args.map(q).join(' ')}"`;
    let child;
    try {
      child = (deps.spawn || spawn)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line],
        { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    } catch {
      try { fs.unlinkSync(file); } catch { /* none */ }
      note(projectId, 'session.job.error', { reason: 'spawn-failed' });
      return 'error';
    }
    child.on && child.on('error', () => { try { fs.unlinkSync(file); } catch { /* none */ } note(projectId, 'session.job.error', { reason: 'spawn-failed' }); });
    child.unref && child.unref();
    return 'started';
  } catch { return 'error'; }
}

function findShell() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    for (const d of dirs) { try { const f = path.join(d, name); if (d && fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  }
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(sys) ? sys : '';
}

function cli(argv) {
  if (argv[0] !== '--record' || argv.length < 3) return;
  const data = {};
  for (const kv of argv.slice(3)) {
    const i = kv.indexOf('=');
    if (i < 1) continue;
    const v = kv.slice(i + 1);
    data[kv.slice(0, i)] = /^-?\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
  }
  note(argv[1], argv[2], data);
}

if (require.main === module) { try { cli(process.argv.slice(2)); } catch { /* nothing to do */ } }

module.exports = { start, claim, held, pidFile, findShell };
