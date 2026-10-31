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

// The runtime file holds the holder's pid (written by the holder); a stale file (holder gone) does not count.
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
    const pri = require('./priority');
    if (!pri.isClaude((deps.describe || pri.describe)(claudePid))) return 'not-claude';
    if (held(projectId, claudePid)) return 'already';
    const shell = deps.shell || findShell();
    if (!shell) { note(projectId, 'session.job.error', { reason: 'no-powershell' }); return 'no-shell'; }
    const cleanup = limits && limits.session_cleanup === 'off' ? 'off' : 'on';
    const file = pidFile(projectId, claudePid);
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.script || SCRIPT,
      '-ClaudePid', String(claudePid), '-ProjectId', projectId, '-PidFile', file, '-CrewHome', require('../core/paths').home(),
      '-NodeExe', process.execPath, '-RecordScript', __filename, '-CapPercent', String(cap), '-Cleanup', cleanup];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Node's own children die with it (libuv puts them in a kill-on-close job) and a `detached` PowerShell exits at
    // once (measured), so the holder is started by `cmd /c start /b` from a detached cmd: it is then outside both.
    // The holder writes its own pid to the runtime file. Arguments are quoted by hand (cmd re-parses the line).
    if (args.some((x) => /["%]/.test(x))) { note(projectId, 'session.job.error', { reason: 'bad-path' }); return 'bad-path'; }
    const q = (x) => `"${x}"`;
    const line = `"start "" /b ${q(shell)} ${args.map(q).join(' ')}"`;
    const child = (deps.spawn || spawn)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on && child.on('error', () => note(projectId, 'session.job.error', { reason: 'spawn-failed' }));
    child.unref && child.unref();
    return 'started';
  } catch { return 'error'; }
}

function findShell() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    for (const d of dirs) { try { const f = path.join(d, name); if (d && fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  }
  const sys = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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

module.exports = { start, held, pidFile, findShell };
