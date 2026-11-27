'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { testFlags } = require('../scripts/run-tests');

test('concurrency is max(2, floor(cores / 4))', () => {
  assert.deepStrictEqual(testFlags(32, '24.9.0', {}), ['--test-concurrency=8']);
  assert.deepStrictEqual(testFlags(4, '22.1.0', {}), ['--test-concurrency=2']);
  assert.deepStrictEqual(testFlags(2, '22.1.0', {}), ['--test-concurrency=2']);
  assert.deepStrictEqual(testFlags(15, '22.1.0', {}), ['--test-concurrency=3']);
});

test('CREW_TEST_CONCURRENCY overrides it; a bad value is ignored', () => {
  assert.deepStrictEqual(testFlags(32, '24.9.0', { CREW_TEST_CONCURRENCY: '3' }), ['--test-concurrency=3']);
  assert.deepStrictEqual(testFlags(32, '24.9.0', { CREW_TEST_CONCURRENCY: '0' }), ['--test-concurrency=8']);
  assert.deepStrictEqual(testFlags(32, '24.9.0', { CREW_TEST_CONCURRENCY: 'x' }), ['--test-concurrency=8']);
});

test('no flag where Node does not know it (18, 20 before 20.10)', () => {
  assert.deepStrictEqual(testFlags(32, '18.20.4', {}), []);
  assert.deepStrictEqual(testFlags(32, '20.9.0', { CREW_TEST_CONCURRENCY: '3' }), []);
  assert.deepStrictEqual(testFlags(32, '20.10.0', {}), ['--test-concurrency=8']);
  assert.deepStrictEqual(testFlags(32, '21.0.0', {}), ['--test-concurrency=8']);
});

test('requiring the script does not start a test run', () => {
  assert.strictEqual(typeof testFlags, 'function');   // reaching this line means require returned without spawning or exiting
});

const { concurrencyFor, runnerMode, runPool } = require('../scripts/run-tests');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (n) => Array.from({ length: n }, (_, i) => `f${i}.test.js`);

test('runnerMode: flag on Node 20.10+, pool before, pool when forced', () => {
  assert.strictEqual(runnerMode('24.9.0', {}), 'flag');
  assert.strictEqual(runnerMode('20.10.0', {}), 'flag');
  assert.strictEqual(runnerMode('20.9.0', {}), 'pool');
  assert.strictEqual(runnerMode('18.20.4', {}), 'pool');
  assert.strictEqual(runnerMode('24.9.0', { CREW_TEST_RUNNER_MODE: 'pool' }), 'pool');
});

test('concurrencyFor honours CREW_TEST_CONCURRENCY, default max(2, floor(cores / 4))', () => {
  assert.strictEqual(concurrencyFor(32, {}), 8);
  assert.strictEqual(concurrencyFor(4, {}), 2);
  assert.strictEqual(concurrencyFor(32, { CREW_TEST_CONCURRENCY: '3' }), 3);
  assert.strictEqual(concurrencyFor(32, { CREW_TEST_CONCURRENCY: '0' }), 8);
});

test('pool: never more than N files running at once, and all of them run', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  const r = await runPool(names(12), 3, async (f) => {
    running++; peak = Math.max(peak, running); seen.push(f);
    await tick(15);
    running--;
    return { code: 0, output: '' };
  });
  assert.strictEqual(peak, 3);
  assert.strictEqual(seen.length, 12);
  assert.deepStrictEqual(r, { ran: 12, failed: [], code: 0 });
});

test('pool: a failing file does not stop the others and gives a non-zero result', async () => {
  const seen = [];
  const r = await runPool(names(5), 2, async (f) => { seen.push(f); return { code: f === 'f1.test.js' ? 1 : 0, output: '' }; });
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(r.ran, 5);
  assert.deepStrictEqual(r.failed, ['f1.test.js']);
  assert.strictEqual(r.code, 1);
});

test('pool: a file that cannot be started counts as failed; output of each file is reported', async () => {
  const done = [];
  const r = await runPool(names(3), 2, async (f) => { if (f === 'f2.test.js') throw new Error('spawn EACCES'); return { code: 0, output: `out ${f}` }; }, (f, res) => done.push([f, res.output]));
  assert.deepStrictEqual(r.failed, ['f2.test.js']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(done.length, 3);
  assert.ok(done.some(([f, o]) => f === 'f2.test.js' && /spawn EACCES/.test(o)));
});

test('pool: an empty list is a pass; a limit larger than the list is fine', async () => {
  assert.deepStrictEqual(await runPool([], 4, async () => ({ code: 0, output: '' })), { ran: 0, failed: [], code: 0 });
  assert.strictEqual((await runPool(names(2), 99, async () => ({ code: 0, output: '' }))).ran, 2);
});

const { selectFiles } = require('../scripts/run-tests');

test('selectFiles: arguments without --pool-worker are ignored, the default list is used', () => {
  const defaults = ['/d/a.test.js', '/d/b.test.js'];
  assert.deepStrictEqual(selectFiles(['x.test.js'], {}, 'flag', defaults), defaults);
  assert.deepStrictEqual(selectFiles(['--inspect', 'x.test.js'], {}, 'pool', defaults), defaults);
  assert.deepStrictEqual(selectFiles([], {}, 'flag', defaults), defaults);
  assert.deepStrictEqual(selectFiles(['--pool-worker'], {}, 'pool', defaults), defaults);
});

test('selectFiles: with --pool-worker the named files replace the list; the env list works only in pool mode', () => {
  const path = require('path');
  const defaults = ['/d/a.test.js'];
  assert.deepStrictEqual(selectFiles(['--pool-worker', 'x.test.js'], {}, 'pool', defaults), [path.resolve('x.test.js')]);
  assert.deepStrictEqual(selectFiles([], { CREW_TEST_POOL_FILES: 'p.test.js,q.test.js' }, 'pool', defaults), [path.resolve('p.test.js'), path.resolve('q.test.js')]);
  assert.deepStrictEqual(selectFiles([], { CREW_TEST_POOL_FILES: 'p.test.js' }, 'flag', defaults), defaults);
});
