'use strict';

// Hooks fed with Codex-shaped payloads (tool collaborationspawn_agent, SubagentStart "default",
// SessionEnd reason "other") and the Codex hook file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./hooks-helpers');
const tasks = require('../lib/core/tasks');

const spawnPayload = (f, task, extra) => H.base(f, {
  hook_event_name: 'PreToolUse', model: 'gpt-x', permission_mode: 'default', turn_id: 'turn-1',
  tool_name: 'collaborationspawn_agent', tool_use_id: `tu-${task.id}`,
  tool_input: { task_name: 'crew-worker', message: `crew-task: ${task.id}\n\ndo it` }, ...extra,
});

test('codex spawn with a marker dispatches the task and is recorded as engine codex', () => {
  const f = H.fixture();
  const t = H.newTask(f);
  H.start(f);
  const r = H.runHook('pre-tool-use', spawnPayload(f, t), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.equal(tasks.load(f.pid, t.id).state, 'dispatched');
  const ev = H.evs(f, 'task.dispatched');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.agent_type, 'crew-worker');
  assert.equal(ev[0].data.engine, 'codex');
  assert.equal(ev[0].data.background, true);
});

test('codex SubagentStart "default" binds to the codex dispatch; PostToolUse of the spawn does not return the task', () => {
  const f = H.fixture();
  const t = H.newTask(f);
  H.start(f);
  H.runHook('pre-tool-use', spawnPayload(f, t), { cwd: f.repo });
  const post = H.runHook('post-tool-use', spawnPayload(f, t, { hook_event_name: 'PostToolUse', tool_response: { agent_id: 'ag-9' } }), { cwd: f.repo });
  assert.equal(post.code, 0);
  assert.equal(tasks.load(f.pid, t.id).state, 'dispatched', 'a spawn returns at once: not a finished worker');
  H.runHook('subagent-start', H.base(f, { hook_event_name: 'SubagentStart', agent_id: 'ag-9', agent_type: 'default' }), { cwd: f.repo });
  const s = H.evs(f, 'subagent.start');
  assert.equal(s.length, 1);
  assert.equal(s[0].task, t.id);
  assert.equal(s[0].data.linked, true);
});

test('codex SessionEnd with reason "other" writes the digest and the in-flight need', () => {
  const f = H.fixture();
  const t = H.newTask(f);
  H.start(f);
  H.runHook('pre-tool-use', spawnPayload(f, t), { cwd: f.repo });
  H.runHook('session-end', H.base(f, { hook_event_name: 'SessionEnd', reason: 'other' }), { cwd: f.repo });
  const e = H.evs(f, 'session.end');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.reason, 'other');
  assert.ok(e[0].data.flags.includes('tasks_in_flight'));
});

test('a codex spawn without a marker changes nothing', () => {
  const f = H.fixture();
  H.start(f);
  const r = H.runHook('pre-tool-use', H.base(f, { tool_name: 'collaborationspawn_agent', tool_use_id: 'x', tool_input: { task_name: 'x', message: 'hello' } }), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.equal(H.evs(f, 'task.dispatched').length, 0);
});

test('codex-hooks.json mirrors hooks.json: same events, timeouts and matchers, single-string commands', () => {
  const dir = path.join(__dirname, '..', 'hooks');
  const claude = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')).hooks;
  const codex = JSON.parse(fs.readFileSync(path.join(dir, 'codex-hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(codex), Object.keys(claude));
  for (const ev of Object.keys(claude)) {
    assert.equal(codex[ev].length, claude[ev].length, ev);
    claude[ev].forEach((g, i) => {
      assert.equal(codex[ev][i].matcher, g.matcher, ev);
      g.hooks.forEach((h, j) => {
        const c = codex[ev][i].hooks[j];
        assert.equal(c.type, 'command');
        assert.equal(c.command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/crew-hook.js" ${h.args[1]}`);
        assert.equal(c.commandWindows, c.command);
        assert.equal(c.timeout, h.timeout);
      });
    });
  }
  const spawn = claude.PreToolUse.find((g) => /Agent/.test(g.matcher || ''));
  assert.match(spawn.matcher, /collaborationspawn_agent/);
  assert.ok(codex.SessionEnd[0].hooks[0].timeout <= 3);
});

test('.codex-plugin/plugin.json agrees with the Claude manifest and points at existing files', () => {
  const root = path.join(__dirname, '..');
  const codex = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version);
  for (const p of [codex.skills, codex.hooks, codex.extensions['com.openai'].hooks]) {
    assert.ok(p.startsWith('./'), p);
    assert.ok(fs.existsSync(path.join(root, p)), p);
  }
});
