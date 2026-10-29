'use strict';

// review dismiss and the lessons it records write the repo files of the work tree the user is in,
// not the main checkout; the task data stays with the project id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();

test('review dismiss + lesson inside a linked worktree write the worktree copies', () => {
  const main = u.initRepo();
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = path.join(h.tmpDir('crew-wt-'), 'wt');
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/r');

  const t = u.createTask(main);
  const submit = u.crewIn(['review', 'submit', t.id], wt, JSON.stringify([u.finding('f1')]));
  assert.equal(submit.code, 0, submit.err);
  assert.equal(h.crew(['review', 'filter', t.id], wt).code, 0);
  const d = u.crewJson(['review', 'dismiss', t.id, 'f1', '--scope', 'always', '--reason', 'known pattern'], wt);
  assert.equal(d.code, 0, d.err);
  assert.equal(d.data.lesson.key, 'review-dismissed-correctness');

  const ledger = path.join(wt, '.crew', 'dismissed.jsonl');
  assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1, 'ledger entry in the worktree');
  assert.match(fs.readFileSync(path.join(wt, '.crew', 'LESSONS.md'), 'utf8'), /review-dismissed-correctness/);
  assert.equal(fs.readFileSync(path.join(main, '.crew', 'dismissed.jsonl'), 'utf8'), '', 'main checkout ledger untouched');
  assert.doesNotMatch(fs.readFileSync(path.join(main, '.crew', 'LESSONS.md'), 'utf8'), /review-dismissed-correctness/);

  // from the main checkout the finding is not dismissed (its ledger is separate), proving the split
  assert.equal(u.crewIn(['review', 'submit', t.id, '--round', '2'], main, JSON.stringify([u.finding('g1')])).code, 0);
  const f = u.crewJson(['review', 'filter', t.id, '--round', '2'], main);
  assert.deepEqual(f.data.dropped.map((x) => x.reason), [], 'not dismissed from the main checkout');
});
