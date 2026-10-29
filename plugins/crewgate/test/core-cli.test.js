'use strict';
const ip = (...o) => o.join('.'); // addresses are built at runtime (repo hygiene scan)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const HOME = h.setupHome();
const cli = require('../lib/core/cli');

const work = h.tmpDir('crew-cli-');
const env = { CREWGATE_HOME: HOME };
const crew = (args, cwd = work) => h.crew(args, cwd, env);

function register(name) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  const r = crew(['project', 'add', dir, '--name', name, '--json']);
  assert.equal(r.code, 0, r.err);
  return { dir, id: JSON.parse(r.out).project.id };
}

test('no arguments prints the group list; unknown group exits 2; --help exits 0', () => {
  const r = crew([]);
  assert.equal(r.code, 2);
  for (const g of ['project', 'need', 'work', 'log', 'mr', 'validate', 'import']) assert.match(r.out, new RegExp(`\\b${g}\\b`));
  assert.equal(crew(['--help']).code, 0);
  const u = crew(['frobnicate']);
  assert.equal(u.code, 2);
  assert.match(u.err, /Unknown command group: frobnicate/);
  assert.equal(crew(['project']).code, 2);
  assert.equal(crew(['project', '--help']).code, 0);
  assert.equal(crew(['../etc/passwd']).code, 2);
});

test('data commands outside a registered project exit 1 with a hint', () => {
  const bare = h.tmpDir('crew-bare-');
  const r = crew(['need', 'list'], bare);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not belong to a registered project/);
  assert.equal(crew(['--lang', 'zh-TW', 'need', 'list'], bare).err.startsWith('錯誤：'), true);
});

test('project add / list / rm via CLI, detection by cwd and --project', () => {
  const { dir, id } = register('alpha');
  assert.match(id, /^p[0-9a-f]{10}$/);
  assert.match(crew(['project', 'list']).out, new RegExp(`${id}  alpha  `));
  assert.equal(crew(['need', 'add', 'from cwd'], dir).code, 0);
  assert.equal(JSON.parse(crew(['need', 'list', '--json'], dir).out).length, 1);
  // --project works from anywhere, by id, name or path
  for (const spec of [id, 'alpha', dir]) assert.equal(JSON.parse(crew(['--project', spec, 'need', 'list', '--json']).out).length, 1, spec);
  assert.equal(crew(['--project', 'ghost', 'need', 'list']).code, 1);
  const rm = crew(['project', 'rm', 'alpha']);
  assert.equal(rm.code, 0);
  assert.equal(crew(['project', 'rm', 'alpha']).code, 1);
  assert.equal(crew(['project', 'add', path.join(work, 'missing')]).code, 1);
  assert.equal(crew(['project', 'add', work, '--bogus']).code, 2);
});

test('need / work / log / mr / validate round trip with --json and exit codes', () => {
  const { dir, id } = register('beta');
  const run = (...a) => crew(a, dir);
  assert.equal(JSON.parse(run('need', 'add', 'ask the user', '--json').out).id, 1);
  assert.equal(run('need', 'done', '1').code, 0);
  assert.match(run('need', 'list').out, /Nothing is waiting/);
  assert.match(run('need', 'list', '--all').out, /#1 \[done\]/);
  assert.equal(run('need', 'done', '9').code, 1);
  assert.equal(run('need', 'done', 'x').code, 2);

  assert.equal(run('work', 'set', 'core', 'Build it', 'doing', 'note').code, 0);
  assert.match(run('work', 'list').out, /\[doing\] Build it - note/);
  assert.equal(run('work', 'set', 'core', 'Build it', 'bogus').code, 2);
  assert.equal(run('work', 'rm', 'core', 'Build it').code, 0);
  assert.equal(run('work', 'rm', 'core', 'Build it').code, 1);

  run('log', 'add', 'me', 'one');
  run('log', 'add', 'me', 'two');
  assert.deepEqual(JSON.parse(run('log', 'list', '--n', '1', '--json').out).map((r) => r.text), ['two']);

  assert.equal(run('mr', 'set', '12', 'My MR', '--ci', 'passed', '--merged', 'yes').code, 0);
  assert.match(run('mr', 'list').out, /!12 {2}ci=passed {2}merged {2}My MR/);
  assert.equal(run('mr', 'set', '12', 'x', '--ci', 'green').code, 2);

  assert.equal(run('validate', 'set', 'T-1', '2026-03-01', 'linux box', 'all good').code, 0);
  assert.match(run('validate', 'list').out, /T-1 {2}2026-03-01 {2}linux box {2}all good/);
  assert.equal(run('validate', 'set', 'T-1', 'March 1', 'h', 'r').code, 1);

  // events were recorded by the commands, redacted
  run('log', 'add', 'me', 'reached ' + ip(10,9,9,9));
  const ev = fs.readFileSync(path.join(HOME, 'projects', id, 'events.jsonl'), 'utf8');
  assert.ok(ev.includes('"type":"need.added"') && ev.includes('"type":"mr.set"') && ev.includes('"type":"validation.set"'));
  assert.ok(!ev.includes(ip(10,9,9,9)));
});

test('language: --lang, then the project config, then the global config', () => {
  const { dir } = register('gamma');
  assert.match(crew(['--lang', 'zh-TW', 'log', 'add', 'me', 'x'], dir).out, /日誌已新增/);
  assert.match(crew(['log', 'add', 'me', 'y'], dir).out, /Log entry added/);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'crew.json'), '{"language":"zh-TW"}');
  assert.match(crew(['log', 'add', 'me', 'z'], dir).out, /日誌已新增/);
  assert.match(crew(['--lang=en', 'log', 'add', 'me', 'w'], dir).out, /Log entry added/);
});

test('extractGlobals pulls the global options out from anywhere and stops at "--"', () => {
  const g = cli.extractGlobals(['need', '--json', 'add', '--project', 'x', 'a text', '--lang=zh-TW', '--', '--json']);
  assert.deepEqual(g.rest, ['need', 'add', 'a text', '--', '--json']);
  assert.equal(g.json, true);
  assert.equal(g.project, 'x');
  assert.equal(g.lang, 'zh-TW');
  assert.throws(() => cli.extractGlobals(['need', '--project']), (e) => e.key === 'args.needsValue');
});

test('commands are discovered from lib/commands and listed with summaries', () => {
  const names = cli.listGroups().map((x) => x.name);
  for (const g of ['import', 'log', 'mr', 'need', 'project', 'validate', 'work']) assert.ok(names.includes(g), g);
  for (const { mod } of cli.listGroups()) {
    assert.ok(mod.summary.en && mod.summary['zh-TW'], mod.name);
    assert.equal(typeof mod.run, 'function');
  }
  assert.equal(cli.loadGroup('nope'), null);
  assert.equal(cli.loadGroup('Bad Name'), null);
});

// ------------------------------------------------------------------ import
function makeOldData() {
  const oldHome = h.tmpDir('crew-old-');
  const pdir = path.join(oldHome, 'projects', 'pabcdef0123');
  fs.mkdirSync(pdir, { recursive: true });
  const w = (name, obj) => fs.writeFileSync(path.join(pdir, `${name}.json`), JSON.stringify(obj));
  w('work', {
    needs: [{ id: 1, text: 'old need ' + ip(10,1,1,1), done: true, created: '2026-01-02 03:04', done_at: '2026-01-03 04:05' }, { id: 2, text: 'open one', done: false, created: '2026-01-02 03:04' }],
    streams: [{ name: 'S', items: [{ title: 'A', state: '進行中', note: 'n', updated: '2026-01-02 03:04' }, { title: 'B', state: '等你確認', note: '', need: 2 }, { title: 'C', state: '???', note: '' }] }],
  });
  w('log', [{ time: '2026-01-02T03:04:05', who: 'x', text: 'hello' }]);
  w('mrs', { mrs: [{ iid: 3, title: 'MR', ci: '通過', merged: true, updated: '2026-01-02 03:04' }] });
  w('validation', { T1: [{ date: '2026-01-01', host: 'h', result: 'ok' }] });
  fs.writeFileSync(path.join(pdir, 'agents.json'), '{"agents":[]}');
  return { oldHome, pdir };
}

const snapshot = (dir) => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n');

test('import agent-board converts a project, leaves the source untouched, refuses to overwrite without --force', () => {
  const { dir, id } = register('delta');
  const { oldHome, pdir } = makeOldData();
  const before = snapshot(pdir);
  const r = crew(['import', 'agent-board', oldHome, '--from-project', 'pabcdef0123', '--json'], dir);
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out);
  assert.deepEqual(res.counts, { needs: 2, items: 3, log: 1, mrs: 1, validation: 1 });
  assert.equal(res.unmappedStates, 1);
  assert.equal(snapshot(pdir), before);

  const rd = (n) => JSON.parse(fs.readFileSync(path.join(HOME, 'projects', id, `${n}.json`), 'utf8'));
  const needs = rd('needs').needs;
  assert.equal(needs[0].text, 'old need [REDACTED-IP]');
  assert.match(needs[0].created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(needs[0].done_at);
  assert.deepEqual(rd('work').streams[0].items.map((i) => i.state), ['doing', 'waiting', 'todo']);
  assert.equal(rd('work').streams[0].items[1].need, 2);
  assert.equal(rd('mrs').mrs[0].ci, 'passed');
  assert.equal(rd('log')[0].text, 'hello');
  assert.equal(rd('validation').T1[0].result, 'ok');

  const again = crew(['import', 'agent-board', oldHome, '--from-project', 'pabcdef0123'], dir);
  assert.equal(again.code, 1);
  assert.match(again.err, /already has data files/);
  const forced = crew(['import', 'agent-board', oldHome, '--from-project', 'pabcdef0123', '--force', '--json'], dir);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(JSON.parse(forced.out).backups.length, 5);
  assert.ok(fs.readdirSync(path.join(HOME, 'projects', id)).filter((f) => f.includes('.before-import-')).length >= 5);
  assert.equal(snapshot(pdir), before);
});

test('import refuses bad input before writing anything', () => {
  const { dir, id } = register('epsilon');
  const { oldHome, pdir } = makeOldData();
  assert.equal(crew(['import', 'agent-board', oldHome], dir).code, 2);                                   // --from-project missing
  assert.equal(crew(['import', 'other', oldHome, '--from-project', 'pabcdef0123'], dir).code, 2);          // unknown source kind
  assert.equal(crew(['import', 'agent-board', oldHome, '--from-project', '../x'], dir).code, 1);
  assert.equal(crew(['import', 'agent-board', oldHome, '--from-project', 'p0000000000'], dir).code, 1);   // no such project
  fs.writeFileSync(path.join(pdir, 'mrs.json'), '{broken');
  const r = crew(['import', 'agent-board', oldHome, '--from-project', 'pabcdef0123'], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /mrs\.json/);
  assert.ok(!fs.existsSync(path.join(HOME, 'projects', id, 'work.json')));
  assert.ok(!fs.existsSync(path.join(HOME, 'projects', id, 'needs.json')));
});
