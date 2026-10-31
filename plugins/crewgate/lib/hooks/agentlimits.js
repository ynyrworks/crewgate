'use strict';

// What a crew subagent must not run, decided from the command line (best effort: a command that cannot be
// recognised passes, and so does any failure of this check).
//   reviewer / refuter: a git command that changes a working tree, the index, history or the branch list.
//   worker, reviewer, refuter: killing processes by image name (taskkill /IM, Stop-Process -Name, pkill, killall).
const G = require('./gitcmd');

const MAX_DEPTH = 3;
const ROLES = new Set(['crew-worker', 'crew-reviewer', 'crew-refuter']);
const READ_ONLY = new Set(['crew-reviewer', 'crew-refuter']);
const GIT_CHANGES = new Set(['checkout', 'switch', 'reset', 'merge', 'rebase', 'commit', 'stash', 'clean', 'restore',
  'cherry-pick', 'push', 'pull', 'revert', 'am']);
const BRANCH_EDIT = /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)(=.*)?)$/;
const BRANCH_LIST = /^(-l|-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged|--points-at)(=.*)?$/;

// -> { word } for the first thing found; word is the command's first word (no arguments).
function scan(command, type, depth = 0) {
  const toks = G.tokenize(command);
  let cur = [];
  let prevOp = null;
  let prevSeg = [];
  const one = (seg, op) => {
    const i = G.commandStart(seg);
    const cmd = G.base(seg[i] || '').toLowerCase();
    const rest = seg.slice(i + 1);
    const hit = () => ({ word: cmd });
    const wrapped = depth < MAX_DEPTH ? G.wrappedCommand(seg) : null;
    if (wrapped !== null) return scan(wrapped, type, depth + 1);
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
