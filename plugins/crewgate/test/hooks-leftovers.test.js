'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const L = require('../lib/hooks/leftovers');
const H = require('./hooks-helpers');
const sess = require('../lib/hooks/session');
const tasks = require('../lib/core/tasks');

const CLAUDE = 100;
const row = (pid, ppid, name) => ({ pid, ppid, name });
const base = [row(100, 1, 'claude.exe'), row(200, 100, 'bash.exe'), row(300, 100, 'node.exe')];
const rec = (extra) => ({ id: 'tu-1', task: 't-1', worker: true, ts: 1000, snap: { pids: [100, 200, 300], ts: 1000 }, ...extra });
const chk = (rows, r, others, deps) => L.check('p', r, others || [], { list: () => rows, claudePid: CLAUDE, selfPid: 999, roots: [], ...deps });

test('nothing left: the same processes before and after', () => {
  const r = chk(base, rec());
  assert.deepStrictEqual([r.count, r.programs, r.shared], [0, {}, false]);
});

test('one left: a new child of Claude Code, only the program name is kept', () => {
  const r = chk([...base, row(400, 200, 'node.exe')], rec());
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.programs, { 'node.exe': 1 });
  assert.ok(!JSON.stringify(r).includes('argv'));
});

test('a new process with a dead parent counts; a new process in another tree does not', () => {
  const r = chk([...base, row(1, 0, 'init'), row(400, 5555, 'busy.exe'), row(401, 1, 'svc.exe'), row(402, 400, 'busy.exe')], rec());
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.programs, { 'busy.exe': 2 });
});

test('the board, the holder, this hook and Claude Code are excluded, with their children', () => {
  const rows = [...base, row(500, 100, 'node.exe'), row(501, 500, 'node.exe'), row(600, 100, 'powershell.exe'), row(700, 100, 'node.exe'), row(701, 700, 'ps'), row(800, 100, 'sleep.exe')];
  const r = chk(rows, rec(), [], { roots: [500, 600], selfPid: 700 });
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.programs, { 'sleep.exe': 1 });
});

test('a pid in another running worker\'s dispatch-time set is not this worker\'s, and the result is shared', () => {
  const other = { id: 'tu-2', task: 't-2', worker: true, stopped: false, ts: 1500, snap: { pids: [100, 200, 300, 450], ts: 1500 } };
  const r = chk([...base, row(450, 100, 'a.exe'), row(460, 100, 'b.exe')], rec(), [other]);
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.programs, { 'b.exe': 1 });
  assert.strictEqual(r.shared, true);
});

test('shared also when another worker started or stopped inside the window; not when it ended before', () => {
  const o = (x) => ({ id: 'tu-2', task: 't-2', worker: true, stopped: true, ts: 10, stopped_at: 500, snap: { pids: [], ts: 10 }, ...x });
  assert.strictEqual(chk(base, rec(), [o()]).shared, false);
  assert.strictEqual(chk(base, rec(), [o({ ts: 1200 })]).shared, true);
  assert.strictEqual(chk(base, rec(), [o({ stopped_at: 1200 })]).shared, true);
});

test('no snapshot or a failed listing gives null, never a count', () => {
  assert.strictEqual(chk(base, rec({ snap: undefined })), null);
  assert.strictEqual(L.check('p', rec(), [], { list: () => { throw new Error('x'); } }), null);
  assert.strictEqual(chk(null, rec()), null);
});

test('parsers read the Windows and ps lines and keep the base name only', () => {
  assert.deepStrictEqual(L.parseWin('4,0,System\r\n12,4,node.exe\r\nbad\r\n'), [row(4, 0, 'System'), row(12, 4, 'node.exe')]);
  assert.deepStrictEqual(L.parsePosix('  1     0 /sbin/init\n 22  1 my prog\n'), [row(1, 0, 'init'), row(22, 1, 'my prog')]);
});

test('real listing: a sleeping detached child is found and then stopped by its pid', () => {
  const before = L.snapshot();
  assert.ok(before && before.pids.length > 5, 'listing works');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  try {
    const r = L.check('p', { snap: before, ts: before.ts }, [], { claudePid: process.pid, selfPid: 1, roots: [], withPids: true });
    assert.ok(r, 'check ran');
    assert.ok(r.pids.includes(child.pid), `child ${child.pid} in ${JSON.stringify(r)}`);
    assert.ok(r.count >= 1 && Object.keys(r.programs).length >= 1);
  } finally {
    try { process.kill(child.pid); } catch { /* already gone */ }
  }
});

test('hook flow: dispatch records the snapshot, the stop records task.leftovers, task show warns', () => {
  const f = H.fixture();
  H.start(f);
  const t = H.newTask(f);
  H.runHook('pre-tool-use', H.agentPayload(f, t), { cwd: f.repo });
  const uses = sess.readUses(f.pid);
  const key = Object.keys(uses)[0];
  assert.ok(uses[key].snap && uses[key].snap.pids.length > 3, 'snapshot recorded at dispatch');
  H.runHook('subagent-start', H.base(f, { agent_id: 'a1', agent_type: 'crew-worker' }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'a1', agent_type: 'crew-worker', last_assistant_message: 'done' }), { cwd: f.repo });
  const ev = H.evs(f, 'task.leftovers');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].task, t.id);
  assert.strictEqual(typeof ev[0].data.count, 'number');
  assert.strictEqual(ev[0].data.shared, false);
  assert.strictEqual(tasks.load(f.pid, t.id).state, 'returned');
});

test('crew task show warns when the count is not 0, whatever the worker reported, and is quiet at 0', () => {
  const h = require('./helpers');
  const events = require('../lib/core/events');
  const f = H.fixture();
  const t = H.newTask(f);
  assert.ok(!h.crew(['task', 'show', t.id], f.repo).out.includes('left running'));
  events.append(f.pid, { type: 'task.leftovers', src: 'hook', task: t.id, data: { count: 0, programs: {}, shared: false }, key: 'a' });
  assert.ok(!h.crew(['task', 'show', t.id], f.repo).out.includes('left running'));
  events.append(f.pid, { type: 'task.leftovers', src: 'hook', task: t.id, data: { count: 2, programs: { 'node.exe': 2 }, shared: true }, key: 'b' });
  const out = h.crew(['task', 'show', t.id], f.repo).out;
  assert.ok(out.includes('WARNING: 2 process(es) left running') && out.includes('node.exe x2') && out.includes('Another worker'), out);
});
