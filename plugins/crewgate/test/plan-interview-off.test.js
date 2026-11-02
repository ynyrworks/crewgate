'use strict';

// plan.interview off: (assumed) lines do not block finalize; the user's one yes confirms them (each becomes (user)).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const plans = require('../lib/core/plans');

function fixture(interview) {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { interview }, limits: { dispatch_max_cpu: 100 } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const planPath = (f) => path.join(f.repo, '.crew', 'plans', 'p.md');
const text = (f) => fs.readFileSync(planPath(f), 'utf8');
const count = (f, type) => events.read(f.pid, {}).filter((e) => e.type === type).length;

function draft(f) {
  { const r = run(f, ['plan', 'new', 'p', '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']); assert.equal(r.code, 0, r.err); }
  assert.equal(run(f, ['plan', 'add', 'p', 'Write the code']).code, 0);
  const c = (q, a, by) => { const r = run(f, ['plan', 'clarify', 'p', '--question', q, '--answer', a, '--by', by]); assert.equal(r.code, 0, r.err); };
  c('Which db?', 'sqlite', 'assumed');
  c('Which os?', 'windows', 'assumed');
  c('Which ui?', 'none', 'decision');
  c('Which mode?', 'the assumed one', 'user');
}
const ask = (f) => {
  const r = run(f, ['--json', 'plan', 'finalize', 'p']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test('off: finalize with assumed lines is asked and lists only them', () => {
  const f = fixture('off');
  draft(f);
  const r = run(f, ['--json', 'plan', 'finalize', 'p']);
  assert.equal(r.code, 0, r.err);
  const a = JSON.parse(r.out);
  assert.deepEqual(a.assumed, ['Q: Which db? A: sqlite (assumed)', 'Q: Which os? A: windows (assumed)']);
  assert.match(a.next, /Which db\? A: sqlite \(assumed\)/);
  assert.match(a.next, /Which os\? A: windows \(assumed\)/);
  assert.doesNotMatch(a.next, /Which ui|Which mode/);
  assert.equal(count(f, 'gate.asked'), 1);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'draft');
});

test('off: yes converts only trailing (assumed), the plan is final and nothing reports a change; one event', () => {
  const f = fixture('off');
  draft(f);
  run(f, ['plan', 'clarify', 'p', '--question', 'Q?', '--answer', 'it was assumed earlier', '--by', 'user']);
  const a = ask(f);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
  const t = text(f);
  assert.match(t, /Which db\? A: sqlite \(user\)/);
  assert.match(t, /Which os\? A: windows \(user\)/);
  assert.match(t, /Which ui\? A: none \(decision\)/);
  assert.match(t, /it was assumed earlier \(user\)/);
  assert.doesNotMatch(t, /\(assumed\)/);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'final');
  assert.equal(plans.changedSinceApproved(f.repo, f.pid, 'p'), false);
  const rec = JSON.parse(fs.readFileSync(path.join(require('../lib/core/paths').projectDir(f.pid), 'plans', 'p.json'), 'utf8'));
  assert.equal(rec.hash, plans.fileHash(f.repo, 'p'));
  const show = JSON.parse(run(f, ['--json', 'plan', 'show', 'p']).out);
  assert.equal(show.state, 'final');
  const ev = events.read(f.pid, {}).filter((e) => e.type === 'plan.assumptions_confirmed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.count, 2);
  assert.equal(count(f, 'plan.finalized'), 1);
});

test('off: a no leaves the plan as it was', () => {
  const f = fixture('off');
  draft(f);
  const before = text(f);
  const a = ask(f);
  assert.equal(run(f, ['gate', 'answer', a.gate_id, 'no']).code, 0);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.equal(text(f), before);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'draft');
  assert.equal(count(f, 'plan.assumptions_confirmed'), 0);
});

test('on: the same plan is refused as before', () => {
  const f = fixture('on');
  draft(f);
  const r = run(f, ['plan', 'finalize', 'p']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /ends in \(assumed\)/);
  assert.equal(count(f, 'gate.asked'), 0);
});

test('off at ask, on at answer: the conversion follows the ask; asked under on is not converted', () => {
  const f = fixture('off');
  draft(f);
  const a = ask(f);
  H.writeConfig(f.repo, { gates: { enforce: 'confirm' }, plan: { interview: 'on' }, limits: { dispatch_max_cpu: 100 } });
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(text(f), /\(assumed\)/);
  assert.equal(count(f, 'plan.assumptions_confirmed'), 1);
  assert.equal(plans.changedSinceApproved(f.repo, f.pid, 'p'), false);
});

test('off: a change after the ask is still refused, and the lines stay assumed', () => {
  const f = fixture('off');
  draft(f);
  const a = ask(f);
  assert.equal(run(f, ['plan', 'clarify', 'p', '--question', 'Late?', '--answer', 'x', '--by', 'decision']).code, 0);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.match(text(f), /sqlite \(assumed\)/);
});
