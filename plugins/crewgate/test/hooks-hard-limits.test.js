'use strict';

// Hard limits: an over-limit dispatch is denied (counting workers that really run), and unbounded busy loops of a
// crew subagent are denied. Commands are only passed to the hook and to scan(); none is ever executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const H = require('./hooks-helpers');
const tasks = require('../lib/core/tasks');
const limits = require('../lib/hooks/agentlimits');
const { bashNoop } = require('../lib/hooks/prefilter');
const sess = require('../lib/hooks/session');
const config = require('../lib/core/config');

const pre = (f, p) => H.runHook('pre-tool-use', p, { cwd: f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const reason = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason) || '';
const cfg = (n, extra) => ({ config: { limits: { max_parallel_workers: n, ...extra } } });

// A dispatch record of a worker, as PreToolUse leaves it.
function record(f, task, extra) {
  sess.remember(f.pid, `tu-${task.id}`, { task: task.id, type: 'crew-worker', bg: true, worker: true, ts: Date.now(), agent: null, stopped: false, session: f.sid, ...extra });
}
function dispatched(f, title) {
  const t = H.newTask(f, title);
  tasks.transition(f.pid, t.id, 'dispatched');
  return t;
}

test('config: parallel_enforce defaults to block and is documented in both languages', () => {
  assert.equal(config.DEFAULTS.limits.parallel_enforce, 'block');
  const e = config.SCHEMA.find((x) => x.path === 'limits.parallel_enforce');
  assert.ok(e && e.description.en && e.description['zh-TW']);
  assert.deepEqual(e.enum, ['block', 'warn']);
});

test('dispatch over max_parallel_workers is denied, names the running tasks, and records nothing', () => {
  const f = H.fixture(cfg(2));
  H.start(f);
  const a = H.newTask(f, 'A');
  const b = H.newTask(f, 'B');
  const c = H.newTask(f, 'C');
  assert.equal(pre(f, H.agentPayload(f, a)).out, '{}');
  assert.equal(pre(f, H.agentPayload(f, b)).out, '{}');
  const r = pre(f, H.agentPayload(f, c));
  assert.equal(decision(r), 'deny');
  assert.ok(reason(r).includes(a.id) && reason(r).includes(b.id), reason(r));
  assert.equal(tasks.load(f.pid, c.id).state, 'created');
  assert.equal(sess.byToolUse(f.pid, `tu-${c.id}`), null);
});

test('re-dispatching a task that is already counted does not count it twice', () => {
  const f = H.fixture(cfg(2));
  H.start(f);
  const a = H.newTask(f, 'A');
  const b = H.newTask(f, 'B');
  pre(f, H.agentPayload(f, a));
  pre(f, H.agentPayload(f, b));
  const again = H.agentPayload(f, b, { tool_use_id: 'tu-again' });
  assert.equal(pre(f, again).out, '{}');
});

test('a stopped worker no longer counts', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  const a = H.newTask(f, 'A');
  const b = H.newTask(f, 'B');
  pre(f, H.agentPayload(f, a));
  assert.equal(decision(pre(f, H.agentPayload(f, b))), 'deny');
  sess.markStopped(f.pid, `tu-${a.id}`);
  assert.equal(pre(f, H.agentPayload(f, b)).out, '{}');
});

test('parallel_enforce=warn lets the dispatch through with a reminder', () => {
  const f = H.fixture(cfg(1, { parallel_enforce: 'warn' }));
  H.start(f);
  const a = H.newTask(f, 'A');
  const b = H.newTask(f, 'B');
  pre(f, H.agentPayload(f, a));
  const r = pre(f, H.agentPayload(f, b));
  assert.equal(decision(r), undefined);
  assert.equal(tasks.load(f.pid, b.id).state, 'dispatched');
});

test('four stale dispatched tasks and a resumed session still allow a dispatch', () => {
  const f = H.fixture(cfg(3));
  H.start(f);
  const stale = ['1', '2', '3', '4'].map((n) => dispatched(f, `S${n}`));
  // Records of the old process: still open, as an app quit leaves them.
  stale.forEach((t) => record(f, t));
  assert.equal(sess.running(f.pid, null).length, 4);
  // The same session is resumed in a new process.
  H.runHook('session-start', H.base(f, { source: 'resume' }), { cwd: f.repo });
  assert.equal(sess.running(f.pid, null).length, 0);
  for (const t of stale) assert.equal(tasks.load(f.pid, t.id).state, 'dispatched');
  const fresh = H.newTask(f, 'Fresh');
  assert.equal(pre(f, H.agentPayload(f, fresh)).out, '{}');
  // A stale task can be dispatched again with no repair.
  assert.equal(pre(f, H.agentPayload(f, stale[0], { tool_use_id: 'tu-redo' })).out, '{}');
});

test('stale dispatched tasks with no record never count, and a compact keeps the live records', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  ['x', 'y', 'z'].forEach((n) => dispatched(f, n));
  const fresh = H.newTask(f, 'Fresh');
  assert.equal(pre(f, H.agentPayload(f, fresh)).out, '{}');
  H.runHook('session-start', H.base(f, { source: 'compact' }), { cwd: f.repo });
  assert.equal(sess.running(f.pid, null).length, 1);
  const next = H.newTask(f, 'Next');
  assert.equal(decision(pre(f, H.agentPayload(f, next))), 'deny');
});

test('records of an ended session do not count, nor do records older than six hours', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  const old = dispatched(f, 'old');
  const gone = dispatched(f, 'gone');
  record(f, old, { ts: Date.now() - 7 * 3600 * 1000 });
  record(f, gone, { session: 'ended-session' });
  assert.equal(sess.running(f.pid, null).length, 0);
});

test('SendMessage to a stopped worker counts like a dispatch; other messages pass', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  const a = dispatched(f, 'A');
  const b = dispatched(f, 'B');
  record(f, a, { agent: 'ag-a' });
  record(f, b, { agent: 'ag-b', stopped: true });
  const send = (to) => H.base(f, { tool_name: 'SendMessage', tool_use_id: 'tu-s', tool_input: { to, message: 'continue' } });
  assert.equal(decision(pre(f, send('ag-b'))), 'deny');
  assert.ok(reason(pre(f, send('ag-b'))).includes(a.id));
  assert.equal(pre(f, send('ag-a')).out, '{}'); // running already
  assert.equal(pre(f, send('someone-else')).out, '{}');
  assert.equal(pre(f, H.base(f, { tool_name: 'SendMessage', tool_input: {} })).out, '{}');
  sess.markStopped(f.pid, `tu-${a.id}`);
  assert.equal(pre(f, send('ag-b')).out, '{}');
  assert.equal(sess.byAgent(f.pid, 'ag-b').stopped, false); // it runs again now
});

test('a failing check lets the dispatch through', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  assert.equal(pre(f, H.base(f, { tool_name: 'SendMessage', tool_input: { to: 5 } })).out, '{}');
});

// ---------------------------------------------------------------- busy loops
const ROLES = ['crew-worker', 'crew-reviewer', 'crew-refuter'];

test('unbounded inline loops are denied for all three roles', () => {
  const bad = ['node -e "for(;;){}"', 'node -e "while(true){}"', 'node --eval "while(1){}"', 'python -c "while True: pass"', 'python3 -c "while 1: pass"',
    'powershell -Command "while($true){}"', 'pwsh -c "for(;;){}"', 'while ($true) {}', 'while true; do :; done', 'while :; do x; done',
    'if x; then while true; do y; done; fi', 'yes > /dev/null', 'yes >/dev/null &', 'yes > NUL', 'stress --cpu 4', 'stress-ng --cpu 0',
    'bash -c "node -e \\"for(;;){}\\""', 'cd x && node -e "while(true){}"', 'cmd /c node -e "for(;;){}"', 'timeout 5 python -c "while True: pass"',
    'timeout 5 powershell -Command "while($true){}"', 'timeout 5 bash -c "node -e \\"for(;;){}\\""', 'timeout 5 yes > /dev/null'];
  for (const type of ROLES) for (const c of bad) assert.ok(limits.scan(c, type), `${type}: ${c}`);
});

test('bounded or ordinary commands pass, a timeout covers a shell loop and node -e run directly', () => {
  const ok = ['timeout 5 node -e "for(;;){}"', 'timeout -s KILL 5 node -e "while(true){}"', 'timeout 60 bash -c "while true; do :; done"',
    'stress --cpu 2 --timeout 10', 'stress-ng -t 5 --cpu 2', 'yes | head -3', 'yes > out.txt', 'echo "while($true)"', 'node -e "console.log(1)"',
    'node --test', 'npm test', 'python x.py', 'python -c "print(1)"', 'for i in 1 2; do node a.js & done',
    'for i in $(seq 1 99); do echo $i; done', 'for i in $(seq 1 99); do node a.js; done', 'while read l; do echo $l; done < f'];
  for (const type of ROLES) for (const c of ok) assert.equal(limits.scan(c, type), null, `${type}: ${c}`);
});

test('more background copies than half the CPU cores is denied; a count it cannot read passes', () => {
  const half = Math.floor(os.cpus().length / 2);
  assert.ok(half >= 1);
  const loop = (n) => `for i in $(seq 1 ${n}); do node a.js & done`;
  assert.ok(limits.scan(loop(48), 'crew-worker'));
  assert.ok(limits.scan(`for i in {1..${half + 1}}; do sleep 5 & done`, 'crew-worker'));
  assert.ok(limits.scan(`bash -c "for i in $(seq ${half + 1}); do sleep 5 & done"`, 'crew-worker'));
  assert.equal(limits.scan(loop(half), 'crew-worker'), null);
  assert.equal(limits.scan('for i in $(seq 1 $N); do node a.js & done', 'crew-worker'), null);
  assert.equal(limits.scan('for f in *.js; do node $f & done', 'crew-worker'), null);
});

test('hook: a busy loop is denied with the reason, the event holds the first word only', () => {
  const f = H.fixture();
  H.start(f);
  const sub = (command, type, extra) => H.base(f, { tool_name: 'Bash', tool_use_id: 'tu-l', tool_input: { command }, agent_id: 'ag-1', agent_type: type, ...extra });
  const r = pre(f, sub('node -e "for(;;){} // secret-arg"', 'crew-worker'));
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /count and a time limit/);
  const ev = H.evs(f, 'agent.limit');
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0].data }, { agent_type: 'crew-worker', command: 'node', tool_use_id: 'tu-l' });
  assert.ok(!JSON.stringify(ev[0]).includes('secret-arg'));
  assert.equal(pre(f, sub('timeout 5 node -e "for(;;){}"', 'crew-worker')).out, '{}');
  // The main session and other subagents are not limited by the busy loop rule.
  assert.equal(pre(f, H.base(f, { tool_name: 'Bash', tool_input: { command: 'node -e "for(;;){}"' } })).out, '{}');
  assert.equal(pre(f, sub('node -e "for(;;){}"', 'general-purpose')).out, '{}');
});

test('prefilter: an ordinary command stays on the fast path; a subagent loop does not', () => {
  const b = (command, extra) => bashNoop({ tool_name: 'Bash', tool_input: { command }, ...extra });
  assert.equal(b('node -e "for(;;){}"'), true);
  assert.equal(b('ls -la', { agent_id: 'a' }), true);
  assert.equal(b('npm test', { agent_id: 'a' }), true);
  assert.equal(b('node -e "for(;;){}"', { agent_id: 'a' }), false);
  assert.equal(b('while true; do :; done', { agent_id: 'a' }), false);
  assert.equal(b('stress --cpu 2', { agent_id: 'a' }), false);
});

test('commands that only mention a loop are never denied', () => {
  const mention = ['grep -n "while ($true)" file', 'grep -n while ($true) file', 'git commit -m "while(true) fix"', 'rg "for(;;)"', 'rg for(;;) src',
    'echo while ($true)', 'echo "while true; do :; done"', 'Select-String -Pattern "while ($true)" f.ps1', 'git commit -m "node -e for(;;){}"',
    'grep "yes > /dev/null" f', 'echo yes > /dev/null', 'grep stress f', 'cat notes.txt | grep "while true"', 'git log --grep="for(;;)"',
    'rg "for i in $(seq 1 99); do node a.js & done"', 'echo "for i in $(seq 1 99); do x & done"', 'git commit -m "for i in {1..99}; do a & done"',
    'powershell -Command "Select-String -Pattern \'while ($true)\' f.ps1"', 'cmd /c grep "node -e for(;;){}" f', 'grep -n "python -c while True" f',
    'yes | installer > /dev/null', 'yes | head -3 > /dev/null', 'echo ok'];
  // (a reviewer's own git commit is denied by the git rule, which is not what is tested here)
  for (const type of ROLES) for (const c of mention.filter((x) => type === 'crew-worker' || !x.startsWith('git commit'))) assert.equal(limits.scan(c, type), null, `${type}: ${c}`);
  // the real statements are still caught
  for (const c of ['while ($true) {}', 'while($true){ }', 'for (;;) { }', 'echo a; while ($true) {}', 'timeout 5 yes > /dev/null']) assert.ok(limits.scan(c, 'crew-worker'), c);
});

test('a worker woken by SendMessage counts whatever its task state, until it stops', () => {
  const f = H.fixture(cfg(1));
  H.start(f);
  const a = dispatched(f, 'A');
  const b = dispatched(f, 'B');
  tasks.recordReport(f.pid, b.id, { report: require('./helpers').GOOD_REPORT });
  assert.equal(tasks.load(f.pid, b.id).state, 'returned');
  record(f, b, { agent: 'ag-b', stopped: true });
  const send = H.base(f, { tool_name: 'SendMessage', tool_use_id: 'tu-s', tool_input: { to: 'ag-b' } });
  assert.equal(pre(f, send).out, '{}');
  assert.deepEqual(sess.running(f.pid, null), [b.id]); // returned, but woken: counted
  const c = H.newTask(f, 'C');
  assert.equal(decision(pre(f, H.agentPayload(f, c))), 'deny');
  sess.markStopped(f.pid, `tu-${b.id}`);
  assert.deepEqual(sess.running(f.pid, null), []);
  assert.equal(pre(f, H.agentPayload(f, c)).out, '{}');
  void a;
});
