'use strict';

// crew review followup: work a code review found enters the plan only as a proposal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.setupHome();
const projects = require('../lib/core/project');
const paths = require('../lib/core/paths');
const rv = require('../lib/features/review');
const planReview = require('../lib/core/plan-review');
const plans = require('../lib/core/plans');

const cli = (repo, ...args) => {
  const r = h.crew(['--json', ...args], repo);
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* an error */ }
  return { ...r, data };
};

// A plan with two steps, a task linked to the second, and a finalized review round holding f1.
function setup({ link = true, goal = 'Ship the CLI' } = {}) {
  const repo = h.makeRepo();
  const proj = projects.add(repo, { name: 'demo' }).project;
  h.crew(['plan', 'new', 'demo', '--title', 'Demo', '--goal', goal], repo);
  h.crew(['plan', 'add', 'demo', 'Parent'], repo);
  h.crew(['plan', 'add', 'demo', 'Step with a task', '--under', 'n1'], repo);
  const brief = path.join(repo, 'brief.md');
  fs.writeFileSync(brief, h.GOOD_BRIEF);
  const made = cli(repo, 'task', 'create', '--title', 'T', '--brief-file', brief, ...(link ? ['--plan', 'demo:n2'] : []));
  assert.equal(made.code, 0, made.err);
  const task = made.data.task.id;
  const dir = rv.findingsDir(paths.taskDir(proj.id, task));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rv.roundFile(paths.taskDir(proj.id, task), 1, 'json'), JSON.stringify([{ id: 'f1', claim: 'The parser drops the last line', suggestion: 'Keep the last line in the parser', verdict: 'upheld' }]));
  return { repo, proj, task };
}

const show = (repo) => cli(repo, 'plan', 'show', 'demo').data;
const flat = (d) => { const out = []; (function walk(l) { l.forEach((n) => { out.push(n); walk(n.children); }); }(d.nodes)); return out; };

test('a finding becomes a proposed step next to the task step, and the percentage does not change until it is accepted', () => {
  const { repo, proj, task } = setup();
  const before = show(repo).summary;
  const r = cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'A test covers the last line');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.state, 'proposed');
  assert.equal(r.data.for, 'n2');
  assert.equal(r.data.goal, 'Ship the CLI');
  const d = show(repo);
  assert.deepEqual([d.summary.done, d.summary.total], [before.done, before.total]);
  const n = flat(d).find((x) => x.id === r.data.id);
  assert.equal(n.text, 'Keep the last line in the parser', 'the suggestion is the default text');
  assert.equal(n.origin, 'review');
  assert.equal(flat(d).find((x) => x.id === 'n1').children.some((c) => c.id === r.data.id), true, 'a sibling of the task step, under its parent');
  assert.equal(flat(d).find((x) => x.id === 'n2').children.length, 0, 'not under the task step');

  const p = planReview.proposalsOf(proj.id, 'demo', plans.readCapped(repo, 'demo')).find((x) => x.id === r.data.id);
  assert.equal(p.from_task, task);
  assert.equal(p.done_when, 'A test covers the last line');
  assert.equal(p.round, null, 'a code review round is not a plan review round');

  const acc = cli(repo, 'plan', 'accept', 'demo', r.data.id);
  assert.equal(acc.code, 0, acc.err);
  assert.equal(show(repo).summary.total, before.total + 1);
});

test('the human output shows the goal and how to decide, and plain text can replace the default', () => {
  const { repo, task } = setup();
  const r = h.crew(['review', 'followup', task, 'f1', '--done-when', 'Done', '--text', 'Own wording'], repo);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Ship the CLI/);
  assert.match(r.out, /crew plan accept demo n\d+/);
  assert.ok(flat(show(repo)).some((x) => x.text === 'Own wording'));
});

test('asking twice changes nothing, and a rejected follow-up does not come back', () => {
  const { repo, task } = setup();
  const one = cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done');
  const again = cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done');
  assert.equal(again.data.existing, true);
  assert.equal(again.data.id, one.data.id);
  const rej = cli(repo, 'plan', 'reject', 'demo', one.data.id, '--note', 'Not worth it');
  assert.equal(rej.code, 0, rej.err);
  const after = cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done');
  assert.equal(after.data.existing, true);
  assert.equal(after.data.state, 'dropped');
});

test('work outside the goal can go to another plan, at its top level', () => {
  const { repo, task } = setup();
  h.crew(['plan', 'new', 'other', '--title', 'Other'], repo);
  const r = cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done', '--plan', 'other');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.slug, 'other');
  assert.equal(r.data.for, null);
  assert.equal(flat(show(repo)).some((x) => x.origin === 'review'), false, 'nothing in the first plan');
  assert.deepEqual(cli(repo, 'plan', 'show', 'other').data.nodes.map((n) => n.state), ['proposed']);
  assert.equal(cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done', '--plan', 'missing').code, 1);
});

test('refused: no --done-when, a finding that is not final, and a task with no plan and no --plan', () => {
  const { repo, task } = setup();
  assert.equal(h.crew(['review', 'followup', task, 'f1'], repo).code !== 0, true);
  const unknown = h.crew(['review', 'followup', task, 'f9', '--done-when', 'Done'], repo);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /not in a finalized review round/);
  const loose = setup({ link: false });
  const r = h.crew(['review', 'followup', loose.task, 'f1', '--done-when', 'Done'], loose.repo);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not linked to a plan step/);
  assert.equal(flat(show(loose.repo)).some((x) => x.origin === 'review'), false);
});

test('--round finds a finding of an older round; a round without it is refused', () => {
  const { repo, proj, task } = setup();
  const dir = paths.taskDir(proj.id, task);
  fs.writeFileSync(rv.roundFile(dir, 2, 'json'), '[]');
  assert.equal(cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done').code, 0, 'found in round 1 from the latest');
  assert.notEqual(cli(repo, 'review', 'followup', task, 'f1', '--done-when', 'Done', '--round', '2').code, 0);
});
