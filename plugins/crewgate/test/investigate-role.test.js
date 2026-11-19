'use strict';

// Investigation tasks (--role investigate), the "Visible to the user:" warning, and the dispatch prompt that survives a compaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();

const skip = { skip: !h.hasGit() };
const run = (repo, ...args) => h.crew(args, repo);
const VISIBLE = 'Visible to the user: nothing';
const BRIEF_VISIBLE = h.GOOD_BRIEF.replace('Light: tests only.', `Light: tests only.\n${VISIBLE}`);
const REPORT = [
  '## Answer', 'The cache key ignores the locale (src/cache.js:42).', '',
  '## Evidence', 'src/cache.js:42; `node x.js` printed the same key twice.', '',
  '## Ruled out', 'The clock: the same result with a fixed time.', '',
  '## Still unknown', 'Why it was written that way.', '',
].join('\n');

function create(repo, over = {}) {
  const brief = u.writeFile(h.tmpDir('crew-brief-'), 'brief.md', over.brief || BRIEF_VISIBLE);
  const args = ['task', 'create', '--title', over.title || 'Why slow', '--brief-file', brief, ...(over.args || [])];
  const r = u.crewJson(args, repo);
  assert.equal(r.code, 0, r.err);
  return r;
}
const reportOf = (repo, id, text = REPORT) => run(repo, 'task', 'report', id, '--report-file', u.writeFile(h.tmpDir('crew-rep-'), 'r.md', text));

test('create --role investigate needs no branch or worktree and names crew-investigator', () => {
  const repo = u.initRepo();
  const r = create(repo, { args: ['--role', 'investigate'] });
  assert.equal(r.data.task.role, 'investigate');
  assert.equal(r.data.task.branch, '');
  assert.equal(r.data.task.worktree, '');
  assert.equal(r.data.subagent_type, 'crew-investigator');
  assert.match(r.data.prompt, /You are the crew investigator for task t-/);
  assert.match(r.data.prompt, /Read-only: change no project file and make no commit/);
  assert.doesNotMatch(r.data.prompt, /Commit to your branch/);
  const w = create(repo);
  assert.equal(w.data.subagent_type, 'crew-worker');
  assert.match(w.data.prompt, /You are the crew worker for task t-/);
});

test('an investigation report uses the investigation sections, a worker report is refused for it', () => {
  const repo = u.initRepo();
  const t = create(repo, { args: ['--role', 'investigate'] }).data.task;
  const bad = run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /Answer/);
  assert.equal(reportOf(repo, t.id).code, 0);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'returned');
});

test('accept of an investigation: no scope check, no review rule, one line says so', () => {
  const repo = u.initRepo();
  const t = create(repo, { args: ['--role', 'investigate'] }).data.task;
  assert.equal(reportOf(repo, t.id).code, 0);
  const r = run(repo, 'task', 'accept', t.id);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /An investigation has no diff: the scope check and the review rule were not applied\./);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'accepted');
});

test('accept of an investigation with commits on its branch is refused', skip, () => {
  const repo = u.initRepo();
  h.git(repo, 'branch', 'inv/x');
  const t = create(repo, { args: ['--role', 'investigate', '--branch', 'inv/x'] }).data.task;
  h.git(repo, 'checkout', '-q', 'inv/x');
  u.writeFile(repo, 'src/stray.js', 'x\n');
  h.git(repo, 'add', '--', 'src/stray.js');
  h.git(repo, 'commit', '-q', '-m', 'stray');
  h.git(repo, 'checkout', '-q', '-');
  assert.equal(reportOf(repo, t.id).code, 0);
  const r = run(repo, 'task', 'accept', t.id);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /an investigation must not change the project/);
  assert.match(r.err, /src\/stray\.js/);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'returned');
});

test('accept of an investigation whose worktree has an edited file is refused; a clean one with a branch is accepted', skip, () => {
  const repo = u.initRepo();
  const wt = path.join(h.tmpDir('crew-wt-'), 'wt');
  h.git(repo, 'worktree', 'add', '-q', wt, '-b', 'inv/y');
  const t = create(repo, { args: ['--role', 'investigate', '--branch', 'inv/y', '--worktree', wt] }).data.task;
  assert.equal(reportOf(repo, t.id).code, 0);
  const ok = run(repo, 'task', 'accept', t.id);
  assert.equal(ok.code, 0, ok.err);
  const t2 = create(repo, { args: ['--role', 'investigate', '--worktree', wt] }).data.task;
  assert.equal(reportOf(repo, t2.id).code, 0);
  fs.writeFileSync(path.join(wt, 'README.md'), 'edited\n');
  const r = run(repo, 'task', 'accept', t2.id);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /an investigation must not change the project/);
});

test('a worker task still goes through the review rule at accept', () => {
  const repo = u.initRepo();
  const t = create(repo).data.task;
  assert.equal(reportOf(repo, t.id, h.GOOD_REPORT).code, 0);
  const r = run(repo, 'task', 'accept', t.id);
  assert.doesNotMatch(r.out + r.err, /An investigation has no diff/);
});

test('create warns, and does not refuse, when Machine impact has no "Visible to the user:" line', () => {
  const repo = u.initRepo();
  const without = u.crewJson(['task', 'create', '--title', 'T', '--brief-file', u.writeFile(h.tmpDir('crew-brief-'), 'b.md', h.GOOD_BRIEF)], repo);
  assert.equal(without.code, 0, without.err);
  assert.deepEqual(without.data.warnings, ['machine_impact_visible']);
  const text = h.crew(['task', 'create', '--title', 'T', '--brief-file', u.writeFile(h.tmpDir('crew-brief-'), 'b.md', h.GOOD_BRIEF)], repo);
  assert.match(text.out, /Visible to the user:/);
  const withLine = h.crew(['task', 'create', '--title', 'T', '--brief-file', u.writeFile(h.tmpDir('crew-brief-'), 'b.md', BRIEF_VISIBLE)], repo);
  assert.equal(withLine.code, 0);
  assert.doesNotMatch(withLine.out, /Warning: the brief's Machine impact/);
  // a statement in another section does not count
  const wrong = h.GOOD_BRIEF.replace('Existing tests keep passing.', `Existing tests keep passing.\n${VISIBLE}`);
  assert.deepEqual(u.crewJson(['task', 'create', '--title', 'T', '--brief-file', u.writeFile(h.tmpDir('crew-brief-'), 'b.md', wrong)], repo).data.warnings, ['machine_impact_visible']);
});

test('send-back prints the create prompt followed by the note with its round number', () => {
  const repo = u.initRepo();
  const created = create(repo, { args: ['--allow', 'src/**', '--deny', 'docs/**'] });
  const t = created.data.task;
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report).code, 0);
  const r = u.crewJson(['task', 'send-back', t.id, '--note', 'fix src/a.js:3'], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.prompt, `${created.data.prompt}\n\nSend-back round 1 of ${r.data.max}: fix src/a.js:3`);
  const text = run(repo, 'task', 'show', t.id, '--prompt');
  assert.equal(text.out.trim(), r.data.prompt.trim());
});

test('send-back text output shows the prompt between markers, after the confirmation line', () => {
  const repo = u.initRepo();
  const t = create(repo).data.task;
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report).code, 0);
  const r = run(repo, 'task', 'send-back', t.id, '--note', 'again');
  const lines = r.out.split(/\r?\n/);
  assert.match(lines[0], /sent back \(return 1 of/);
  assert.equal(lines[1], '--- prompt ---');
  assert.match(r.out, new RegExp(`crew-task: ${t.id}`));
  assert.match(r.out, /Send-back round 1 of \d+: again/);
});

test('task show --prompt prints the create prompt at any time, and the prompts say no git stash', () => {
  const repo = u.initRepo();
  const created = create(repo, { args: ['--allow', 'src/**'] });
  const r = u.crewJson(['task', 'show', created.data.task.id, '--prompt'], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.prompt, created.data.prompt);
  assert.equal(r.data.subagent_type, 'crew-worker');
  assert.match(created.data.prompt, /Do not use `git stash`; the stash list is shared by every worktree/);
  const inv = create(repo, { args: ['--role', 'investigate'] });
  assert.match(inv.data.prompt, /Do not use `git stash`/);
});

test('crew init copies the investigator agent; the agent files carry the rules', () => {
  const repo = u.initRepo();
  const f = path.join(repo, '.claude', 'agents', 'crew-investigator.md');
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /^name: crew-investigator$/m);
  assert.match(text, /^tools: Read, Grep, Glob, Bash, Write$/m);
  assert.match(text, /Stop and report after three hypotheses have failed/);
  assert.match(text, /crew slot run/);
  assert.match(text, /## Answer\r?\n## Evidence\r?\n## Ruled out\r?\n## Still unknown/);
  const worker = fs.readFileSync(path.join(repo, '.claude', 'agents', 'crew-worker.md'), 'utf8');
  assert.match(worker, /Do not use `git stash`/);
  assert.match(worker, /never show a window, play a sound, send a notification, ask for a reboot or shutdown/);
  const generic = fs.readFileSync(path.join(__dirname, '..', 'agents', 'crew-investigator.md'), 'utf8');
  assert.match(generic, /^name: crew-investigator$/m);
});

test('doctor reports a missing investigator copy as a warning, not a failure', () => {
  const repo = u.initRepo();
  const d = u.crewJson(['doctor'], repo);
  assert.notEqual(d.code, 2);
  fs.rmSync(path.join(repo, '.claude', 'agents', 'crew-investigator.md'));
  const r = u.crewJson(['doctor'], repo);
  const row = JSON.stringify(r.data);
  assert.match(row, /crew-investigator\.md/);
  assert.ok(r.code === 0 || r.code === 1, `doctor exit ${r.code}`);
});

test('task show --prompt prints the full send-back note, as send-back did (note over 500 characters)', () => {
  const repo = u.initRepo();
  const t = create(repo).data.task;
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report).code, 0);
  const note = `${'long note line. '.repeat(60)}END-MARK`;
  assert.ok(note.length > 800);
  const r = u.crewJson(['task', 'send-back', t.id, '--note', note], repo);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.data.prompt.includes('END-MARK'));
  const shown = u.crewJson(['task', 'show', t.id, '--prompt'], repo);
  assert.equal(shown.data.prompt, r.data.prompt);
});
