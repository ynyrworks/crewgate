'use strict';

// Shared test helpers. Never touches the real ~/.crewgate: every test file calls setupHome().
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const created = [];
process.on('exit', () => {
  for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tmpDir(prefix = 'crew-test-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
}

// Points CREWGATE_HOME at a fresh temp dir (data root) and shortens the lock wait.
function setupHome() {
  const home = tmpDir('crew-home-');
  process.env.CREWGATE_HOME = home;
  process.env.CREWGATE_LOCK_WAIT_MS = '3000';
  // tests may run inside a Claude Code session: its id must not leak into CLI events written by the tests
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  // temp folders may sit inside a repository (e.g. a git-tracked home dir): stop git's upward search there
  process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());
  return home;
}

function hasGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

// `spawn` is injectable for the helper test. A process that could not be started at all (r.error set or r.status null) is
// started once more; git that ran and failed (non-zero) with a fatal:/error: line is never retried, and one that failed with
// no such line is run once more with GIT_TRACE on, with a note on stderr. A failure names the error code and message, the
// status and the signal next to stderr, so an empty stderr still explains itself.
function gitWith(spawn, cwd, ...args) {
  const full = ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args];
  let r = spawn('git', full, { cwd, encoding: 'utf8' });
  let tries = 1;
  if (r.error || r.status === null) { r = spawn('git', full, { cwd, encoding: 'utf8' }); tries = 2; }
  // git ran, failed, and said nothing that names an error (seen on Windows CI: status 1 with only a CRLF warning): run it once
  // more with tracing on (trace goes to stderr, stdout stays the caller's), and leave a line in the CI log either way.
  if (!r.error && typeof r.status === 'number' && r.status !== 0 && !/^\s*(fatal|error):/m.test(r.stderr || '')) {
    const first = r;
    const cmd = `git ${args.join(' ')}`;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    r = spawn('git', full, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TRACE: '1', GIT_TRACE_SETUP: '1' } });
    tries = 2;
    const second = r.error ? `error=${r.error.code || ''} ${r.error.message}`.trim() : `status=${r.status} signal=${r.signal}`;
    process.stderr.write(`[git-helper] silent failure of \`${cmd}\` in ${cwd}: first attempt status=${first.status} signal=${first.signal} stderr=${JSON.stringify(first.stderr)}; second attempt (traced) ${second}\n`);
    if (r.status !== 0) {
      const err2 = r.error ? `${r.error.code || ''} ${r.error.message}`.trim() : 'none';
      throw new Error(`${cmd} failed twice without a git error. first attempt: status=${first.status} signal=${first.signal} stderr=${first.stderr}`
        + ` | second attempt (error=${err2} status=${r.status} signal=${r.signal} tries=2) trace/stderr: ${r.stderr}`);
    }
  }
  if (r.status !== 0) {
    const err = r.error ? `${r.error.code || ''} ${r.error.message}`.trim() : 'none';
    throw new Error(`git ${args.join(' ')} failed (error=${err} status=${r.status} signal=${r.signal} tries=${tries}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function git(cwd, ...args) { return gitWith(spawnSync, cwd, ...args); }

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

// A finalized review round for a task, written the way `crew review finalize` writes it (N.raw.json as submitted, then the
// product's own saveFinalized: N.json plus the review.finalized event that says when). `findings` go in both files.
function finalizedRound(projectId, taskId, findings = [], round = 1) {
  const rv = require('../lib/features/review');
  const dir = require('../lib/core/paths').taskDir(projectId, taskId);
  fs.mkdirSync(rv.findingsDir(dir), { recursive: true });
  fs.writeFileSync(rv.roundFile(dir, round, 'raw.json'), JSON.stringify(findings));
  rv.saveFinalized(projectId, taskId, dir, round, findings);
}

const GOOD_BRIEF = [
  '# Goal', 'Add the thing.', '',
  '# Scope', 'Allowed: src/**. Forbidden: docs/**.', '',
  '# Must not regress', 'Existing tests keep passing.', '',
  '# Machine impact', 'Light: tests only.', '',
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

module.exports = { tmpDir, setupHome, hasGit, git, gitWith, makeRepo, crew, finalizedRound, BIN, GOOD_BRIEF, GOOD_REPORT };
