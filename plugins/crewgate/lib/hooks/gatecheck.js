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

// A `git merge` run inside a linked worktree that is neither a task worktree of the project nor its main checkout (a scratch
// worktree: a check-out made to test or build something) is not a merge into the project's branches: it records nothing and
// reminds nothing. Marks f.ignore on such a detected command. Only looks at `git merge`; any doubt leaves it counted.
function markTemp(fh, f, sessionCwd) {
  if (!f || f.type !== 'git.merge' || !f.data || f.data.command !== 'git merge') return f;
  try {
    const dir = targetDir(sessionCwd, f.cd) || sessionCwd;
    const info = require('../core/project').inspect(dir);
    if (!info.linked) return f;
    const norm = require('../core/project').normalizePath;
    const mine = require('../core/tasks').list(fh.pid).filter((t) => t.worktree).map((t) => norm(path.resolve(fh.root, t.worktree)));
    if (!mine.includes(norm(info.workTree))) f.ignore = true;
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

// Gates of `wanted` that are set to ask and have no usable approval from this session:
// { missing: [{ gate, command, text }], by: Map gate -> "plan:<slug>" | "gate:<id>" } (by: what covers the ones that are not missing).
// Config unreadable = nothing missing (the modes are unknown). Events unreadable =
// nothing missing, unless o.failClosed (gates.enforce block): an approval that cannot be seen does not count.
function check(h, wanted, o = {}) {
  const missing = [];
  const by = new Map();
  let cfg;
  try { cfg = h.cfg(); } catch { return { missing, by }; }
  const opts = { requireUserTurn: gates.requiresUserTurn(cfg) };
  for (const [gate, w] of wanted) {
    if (gates.modeOf(cfg, gate) !== 'ask') continue;
    if (gate === 'merge') {
      let slug = null;
      try { slug = planCover(h, cfg, w); } catch { /* no cover */ }
      if (slug) { by.set(gate, `plan:${slug}`); continue; }
    }
    let approved = !o.failClosed;
    const out = {};
    try { approved = gates.hasApproval(h.pid, gate, h.sid, Date.now(), { ...opts, out }); } catch { /* cannot tell */ }
    if (!approved) missing.push({ gate, ...w });
    else if (out.by) by.set(gate, out.by);
  }
  return { missing, by };
}

const unapproved = (h, wanted, o) => check(h, wanted, o).missing;

module.exports = { GIT_WORDS, targetDir, makeHandleFor, markTemp, isCodex, wantedGates, forbidden, check, unapproved, planCover };
