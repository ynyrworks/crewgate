'use strict';

// A task's git worktree: may it be removed, and the removal itself. `check` decides and removes nothing; `remove` acts on a
// passing check. Nothing here deletes a branch, passes --force to git or runs `git worktree prune`.
// check -> null (no worktree recorded, or its folder is gone: nothing to say)
//        | { path, ok, reason?, adopt?, main } ; reason codes: setting-off, not-a-worktree, main-checkout, not-merged,
//          inside, dirty, status-failed (git status cannot be read), cancelled (only with opts.explicit). adopt is true when the only change is the untracked .crew/LESSONS.md (lessons still to adopt).
// remove -> { path, removed, reason?, adopted?, message? } ; extra reason codes: adopt-failed, git-failed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const project = require('../core/project');
const common = require('./common');
const lessons = require('./lessons');

const norm = (p) => project.normalizePath(p);

function listed(root) {
  const out = common.git(['worktree', 'list', '--porcelain'], root);
  if (out === null) return null;
  return out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9)));
}

function inside(dir, root) {
  const d = norm(dir);
  const r = norm(root);
  return d === r || d.startsWith(r.endsWith('/') ? r : `${r}/`);
}

// opts.explicit (`crew task clean`): the user asked for the cleanup, so worktree.remove_on_merge is not consulted and a cancelled
// task's worktree is never removable (its work was not merged).
function check(proj, task, cwd, cfg, opts) {
  if (!task || !task.worktree) return null;
  const wt = path.resolve(proj.path, String(task.worktree));
  if (!fs.existsSync(wt)) return null;
  const res = (ok, reason, more) => ({ path: wt, ok, ...(reason ? { reason } : {}), main: proj.path, ...(more || {}) });
  const explicit = !!(opts && opts.explicit);
  if (!explicit && cfg && cfg.worktree && cfg.worktree.remove_on_merge === false) return res(false, 'setting-off');
  if (explicit && task.state === 'cancelled') return res(false, 'cancelled');
  const known = listed(proj.path);
  if (!known || !known.includes(norm(wt))) return res(false, 'not-a-worktree');
  if (norm(wt) === norm(proj.path) || known[0] === norm(wt)) return res(false, 'main-checkout');
  const branch = task.branch;
  const tip = branch && /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(branch) && !branch.includes('..')
    ? (common.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], proj.path) || '').trim() : '';
  if (!tip || common.git(['merge-base', '--is-ancestor', tip, 'HEAD'], proj.path) === null) return res(false, 'not-merged');
  if (cwd && inside(cwd, wt)) return res(false, 'inside');
  const st = common.git(['status', '--porcelain', '--untracked-files=all', '-z'], wt);
  if (st === null) return res(false, 'status-failed');
  const entries = st.split('\0').filter(Boolean);
  if (!entries.length) return res(true);
  if (entries.length === 1 && entries[0] === '?? .crew/LESSONS.md') return res(true, undefined, { adopt: true });
  return res(false, 'dirty');
}

function remove(proj, chk) {
  const wt = chk.path;
  let adopted;
  if (!chk.ok) return { path: wt, removed: false, reason: chk.reason };
  try {
    if (chk.adopt) {
      const a = lessons.adoptFrom(wt, proj.path);
      if (!a.ok) return { path: wt, removed: false, reason: 'adopt-failed', message: String(a.error || '').split(/\r?\n/)[0] };
      adopted = a.adopted;
      fs.unlinkSync(path.join(wt, '.crew', 'LESSONS.md'));
      try { fs.rmdirSync(path.join(wt, '.crew')); } catch { /* not empty: stays */ }
    }
    const r = spawnSync('git', ['worktree', 'remove', wt], { cwd: proj.path, encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (r.error || r.status !== 0) {
      const msg = String((r.error && r.error.message) || r.stderr || r.stdout || '').trim().split(/\r?\n/)[0];
      return { path: wt, removed: false, reason: 'git-failed', message: msg, ...(adopted !== undefined ? { adopted } : {}) };
    }
    return { path: wt, removed: true, ...(adopted !== undefined ? { adopted } : {}) };
  } catch (err) {
    return { path: wt, removed: false, reason: 'git-failed', message: String((err && err.message) || err).split(/\r?\n/)[0], ...(adopted !== undefined ? { adopted } : {}) };
  }
}

// Size of a folder: entries are read, symlinks and junctions are not followed. Stops at the limit.
// -> { bytes, partial }. opts: limitMs (default 2000), now (clock, for tests).
function dirSize(dir, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const end = now() + (o.limitMs === undefined ? 2000 : o.limitMs);
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    if (now() >= end) return { bytes, partial: true };
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (now() >= end) return { bytes, partial: true };
      const p = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { bytes += fs.lstatSync(p).size; } catch { /* gone meanwhile */ }
    }
  }
  return { bytes, partial: false };
}

module.exports = { check, remove, dirSize };
