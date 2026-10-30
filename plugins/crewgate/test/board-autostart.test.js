'use strict';
// Board recoverability: stop lines in board.log, stale state reporting, and the opt-in SessionStart autostart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./hooks-helpers');
const bh = require('./board-helpers');

const F = h.fixture();
const HOME = F.home;
const board = require('../lib/commands/board');
const crewEnv = { CREWGATE_HOME: HOME };
const crew = (args) => bh.crew(args, process.cwd(), crewEnv);
const state = path.join(HOME, 'board.json');
const lock = path.join(HOME, 'board.starting');
const log = path.join(HOME, 'board.log');
const writeGlobal = (o) => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1, ...o }));
const reset = () => { for (const f of [state, lock, log, path.join(HOME, 'config.json')]) fs.rmSync(f, { force: true }); };
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

test.after(() => { crew(['board', 'stop']); });

test('autostart is off by default and never spawns', () => {
  reset();
  let calls = 0;
  assert.equal(board.ensureStarted({ spawn: () => { calls++; } }), 'off');
  writeGlobal({ board: { autostart: false } });
  assert.equal(board.ensureStarted({ spawn: () => { calls++; } }), 'off');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(lock), false);
});

test('autostart: one spawn for two callers, a live state file wins, a stale lock is retaken, a failing spawn is an error', () => {
  reset();
  writeGlobal({ port: 45678, board: { autostart: true } });
  const ports = [];
  const spawn = (bin, port, o) => { ports.push([port, o.search]); };
  assert.equal(board.ensureStarted({ spawn }), 'started');
  assert.equal(board.ensureStarted({ spawn }), 'busy', 'a second session starting at once does not spawn again');
  assert.deepEqual(ports, [[45678, false]]);

  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.equal(board.ensureStarted({ spawn }), 'started', 'a lock from a board that never came up expires');

  fs.rmSync(lock, { force: true });
  fs.writeFileSync(state, JSON.stringify({ pid: process.pid, port: 45678, started: 'x' }));
  assert.equal(board.ensureStarted({ spawn }), 'running');
  assert.equal(ports.length, 2);

  fs.rmSync(state, { force: true });
  fs.rmSync(lock, { force: true });
  assert.equal(board.ensureStarted({ spawn: () => { throw new Error('boom'); } }), 'error');
  assert.equal(fs.existsSync(lock), false, 'the lock is released when the spawn fails');
  assert.match(fs.readFileSync(log, 'utf8'), /autostart could not spawn the board: boom/);
  reset();
});

test('SessionStart starts the board when board.autostart is on, without waiting for it, and a second start reuses it', async () => {
  reset();
  const port = await freePort();
  writeGlobal({ port, board: { autostart: true } });
  const r = h.start(F);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json && r.json.hookSpecificOutput, 'the brief is still returned');
  const st = await until(async () => {
    try {
      const x = JSON.parse(fs.readFileSync(state, 'utf8'));
      return (await bh.request(port, { path: '/api/health' })).status === 200 ? x : null;
    } catch { return null; }
  });
  assert.ok(st, 'the board came up on the configured port');
  assert.equal(st.port, port);
  assert.equal(fs.existsSync(lock), false, 'the serve process released the start lock');
  h.start(F);
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).pid, st.pid, 'no second board');
  assert.equal(crew(['board', 'stop']).code, 0);
});

test('SessionStart leaves the board alone by default', () => {
  reset();
  const r = h.start(F);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.existsSync(lock), false);
});

function child(script) {
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CREWGATE_HOME: HOME }, timeout: 20000 });
}
const loadBoard = `const b = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'commands', 'board.js'))});`;

test('the server logs why it stops: exit, uncaught exception, unhandled rejection', () => {
  reset();
  child(`${loadBoard} b.installStopLog();`);
  assert.match(fs.readFileSync(log, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z board \(pid \d+\) exit, code 0$/m);
  reset();
  const c = child(`${loadBoard} b.installStopLog(); setTimeout(() => { throw new Error('kaput'); }, 10);`);
  assert.equal(c.status, 1);
  const t = fs.readFileSync(log, 'utf8');
  assert.match(t, /uncaught exception: Error: kaput/);
  assert.match(t, /exit, code 1/);
  reset();
  child(`${loadBoard} b.installStopLog(); Promise.reject(new Error('nope')); setTimeout(() => {}, 1000);`);
  assert.match(fs.readFileSync(log, 'utf8'), /unhandled rejection: Error: nope/);
});

test('the server logs the signal that stops it', { skip: process.platform === 'win32' && 'Windows has no catchable SIGTERM' }, () => {
  reset();
  child(`${loadBoard} b.installStopLog(); process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20); setTimeout(() => {}, 5000);`);
  const t = fs.readFileSync(log, 'utf8');
  assert.match(t, /received SIGTERM/);
  assert.match(t, /exit, code 0/);
});

test('status and doctor report a board that vanished without a stop line', async () => {
  reset();
  const port = await freePort();
  writeGlobal({ port });
  fs.writeFileSync(state, JSON.stringify({ pid: 2147483000, port, started: '2026-10-30T01:02:03.000Z' }));
  const doc = crew(['doctor']);
  assert.match(doc.out, /stopped without logging a reason \(pid 2147483000, started 2026-10-30T01:02:03\.000Z\)/);
  assert.match(doc.out, /Board autostart: off/);
  assert.equal(fs.existsSync(state), true, 'doctor only reads');
  const js = crew(['board', 'status', '--json']);
  assert.equal(js.code, 1);
  assert.deepEqual(JSON.parse(js.out), { running: false, stale: true, pid: 2147483000, started: '2026-10-30T01:02:03.000Z' });
  assert.equal(fs.existsSync(state), false, 'status cleans the stale file');
  assert.match(fs.readFileSync(log, 'utf8'), /previous board \(pid 2147483000, started 2026-10-30T01:02:03\.000Z\) is gone and left no stop line/);
  const again = crew(['board', 'status']);
  assert.equal(again.code, 1);
  assert.match(again.out, /not running/i);
  reset();
});
