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
const read = (root) => fs.readFileSync(LF(root), 'utf8');

function pair() {
  const main = u.initRepo();
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = `${h.tmpDir('crew-lmc-')}${path.sep}wt`;
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/lmc');
  return { main, wt };
}

test('lesson add from a worktree lands in the main checkout, and list shows it from both places', () => {
  const { main, wt } = pair();
  const before = read(wt);
  const r = h.crew(['lesson', 'add', '--key', 'from-wt', '--text', 'written in a worktree', '--date', '2026-05-01'], wt);
  assert.equal(r.code, 0, r.err);
  assert.match(read(main), /^- 2026-05-01 \[correction\] from-wt: written in a worktree$/m);
  assert.equal(read(wt), before, 'the worktree file is untouched');
  for (const where of [wt, main]) {
    assert.deepEqual(u.crewJson(['lesson', 'list'], where).data.map((s) => s.key), ['from-wt']);
    assert.equal(u.crewJson(['lesson', 'find', 'worktree'], where).data.length, 1);
  }
});

test('adoptFrom adopts new lines in order, skips duplicates, is a no-op the second time and keeps the source byte-identical', () => {
  const { main, wt } = pair();
  lessons.add(main, null, { key: 'dup', text: 'already there', date: '2026-05-01' });
  lessons.add(wt, null, { key: 'dup', text: 'already there', date: '2026-05-01' });
  lessons.add(wt, null, { key: 'new-b', text: 'second', kind: 'send-back', date: '2026-05-02' });
  lessons.add(wt, null, { key: 'new-a', text: 'third', date: '2026-05-03' });
  const src = fs.readFileSync(LF(wt));
  assert.deepEqual(lessons.adoptFrom(wt, main), { adopted: 2, skipped: 1 });
  const keys = lessons.readEntries(main).map((e) => e.key);
  assert.deepEqual(keys.slice(-3), ['dup', 'new-b', 'new-a']);
  assert.equal(keys.filter((k) => k === 'dup').length, 1);
  const after = fs.readFileSync(LF(main));
  assert.deepEqual(lessons.adoptFrom(wt, main), { adopted: 0, skipped: 3 });
  assert.ok(fs.readFileSync(LF(main)).equals(after));
  assert.ok(fs.readFileSync(LF(wt)).equals(src));
});

test('adoptFrom: a missing file or the same folder does nothing', () => {
  const { main } = pair();
  const empty = h.tmpDir('crew-lmc-');
  const before = fs.readFileSync(LF(main));
  assert.deepEqual(lessons.adoptFrom(empty, main), { adopted: 0, skipped: 0 });
  assert.deepEqual(lessons.adoptFrom(main, main), { adopted: 0, skipped: 0 });
  assert.ok(fs.readFileSync(LF(main)).equals(before));
});
