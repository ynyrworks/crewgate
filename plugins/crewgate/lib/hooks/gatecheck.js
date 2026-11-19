'use strict';

// What PreToolUse(Bash) and PostToolUse(Bash) share for approval gates: which project a command acts on
// (cd / pushd / git -C), which gates it falls under, and whether this session holds an approval.
const path = require('path');
const C = require('./common');
const gates = require('../core/gates');

// Cheap pre-filter so ordinary Bash calls never pay for project resolution.
const GIT_WORDS = /\b(push|merge|create)\b/;

// Git-Bash style /c/work/x (and /cygdrive/c/...) -> C:/work/x; only on Windows, other words pass through.
function nativeDir(w) {
  if (process.platform !== 'win32') return w;
  const m = /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/.exec(w);
  return m ? `${m[1].toUpperCase()}:/${m[2] || ''}` : w;
}

// The directory a command's cd / git -C words lead to, starting at the session cwd; null for no words.
function targetDir(cwd, steps) {
  if (!steps || !steps.length) return null;
  let dir = cwd;
  for (const w of steps) dir = path.resolve(dir, nativeDir(w));
  return dir;
}

// handleFor(f) -> the hook handle of the project a detected command acts on: the session's own for a command
// without cd words, otherwise the project of the directory they lead to (null = outside every registered
// project, never registered here). Full resolution (no session-file shortcut): a registered repo nested
// inside the session repo is its own project.
function makeHandleFor(payload, h) {
  const sessionCwd = C.str(payload.cwd) || process.cwd();
  const handles = new Map();
  return (f) => {
    const dir = targetDir(sessionCwd, f.cd);
    if (!dir) return h;
    if (!handles.has(dir)) {
      let t = null;
      try { t = C.open({ ...payload, cwd: dir }, { full: true }); } catch { /* unusable directory */ }
      handles.set(dir, t);
    }
    return handles.get(dir);
  };
}

// Runs git in `dir`; stdout trimmed, or null on failure.
function gitOut(dir, args, input) {
  const r = require('child_process').spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true, input });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

// Does the branch checked out in `dir` matter to the project? No when HEAD is detached, or when the branch is a throwaway: not a task
// branch, no upstream, and no commit of its own (no non-merge commit that no other branch, remote or tag holds, so before and after
// the merge alike). Any doubt: it matters.
function throwaway(fh, dir) {
  const branch = gitOut(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch === null) return gitOut(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null; // detached (null for both = unknown)
  if (!branch) return false;
  if (require('../core/tasks').list(fh.pid).some((t) => t.branch === branch)) return false;
  if (gitOut(dir, ['config', '--get', `branch.${branch}.remote`])) return false;
  const refs = (gitOut(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']) || '').split(/\r?\n/).filter(Boolean);
  const own = gitOut(dir, ['rev-list', '--no-merges', '--count', '--stdin'], [`refs/heads/${branch}`, ...refs.filter((r) => r !== `refs/heads/${branch}`).map((r) => `^${r}`)].join('\n') + '\n');
  return own === '0';
}

// Which `git merge` commands are ignored (f.ignore = true: nothing recorded, no reminder): only a plain `git merge` run in a linked
// worktree that is not a task worktree of the project and that is not the session's own work tree, when that worktree has a
// detached HEAD or a throwaway branch (see throwaway()). Merges in the main checkout, in a task worktree, in the session's own
// work tree (gated like the main checkout) and in any worktree whose branch matters stay gated. Any doubt leaves it counted.
function markTemp(fh, f, sessionCwd) {
  if (!f || f.type !== 'git.merge' || !f.data || f.data.command !== 'git merge') return f;
  try {
    const dir = targetDir(sessionCwd, f.cd) || sessionCwd;
    const info = require('../core/project').inspect(dir);
    if (!info.linked) return f;
    const norm = require('../core/project').normalizePath;
    const mine = require('../core/tasks').list(fh.pid).filter((t) => t.worktree).map((t) => norm(path.resolve(fh.root, t.worktree)));
    if (!mine.includes(norm(info.workTree)) && throwaway(fh, dir)) f.ignore = true;
  } catch { /* cannot tell: counted */ }
  return f;
}

// Codex payloads carry turn_id; its PreToolUse honours "deny" but "ask" fails open, so Codex is only ever sent deny.
const isCodex = (payload) => typeof payload.turn_id === 'string' && payload.turn_id !== '';

// The gates a set of detected commands falls under -> Map gate -> display text of the first command.
function wantedGates(found) {
  const wanted = new Map();
  for (const f of found) {
    const gate = gates.gateOf(f);
    if (!gate || wanted.has(gate)) continue;
    const d = f.data || {};
    const words = [d.remote, ...(Array.isArray(d.refs) ? d.refs : []), ...(Array.isArray(d.branches) ? d.branches : []), d.head && `--head ${d.head}`]
      .filter((x) => typeof x === 'string' && x).join(' ');
    wanted.set(gate, { command: d.command, text: C.snippet(words ? `${d.command} ${words}` : d.command, 120), items: [] });
  }
  for (const f of found) {
    const gate = gates.gateOf(f);
    if (gate && wanted.has(gate) && f.data) wanted.get(gate).items.push(f.data);
  }
  return wanted;
}

// Gates of `wanted` that are set to never: [{ gate, command, text }]. No approval lifts these.
// Config unreadable = none (the modes are unknown).
function forbidden(h, wanted) {
  let cfg;
  try { cfg = h.cfg(); } catch { return []; }
  return [...wanted].filter(([gate]) => gates.modeOf(cfg, gate) === 'never').map(([gate, w]) => ({ gate, ...w }));
}

// The slug of the final plan whose approval covers every `git merge` of this gate entry, or null. Local merges only: a PR merge,
// a merge whose branch words are unknown (dynamic) or empty, or gates.plan_covers_merge=false is never covered.
function planCover(h, cfg, w) {
  if (cfg.gates && cfg.gates.plan_covers_merge === false) return null;
  const items = w.items || [];
  if (!items.length || items.some((d) => d.command !== 'git merge' || d.dynamic || !Array.isArray(d.branches) || !d.branches.length)) return null;
  const plans = require('../core/plans');
  const branches = items.flatMap((d) => d.branches);
  for (const root of new Set([h.workTree, h.root])) {
    const slug = plans.mergeCover(root, h.pid, branches);
    if (slug) return slug;
  }
  return null;
}

// The task a detected action belongs to (by the branch words of the command), or null.
function taskOfItem(taskList, d) {
  if (!d) return null;
  const names = [...(d.branches || []), ...(d.refs || []).flatMap((r) => String(r).split(':')), d.head]
    .filter((x) => typeof x === 'string' && x).map((x) => x.replace(/^\+/, '').replace(/^refs\/heads\//, ''));
  for (const n of names) {
    const t = taskList.find((x) => x.branch && x.branch === n);
    if (t) return t.id;
  }
  return null;
}

// Gates of `wanted` that are set to ask and have no usable approval from this session:
// { missing: [{ gate, command, text }], by: Map gate -> "plan:<slug>" | "gate:<id>", items: Map gate -> one entry per detected action
// (null = not covered) } (by: what covers the first covered action of a gate that is not missing).
// One yes covers one action: a command line with more pushes (or merges not covered by a plan) than unused yeses leaves the extra ones
// uncovered, and the gate missing. An action whose branch belongs to task T is covered by a yes asked for T or for no task (never by a yes for another task); an action of no task by any yes.
// Config unreadable = nothing missing (the modes are unknown). Events unreadable =
// nothing missing, unless o.failClosed (gates.enforce block): an approval that cannot be seen does not count.
function check(h, wanted, o = {}) {
  const missing = [];
  const by = new Map();
  const itemsBy = new Map();
  let cfg;
  try { cfg = h.cfg(); } catch { return { missing, by, items: itemsBy }; }
  const opts = { requireUserTurn: gates.requiresUserTurn(cfg) };
  let taskList = null;
  for (const [gate, w] of wanted) {
    if (gates.modeOf(cfg, gate) !== 'ask') continue;
    const items = w.items && w.items.length ? w.items : [null];
    if (gate === 'merge') {
      let slug = null;
      try { slug = planCover(h, cfg, w); } catch { /* no cover */ }
      if (slug) { by.set(gate, `plan:${slug}`); itemsBy.set(gate, items.map(() => `plan:${slug}`)); continue; }
    }
    let pool = null;
    try {
      pool = gates.usableYeses(h.pid, gate, h.sid, Date.now(), opts);
      if (!taskList) { try { taskList = require('../core/tasks').list(h.pid); } catch { taskList = []; } }
    } catch { /* cannot tell */ }
    if (!pool) {
      if (o.failClosed) missing.push({ gate, ...w });
      continue;
    }
    const picked = new Set();
    const per = items.map((d) => {
      const t = taskOfItem(taskList || [], d);
      const free = pool.filter((y) => !picked.has(y));
      const y = t ? (free.find((x) => x.task === t) || free.find((x) => !x.task)) : (free.find((x) => !x.task) || free[0]);
      if (!y) return null;
      picked.add(y);
      return `gate:${y.data.id}`;
    });
    itemsBy.set(gate, per);
    if (per.some((x) => !x)) missing.push({ gate, ...w });
    const first = per.find(Boolean);
    if (first) by.set(gate, first);
  }
  return { missing, by, items: itemsBy };
}

const unapproved = (h, wanted, o) => check(h, wanted, o).missing;

module.exports = { GIT_WORDS, targetDir, makeHandleFor, markTemp, isCodex, wantedGates, forbidden, check, unapproved, planCover };
