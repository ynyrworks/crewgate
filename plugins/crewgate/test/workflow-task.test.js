'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();

const run = (repo, ...args) => h.crew(args, repo);

test('task create: prints id, marker line, prompt; json carries the same data', () => {
  const repo = u.initRepo();
  const brief = u.writeFile(h.tmpDir(), 'b.md', h.GOOD_BRIEF);
  const r = u.crewJson(['task', 'create', '--title', 'Add thing', '--brief-file', brief, '--branch', 'feat/x',
    '--worktree', '/work/wt', '--allow', 'src/**,test/**', '--deny', 'docs/**'], repo);
  assert.equal(r.code, 0, r.err);
  const d = r.data;
  assert.match(d.task.id, /^t-\d{8}-[0-9a-z]{4}$/);
  assert.equal(d.marker, `crew-task: ${d.task.id}`);
  assert.deepEqual(d.task.scope, { allow: ['src/**', 'test/**'], deny: ['docs/**'] });
  assert.equal(d.subagent_type, 'crew-worker');
  assert.ok(d.prompt.includes(d.marker));
  assert.ok(d.prompt.includes('crew-cli: node "'));
  assert.ok(d.prompt.includes('feat/x') && d.prompt.includes('src/**, test/**'));
  assert.ok(fs.existsSync(d.brief_path));
  const text = run(repo, 'task', 'create', '--title', 'Second', '--brief-file', brief);
  assert.equal(text.code, 0);
  assert.match(text.out, /Task t-\d{8}-[0-9a-z]{4} created\./);
  assert.match(text.out, /^crew-task: t-\d{8}-[0-9a-z]{4}$/m);
});

test('task create: incomplete brief, missing file, missing title and bad branch are rejected', () => {
  const repo = u.initRepo();
  const bad = u.writeFile(h.tmpDir(), 'bad.md', '# Goal\nx\n# Scope\ny\n');
  const r = run(repo, 'task', 'create', '--title', 'T', '--brief-file', bad);
  assert.equal(r.code, 1);
  assert.match(r.err, /Missing sections: .*Acceptance/);
  assert.equal(run(repo, 'task', 'create', '--title', 'T', '--brief-file', path.join(repo, 'nope.md')).code, 1);
  const good = u.writeFile(h.tmpDir(), 'g.md', h.GOOD_BRIEF);
  assert.equal(run(repo, 'task', 'create', '--brief-file', good).code, 2);
  assert.equal(run(repo, 'task', 'create', '--title', 'T').code, 2);
  const b = run(repo, 'task', 'create', '--title', 'T', '--brief-file', good, '--branch', '--upload-pack=x');
  assert.notEqual(b.code, 0);
  assert.equal(run(repo, 'task', 'create', '--title', 'T', '--brief-file', good, '--branch', 'a..b').code, 2);
  assert.deepEqual(u.crewJson(['task', 'list'], repo).data, []);
});

test('task commands outside a registered project fail with a clear message', () => {
  const plain = h.tmpDir();
  const r = run(plain, 'task', 'list');
  assert.equal(r.code, 1);
  assert.match(r.err, /registered project/);
  assert.equal(run(plain, 'task', 'bogus').code, 2);
});

test('task list filters by state and prints returns', () => {
  const repo = u.initRepo();
  const a = u.createTask(repo, { title: 'A' });
  u.createTask(repo, { title: 'B' });
  const all = u.crewJson(['task', 'list'], repo).data;
  assert.equal(all.length, 2);
  const f = u.reportFiles();
  assert.equal(run(repo, 'task', 'report', a.id, '--report-file', f.report).code, 0);
  assert.equal(u.crewJson(['task', 'list', '--state', 'returned'], repo).data.length, 1);
  assert.match(run(repo, 'task', 'list').out, /returns 0\/2/);
  assert.equal(run(repo, 'task', 'list', '--state', 'nonsense').code, 2);
  assert.equal(run(repo, 'task', 'show', 't-20000101-zzzz').code, 1);
});

test('task report: validates before touching state, stores report and packet, moves to returned', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  const badReport = u.writeFile(h.tmpDir(), 'r.md', '## Branch & commits\nx\n');
  const bad = run(repo, 'task', 'report', t.id, '--report-file', badReport);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not valid/);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'created');
  u.patchCfg(repo, (c) => { c.limits = { report_max_tokens: 100 }; });
  const long = u.writeFile(h.tmpDir(), 'long.md', `${h.GOOD_REPORT}\n${'word '.repeat(200)}`);
  const tooLong = run(repo, 'task', 'report', t.id, '--report-file', long);
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.err, /too long/);
  u.patchCfg(repo, (c) => { c.limits = { report_max_tokens: 1500 }; });
  const f = u.reportFiles();
  const ok = u.crewJson(['task', 'report', t.id, '--report-file', f.report, '--packet-file', f.packet], repo);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.data.task.state, 'returned');
  assert.ok(ok.data.tokens > 0);
  assert.equal(run(repo, 'task', 'report', t.id).code, 2);
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', path.join(repo, 'missing.md')).code, 1);
});

test('task show is compact: report, diff stat, packet path, never the packet itself', () => {
  const repo = u.initRepo();
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(repo, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(repo, 'src.js'), 'one\ntwo\n');
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', base);
  const t = u.createTask(repo, { branch: 'feat/x' });
  const f = u.reportFiles();
  run(repo, 'task', 'report', t.id, '--report-file', f.report, '--packet-file', f.packet);
  const r = run(repo, 'task', 'show', t.id);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('Branch & commits'));
  assert.match(r.out, /src\.js\s+\|\s+2 \+/);
  assert.ok(r.out.includes('packet.md'));
  assert.ok(!r.out.includes('UNIQUE-PACKET-TOKEN'));
  const d = u.crewJson(['task', 'show', t.id], repo).data;
  assert.equal(d.task.state, 'returned');
  assert.ok(d.diff_stat.includes('src.js'));
  assert.equal(d.findings, null);
  assert.ok(d.packet_path.endsWith('packet.md'));
});

test('task show without a branch says the diff is unavailable', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo, { branch: 'feat/missing' });
  const d = u.crewJson(['task', 'show', t.id], repo).data;
  assert.equal(d.diff_stat, null);
  assert.equal(d.report, null);
  assert.match(run(repo, 'task', 'show', t.id).out, /no report yet/);
});

test('send-back enforces the takeover limit and records a takeover lesson', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  const f = u.reportFiles();
  const back = (note) => run(repo, 'task', 'send-back', t.id, '--note', note);
  const rep = () => run(repo, 'task', 'report', t.id, '--report-file', f.report);
  assert.equal(rep().code, 0);
  assert.equal(run(repo, 'task', 'send-back', t.id).code, 2, 'note is required');
  const first = back('fix the edge case');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /return 1 of 2/);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'dispatched');
  assert.equal(back('again').code, 1, 'cannot send back a task that was not returned');
  assert.equal(rep().code, 0);
  assert.equal(back('second fix').code, 0);
  assert.equal(rep().code, 0);
  const refused = back('third fix');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /take it over/);
  assert.match(refused.err, /takeover lesson/);
  const lessons = fs.readFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'utf8');
  assert.match(lessons, /\[takeover\] takeover-limit: .*third fix/);
  const d = u.crewJson(['task', 'show', t.id], repo).data;
  assert.equal(d.task.state, 'returned');
  assert.equal(d.task.returns, 2);
});

test('send-back honours max_returns_before_takeover from the config', () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.limits = { max_returns_before_takeover: 1 }; });
  const t = u.createTask(repo);
  const f = u.reportFiles();
  run(repo, 'task', 'report', t.id, '--report-file', f.report);
  assert.equal(run(repo, 'task', 'send-back', t.id, '--note', 'x').code, 0);
  run(repo, 'task', 'report', t.id, '--report-file', f.report);
  assert.equal(run(repo, 'task', 'send-back', t.id, '--note', 'y').code, 1);
});

test('accept, merge and cancel follow the state machine', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  const f = u.reportFiles();
  assert.equal(run(repo, 'task', 'accept', t.id).code, 1, 'cannot accept before it returned');
  assert.equal(run(repo, 'task', 'merge', t.id).code, 1);
  run(repo, 'task', 'report', t.id, '--report-file', f.report);
  const acc = u.crewJson(['task', 'accept', t.id, '--note', 'looks good'], repo);
  assert.equal(acc.code, 0, acc.err);
  assert.equal(acc.data.task.state, 'accepted');
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', f.report).code, 1, 'no report after accept');
  const m = u.crewJson(['task', 'merge', t.id, '--note', 'abc123'], repo);
  assert.equal(m.data.task.state, 'merged');
  assert.equal(m.data.task.history[m.data.task.history.length - 1].note, 'abc123');
  assert.equal(run(repo, 'task', 'cancel', t.id).code, 1, 'merged is final');
  const t2 = u.createTask(repo, { title: 'other' });
  assert.equal(u.crewJson(['task', 'cancel', t2.id, '--note', 'dropped'], repo).data.task.state, 'cancelled');
  assert.equal(run(repo, 'task', 'accept', t2.id).code, 1);
});

test('merge is refused when the merge gate is never; events are recorded', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  run(repo, 'task', 'accept', t.id);
  u.patchCfg(repo, (c) => { c.gates = { merge: 'never' }; });
  const r = run(repo, 'task', 'merge', t.id);
  assert.equal(r.code, 1);
  assert.match(r.err, /never/);
  u.patchCfg(repo, (c) => { c.gates = { merge: 'ask' }; });
  assert.equal(run(repo, 'task', 'merge', t.id).code, 0);
  const events = require('../lib/core/events');
  const project = require('../lib/core/project');
  const types = events.read(project.findByCwd(repo).id).filter((e) => e.task === t.id).map((e) => e.type);
  assert.deepEqual(types, ['task.created', 'task.dispatched', 'task.returned', 'task.accepted', 'task.merged']);
});

test('accept warns about blocker/major findings that are still listed', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo);
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  const project = require('../lib/core/project');
  const paths = require('../lib/core/paths');
  const dir = path.join(paths.taskDir(project.findByCwd(repo).id, t.id), 'findings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify([u.finding('f1'), u.finding('f2', { severity: 'nit', category: 'nit' })]));
  const show = run(repo, 'task', 'show', t.id);
  assert.match(show.out, /Findings, round 1: 2/);
  const r = u.crewJson(['task', 'accept', t.id], repo);
  assert.deepEqual(r.data.open_findings.map((f) => f.id), ['f1']);
  assert.match(run(repo, 'task', 'list').out, /accepted/);
});
