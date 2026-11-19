'use strict';

// Small helpers shared by the workflow command groups.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { CrewError, UsageError } = require('../core/errors');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'crew.js');

function readText(file, what) {
  try {
    const s = fs.readFileSync(path.resolve(file), 'utf8');
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch (e) {
    throw new CrewError('wf.fileUnreadable', { what, file, code: e.code || 'ERR' });
  }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseJsonText(text, what) {
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) {
    throw new CrewError('wf.badJson', { what, detail: e.message });
  }
}

// Local calendar date, YYYY-MM-DD.
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function checkDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new UsageError('wf.badDate', { value: s });
  return s;
}

// Repeatable and/or comma-separated option values -> flat list.
function splitList(v) {
  return [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
}

function git(args, cwd, timeout = 10000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
function checkBranch(b) {
  if (b && (!BRANCH_RE.test(b) || b.includes('..'))) throw new UsageError('wf.badBranch', { value: b });
  return b;
}

// -> { base, branch } for a task whose branch exists in the repository, else null.
function branchRange(root, branch) {
  if (!branch || !BRANCH_RE.test(branch)) return null;
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  if (!tip) return null;
  const tipSha = tip.trim();
  for (const cand of ['HEAD', 'main', 'master']) {
    if (cand === branch) continue;
    const mb = git(['merge-base', cand, branch], root);
    if (mb && mb.trim() && mb.trim() !== tipSha) return { base: mb.trim(), branch };
  }
  return null;
}

// The commit a task's scope is judged from, for `crew task accept`. -> { base, branch } or { failed: code }.
// Rule: the base is the closest of (a) the branch tips recorded when other tasks were accepted, if that tip is an ancestor of this
// branch tip, and (b) the merge-base with HEAD/main/master; for a branch already merged, the merge-base of the first parent of the
// merge commit that took it in. A branch with no commit beyond its base gives base = tip (nothing changed).
// Codes: 'no-branch' (not in this repository), 'no-base' (no common history with HEAD/main/master), 'no-commits' (nothing beyond
// the base, or fast-forwarded in with no recorded base: nothing to tell the task's own commits apart).
function scopeRange(root, branch, recordedTips = []) {
  if (!branch || !BRANCH_RE.test(branch)) return { failed: 'no-branch' };
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  if (!tip) return { failed: 'no-branch' };
  const tipSha = tip.trim();
  const cands = [];
  for (const t of recordedTips) {
    if (/^[0-9a-f]{7,64}$/.test(t || '') && git(['merge-base', '--is-ancestor', t, tipSha], root) !== null) cands.push(t);
  }
  const refs = ['HEAD', 'main', 'master'].filter((c) => c !== branch);
  // A merge-base equal to the tip (the branch is checked out as HEAD, or is merged into that ref) says nothing about where the task
  // started; keep it only when every ref gives the tip.
  let sawTip = false;
  let nonTip = 0;
  for (const c of refs) {
    const mb = git(['merge-base', c, branch], root);
    if (!mb || !mb.trim()) continue;
    if (mb.trim() === tipSha) sawTip = true;
    else { cands.push(mb.trim()); nonTip++; }
  }
  if (sawTip && !nonTip) cands.push(tipSha);
  if (!cands.length) return { failed: 'no-base' };
  let best = null;
  let bestN = -1;
  for (const c of cands) {
    const n = Number((git(['rev-list', '--count', c], root) || '').trim());
    if (Number.isFinite(n) && n > bestN) { best = c; bestN = n; }
  }
  // Merged into a ref: the merge-base is then the tip itself; look at the side the branch was merged into.
  // The merge-derived base joins the recorded ancestor tips (the tip itself removed); the closest wins, so a recorded tip still
  // beats it when the task started from that tip.
  if (best === tipSha && !recordedTips.includes(tipSha)) {
    const rest = cands.filter((c) => c !== tipSha);
    for (const c of refs) {
      const m = git(['rev-list', '--merges', '--ancestry-path', '--reverse', `${tipSha}..${c}`], root);
      const first = m && m.split(/\r?\n/).filter(Boolean)[0];
      if (!first) continue;
      const mb = git(['merge-base', `${first}^1`, tipSha], root);
      if (mb && mb.trim() && mb.trim() !== tipSha) { rest.push(mb.trim()); break; }
    }
    best = null;
    bestN = -1;
    for (const c of rest) {
      const n = Number((git(['rev-list', '--count', c], root) || '').trim());
      if (Number.isFinite(n) && n > bestN) { best = c; bestN = n; }
    }
    return best ? { base: best, branch } : { failed: 'no-commits' };
  }
  return { base: best, branch };
}

function branchTip(root, branch) {
  if (!branch || !BRANCH_RE.test(branch)) return null;
  const t = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  return t ? t.trim() : null;
}

// Lines changed between two commits, added plus removed as `git diff --numstat` counts them (a binary file counts as 1), and
// the files touched (both paths of a rename). -> { lines, files } or null when git cannot say.
function changedLines(root, from, to) {
  const out = git(['diff', '--numstat', '--no-renames', '-z', from, to], root);
  if (out === null) return null;
  let lines = 0;
  const files = [];
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    lines += m[1] === '-' ? 1 : Number(m[1]) + Number(m[2]);
    files.push(m[3]);
  }
  return { lines, files };
}

function slug(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

// A fence longer than any backtick run in the text, so the text cannot close it early.
function fence(text) {
  let n = 3;
  for (const m of String(text).matchAll(/`+/g)) n = Math.max(n, m[0].length + 1);
  return '`'.repeat(n);
}

function cliCommand() { return `node "${CLI_PATH}"`; }

module.exports = {
  PLUGIN_ROOT, CLI_PATH, readText, readStdin, parseJsonText, today, checkDate, splitList, git,
  checkBranch, branchRange, scopeRange, branchTip, changedLines, slug, fence, cliCommand,
};
