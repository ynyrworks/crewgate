'use strict';

// Work outside the plan raises the drift question: a task created with no plan while a plan is final (unlinked-task, with
// --outside-plan as the light way out), and files outside a task's --allow / --deny at `crew task accept` (out-of-scope).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const h = require('./helpers');
const { crew } = h;
const events = require('../lib/core/events');
const tasks = require('../lib/core/tasks');

function fixture(enforce = 'block') {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const evs = (f, ...t) => events.read(f.pid, { types: t });

function finalPlan(f, slug = 'p') {
  let r = run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(f, ['plan', 'add', slug, 'Write the code']).code, 0);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', slug]).out);
  H.prompt(f);
  r = run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
}
function answerKind(f, kind, slug = 'p') {
  const a = JSON.parse(run(f, ['--json', 'plan', 'drift', slug, '--kind', kind, '--detail', 'x']).out);
  H.prompt(f);
  const r = run(f, ['plan', 'drift', slug, '--gate', a.gate_id, '--answer', 'defer', '--text', 'noted']);
  assert.equal(r.code, 0, r.err);
}
const briefFile = () => { const p = path.join(h.tmpDir('crew-brief-'), 'b.md'); fs.writeFileSync(p, h.GOOD_BRIEF); return p; };
const create = (f, extra = []) => run(f, ['task', 'create', '--title', 'T', '--brief-file', briefFile(), ...extra]);
const taskCount = (f) => tasks.list(f.pid).length;

// ---------------------------------------------------------------- unlinked task
test('unlinked task, block: refused with the way on, no task made; an answered question lets it through', () => {
  const f = fixture('block');
  finalPlan(f);
  const r = create(f);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /\bp\b/);
  assert.match(r.err, /--plan <slug>:<node>/);
  assert.match(r.err, /plan drift p --kind unlinked-task --detail/);
  assert.match(r.err, /--outside-plan/);
  assert.equal(taskCount(f), 0);
  answerKind(f, 'unlinked-task');
  const ok = create(f);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(taskCount(f), 1);
});

test('unlinked task, block: a task linked with --plan is not blocked', () => {
  const f = fixture('block');
  finalPlan(f);
  const r = create(f, ['--plan', 'p:n1']);
  assert.equal(r.code, 0, r.err);
  assert.equal(taskCount(f), 1);
});

test('unlinked task, remind: created with a warning and plan.drift_unasked; off: silent', () => {
  const f = fixture('remind');
  finalPlan(f);
  const r = create(f);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err + r.out, /a plan is final/i);
  const e = evs(f, 'plan.drift_unasked');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.kind, 'unlinked-task');
  assert.equal(e[0].data.slug, 'p');
  const g = fixture('off');
  finalPlan(g);
  const q = create(g);
  assert.equal(q.code, 0, q.err);
  assert.doesNotMatch(q.err + q.out, /a plan is final/i);
  assert.equal(evs(g, 'plan.drift_unasked').length, 0);
  assert.equal(taskCount(g), 1);
});

test('no final plan: a draft plan does not count; create behaves as before', () => {
  const f = fixture('block');
  assert.equal(create(f).code, 0, 'no plan at all');
  assert.equal(run(f, ['plan', 'new', 'd', '--title', 'D', '--goal', 'g']).code, 0);
  const r = create(f);
  assert.equal(r.code, 0, r.err);
  assert.equal(taskCount(f), 2);
  assert.equal(evs(f, 'plan.drift_unasked', 'plan.drift_denied').length, 0);
});

// ---------------------------------------------------------------- --outside-plan
test('--outside-plan: no reply needed, recorded, stored, shown and counted', () => {
  const f = fixture('block');
  finalPlan(f);
  const r = run(f, ['--json', 'task', 'create', '--title', 'T', '--brief-file', briefFile(), '--outside-plan', 'typo fix']);
  assert.equal(r.code, 0, r.err);
  const id = JSON.parse(r.out).task.id;
  const e = evs(f, 'task.outside_plan');
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].data, { task: id, reason: 'typo fix', plans: ['p'] });
  assert.equal(tasks.load(f.pid, id).outside_plan, 'typo fix');
  assert.match(run(f, ['task', 'show', id]).out, /typo fix/);
  assert.match(run(f, ['plan', 'drift-stats']).out, /--outside-plan uses in this project: 1/);
});

test('--outside-plan: an empty reason, or together with --plan, is a usage error and makes no task', () => {
  const f = fixture('block');
  finalPlan(f);
  assert.equal(create(f, ['--outside-plan', '']).code, 2);
  assert.equal(create(f, ['--outside-plan', '   ']).code, 2);
  assert.equal(create(f, ['--outside-plan', 'why', '--plan', 'p:n1']).code, 2);
  assert.equal(taskCount(f), 0);
  assert.equal(evs(f, 'task.outside_plan').length, 0);
});

// ---------------------------------------------------------------- scope at accept
function branchWith(f, name, files) {
  const base = h.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  h.git(f.repo, 'checkout', '-q', '-b', name);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(f.repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    h.git(f.repo, 'add', rel);
  }
  h.git(f.repo, 'commit', '-q', '-m', 'work');
  h.git(f.repo, 'checkout', '-q', base);
}
function returnedTask(f, { branch = 'feat/x', allow = [], deny = [], plan = null } = {}) {
  const t = tasks.createTask(f.pid, { title: 'T', brief: h.GOOD_BRIEF, branch, scope: { allow, deny } });
  tasks.transition(f.pid, t.id, 'dispatched', {});
  tasks.transition(f.pid, t.id, 'returned', {});
  if (plan) assert.equal(run(f, ['plan', 'link', plan, 'n1', t.id]).code, 0);
  return t;
}
const state = (f, t) => tasks.load(f.pid, t.id).state;
const SCOPE_EVENTS = ['task.scope_warned', 'task.scope_widened', 'task.scope_check_failed'];

test('accept, no scope on the task: not checked', () => {
  const f = fixture('block');
  branchWith(f, 'feat/x', { 'any/where.txt': 'x' });
  const t = returnedTask(f);
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(evs(f, ...SCOPE_EVENTS).length, 0);
});

test('accept, only files inside the scope: accepted, nothing recorded', () => {
  const f = fixture('block');
  branchWith(f, 'feat/x', { 'src/a.txt': 'x' });
  const t = returnedTask(f, { allow: ['src/**'], deny: ['docs/**'] });
  assert.equal(run(f, ['task', 'accept', t.id]).code, 0);
  assert.equal(evs(f, ...SCOPE_EVENTS).length, 0);
});

test('accept, block, no final plan: refused with both ways on; --widen needs the user reply through task_scope', () => {
  const f = fixture('block');
  branchWith(f, 'feat/x', { 'src/a.txt': 'x', 'docs/b.txt': 'y' });
  const t = returnedTask(f, { allow: ['src/**'] });
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/b\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt/);
  assert.match(r.err, /task send-back/);
  assert.match(r.err, /--widen/);
  assert.equal(state(f, t), 'returned');
  // the widen asks first
  const ask = JSON.parse(run(f, ['--json', 'task', 'accept', t.id, '--widen', 'docs are part of it']).out);
  assert.ok(ask.gate_id);
  assert.equal(state(f, t), 'returned');
  // no user message since the ask: refused
  const no = run(f, ['task', 'accept', t.id, '--widen', 'docs are part of it', '--gate', ask.gate_id]);
  assert.notEqual(no.code, 0);
  assert.equal(state(f, t), 'returned');
  H.prompt(f);
  const ok = run(f, ['task', 'accept', t.id, '--widen', 'docs are part of it', '--gate', ask.gate_id]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(state(f, t), 'accepted');
  const e = evs(f, 'task.scope_widened');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.reason, 'docs are part of it');
  assert.deepEqual(e[0].data.files, ['docs/b.txt']);
});

test('accept, block, task of a final plan: refused until out-of-scope was answered', () => {
  const f = fixture('block');
  finalPlan(f);
  branchWith(f, 'feat/x', { 'docs/b.txt': 'y' });
  const t = returnedTask(f, { allow: ['src/**'], plan: 'p' });
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/b\.txt/);
  assert.match(r.err, /plan drift p --kind out-of-scope --detail/);
  assert.equal(state(f, t), 'returned');
  answerKind(f, 'out-of-scope');
  const ok = run(f, ['task', 'accept', t.id]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(state(f, t), 'accepted');
});

test('accept, remind: accepted with the files printed and task.scope_warned; off: nothing, no diff read', () => {
  const f = fixture('remind');
  branchWith(f, 'feat/x', { 'docs/b.txt': 'y' });
  const t = returnedTask(f, { allow: ['src/**'] });
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err + r.out, /docs\/b\.txt/);
  const e = evs(f, 'task.scope_warned');
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].data.files, ['docs/b.txt']);
  const g = fixture('off');
  const u = returnedTask(g, { branch: 'feat/none', allow: ['src/**'] }); // no such branch: a read would record a failure
  const q = run(g, ['task', 'accept', u.id]);
  assert.equal(q.code, 0, q.err);
  assert.equal(evs(g, ...SCOPE_EVENTS).length, 0);
});

test('accept: a file matching both --allow and --deny is outside', () => {
  const f = fixture('block');
  branchWith(f, 'feat/x', { 'src/secret/k.txt': 'x' });
  const t = returnedTask(f, { allow: ['src/**'], deny: ['src/secret/**'] });
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /src\/secret\/k\.txt/);
});

test('accept: a file renamed out of the scope is outside (the old path counts)', () => {
  const f = fixture('block');
  fs.mkdirSync(path.join(f.repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'docs', 'old.txt'), 'some content that is long enough to be seen as the same file\n'.repeat(5));
  h.git(f.repo, 'add', 'docs/old.txt');
  h.git(f.repo, 'commit', '-q', '-m', 'docs');
  const base = h.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/x');
  fs.mkdirSync(path.join(f.repo, 'src'), { recursive: true });
  h.git(f.repo, 'mv', 'docs/old.txt', 'src/new.txt');
  h.git(f.repo, 'commit', '-q', '-m', 'move');
  h.git(f.repo, 'checkout', '-q', base);
  const t = returnedTask(f, { allow: ['src/**'] });
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/old\.txt/);
});

test('accept: a git failure lets accept go on with a warning and task.scope_check_failed', () => {
  const f = fixture('block');
  const t = returnedTask(f, { branch: 'feat/missing', allow: ['src/**'] });
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err + r.out, /scope/i);
  assert.equal(evs(f, 'task.scope_check_failed').length, 1);
  assert.equal(state(f, t), 'accepted');
});
