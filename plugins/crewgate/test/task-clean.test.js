'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const worktrees = require('../lib/features/worktrees');
const taskCmd = require('../lib/commands/task');

const OFF = (c) => { c.worktree = { remove_on_merge: false }; };
const clean = (cwd, ...more) => u.crewJson(['task', 'clean', ...more], cwd);

// A project (remove_on_merge off unless opts.on) and helpers to make tasks with a linked worktree on feat/<name>.
function project(opts = {}) {
  const main = u.initRepo();
  if (!opts.on) u.patchCfg(main, OFF);
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  return main;
}
function worker(main, name) {
  const wt = `${h.tmpDir('crew-clean-')}${path.sep}wt`;
  h.git(main, 'worktree', 'add', '-q', wt, '-b', `feat/${name}`);
  fs.writeFileSync(path.join(wt, `${name}.txt`), 'x\n');
  h.git(wt, 'add', `${name}.txt`);
  h.git(wt, 'commit', '-q', '-m', `work ${name}`);
  const task = u.createTask(main, { branch: `feat/${name}`, worktree: wt });
  return { wt, task };
}
function accepted(main, name) {
  const w = worker(main, name);
  assert.equal(h.crew(['task', 'report', w.task.id, '--report-file', u.reportFiles().report], w.wt).code, 0);
  assert.equal(h.crew(['task', 'accept', w.task.id, '--read-by-orchestrator', 'read the one-line change'], main).code, 0);
  return w;
}
// merged task: the branch is merged into main's HEAD unless opts.skipGit; the task is recorded as merged
function merged(main, name, opts = {}) {
  const w = accepted(main, name);
  if (!opts.skipGit) h.git(main, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, `feat/${name}`);
  const r = u.crewJson(['task', 'merge', w.task.id], main);
  assert.equal(r.code, 0, r.err);
  return w;
}
function cancelled(main, name) {
  const w = worker(main, name);
  assert.equal(h.crew(['task', 'cancel', w.task.id], main).code, 0);
  return w;
}
const row = (r, id) => r.data.worktrees.find((e) => e.task === id);
const lock = (main, wt) => h.git(main, 'worktree', 'lock', wt);
const unlock = (main, wt) => h.git(main, 'worktree', 'unlock', wt);

test('nothing to list: one line, exit 0, empty JSON', () => {
  const main = project();
  const t = h.crew(['task', 'clean'], main);
  assert.equal(t.code, 0, t.err);
  assert.equal(t.out.split('\n').length, 1, t.out);
  assert.match(t.out, /No worktrees of finished tasks/);
  const j = clean(main);
  assert.deepEqual(j.data, { worktrees: [], removed: 0, kept: 0, freed_bytes: 0 });
});

test('list without --apply changes nothing; --apply removes only the removable ones and keeps the branch', () => {
  const main = project();
  const A = merged(main, 'a');                          // merged, clean
  const B = merged(main, 'b');                          // merged, then changed
  fs.writeFileSync(path.join(B.wt, 'scratch.txt'), 'x\n');
  const C = merged(main, 'c', { skipGit: true });       // merged on record, branch not in HEAD
  const D = cancelled(main, 'd');                       // cancelled
  const E = merged(main, 'e');                          // folder gone
  h.git(main, 'worktree', 'remove', E.wt);
  const F = accepted(main, 'f');                        // accepted: not finished, not listed
  const before = u.crewJson(['task', 'list'], main).data;

  const r = clean(main);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.worktrees.map((e) => e.task).sort(), [A.task.id, B.task.id, C.task.id, D.task.id].sort());
  assert.ok(!row(r, E.task.id) && !row(r, F.task.id));
  const a = row(r, A.task.id);
  assert.equal(a.state, 'merged');
  assert.equal(a.path, A.wt);
  assert.equal(a.removable, true);
  assert.equal(a.size_partial, false);
  assert.ok(a.size_bytes > 0);
  assert.ok(!('reason' in a) && !('removed' in a));
  assert.equal(row(r, B.task.id).reason, 'dirty');
  assert.equal(row(r, C.task.id).reason, 'not-merged');
  assert.equal(row(r, D.task.id).reason, 'cancelled');
  assert.equal(row(r, D.task.id).removable, false);
  assert.equal(r.data.removed, 0);
  assert.equal(r.data.kept, 4);
  assert.equal(r.data.freed_bytes, 0);
  for (const w of [A, B, C, D, F]) assert.ok(fs.existsSync(w.wt));
  assert.deepEqual(u.crewJson(['task', 'list'], main).data, before, 'the task store did not change');

  const text = h.crew(['task', 'clean'], main);
  assert.equal(text.code, 0, text.err);
  const lines = text.out.split('\n');
  assert.ok(lines.some((l) => l.includes(A.task.id) && l.includes(A.wt) && l.includes('MB') && l.endsWith('can be removed')), text.out);
  assert.ok(lines.some((l) => l.includes(D.task.id) && l.includes(`git worktree remove "${D.wt}"`)), text.out);
  assert.ok(fs.existsSync(A.wt));

  const ap = clean(main, '--apply');
  assert.equal(ap.code, 0, ap.err);
  assert.equal(row(ap, A.task.id).removed, true);
  assert.ok(!('removed' in row(ap, B.task.id)));
  assert.equal(ap.data.removed, 1);
  assert.equal(ap.data.kept, 3);
  assert.equal(ap.data.freed_bytes, a.size_bytes);
  assert.ok(!fs.existsSync(A.wt));
  for (const w of [B, C, D, F]) assert.ok(fs.existsSync(w.wt));
  assert.match(h.git(main, 'branch', '--list', 'feat/a'), /feat\/a/);
  // the second run no longer lists the removed one and removes nothing more
  const again = h.crew(['task', 'clean', '--apply'], main);
  assert.equal(again.code, 0, again.err);
  assert.ok(!again.out.includes(A.task.id), again.out);
  assert.match(again.out.split('\n').pop(), /^removed 0, kept 3, freed about 0\.0 MB$/);
});

test('text --apply: a removed line and a summary line', () => {
  const main = project();
  const A = merged(main, 'a');
  const r = h.crew(['task', 'clean', '--apply'], main);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines[0].includes(A.task.id) && lines[0].endsWith('removed'), r.out);
  assert.match(lines[lines.length - 1], /^removed 1, kept 0, freed about \d+\.\d MB$/);
  assert.ok(!fs.existsSync(A.wt));
});

test('two removable and one locked: two removed, one git-failed, summary right, exit 0', () => {
  const main = project();
  const A = merged(main, 'a');
  const B = merged(main, 'b');
  const L = merged(main, 'l');
  lock(main, L.wt);
  try {
    const r = clean(main, '--apply');
    assert.equal(r.code, 0, r.err);
    assert.equal(row(r, A.task.id).removed, true);
    assert.equal(row(r, B.task.id).removed, true);
    const l = row(r, L.task.id);
    assert.equal(l.removed, false);
    assert.equal(l.reason, 'git-failed');
    assert.ok(l.message && !/[\r\n]/.test(l.message));
    assert.equal(r.data.removed, 2);
    assert.equal(r.data.kept, 1);
    assert.ok(r.data.freed_bytes > 0);
    assert.ok(!fs.existsSync(A.wt) && !fs.existsSync(B.wt) && fs.existsSync(L.wt));
    const text = h.crew(['task', 'clean', '--apply'], main);
    assert.equal(text.code, 0, text.err);
    assert.ok(text.out.split('\n').some((l) => l.includes(L.task.id) && l.includes('not removed: ')), text.out);
    assert.match(text.out.split('\n').pop(), /^removed 0, kept 1, freed about 0\.0 MB$/);
  } finally { unlock(main, L.wt); }
});

test('worktree.remove_on_merge off does not stop clean --apply', () => {
  const main = project();
  assert.equal(u.readCfg(main).worktree.remove_on_merge, false);
  const A = merged(main, 'a');
  assert.ok(fs.existsSync(A.wt), 'the merge kept it because the setting is off');
  const r = clean(main, '--apply');
  assert.equal(row(r, A.task.id).removed, true);
  assert.ok(!r.data.worktrees.some((e) => e.reason === 'setting-off'));
  assert.ok(!fs.existsSync(A.wt));
});

test('a merged worktree that only has the untracked .crew/LESSONS.md: adopted, then removed', () => {
  const main = project();
  h.git(main, 'rm', '-q', '--cached', '.crew/LESSONS.md');
  h.git(main, 'commit', '-q', '-m', 'untrack lessons');
  const A = merged(main, 'a');
  require('../lib/features/lessons').add(A.wt, null, { key: 'from-worker', text: 'written in the worktree', date: '2026-05-01' });
  const r = clean(main, '--apply');
  assert.equal(row(r, A.task.id).removed, true);
  assert.equal(row(r, A.task.id).adopted, 1);
  assert.match(fs.readFileSync(path.join(main, '.crew', 'LESSONS.md'), 'utf8'), /from-worker: written in the worktree/);
});

test('git status that cannot be read is status-failed (clean and merge), not dirty', () => {
  const main = project();
  const A = merged(main, 'a');
  const gitFile = path.join(A.wt, '.git');
  fs.renameSync(gitFile, `${gitFile}.away`);   // the folder is no longer a repository: git status fails
  try {
    const r = clean(main);
    assert.equal(row(r, A.task.id).reason, 'status-failed');
    assert.equal(row(r, A.task.id).removable, false);
    const t = h.crew(['task', 'clean'], main);
    assert.ok(t.out.includes('git status could not be read in it.'), t.out);
  } finally { fs.renameSync(`${gitFile}.away`, gitFile); }
  // the merge path: the same code and its own text line
  const on = project({ on: true });
  const M = accepted(on, 'm');
  h.git(on, 'merge', '-q', '--no-ff', '-m', 'merge m', 'feat/m');
  const mf = path.join(M.wt, '.git');
  fs.renameSync(mf, `${mf}.away`);
  try {
    const mr = u.crewJson(['task', 'merge', M.task.id], on);
    assert.equal(mr.code, 0, mr.err);
    assert.equal(mr.data.worktree.reason, 'status-failed');
    assert.ok(fs.existsSync(M.wt));
  } finally { fs.renameSync(`${mf}.away`, mf); }
});

test('status-failed text exists in both languages', () => {
  for (const l of ['en', 'zh-TW']) {
    const m = require(`../lib/i18n/workflow.${l}.json`);
    assert.ok(m['wf.task.wtWhy.status-failed'] && m['wf.task.wtWhy.cancelled'] && m['wf.task.cleanNone'], l);
  }
});

test('size walk: exact bytes, symlinks and junctions are not followed', () => {
  const dir = h.tmpDir('crew-size-');
  const big = h.tmpDir('crew-size-big-');
  fs.writeFileSync(path.join(big, 'big.bin'), Buffer.alloc(5000));
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(200));
  fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'c.bin'), Buffer.alloc(300));
  try { fs.symlinkSync(big, path.join(dir, 'link'), 'junction'); } catch { /* no link right here: the sum is still exact */ }
  const r = worktrees.dirSize(dir);
  assert.deepEqual(r, { bytes: 600, partial: false });
});

test('size walk: the limit stops it and the size is partial (injected clock)', () => {
  const dir = h.tmpDir('crew-size-');
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}`), Buffer.alloc(10));
  let t = 0;
  const slow = worktrees.dirSize(dir, { limitMs: 5, now: () => (t += 1) });
  assert.equal(slow.partial, true);
  assert.ok(slow.bytes < 200);
  const none = worktrees.dirSize(dir, { limitMs: 0 });
  assert.deepEqual(none, { bytes: 0, partial: true });
  t = 0;
  const fast = worktrees.dirSize(dir, { limitMs: 100000, now: () => (t += 1) });
  assert.deepEqual(fast, { bytes: 200, partial: false });
});

test('JSON entries carry exactly the documented fields', () => {
  const main = project();
  const A = merged(main, 'a');
  const D = cancelled(main, 'd');
  const r = clean(main);
  assert.deepEqual(Object.keys(r.data).sort(), ['freed_bytes', 'kept', 'removed', 'worktrees']);
  assert.deepEqual(Object.keys(row(r, A.task.id)).sort(), ['path', 'removable', 'size_bytes', 'size_partial', 'state', 'task']);
  assert.deepEqual(Object.keys(row(r, D.task.id)).sort(), ['path', 'reason', 'removable', 'size_bytes', 'size_partial', 'state', 'task']);
  const ap = clean(main, '--apply');
  assert.deepEqual(Object.keys(row(ap, A.task.id)).sort(), ['path', 'removable', 'removed', 'size_bytes', 'size_partial', 'state', 'task']);
});

test('help and usage list task clean in both languages; the merge line no longer says no git ran', () => {
  for (const l of ['en', 'zh-TW']) {
    assert.ok(taskCmd.usage[l].includes('crew task clean [--apply]'), l);
    const m = require(`../lib/i18n/workflow.${l}.json`);
    assert.ok(m['wf.task.usage'].includes('clean'), l);
    assert.ok(!/no git command|沒有執行任何 git/.test(m['wf.task.merged']), l);
  }
  const main = project();
  const t = h.crew(['task', 'help'], main);
  assert.ok(t.out.includes('crew task clean [--apply]'), t.out);
});
