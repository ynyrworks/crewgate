'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const lessons = require('../lib/features/lessons');

const run = (repo, ...args) => h.crew(args, repo);
const add = (repo, key, date, text = 'note', kind) => run(repo, 'lesson', 'add', '--key', key, '--text', text, '--date', date, ...(kind ? ['--kind', kind] : []));
const rulesFile = (repo) => path.join(repo, 'CLAUDE.md');

test('lesson add appends a formatted line, creates the file header and validates input', () => {
  const repo = u.initRepo();
  fs.rmSync(path.join(repo, '.crew', 'LESSONS.md'));
  const r = u.crewJson(['lesson', 'add', '--key', 'check-edge-cases', '--text', 'Workers\nforget edge cases', '--kind', 'send-back', '--date', '2026-03-01'], repo);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'utf8');
  assert.ok(text.startsWith('# Lessons'));
  assert.ok(text.includes('- 2026-03-01 [send-back] check-edge-cases: Workers forget edge cases\n'));
  assert.equal(run(repo, 'lesson', 'add', '--key', 'Bad Key', '--text', 'x').code, 1);
  assert.equal(run(repo, 'lesson', 'add', '--key', 'k', '--text', 'x', '--kind', 'weird').code, 2);
  assert.equal(run(repo, 'lesson', 'add', '--key', 'k').code, 2);
  assert.equal(run(repo, 'lesson', 'add', '--text', 'x').code, 2);
  assert.equal(run(repo, 'lesson', 'add', '--key', 'k', '--text', '   ').code, 1);
  assert.equal(run(repo, 'lesson', 'add', '--key', 'k', '--text', 'x', '--date', '2026-13-45').code, 2);
  const today = u.crewJson(['lesson', 'add', '--key', 'k2', '--text', 'secret token=abc123def'], repo);
  assert.match(today.data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!today.data.text.includes('abc123def'));
});

test('suggest counts distinct days, not entries', () => {
  const repo = u.initRepo();
  for (const d of ['2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01']) add(repo, 'same-day', d);
  add(repo, 'two-days', '2026-03-01');
  add(repo, 'two-days', '2026-03-02');
  add(repo, 'three-days', '2026-03-01');
  add(repo, 'three-days', '2026-03-05');
  add(repo, 'three-days', '2026-03-09', 'latest wording');
  const list = u.crewJson(['lesson', 'list'], repo).data;
  const by = Object.fromEntries(list.map((s) => [s.key, s]));
  assert.equal(by['same-day'].days, 1);
  assert.equal(by['same-day'].count, 4);
  assert.equal(by['three-days'].days, 3);
  assert.equal(by['three-days'].first, '2026-03-01');
  assert.equal(by['three-days'].last, '2026-03-09');
  const sug = u.crewJson(['lesson', 'suggest'], repo).data;
  assert.deepEqual(sug.map((s) => s.key), ['three-days']);
  assert.match(run(repo, 'lesson', 'suggest').out, /three-days.*latest wording/);
  u.patchCfg(repo, (c) => { c.lessons = { promote_after_days: 2 }; });
  assert.deepEqual(u.crewJson(['lesson', 'suggest'], repo).data.map((s) => s.key).sort(), ['three-days', 'two-days']);
});

test('promote creates the marked block (and the file) and writes the source dates', () => {
  const repo = u.initRepo();
  for (const d of ['2026-03-01', '2026-03-05', '2026-03-09']) add(repo, 'run-full-tests', d);
  assert.ok(!fs.existsSync(rulesFile(repo)));
  const r = u.crewJson(['lesson', 'promote', 'run-full-tests', '--rule', 'Always run the full test suite before reporting.'], repo);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(rulesFile(repo), 'utf8');
  assert.ok(text.includes(lessons.START) && text.includes(lessons.END));
  assert.ok(text.includes('- Always run the full test suite before reporting. (source: run-full-tests, 2026-03-01–2026-03-09)'));
  assert.equal(u.crewJson(['lesson', 'suggest'], repo).data.length, 0, 'promoted keys are no longer suggested');
  assert.match(run(repo, 'lesson', 'list').out, /\[promoted\]/);
  assert.equal(run(repo, 'lesson', 'promote', 'run-full-tests', '--rule', 'again').code, 1);
  assert.equal(run(repo, 'lesson', 'promote', 'unknown-key', '--rule', 'x').code, 1);
  assert.equal(run(repo, 'lesson', 'promote', 'run-full-tests').code, 2);
});

test('promote and retire only touch text between the markers', () => {
  const repo = u.initRepo();
  add(repo, 'a-rule', '2026-03-01');
  add(repo, 'b-rule', '2026-03-02');
  const before = '# Project\n\nSome prose that must stay.\n\n';
  const after = '\n## Later section\n\nMore prose.\n';
  fs.writeFileSync(rulesFile(repo), `${before}${lessons.START}\n${lessons.END}\n${after}`);
  assert.equal(run(repo, 'lesson', 'promote', 'a-rule', '--rule', 'Rule A.').code, 0);
  assert.equal(run(repo, 'lesson', 'promote', 'b-rule', '--rule', 'Rule B.').code, 0);
  let text = fs.readFileSync(rulesFile(repo), 'utf8');
  assert.ok(text.startsWith(`${before}${lessons.START}\n`));
  assert.ok(text.endsWith(`${lessons.END}\n${after}`));
  assert.equal((text.match(/\(source:/g) || []).length, 2);
  assert.equal(run(repo, 'lesson', 'retire', 'a-rule').code, 0);
  text = fs.readFileSync(rulesFile(repo), 'utf8');
  assert.ok(text.startsWith(before) && text.endsWith(after));
  assert.ok(!text.includes('Rule A.') && text.includes('Rule B.'));
  assert.equal(run(repo, 'lesson', 'retire', 'a-rule').code, 1, 'no longer a rule');
  assert.match(fs.readFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'utf8'), /\[retired\] a-rule/);
  assert.match(run(repo, 'lesson', 'list').out, /a-rule.*\[retired\]/);
});

test('a retired lesson is not suggested again until it recurs', () => {
  const repo = u.initRepo();
  for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) add(repo, 'flaky', d);
  run(repo, 'lesson', 'promote', 'flaky', '--rule', 'Rule.');
  run(repo, 'lesson', 'retire', 'flaky');
  assert.equal(u.crewJson(['lesson', 'suggest'], repo).data.length, 0);
  // a lesson dated after today's retirement would be needed to revive it
  add(repo, 'flaky', '2999-01-01');
  assert.equal(u.crewJson(['lesson', 'suggest'], repo).data.length, 1);
});

test('rules cap: the command refuses and names the oldest rule', () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.lessons = { rules_cap: 2 }; });
  add(repo, 'old-one', '2026-01-01');
  add(repo, 'old-one', '2026-01-02');
  add(repo, 'newer', '2026-05-01');
  add(repo, 'newest', '2026-06-01');
  assert.equal(run(repo, 'lesson', 'promote', 'old-one', '--rule', 'First rule.').code, 0);
  assert.equal(run(repo, 'lesson', 'promote', 'newer', '--rule', 'Second rule.').code, 0);
  const before = fs.readFileSync(rulesFile(repo), 'utf8');
  const r = run(repo, 'lesson', 'promote', 'newest', '--rule', 'Third rule.');
  assert.equal(r.code, 1);
  assert.match(r.err, /already holds 2 rules/);
  assert.match(r.err, /Oldest\/least-cited: old-one/);
  assert.match(r.err, /crew lesson retire old-one/);
  assert.equal(fs.readFileSync(rulesFile(repo), 'utf8'), before, 'nothing was written');
  assert.equal(run(repo, 'lesson', 'retire', 'old-one').code, 0);
  assert.equal(run(repo, 'lesson', 'promote', 'newest', '--rule', 'Third rule.').code, 0);
});

test('rules file other than CLAUDE.md and broken markers', () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.lessons = { rules_file: 'docs/RULES.md' }; });
  fs.mkdirSync(path.join(repo, 'docs'));
  add(repo, 'k', '2026-03-01');
  assert.equal(run(repo, 'lesson', 'promote', 'k', '--rule', 'R.').code, 0);
  assert.ok(fs.readFileSync(path.join(repo, 'docs', 'RULES.md'), 'utf8').includes('R.'));
  assert.ok(!fs.existsSync(rulesFile(repo)));
  add(repo, 'm', '2026-03-02');
  fs.writeFileSync(path.join(repo, 'docs', 'RULES.md'), `text\n${lessons.START}\nno end marker\n`);
  const bad = run(repo, 'lesson', 'promote', 'm', '--rule', 'R2.');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /marker/);
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'RULES.md'), 'utf8'), `text\n${lessons.START}\nno end marker\n`);
});

test('CRLF rules files keep their line endings', () => {
  const repo = u.initRepo();
  add(repo, 'k', '2026-03-01');
  fs.writeFileSync(rulesFile(repo), `# T\r\n${lessons.START}\r\n${lessons.END}\r\n`);
  run(repo, 'lesson', 'promote', 'k', '--rule', 'R.');
  const text = fs.readFileSync(rulesFile(repo), 'utf8');
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
  assert.ok(text.includes('- R. (source: k,'));
});

test('lesson list is empty-safe and survives hand-edited lines', () => {
  const repo = u.initRepo();
  assert.match(run(repo, 'lesson', 'list').out, /No lessons/);
  fs.appendFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'free text the user wrote\n- not a lesson line\n');
  add(repo, 'k', '2026-03-01');
  assert.equal(u.crewJson(['lesson', 'list'], repo).data.length, 1);
  assert.match(run(repo, 'lesson', 'suggest').out, /No lesson is ready/);
  assert.equal(run(repo, 'lesson', 'bogus').code, 2);
});
