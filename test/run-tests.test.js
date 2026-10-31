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
