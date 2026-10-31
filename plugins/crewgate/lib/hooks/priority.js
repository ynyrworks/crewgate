'use strict';

// Lower the Claude Code process to below normal priority, so every process it starts later (Bash, PowerShell,
// subagent commands, test runs) inherits it and the scheduler prefers the user's own apps. Windows and POSIX
// both pass the class / nice value on to children. Never raises, never kills; anything unexpected does nothing.
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

// The parent is only touched when its name (or command line) shows it is Claude Code. A shell, a launcher
// or a `node` we cannot tell apart is left alone.
const NAME_RE = /^claude(\.exe)?$/i;

function describe(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      const m = /^"([^"]+)","(\d+)"/m.exec(out);
      return m && Number(m[2]) === pid ? { name: m[1], args: '' } : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 }).trim();
    if (!out) return null;
    return { name: path.basename(out.split(/\s+/)[0]), args: out };
  } catch { return null; }
}

function isClaude(info) {
  if (!info) return false;
  if (NAME_RE.test(info.name)) return true;
  return /^(node|bun)(\.exe)?$/i.test(info.name) && /@anthropic-ai[\/]claude-code/.test(info.args || '');
}

// deps (describe, getPriority, setPriority) can be replaced by a test. Returns a short status string.
function lower(setting, pid = process.ppid, deps = {}) {
  try {
    if (setting === 'normal') return 'off';
    if (!Number.isInteger(pid) || pid <= 1) return 'no-parent';
    const info = (deps.describe || describe)(pid);
    if (!isClaude(info)) return 'not-claude';
    const get = deps.getPriority || os.getPriority;
    const set = deps.setPriority || os.setPriority;
    if (get(pid) >= BELOW_NORMAL) return 'already';   // already at or below: never raised
    set(pid, BELOW_NORMAL);
    return 'lowered';
  } catch { return 'error'; }
}

module.exports = { lower, isClaude, describe, BELOW_NORMAL };
