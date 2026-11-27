'use strict';

// Hook contract: stdout is one JSON object, exit 0, never throws; adversarial input; latency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, hasGit, git } = require('./helpers');
const H = require('./hooks-helpers');

const EVENTS = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'subagent-start',
  'subagent-stop', 'stop', 'pre-compact', 'session-end'];

test('empty stdin, malformed JSON and unknown events all give {} and exit 0', () => {
  H.fixture();
  const elsewhere = tmpDir('crew-else-');
  for (const ev of EVENTS) {
    for (const raw of ['', 'not json', '[1,2]']) {
      const r = H.runHook(ev, null, { raw, cwd: elsewhere });
      assert.equal(r.code, 0, `${ev} <- ${JSON.stringify(raw)}`);
      assert.equal(r.out, '{}', `${ev} <- ${JSON.stringify(raw)}`);
    }
  }
  assert.equal(H.runHook('no-such-event', {}, { cwd: elsewhere }).out, '{}');
  assert.equal(H.runHook('', {}, { cwd: elsewhere }).out, '{}');
});

test('CamelCase event names are accepted', () => {
  const f = H.fixture();
  const r = H.runHook('SessionStart', H.base(f, { source: 'startup' }), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes('demo'));
});

test('unregistered project: silent no-op, nothing is created', { skip: !hasGit() }, () => {
  const f = H.fixture();
  const other = tmpDir('crew-unreg-');
  git(other, 'init', '-q');
  for (const ev of EVENTS) {
    const r = H.runHook(ev, { session_id: 'u1', cwd: other, source: 'startup', tool_name: 'Edit', tool_input: { file_path: path.join(other, 'a.js') } }, { cwd: other });
    assert.equal(r.out, '{}', ev);
    assert.equal(r.code, 0);
  }
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'projects')).sort(), [f.pid]);
  assert.ok(!fs.existsSync(path.join(f.home, 'sessions')));
});

test('cwd that is not a git repository gives {}', () => {
  H.fixture();
  const dir = tmpDir('crew-nogit-');
  const r = H.runHook('session-start', { session_id: 'n1', cwd: dir, source: 'startup' }, { cwd: dir });
  assert.equal(r.out, '{}');
  assert.equal(r.code, 0);
});

test('git missing from PATH: unregistered gives {}, project with crew.json still works', () => {
  const f = H.fixture({ config: { language: 'en' } });
  const emptyBin = tmpDir('crew-nobin-');
  const env = { PATH: emptyBin, Path: emptyBin };
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo, env });
  assert.equal(r.code, 0);
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes('crewgate'));
  const g = H.fixture();
  fs.rmSync(path.join(g.repo, '.claude'), { recursive: true, force: true });
  const r2 = H.runHook('session-start', H.base(g, { source: 'startup' }), { cwd: g.repo, env });
  assert.equal(r2.code, 0);
  assert.equal(typeof r2.json, 'object');
});

test('a 5 MB prompt is handled and only a short redacted snippet is kept', () => {
  const f = H.fixture();
  H.start(f);
  const prompt = `${'x'.repeat(5 * 1024 * 1024)} password=hunter2hunter2`;
  const r = H.runHook('user-prompt-submit', H.base(f, { prompt }), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.equal(r.out, '{}');
  assert.ok(r.ms < 10000);
  const s = JSON.parse(fs.readFileSync(path.join(f.home, 'sessions', `${f.sid}.json`), 'utf8'));
  assert.equal(s.prompts, 1);
  assert.ok(s.last_prompt.length <= 200);
  assert.ok(!s.last_prompt.includes('hunter2'));
});

test('a 5 MB tool_response / tool_input is ignored cheaply', () => {
  const f = H.fixture();
  H.start(f);
  const big = 'y'.repeat(5 * 1024 * 1024);
  const r = H.runHook('post-tool-use', H.base(f, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' }, tool_response: { stdout: big } }), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.equal(r.out, '{}');
});

test('hard guard: a stuck handler is answered with {} in time', () => {
  const f = H.fixture();
  const t0 = Date.now();
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), {
    cwd: f.repo, env: { CREWGATE_HOOK_GUARD_MS: '400', CREWGATE_TEST: '1', CREWGATE_HOOK_TEST_SLEEP_MS: '5000' },
  });
  assert.equal(r.out, '{}');
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 3500);
});

test('events are single JSON objects on one line (stdout is exactly one object)', () => {
  const f = H.fixture();
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo });
  assert.equal(r.out.split('\n').length, 1);
  assert.equal(r.err, '');
});

test('latency: typical hook runs stay well under a loose CI bound', () => {
  const f = H.fixture();
  // The bound follows the machine: the median cost of starting a bare node, times LATENCY_FACTOR, with 1000 ms as the floor.
  // A hook that becomes several times slower than a bare node start still fails on any machine.
  const LATENCY_FACTOR = 20;
  const median = (fn, n = 3) => { const a = Array.from({ length: n }, fn).sort((x, y) => x - y); return a[a.length >> 1]; };
  const bareNode = () => { const t0 = process.hrtime.bigint(); require('child_process').spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const bare = median(bareNode, 5);
  const bound = Math.max(1000, bare * LATENCY_FACTOR);
  // A full test run keeps the machine busy: a measurement over the bound gets one more try before it counts.
  const med = (fn) => { const first = median(fn); return first < bound ? first : median(fn); };
  const start = med(() => H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo }).ms);
  const edit = med(() => H.runHook('pre-tool-use', H.base(f, { tool_name: 'Edit', tool_input: { file_path: path.join(f.repo, 'src', 'a.js') } }), { cwd: f.repo }).ms);
  const end = med(() => { H.start(f); return H.runHook('session-end', H.base(f, { reason: 'other' }), { cwd: f.repo }).ms; });
  console.log(`# median ms: session-start=${start.toFixed(0)} pre-tool-use(Edit)=${edit.toFixed(0)} session-end=${end.toFixed(0)} bare-node=${bare.toFixed(0)} bound=${bound.toFixed(0)} (${os.platform()})`);
  assert.ok(start < bound, `session-start ${start} (bound ${bound}, bare node ${bare})`);
  assert.ok(edit < bound, `edit ${edit} (bound ${bound}, bare node ${bare})`);
  assert.ok(end < bound, `session-end ${end} (bound ${bound}, bare node ${bare})`);
});

test('double-fired SessionStart is deduplicated', () => {
  const f = H.fixture();
  H.start(f);
  H.start(f);
  assert.equal(H.evs(f, 'session.start').length, 1);
});

test('hooks.json: exec-form commands for known events, valid matchers', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const names = Object.keys(cfg.hooks);
  for (const n of ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'SessionEnd']) assert.ok(names.includes(n), n);
  for (const groups of Object.values(cfg.hooks)) {
    for (const g of groups) {
      for (const hk of g.hooks) {
        assert.equal(hk.type, 'command');
        assert.equal(hk.command, 'node');
        assert.equal(hk.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/crew-hook.js');
        assert.ok(EVENTS.includes(hk.args[1]), hk.args[1]);
        assert.ok(hk.timeout > 0 && hk.timeout <= 10);
      }
    }
  }
  assert.ok(cfg.hooks.SessionEnd[0].hooks[0].timeout <= 2);
});

test('the stuck-handler test knob is ignored without CREWGATE_TEST=1', () => {
  const f = H.fixture();
  // The knob is 20 s and the limit 10 s: a hook that honours it takes 20 s or more, a slow machine would have to be 20 times
  // slower than usual (about 0.5 s) to reach the limit. The hook's own answer (not the guard's '{}') says the handler ran.
  const KNOB = 20000;
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), {
    cwd: f.repo, env: { CREWGATE_TEST: '', CREWGATE_HOOK_TEST_SLEEP_MS: String(KNOB) },
  });
  assert.equal(r.code, 0);
  assert.ok(r.ms < KNOB / 2, `the hook took ${r.ms.toFixed(0)} ms with a ${KNOB} ms knob: it slept (or the machine is 20x slower than usual)`);
  assert.notEqual(r.out, '{}');
});

test('session start writes a CLI path that stays the same across versions, and it runs', () => {
  const f = H.fixture();
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo });
  assert.equal(r.code, 0);
  const shim = path.join(f.home, 'bin', 'crew.js');
  const text = fs.readFileSync(shim, 'utf8');
  assert.match(text, /bin.+crew\.js/);
  const out = require('child_process').spawnSync(process.execPath, [shim, '--help'], { encoding: 'utf8', env: { ...process.env, CREWGATE_HOME: f.home } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /crew/);
  const before = fs.statSync(shim).mtimeMs;
  H.runHook('session-start', H.base(f, { source: 'resume' }), { cwd: f.repo });
  assert.equal(fs.statSync(shim).mtimeMs, before, 'not rewritten when nothing changed');
});
