'use strict';

// n32: session-start line for lessons ready, `crew lesson find`, the "make it a check" hint, pinned skill wording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');
const H = require('./hooks-helpers');

h.setupHome();
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\s+/g, ' ');
const add = (repo, key, date, text, kind) => h.crew(['lesson', 'add', '--key', key, '--text', text, '--date', date, ...(kind ? ['--kind', kind] : [])], repo);
const find = (repo, ...a) => u.crewJson(['lesson', 'find', ...a], repo);
const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const D = (n) => `2026-03-0${n}`;

test('find: words, case, CJK substrings, retired excluded, newest first, limit, no match', () => {
  const repo = u.initRepo();
  add(repo, 'old-one', D(1), 'Always run the Full test suite');
  add(repo, 'mid-one', D(2), 'Use 繁體中文 in commit bodies', 'correction');
  add(repo, 'new-one', D(3), 'full docs build before release', 'send-back');
  add(repo, 'gone', D(4), 'full retired thing');
  assert.equal(h.crew(['lesson', 'promote', 'gone', '--rule', 'r'], repo).code, 0);
  assert.equal(h.crew(['lesson', 'retire', 'gone'], repo).code, 0);
  let r = find(repo, 'FULL');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.data.map((x) => x.key), ['new-one', 'old-one']);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ['date', 'key', 'kind', 'text']);
  assert.equal(r.data[0].kind, 'send-back');
  assert.deepEqual(find(repo, '中文').data.map((x) => x.key), ['mid-one']);
  assert.equal(find(repo, 'full', '--limit', '1').data.length, 1);
  const none = h.crew(['lesson', 'find', 'nothingmatches'], repo);
  assert.equal(none.code, 0);
  assert.equal(none.out.trim(), '');
  const text = h.crew(['lesson', 'find', 'full'], repo).out.split('\n').filter(Boolean);
  assert.match(text[0], /^new-one {2}\[send-back\] {2}2026-03-03 {2}full docs build/);
  assert.equal(h.crew(['lesson', 'find'], repo).code, 2);
});

test('find: --paths matches a file named in the lesson text', () => {
  const repo = u.initRepo();
  add(repo, 'gates-touch', D(1), 'Never edit lib/core/gates.js from a worker');
  add(repo, 'readme-note', D(2), 'Keep README.md short');
  add(repo, 'plain', D(3), 'nothing about files');
  assert.deepEqual(find(repo, '--paths', 'lib/core/*.js').data.map((x) => x.key), ['gates-touch']);
  assert.deepEqual(find(repo, '--paths', '*.md').data.map((x) => x.key), ['readme-note']);
  assert.deepEqual(find(repo, '--paths', 'lib/**').data.map((x) => x.key), ['gates-touch']);
  assert.deepEqual(find(repo, '--paths', '*.md', '--paths', 'lib/core/gates.js').data.map((x) => x.key), ['readme-note', 'gates-touch']);
  assert.deepEqual(find(repo, '--paths', 'docs/*.txt').data, []);
});

test('suggest: mechanical candidates carry a hint, judgement ones do not', () => {
  const repo = u.initRepo();
  for (const d of [1, 2, 3]) {
    add(repo, 'mech', D(d), 'Do not call `fs.rmSync` on the project root');
    add(repo, 'judge', D(d), 'Explain the trade-off before choosing');
  }
  const r = u.crewJson(['lesson', 'suggest'], repo);
  const by = Object.fromEntries(r.data.map((x) => [x.key, x]));
  assert.equal(by.mech.check_hint, true);
  assert.ok(!('check_hint' in by.judge));
  const out = h.crew(['lesson', 'suggest'], repo).out;
  assert.equal((out.match(/automatic check/g) || []).length, 1);
  assert.ok(out.indexOf('automatic check') > out.indexOf('mech'));
  assert.ok(out.indexOf('automatic check') < out.indexOf('judge'));
});

test('SessionStart: one line with the count when lessons are ready, none otherwise, zh-TW too', () => {
  const f = H.fixture({});
  const start = () => ctxOf(H.runHook('session-start', H.base(f, { source: 'startup' }), { cwd: f.repo }));
  assert.ok(!/lesson/i.test(start().split('<crew-state')[1].replace('lessons.rules', '')), 'no line without candidates');
  for (const d of [1, 2, 3]) { add(f.repo, 'k-a', D(d), 'x'); add(f.repo, 'k-b', D(d), 'y'); }
  const text = start();
  const lines = text.split('\n').filter((l) => l.startsWith('lessons ready'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('2') && lines[0].includes('crew lesson suggest'));
  assert.ok(Buffer.byteLength(text) <= 4000);
  h.crew(['lesson', 'promote', 'k-a', '--rule', 'r'], f.repo);
  assert.ok(start().includes('lessons ready to show the user: 1'));
  const z = H.fixture({ config: { language: 'zh-TW' } });
  for (const d of [1, 2, 3]) add(z.repo, 'k-z', D(d), 'z');
  const zt = ctxOf(H.runHook('session-start', H.base(z, { source: 'startup' }), { cwd: z.repo }));
  assert.ok(zt.includes('可讓使用者看的經驗：1 筆'));
});

test('skills: pinned wording for the session-start line, find before briefs and plans, checks before rules', () => {
  const crew = read('skills', 'crew', 'SKILL.md');
  assert.ok(crew.includes('session-start state names lessons ready'));
  assert.ok(crew.includes('before you write a brief, run `crew lesson find'));
  assert.ok(crew.includes('offer an automatic check (a test, lint rule or hook) first'));
  assert.ok(crew.includes('Promote nothing without a clear yes'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'skills', 'crew', 'SKILL.md'), 'utf8').split('\n').length < 250);
  const plan = read('skills', 'plan', 'SKILL.md');
  assert.ok(plan.includes('run `crew lesson find <the goal\'s words>` before the first round'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'skills', 'plan', 'SKILL.md'), 'utf8').split('\n').length <= 133);
  assert.ok(read('skills', 'crew', 'references', 'commands.md').includes('`find <words...> [--paths <glob>...] [--limit N]`'));
});
