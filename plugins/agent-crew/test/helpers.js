'use strict';

// Shared test helpers. Never touches the real ~/.agent-crew: every test file calls setupHome().
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const created = [];
process.on('exit', () => {
  for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tmpDir(prefix = 'crew-test-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
}

// Points AGENT_CREW_HOME at a fresh temp dir (data root) and shortens the lock wait.
function setupHome() {
  const home = tmpDir('crew-home-');
  process.env.AGENT_CREW_HOME = home;
  process.env.AGENT_CREW_LOCK_WAIT_MS = '3000';
  // temp folders may sit inside a repository (e.g. a git-tracked home dir): stop git's upward search there
  process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(os.tmpdir());
  return home;
}

function hasGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A repo with one commit; returns its (real) path.
function makeRepo() {
  const dir = tmpDir('crew-repo-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const BIN = path.join(__dirname, '..', 'bin', 'crew.js');

// Runs the CLI as a child process: { code, out, err }.
function crew(args, cwd, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const GOOD_BRIEF = [
  '# Goal', 'Add the thing.', '',
  '# Scope', 'Allowed: src/**. Forbidden: docs/**.', '',
  '# Must not regress', 'Existing tests keep passing.', '',
  '# Acceptance', 'npm test passes.', '',
  '# Context', 'See src/a.js:10-20.', '',
].join('\n');

const GOOD_REPORT = [
  '## Branch & commits', 'feat/x abc123', '',
  '## What changed and why', '- src/a.js: add thing', '',
  '## Tests run', 'npm test: 5 pass', '',
  '## Assumptions & unfinished', 'none', '',
  '## Needs real-environment check', 'no', '',
].join('\n');

module.exports = { tmpDir, setupHome, hasGit, git, makeRepo, crew, BIN, GOOD_BRIEF, GOOD_REPORT };
