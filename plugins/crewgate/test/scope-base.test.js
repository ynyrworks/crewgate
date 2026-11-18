'use strict';

// The scope check at `crew task accept` judges only what this task changed: stacked or shared branches, a branch already merged,
// and a plain reason when the check cannot run.
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
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce }, limits: { dispatch_max_cpu: 100 } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const evs = (f, ...t) => events.read(f.pid, { types: t });
const state = (f, t) => tasks.load(f.pid, t.id).state;
function commit(f, files, msg = 'work') {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(f.repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    h.git(f.repo, 'add', rel);
  }
  h.git(f.repo, 'commit', '-q', '-m', msg);
}
const cur = (f) => h.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
function returned(f, branch, allow) {
  const t = tasks.createTask(f.pid, { title: 'T', brief: h.GOOD_BRIEF, branch, scope: { allow, deny: [] } });
  tasks.transition(f.pid, t.id, 'dispatched', {});
  tasks.transition(f.pid, t.id, 'returned', {});
  return t;
}

test('stacked on one branch: the second task is not charged with the first one\'s files', () => {
  const f = fixture('block');
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/s');
  commit(f, { 'src/a.txt': 'a' });
  h.git(f.repo, 'checkout', '-q', main);
  const a = returned(f, 'feat/s', ['src/**']);
  assert.equal(run(f, ['task', 'accept', a.id]).code, 0);
  h.git(f.repo, 'checkout', '-q', 'feat/s');
  commit(f, { 'lib/b.txt': 'b' });
  h.git(f.repo, 'checkout', '-q', main);
  const b = returned(f, 'feat/s', ['lib/**']);
  const r = run(f, ['task', 'accept', b.id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err + r.out, /src\/a\.txt/);
  assert.equal(state(f, b), 'accepted');
});

test('a branch started from the tip of an accepted task: the first task\'s files are not counted', () => {
  const f = fixture('block');
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/one');
  commit(f, { 'src/a.txt': 'a' });
  h.git(f.repo, 'checkout', '-q', main);
  const a = returned(f, 'feat/one', ['src/**']);
  assert.equal(run(f, ['task', 'accept', a.id]).code, 0);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/two', 'feat/one');
  commit(f, { 'lib/b.txt': 'b' });
  h.git(f.repo, 'checkout', '-q', main);
  const b = returned(f, 'feat/two', ['lib/**']);
  const r = run(f, ['task', 'accept', b.id]);
  assert.equal(r.code, 0, r.err);
});

test('stacked: a real change outside --allow is still refused, naming only that file', () => {
  const f = fixture('block');
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/s');
  commit(f, { 'src/a.txt': 'a' });
  h.git(f.repo, 'checkout', '-q', main);
  const a = returned(f, 'feat/s', ['src/**']);
  assert.equal(run(f, ['task', 'accept', a.id]).code, 0);
  h.git(f.repo, 'checkout', '-q', 'feat/s');
  commit(f, { 'lib/b.txt': 'b', 'docs/c.txt': 'c' });
  h.git(f.repo, 'checkout', '-q', main);
  const b = returned(f, 'feat/s', ['lib/**']);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt/);
  assert.equal(state(f, b), 'returned');
});

test('a branch already merged into HEAD is still checked, from the first parent of the merge', () => {
  const f = fixture('block');
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/m');
  commit(f, { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  h.git(f.repo, 'checkout', '-q', main);
  commit(f, { 'other.txt': 'o' }, 'main moves');
  h.git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/m');
  const t = returned(f, 'feat/m', ['src/**']);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, 'the check must run, not be skipped');
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /other\.txt/);
  assert.equal(evs(f, 'task.scope_check_failed').length, 0);
});

function stackedMerged(f, bFiles, allow) {
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/sm');
  commit(f, { 'src/a.txt': 'a' });
  h.git(f.repo, 'checkout', '-q', main);
  const a = returned(f, 'feat/sm', ['src/**']);
  assert.equal(run(f, ['task', 'accept', a.id]).code, 0);
  h.git(f.repo, 'checkout', '-q', 'feat/sm');
  commit(f, bFiles);
  h.git(f.repo, 'checkout', '-q', main);
  commit(f, { 'other.txt': 'o' }, 'main moves');
  h.git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/sm');
  return returned(f, 'feat/sm', allow);
}

test('stacked branch merged before the second accept: the first task\'s files are not counted', () => {
  const f = fixture('block');
  const b = stackedMerged(f, { 'lib/b.txt': 'b' }, ['lib/**']);
  const r = run(f, ['task', 'accept', b.id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err + r.out, /src\/a\.txt|other\.txt/);
  assert.equal(state(f, b), 'accepted');
});

test('stacked branch merged before the second accept: an out-of-scope file is refused, naming only it', () => {
  const f = fixture('block');
  const b = stackedMerged(f, { 'lib/b.txt': 'b', 'docs/c.txt': 'c' }, ['lib/**']);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt|other\.txt/);
  assert.equal(state(f, b), 'returned');
});

test('check cannot run: the warning names the branch and repository; the event keeps a machine-readable reason', () => {
  const f = fixture('block');
  const t = returned(f, 'feat/elsewhere', ['src/**']);
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err + r.out, /no branch range/);
  assert.match(r.err + r.out, /feat\/elsewhere/);
  assert.match(r.err + r.out, /does not exist in repository/);
  const e = evs(f, 'task.scope_check_failed');
  assert.equal(e.length, 1);
  assert.equal(e[0].data.reason, 'no-branch');
  assert.equal(e[0].data.branch, 'feat/elsewhere');
});

test('a branch with no commits beyond its base: warned with a plain reason, not "no branch range"', () => {
  const f = fixture('block');
  h.git(f.repo, 'branch', 'feat/empty');
  const t = returned(f, 'feat/empty', ['src/**']);
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err + r.out, /no branch range/);
  assert.match(r.err + r.out, /no commits beyond its base/);
  assert.equal(evs(f, 'task.scope_check_failed')[0].data.reason, 'no-commits');
});

test('the task branch checked out in the project repo: its out-of-scope file is still refused', () => {
  const f = fixture('block');
  const main = cur(f);
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/co');
  commit(f, { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  const t = returned(f, 'feat/co', ['src/**']);
  assert.equal(cur(f), 'feat/co');
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, 'the check must run, not find an empty range');
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt/);
  assert.equal(state(f, t), 'returned');
  assert.ok(main);
});

test('HEAD, main and master give different merge-bases: the nearest one is the base', () => {
  const f = fixture('block');
  const main = cur(f);
  commit(f, { 'pre.txt': 'p' }, 'main moves before the branch');
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/near');
  commit(f, { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  h.git(f.repo, 'checkout', '-q', '-b', 'side', `${main}~1`);
  assert.equal(cur(f), 'side');
  const t = returned(f, 'feat/near', ['src/**']);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /pre\.txt|src\/a\.txt/);
});
