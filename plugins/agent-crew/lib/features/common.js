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
  checkBranch, branchRange, slug, fence, cliCommand,
};
