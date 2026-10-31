'use strict';

// What a crew subagent must not run, decided from the command line (best effort: a command that cannot be
// recognised passes, and so does any failure of this check).
//   reviewer / refuter: a git command that changes a working tree, the index, history or the branch list.
//   worker, reviewer, refuter: killing processes by image name (taskkill /IM, Stop-Process -Name, pkill, killall).
//   worker, reviewer, refuter also: an inline loop with no end (node -e, python -c, powershell, a bash while true,
//   yes > /dev/null, stress without a time limit) and a shell loop that starts more background copies than half the
//   CPU cores. A script or a file is never read, and nothing here limits a process once it runs.
const os = require('os');
const G = require('./gitcmd');

const MAX_DEPTH = 3;
const ROLES = new Set(['crew-worker', 'crew-reviewer', 'crew-refuter']);
const READ_ONLY = new Set(['crew-reviewer', 'crew-refuter']);
const GIT_CHANGES = new Set(['checkout', 'switch', 'reset', 'merge', 'rebase', 'commit', 'stash', 'clean', 'restore',
  'cherry-pick', 'push', 'pull', 'revert', 'am']);
const BRANCH_EDIT = /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)(=.*)?)$/;
const BRANCH_LIST = /^(-l|-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged|--points-at)(=.*)?$/;

const JS_LOOP = /\bwhile\s*\(\s*(true|1|!0|!!1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/;
const PY_LOOP = /\bwhile\s+\(?\s*(True|1)\s*\)?\s*:/;
const PS_LOOP = /\bwhile\s*\(\s*(\$true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i;
const PS_TRUE = /\bwhile\s*\(\s*\$true\s*\)/i;
const PRINTS = /^(echo|printf|cat|write-host|write-output)$/i;
const FOR_RE = /\bfor\s+\w+\s+in\s+([^;\n]*?)\s*;?\s*(?:\n\s*)?do\b([\s\S]*?)\bdone\b/g;
const DISCARD = /(?:>|>>|&>)\s*(?:\/dev\/null|nul)\b/i;

// The code after an inline-code flag: `node -e CODE`, `node --eval=CODE`.
function inlineCode(rest, flags) {
  const j = rest.findIndex((w) => flags.test(w.split('=')[0]));
  if (j < 0) return '';
  return rest[j].startsWith('--') && rest[j].includes('=') ? rest[j].slice(rest[j].indexOf('=') + 1) : String(rest[j + 1] || '');
}

// The command after `timeout [opts] DURATION`; null when it is not that shape.
function timeoutInner(rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) i += /^(-s|-k|--signal|--kill-after)$/.test(rest[i]) ? 2 : 1;
  return /^\d+(\.\d+)?[smhd]?$/.test(rest[i] || '') ? rest.slice(i + 1) : null;
}

// How many times a `for x in LIST` runs, or null when it cannot be read.
function iterations(list) {
  const l = list.trim();
  let m = /^(?:\$\(|`)\s*seq\s+([\d\s]+?)\s*(?:\)|`)$/.exec(l);
  if (m) {
    const n = m[1].trim().split(/\s+/).map(Number);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[1] - n[0] + 1;
    if (n.length === 3 && n[1] > 0) return Math.floor((n[2] - n[0]) / n[1]) + 1;
    return null;
  }
  m = /^\{(\d+)\.\.(\d+)(?:\.\.(\d+))?\}$/.exec(l);
  if (m) return Math.floor(Math.abs(Number(m[2]) - Number(m[1])) / (Number(m[3]) || 1)) + 1;
  const words = l.split(/\s+/).filter(Boolean);
  return words.length && words.every((w) => /^[\w.-]+$/.test(w)) ? words.length : null;
}

// A `for` loop whose body starts a background job (&) more often than half the CPU cores.
function manyCopies(command) {
  const half = Math.floor((os.cpus() || []).length / 2);
  if (half < 1) return false;
  for (const m of String(command).slice(0, 20000).matchAll(FOR_RE)) {
    const n = iterations(m[1]);
    if (n !== null && n > half && /&/.test(m[2].replace(/&&|&>|>&\d?|\d>&\d/g, ''))) return true;
  }
  return false;
}

// -> { word } for the first thing found; word is the command's first word (no arguments). loop: true for a busy loop.
// shellTimed: the command line is what `timeout N bash -c` runs, so a shell loop in it has a time limit.
function scan(command, type, depth = 0, shellTimed = false) {
  const toks = G.tokenize(command);
  if (typeof toks[0] === 'string' && !PRINTS.test(G.base(toks[0])) && PS_TRUE.test(command)) return { word: G.base(toks[0]), loop: true };
  if (manyCopies(command)) return { word: 'for', loop: true };
  let cur = [];
  let prevOp = null;
  let prevSeg = [];
  const one = (seg, op, direct = false) => {
    const i = G.commandStart(seg);
    const cmd = G.base(seg[i] || '').toLowerCase();
    const rest = seg.slice(i + 1);
    const hit = () => ({ word: cmd });
    const loop = () => ({ word: cmd, loop: true });
    const wrapped = depth < MAX_DEPTH ? G.wrappedCommand(seg) : null;
    if (wrapped !== null) {
      if ((cmd === 'powershell' || cmd === 'pwsh') && PS_LOOP.test(wrapped)) return loop();
      // cmd and PowerShell hand over their words joined, so the quotes around inline code are gone: read the text.
      if ((cmd === 'cmd' || cmd === 'powershell' || cmd === 'pwsh')
        && ((/\bnodej?s?(\.exe)?\s+(-e|-pe?|--eval|--print)\b/i.test(wrapped) && JS_LOOP.test(wrapped))
          || (/\bpython[\d.]*(\.exe)?\s+-c\b/i.test(wrapped) && PY_LOOP.test(wrapped)))) return loop();
      return scan(wrapped, type, depth + 1, direct);
    }
    if (cmd === 'timeout') { const inner = timeoutInner(rest); return inner && inner.length ? one(inner, op, true) : null; }
    const w0 = /^(then|do|else)$/.test(seg[0]) ? seg.slice(1) : seg;
    if (w0[0] === 'while' && w0.length === 2 && (w0[1] === 'true' || w0[1] === ':')) return shellTimed ? null : { word: 'while', loop: true };
    if (cmd === 'node' || cmd === 'nodejs') return !direct && JS_LOOP.test(inlineCode(rest, /^(-e|-p|-pe|--eval|--print)$/)) ? loop() : null;
    if (/^(python[\d.]*|py|pypy3?)$/.test(cmd)) return PY_LOOP.test(inlineCode(rest, /^-c$/)) ? loop() : null;
    if (cmd === 'yes') return DISCARD.test(command) && !/\|\s*head\b/i.test(command) ? loop() : null;
    if (cmd === 'stress' || cmd === 'stress-ng') return rest.some((w) => /^(-t\d*|--timeout(=.*)?)$/.test(w)) ? null : loop();
    if (cmd === 'taskkill') return rest.some((w) => /^[-/]im$/i.test(w)) ? hit() : null;
    if (cmd === 'pkill' || cmd === 'killall') return hit();
    if (cmd === 'stop-process' || cmd === 'spps') {
      const isId = (w) => /^-id$/i.test(w);
      const byId = rest.some(isId) || (prevOp === '|' && prevSeg.some(isId));
      const byName = rest.some((w) => /^-n(a(me?)?)?(:.*)?$/i.test(w));
      return byName || (prevOp === '|' && !byId) ? hit() : null;
    }
    if (cmd === 'git' && READ_ONLY.has(type)) {
      const { j } = G.gitOptions(rest);
      const sub = rest[j];
      const args = rest.slice(j + 1);
      if (GIT_CHANGES.has(sub)) return hit();
      if (sub === 'worktree' && args[0] !== 'list') return hit();
      if (sub === 'branch') {
        const flags = args.filter((w) => w.startsWith('-'));
        const positional = args.some((w) => !w.startsWith('-'));
        if (flags.some((w) => BRANCH_EDIT.test(w))) return hit();
        if (positional && !flags.some((w) => BRANCH_LIST.test(w))) return hit();
      }
    }
    return null;
  };
  for (const t of toks) {
    if (typeof t === 'object' && G.OPS.has(t.op)) {
      if (cur.length) { const r = one(cur, t.op); if (r) return r; prevSeg = cur; }
      cur = [];
      prevOp = t.op;
    } else cur.push(t);
  }
  return cur.length ? one(cur, null) : null;
}

const limited = (type) => ROLES.has(type);

module.exports = { scan, limited };
