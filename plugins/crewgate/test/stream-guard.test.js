'use strict';

// The handler crew.js installs on stdout and stderr: a gone reader never throws, any other error does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const h = require('./helpers');
const guard = require('../lib/core/stream-guard');

const err = (code) => Object.assign(new Error(code), { code });

test('every "reader is gone" code is ignored, in any order, ERR_STREAM_DESTROYED first included', () => {
  for (const order of [
    ['EPIPE'], ['EPROTOTYPE'], ['ECONNRESET'], ['ERR_STREAM_DESTROYED'],
    ['ERR_STREAM_DESTROYED', 'EPIPE'], ['EPROTOTYPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'EPIPE'],
  ]) {
    for (const c of order) assert.doesNotThrow(() => guard.handleStreamError(err(c)), c);
  }
});

test('an error that is not about a closed reader still throws, also after a closed one', () => {
  guard.handleStreamError(err('EPIPE'));
  for (const e of [err('EIO'), err('ENOSPC'), new Error('plain'), err(undefined)]) {
    assert.throws(() => guard.handleStreamError(e), (x) => x === e);
  }
});

test('install puts the same handler on every stream it is given', () => {
  const a = new EventEmitter();
  const b = new EventEmitter();
  guard.install([a, b]);
  for (const s of [a, b]) {
    assert.doesNotThrow(() => s.emit('error', err('EPROTOTYPE')));
    assert.throws(() => s.emit('error', err('EIO')), /EIO/);
  }
});

test('crew.js installs this module on stdout and stderr and nothing else', () => {
  const src = fs.readFileSync(h.BIN, 'utf8');
  assert.match(src, /require\('\.\.\/lib\/core\/stream-guard'\)\.install\(\[process\.stdout, process\.stderr\]\)/);
  assert.doesNotMatch(src, /\.on\('error'/);
});

test('the evidence file is written only with CREWGATE_TEST=1', () => {
  const file = `${h.tmpDir()}/e.log`;
  const saved = { t: process.env.CREWGATE_TEST, l: process.env.CREWGATE_STREAM_ERROR_LOG };
  try {
    process.env.CREWGATE_STREAM_ERROR_LOG = file;
    delete process.env.CREWGATE_TEST;
    guard.handleStreamError(err('EPIPE'));
    assert.equal(fs.existsSync(file), false);
    process.env.CREWGATE_TEST = '1';
    guard.handleStreamError(err('EPROTOTYPE'));
    assert.throws(() => guard.handleStreamError(err('EIO')));
    assert.equal(fs.readFileSync(file, 'utf8'), 'EPROTOTYPE\nEIO\n');
  } finally {
    for (const [k, v] of [['CREWGATE_TEST', saved.t], ['CREWGATE_STREAM_ERROR_LOG', saved.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
