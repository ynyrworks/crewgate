'use strict';

// helpers.git(): one more start when git could not be started at all, never when git ran and failed; failures explain themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gitWith, git, tmpDir } = require('./helpers');

test('git(): a process that cannot be started is retried once, then the error names its cause', () => {
  let calls = 0;
  const spawn = () => { calls++; return { status: null, signal: null, stderr: '', error: Object.assign(new Error('spawnSync git EAGAIN'), { code: 'EAGAIN' }) }; };
  assert.throws(() => gitWith(spawn, '.', 'init', '-q'), (e) => /EAGAIN/.test(e.message) && /spawnSync git EAGAIN/.test(e.message)
    && /status=null/.test(e.message) && /signal=null/.test(e.message) && /tries=2/.test(e.message));
  assert.equal(calls, 2);
});

test('git(): a start failure that clears on the second try returns the output', () => {
  let calls = 0;
  const spawn = () => { calls++; return calls === 1 ? { status: null, stderr: '', error: new Error('x') } : { status: 0, stdout: 'ok\n', stderr: '' }; };
  assert.equal(gitWith(spawn, '.', 'status'), 'ok');
  assert.equal(calls, 2);
});

test('git(): git that ran and failed is not retried and its stderr is reported', () => {
  let calls = 0;
  const spawn = () => { calls++; return { status: 128, signal: null, stderr: 'fatal: not a repository', stdout: '' }; };
  assert.throws(() => gitWith(spawn, '.', 'log'), (e) => /fatal: not a repository/.test(e.message) && /status=128/.test(e.message) && /tries=1/.test(e.message));
  assert.equal(calls, 1);
});

test('git(): real git still works and fails with its stderr', () => {
  const dir = tmpDir('crew-gh-');
  assert.equal(git(dir, 'init', '-q'), '');
  assert.throws(() => git(dir, 'rev-parse', '--verify', 'nope'), /status=128/);
});

// Runs fn with process.stderr.write replaced; returns what was written.
function captureStderr(fn) {
  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return lines;
}

test('git(): a silent non-zero exit is traced and run once more; the second stdout is returned and a note is written', () => {
  const envs = [];
  const spawn = (cmd, a, o) => {
    envs.push(o.env);
    return envs.length === 1
      ? { status: 1, signal: null, stderr: "warning: in the working copy of 'a.txt', LF will be replaced by CRLF", stdout: '' }
      : { status: 0, signal: null, stderr: 'trace: x', stdout: 'second\n' };
  };
  let out;
  const lines = captureStderr(() => { out = gitWith(spawn, '.', 'add', '.'); });
  assert.equal(out, 'second');
  assert.equal(envs.length, 2);
  assert.equal(envs[0], undefined);
  assert.equal(envs[1].GIT_TRACE, '1');
  assert.equal(envs[1].GIT_TRACE_SETUP, '1');
  assert.equal(process.env.GIT_TRACE, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /git add \./);
  assert.match(lines[0], /status=1/);
  assert.match(lines[0], /LF will be replaced/);
  assert.match(lines[0], /second attempt \(traced\) status=0/);
});

test('git(): a silent non-zero exit twice throws once with both attempts and the trace', () => {
  let calls = 0;
  const spawn = () => { calls++; return calls === 1
    ? { status: 1, signal: null, stderr: 'warning: first-warning', stdout: '' }
    : { status: 1, signal: null, stderr: 'trace: second-trace', stdout: '' }; };
  let err;
  captureStderr(() => { try { gitWith(spawn, '.', 'add', '.'); } catch (e) { err = e; } });
  assert.equal(calls, 2);
  assert.ok(err);
  assert.match(err.message, /first-warning/);
  assert.match(err.message, /second-trace/);
  assert.match(err.message, /tries=2/);
});

test('git(): status 128 with a fatal line is thrown at once, not retried', () => {
  let calls = 0;
  const spawn = () => { calls++; return { status: 128, signal: null, stderr: 'fatal: not a git repository', stdout: '' }; };
  const lines = captureStderr(() => { assert.throws(() => gitWith(spawn, '.', 'status'), /fatal: not a git repository.*|tries=1/s); });
  assert.equal(calls, 1);
  assert.equal(lines.length, 0);
});

test('git(): a warning line followed by an error line is not retried', () => {
  let calls = 0;
  const spawn = () => { calls++; return { status: 1, signal: null, stderr: 'warning: LF will be replaced\n  error: pathspec x did not match', stdout: '' }; };
  captureStderr(() => { assert.throws(() => gitWith(spawn, '.', 'add', 'x'), /error: pathspec x/); });
  assert.equal(calls, 1);
});
