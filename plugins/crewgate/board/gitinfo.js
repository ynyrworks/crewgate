'use strict';

// Branch and worktree of a working directory, read straight from the .git files (no git process).
// The location of HEAD is cached per directory; the parsed value is cached by HEAD's mtime.
const fs = require('fs');
const path = require('path');

const FIND_TTL = 30 * 1000;
const MAX_UP = 25;

function readSmall(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// -> { head, worktree } or null. `.git` is a directory (normal repo) or a "gitdir: <path>" file
// (linked worktree or submodule).
function locate(cwd) {
  let dir = path.resolve(cwd);
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }   // a folder that is gone has no branch to read
  for (let i = 0; i < MAX_UP; i++) {
    const g = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* none here */ }
    if (st && st.isDirectory()) return { head: path.join(g, 'HEAD'), worktree: null };
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(g) || '');
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const linked = path.basename(path.dirname(gitdir)) === 'worktrees';
      return { head: path.join(gitdir, 'HEAD'), worktree: linked ? path.basename(gitdir) : null };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function parseHead(text) {
  const t = String(text || '').trim();
  const ref = /^ref:\s*(\S+)/.exec(t);
  if (ref) return { branch: ref[1].replace(/^refs\/heads\//, '').replace(/^refs\//, ''), detached: false };
  if (/^[0-9a-f]{40,64}$/i.test(t)) return { branch: t.slice(0, 7), detached: true };
  return null;
}

function createGitInfo() {
  const found = new Map();   // cwd -> { at, loc }
  const parsed = new Map();  // head file -> { mtimeMs, size, val }

  // gitInfo(cwd, now) -> { branch, detached, worktree } or null
  function get(cwd, now = Date.now()) {
    if (!cwd || typeof cwd !== 'string') return null;
    let f = found.get(cwd);
    if (!f || now - f.at > FIND_TTL || now < f.at) {
      f = { at: now, loc: locate(cwd) };
      found.set(cwd, f);
      if (found.size > 2000) found.delete(found.keys().next().value);
    }
    if (!f.loc) return null;
    let st;
    try { st = fs.statSync(f.loc.head); } catch { found.delete(cwd); return null; }
    let p = parsed.get(f.loc.head);
    if (!p || p.mtimeMs !== st.mtimeMs || p.size !== st.size) {
      const v = parseHead(readSmall(f.loc.head));
      p = { mtimeMs: st.mtimeMs, size: st.size, val: v };
      parsed.set(f.loc.head, p);
    }
    return p.val ? { ...p.val, worktree: f.loc.worktree } : null;
  }

  return { get };
}

module.exports = { createGitInfo, parseHead, locate };
