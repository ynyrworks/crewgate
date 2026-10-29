#!/usr/bin/env node
'use strict';

// Single hook entry point: node crew-hook.js <event>
// Contract: read all of stdin, never throw, print exactly one JSON object ({} when there is
// nothing to say), exit 0. The handler runs in a worker thread so that a hard timer in the
// main thread can answer `{}` even if the handler is stuck in synchronous work (git, locks).
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const EVENTS = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'subagent-start',
  'subagent-stop', 'stop', 'pre-compact', 'session-end'];
const MAX_STDIN = 64 * 1024 * 1024;
const { guardMs } = require('../lib/hooks/timeouts');

function normEvent(x) {
  const s = String(x || '').replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  return EVENTS.includes(s) ? s : null;
}

function main() {
  const event = normEvent(process.argv[2]);
  let done = false;
  let worker = null;
  const finish = (text) => {
    if (done) return;
    done = true;
    let out = '{}';
    try { if (typeof text === 'string' && JSON.parse(text) && typeof JSON.parse(text) === 'object') out = text; } catch { /* keep {} */ }
    process.stdout.on('error', () => process.exit(0));
    process.stdout.write(`${out}\n`, () => process.exit(0));
  };
  if (!event) return finish('{}');

  // Keep lock waits short: a hook must not hold up the session.
  if (!process.env.CREWGATE_LOCK_WAIT_MS) process.env.CREWGATE_LOCK_WAIT_MS = '500';
  const guard = Number(process.env.CREWGATE_HOOK_GUARD_MS) || guardMs(event);
  setTimeout(() => finish('{}'), guard).unref();

  const chunks = [];
  let size = 0;
  let over = false;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    if (over) return finish('{}');
    try {
      worker = new Worker(__filename, { workerData: { event, input: Buffer.concat(chunks).toString('utf8') } });
      worker.on('message', (m) => finish(m));
      worker.on('error', () => finish('{}'));
      worker.on('exit', () => finish('{}'));
    } catch { finish('{}'); }
  };
  if (process.stdin.isTTY) return start();
  process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN) chunks.push(c); else over = true; });
  process.stdin.on('end', start);
  process.stdin.on('error', start);
}

function work() {
  let out = '{}';
  try {
    const { event, input } = workerData;
    if (EVENTS.includes(event)) {
      if (process.env.CREWGATE_TEST === '1' && process.env.CREWGATE_HOOK_TEST_SLEEP_MS) { // test-only: simulates a stuck handler
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CREWGATE_HOOK_TEST_SLEEP_MS) || 0);
      }
      let payload = {};
      try {
        const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
        const parsed = text.trim() ? JSON.parse(text) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch { /* malformed JSON: treat as empty */ }
      const mod = require(path.join(__dirname, '..', 'lib', 'hooks', `${event}.js`));
      const r = mod.run(payload);
      if (r && typeof r === 'object') out = JSON.stringify(r);
    }
  } catch { /* any internal error: {} */ }
  parentPort.postMessage(out);
}

if (isMainThread) main(); else work();
