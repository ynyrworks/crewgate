'use strict';

// Regression tests for the usage-analysis gaps that live in the hooks: gate reminders, hook-seen,
// merge parsing, subagent.stop text, `via`, bare agent names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { tmpDir } = require('./helpers');
const gitcmd = require('../lib/hooks/gitcmd');
const agents = require('../lib/core/agents');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const hookseen = require('../lib/core/hookseen');
const tasks = require('../lib/core/tasks');

const post = (f, command, id, response) => H.runHook('post-tool-use', H.base(f, {
  tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: response === undefined ? { stdout: '' } : response,
}), { cwd: f.repo });

// ---------------------------------------------------------------- 1. gate reminders
test('push without a recorded approval: reminder + gate.missing; with a yes it stays quiet', () => {
  const f = H.fixture();
  H.start(f);
  const r = post(f, 'git push origin feat/x', 'p1');
  assert.match(r.json.hookSpecificOutput.additionalContext, /"push" gate is set to ask/);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(!('decision' in r.json), 'never blocks');
  const miss = H.evs(f, 'gate.missing');
  assert.equal(miss.length, 1);
  assert.equal(miss[0].data.gate, 'push');
  assert.equal(miss[0].data.command, 'git push');

  H.approve(f); // ask, the user replies, answer
  assert.equal(post(f, 'git push origin feat/x', 'p2').out, '{}');
  assert.equal(H.evs(f, 'gate.missing').length, 1);
});

test('gh pr create is the open_pr gate, git merge the merge gate; a "no" answer or another gate does not count', () => {
  const f = H.fixture();
  H.start(f);
  const pr = post(f, 'gh pr create --base main', 'pr1');
  assert.match(pr.json.hookSpecificOutput.additionalContext, /"open_pr" gate/);
  const g = gates.ask(f.pid, {}, { gate: 'merge' });
  gates.answer(f.pid, g.id, 'no');
  assert.match(post(f, 'git merge feat/x', 'm1', { stdout: '' }).json.hookSpecificOutput.additionalContext, /"merge" gate/);
  const other = gates.ask(f.pid, {}, { gate: 'push' });
  gates.answer(f.pid, other.id, 'yes');
  assert.match(post(f, 'glab mr create', 'mr1').json.hookSpecificOutput.additionalContext, /"open_pr" gate/, 'a push yes is not an open_pr yes');
});

test('an approval older than 30 minutes or from another session does not count; an auto gate stays quiet, a never gate that ran is reported', () => {
  const f = H.fixture({ config: { gates: { merge: 'auto', open_pr: 'never' } } });
  H.start(f);
  assert.equal(post(f, 'git merge x', 'a1').out, '{}', 'auto');
  assert.match(post(f, 'gh pr create', 'a2').json.hookSpecificOutput.additionalContext, /"open_pr" gate is set to never/);
  assert.equal(H.evs(f, 'gate.missing').filter((e) => e.data.mode === 'never').length, 1);

  const g = gates.ask(f.pid, {}, { gate: 'push' }, { session: 'other-session' });
  gates.answer(f.pid, g.id, 'yes', '', { session: 'other-session' });
  assert.equal(gates.hasApproval(f.pid, 'push', f.sid), false, 'other session');
  assert.equal(gates.hasApproval(f.pid, 'push', 'other-session'), true);
  assert.equal(gates.hasApproval(f.pid, 'push', 'other-session', Date.now() + gates.ANSWER_WINDOW_MS + 60000), false, 'too old');
});

// ---------------------------------------------------------------- 2. hook-seen
test('hooks note when they fired for the project, at most once per event per minute', () => {
  const f = H.fixture();
  H.start(f);
  H.runHook('user-prompt-submit', H.base(f, { prompt: 'hi' }), { cwd: f.repo });
  const seen = hookseen.read(f.pid);
  const by = Object.fromEntries(seen.rows.map((r) => [r.event, r.last]));
  assert.ok(by.SessionStart && by.UserPromptSubmit);
  assert.equal(by.SessionEnd, null);
  assert.deepEqual(seen.missing, ['Stop', 'SessionEnd']);

  const file = path.join(f.home, 'projects', f.pid, 'runtime', 'hook-seen.json');
  const before = fs.readFileSync(file, 'utf8');
  H.runHook('user-prompt-submit', H.base(f, { prompt: 'again' }), { cwd: f.repo });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'throttled: no second write within 60 s');

  H.runHook('stop', H.base(f, { last_assistant_message: 'x' }), { cwd: f.repo });
  H.runHook('session-end', H.base(f, { reason: 'other' }), { cwd: f.repo });
  assert.deepEqual(hookseen.read(f.pid).missing, []);
});

test('hookseen.note ignores unknown events and unregistered ids without throwing', () => {
  const f = H.fixture();
  hookseen.note(f.pid, 'nonsense');
  hookseen.note(null, 'stop');
  assert.ok(hookseen.read(f.pid).rows.every((r) => r.last === null));
  const t0 = Date.now();
  hookseen.note(f.pid, 'stop', t0);
  hookseen.note(f.pid, 'stop', t0 + 59000);
  assert.equal(Date.parse(hookseen.read(f.pid).rows.find((r) => r.event === 'Stop').last), t0);
  hookseen.note(f.pid, 'stop', t0 + 61000);
  assert.equal(Date.parse(hookseen.read(f.pid).rows.find((r) => r.event === 'Stop').last), t0 + 61000);
});

// ---------------------------------------------------------------- 3. merge parsing
test('an unexpanded shell variable is never a branch name', () => {
  const one = gitcmd.detect('for b in a b c; do git merge --no-ff $b; done');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].data.branches, []);
  assert.equal(one[0].data.dynamic, true);
  for (const w of ['"$b"', '`cat x`', '$(git branch)', '%BRANCH%', '${B}']) {
    const d = gitcmd.detect(`git merge ${w}`)[0].data;
    assert.deepEqual(d.branches, [], w);
    assert.equal(d.dynamic, true, w);
  }
  const plain = gitcmd.detect('git merge feat/x')[0].data;
  assert.deepEqual(plain.branches, ['feat/x']);
  assert.ok(!('dynamic' in plain));
});

test('mergesIn reads git output: merge, fast-forward with range, squash', () => {
  const out = ['Updating 1a2b3c4..5d6e7f8', 'Fast-forward', ' a | 1 +', "Merge made by the 'ort' strategy.", 'Squash commit -- not updating HEAD', 'Already up to date.'].join('\n');
  assert.deepEqual(gitcmd.mergesIn(out), [
    { outcome: 'fast-forward', range: '1a2b3c4..5d6e7f8' }, { outcome: 'merge' }, { outcome: 'squash' },
  ]);
  assert.deepEqual(gitcmd.mergesIn(''), []);
  assert.deepEqual(gitcmd.mergesIn(undefined), []);
});

test('a loop merging three branches yields three git.merge events with no "$b"', () => {
  const f = H.fixture({ config: { gates: { merge: 'auto' } } });
  H.start(f);
  const stdout = ["Merge made by the 'ort' strategy.", 'Updating aaaaaaa..bbbbbbb', 'Fast-forward', "Merge made by the 'ort' strategy."].join('\n');
  post(f, 'for b in one two three; do git merge --no-ff $b; done', 'loop1', { stdout, stderr: '' });
  post(f, 'for b in one two three; do git merge --no-ff $b; done', 'loop1', { stdout, stderr: '' }); // fired twice
  const merges = H.evs(f, 'git.merge');
  assert.equal(merges.length, 3);
  assert.deepEqual(merges.map((e) => e.data.outcome), ['merge', 'fast-forward', 'merge']);
  assert.deepEqual(merges.map((e) => `${e.data.seq}/${e.data.of}`), ['1/3', '2/3', '3/3']);
  assert.ok(merges.every((e) => e.data.dynamic === true && e.data.branches.length === 0));
  assert.ok(!JSON.stringify(merges).includes('$b'));
  assert.equal(merges[1].data.range, 'aaaaaaa..bbbbbbb');
});

test('a plain merge carries the count git reported; a string tool_response works too', () => {
  const f = H.fixture({ config: { gates: { merge: 'auto' } } });
  H.start(f);
  post(f, 'git merge feat/x', 'm1', "Merge made by the 'ort' strategy.\n a | 1 +");
  const [e] = H.evs(f, 'git.merge');
  assert.deepEqual(e.data.branches, ['feat/x']);
  assert.equal(e.data.merged, 1);
  assert.equal(e.data.outcome, 'merge');
});

// ---------------------------------------------------------------- 4. subagent.stop text
test('subagent.stop keeps a redacted snippet of at most 200 characters (realistic Claude payload)', () => {
  const f = H.fixture();
  H.start(f);
  const long = `${'Finished the work. '.repeat(30)}token=abcdef1234567890 done`;
  H.runHook('subagent-stop', H.base(f, {
    hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'crewgate:crew-worker', stop_hook_active: false,
    agent_transcript_path: path.join(f.repo, 'agent.jsonl'), last_assistant_message: long, background_tasks: [],
  }), { cwd: f.repo });
  const [e] = H.evs(f, 'subagent.stop');
  assert.ok(e.data.last.length > 0 && e.data.last.length <= 200, `length ${e.data.last.length}`);
  assert.match(e.data.last, /^Finished the work\./);
  assert.equal(e.data.last_src, 'payload');
  const redacted = H.runHook('subagent-stop', H.base(f, { agent_id: 'a2', agent_type: 'x', last_assistant_message: 'password=hunter2hunter2 ok' }), { cwd: f.repo });
  assert.equal(redacted.code, 0);
  assert.ok(!JSON.stringify(H.evs(f, 'subagent.stop')).includes('hunter2'));
});

test('subagent.stop falls back to the transcript when the payload message is empty or content blocks', () => {
  const f = H.fixture();
  H.start(f);
  const tp = path.join(tmpDir('crew-tp-'), 'agent-a3.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first words' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Report filed, all green.' }] } }),
  ].join('\n') + '\n');
  H.runHook('subagent-stop', H.base(f, { agent_id: 'a3', agent_type: 'crew-worker', agent_transcript_path: tp, last_assistant_message: '' }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'a4', agent_type: 'crew-worker', last_assistant_message: [{ type: 'text', text: 'blocks form' }] }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'a5', agent_type: 'crew-worker' }), { cwd: f.repo });
  const by = Object.fromEntries(H.evs(f, 'subagent.stop').map((e) => [e.agent, e.data]));
  assert.equal(by.a3.last, 'Report filed, all green.');
  assert.equal(by.a3.last_src, 'transcript');
  assert.equal(by.a4.last, 'blocks form');
  assert.equal(by.a5.last, '');
  assert.equal(by.a5.last_src, 'none');
});

// ---------------------------------------------------------------- 5. via
test('task.dispatched / task.returned say where they came from', () => {
  const f = H.fixture();
  H.start(f);
  const t = H.newTask(f);
  H.runHook('pre-tool-use', H.agentPayload(f, t, { tool_input: { prompt: `crew-task: ${t.id}\nx`, subagent_type: 'crewgate:crew-worker' } }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'ag', agent_type: 'crewgate:crew-worker', last_assistant_message: `crew-task: ${t.id}` }), { cwd: f.repo });
  const d = H.evs(f, 'task.dispatched')[0].data;
  const r = H.evs(f, 'task.returned')[0].data;
  assert.equal(d.via, 'pre-tool-use');
  assert.equal(r.via, 'subagent-stop');
});

test('foreground return through PostToolUse(Agent) is via post-tool-use', () => {
  const f = H.fixture();
  H.start(f);
  const t = H.newTask(f);
  const payload = H.agentPayload(f, t, { tool_input: { prompt: `crew-task: ${t.id}\nx`, subagent_type: 'crew-worker' } });
  H.runHook('pre-tool-use', payload, { cwd: f.repo });
  H.runHook('post-tool-use', { ...payload, tool_response: { content: 'done' } }, { cwd: f.repo });
  assert.equal(H.evs(f, 'task.returned')[0].data.via, 'post-tool-use');
});

// ---------------------------------------------------------------- 6. agent names
test('agent_type is the bare name, the original is kept as agent_type_raw', () => {
  assert.equal(agents.bareName('crewgate:Crew-Reviewer'), 'crew-reviewer');
  assert.equal(agents.bareName(''), 'general-purpose');
  assert.equal(agents.bareName(undefined, 'x'), 'x');
  assert.equal(agents.roleOf('crewgate:crew-refuter'), 'refuter');
  assert.equal(agents.roleOf('crew-worker'), 'worker');
  assert.equal(agents.roleOf('Explore'), 'other');
  assert.deepEqual(agents.typeFields('crewgate:crew-worker'), { agent_type: 'crew-worker', agent_type_raw: 'crewgate:crew-worker' });

  const f = H.fixture();
  H.start(f);
  H.runHook('subagent-start', H.base(f, { agent_id: 'p', agent_type: 'crewgate:crew-reviewer' }), { cwd: f.repo });
  H.runHook('subagent-start', H.base(f, { agent_id: 'q', agent_type: 'crew-reviewer' }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'p', agent_type: 'crewgate:crew-reviewer', last_assistant_message: 'x' }), { cwd: f.repo });
  const evs = [...H.evs(f, 'subagent.start'), ...H.evs(f, 'subagent.stop')];
  assert.ok(evs.every((e) => e.data.agent_type === 'crew-reviewer'));
  assert.deepEqual(evs.map((e) => e.data.agent_type_raw).sort(), ['crew-reviewer', 'crewgate:crew-reviewer', 'crewgate:crew-reviewer']);
  void events; void tasks;
});
