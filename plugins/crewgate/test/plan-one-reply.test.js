'use strict';

// One reply to start and to keep a plan up to date: (assumed) lines are confirmed by the finalize yes, a split of an approved step
// and the user's own instruction are added without the drift question, bookkeeping of proposals does not void an approval,
// a finished plan closes without a question, and the drift question is three labelled parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const h = require('./helpers');
const { crew } = h;
const events = require('../lib/core/events');
const plans = require('../lib/core/plans');
const tasks = require('../lib/core/tasks');

function fixture(plan = {}, extra = {}) {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce: 'block', ...plan }, limits: { dispatch_max_cpu: 100 }, ...extra } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const planPath = (f, slug = 'p') => path.join(f.repo, '.crew', 'plans', `${slug}.md`);
const text = (f, slug = 'p') => fs.readFileSync(planPath(f, slug), 'utf8');
const evs = (f, ...t) => events.read(f.pid, { types: t });
const changed = (f) => plans.changedSinceApproved(f.repo, f.pid, 'p');
const say = (f, prompt) => H.runHook('user-prompt-submit', H.base(f, { prompt }), { cwd: f.repo });

function draft(f, slug = 'p') {
  const r = run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(f, ['plan', 'add', slug, 'Write the code']).code, 0);
}
function finalPlan(f, slug = 'p') {
  draft(f, slug);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', slug]).out);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
}

// ---------------------------------------------------------------- 1. one reply to start
test('finalize: (assumed) lines under plan.interview on are listed with the plan and the one yes turns them into (user)', () => {
  const f = fixture({ interview: 'on' });
  draft(f);
  assert.equal(run(f, ['plan', 'clarify', 'p', '--question', 'Which db?', '--answer', 'sqlite', '--by', 'assumed']).code, 0);
  const r = run(f, ['--json', 'plan', 'finalize', 'p']);
  assert.equal(r.code, 0, r.err);
  const a = JSON.parse(r.out);
  assert.deepEqual(a.assumed, ['Q: Which db? A: sqlite (assumed)']);
  assert.match(a.next, /Which db\? A: sqlite \(assumed\)/);
  H.prompt(f);
  const y = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.equal(y.code, 0, y.err);
  assert.match(text(f), /sqlite \(user\)/);
  assert.doesNotMatch(text(f), /\(assumed\)/);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'final');
  assert.equal(changed(f), false);
});

// ---------------------------------------------------------------- 2. splitting is not drift
test('add --under an approved open step is a split: no question, recorded, the plan stays approved', () => {
  const f = fixture();
  finalPlan(f);
  const r = run(f, ['plan', 'add', 'p', 'Write the parser', '--under', 'n1', '--origin', 'plan']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f), /Write the parser/);
  assert.match(text(f), /## Drift\r?\n- \d{4}-\d{2}-\d{2} split n1: Write the parser/);
  const e = evs(f, 'plan.drift_answered');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.kind, 'split');
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'final');
  assert.equal(changed(f), false);
  assert.equal(evs(f, 'gate.asked').filter((g) => g.data.gate === 'plan_drift').length, 0);
});

test('add: a top-level step, and a step under a done or dropped node, still stop for the question', () => {
  const f = fixture();
  finalPlan(f);
  let r = run(f, ['plan', 'add', 'p', 'Top level', '--origin', 'plan']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Expected:/);
  assert.equal(run(f, ['plan', 'set', 'p', 'n1', 'done']).code, 0);
  r = run(f, ['plan', 'add', 'p', 'Under done', '--under', 'n1', '--origin', 'plan']);
  assert.notEqual(r.code, 0);
  assert.equal(run(f, ['plan', 'set', 'p', 'n1', 'dropped']).code, 0);
  r = run(f, ['plan', 'add', 'p', 'Under dropped', '--under', 'n1', '--origin', 'plan']);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(text(f), /Top level|Under done|Under dropped/);
});

// ---------------------------------------------------------------- 3. the user's instruction
test('add --origin user --quote: accepted when the quote is in the prompt of this turn, recorded as add with the quote', () => {
  const f = fixture();
  finalPlan(f);
  say(f, 'Please also write the docs page for it');
  const r = run(f, ['plan', 'add', 'p', 'Write the docs page', '--origin', 'user', '--quote', 'write the DOCS page']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f), /Write the docs page/);
  const e = evs(f, 'plan.drift_answered');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.answer, 'add');
  assert.equal(e[0].data.quote, 'write the DOCS page');
  assert.match(text(f), /new-step add: Write the docs page/);
  assert.equal(changed(f), false);
});

test('add --origin user: no quote, a quote that is not in the prompt, and a too short quote still stop', () => {
  const f = fixture();
  finalPlan(f);
  say(f, 'Please also write the docs page for it');
  for (const extra of [[], ['--quote', 'delete everything'], ['--quote', 'x']]) {
    const r = run(f, ['plan', 'add', 'p', 'Write the docs page', '--origin', 'user', ...extra]);
    assert.notEqual(r.code, 0, extra.join(' '));
  }
  assert.doesNotMatch(text(f), /docs page/);
  assert.equal(evs(f, 'plan.drift_answered').length, 0);
});

// ---------------------------------------------------------------- 4. bookkeeping does not void an approval
test('reject and rm of a [?] proposal on a final plan leave changedSinceApproved false', () => {
  const f = fixture();
  finalPlan(f);
  assert.equal(run(f, ['plan', 'add', 'p', 'Maybe this', '--proposed']).code, 0);
  assert.equal(run(f, ['plan', 'add', 'p', 'Maybe that', '--proposed']).code, 0);
  assert.equal(changed(f), false, 'open proposals');
  const r = run(f, ['plan', 'reject', 'p', 'n2', '--note', 'superseded']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f), /\[~\] Maybe this/);
  assert.equal(changed(f), false, 'after reject');
  assert.equal(run(f, ['plan', 'rm', 'p', 'n3']).code, 0);
  assert.equal(changed(f), false, 'after rm');
});

test('a plan finalized with a rejected [~] proposal under the old hash formula still reads unchanged, and its record is rewritten', () => {
  const f = fixture();
  finalPlan(f);
  assert.equal(run(f, ['plan', 'add', 'p', 'Maybe this', '--proposed']).code, 0);
  assert.equal(run(f, ['plan', 'reject', 'p', 'n2', '--note', 'superseded']).code, 0);
  const doc = plans.parse(text(f));
  const steps = doc.nodes.filter((n) => n.box !== '?').map((n) => [n.depth, n.text]);
  const old = require('node:crypto').createHash('sha256').update(JSON.stringify([doc.title, doc.goal, doc.notDoing, doc.doneWhen, steps])).digest('hex');
  assert.notEqual(old, plans.fileApprovedHash(f.repo, 'p'));
  plans.writeRecord(f.pid, 'p', { approved: old });
  assert.equal(changed(f), false);
  assert.equal(plans.readRecord(f.pid, 'p').approved, plans.fileApprovedHash(f.repo, 'p'));
  // a real change is still seen
  fs.writeFileSync(planPath(f), text(f).replace('Write the code', 'Write other code'));
  plans.writeRecord(f.pid, 'p', { approved: old });
  assert.equal(changed(f), true);
});

test('add --origin user --quote does not answer the drift question: a second top-level add without a quote in the same turn still stops', () => {
  const f = fixture();
  finalPlan(f);
  say(f, 'Please also write the docs page for it');
  assert.equal(run(f, ['plan', 'add', 'p', 'Write the docs page', '--origin', 'user', '--quote', 'write the DOCS page']).code, 0);
  const r = run(f, ['plan', 'add', 'p', 'Another thing', '--origin', 'user']);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(text(f), /Another thing/);
});

// ---------------------------------------------------------------- 5. finished plans close themselves out
test('the last open step done: one line says the plan is complete; close done needs no gate; parked still asks', () => {
  const f = fixture();
  finalPlan(f);
  assert.equal(run(f, ['plan', 'add', 'p', 'Second', '--under', 'n1', '--origin', 'plan']).code, 0);
  assert.equal(run(f, ['plan', 'add', 'p', 'Third', '--under', 'n1', '--origin', 'plan']).code, 0);
  let r = run(f, ['plan', 'set', 'p', 'n2', 'done']);
  assert.doesNotMatch(r.out, /plan close/);
  r = run(f, ['plan', 'set', 'p', 'n3', 'done']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /plan close p done/);
  const park = run(f, ['plan', 'close', 'p', 'parked']);
  assert.match(park.out, /gate/i);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'final');
  const asked = evs(f, 'gate.asked').length;
  r = run(f, ['plan', 'close', 'p', 'done']);
  assert.equal(r.code, 0, r.err);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'done');
  assert.equal(evs(f, 'gate.asked').length, asked);
});

test('close done with an open step still asks the user', () => {
  const f = fixture();
  finalPlan(f);
  const r = run(f, ['plan', 'close', 'p', 'done']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /gate/i);
  assert.equal(plans.stateOf(f.repo, f.pid, 'p'), 'final');
});

test('a final plan with every step done does not make task create refuse an unlinked task; one with an open step does', () => {
  const f = fixture();
  finalPlan(f);
  const brief = path.join(h.tmpDir('crew-brief-'), 'b.md');
  fs.writeFileSync(brief, h.GOOD_BRIEF);
  const create = () => run(f, ['task', 'create', '--title', 'T', '--brief-file', brief]);
  assert.notEqual(create().code, 0, 'open step');
  assert.equal(run(f, ['plan', 'set', 'p', 'n1', 'done']).code, 0);
  const r = create();
  assert.equal(r.code, 0, r.err);
  assert.equal(tasks.list(f.pid).length, 1);
});

// ---------------------------------------------------------------- 6. the drift question says what happened
test('the drift question has three labelled parts in the gate detail and the printed text', () => {
  const f = fixture();
  finalPlan(f);
  const r = run(f, ['plan', 'drift', 'p', '--kind', 'new-step', '--detail', 'a docs step appeared', '--expected', 'only code steps', '--why', 'docs were never approved']);
  assert.equal(r.code, 0, r.err);
  for (const w of [/Expected: only code steps/, /Found: a docs step appeared/, /Why it matters: docs were never approved/, /same intent, refined execution/, /intent changed or it is a different job/]) assert.match(r.out, w);
  const g = evs(f, 'gate.asked').find((x) => x.data.gate === 'plan_drift');
  assert.match(g.data.detail, /Expected: only code steps \| Found: a docs step appeared \| Why it matters: docs were never approved/);
  const d = run(f, ['plan', 'drift', 'p', '--kind', 'changed-text']);
  assert.match(d.out, /Expected: the plan the user approved \(p\): Ship it/);
  assert.match(d.out, /Why it matters: a changed step text/);
});

test('the drift question is in the project language', () => {
  const f = fixture({}, { language: 'zh-TW' });
  finalPlan(f);
  const r = run(f, ['plan', 'drift', 'p', '--kind', 'new-step', '--detail', 'x']);
  assert.match(r.out, /預期: /);
  assert.match(r.out, /發現: x/);
  assert.match(r.out, /為什麼重要: /);
  assert.match(evs(f, 'gate.asked').find((x) => x.data.gate === 'plan_drift').data.detail, /預期: .*發現: x.*為什麼重要: /);
  const s = run(f, ['plan', 'add', 'p', 'Top level']);
  assert.match(s.err, /預期：[^\n]*\n[^\n]*發現：/);
});

// ---------------------------------------------------------------- 7. large_task
test('accepting proposals on a final plan does not print the large_task hint or record a need', () => {
  const f = fixture({ large_growth: 1, enforce: 'off' });
  finalPlan(f);
  for (const t of ['A', 'B', 'C']) assert.equal(run(f, ['plan', 'add', 'p', t, '--proposed']).code, 0);
  for (const n of ['n2', 'n3', 'n4']) {
    const r = run(f, ['plan', 'accept', 'p', n]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out + r.err, /large_task/);
  }
});
