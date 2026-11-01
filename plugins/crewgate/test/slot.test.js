'use strict';

// crew slot run: a machine-wide slot for heavy commands. Only sleeping processes are used, never load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setupHome, makeRepo, crew, BIN } = require('./helpers');

const HOME = setupHome();
const SLOTS = path.join(HOME, 'slots');
const SLOT0 = path.join(SLOTS, 'slot-0.json');
const FAST = { CREWGATE_SLOT_POLL_MS: '50', CREWGATE_SLOT_NOTE_MS: '200', CREWGATE_HOME: HOME };

// the tests may run inside a slot themselves: the child must not inherit that
function env(extra = {}) {
  const e = { ...process.env, ...FAST, ...extra };
  delete e.CREWGATE_SLOT_HELD;
  return e;
}

function slot(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, 'slot', 'run', ...args], { encoding: 'utf8', env: env(opts.env), input: opts.input, timeout: 30000 });
}

function startSlot(args) {
  const c = spawn(process.execPath, [BIN, 'slot', 'run', ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = '';
  c.err = '';
  c.stdout.on('data', (d) => { c.out += d; });
  c.stderr.on('data', (d) => { c.err += d; });
  c.done = new Promise((r) => c.on('close', (code) => r(code)));
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(25); }
  return false;
}

function reset() { fs.rmSync(SLOTS, { recursive: true, force: true }); }

// a sleeping process that stands in for a live holder; stop it by its pid
function sleeper() {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return c;
}
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

const SLEEP_CMD = (ms, tag) => ['node', '-e', `console.log('${tag}-start ' + Date.now()); setTimeout(() => console.log('${tag}-end ' + Date.now()), ${ms})`];
const stamp = (out, key) => Number(new RegExp(`${key} (\\d+)`).exec(out)[1]);

test('two callers run one after the other, and the waiter says who holds the slot', async () => {
  reset();
  const a = startSlot(['--', ...SLEEP_CMD(1200, 'A')]);
  // the file exists a moment before its content is written, so wait until it parses
  let held;
  assert.ok(await until(() => { try { held = JSON.parse(fs.readFileSync(SLOT0, 'utf8')); return true; } catch { return false; } }), 'A took the slot');
  assert.deepEqual(Object.keys(held).sort(), ['pid', 'started']);   // no command line
  assert.equal(held.pid, a.pid);
  const b = startSlot(['--', ...SLEEP_CMD(100, 'B')]);
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  assert.ok(stamp(b.out, 'B-start') >= stamp(a.out, 'A-end'), 'B started after A ended');
  assert.match(b.err, new RegExp(`held by pid ${a.pid} for \\d+ s`));
  assert.ok(!fs.existsSync(SLOT0), 'the slot is freed');
});

test('a holder that died frees its slot', () => {
  reset();
  fs.mkdirSync(SLOTS, { recursive: true });
  fs.writeFileSync(SLOT0, JSON.stringify({ pid: deadPid(), started: new Date().toISOString() }));
  const t0 = Date.now();
  const r = slot(['--max-wait', '20', '--', ...SLEEP_CMD(10, 'D')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /D-end/);
  assert.ok(Date.now() - t0 < 15000, 'did not wait for the maximum');
  assert.doesNotMatch(r.stderr, /anyway/);
});

test('the maximum wait runs the command anyway, with a line and a slot.timeout event', () => {
  reset();
  const repo = makeRepo();
  assert.equal(crew(['project', 'add', repo], repo, { CREWGATE_HOME: HOME }).code, 0);
  const live = sleeper();
  try {
    fs.mkdirSync(SLOTS, { recursive: true });
    fs.writeFileSync(SLOT0, JSON.stringify({ pid: live.pid, started: new Date().toISOString() }));
    const r = spawnSync(process.execPath, [BIN, 'slot', 'run', '--max-wait', '1', '--', ...SLEEP_CMD(10, 'T')], { cwd: repo, encoding: 'utf8', env: env() });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T-end/);
    assert.match(r.stderr, /No slot became free in 1 s; running the command anyway/);
    assert.match(r.stderr, new RegExp(`held by pid ${live.pid}`));
    const ev = crew(['--json', 'project', 'list'], repo, { CREWGATE_HOME: HOME });
    const id = JSON.parse(ev.out)[0].id;
    const log = fs.readFileSync(path.join(HOME, 'projects', id, 'events.jsonl'), 'utf8');
    assert.match(log, /"type":"slot\.timeout"/);
    assert.equal(JSON.parse(fs.readFileSync(SLOT0, 'utf8')).pid, live.pid, 'the live holder keeps its slot');
  } finally { live.kill(); }
});

test('the exit code, stdout and stdin pass through', () => {
  reset();
  const r = slot(['--', 'node', '-e', "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { process.stdout.write('got:' + s); process.exit(7); })"], { input: 'hello' });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, 'got:hello');
  assert.ok(!fs.existsSync(SLOT0));
});

test('a nested call inside the holder does not wait on itself; children share the slot', () => {
  reset();
  const inner = [process.execPath, BIN, 'slot', 'run', '--max-wait', '3', '--', 'node', '-e', "console.log('inner ' + (process.env.CREWGATE_SLOT_HELD || ''))"];
  const t0 = Date.now();
  const r = slot(['--max-wait', '3', '--', ...inner]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^inner \d+:0/);
  assert.ok(Date.now() - t0 < 2900, 'the inner call did not wait for the maximum');
  assert.doesNotMatch(r.stderr, /Waiting|anyway/);
});

test('a CREWGATE_SLOT_HELD that no live holder backs does not count', () => {
  reset();
  fs.mkdirSync(SLOTS, { recursive: true });
  fs.writeFileSync(SLOT0, JSON.stringify({ pid: deadPid(), started: new Date().toISOString() }));
  const r = spawnSync(process.execPath, [BIN, 'slot', 'run', '--max-wait', '5', '--', 'node', '-e', "console.log(process.env.CREWGATE_SLOT_HELD)"], { encoding: 'utf8', env: { ...env(), CREWGATE_SLOT_HELD: `${deadPid()}:0` } });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), new RegExp('^\\d+:0$'));
  assert.notEqual(r.stdout.trim().split(':')[0], String(process.pid));
});

test('a failure in the slot code still runs the command', () => {
  const file = path.join(HOME, 'not-a-folder');
  fs.writeFileSync(file, 'x');
  const r = slot(['--', 'node', '-e', "console.log('ran'); process.exit(3)"], { env: { CREWGATE_HOME: file } });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /ran/);
  assert.match(r.stderr, /The slot code failed .*running the command anyway/);
});

test('--slots 2 lets two callers run together; a third waits', async () => {
  reset();
  const a = startSlot(['--slots', '2', '--', ...SLEEP_CMD(1000, 'A')]);
  assert.ok(await until(() => fs.existsSync(SLOT0)));
  const b = startSlot(['--slots', '2', '--', ...SLEEP_CMD(1000, 'B')]);
  assert.ok(await until(() => fs.existsSync(path.join(SLOTS, 'slot-1.json'))), 'B took the second slot at once');
  const c = startSlot(['--slots', '2', '--', ...SLEEP_CMD(10, 'C')]);
  await Promise.all([a.done, b.done, c.done]);
  assert.ok(stamp(c.out, 'C-start') >= Math.min(stamp(a.out, 'A-end'), stamp(b.out, 'B-end')));
});

test('no command, a bad number and an unknown action are usage errors', () => {
  assert.equal(slot([]).status, 2);
  assert.equal(slot(['--']).status, 2);
  assert.equal(slot(['--slots', '0', '--', 'node', '-v']).status, 2);
  const r = spawnSync(process.execPath, [BIN, 'slot', 'list'], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 2);
});

test('a command that does not exist reports it and exits 127', () => {
  reset();
  const r = slot(['--', 'crew-no-such-command-xyz']);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /Could not start crew-no-such-command-xyz/);
  assert.ok(!fs.existsSync(SLOT0));
});

test('after a timeout or a failure the command carries a marker, so a nested call does not wait again', () => {
  reset();
  const live = sleeper();
  try {
    fs.mkdirSync(SLOTS, { recursive: true });
    fs.writeFileSync(SLOT0, JSON.stringify({ pid: live.pid, started: new Date().toISOString() }));
    const inner = [process.execPath, BIN, 'slot', 'run', '--max-wait', '30', '--', 'node', '-e', "console.log('inner ok')"];
    const t0 = Date.now();
    const r = slot(['--max-wait', '1', '--', ...inner]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /inner ok/);
    assert.ok(Date.now() - t0 < 10000, 'the inner call did not wait again');
    assert.doesNotMatch(r.stderr.split('anyway')[1] || '', /Waiting/);
    // a failure in the slot code: same marker
    const file = path.join(HOME, 'not-a-folder2');
    fs.writeFileSync(file, 'x');
    const r2 = slot(['--', ...inner], { env: { CREWGATE_HOME: file } });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /inner ok/);
    // the marker is not set on a normal run with a free slot, and a dead wrapper's marker is ignored
    reset();
    const r3 = slot(['--', 'node', '-e', 'console.log(process.env.CREWGATE_SLOT_HELD)']);
    assert.match(r3.stdout.trim(), /^\d+:0$/);
    fs.mkdirSync(SLOTS, { recursive: true });
    fs.writeFileSync(SLOT0, JSON.stringify({ pid: live.pid, started: new Date().toISOString() }));
    const r4 = spawnSync(process.execPath, [BIN, 'slot', 'run', '--max-wait', '1', '--', 'node', '-e', 'console.log(1)'], { encoding: 'utf8', env: { ...env(), CREWGATE_SLOT_HELD: `free:${deadPid()}` } });
    assert.match(r4.stderr, /running the command anyway/);   // it waited, so the stale marker did not count
  } finally { live.kill(); }
});
