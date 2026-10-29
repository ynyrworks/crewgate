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
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes('agent-crew'));
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
    cwd: f.repo, env: { AGENT_CREW_HOOK_GUARD_MS: '400', AGENT_CREW_HOOK_TEST_SLEEP_MS: '5000' },
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
  const med = (fn) => { const a = [0, 1, 2].map(fn).sort((x, y) => x - y); return a[1]; };
  const start = med(() => H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo }).ms);
  const edit = med(() => H.runHook('pre-tool-use', H.base(f, { tool_name: 'Edit', tool_input: { file_path: path.join(f.repo, 'src', 'a.js') } }), { cwd: f.repo }).ms);
  const end = med(() => { H.start(f); return H.runHook('session-end', H.base(f, { reason: 'other' }), { cwd: f.repo }).ms; });
  console.log(`# median ms: session-start=${start.toFixed(0)} pre-tool-use(Edit)=${edit.toFixed(0)} session-end=${end.toFixed(0)} (${os.platform()})`);
  assert.ok(start < 1000, `session-start ${start}`);
  assert.ok(edit < 1000, `edit ${edit}`);
  assert.ok(end < 1000, `session-end ${end}`);
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
