'use strict';

// Regression tests for the usage-analysis gaps in the CLI: crew gate, task merge as the merge record,
// work set updating in place, init checks detection, doctor warnings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');
const { detectChecks } = require('../lib/features/stack');

h.setupHome();
const events = require('../lib/core/events');
const project = require('../lib/core/project');

const pidOf = (repo) => project.list().find((p) => path.resolve(p.path).toLowerCase() === path.resolve(repo).toLowerCase()).id;
const evs = (repo, types) => events.read(pidOf(repo), { types });

// ---------------------------------------------------------------- 1. gates
test('gate ask records gate.asked and prints an id; gate answer records gate.answered', () => {
  const repo = u.initRepo();
  const task = u.createTask(repo);
  const ask = u.crewJson(['gate', 'ask', 'push', '--task', task.id, '--detail', 'push feat/x to origin'], repo);
  assert.equal(ask.code, 0, ask.err);
  assert.match(ask.data.id, /^g-[0-9a-f]{6}$/);
  assert.equal(ask.data.mode, 'ask');
  assert.match(h.crew(['gate', 'ask', 'merge'], repo).out, /^Gate merge asked: g-[0-9a-f]{6}/);

  const ans = u.crewJson(['gate', 'answer', ask.data.id, 'yes', '--note', 'user agreed'], repo);
  assert.equal(ans.code, 0, ans.err);
  const asked = evs(repo, 'gate.asked');
  const answered = evs(repo, 'gate.answered');
  assert.equal(asked.length, 2);
  assert.equal(asked[0].task, task.id);
  assert.equal(asked[0].data.detail, 'push feat/x to origin');
  assert.equal(answered.length, 1);
  assert.deepEqual([answered[0].data.id, answered[0].data.gate, answered[0].data.answer, answered[0].data.note], [ask.data.id, 'push', 'yes', 'user agreed']);

  assert.notEqual(h.crew(['gate', 'answer', ask.data.id, 'no'], repo).code, 0, 'answered once');
  assert.notEqual(h.crew(['gate', 'answer', 'g-000000', 'yes'], repo).code, 0, 'unknown id');
  assert.equal(h.crew(['gate', 'answer', ask.data.id, 'maybe'], repo).code, 2);
  assert.equal(h.crew(['gate', 'ask', 'nonsense'], repo).code, 2);
  assert.notEqual(h.crew(['gate', 'ask', 'push', '--task', 't-20200101-zzzz'], repo).code, 0, 'unknown task');
});

test('gate auto answers yes at once; never refuses with exit 1 and records the refusal', () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.gates = { push: 'auto', merge: 'never' }; });
  const auto = u.crewJson(['gate', 'ask', 'push'], repo);
  assert.equal(auto.code, 0);
  assert.equal(auto.data.answered, 'yes');
  const never = h.crew(['gate', 'ask', 'merge'], repo);
  assert.equal(never.code, 1);
  assert.match(never.err, /never/);
  const answered = evs(repo, 'gate.answered');
  assert.deepEqual(answered.map((e) => `${e.data.gate}:${e.data.answer}:${e.data.auto}`), ['push:yes:true', 'merge:no:true']);
});

// ---------------------------------------------------------------- 3. task merge is the merge record
function mergedTaskRepo() {
  const repo = u.initRepo();
  const task = u.createTask(repo, { branch: 'feat/gap' });
  h.git(repo, 'checkout', '-q', '-b', 'feat/gap');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', '-');
  const f = u.reportFiles();
  assert.equal(h.crew(['task', 'report', task.id, '--report-file', f.report], repo).code, 0);
  assert.equal(h.crew(['task', 'accept', task.id], repo).code, 0);
  return { repo, task };
}

test('task merge records task.merged with the branch and a git.merge with the real branch name once git shows it merged', { skip: !h.hasGit() }, () => {
  const { repo, task } = mergedTaskRepo();
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/gap');
  const tip = h.git(repo, 'rev-parse', 'feat/gap');
  const r = u.crewJson(['task', 'merge', task.id], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.git_merge.status, 'recorded');
  const [merged] = evs(repo, 'task.merged');
  assert.equal(merged.data.branch, 'feat/gap');
  const [gm] = evs(repo, 'git.merge');
  assert.deepEqual(gm.data.branches, ['feat/gap']);
  assert.equal(gm.data.commit, tip.slice(0, 12));
  assert.equal(gm.data.target, h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
  assert.ok(gm.data.root, 'the work tree it was merged in is recorded');
  assert.ok(!JSON.stringify(gm).includes('$'));
});

test('task merge does not duplicate a git.merge a hook already recorded for the branch', { skip: !h.hasGit() }, () => {
  const { repo, task } = mergedTaskRepo();
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/gap');
  events.append(pidOf(repo), { type: 'git.merge', src: 'hook', data: { command: 'git merge', branches: ['feat/gap'], flags: [] }, key: 'hook-1' });
  const r = u.crewJson(['task', 'merge', task.id], repo);
  assert.equal(r.data.git_merge.status, 'already');
  assert.equal(evs(repo, 'git.merge').length, 1);
});

test('task merge on a branch git does not consider merged records only task.merged', { skip: !h.hasGit() }, () => {
  const { repo, task } = mergedTaskRepo();
  const r = u.crewJson(['task', 'merge', task.id], repo);
  assert.equal(r.code, 0);
  assert.equal(r.data.git_merge.status, 'not-merged');
  assert.equal(evs(repo, 'git.merge').length, 0);
  assert.equal(evs(repo, 'task.merged').length, 1);
});

// ---------------------------------------------------------------- 5. via on the CLI paths
test('task report from the CLI is via cli-report', () => {
  const repo = u.initRepo();
  const task = u.createTask(repo);
  const f = u.reportFiles();
  assert.equal(h.crew(['task', 'report', task.id, '--report-file', f.report], repo).code, 0);
  assert.equal(evs(repo, 'task.dispatched')[0].data.via, 'cli-report');
  assert.equal(evs(repo, 'task.returned')[0].data.via, 'cli-report');
});

// ---------------------------------------------------------------- 7. work set updates in place
test('work set updates the item with the same normalised title instead of adding another', () => {
  const repo = u.initRepo();
  assert.equal(h.crew(['work', 'set', 'DSHA', 'Fix  the Parser', 'doing', 'first'], repo).code, 0);
  assert.equal(h.crew(['work', 'set', 'DSHA', '  fix the parser ', 'done', 'second'], repo).code, 0);
  assert.equal(h.crew(['work', 'set', 'OTHER', 'Fix the parser', 'todo'], repo).code, 0, 'another stream is another item');
  const list = u.crewJson(['work', 'list'], repo).data;
  const dsha = list.find((s) => s.name === 'DSHA');
  assert.equal(dsha.items.length, 1);
  assert.equal(dsha.items[0].state, 'done');
  assert.equal(dsha.items[0].note, 'second');
  assert.equal(dsha.items[0].title, 'fix the parser');
  assert.match(dsha.items[0].id, /^w-[0-9a-f]{6}$/);
  assert.equal(list.find((s) => s.name === 'OTHER').items.length, 1);
});

test('work set --id targets an item (and may rename it); --new forces a second item; rm --id works', () => {
  const repo = u.initRepo();
  h.crew(['work', 'set', 'S', 'Alpha', 'todo'], repo);
  const id = u.crewJson(['work', 'list'], repo).data[0].items[0].id;
  assert.equal(h.crew(['work', 'set', 'S', 'Alpha renamed', 'doing', '--id', id], repo).code, 0);
  let items = u.crewJson(['work', 'list'], repo).data[0].items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].id, items[0].title, items[0].state], [id, 'Alpha renamed', 'doing']);
  assert.notEqual(h.crew(['work', 'set', 'S', 'x', 'doing', '--id', 'w-ffffff'], repo).code, 0, 'unknown id');
  assert.equal(h.crew(['work', 'set', 'S', 'Alpha renamed', 'todo', '--new'], repo).code, 0);
  items = u.crewJson(['work', 'list'], repo).data[0].items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(h.crew(['work', 'set', 'S', 'x', 'todo', '--id', id, '--new'], repo).code, 2);
  assert.equal(h.crew(['work', 'rm', 'S', '--id', id], repo).code, 0);
  assert.equal(u.crewJson(['work', 'list'], repo).data[0].items.length, 1);
  assert.equal(h.crew(['work', 'rm', 'S', 'ALPHA   RENAMED'], repo).code, 0, 'rm matches the normalised title too');
  assert.deepEqual(u.crewJson(['work', 'list'], repo).data, []);
});

test('legacy work items without ids get a stable id; doctor reports duplicate-looking ones', async () => {
  const repo = u.initRepo();
  h.crew(['work', 'set', 'S', 'Seed', 'todo'], repo);
  const file = path.join(process.env.CREWGATE_HOME, 'projects', pidOf(repo), 'work.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.streams[0].items = [{ title: 'Same thing', state: 'todo', note: '' }, { title: 'same  THING', state: 'doing', note: '' }];
  fs.writeFileSync(file, JSON.stringify(d));
  const a = u.crewJson(['work', 'list'], repo).data[0].items;
  const b = u.crewJson(['work', 'list'], repo).data[0].items;
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id), 'stable');
  assert.equal(new Set(a.map((i) => i.id)).size, 2, 'normalised-equal titles still get distinct ids');
  assert.equal(h.crew(['work', 'set', 'S', 'Same thing', 'done', '--id', a[1].id], repo).code, 0);
  assert.deepEqual(u.crewJson(['work', 'list'], repo).data[0].items.map((i) => i.state), ['todo', 'done']);
  const doc = await u.crewAsync(['--json', 'doctor'], repo);
  const work = JSON.parse(doc.out).checks.find((c) => c.name === 'work');
  assert.equal(work.status, 'warn');
  assert.match(work.detail, /S \/ Same thing \(2\)/);
});

// ---------------------------------------------------------------- 8. checks
test('detectChecks recognises the usual stacks and ignores the npm placeholder', () => {
  const dir = (files) => {
    const d = h.tmpDir('crew-stack-');
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
    return d;
  };
  assert.deepEqual(detectChecks(dir({})), []);
  assert.deepEqual(detectChecks(dir({ 'package.json': '{"scripts":{"test":"node --test"}}' })), ['npm test']);
  assert.deepEqual(detectChecks(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), []);
  assert.deepEqual(detectChecks(dir({ 'package.json': '{ broken' })), []);
  assert.deepEqual(detectChecks(dir({ 'go.mod': 'module x\n' })), ['go test ./...', 'go vet ./...']);
  assert.deepEqual(detectChecks(dir({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })), ['pytest']);
  assert.deepEqual(detectChecks(dir({ 'pytest.ini': '' })), ['pytest']);
  assert.deepEqual(detectChecks(dir({ 'Cargo.toml': '[package]\n' })), ['cargo test']);
  assert.deepEqual(detectChecks(dir({ 'App.sln': '' })), ['dotnet test']);
  assert.deepEqual(detectChecks(dir({ 'x.csproj': '' })), ['dotnet test']);
  assert.deepEqual(detectChecks(dir({ Makefile: 'build:\n\tcc\n\ntest:\n\t./t\n' })), ['make test']);
  assert.deepEqual(detectChecks(dir({ Makefile: 'build:\n\tcc\n' })), []);
  assert.deepEqual(detectChecks(dir({ 'go.mod': 'module x\n', Makefile: 'test:\n\tgo test\n' })), ['go test ./...', 'go vet ./...', 'make test']);
});

test('crew init fills an empty checks list from the stack, prints it, and never overwrites existing checks', () => {
  const repo = h.makeRepo();
  fs.writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const r = h.crew(['init'], repo);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /set checks to: npm test/);
  assert.deepEqual(u.readCfg(repo).checks, ['npm test']);
  assert.match(fs.readFileSync(path.join(repo, '.claude', 'agents', 'crew-worker.md'), 'utf8'), /`npm test`/, 'the worker copy lists the check');

  // user-chosen checks survive a re-run, with and without --force
  u.patchCfg(repo, (c) => { c.checks = ['make ci']; });
  h.crew(['init'], repo);
  h.crew(['init', '--force'], repo);
  assert.deepEqual(u.readCfg(repo).checks, ['make ci']);
  const again = u.crewJson(['init'], repo);
  assert.deepEqual(again.data.checks, { detected: [], written: false, kept: 1 });
});

test('crew init in an existing config with empty checks adds them; with no recognisable stack it says so', () => {
  const repo = u.initRepo(); // no stack files: checks stay empty
  assert.deepEqual(u.readCfg(repo).checks, []);
  assert.match(h.crew(['init'], repo).out, /No test command recognised/);
  fs.writeFileSync(path.join(repo, 'go.mod'), 'module x\n');
  const r = h.crew(['init'], repo);
  assert.match(r.out, /updated\s+\.claude\/crew\.json/);
  assert.deepEqual(u.readCfg(repo).checks, ['go test ./...', 'go vet ./...']);
});

test('crew init explains that project agent copies take precedence over the plugin', () => {
  const repo = h.makeRepo();
  assert.match(h.crew(['init'], repo).out, /take precedence over the plugin/);
  assert.match(h.crew(['--lang', 'zh-TW', 'init'], repo).out, /優先於外掛/);
});

test('doctor warns on empty checks and on hooks that never fired; both clear when fixed', async () => {
  const repo = u.initRepo();
  let by = Object.fromEntries(JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out).checks.map((c) => [c.name, c]));
  assert.equal(by.checks.status, 'warn');
  assert.match(by.checks.detail, /"checks" is empty/);
  assert.equal(by.hookseen.status, 'warn');
  assert.match(by.hookseen.detail, /SessionStart, Stop, SessionEnd/);

  u.patchCfg(repo, (c) => { c.checks = ['npm test']; });
  const pid = pidOf(repo);
  const seen = path.join(process.env.CREWGATE_HOME, 'projects', pid, 'runtime', 'hook-seen.json');
  fs.mkdirSync(path.dirname(seen), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(seen, JSON.stringify({ v: 1, events: { SessionStart: now, Stop: now, SessionEnd: now } }));
  const doc = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
  by = Object.fromEntries(doc.checks.map((c) => [c.name, c]));
  assert.equal(by.checks.status, 'ok');
  assert.equal(by.hookseen.status, 'ok');
  assert.ok(doc.hook_seen.find((r) => r.event === 'Stop').last);
});
