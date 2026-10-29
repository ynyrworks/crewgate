'use strict';

// `crew task run --engine codex` against a FAKE codex (a node script; a .cmd shim on Windows).
// The real Codex is never started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');
const u = require('./workflow-util');
const paths = require('../lib/core/paths');
const events = require('../lib/core/events');
const project = require('../lib/core/project');
const store = require('../lib/core/store');
const codexrun = require('../lib/features/codexrun');

h.setupHome();

const FAKE = [
  "const fs = require('fs');",
  "const a = process.argv.slice(2);",
  "const val = (f) => a[a.indexOf(f) + 1];",
  "const dir = val('-C'); const out = val('-o'); const schema = val('--output-schema');",
  "let stdin = 'unset'; try { stdin = fs.readFileSync(0, 'utf8'); } catch (e) { stdin = ''; }",
  "const m = /Read the file (.*) and follow it exactly/.exec(a[a.length - 1]);",
  "const mode = process.env.FAKE_MODE || 'ok';",
  "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, cwd: process.cwd(), stdin, pid: process.pid,",
  "  schema: fs.existsSync(schema) ? JSON.parse(fs.readFileSync(schema, 'utf8')) : null,",
  "  prompt: m ? fs.readFileSync(m[1], 'utf8') : null }));",
  "if (mode === 'hang') { setInterval(() => {}, 1000); } else {",
  "if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }",
  "if (mode !== 'nochange') fs.writeFileSync(require('path').join(dir, 'made-by-codex.txt'), 'hello\\n');",
  "const good = JSON.stringify({ changes: '- made-by-codex.txt: new file', tests: 'npm test: 3 pass', assumptions: 'none', realenv: 'no' });",
  "if (mode === 'invalid') { fs.writeFileSync(out, 'this is not json'); console.log('this is not json'); }",
  "else if (mode === 'missing') { console.log('all done, no json'); }",
  "else if (mode === 'fenced') { fs.writeFileSync(out, 'Result:\\n```json\\n' + good + '\\n```'); }",
  "else { fs.writeFileSync(out, good); console.log(good); }",
  "}",
].join('\n');

function setGlobalEngines(engines) {
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines }));
}

// Installs a fake `codex` in a fresh bin dir. -> { bin, script, log }
function fakeCodex() {
  const bin = h.tmpDir('crew-fakebin-');
  const script = u.writeFile(bin, 'fake-codex.js', FAKE);
  const log = path.join(bin, 'log.json');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n${FAKE}\n`, { mode: 0o755 });
  }
  return { bin, script, log };
}

function setup() {
  const repo = u.initRepo();
  for (const [k, v] of [['user.name', 'Repo Person'], ['user.email', 'repo@example.test'], ['commit.gpgsign', 'false']]) {
    spawnSync('git', ['config', k, v], { cwd: repo });
  }
  const fake = fakeCodex();
  setGlobalEngines({ codex: { command: 'codex', args: [] } });
  const wt = path.join(h.tmpDir('crew-wt-'), 'wt');
  const task = u.createTask(repo, { worktree: wt });
  const env = (mode) => ({ PATH: `${fake.bin}${path.delimiter}${process.env.PATH || process.env.Path}`, FAKE_MODE: mode, FAKE_LOG: fake.log });
  const run = (mode, ...more) => h.crew(['task', 'run', task.id, ...more], repo, env(mode));
  const pid = project.findByCwd(repo).id;
  const evs = (t) => events.read(pid, { types: t });
  return { repo, fake, wt, task, run, pid, evs };
}

const gitOut = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const readLog = (s) => JSON.parse(fs.readFileSync(s.fake.log, 'utf8'));
const show = (s) => u.crewJson(['task', 'show', s.task.id], s.repo).data;

test('run: success commits on the task branch with the trailer, files the report and returns the task', () => {
  const s = setup();
  const r = s.run('ok');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /returned by codex: 1 file\(s\) committed as [0-9a-f]+ on crew\/t-/);
  assert.equal(r.out.split('\n').length, 1, 'one-line summary on stdout');

  const t = show(s);
  assert.equal(t.task.state, 'returned');
  assert.equal(t.task.branch, `crew/${s.task.id}`);
  assert.equal(path.resolve(t.task.worktree), path.resolve(s.wt));

  assert.equal(gitOut(s.wt, 'branch', '--show-current'), `crew/${s.task.id}`);
  const msg = gitOut(s.wt, 'log', '-1', '--format=%B');
  assert.match(msg, /Co-Authored-By: Codex <noreply@openai\.com>/);
  assert.equal(gitOut(s.wt, 'log', '-1', '--format=%an <%ae>'), 'Repo Person <repo@example.test>');
  assert.equal(gitOut(s.wt, 'show', '--name-only', '--format=', 'HEAD'), 'made-by-codex.txt');
  assert.equal(gitOut(s.wt, 'status', '--porcelain'), '');

  const dir = paths.taskDir(s.pid, s.task.id);
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  for (const sec of ['Branch & commits', 'What changed and why', 'Tests run', 'Assumptions & unfinished', 'Needs real-environment check']) assert.ok(report.includes(`## ${sec}`), sec);
  assert.match(report, /made-by-codex\.txt: new file/);
  const packet = fs.readFileSync(path.join(dir, 'packet.md'), 'utf8');
  assert.match(packet, /\+hello/);
  assert.match(packet, /"assumptions":"none"/);

  const d = s.evs('task.dispatched');
  assert.equal(d.length, 1);
  assert.equal(d[0].data.engine, 'codex');
  assert.equal(s.evs('task.returned')[0].data.engine, 'codex');

  // how codex was started
  const log = readLog(s);
  assert.equal(log.stdin, '', 'stdin is closed');
  for (const f of ['exec', '-C', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-schema', '-o']) assert.ok(log.argv.includes(f), f);
  assert.equal(log.argv[log.argv.indexOf('-C') + 1], s.wt);
  assert.equal(log.schema.additionalProperties, false);
  assert.deepEqual(log.schema.required, ['changes', 'tests', 'assumptions', 'realenv']);
  assert.ok(log.prompt.includes(`crew-task: ${s.task.id}`));
  assert.ok(log.prompt.includes('Add the thing.'), 'brief included');
  assert.ok(log.prompt.includes('Do NOT run `git add`'));
  assert.ok(log.prompt.includes('You are a crew worker'), 'worker rules included');
  assert.equal(fs.realpathSync(log.cwd), fs.realpathSync(s.wt));
});

test('run: creates the worktree and a default branch from HEAD when missing; accepts fenced JSON', () => {
  const s = setup();
  assert.ok(!fs.existsSync(s.wt));
  const r = s.run('fenced');
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(s.wt, '.git')));
  assert.equal(gitOut(s.repo, 'rev-parse', '--verify', `crew/${s.task.id}`).length, 40);
});

test('run: invalid or missing final output -> no commit, failure recorded, task stays dispatched', () => {
  for (const mode of ['invalid', 'missing']) {
    const s = setup();
    const r = s.run(mode);
    assert.equal(r.code, 1, mode);
    assert.match(r.err, /worker failed \(output\)/);
    assert.equal(show(s).task.state, 'dispatched');
    assert.equal(gitOut(s.wt, 'rev-list', '--count', 'HEAD'), '1', 'no commit');
    assert.match(gitOut(s.wt, 'status', '--porcelain'), /made-by-codex\.txt/, 'changes left for inspection');
    const f = s.evs('task.failed');
    assert.equal(f.length, 1);
    assert.equal(f[0].data.kind, 'output');
    assert.ok(store.needList(s.pid).some((n) => n.text.includes(s.task.id)));
    assert.equal(s.evs('task.returned').length, 0);
  }
});

test('run: a failed run can be repeated and then succeeds', () => {
  const s = setup();
  assert.equal(s.run('invalid').code, 1);
  const r = s.run('ok');
  assert.equal(r.code, 0, r.err);
  assert.equal(show(s).task.state, 'returned');
  assert.equal(s.evs('task.dispatched').length, 2, 'second launch recorded as a re-dispatch');
});

test('run: non-zero exit and "no files changed" are failures', () => {
  const a = setup();
  const r = a.run('fail');
  assert.equal(r.code, 1);
  assert.match(r.err, /\(exit\)/);
  assert.equal(a.evs('task.failed')[0].data.kind, 'exit');
  const b = setup();
  assert.equal(b.run('nochange').code, 1);
  assert.equal(b.evs('task.failed')[0].data.kind, 'no-changes');
});

test('run: timeout kills the process and records the failure', () => {
  const s = setup();
  const t0 = Date.now();
  const r = s.run('hang', '--timeout', '2');
  assert.equal(r.code, 1);
  assert.ok(Date.now() - t0 < 25000, 'did not wait for the hung process');
  assert.match(r.err, /worker failed \(timeout\)/);
  assert.equal(s.evs('task.failed')[0].data.kind, 'timeout');
  assert.equal(show(s).task.state, 'dispatched');
  const pid = readLog(s).pid;
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the fake codex was killed');
});

test('run: engine not configured, command not found, wrong state, claude engine', () => {
  const s = setup();
  const nope = h.crew(['task', 'run', s.task.id, '--engine', 'nope'], s.repo, { FAKE_LOG: s.fake.log });
  assert.equal(nope.code, 1);
  assert.match(nope.err, /No engine named "nope"/);
  setGlobalEngines({ codex: { command: 'crewgate-no-such-codex', args: [] } });
  const missing = s.run('ok');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /was not found on PATH/);
  assert.equal(show(s).task.state, 'created', 'nothing started');
  assert.equal(h.crew(['task', 'run', s.task.id, '--engine', 'claude'], s.repo).code, 2);
  assert.equal(h.crew(['task', 'run', s.task.id, '--timeout', '0'], s.repo).code, 2);
  setGlobalEngines({ codex: { command: 'codex', args: [] } });
  assert.equal(h.crew(['task', 'cancel', s.task.id], s.repo).code, 0);
  const bad = s.run('ok');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /only a created or dispatched task/);
});

test('run: the engine is found through PATH/PATHEXT; on Windows that is a .cmd shim', () => {
  const s = setup();
  if (process.platform === 'win32') assert.ok(fs.existsSync(path.join(s.fake.bin, 'codex.cmd')));
  assert.equal(s.run('ok').code, 0);
});

test('parseFinal: plain, fenced and wrapped JSON; wrong shapes are rejected', () => {
  const good = { changes: 'a', tests: 'b', assumptions: 'c', realenv: 'd' };
  const s = JSON.stringify(good);
  assert.deepEqual(codexrun.parseFinal(s), good);
  assert.deepEqual(codexrun.parseFinal(`\`\`\`json\n${s}\n\`\`\``), good);
  assert.deepEqual(codexrun.parseFinal(`Done. ${s} bye`), good);
  assert.equal(codexrun.parseFinal('{"changes":"a"}'), null);
  assert.equal(codexrun.parseFinal(JSON.stringify({ ...good, tests: '' })), null);
  assert.equal(codexrun.parseFinal(JSON.stringify([good])), null);
  assert.equal(codexrun.parseFinal(''), null);
});
