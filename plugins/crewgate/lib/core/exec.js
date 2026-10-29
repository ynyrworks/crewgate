'use strict';

// Starting external programs without a shell, the same way on every platform.
//   resolveCommand(cmd, opts)  -> absolute path of the program, or null (PATH, and PATHEXT on Windows)
//   spawnPlan(file, args, opts) -> { file, args, options } ready for child_process.spawnSync
// Never uses `shell: true`: on Windows a .cmd/.bat file is started through `cmd.exe /d /s /c` with
// every argument quoted by us and `windowsVerbatimArguments`, so nothing is left to be re-parsed.
const fs = require('fs');
const path = require('path');
const { CrewError } = require('./errors');

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isExecutable(p, platform) {
  if (!isFile(p)) return false;
  if (platform === 'win32') return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// opts: { platform, env, cwd }. A command with a directory part is not searched on PATH.
function resolveCommand(cmd, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const win = platform === 'win32';
  const exts = win
    ? String(env.PATHEXT || env.Pathext || DEFAULT_PATHEXT).split(';').map((x) => x.trim()).filter(Boolean)
    : [];
  const hasExt = win && exts.some((x) => cmd.toLowerCase().endsWith(x.toLowerCase()));
  const variants = (base) => {
    if (!win || hasExt) return [base];
    const out = [];
    for (const x of exts) out.push(base + x, base + x.toLowerCase());
    return out;
  };
  const sep = win ? /[\\/]/ : /\//;
  const dirs = sep.test(cmd)
    ? ['']
    : String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((d) => d.replace(/^"(.*)"$/, '$1'));
  for (const dir of dirs) {
    const base = dir ? path.join(dir, cmd) : path.resolve(cwd, cmd);
    for (const cand of variants(base)) {
      if (isExecutable(cand, platform)) return cand;
    }
  }
  return null;
}

const BATCH_RE = /\.(cmd|bat)$/i;

// One argument for a cmd.exe command line. Characters cmd.exe would still interpret inside quotes
// (a quote, %, a line break) are refused instead of escaped.
function quoteForCmd(arg) {
  const s = String(arg);
  if (/["%\r\n\0]/.test(s)) throw new CrewError('wf.review.badEngineArg', { arg: s.slice(0, 40) });
  if (s !== '' && !/[\s&|<>()^!,;=]/.test(s)) return s;
  return `"${s.replace(/(\+)$/, '$1$1')}"`;
}

// opts: { platform, comspec }. -> { file, args, options } where options holds windowsVerbatimArguments.
function spawnPlan(file, args, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32' && BATCH_RE.test(file)) {
    const line = [file, ...(args || [])].map(quoteForCmd).join(' ');
    const comspec = opts.comspec || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file, args: args || [], options: {} };
}

module.exports = { resolveCommand, spawnPlan, quoteForCmd };
