'use strict';

// When a review round was finalized, for "sent back after the round" (crew task accept and crew release record):
// the moment is the review.finalized event that `crew review finalize` writes, judged by its place in the event log,
// not by the round file's modification time. On Linux a file time comes from a coarser clock than Date.now() and can be
// a few milliseconds behind an event written just before the file, which made a round finalized after the return look
// older than the return. The file time stays only for rounds written before the event existed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const release = require('../lib/features/release');
const events = require('../lib/core/events');
const project = require('../lib/core/project');
const paths = require('../lib/core/paths');

const run = (repo, ...args) => h.crew(args, repo);
const iso = (ms) => new Date(ms).toISOString();
const ev = (ms, type, data = {}) => ({ v: 1, ts: iso(ms), id: `${type}${ms}`, type, src: 'cli', session: null, task: 't-1', agent: null, data });

// A task folder with findings/1.json whose modification time is `mtimeMs`.
function roundAt(mtimeMs) {
  const dir = h.tmpDir('crew-round-');
  const f = path.join(dir, 'findings', '1.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '[]');
  fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return dir;
}

test('returnedAfterRound: a recorded finalize after the return wins over a round file time a few ms before the return', () => {
  const T = Date.parse('2026-11-19T10:00:00.123Z');
  const dir = roundAt(T - 5);   // the coarse file clock: the file looks 5 ms older than the return that preceded it
  const evs = [ev(T, 'task.returned'), ev(T + 1, 'review.finalized', { round: 1 })];
  assert.equal(release.returnedAfterRound(dir, 1, evs), false, 'finalized after the return: not sent back after the round');
  // same millisecond, or a recorded time behind the return: the order in the log decides
  assert.equal(release.returnedAfterRound(dir, 1, [ev(T, 'task.returned'), ev(T, 'review.finalized', { round: 1 })]), false);
  assert.equal(release.returnedAfterRound(dir, 1, [ev(T, 'task.returned'), ev(T - 3, 'review.finalized', { round: 1 })]), false);
  // a return after the recorded finalize still counts, whatever the file time says
  const late = roundAt(T + 60000);
  assert.equal(release.returnedAfterRound(late, 1, [ev(T - 1, 'review.finalized', { round: 1 }), ev(T, 'task.returned')]), true);
  // the finalize of another round says nothing about round 1
  assert.equal(release.returnedAfterRound(dir, 1, [ev(T, 'task.returned'), ev(T + 1, 'review.finalized', { round: 2 })]), true);
  // the last finalize of the round counts (finalized again after a later return)
  assert.equal(release.returnedAfterRound(dir, 1, [
    ev(T, 'review.finalized', { round: 1 }), ev(T + 1, 'task.returned'), ev(T + 2, 'review.finalized', { round: 1 }),
  ]), false);
});

test('returnedAfterRound: rounds from an older version (no review.finalized) are judged as before', () => {
  const T = Date.parse('2026-11-19T10:00:00.000Z');
  // the "review round N" task.reviewed event of older versions
  const dir = roundAt(T - 60000);
  assert.equal(release.returnedAfterRound(dir, 1, [ev(T, 'task.returned'), ev(T + 1, 'task.reviewed', { note: 'review round 1' })]), false);
  assert.equal(release.returnedAfterRound(dir, 1, [ev(T, 'task.reviewed', { note: 'review round 1' }), ev(T + 1, 'task.returned')]), true);
  // no event at all: the file's modification time
  assert.equal(release.returnedAfterRound(roundAt(T + 1000), 1, [ev(T, 'task.returned')]), false);
  assert.equal(release.returnedAfterRound(roundAt(T - 1000), 1, [ev(T, 'task.returned')]), true);
  // no file either: never crashes, a return counts as after
  assert.equal(release.returnedAfterRound(h.tmpDir('crew-none-'), 1, [ev(T, 'task.returned')]), true);
  assert.equal(release.returnedAfterRound(h.tmpDir('crew-none-'), 1, []), false);
});

// One round through the real commands. -> round number
function finalizeRound(repo, id) {
  const r = run(repo, 'review', 'run', id);
  assert.equal(r.code, 0, r.err);
  const round = Number(/round (\d+)/.exec(r.out)[1]);
  assert.equal(u.crewIn(['review', 'submit', id, '--round', String(round)], repo, '[]').code, 0);
  assert.equal(run(repo, 'review', 'filter', id).code, 0);
  assert.equal(run(repo, 'review', 'finalize', id).code, 0);
  return round;
}

test('crew task accept: a round finalized after the return is accepted even when its file time is before the return', { skip: !h.hasGit() }, () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report).code, 0);
  finalizeRound(repo, t.id);   // round 1 moves the task to reviewing
  const r2 = finalizeRound(repo, t.id);   // round 2 while reviewing: no state change
  assert.equal(r2, 2);
  const pid = project.findByCwd(repo).id;
  const mine = events.read(pid).filter((e) => e.task === t.id);
  const returned = mine.filter((e) => e.type === 'task.returned').pop();
  // the file clock behind the event clock, as on Linux
  const f = path.join(paths.taskDir(pid, t.id), 'findings', '2.json');
  const at = new Date(Date.parse(returned.ts) - 5);
  fs.utimesSync(f, at, at);
  const acc = u.crewJson(['--lang', 'en', 'task', 'accept', t.id], repo);
  assert.equal(acc.code, 0, acc.err);
  assert.equal(acc.data.review_gap, null);
  assert.deepEqual(events.read(pid).filter((e) => e.task === t.id).filter((e) => e.type === 'review.finalized').map((e) => e.data.round), [1, 2], 'finalize records each round');
});
