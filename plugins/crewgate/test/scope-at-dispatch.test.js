'use strict';

// The scope check at `crew task accept` starts from the commit stored when the task was dispatched (scope_base), set by the
// PreToolUse hook for the Agent tool, and only guesses without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const h = require('./helpers');
const { crew } = h;
const events = require('../lib/core/events');
const tasks = require('../lib/core/tasks');

function fixture() {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce: 'block' }, limits: { dispatch_max_cpu: 100 } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
// review.enforce is on (block). These tests are about the scope check at accept, so the review rule is met the way it is for any
// task: a finalized round (no findings) is on disk before accept.
const reviewed = (f, args) => {
  const i = args[0] === 'task' ? args.indexOf('accept') : -1;
  if (i < 0 || !args[i + 1]) return;
  const dir = path.join(require('../lib/core/paths').taskDir(f.pid, args[i + 1]), 'findings');
  if (!fs.existsSync(path.join(dir, '1.json'))) h.finalizedRound(f.pid, args[i + 1]);
};
const run = (f, args) => { reviewed(f, args); return crew(args, f.repo, f.env); };
const evs = (f, ...t) => events.read(f.pid, { types: t });
const state = (f, t) => tasks.load(f.pid, t.id).state;
const cur = (f) => h.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const sha = (f, ref) => h.git(f.repo, 'rev-parse', ref).trim();
function commit(f, files, msg = 'work') {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(f.repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    h.git(f.repo, 'add', rel);
  }
  h.git(f.repo, 'commit', '-q', '-m', msg);
}
// Dispatches through the real hook (created -> dispatched), as the orchestrator's Agent call does.
function dispatch(f, branch, allow) {
  const t = tasks.createTask(f.pid, { title: 'T', brief: h.GOOD_BRIEF, branch, scope: { allow, deny: [] } });
  const r = H.runHook('pre-tool-use', H.agentPayload(f, t), { cwd: f.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(state(f, t), 'dispatched');
  return t;
}
const ret = (f, t) => tasks.transition(f.pid, t.id, 'returned', {});
// Work on `branch` while the project checkout stays where it was.
function work(f, branch, files) {
  const was = cur(f);
  h.git(f.repo, 'checkout', '-q', branch);
  commit(f, files);
  h.git(f.repo, 'checkout', '-q', was);
}

test('dispatch stores the branch tip; a re-dispatch after a send-back keeps it', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/a');
  const t = dispatch(f, 'feat/a', ['src/**']);
  const first = sha(f, 'feat/a');
  assert.equal(tasks.load(f.pid, t.id).scope_base, first);
  work(f, 'feat/a', { 'src/a.txt': 'a' });
  ret(f, t);
  tasks.sendBack(f.pid, t.id, {});
  assert.equal(tasks.recordScopeBase(f.pid, t.id, f.repo), null);
  assert.equal(tasks.load(f.pid, t.id).scope_base, first);
});

test('no branch yet: nothing is recorded and the dispatch goes on', () => {
  const f = fixture();
  const t = dispatch(f, 'feat/not-yet', ['src/**']);
  assert.equal(tasks.load(f.pid, t.id).scope_base, undefined);
  const u = dispatch(f, '', ['src/**']);
  assert.equal(tasks.load(f.pid, u.id).scope_base, undefined);
});

test('a task alone on its branch: only its own files are judged', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/alone');
  work(f, 'feat/alone', { 'pre/p.txt': 'p' });
  const t = dispatch(f, 'feat/alone', ['src/**']);
  work(f, 'feat/alone', { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|pre\/p\.txt/);
});

test('two tasks stacked on one branch (the first not accepted yet), HEAD ahead of the branch: the second is not charged with the first', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/s');
  const a = dispatch(f, 'feat/s', ['src/**']);
  work(f, 'feat/s', { 'src/a.txt': 'a' });
  ret(f, a);
  const b = dispatch(f, 'feat/s', ['lib/**']);
  work(f, 'feat/s', { 'lib/b.txt': 'b', 'docs/c.txt': 'c' });
  commit(f, { 'other.txt': 'o' }, 'main moves');
  ret(f, b);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt|other\.txt/);
});

test('a task started from the tip of another branch, HEAD ahead: only its own files', () => {
  const f = fixture();
  const main = cur(f);
  h.git(f.repo, 'branch', 'feat/one');
  const a = dispatch(f, 'feat/one', ['src/**']);
  work(f, 'feat/one', { 'src/a.txt': 'a' });
  ret(f, a);
  h.git(f.repo, 'branch', 'feat/two', 'feat/one');
  const b = dispatch(f, 'feat/two', ['lib/**']);
  work(f, 'feat/two', { 'lib/b.txt': 'b', 'docs/c.txt': 'c' });
  commit(f, { 'other.txt': 'o' }, 'main moves');
  assert.equal(cur(f), main);
  ret(f, b);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt|other\.txt/);
});

test('merged with --no-ff before accept while HEAD is ahead of main: other tasks\' files are not counted', () => {
  const f = fixture();
  const main = cur(f);
  h.git(f.repo, 'branch', 'feat/m');
  const a = dispatch(f, 'feat/m', ['src/**']);
  work(f, 'feat/m', { 'src/a.txt': 'a' });
  ret(f, a);
  const b = dispatch(f, 'feat/m', ['lib/**']);
  work(f, 'feat/m', { 'lib/b.txt': 'b', 'docs/c.txt': 'c' });
  commit(f, { 'other.txt': 'o' }, 'main moves');
  h.git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/m');
  h.git(f.repo, 'checkout', '-q', '-b', 'wip');
  commit(f, { 'wip/w1.txt': '1' }, 'wip 1');
  commit(f, { 'wip/w2.txt': '2' }, 'wip 2');
  assert.notEqual(cur(f), main);
  ret(f, b);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt|other\.txt|wip\//);
});

test('fast-forwarded into the target before accept: the task\'s files are still judged', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/ff');
  const t = dispatch(f, 'feat/ff', ['src/**']);
  work(f, 'feat/ff', { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  h.git(f.repo, 'merge', '-q', '--ff-only', 'feat/ff');
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt/);
  assert.equal(evs(f, 'task.scope_check_failed').length, 0);
});

test('the project checkout sitting on the task branch', () => {
  const f = fixture();
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/co');
  commit(f, { 'pre/p.txt': 'p' });
  const t = dispatch(f, 'feat/co', ['src/**']);
  commit(f, { 'src/a.txt': 'a', 'docs/z.txt': 'z' });
  assert.equal(cur(f), 'feat/co');
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0, r.err);
  assert.match(r.err, /docs\/z\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|pre\/p\.txt/);
});

test('a stored base the branch was reset past is not used: the guess applies and the warning says so', () => {
  const f = fixture();
  const main = cur(f);
  h.git(f.repo, 'branch', 'feat/r');
  work(f, 'feat/r', { 'src/first.txt': 'f' });
  const t = dispatch(f, 'feat/r', ['src/**']);
  const stored = tasks.load(f.pid, t.id).scope_base;
  assert.equal(stored, sha(f, 'feat/r'));
  h.git(f.repo, 'branch', '-f', 'feat/r', main);
  work(f, 'feat/r', { 'src/new.txt': 'n' });
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err + r.out, /no longer belongs to branch feat\/r/);
  assert.equal(state(f, t), 'accepted');
});

test('a branch that no longer exists: no stale note next to the no-branch failure', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/gone');
  const t = dispatch(f, 'feat/gone', ['src/**']);
  assert.ok(tasks.load(f.pid, t.id).scope_base);
  h.git(f.repo, 'branch', '-D', 'feat/gone');
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.doesNotMatch(r.err + r.out, /no longer belongs/);
  assert.equal(evs(f, 'task.scope_check_failed').length, 1);
});

test('block mode, reset branch whose guess finds an out-of-scope file: the refusal comes with the stale note', () => {
  const f = fixture();
  const main = cur(f);
  h.git(f.repo, 'branch', 'feat/rb');
  work(f, 'feat/rb', { 'src/first.txt': 'f' });
  const t = dispatch(f, 'feat/rb', ['src/**']);
  h.git(f.repo, 'branch', '-f', 'feat/rb', main);
  work(f, 'feat/rb', { 'docs/out.txt': 'o' });
  ret(f, t);
  const r = run(f, ['task', 'accept', t.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/out\.txt/);
  assert.match(r.err, /no longer belongs to branch feat\/rb/);
});

test('two tasks dispatched on one branch at the same commit: accepting the first does not put its files on the second', () => {
  const f = fixture();
  h.git(f.repo, 'branch', 'feat/two');
  const a = dispatch(f, 'feat/two', ['src/**']);
  const b = dispatch(f, 'feat/two', ['lib/**']);
  assert.equal(tasks.load(f.pid, a.id).scope_base, tasks.load(f.pid, b.id).scope_base);
  work(f, 'feat/two', { 'src/a.txt': 'a' });
  ret(f, a);
  const ra = run(f, ['task', 'accept', a.id]);
  assert.equal(ra.code, 0, ra.err);
  work(f, 'feat/two', { 'lib/b.txt': 'b', 'docs/c.txt': 'c' });
  ret(f, b);
  const r = run(f, ['task', 'accept', b.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /docs\/c\.txt/);
  assert.doesNotMatch(r.err, /src\/a\.txt|lib\/b\.txt/);
});
