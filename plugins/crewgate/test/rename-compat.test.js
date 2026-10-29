'use strict';
// Backward compatibility with the pre-rename name (agent-crew): data folder, env var and rules markers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const lessons = require('../lib/features/lessons');

// Runs the CLI with a fake user home so the real ~/.agent-crew and ~/.crewgate are never touched.
function withFakeHome(mk, extra = {}) {
  const fake = h.tmpDir('crew-fakehome-');
  mk(fake);
  const cwd = h.tmpDir('crew-cwd-');
  const env = { CREWGATE_HOME: '', AGENT_CREW_HOME: '', HOME: fake, USERPROFILE: fake, ...extra };
  return { fake, run: (args) => h.crew(args, cwd, env) };
}

test('old ~/.agent-crew is used when ~/.crewgate is missing; CLI prints a one-time notice', () => {
  const t = withFakeHome((f) => fs.mkdirSync(path.join(f, '.agent-crew')));
  const first = t.run(['project', 'list']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /\.agent-crew/);
  assert.match(first.err, /\.crewgate/);
  const second = t.run(['project', 'list']);
  assert.equal(second.err, '', 'notice is shown once');
  assert.ok(!fs.existsSync(path.join(t.fake, '.crewgate')), 'new folder is not created');
});

test('~/.crewgate wins when both exist; no notice', () => {
  const t = withFakeHome((f) => { fs.mkdirSync(path.join(f, '.agent-crew')); fs.mkdirSync(path.join(f, '.crewgate')); });
  const r = t.run(['project', 'list']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
});

test('no notice when neither folder exists', () => {
  const t = withFakeHome(() => {});
  const r = t.run(['project', 'list']);
  assert.equal(r.err, '');
});

test('old AGENT_CREW_HOME is honoured as a fallback; CREWGATE_HOME takes precedence', () => {
  const old = h.tmpDir('crew-oldenv-');
  const nw = h.tmpDir('crew-newenv-');
  const cmd = "console.log(require(process.argv[1]).home())";
  const mod = path.join(__dirname, '..', 'lib', 'core', 'paths.js');
  const { spawnSync } = require('node:child_process');
  const get = (env) => spawnSync(process.execPath, ['-e', cmd, mod], { encoding: 'utf8', env: { ...process.env, CREWGATE_HOME: '', AGENT_CREW_HOME: '', ...env } }).stdout.trim();
  assert.equal(get({ AGENT_CREW_HOME: old }), path.resolve(old));
  assert.equal(get({ AGENT_CREW_HOME: old, CREWGATE_HOME: nw }), path.resolve(nw));
});

test('old agent-crew rules markers are read and rewritten to the new ones on promote and retire', () => {
  const repo = u.initRepo();
  const file = path.join(repo, 'CLAUDE.md');
  const run = (...a) => h.crew(a, repo);
  run('lesson', 'add', '--key', 'k1', '--text', 'x', '--date', '2026-03-01');
  run('lesson', 'add', '--key', 'k2', '--text', 'y', '--date', '2026-03-02');
  fs.writeFileSync(file, `# T\n${lessons.OLD_START}\n- Old rule. (source: old, 2026-01-01–2026-01-02)\n${lessons.OLD_END}\n`);
  assert.equal(lessons.readRules(repo, { lessons: {} }).length, 1, 'legacy block is read');
  assert.equal(run('lesson', 'promote', 'k1', '--rule', 'New rule.').code, 0);
  let text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(lessons.START) && text.includes(lessons.END));
  assert.ok(!text.includes(lessons.OLD_START) && !text.includes(lessons.OLD_END));
  assert.ok(text.includes('Old rule.') && text.includes('New rule.'));
  // retire path on a legacy block
  fs.writeFileSync(file, text.replace(lessons.START, lessons.OLD_START).replace(lessons.END, lessons.OLD_END));
  assert.equal(run('lesson', 'retire', 'k1').code, 0);
  text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(lessons.START) && !text.includes(lessons.OLD_START));
  assert.ok(!text.includes('New rule.'));
});
