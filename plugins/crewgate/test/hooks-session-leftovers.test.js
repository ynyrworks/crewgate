'use strict';

// SessionStart brief: leftover worktrees of finished tasks, accepted tasks whose branch is already merged, lessons from the main checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const H = require('./hooks-helpers');

const tasks = require('../lib/core/tasks');
const lessons = require('../lib/features/lessons');
const ss = require('../lib/hooks/session-start');
const C = require('../lib/hooks/common');

const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const start = (f, cwd) => ctxOf(H.runHook('session-start', { session_id: f.sid, cwd: cwd || f.repo, source: 'startup' }, { cwd: cwd || f.repo }));
const leftLine = (t) => t.split('\n').find((l) => l.startsWith('finished tasks with a worktree')) || '';
const mergedLine = (t) => t.split('\n').find((l) => l.startsWith('accepted tasks whose branch')) || '';

const open = (f) => { H.start(f); return C.open({ session_id: f.sid, cwd: f.repo, source: 'startup' }, { full: true }); };

// a task in `state` with optional branch / worktree
function mk(f, state, fields = {}) {
  const t = tasks.createTask(f.pid, { title: `t ${state}`, brief: h.GOOD_BRIEF, ...fields });
  const path_ = { created: [], cancelled: ['cancelled'], accepted: ['dispatched', 'returned', 'accepted'], merged: ['dispatched', 'returned', 'accepted', 'merged'] }[state];
  for (const s of path_) tasks.transition(f.pid, t.id, s);
  return t;
}
const wtDir = (name) => { const d = h.tmpDir(`crew-wtdir-${name}-`); return d; };

test('leftover worktrees: merged and cancelled tasks with an existing folder are counted; no folder or no value, no count', () => {
  const f = H.fixture();
  const a = wtDir('a'); const b = wtDir('b'); const gone = wtDir('c');
  mk(f, 'merged', { worktree: a });
  mk(f, 'cancelled', { worktree: b });
  mk(f, 'merged', { worktree: gone });
  mk(f, 'merged');
  mk(f, 'created', { worktree: wtDir('open') });
  fs.rmSync(gone, { recursive: true, force: true });
  const text = start(f);
  const l = leftLine(text);
  assert.ok(l.includes(': 2;') && l.includes('crew task clean'), l);
  assert.ok(l.length < 160);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
  assert.equal(leftLine(start(f)), '');
});

test('leftover worktrees: a relative value is resolved against the project path', () => {
  const f = H.fixture();
  fs.mkdirSync(path.join(f.repo, 'wt-rel'));
  mk(f, 'merged', { worktree: 'wt-rel' });
  assert.ok(leftLine(start(f)).includes(': 1;'));
});

test('accepted but merged: the merged branch is named, the unmerged one is not', () => {
  const f = H.fixture();
  h.git(f.repo, 'branch', 'feat/done');
  h.git(f.repo, 'checkout', '-q', '-b', 'feat/open');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b\n');
  h.git(f.repo, 'add', '.');
  h.git(f.repo, 'commit', '-q', '-m', 'open work');
  h.git(f.repo, 'checkout', '-q', '-');
  const done = mk(f, 'accepted', { branch: 'feat/done' });
  const open = mk(f, 'accepted', { branch: 'feat/open' });
  const text = start(f);
  const l = mergedLine(text);
  assert.ok(l.includes(done.id) && !l.includes(open.id), l);
  assert.ok(l.includes('1 (') && l.includes('crew task merge <id>') && l.length < 160, l);
});

test('accepted but merged: up to three ids, then ", ..." and the count', () => {
  const f = H.fixture();
  const ids = [];
  for (let i = 0; i < 5; i++) { h.git(f.repo, 'branch', `feat/m${i}`); ids.push(mk(f, 'accepted', { branch: `feat/m${i}` }).id); }
  const l = mergedLine(start(f));
  assert.ok(l.includes(': 5 (') && l.includes(', ...)'), l);
  assert.equal(ids.filter((id) => l.includes(id)).length, 3);
});

test('accepted but merged: no accepted task with a branch means no git call; a failing or empty call means no line', () => {
  const f = H.fixture();
  mk(f, 'accepted');
  mk(f, 'created', { branch: 'feat/x' });
  let calls = 0;
  const hh = open(f);
  ss.brief(hh, 'startup', () => { calls++; return ''; });
  assert.equal(calls, 0);
  mk(f, 'accepted', { branch: 'feat/x' });
  ss.brief(hh, 'startup', () => { calls++; throw new Error('git failed'); });
  assert.equal(calls, 1);
  assert.equal(mergedLine(ss.brief(hh, 'startup', () => { throw new Error('timeout'); })), '');
  assert.equal(mergedLine(ss.brief(hh, 'startup', () => '')), '');
  assert.ok(mergedLine(ss.brief(hh, 'startup', () => 'feat/x\n')) !== '');
});

test('git failing: the brief is the same as without the new lines', () => {
  const f = H.fixture();
  mk(f, 'accepted', { branch: 'feat/x' });
  const hh = open(f);
  const failing = ss.brief(hh, 'startup', () => { throw new Error('ENOENT'); });
  const none = ss.brief(hh, 'startup', () => '');
  assert.equal(failing, none);
  assert.ok(!failing.includes('crew task merge'));
});

test('a brief over MAX_BYTES drops the new lines first; the task lines stay', () => {
  const f = H.fixture();
  const gone = wtDir('x');
  mk(f, 'merged', { worktree: gone });
  h.git(f.repo, 'branch', 'feat/m');
  const acc = mk(f, 'accepted', { branch: 'feat/m' });
  const hh = open(f);
  const run = () => 'feat/m\n';
  const small = ss.brief(hh, 'startup', run);
  assert.ok(leftLine(small) && mergedLine(small));
  const orig = hh.t;
  const room = 4000 - Buffer.byteLength(small);
  // pad the rules line so the brief is only just too long with the new lines, but fits without them
  const extra = Buffer.byteLength(leftLine(small)) + Buffer.byteLength(mergedLine(small)) + 2;
  const pad = 'x'.repeat(room + extra - 1);
  hh.t = (k, v) => (k === 'brief.rules' ? `${orig.call(hh, k, v)} ${pad}` : orig.call(hh, k, v));
  const big = ss.brief(hh, 'startup', run);
  assert.ok(Buffer.byteLength(big) <= 4000);
  assert.ok(!leftLine(big) && !mergedLine(big));
  assert.ok(big.includes(acc.id));
});

test('lessons count: a session started in a worktree shows the count of the main checkout', () => {
  const f = H.fixture();
  const wt = `${h.tmpDir('crew-wtl-')}${path.sep}wt`;
  h.git(f.repo, 'worktree', 'add', '-q', wt, '-b', 'feat/l');
  const D = (d) => `2026-01-0${d}`;
  for (const d of [1, 2, 3]) lessons.add(f.repo, f.pid, { key: 'k-main', text: 'a lesson', date: D(d) });
  const inMain = start(f, f.repo);
  const inWt = start(f, wt);
  const l = (t) => t.split('\n').find((x) => x.startsWith('lessons ready')) || '';
  assert.ok(l(inMain).includes(': 1'), l(inMain));
  assert.equal(l(inWt), l(inMain));
});
