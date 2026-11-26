'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const lessons = require('../lib/features/lessons');

const LF = (root) => path.join(root, '.crew', 'LESSONS.md');
const OFF = (c) => { c.worktree = { remove_on_merge: false }; };

// A project with one linked worktree on feat/wt that holds one commit, and an accepted task for it.
// opts.cfg patches the config before the worktree is made; opts.keepLessonsOut leaves .crew/LESSONS.md untracked;
// opts.recorded is the worktree value recorded on the task (default: the real worktree).
function setup(opts = {}) {
  const main = u.initRepo();
  if (opts.cfg) u.patchCfg(main, opts.cfg);
  h.git(main, 'add', '-A');
  if (opts.keepLessonsOut) h.git(main, 'rm', '-q', '--cached', '.crew/LESSONS.md');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = `${h.tmpDir('crew-wtm-')}${path.sep}wt`;
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/wt');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n');
  h.git(wt, 'add', 'new.txt');
  h.git(wt, 'commit', '-q', '-m', 'work');
  const task = u.createTask(main, { branch: 'feat/wt', worktree: opts.recorded === undefined ? wt : opts.recorded });
  assert.equal(h.crew(['task', 'report', task.id, '--report-file', u.reportFiles().report], wt).code, 0);
  assert.equal(h.crew(['task', 'accept', task.id, '--read-by-orchestrator', 'read the one-line change'], main).code, 0);
  return { main, wt, task };
}
const mergeBranch = (main) => h.git(main, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/wt');
const doMerge = (id, cwd) => u.crewJson(['task', 'merge', id], cwd);

test('clean and merged: the worktree is removed, the branch stays', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.git_merge.status, 'recorded');
  assert.deepEqual(r.data.worktree, { path: wt, removed: true });
  assert.ok(!fs.existsSync(wt));
  assert.ok(!h.git(main, 'worktree', 'list', '--porcelain').includes('feat/wt'));
  assert.match(h.git(main, 'branch', '--list', 'feat/wt'), /feat\/wt/);
});

test('text output: one added line, and the exit code stays 0', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  const r = h.crew(['task', 'merge', task.id], main);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Task .* recorded as merged/);
  assert.ok(r.out.split('\n').includes(`Removed worktree ${wt}.`), r.out);
});

test('setting off: nothing is removed and the line names the worktree and the command', () => {
  const a = setup({ cfg: OFF });
  mergeBranch(a.main);
  const r = doMerge(a.task.id, a.main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: a.wt, removed: false, reason: 'setting-off' });
  assert.ok(fs.existsSync(a.wt));
  const b = setup({ cfg: OFF });
  mergeBranch(b.main);
  const text = h.crew(['task', 'merge', b.task.id], b.main);
  assert.ok(text.out.includes(`Worktree ${b.wt} stays: worktree.remove_on_merge is off. To remove it: git worktree remove "${b.wt}"`), text.out);
});

test('a modified tracked file keeps the worktree', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: wt, removed: false, reason: 'dirty' });
  assert.ok(fs.existsSync(wt));
});

test('an untracked file keeps the worktree', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x\n');
  const r = doMerge(task.id, main);
  assert.deepEqual(r.data.worktree, { path: wt, removed: false, reason: 'dirty' });
  assert.ok(fs.existsSync(path.join(wt, 'scratch.txt')));
});

test('a file git ignores goes with the worktree', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  const exclude = path.resolve(wt, h.git(wt, 'rev-parse', '--git-path', 'info/exclude'));
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, 'junk.log\n');
  fs.writeFileSync(path.join(wt, 'junk.log'), 'x\n');
  const r = doMerge(task.id, main);
  assert.deepEqual(r.data.worktree, { path: wt, removed: true });
  assert.ok(!fs.existsSync(wt));
});

test('only an untracked .crew/LESSONS.md: its lessons go to the main checkout and the worktree is removed', () => {
  const { main, wt, task } = setup({ keepLessonsOut: true });
  lessons.add(wt, null, { key: 'from-worker', text: 'written in the worktree', date: '2026-05-01' });
  assert.match(h.git(wt, 'status', '--porcelain', '--untracked-files=all'), /\?\? \.crew\/LESSONS\.md/);
  mergeBranch(main);
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: wt, removed: true, adopted: 1 });
  assert.match(fs.readFileSync(LF(main), 'utf8'), /^- 2026-05-01 \[correction\] from-worker: written in the worktree$/m);
  assert.ok(!fs.existsSync(wt));
});

test('adoption fails: the worktree is kept and its file is untouched', () => {
  const { main, wt, task } = setup({ keepLessonsOut: true });
  lessons.add(wt, null, { key: 'from-worker', text: 'written in the worktree', date: '2026-05-01' });
  mergeBranch(main);
  fs.rmSync(LF(main), { force: true });
  fs.mkdirSync(LF(main));   // a folder where the file belongs: the write fails
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.worktree.removed, false);
  assert.equal(r.data.worktree.reason, 'adopt-failed');
  assert.ok(fs.existsSync(LF(wt)));
  assert.ok(fs.existsSync(wt));
});

test('run inside the worktree before main merged the branch: recorded by the cwd check, but not confirmed against main', () => {
  const { wt, task } = setup();
  const r = doMerge(task.id, wt);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.git_merge.status, 'recorded');
  assert.deepEqual(r.data.worktree, { path: wt, removed: false, reason: 'not-merged' });
  assert.ok(fs.existsSync(wt));
});

test('cwd inside the worktree (also a subfolder): kept, with the command to run from the main checkout', () => {
  const a = setup();
  mergeBranch(a.main);
  const r = doMerge(a.task.id, a.wt);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: a.wt, removed: false, reason: 'inside' });
  assert.ok(fs.existsSync(a.wt));
  const b = setup();
  mergeBranch(b.main);
  fs.mkdirSync(path.join(b.wt, 'sub'));
  assert.equal(doMerge(b.task.id, path.join(b.wt, 'sub')).data.worktree.reason, 'inside');
  const c = setup();
  mergeBranch(c.main);
  const text = h.crew(['task', 'merge', c.task.id], c.wt);
  assert.ok(text.out.includes(`you are inside it. From the main checkout run: git worktree remove "${c.wt}"`), text.out);
});

test('a recorded path that is the main checkout is never removed', () => {
  const m = u.initRepo();
  h.git(m, 'add', '-A');
  h.git(m, 'commit', '-q', '-m', 'crew files');
  h.git(m, 'checkout', '-q', '-b', 'feat/wt');
  fs.writeFileSync(path.join(m, 'new.txt'), 'x\n');
  h.git(m, 'add', 'new.txt');
  h.git(m, 'commit', '-q', '-m', 'work');
  h.git(m, 'checkout', '-q', '-');
  const task = u.createTask(m, { branch: 'feat/wt', worktree: m });
  assert.equal(h.crew(['task', 'report', task.id, '--report-file', u.reportFiles().report], m).code, 0);
  assert.equal(h.crew(['task', 'accept', task.id, '--read-by-orchestrator', 'read the one-line change'], m).code, 0);
  mergeBranch(m);
  const r = doMerge(task.id, m);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: m, removed: false, reason: 'main-checkout' });
  assert.ok(fs.existsSync(path.join(m, '.git')));
});

test('a recorded path that git does not list is left alone', () => {
  const other = h.tmpDir('crew-wtm-other-');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'x\n');
  const { main, task } = setup({ recorded: other });
  mergeBranch(main);
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: other, removed: false, reason: 'not-a-worktree' });
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
});

test('a relative recorded path is resolved against the project path', () => {
  const main = u.initRepo();
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const rel = path.join('..', `${path.basename(main)}-rel-wt`);
  const wt = path.resolve(main, rel);
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/wt');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n');
  h.git(wt, 'add', 'new.txt');
  h.git(wt, 'commit', '-q', '-m', 'work');
  const task = u.createTask(main, { branch: 'feat/wt', worktree: rel });
  assert.equal(h.crew(['task', 'report', task.id, '--report-file', u.reportFiles().report], wt).code, 0);
  assert.equal(h.crew(['task', 'accept', task.id, '--read-by-orchestrator', 'read the one-line change'], main).code, 0);
  mergeBranch(main);
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktree, { path: wt, removed: true });
  assert.ok(!fs.existsSync(wt));
});

test('a worktree folder that is already gone: no new field and no error', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  h.git(main, 'worktree', 'remove', wt);
  const r = doMerge(task.id, main);
  assert.equal(r.code, 0, r.err);
  assert.ok(!('worktree' in r.data));
});

test('takeover lesson written from a worktree lands in the main checkout', () => {
  const main = u.initRepo();
  u.patchCfg(main, (c) => { c.limits = { max_returns_before_takeover: 1 }; });
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = `${h.tmpDir('crew-wtm-')}${path.sep}wt`;
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/wt');
  const t = u.createTask(main, { branch: 'feat/wt', worktree: wt });
  const f = u.reportFiles();
  const rep = () => h.crew(['task', 'report', t.id, '--report-file', f.report], wt);
  assert.equal(rep().code, 0);
  assert.equal(h.crew(['task', 'send-back', t.id, '--note', 'first'], wt).code, 0);
  assert.equal(rep().code, 0);
  const refused = h.crew(['task', 'send-back', t.id, '--note', 'second fix'], wt);
  assert.equal(refused.code, 1);
  assert.match(fs.readFileSync(LF(main), 'utf8'), /\[takeover\] takeover-limit: .*second fix/);
  assert.doesNotMatch(fs.readFileSync(LF(wt), 'utf8'), /takeover-limit/);
  assert.equal(h.git(wt, 'status', '--porcelain'), '');
});

test('dismissal lesson written from a worktree lands in the main checkout', () => {
  const main = u.initRepo();
  u.patchCfg(main, (c) => { c.review.enforce = 'off'; });
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = `${h.tmpDir('crew-wtm-')}${path.sep}wt`;
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/wt');
  u.writeFile(wt, 'src/x.js', 'const total = compute(1);\nmodule.exports = total;\n');
  const t = u.createTask(main, { branch: 'feat/wt', worktree: wt });
  assert.equal(h.crew(['review', 'run', t.id], wt).code, 0);
  assert.equal(u.crewIn(['review', 'submit', t.id], wt, JSON.stringify([u.finding('f1')])).code, 0);
  assert.equal(h.crew(['review', 'filter', t.id], wt).code, 0);
  const d = u.crewJson(['review', 'dismiss', t.id, 'f1', '--scope', 'always', '--reason', 'known pattern'], wt);
  assert.equal(d.code, 0, d.err);
  assert.equal(d.data.lesson.key, 'review-dismissed-correctness');
  assert.match(fs.readFileSync(LF(main), 'utf8'), /\[dismissal\] review-dismissed-correctness/);
  assert.doesNotMatch(fs.readFileSync(LF(wt), 'utf8'), /review-dismissed-correctness/);
});

// git refuses `worktree remove` on a locked worktree (no --force is ever passed), so the git-failed path is reached for real.
function withLock(wt, main, fn) {
  h.git(main, 'worktree', 'lock', wt);
  try { fn(); } finally { h.git(main, 'worktree', 'unlock', wt); }
}

test('git refuses to remove (locked worktree): exit 0, merged, worktree and branch stay, reason git-failed', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  withLock(wt, main, () => {
    const r = doMerge(task.id, main);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.task.state, 'merged');
    assert.equal(r.data.worktree.path, wt);
    assert.equal(r.data.worktree.removed, false);
    assert.equal(r.data.worktree.reason, 'git-failed');
    assert.ok(fs.existsSync(wt));
    assert.match(h.git(main, 'branch', '--list', 'feat/wt'), /feat\/wt/);
  });
  // the same again as text, on a second task (the first is merged already)
  const b = setup();
  mergeBranch(b.main);
  withLock(b.wt, b.main, () => {
    const t = h.crew(['task', 'merge', b.task.id], b.main);
    assert.equal(t.code, 0, t.err);
    const line = t.out.split('\n').find((l) => l.startsWith(`Worktree ${b.wt} stays: git could not remove it: `));
    assert.ok(line, t.out);
    assert.ok(line.length > `Worktree ${b.wt} stays: git could not remove it: `.length, 'the message is not empty');
    assert.ok(fs.existsSync(b.wt));
  });
});

test('git-failed message is one line', () => {
  const { main, wt, task } = setup();
  mergeBranch(main);
  withLock(wt, main, () => {
    const r = doMerge(task.id, main);
    assert.equal(r.data.worktree.reason, 'git-failed');
    assert.ok(r.data.worktree.message && !/[\r\n]/.test(r.data.worktree.message), String(r.data.worktree.message));
  });
});

test('untracked .crew/LESSONS.md and a locked worktree: the lesson is in the main checkout, the worktree stays', () => {
  const { main, wt, task } = setup({ keepLessonsOut: true });
  lessons.add(wt, null, { key: 'from-worker', text: 'written in the worktree', date: '2026-05-01' });
  mergeBranch(main);
  withLock(wt, main, () => {
    const r = doMerge(task.id, main);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.worktree.removed, false);
    assert.equal(r.data.worktree.reason, 'git-failed');
    assert.equal(r.data.worktree.adopted, 1);
    assert.match(fs.readFileSync(LF(main), 'utf8'), /^- 2026-05-01 \[correction\] from-worker: written in the worktree$/m);
    assert.ok(fs.existsSync(wt));
  });
});
