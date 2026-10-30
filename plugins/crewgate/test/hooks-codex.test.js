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
  // The Bash PreToolUse entry (gates.enforce confirm / block) is Claude Code only: Codex "ask" support is unverified.
  claude.PreToolUse = claude.PreToolUse.filter((g) => g.matcher !== 'Bash' && g.matcher !== 'PowerShell');
  // PowerShell is a Claude Code tool; Codex has no such tool name.
  claude.PostToolUse = claude.PostToolUse.filter((g) => g.matcher !== 'PowerShell');
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

// ---- real Codex 0.160 payload shapes (text is synthetic). PreToolUse/PostToolUse of collaborationspawn_agent
// carry an opaque (encrypted) `message`, so the dispatch is recorded at SubagentStart from the subagent's rollout file.
const OPAQUE = `gAAAAAB${'x'.repeat(190)}`;
const realSpawn = (f, extra) => H.base(f, {
  turn_id: 't1', transcript_path: path.join(f.repo, 'rollout-parent.jsonl'), hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default',
  tool_name: 'collaborationspawn_agent', tool_use_id: 'call-1', tool_input: { task_name: 'crew_task', message: OPAQUE }, ...extra,
});

function rollout(f, agentId, lines) {
  const dir = path.join(f.repo, '..', `codex-sessions-${agentId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-parent.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, `rollout-2026-10-29T16-00-00-${agentId}.jsonl`), lines.map((l) => JSON.stringify({ type: 'message', text: l })).join('\n') + '\n');
  return path.join(dir, 'rollout-parent.jsonl');
}

test('real codex shapes: opaque spawn message is ignored, SubagentStart links the task from the subagent rollout (last marker wins)', () => {
  const f = H.fixture();
  const old = H.newTask(f, 'Earlier task');
  const t = H.newTask(f, 'The task');
  H.start(f);
  const pre = H.runHook('pre-tool-use', realSpawn(f), { cwd: f.repo });
  assert.equal(pre.code, 0);
  assert.equal(tasks.load(f.pid, t.id).state, 'created', 'nothing to read in an opaque message');
  const agentId = '01a186b0-5a69-78c2-85fc-0312b75245e2';
  const tp = rollout(f, agentId, [`first prompt mentions crew-task: ${old.id} long ago`, `crew-task: ${t.id}\n\nReply ok.`, 'developer instructions']);
  H.runHook('post-tool-use', realSpawn(f, { hook_event_name: 'PostToolUse', tool_response: '{"task_name":"/root/crew_task"}' }), { cwd: f.repo });
  H.runHook('subagent-start', H.base(f, {
    turn_id: 't1', transcript_path: tp, hook_event_name: 'SubagentStart', model: 'm', permission_mode: 'default', agent_id: agentId, agent_type: 'default',
  }), { cwd: f.repo });
  assert.equal(tasks.load(f.pid, t.id).state, 'dispatched');
  assert.equal(tasks.load(f.pid, old.id).state, 'created', 'a marker in forked history is not the dispatch');
  const d = H.evs(f, 'task.dispatched');
  assert.equal(d.length, 1);
  assert.equal(d[0].task, t.id);
  assert.equal(d[0].data.engine, 'codex');
  const s = H.evs(f, 'subagent.start');
  assert.equal(s[0].task, t.id);
  assert.equal(s[0].data.linked, true);
  // SubagentStop finishes the task through the stored link
  H.runHook('subagent-stop', H.base(f, {
    transcript_path: tp, hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'default', stop_hook_active: false,
    agent_transcript_path: path.join(path.dirname(tp), `rollout-2026-10-29T16-00-00-${agentId}.jsonl`), last_assistant_message: 'ok',
  }), { cwd: f.repo });
  assert.equal(tasks.load(f.pid, t.id).state, 'returned');
});

test('real codex shapes: a subagent without a marker stays unlinked', () => {
  const f = H.fixture();
  H.start(f);
  const agentId = '01a186b0-aaaa-78c2-85fc-0312b75245e2';
  const tp = rollout(f, agentId, ['just do something']);
  H.runHook('subagent-start', H.base(f, { transcript_path: tp, agent_id: agentId, agent_type: 'default' }), { cwd: f.repo });
  assert.equal(H.evs(f, 'subagent.start')[0].data.linked, false);
  assert.equal(H.evs(f, 'task.dispatched').length, 0);
});
