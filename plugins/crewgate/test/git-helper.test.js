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
