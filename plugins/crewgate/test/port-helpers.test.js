'use strict';
// withFreePort retries only on evidence that the port was taken, a bounded number of times, each on a new port.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withFreePort, takenIn, takenError, ATTEMPTS } = require('./port-helpers');

const counter = () => { let n = 1000; return async () => ++n; };

test('takenIn recognises the board message and EADDRINUSE for that port only', () => {
  assert.equal(takenIn('x\nError: Port 5000 is already in use.\n', 5000), true);
  assert.equal(takenIn('Error: listen EADDRINUSE: address already in use 127.0.0.1:5000', 5000), true);
  assert.equal(takenIn('Error: Port 5000 is already in use.', 5001), false);
  assert.equal(takenIn('Error: listen EADDRINUSE 127.0.0.1:50001', 5000), false);
  assert.equal(takenIn('something else failed', 5000), false);
});

test('a taken port is retried on a new port; the cleanup runs between attempts', async () => {
  const seen = []; const cleaned = [];
  const r = await withFreePort(async (port, attempt) => {
    seen.push(port);
    if (attempt < 3) throw takenError(port);
    return port;
  }, { pick: counter(), cleanup: (p) => cleaned.push(p) });
  assert.deepEqual(seen, [1001, 1002, 1003]);
  assert.deepEqual(cleaned, [1001, 1002]);
  assert.equal(r, 1003);
});

test('a failure with no taken-port evidence is thrown at once, without a retry', async () => {
  let calls = 0;
  await assert.rejects(withFreePort(async () => { calls++; throw new Error('the board came up on the wrong page'); }, { pick: counter() }), /wrong page/);
  assert.equal(calls, 1);
  // evidence about another port is not evidence for this one
  calls = 0;
  await assert.rejects(withFreePort(async () => { calls++; throw new Error('Port 7 is already in use'); }, { pick: counter() }), /Port 7/);
  assert.equal(calls, 1);
});

test('a port that stays taken gives up after a fixed number of attempts and throws the last failure', async () => {
  let calls = 0;
  await assert.rejects(withFreePort(async (port) => { calls++; throw takenError(port); }, { pick: counter() }), /already in use/);
  assert.equal(calls, ATTEMPTS);
});
