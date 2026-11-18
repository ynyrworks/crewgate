'use strict';

// An approval counts once: the user's own instruction (--quote of words in the prompt that started the turn) and an answer
// given in the AskUserQuestion widget count as the user reply that `gate answer yes` needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const sess = require('../lib/hooks/session');

function fixture(extra = {}) {
  const f = H.fixture({ config: { gates: { enforce: 'confirm', ...extra } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const say = (f, text) => H.runHook('user-prompt-submit', H.base(f, { prompt: text }), { cwd: f.repo });
const askGate = (f, gate = 'merge') => gates.ask(f.pid, {}, { gate }, { session: f.sid }).id;
const answer = (f, id, ...more) => crew(['gate', 'answer', id, 'yes', ...more], f.repo, f.env);
const last = (f) => events.read(f.pid, { types: 'gate.answered' }).pop();
const refused = (f) => events.read(f.pid, { types: 'gate.refused' });

test('instruction: a quote found in the prompt of this turn is accepted and recorded', () => {
  const f = fixture();
  say(f, 'ok,   Merge the branch   to main now');
  const id = askGate(f);
  const r = answer(f, id, '--quote', '  merge THE branch ');
  assert.equal(r.code, 0, r.err);
  const e = last(f);
  assert.equal(e.data.answer, 'yes');
  assert.equal(e.data.user_turn, 'instruction');
  assert.equal(e.data.quote, 'merge THE branch');
  assert.equal(refused(f).length, 0);
  assert.equal(gates.hasApproval(f.pid, 'merge', f.sid, Date.now(), { requireUserTurn: false }), true);
});

test('instruction: a quote that is not in the prompt, one that is too short, and no quote are refused', () => {
  const f = fixture();
  say(f, 'merge it');
  const id = askGate(f);
  for (const args of [['--quote', 'push it'], ['--quote', 'm'], ['--quote', '   '], []]) {
    const r = answer(f, id, ...args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /user must reply in chat first/);
  }
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).length, 0);
  assert.ok(refused(f).length >= 1);
  assert.equal(answer(f, id, '--quote', 'merge it').code, 0);
});

test('instruction: a turn started by a task notification has no prompt to quote', () => {
  const f = fixture();
  say(f, 'merge it');
  say(f, '<task-notification>worker done</task-notification>');
  assert.equal(sess.read(f.sid).turn_prompt, undefined);
  const id = askGate(f);
  const r = answer(f, id, '--quote', 'merge it');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user must reply in chat first/);
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).length, 0);
});

test('instruction: an ask made before the prompt is not in the same turn', () => {
  const f = fixture();
  const id = askGate(f);
  say(f, 'merge it');
  // the later prompt is also a plain user reply after the ask: true, not instruction
  assert.equal(answer(f, id, '--quote', 'merge it').code, 0);
  assert.equal(last(f).data.user_turn, true);
  assert.equal(last(f).data.quote, undefined);
});

test('instruction: the prompt text stays in the session file, never in an event', () => {
  const f = fixture();
  say(f, 'merge the unique-marker-7f3a branch');
  const id = askGate(f);
  assert.equal(answer(f, id, '--quote', 'unique-marker-7f3a').code, 0);
  const s = sess.read(f.sid);
  assert.match(s.turn_prompt.text, /unique-marker-7f3a/);
  assert.ok(Number.isFinite(s.turn_prompt.ts));
  const log = events.read(f.pid, {}).map((e) => JSON.stringify(e)).join('\n');
  assert.equal(log.includes('merge the unique-marker-7f3a branch'), false);
  say(f, 'x'.repeat(9000));
  assert.ok(sess.read(f.sid).turn_prompt.text.length <= 4000);
});

test('instruction: gates.require_user_turn=false keeps today (no instruction verdict)', () => {
  const f = fixture({ require_user_turn: false });
  say(f, 'merge it');
  const id = askGate(f);
  // the prompt came before the ask, so today's rule stores false and does not refuse
  assert.equal(answer(f, id, '--quote', 'merge it').code, 0);
  assert.equal(last(f).data.user_turn, false);
});

test('instruction: the same quote finalizes a plan', () => {
  const f = fixture();
  say(f, 'looks right, finalize the plan');
  const run = (args) => crew(args, f.repo, f.env);
  assert.equal(run(['plan', 'new', 'p', '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']).code, 0);
  assert.equal(run(['plan', 'add', 'p', 'Write the code']).code, 0);
  const a = JSON.parse(run(['--json', 'plan', 'finalize', 'p']).out);
  const bad = run(['plan', 'finalize', 'p', '--gate', a.gate_id, '--quote', 'delete everything']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /user must reply in chat first/);
  const ok = run(['plan', 'finalize', 'p', '--gate', a.gate_id, '--quote', 'Finalize the plan']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(events.read(f.pid, { types: 'plan.finalized' }).length, 1);
  assert.equal(last(f).data.user_turn, 'instruction');
});

// ---------------------------------------------------------------- widget
const widget = (f, response) => H.runHook('post-tool-use', H.base(f, {
  tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: { questions: [{ question: 'Merge?', options: [] }] }, tool_response: response,
}), { cwd: f.repo });

test('widget: an answered question is a user reply for the ask before it', () => {
  const f = fixture();
  const id = askGate(f);
  assert.notEqual(answer(f, id).code, 0);
  const r = widget(f, { questions: [], answers: { 'Merge?': 'Yes' } });
  assert.equal(r.code, 0);
  assert.equal(sess.read(f.sid).widget_ts.length, 1);
  assert.ok(!JSON.stringify(sess.read(f.sid)).includes('"Yes"'), 'the answer text is not kept');
  assert.equal(answer(f, id).code, 0);
  assert.equal(last(f).data.user_turn, true);
});

test('widget: the text form of an answered result counts too', () => {
  const f = fixture();
  const id = askGate(f);
  widget(f, 'User has answered your questions: "Merge?"="Yes". You can now continue with the user\'s answers in mind.');
  assert.equal(answer(f, id).code, 0);
});

test('widget: a dismissed or unanswered question is not a reply', () => {
  const f = fixture();
  const id = askGate(f);
  widget(f, "The user doesn't want to proceed with this tool use. The tool use was rejected.");
  widget(f, { is_error: true, content: 'User declined to answer questions' });
  widget(f, { questions: [], answers: {} });
  widget(f, undefined);
  assert.equal((sess.read(f.sid).widget_ts || []).length, 0);
  const r = answer(f, id);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user must reply in chat first/);
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).length, 0);
});

test('hooks.json and codex-hooks.json both route AskUserQuestion to post-tool-use', () => {
  for (const n of ['hooks.json', 'codex-hooks.json']) {
    const h = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'hooks', n), 'utf8')).hooks.PostToolUse;
    assert.ok(h.some((g) => g.matcher === 'AskUserQuestion'), n);
  }
});
