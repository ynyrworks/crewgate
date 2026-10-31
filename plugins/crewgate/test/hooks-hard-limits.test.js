'use strict';

// Hard limits: an over-limit dispatch is denied (counting workers that really run), and unbounded busy loops of a
// crew subagent are denied. Commands are only passed to the hook and to scan(); none is ever executed.
const test = require('node:test');
const assert = require('node:assert/strict');
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

test('more background copies than max(2, half the CPU cores) is denied; a count it cannot read passes', () => {
  const loop = (n) => `for i in $(seq 1 ${n}); do node a.js & done`;
  // The core count is injected, so the test does not depend on the runner.
  for (const [cores, half] of [[1, 2], [2, 2], [3, 2], [4, 2], [32, 16]]) {
    assert.ok(limits.scan(loop(48), 'crew-worker', 0, false, cores), `${cores} cores: 48 copies`);
    assert.ok(limits.scan(`for i in {1..${half + 1}}; do sleep 5 & done`, 'crew-worker', 0, false, cores), `${cores} cores: ${half + 1}`);
    assert.ok(limits.scan(`bash -c "for i in $(seq ${half + 1}); do sleep 5 & done"`, 'crew-worker', 0, false, cores), `${cores} cores: bash -c`);
    assert.equal(limits.scan(loop(half), 'crew-worker', 0, false, cores), null, `${cores} cores: ${half}`);
    assert.equal(limits.scan('for i in 1 2; do node a.js & done', 'crew-worker', 0, false, cores), null, `${cores} cores: two copies`);
  }
  assert.ok(limits.scan(loop(48), 'crew-worker'));
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

// ---------------------------------------------------------------- dispatch_max_cpu (sampler stubbed: no real load)
const load = require('../lib/hooks/machineload');
const preTool = require('../lib/hooks/pre-tool-use');

// Runs the hook in this process with the sampler returning `values` in turn (a function is called as is).
function withSampler(values, fn) {
  const calls = [];
  const seq = Array.isArray(values) ? values.slice() : null;
  load.setSampler(() => {
    calls.push(1);
    if (!seq) return values();
    return seq.length > 1 ? seq.shift() : seq[0];
  });
  try { return fn(calls); } finally { load.setSampler(null); }
}
const cpuCfg = (max) => ({ config: { limits: { dispatch_max_cpu: max } } });
const inproc = (p) => { const r = preTool.run(p); return r ? r.hookSpecificOutput : undefined; };

test('config: dispatch_max_cpu defaults to 85 and is documented in both languages', () => {
  assert.equal(config.DEFAULTS.limits.dispatch_max_cpu, 85);
  const e = config.SCHEMA.find((x) => x.path === 'limits.dispatch_max_cpu');
  assert.ok(e && e.description.en && e.description['zh-TW']);
  assert.equal(e.max, 100);
});

test('dispatch above dispatch_max_cpu is denied with the percent, the limit and what to do; nothing is recorded but dispatch.load', () => {
  const f = H.fixture(cpuCfg(85));
  H.start(f);
  const a = H.newTask(f, 'A');
  const out = withSampler([97], () => inproc(H.agentPayload(f, a)));
  assert.equal(out.permissionDecision, 'deny');
  const why = out.permissionDecisionReason;
  assert.ok(why.includes('97%') && why.includes('85%') && why.includes('dispatch_max_cpu') && /wait/i.test(why) && why.includes('=100'), why);
  assert.equal(tasks.load(f.pid, a.id).state, 'created');
  const ev = H.evs(f, ['dispatch.load']);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.percent, 97);
  assert.equal(ev[0].data.limit, 85);
  assert.equal(ev[0].task, a.id);
  assert.ok(!JSON.stringify(ev[0]).includes('do it'), 'no prompt text');
});

test('at the limit and under it the dispatch goes on, with one sample only', () => {
  for (const pct of [85, 20]) {
    const f = H.fixture(cpuCfg(85));
    H.start(f);
    const a = H.newTask(f, 'A');
    const out = withSampler([pct], (calls) => { const o = inproc(H.agentPayload(f, a)); assert.equal(calls.length, 1); return o; });
    assert.equal(out, undefined);
    assert.equal(tasks.load(f.pid, a.id).state, 'dispatched');
  }
});

test('a short spike is not enough: the second sample decides', () => {
  const f = H.fixture(cpuCfg(85));
  H.start(f);
  const a = H.newTask(f, 'A');
  const out = withSampler([99, 30], (calls) => { const o = inproc(H.agentPayload(f, a)); assert.equal(calls.length, 2); return o; });
  assert.equal(out, undefined);
  assert.equal(H.evs(f, ['dispatch.load']).length, 0);
});

test('dispatch_max_cpu 100 turns the check off and never samples', () => {
  const f = H.fixture(cpuCfg(100));
  H.start(f);
  const a = H.newTask(f, 'A');
  const out = withSampler(() => { throw new Error('must not sample'); }, (calls) => { const o = inproc(H.agentPayload(f, a)); assert.equal(calls.length, 0); return o; });
  assert.equal(out, undefined);
});

test('a sampler that throws lets the dispatch through', () => {
  const f = H.fixture(cpuCfg(85));
  H.start(f);
  const a = H.newTask(f, 'A');
  const out = withSampler(() => { throw new Error('boom'); }, () => inproc(H.agentPayload(f, a)));
  assert.equal(out, undefined);
  assert.equal(tasks.load(f.pid, a.id).state, 'dispatched');
});

test('a reviewer dispatch (task in review) and a subagent call are not sampled', () => {
  const f = H.fixture(cpuCfg(85));
  H.start(f);
  const a = dispatched(f, 'A');
  tasks.transition(f.pid, a.id, 'returned');
  tasks.transition(f.pid, a.id, 'reviewing');
  withSampler(() => { throw new Error('must not sample'); }, (calls) => {
    const o = inproc(H.agentPayload(f, a, { tool_input: { prompt: `crew-task: ${a.id}\n`, subagent_type: 'crew-reviewer' } }));
    assert.equal(o, undefined);
    assert.equal(preTool.run(H.agentPayload(f, a, { agent_id: 'ag-x' })), null);
    assert.equal(calls.length, 0);
  });
});

test('SendMessage that wakes a stopped worker is checked; another message is not', () => {
  const f = H.fixture(cpuCfg(85));
  H.start(f);
  const b = dispatched(f, 'B');
  record(f, b, { agent: 'ag-b', stopped: true });
  const send = (to) => H.base(f, { tool_name: 'SendMessage', tool_use_id: 'tu-s', tool_input: { to, message: 'go' } });
  const out = withSampler([95], (calls) => {
    assert.equal(inproc(send('someone-else')), undefined);
    assert.equal(calls.length, 0);
    return inproc(send('ag-b'));
  });
  assert.equal(out.permissionDecision, 'deny');
  assert.ok(out.permissionDecisionReason.includes('95%'));
  assert.equal(withSampler([10], () => inproc(send('ag-b'))), undefined);
});

test('sample(): whole-machine percent from two readings, in 0-100', () => {
  const p = load.sample(20);
  assert.ok(Number.isInteger(p) && p >= 0 && p <= 100, String(p));
});
