'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const config = require('../lib/core/config');
const project = require('../lib/core/project');
const events = require('../lib/core/events');

const run = (repo, ...args) => h.crew(args, repo);
const NOTE = 'read the diff line by line';
const skip = { skip: !h.hasGit() };

// A repository with a task on feat/x holding one commit of `files` ({ name: text }).
function setup(files = { 'src/x.js': 'a\nb\nc\n' }, cfgPatch = null) {
  const repo = u.initRepo();
  if (cfgPatch) u.patchCfg(repo, cfgPatch);
  h.git(repo, 'branch', 'feat/x');
  commit(repo, files, 'work');
  const t = u.createTask(repo, { branch: 'feat/x' });
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  return { repo, t };
}

// Commits on feat/x without leaving the main checkout on it.
function commit(repo, files, msg) {
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (base !== 'feat/x') h.git(repo, 'checkout', '-q', 'feat/x');
  for (const [name, text] of Object.entries(files)) u.writeFile(repo, name, text);
  h.git(repo, 'add', '--', ...Object.keys(files));
  h.git(repo, 'commit', '-q', '-m', msg);
  if (base !== 'feat/x') h.git(repo, 'checkout', '-q', base);
}

// One finalized round with no findings, started with `crew review run` (which records the branch tip).
function finalizeRound(repo, t, extra = []) {
  const r = run(repo, 'review', 'run', t.id, ...extra);
  assert.equal(r.code, 0, r.err);
  const round = Number(/round (\d+)/.exec(r.out)[1]);
  const sub = u.crewIn(['review', 'submit', t.id, '--round', String(round)], repo, '[]');
  assert.equal(sub.code, 0, sub.err);
  assert.equal(run(repo, 'review', 'filter', t.id).code, 0);
  assert.equal(run(repo, 'review', 'finalize', t.id).code, 0);
  return round;
}

function sentBackAfterReview(files, cfgPatch) {
  const s = setup(undefined, cfgPatch);
  finalizeRound(s.repo, s.t);
  run(s.repo, 'task', 'send-back', s.t.id, '--note', 'fix it');
  commit(s.repo, files, 'fix');
  run(s.repo, 'task', 'report', s.t.id, '--report-file', u.reportFiles().report);
  return s;
}

const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`;
const accept = (repo, id, ...more) => h.crew(['--lang', 'en', '--json', 'task', 'accept', id, ...more], repo);
const acceptedEvent = (repo, id) => events.read(project.findByCwd(repo).id, { types: 'task.accepted' }).filter((e) => e.task === id).pop();

// ---------------------------------------------------------------- 1. the setting
test('review.enforce, small_fix_lines and docs_globs have defaults and the right type', () => {
  assert.equal(config.DEFAULTS.review.enforce, 'block');
  assert.equal(config.DEFAULTS.review.small_fix_lines, 20);
  assert.deepEqual(config.DEFAULTS.review.docs_globs, ['*.md', '*.txt', 'docs/**']);
  const bad = config.validate({ review: { enforce: 'maybe' } });
  assert.ok(JSON.stringify(bad).includes('review.enforce'), 'a value outside block, remind, off is refused');
});

// ---------------------------------------------------------------- 2. a fix after a send-back
test('fix after a send-back: a small fix with --read-by-orchestrator is accepted and recorded', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': 'a\nb\nc\nd\n' });
  const r = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.equal(r.code, 0, r.err);
  const rule = JSON.parse(r.out).review_rule;
  assert.equal(rule.applied, 'read_by_orchestrator');
  assert.equal(rule.lines, 1);
  assert.equal(rule.note, NOTE);
  assert.deepEqual(JSON.parse(r.out).review_gap, { kind: 'not_re_reviewed', round: 1 }, 'the NOT RE-REVIEWED note stays');
  assert.deepEqual(acceptedEvent(repo, t.id).data.review_rule, rule, 'the accept event carries the rule that applied');
});

test('fix after a send-back: a small fix without the flag is refused, naming the flag and the line count', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': 'a\nb\nc\nd\n' });
  const r = accept(repo, t.id);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--read-by-orchestrator/);
  assert.match(r.err, /1 line\(s\)/);
  assert.equal(run(repo, 'task', 'list', '--state', 'accepted').out.includes(t.id), false, 'the task is not accepted');
});

test('fix after a send-back: exactly the limit passes, one line over is refused even with the flag', skip, () => {
  const at = sentBackAfterReview({ 'src/x.js': lines(20) });   // replaces 3 lines with 20: 20 added + 3 removed
  // the limit is counted as added plus removed, so use a limit that matches this fix exactly
  u.patchCfg(at.repo, (c) => { c.review.small_fix_lines = 23; });
  assert.equal(accept(at.repo, at.t.id, '--read-by-orchestrator', NOTE).code, 0);

  const over = sentBackAfterReview({ 'src/x.js': lines(20) });
  u.patchCfg(over.repo, (c) => { c.review.small_fix_lines = 22; });
  const r = accept(over.repo, over.t.id, '--read-by-orchestrator', NOTE);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /23 line\(s\)/);
  assert.match(r.err, /--since-last-round/);
});

test('fix after a send-back: a later finalized round is enough, and the event says so', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': lines(40) });
  finalizeRound(repo, t);
  const r = accept(repo, t.id);
  assert.equal(r.code, 0, r.err);
  assert.equal(acceptedEvent(repo, t.id).data.review_rule.applied, 'later_round');
});

// ---------------------------------------------------------------- 3. no review at all
test('no review: documentation only needs the flag', skip, () => {
  const { repo, t } = setup({ 'docs/guide.md': lines(50), 'README.txt': lines(30) });
  const no = accept(repo, t.id);
  assert.notEqual(no.code, 0);
  assert.match(no.err, /--read-by-orchestrator/);
  assert.match(no.err, /documentation/);
  const yes = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.equal(yes.code, 0, yes.err);
  const rule = JSON.parse(yes.out).review_rule;
  assert.equal(rule.applied, 'docs_only_read');
  assert.equal(rule.note, NOTE);
  assert.equal(rule.lines, 80);
});

test('no review: documentation mixed with code that is not small is refused even with the flag', skip, () => {
  const { repo, t } = setup({ 'docs/guide.md': lines(5), 'src/big.js': lines(30) });
  const r = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /crew review run/);
  assert.equal(run(repo, 'task', 'list', '--state', 'accepted').out.includes(t.id), false);
});

test('no review: a small code task needs the flag, and review.docs_globs is a setting', skip, () => {
  const small = setup({ 'src/tiny.js': lines(5) });
  assert.notEqual(accept(small.repo, small.t.id).code, 0);
  const ok = accept(small.repo, small.t.id, '--read-by-orchestrator', NOTE);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).review_rule.applied, 'small_read');

  const custom = setup({ 'notes/a.rst': lines(60) }, (c) => { c.review.docs_globs = ['*.rst']; });
  assert.equal(accept(custom.repo, custom.t.id, '--read-by-orchestrator', NOTE).code, 0);
  const plain = setup({ 'notes/a.rst': lines(60) });
  assert.notEqual(accept(plain.repo, plain.t.id, '--read-by-orchestrator', NOTE).code, 0, 'rst is not documentation by default');
});

test('no review: a task whose change cannot be counted is refused', () => {
  const repo = u.initRepo();
  const t = u.createTask(repo, {});
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  const r = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /could not be counted/);
});

// ---------------------------------------------------------------- 4. remind and off
test('remind accepts, prints the message as a warning and records review.rule_unmet', skip, () => {
  const { repo, t } = setup({ 'src/big.js': lines(40) }, (c) => { c.review.enforce = 'remind'; });
  const r = accept(repo, t.id);
  assert.equal(r.code, 0, r.err);
  assert.match(JSON.parse(r.out).review_rule.applied, /none/);
  const ev = events.read(project.findByCwd(repo).id, { types: 'review.rule_unmet' }).filter((e) => e.task === t.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.kind, 'no_review');

  const fix = sentBackAfterReview({ 'src/x.js': lines(40) }, (c) => { c.review.enforce = 'remind'; });
  const f = h.crew(['--lang', 'en', 'task', 'accept', fix.t.id], fix.repo);
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /Warning: task .* accepted without meeting the review rule/);
});

test('off does nothing: no refusal, no event', skip, () => {
  const { repo, t } = setup({ 'src/big.js': lines(40) }, (c) => { c.review.enforce = 'off'; });
  const r = accept(repo, t.id);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).review_rule, undefined);
  assert.equal(events.read(project.findByCwd(repo).id, { types: 'review.rule_unmet' }).length, 0);
});

test('a task whose last round is finalized with no send-back is accepted as before, with no rule recorded', skip, () => {
  const { repo, t } = setup({ 'src/big.js': lines(40) });
  finalizeRound(repo, t);
  const r = accept(repo, t.id);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).review_rule, undefined);
});

// ---------------------------------------------------------------- 5. the scoped round
test('review run records the branch tip, and --since-last-round diffs from it and lists the earlier findings', skip, () => {
  const { repo, t } = setup();
  const tip1 = h.git(repo, 'rev-parse', 'feat/x').trim();
  const r1 = run(repo, 'review', 'run', t.id);
  assert.equal(r1.code, 0, r1.err);
  const dir = path.join(project.findByCwd(repo) && require('../lib/core/paths').taskDir(project.findByCwd(repo).id, t.id), 'findings');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '1.tip.json'), 'utf8')).tip, tip1);
  u.crewIn(['review', 'submit', t.id, '--round', '1'], repo, JSON.stringify([u.finding('f1', { file: 'src/x.js', line: 1, snippet: 'a' })]));
  run(repo, 'review', 'filter', t.id);
  commit(repo, { 'src/x.js': 'a\nb\nc\nd\n' }, 'fix');
  const scoped = h.crew(['--lang', 'en', '--json', 'review', 'run', t.id, '--since-last-round'], repo);
  assert.equal(scoped.code, 0, scoped.err);
  const prompt = JSON.parse(scoped.out).prompt;
  assert.ok(prompt.includes(`diff ${tip1} feat/x`), 'the diff runs from the tip recorded for the previous round');
  assert.match(prompt, /"verdict": "addressed\|not addressed"/);
  assert.match(prompt, /new problems found in the fix diff only/);
  assert.match(prompt, /f1 \[major\] src\/x\.js:1/);
  const full = h.crew(['--lang', 'en', '--json', 'review', 'run', t.id], repo);
  assert.ok(!JSON.parse(full.out).prompt.includes('not addressed'), 'the default round is still the full diff');
});

const findingsDir = (repo, id) => path.join(require('../lib/core/paths').taskDir(project.findByCwd(repo).id, id), 'findings');

test('--since-last-round with no earlier round that has a recorded tip falls back to the full diff, with one line saying why', skip, () => {
  const { repo, t } = setup();
  const text = h.crew(['--lang', 'en', 'review', 'run', t.id, '--since-last-round', '--round', '1'], repo).out;
  assert.equal(text.split('\n').filter((l) => /no earlier round has a recorded branch tip/.test(l)).length, 1);
  const r = h.crew(['--lang', 'en', '--json', 'review', 'run', t.id, '--since-last-round', '--round', '1'], repo);
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.equal(d.scope_note, 'full_diff');
  assert.ok(!d.prompt.includes('not addressed'), 'no scoped lines');
  assert.match(d.prompt, /diff \S+ feat\/x/);
});

test('fix after a send-back, last round has no recorded tip: the refusal says to run a normal full-diff round, and that round works', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': 'a\nb\nc\nd\n' });
  fs.unlinkSync(path.join(findingsDir(repo, t.id), '1.tip.json'));
  const r = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /No branch tip was recorded for review round 1/);
  assert.match(r.err, /crew review run \S+, then/);
  assert.ok(!r.err.includes('--since-last-round'), 'it does not point to the dead end');
  const scoped = h.crew(['--lang', 'en', '--json', 'review', 'run', t.id, '--since-last-round'], repo);
  assert.equal(scoped.code, 0, scoped.err);
  finalizeRound(repo, t);
  assert.equal(accept(repo, t.id).code, 0);
});

test('--since-last-round with an external engine: verdicts come back inside the JSON, stored and printed apart from new findings', skip, () => {
  const { repo, t } = setup();
  run(repo, 'review', 'run', t.id);
  u.crewIn(['review', 'submit', t.id, '--round', '1'], repo, JSON.stringify([u.finding('f1', { file: 'src/x.js', line: 1, snippet: 'a' })]));
  run(repo, 'review', 'filter', t.id);
  commit(repo, { 'src/x.js': 'a\nb\nc\nd\n' }, 'fix');
  const scratch = h.tmpDir();
  const payload = u.writeFile(scratch, 'out.json', JSON.stringify([
    { id: 'f1', verdict: 'not addressed', evidence: 'src/x.js:1 still wrong' },
    u.finding('f2', { file: 'src/x.js', line: 4, snippet: 'd' }),
  ]));
  const script = u.writeFile(scratch, 'fake.js', [
    "const fs = require('fs'); let i = '';",
    "process.stdin.on('data', (d) => { i += d; });",
    "process.stdin.on('end', () => { fs.writeFileSync(process.argv[3], i); console.log('```json\\n' + fs.readFileSync(process.argv[2], 'utf8') + '\\n```'); });",
  ].join('\n'));
  const promptFile = path.join(scratch, 'prompt.txt');
  fs.mkdirSync(path.dirname(require('../lib/core/paths').configFile()), { recursive: true });
  fs.writeFileSync(require('../lib/core/paths').configFile(), JSON.stringify({ version: 1, engines: { fake: { command: process.execPath, args: [script, payload, promptFile] } } }));
  const r = h.crew(['--lang', 'en', '--json', 'review', 'run', t.id, '--since-last-round', '--engine', 'fake'], repo);
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.equal(d.count, 1, 'only the new finding is a finding');
  assert.deepEqual(d.verdicts, [{ id: 'f1', verdict: 'not addressed', evidence: 'src/x.js:1 still wrong' }]);
  const dir = findingsDir(repo, t.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '2.raw.json'), 'utf8')).map((f) => f.id), ['f2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '2.verdicts.json'), 'utf8')).map((v) => v.id), ['f1']);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /"verdict": "addressed\|not addressed"/);
  assert.ok(!prompt.includes('one line each'), 'the engine prompt does not ask for text verdict lines');
  const text = h.crew(['--lang', 'en', 'review', 'run', t.id, '--since-last-round', '--engine', 'fake', '--round', '2'], repo).out;
  assert.match(text, /Earlier finding f1: not addressed/);
});

// ---------------------------------------------------------------- 6. release record
test('release record still prints NOT RE-REVIEWED for a fix accepted with --read-by-orchestrator', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': 'a\nb\nc\nd\n' });
  h.git(repo, 'tag', 'v0.0.1');
  assert.equal(accept(repo, t.id, '--read-by-orchestrator', NOTE).code, 0);
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
  h.git(repo, 'tag', 'v0.0.2');
  assert.equal(run(repo, 'task', 'merge', t.id).code, 0);
  const rec = h.crew(['--lang', 'en', 'release', 'record', '0.0.2'], repo);
  assert.equal(rec.code, 0, rec.err);
  assert.match(fs.readFileSync(path.join(repo, '.crew', 'releases', '0.0.2.md'), 'utf8'), /NOT RE-REVIEWED/);
});

test('release record prints NO REVIEW and the --read-by-orchestrator note for a small task accepted with no review', skip, () => {
  const { repo, t } = setup({ 'src/tiny.js': lines(5) });
  h.git(repo, 'tag', 'v0.0.1');
  assert.equal(accept(repo, t.id, '--read-by-orchestrator', NOTE).code, 0);
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
  h.git(repo, 'tag', 'v0.0.2');
  assert.equal(run(repo, 'task', 'merge', t.id).code, 0);
  const rec = h.crew(['--lang', 'en', 'release', 'record', '0.0.2'], repo);
  assert.equal(rec.code, 0, rec.err);
  const text = fs.readFileSync(path.join(repo, '.crew', 'releases', '0.0.2.md'), 'utf8');
  assert.match(text, /NO REVIEW/);
  assert.ok(text.includes(`--read-by-orchestrator): ${NOTE}`), 'the note is named beside the NO REVIEW line');
});

test('release record names the note beside NOT RE-REVIEWED too', skip, () => {
  const { repo, t } = sentBackAfterReview({ 'src/x.js': 'a\nb\nc\nd\n' });
  h.git(repo, 'tag', 'v0.0.1');
  assert.equal(accept(repo, t.id, '--read-by-orchestrator', NOTE).code, 0);
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
  h.git(repo, 'tag', 'v0.0.2');
  assert.equal(run(repo, 'task', 'merge', t.id).code, 0);
  assert.equal(h.crew(['--lang', 'en', 'release', 'record', '0.0.2'], repo).code, 0);
  assert.ok(fs.readFileSync(path.join(repo, '.crew', 'releases', '0.0.2.md'), 'utf8').includes(`--read-by-orchestrator): ${NOTE}`));
});

// ---------------------------------------------------------------- review rounds that were never finalized
test('a round submitted with zero findings and never finalized is no review: a big task is refused', skip, () => {
  const { repo, t } = setup({ 'src/big.js': lines(40) });
  const r1 = run(repo, 'review', 'run', t.id);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(u.crewIn(['review', 'submit', t.id, '--round', '1'], repo, '[]').code, 0);
  const r = accept(repo, t.id);
  assert.notEqual(r.code, 0, 'a round with no finalize lets nothing through');
  assert.match(r.err, /crew review run/);
});

// ---------------------------------------------------------------- the size check starts from the scope base stored at dispatch
test('a small task on a branch stacked on unaccepted work is counted from its stored scope base', skip, () => {
  const repo = u.initRepo();
  const main = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(repo, 'checkout', '-q', '-b', 'feat/base');
  u.writeFile(repo, 'src/base.js', lines(60));
  h.git(repo, 'add', '--', 'src/base.js');
  h.git(repo, 'commit', '-q', '-m', 'unaccepted base work');
  h.git(repo, 'branch', 'feat/x');
  h.git(repo, 'checkout', '-q', main);
  const t = u.createTask(repo, { branch: 'feat/x' });
  const pid = project.findByCwd(repo).id;
  assert.ok(require('../lib/core/tasks').recordScopeBase(pid, t.id, repo), 'the base is stored at dispatch');
  commit(repo, { 'src/small.js': lines(3) }, 'small work');
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  const r = accept(repo, t.id, '--read-by-orchestrator', NOTE);
  assert.equal(r.code, 0, r.err);
  const rule = JSON.parse(r.out).review_rule;
  assert.equal(rule.applied, 'small_read');
  assert.equal(rule.lines, 3, 'only the task\'s own lines are counted, not the 60 of the work it stacks on');
});
