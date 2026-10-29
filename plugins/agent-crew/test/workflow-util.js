'use strict';

// Helpers for the workflow-* test files (not a test itself).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers');

// A fresh repo with `crew init` already run. -> repo path
function initRepo(extra = []) {
  const repo = h.makeRepo();
  const r = h.crew(['init', ...extra], repo);
  if (r.code !== 0) throw new Error(`init failed: ${r.err}`);
  return repo;
}

function readCfg(repo) { return JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'crew.json'), 'utf8')); }
function writeCfg(repo, cfg) { fs.writeFileSync(path.join(repo, '.claude', 'crew.json'), JSON.stringify(cfg, null, 2)); }
function patchCfg(repo, fn) { const c = readCfg(repo); fn(c); writeCfg(repo, c); }

// Runs the CLI with --json and parses stdout.
function crewJson(args, cwd) {
  const r = h.crew(['--json', ...args], cwd);
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* leave null */ }
  return { ...r, data };
}

// CLI call with stdin input (the shared helper has none).
function crewIn(args, cwd, input) {
  const r = spawnSync(process.execPath, [h.BIN, ...args], { cwd, encoding: 'utf8', input, env: process.env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// Async variant, so a test can run a local HTTP server in the same process.
function crewAsync(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [h.BIN, ...args], { cwd, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

function writeFile(dir, rel, text) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

// Creates a task through the CLI. -> task object
function createTask(repo, over = {}) {
  const brief = writeFile(h.tmpDir('crew-brief-'), 'brief.md', over.brief || h.GOOD_BRIEF);
  const args = ['task', 'create', '--title', over.title || 'Add thing', '--brief-file', brief];
  if (over.branch) args.push('--branch', over.branch);
  if (over.worktree) args.push('--worktree', over.worktree);
  for (const a of over.allow || []) args.push('--allow', a);
  const r = crewJson(args, repo);
  if (r.code !== 0) throw new Error(`task create failed: ${r.err}`);
  return r.data.task;
}

function reportFiles(report = h.GOOD_REPORT, packet = 'full packet detail UNIQUE-PACKET-TOKEN\n') {
  const dir = h.tmpDir('crew-report-');
  return { report: writeFile(dir, 'report.md', report), packet: writeFile(dir, 'packet.md', packet) };
}

// A valid finding with overrides.
function finding(id, over = {}) {
  return {
    id, category: 'correctness', severity: 'major', file: 'src/x.js', line: 3, symbol: 'compute',
    snippet: 'const total = compute(1);', claim: `claim ${id}`, evidence: ['src/x.js:3'],
    verified_by: 'code-trace', confidence: 0.9, ...over,
  };
}

module.exports = {
  initRepo, readCfg, writeCfg, patchCfg, crewJson, crewIn, crewAsync, writeFile, createTask, reportFiles, finding,
};
