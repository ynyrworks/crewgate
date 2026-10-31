'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const L = require('../lib/hooks/leftovers');
const H = require('./hooks-helpers');
const sess = require('../lib/hooks/session');
const tasks = require('../lib/core/tasks');

// Real listings must not depend on machine load: a long listing limit for every real call in this file (and the hooks it runs).
process.env.CREWGATE_LEFTOVERS_LIST_MS = '20000';

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
  const r = chk([...base, row(450, 9999, 'a.exe'), row(460, 9999, 'b.exe')], rec(), [other]);
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

test('real listing: a sleeping child started detached, whose parent is gone, is counted; then stopped by its pid', () => {
  const before = L.snapshot();
  assert.ok(before && before.pids.length > 5, 'listing works');
  // an intermediate process starts the sleeper detached, prints its pid and exits: the sleeper's parent is gone
  const mid = spawnSync(process.execPath, ['-e',
    "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log(c.pid)"],
  { encoding: 'utf8', windowsHide: true });
  const childPid = Number(mid.stdout.trim());
  assert.ok(childPid > 0, 'child started');
  try {
    // claudePid is a pid that is not in the sleeper's chain, so only the dead parent can make it count
    const r = L.check('p', { snap: before, ts: before.ts }, [], { claudePid: 1, selfPid: process.pid, roots: [], withPids: true });
    assert.ok(r, 'check ran');
    assert.ok(r.pids.includes(childPid), `child ${childPid} in ${JSON.stringify(r)}`);
    assert.ok(r.programs[Object.keys(r.programs).find((k) => /^node/i.test(k))] >= 1);
  } finally {
    try { process.kill(childPid); } catch { /* already gone */ }
  }
});

test('system helpers (conhost, WMI host, svchost, updaters, ps) are not counted, a node with a dead parent is', () => {
  const rows = [...base, row(1, 0, 'init'), row(400, 100, 'conhost.exe'), row(401, 9999, 'WmiPrvSE.exe'), row(402, 9999, 'svchost.exe'),
    row(403, 9999, 'MicrosoftEdgeUpdate.exe'), row(404, 100, 'ps'), row(405, 9999, 'node.exe')];
  const r = chk(rows, rec());
  assert.deepStrictEqual(r.programs, { 'node.exe': 1 });
});

test('shared (another subagent, a background run) counts only what clearly outlived its parent, not a live shell or child', () => {
  const rows = [...base, row(1, 0, 'init'), row(400, 100, 'bash.exe'), row(401, 100, 'node.exe'), row(402, 9999, 'node.exe')];
  const solo = chk(rows, rec());
  assert.deepStrictEqual([solo.count, solo.shared, solo.programs], [2, false, { 'node.exe': 2 }]);   // the shell is never counted
  const shared = chk(rows, rec(), [], { sharedHint: true });
  assert.deepStrictEqual([shared.count, shared.shared, shared.unclear], [1, true, 2]);
});

test('a list over the cap is skipped and recorded as skipped, never cut', () => {
  const big = Array.from({ length: 3001 }, (_, i) => row(1000 + i, 1, 'x'));
  const snap = L.snapshot({ list: () => big });
  assert.deepStrictEqual(Object.keys(snap).sort(), ['skipped', 'ts']);
  assert.deepStrictEqual(L.check('p', rec({ snap }), [], { list: () => base, claudePid: CLAUDE, roots: [] }).skipped, 'too-many-processes');
  const ok = L.snapshot({ list: () => base });
  assert.strictEqual(L.check('p', rec({ snap: ok }), [], { list: () => big, claudePid: CLAUDE, roots: [] }).skipped, 'too-many-processes');
});

test('the listing timeout follows the budget; a short budget lists nothing and gives no snapshot', () => {
  const keep = process.env.CREWGATE_LEFTOVERS_LIST_MS;
  delete process.env.CREWGATE_LEFTOVERS_LIST_MS;
  try { budgetCase(); } finally { process.env.CREWGATE_LEFTOVERS_LIST_MS = keep; }
});

function budgetCase() {
  const seen = [];
  const deps = { list: () => { seen.push(1); return base; } };
  assert.strictEqual(L.snapshot(deps, 2000), null);
  assert.strictEqual(seen.length, 0);
  assert.ok(L.snapshot(deps, 4000));
  assert.strictEqual(L.check('p', rec(), [], { list: () => { seen.push(2); return base; }, budgetMs: 1500, claudePid: CLAUDE, roots: [] }), null);
  assert.strictEqual(seen.length, 1);
}

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
