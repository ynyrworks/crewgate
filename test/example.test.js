'use strict';

// The fictional example project must stay valid: its own tests pass, its config validates,
// its sample brief is accepted and its lessons show one promotion candidate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EX = path.join(__dirname, '..', 'examples', 'todo-cli');
const PLUGIN = path.join(__dirname, '..', 'plugins', 'agent-crew');
const config = require(path.join(PLUGIN, 'lib', 'core', 'config'));
const tasks = require(path.join(PLUGIN, 'lib', 'core', 'tasks'));
const rv = require(path.join(PLUGIN, 'lib', 'features', 'review'));

test('the example app passes its own tests', () => {
  const r = spawnSync(process.execPath, ['--test'], { cwd: EX, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('example crew.json is valid and says what the walkthrough says', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, '.claude', 'crew.json'), 'utf8'));
  assert.deepEqual(config.validate(cfg), []);
  assert.equal(cfg.language, 'en');
  assert.deepEqual(cfg.checks, ['node --test']);
  assert.equal(cfg.limits.orchestrator_edit, 'warn');
  assert.ok(cfg.forbidden.paths.length + cfg.forbidden.actions.length >= 2);
});

test('example agents are rendered and carry the project rules', () => {
  for (const n of ['crew-worker', 'crew-reviewer', 'crew-refuter']) {
    const text = fs.readFileSync(path.join(EX, '.claude', 'agents', `${n}.md`), 'utf8');
    assert.match(text, new RegExp(`^---\nname: ${n}\n`));
    assert.ok(!/\{\{\w+\}\}/.test(text), 'no unfilled placeholder');
  }
  assert.match(fs.readFileSync(path.join(EX, '.claude', 'agents', 'crew-worker.md'), 'utf8'), /## Project rules \(todo-cli\)/);
});

test('example brief has all five sections; REVIEW.md has two project rules; one lesson is a candidate', () => {
  assert.equal(tasks.validateBrief(fs.readFileSync(path.join(EX, 'briefs', 'add-due-dates.md'), 'utf8')).ok, true);
  const review = fs.readFileSync(path.join(EX, '.crew', 'REVIEW.md'), 'utf8');
  const rules = review.split('## Project-specific rules')[1].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(rules.length, 2);
  const lines = fs.readFileSync(path.join(EX, '.crew', 'LESSONS.md'), 'utf8').split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} \[/.test(l));
  assert.equal(lines.length, 5);
  const days = {};
  for (const l of lines) { const m = /^- (\S+) \[[\w-]+\] ([^:]+):/.exec(l); (days[m[2]] = days[m[2]] || new Set()).add(m[1]); }
  const candidates = Object.entries(days).filter(([, d]) => d.size >= 3).map(([k]) => k);
  assert.deepEqual(candidates, ['old-format-files']);
  assert.equal(rv.readLedger(EX).length, 1);
});
