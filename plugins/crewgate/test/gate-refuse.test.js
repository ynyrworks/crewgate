'use strict';

// `crew gate answer ... yes` is refused when the verdict says the user did not speak since the ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');

function fixture(extra = {}) {
  const f = H.fixture({ config: { gates: { enforce: 'confirm', ...extra } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const note = (f) => H.runHook('user-prompt-submit', H.base(f, { prompt: '<task-notification>done</task-notification>' }), { cwd: f.repo });
const answered = (f) => events.read(f.pid, { types: 'gate.answered' });
const refused = (f) => events.read(f.pid, { types: 'gate.refused' });

test('refused in a turn started by a task notification: non-zero, no yes recorded, a refusal event without the note', () => {
  const f = fixture();
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  note(f);
  const r = crew(['gate', 'answer', id, 'yes', '--note', 'SECRET-NOTE-TEXT'], f.repo, f.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user must reply in chat first/);
  assert.equal(answered(f).length, 0);
  assert.equal(refused(f).length, 1);
  assert.equal(refused(f)[0].data.id, id);
  assert.doesNotMatch(JSON.stringify(refused(f)[0]), /SECRET-NOTE-TEXT/);
  assert.equal(gates.hasApproval(f.pid, 'push', f.sid, Date.now(), { requireUserTurn: true }), false);
});

test('accepted after a real reply, and the same gate can still be answered after a refusal', () => {
  const f = fixture();
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  assert.notEqual(crew(['gate', 'answer', id, 'yes'], f.repo, f.env).code, 0);
  H.prompt(f);
  const r = crew(['gate', 'answer', id, 'yes', '--note', 'ok'], f.repo, f.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(answered(f).length, 1);
  assert.equal(answered(f)[0].data.user_turn, true);
});

test('a no is always accepted', () => {
  const f = fixture();
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  const r = crew(['gate', 'answer', id, 'no'], f.repo, f.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(answered(f)[0].data.answer, 'no');
  assert.equal(refused(f).length, 0);
});

test('require_user_turn false keeps the old behaviour: the yes is stored with user_turn false', () => {
  const f = fixture({ require_user_turn: false });
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  const r = crew(['gate', 'answer', id, 'yes'], f.repo, f.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(answered(f)[0].data.user_turn, false);
  assert.equal(refused(f).length, 0);
});

test('no session known at all: the old verdict is kept (stored, not refused)', () => {
  const f = fixture();
  const id = gates.ask(f.pid, {}, { gate: 'push' }).id;
  const r = crew(['gate', 'answer', id, 'yes'], f.repo, {});
  assert.equal(r.code, 0, r.err);
  assert.equal(answered(f)[0].data.user_turn, false);
  assert.equal(refused(f).length, 0);
});

test('ask and answer in the turn of the user message that wanted the action: refused, that message came before the ask', () => {
  const f = fixture();
  H.prompt(f);
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  const r = crew(['gate', 'answer', id, 'yes'], f.repo, f.env);
  assert.notEqual(r.code, 0);
  assert.equal(answered(f).length, 0);
});
