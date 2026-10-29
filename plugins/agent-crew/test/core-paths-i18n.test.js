'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const HOME = h.setupHome();
const paths = require('../lib/core/paths');
const i18n = require('../lib/core/i18n');
const args = require('../lib/core/args');
const { CrewError, UsageError } = require('../lib/core/errors');

test('home follows AGENT_CREW_HOME and derives all locations', () => {
  assert.equal(paths.home(), path.resolve(HOME));
  const id = 'p0123456789';
  assert.equal(paths.configFile(), path.join(HOME, 'config.json'));
  assert.equal(paths.projectsFile(), path.join(HOME, 'projects.json'));
  assert.equal(paths.projectDir(id), path.join(HOME, 'projects', id));
  assert.equal(paths.dataFile(id, 'needs'), path.join(HOME, 'projects', id, 'needs.json'));
  assert.equal(paths.eventsFile(id), path.join(HOME, 'projects', id, 'events.jsonl'));
  assert.equal(paths.taskDir(id, 't-20260101-ab12'), path.join(HOME, 'projects', id, 'tasks', 't-20260101-ab12'));
  assert.equal(paths.handoffDir(id, 'open'), path.join(HOME, 'projects', id, 'handoffs', 'open'));
  assert.equal(paths.handoffFile(id, 'accepted', 'h-1'), path.join(HOME, 'projects', id, 'handoffs', 'accepted', 'h-1.json'));
  assert.equal(paths.projectConfigFile(path.join('r', 'x')), path.join('r', 'x', '.claude', 'crew.json'));
});

test('ids are validated so they cannot escape the data folder', () => {
  assert.throws(() => paths.projectDir('../x'), CrewError);
  assert.throws(() => paths.projectDir('pXYZ'), CrewError);
  assert.throws(() => paths.dataFile('p0123456789', 'agents'), CrewError);
  assert.throws(() => paths.taskDir('p0123456789', '../../x'), CrewError);
  assert.throws(() => paths.handoffDir('p0123456789', 'weird'), CrewError);
  assert.throws(() => paths.handoffFile('p0123456789', 'open', '../x'), CrewError);
});

test('default home is under the user home directory', () => {
  const saved = process.env.AGENT_CREW_HOME;
  delete process.env.AGENT_CREW_HOME;
  assert.equal(path.basename(paths.home()), '.agent-crew');
  process.env.AGENT_CREW_HOME = saved;
});

test('i18n: both languages, placeholders, fallback to en then key', () => {
  assert.equal(i18n.t('en', 'need.added', { id: 3 }), 'Need #3 added');
  assert.equal(i18n.t('zh-TW', 'need.added', { id: 3 }), '等你確認 #3 已新增');
  assert.equal(i18n.t('zh-tw', 'log.added'), '日誌已新增');
  assert.equal(i18n.t('fr', 'log.added'), 'Log entry added');
  assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key');
  assert.equal(i18n.t('en', 'need.added', {}), 'Need #{id} added');
});

test('i18n: every en key exists in zh-TW and vice versa', () => {
  const dir = path.join(__dirname, '..', 'lib', 'i18n');
  const keys = (n) => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort();
  assert.deepEqual(keys('core.en.json'), keys('core.zh-TW.json'));
});

test('i18n merges every module file in lib/i18n', () => {
  const dir = path.join(__dirname, '..', 'lib', 'i18n');
  const f = path.join(dir, 'zz-test.en.json');
  fs.writeFileSync(f, JSON.stringify({ 'zz.hello': 'hi {who}' }));
  try {
    i18n.reload();
    assert.equal(i18n.t('en', 'zz.hello', { who: 'you' }), 'hi you');
    assert.equal(i18n.t('zh-TW', 'zz.hello', { who: 'you' }), 'hi you'); // falls back to en
  } finally {
    fs.unlinkSync(f);
    i18n.reload();
  }
});

test('CrewError carries key and English message; UsageError is a CrewError', () => {
  const e = new CrewError('task.notFound', { id: 't-1' });
  assert.equal(e.message, 'Task not found: t-1');
  assert.equal(e.key, 'task.notFound');
  assert.ok(new UsageError('args.missing', { name: 'x' }) instanceof CrewError);
});

test('args: positionals, options, ints, flags, multi, rest and errors', () => {
  const spec = {
    positionals: [{ name: 'a' }, { name: 'b', optional: true, int: true }],
    options: {
      '--n': { dest: 'n', int: true, default: 20 }, '--f': { dest: 'f', flag: true },
      '--c': { dest: 'c', choices: ['x', 'y'] }, '--m': { dest: 'm', multi: true },
    },
  };
  assert.deepEqual(args.parse(['v'], spec), { n: 20, a: 'v' });
  assert.deepEqual(args.parse(['v', '5', '--n=7', '--f', '--c', 'x'], spec), { n: 7, a: 'v', b: 5, f: true, c: 'x' });
  assert.deepEqual(args.parse(['--m', '1', '--m', '2', 'v'], spec).m, ['1', '2']);
  assert.equal(args.parse(['--', '-5x'], spec).a, '-5x');
  assert.equal(args.parse(['-3'], { positionals: [{ name: 'a', int: true }] }).a, -3);
  assert.deepEqual(args.parse(['a', 'b', 'c'], { positionals: [{ name: 'a' }], rest: 'more' }).more, ['b', 'c']);
  for (const bad of [[], ['v', '--zzz'], ['v', '--n'], ['v', '--n', 'x'], ['v', '--c', 'q'], ['v', '1', 'extra'], ['v', '--f=1']]) {
    assert.throws(() => args.parse(bad, spec), UsageError, bad.join(' '));
  }
  assert.throws(() => args.parse(['--__proto__', 'x'], spec), UsageError);
});

test('runtimeDir and sessionsDir sit under the data root', () => {
  const p = require('../lib/core/paths');
  const id = `p${'a'.repeat(10)}`;
  assert.equal(p.runtimeDir(id), require('node:path').join(p.projectDir(id), 'runtime'));
  assert.equal(p.sessionsDir(), require('node:path').join(p.home(), 'sessions'));
  assert.throws(() => p.runtimeDir('bad'), (e) => e.key === 'paths.badProjectId');
});
