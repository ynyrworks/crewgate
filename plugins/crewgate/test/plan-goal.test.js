'use strict';

// A plan keeps the work on its goal: a plan without one is warned about, and a plan review can say a step drifts.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const projects = require('../lib/core/project');
const plans = require('../lib/core/plans');

function setup() {
  const repo = h.makeRepo();
  projects.add(repo, { name: 'demo' });
  return repo;
}

test('plan new warns on stderr without a goal, still creates the plan, and is silent with one', () => {
  const repo = setup();
  const none = h.crew(['plan', 'new', 'a', '--title', 'A'], repo);
  assert.equal(none.code, 0, none.err);
  assert.match(none.err, /no goal/);
  assert.equal(h.crew(['plan', 'show', 'a'], repo).code, 0);
  const blank = h.crew(['plan', 'new', 'b', '--title', 'B', '--goal', '  '], repo);
  assert.match(blank.err, /no goal/);
  const set = h.crew(['plan', 'new', 'c', '--title', 'C', '--goal', 'Ship it'], repo);
  assert.equal(set.code, 0, set.err);
  assert.doesNotMatch(set.err, /no goal/);
});

test('off-goal is a plan review kind: the reviewer is told about it, the filter keeps it, and it ranks first', () => {
  assert.equal(plans.KINDS[0], 'off-goal');
  const repo = setup();
  h.crew(['plan', 'new', 'd', '--title', 'D', '--goal', 'Ship it'], repo);
  h.crew(['plan', 'add', 'd', 'Rewrite the logo'], repo);
  const run = JSON.parse(h.crew(['--json', 'plan', 'review', 'run', 'd'], repo).out);
  assert.match(run.prompt, /off-goal means a step that does not serve the goal/);
  const finding = { node: 'n1', kind: 'off-goal', claim: 'The logo does not help ship it', evidence: ['n1'], proposal: { action: 'drop', text: 'Not part of the goal', done_when: 'The step is gone from the plan' } };
  assert.equal(u.crewIn(['plan', 'review', 'submit', 'd', '--round', String(run.round)], repo, JSON.stringify([finding])).code, 0);
  const flt = JSON.parse(h.crew(['--json', 'plan', 'review', 'filter', 'd', '--round', String(run.round)], repo).out);
  assert.deepEqual(flt.kept.map((f) => f.kind), ['off-goal']);
});
