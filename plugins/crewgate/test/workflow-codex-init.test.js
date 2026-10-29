'use strict';

// `crew init --engine codex`: .codex/agents/*.toml and the AGENTS.md block, idempotent and non-destructive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');
const { BEGIN, END } = require('../lib/features/codexinit');

h.setupHome();

const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

test('init --engine codex renders reviewer/refuter agents and a new AGENTS.md; no worker agent', () => {
  const repo = h.makeRepo();
  const r = u.crewJson(['init', '--engine', 'codex'], repo);
  assert.equal(r.code, 0, r.err);
  const by = Object.fromEntries(r.data.files.map((f) => [f.file, f.action]));
  assert.equal(by['.codex/agents/crew-reviewer.toml'], 'created');
  assert.equal(by['.codex/agents/crew-refuter.toml'], 'created');
  assert.equal(by['AGENTS.md'], 'created');
  assert.ok(!fs.existsSync(path.join(repo, '.codex', 'agents', 'crew-worker.toml')));
  const toml = read(repo, '.codex/agents/crew-reviewer.toml');
  assert.match(toml, /^name = "crew-reviewer"$/m);
  assert.match(toml, /^description = ".*[Rr]ead-only code reviewer/m);
  assert.match(toml, /^developer_instructions = """\n/m);
  assert.ok(toml.includes('You are a crew reviewer'));
  assert.ok(!/^model\s*=/m.test(toml), 'no Claude model name in a Codex agent');
  const md = read(repo, 'AGENTS.md');
  assert.ok(md.includes(BEGIN) && md.includes(END));
  assert.ok(md.includes('crew task run'));
});

test('init --engine codex is idempotent and keeps existing AGENTS.md content', () => {
  const repo = h.makeRepo();
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# My rules\n\nBe nice.\n');
  assert.equal(u.crewJson(['init', '--engine', 'codex'], repo).code, 0);
  const once = read(repo, 'AGENTS.md');
  assert.ok(once.startsWith('# My rules\n\nBe nice.\n'));
  assert.equal(once.split(BEGIN).length, 2);
  const r = u.crewJson(['init', '--engine', 'codex'], repo);
  assert.equal(read(repo, 'AGENTS.md'), once, 'second run changes nothing');
  const by = Object.fromEntries(r.data.files.map((f) => [f.file, f.action]));
  assert.equal(by['AGENTS.md'], 'kept');
  assert.equal(by['.codex/agents/crew-reviewer.toml'], 'kept');
  // a hand edit inside the markers is refreshed, text outside stays
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), once.replace('## crewgate', '## edited') + '\nTail.\n');
  u.crewJson(['init', '--engine', 'codex'], repo);
  const after = read(repo, 'AGENTS.md');
  assert.ok(after.includes('## crewgate') && !after.includes('## edited'));
  assert.ok(after.includes('Tail.') && after.startsWith('# My rules'));
});

test('init --force backs up an edited codex agent; without the flag it is kept; claude-only by default', () => {
  const repo = h.makeRepo();
  assert.equal(u.crewJson(['init'], repo).code, 0);
  assert.ok(!fs.existsSync(path.join(repo, '.codex')) && !fs.existsSync(path.join(repo, 'AGENTS.md')), 'nothing for Codex unless asked');
  u.crewJson(['init', '--engine', 'codex'], repo);
  const f = path.join(repo, '.codex', 'agents', 'crew-refuter.toml');
  fs.writeFileSync(f, 'name = "mine"\n');
  u.crewJson(['init', '--engine', 'codex'], repo);
  assert.equal(fs.readFileSync(f, 'utf8'), 'name = "mine"\n');
  const r = u.crewJson(['init', '--engine', 'codex', '--force'], repo);
  assert.match(fs.readFileSync(f, 'utf8'), /name = "crew-refuter"/);
  assert.ok(r.data.files.some((x) => x.backup && x.backup.startsWith('.codex/agents/crew-refuter.toml.bak-')));
  // an existing .codex folder is detected on a later plain init
  const repo2 = h.makeRepo();
  fs.mkdirSync(path.join(repo2, '.codex'));
  const d = u.crewJson(['init'], repo2);
  assert.ok(d.data.files.some((x) => x.file === 'AGENTS.md'));
});
