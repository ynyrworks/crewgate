'use strict';
// The review pipeline's friction fixes: tool rules in the prompts, saving that always works, `review keep`, accept after dismissals,
// the default dismiss scope, verdicts of a scoped round with the Claude reviewer, and the off setting of review.enforce.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const project = require('../lib/core/project');
const paths = require('../lib/core/paths');
const events = require('../lib/core/events');

const skip = { skip: !h.hasGit() };
const run = (repo, ...args) => h.crew(['--lang', 'en', ...args], repo);
const json = (repo, ...args) => u.crewJson(['--lang', 'en', ...args], repo);
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function commit(repo, files, msg) {
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (base !== 'feat/x') h.git(repo, 'checkout', '-q', 'feat/x');
  for (const [name, text] of Object.entries(files)) u.writeFile(repo, name, text);
  h.git(repo, 'add', '--', ...Object.keys(files));
  h.git(repo, 'commit', '-q', '-m', msg);
  if (base !== 'feat/x') h.git(repo, 'checkout', '-q', base);
}

function setup(cfgPatch = null) {
  const repo = u.initRepo();
  if (cfgPatch) u.patchCfg(repo, cfgPatch);
  h.git(repo, 'branch', 'feat/x');
  commit(repo, { 'src/x.js': 'a\nb\nc\n' }, 'work');
  const t = u.createTask(repo, { branch: 'feat/x' });
  assert.equal(run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report).code, 0);
  return { repo, t };
}
const findingsDir = (repo, id) => path.join(paths.taskDir(project.findByCwd(repo).id, id), 'findings');
const submitIn = (repo, t, list, ...more) => u.crewIn(['review', 'submit', t.id, ...more], repo, JSON.stringify(list));
const fnd = (id, over = {}) => u.finding(id, { file: 'src/x.js', line: 1, snippet: 'a', ...over });

// Three raised, one kept, two dropped (low confidence, inference): round 1 filtered.
function filtered(cfgPatch) {
  const s = setup(cfgPatch);
  assert.equal(run(s.repo, 'review', 'run', s.t.id).code, 0);
  assert.equal(submitIn(s.repo, s.t, [
    fnd('f1'), fnd('f2', { confidence: 0.2, snippet: 'b' }), fnd('f3', { verified_by: 'inference', snippet: 'c' }),
  ], '--round', '1').code, 0);
  const f = json(s.repo, 'review', 'filter', s.t.id);
  assert.equal(f.code, 0, f.err);
  return { ...s, filter: f.data };
}

// ---------------------------------------------------------------- 1. tool rules in every prompt and agent file
const RULES = [/Read tool, not with cat/, /one command per Bash call.*no ;, && or pipes/, /git with -C <path>.*instead of changing directory/];
const hasRules = (text, label) => { for (const re of RULES) assert.match(text, re, label); };
const SAVE = [/If saving is refused, end with the JSON array as the whole final message and nothing else/, /--file or --json/];

test('the printed reviewer and refuter prompts of a task review carry the tool rules and the save fallback', skip, () => {
  const { repo, t, filter } = filtered();
  const rev = json(repo, 'review', 'run', t.id);
  hasRules(rev.data.prompt, 'reviewer prompt');
  for (const re of SAVE) assert.match(rev.data.prompt, re);
  assert.ok(rev.data.prompt.indexOf('piping it to') < rev.data.prompt.indexOf('If saving is refused'), 'the stdin form comes first');
  hasRules(filter.refuter.prompt, 'refuter prompt');
  for (const re of SAVE) assert.match(filter.refuter.prompt, re);
  assert.ok(filter.refuter.prompt.indexOf('piping it to') < filter.refuter.prompt.indexOf('If saving is refused'));
});

test('the prompt builders add the tool rules and the save fallback themselves (no line matching in the command)', () => {
  const rv = require('../lib/features/review');
  const pr = require('../lib/core/plan-review');
  const task = { id: 't-1' };
  const base = { task, briefPath: 'b', reviewPath: 'r', diffCmd: 'git -C x diff', keptPath: 'k', categories: ['correctness'], round: 1, rawPath: 'raw', cli: 'crew' };
  const texts = [
    rv.reviewerInstructions(base), rv.refuterInstructions(base),
    pr.reviewerPrompt({ slug: 's', round: 1, packetPath: 'p', rawPath: 'raw', scope: null, max: 4, cli: 'crew' }),
    pr.refuterPrompt({ slug: 's', round: 1, packetPath: 'p', keptPath: 'k', cli: 'crew' }),
  ];
  texts.forEach((t, i) => { hasRules(t, `builder ${i}`); for (const re of SAVE) assert.match(t, re); });
  assert.deepEqual(pr.TOOL_RULES, rv.TOOL_RULES);
});

test('the printed reviewer and refuter prompts of a plan review carry the tool rules and the save fallback', skip, () => {
  const repo = u.initRepo();
  const planFile = path.join(repo, '.crew', 'plans', 'demo.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# Demo\nGoal text.\n\n- [ ] Step one <!-- id:n1 added:2026-10-01 origin:plan -->\n');
  const r = json(repo, 'plan', 'review', 'run', 'demo');
  assert.equal(r.code, 0, r.err);
  hasRules(r.data.prompt, 'plan reviewer prompt');
  for (const re of SAVE) assert.match(r.data.prompt, re);
  assert.ok(r.data.prompt.indexOf('piping it to') < r.data.prompt.indexOf('If saving is refused'));
  const finding = { node: 'n1', kind: 'vague-done', claim: 'c', evidence: ['n1'], proposal: { action: 'change', text: 'Step one, sharper', done_when: 'a test shows it' } };
  assert.equal(u.crewIn(['plan', 'review', 'submit', 'demo', '--round', String(r.data.round)], repo, JSON.stringify([finding])).code, 0);
  const f = json(repo, 'plan', 'review', 'filter', 'demo', '--round', String(r.data.round));
  assert.equal(f.code, 0, f.err);
  hasRules(f.data.refuter.prompt, 'plan refuter prompt');
  for (const re of SAVE) assert.match(f.data.refuter.prompt, re);
});

test('the agent files and their init templates carry the tool rules', () => {
  for (const dir of [['agents'], ['templates', 'agents']]) {
    for (const n of ['crew-reviewer', 'crew-refuter']) {
      const text = read(...dir, `${n}.md`);
      assert.match(text, /`Read` tool, never with `cat`/, `${dir.join('/')}/${n}`);
      assert.match(text, /one command per Bash call/);
      assert.match(text, /git with `-C <path>`/);
      assert.match(text, /as your whole final message and nothing else/);
    }
  }
});

// ---------------------------------------------------------------- 2. saving always works
test('review submit takes the JSON on stdin, with --file, and with --json (both spellings)', skip, () => {
  const { repo, t } = setup();
  run(repo, 'review', 'run', t.id);
  const list = [fnd('f1')];
  const raw = path.join(findingsDir(repo, t.id), '1.raw.json');
  const ids = () => JSON.parse(fs.readFileSync(raw, 'utf8')).map((f) => f.id);

  assert.equal(submitIn(repo, t, list, '--round', '1').code, 0);
  assert.deepEqual(ids(), ['f1']);
  const file = u.writeFile(h.tmpDir(), 'a.json', JSON.stringify([fnd('f2')]));
  const viaFile = run(repo, 'review', 'submit', t.id, '--round', '1', '--file', file);
  assert.equal(viaFile.code, 0, viaFile.err);
  assert.deepEqual(ids(), ['f2']);
  const eq = run(repo, 'review', 'submit', t.id, '--round', '1', `--json=${JSON.stringify([fnd('f3')])}`);
  assert.equal(eq.code, 0, eq.err);
  assert.deepEqual(ids(), ['f3']);
  const spaced = run(repo, 'review', 'submit', t.id, '--round', '1', '--json', JSON.stringify([fnd('f4'), fnd('f5', { snippet: 'b' })]));
  assert.equal(spaced.code, 0, spaced.err);
  assert.deepEqual(ids(), ['f4', 'f5']);
  // a refutation list goes the same way
  const ref = run(repo, 'review', 'submit', t.id, '--round', '1', '--kind', 'refutations', '--json', JSON.stringify([{ id: 'f4', verdict: 'upheld', evidence: 'src/x.js:1 ok' }]));
  assert.equal(ref.code, 0, ref.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(findingsDir(repo, t.id), '1.refutations.json'), 'utf8'))[0].id, 'f4');
  // a stray word that is not JSON is still an error
  assert.equal(run(repo, 'review', 'submit', t.id, '--round', '1', 'oops').code, 2);
});

test('plan review submit takes --file and --json too', skip, () => {
  const repo = u.initRepo();
  const planFile = path.join(repo, '.crew', 'plans', 'demo.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# Demo\nGoal text.\n\n- [ ] Step one <!-- id:n1 added:2026-10-01 origin:plan -->\n');
  const r = json(repo, 'plan', 'review', 'run', 'demo');
  const f = { node: 'n1', kind: 'vague-done', claim: 'c', evidence: ['n1'], proposal: { action: 'change', text: 'x', done_when: 'a test shows it' } };
  const rawFile = r.data.raw_path;
  const viaJson = run(repo, 'plan', 'review', 'submit', 'demo', '--round', String(r.data.round), '--json', JSON.stringify([f, { ...f, claim: 'd' }]));
  assert.equal(viaJson.code, 0, viaJson.err);
  assert.equal(JSON.parse(fs.readFileSync(rawFile, 'utf8')).length, 2);
  const file = u.writeFile(h.tmpDir(), 'p.json', JSON.stringify([f]));
  const viaFile = run(repo, 'plan', 'review', 'submit', 'demo', '--round', String(r.data.round), '--file', file);
  assert.equal(viaFile.code, 0, viaFile.err);
  assert.equal(JSON.parse(fs.readFileSync(rawFile, 'utf8')).length, 1);
  const eq = run(repo, 'plan', 'review', 'submit', 'demo', '--round', String(r.data.round), `--json=${JSON.stringify([f, f, f])}`);
  assert.equal(eq.code, 0, eq.err);
  assert.equal(JSON.parse(fs.readFileSync(rawFile, 'utf8')).length, 3);
});

// ---------------------------------------------------------------- 3. review keep
test('review keep puts a dropped finding back among the kept ones; show names the reason; a second filter keeps it', skip, () => {
  const { repo, t } = filtered();
  const dir = findingsDir(repo, t.id);
  const ids = (suffix) => JSON.parse(fs.readFileSync(path.join(dir, `1.${suffix}.json`), 'utf8')).map((f) => (f.finding || f).id);
  assert.deepEqual(ids('kept'), ['f1']);
  const k = json(repo, 'review', 'keep', t.id, 'f3', '--reason', 'the trace in src/x.js is real');
  assert.equal(k.code, 0, k.err);
  assert.deepEqual(ids('kept'), ['f1', 'f3']);
  assert.deepEqual(ids('filtered'), ['f2']);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, '1.kept.json'), 'utf8')).find((f) => f.id === 'f3');
  assert.equal(kept.kept_by, 'orchestrator');
  assert.equal(kept.keep_reason, 'the trace in src/x.js is real');
  const show = run(repo, 'review', 'show', t.id);
  assert.match(show.out, /f3 .*src\/x\.js:1/);
  assert.match(show.out, /kept by the orchestrator: the trace in src\/x\.js is real/);
  assert.match(show.out, /Dropped by reason: low-confidence 1/);
  // the refuter sees it
  const again = json(repo, 'review', 'filter', t.id);
  assert.deepEqual(again.data.kept.map((f) => f.id), ['f1', 'f3']);
  assert.match(again.data.refuter.prompt, /round 1/);
  assert.deepEqual(ids('kept'), ['f1', 'f3'], 'a second filter does not undo the keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '1.filtered.json'), 'utf8')).map((d) => d.finding.id), ['f2']);
  // it goes through finalize like any kept finding
  assert.equal(submitIn(repo, t, [{ id: 'f1', verdict: 'upheld', evidence: 'x' }, { id: 'f3', verdict: 'uncertain', evidence: 'y' }], '--round', '1', '--kind', 'refutations').code, 0);
  const fin = json(repo, 'review', 'finalize', t.id);
  assert.equal(fin.code, 0, fin.err);
  assert.deepEqual(fin.data.findings.map((f) => f.id), ['f1', 'f3']);
  assert.match(run(repo, 'review', 'show', t.id).out, /kept by the orchestrator: the trace/);
});

test('review keep refuses without a reason, for an unknown id, for an invalid entry and after the round is finalized', skip, () => {
  const { repo, t } = filtered();
  const noReason = run(repo, 'review', 'keep', t.id, 'f3');
  assert.equal(noReason.code, 2);
  assert.match(noReason.err, /--reason/);
  const unknown = run(repo, 'review', 'keep', t.id, 'nope', '--reason', 'x');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /nope is not among the findings the filter dropped in round 1/);
  const alreadyKept = run(repo, 'review', 'keep', t.id, 'f1', '--reason', 'x');
  assert.equal(alreadyKept.code, 1, 'a finding that is kept already was not dropped');
  // an invalid entry cannot be kept
  run(repo, 'review', 'run', t.id);
  submitIn(repo, t, [fnd('g1'), { id: 'bad' }], '--round', '2');
  run(repo, 'review', 'filter', t.id);
  const bad = run(repo, 'review', 'keep', t.id, 'bad', '--reason', 'x');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /invalid/);
  // finalize round 2, then keep refuses
  submitIn(repo, t, [{ id: 'g1', verdict: 'upheld', evidence: 'x' }], '--round', '2', '--kind', 'refutations');
  assert.equal(run(repo, 'review', 'finalize', t.id).code, 0);
  const late = run(repo, 'review', 'keep', t.id, 'bad', '--reason', 'x');
  assert.equal(late.code, 1);
  assert.match(late.err, /already finalized/);
});

// ---------------------------------------------------------------- 4. dismissals close the round
const acceptJson = (repo, id, ...more) => h.crew(['--lang', 'en', '--json', 'task', 'accept', id, ...more], repo);

test('accept treats a round whose kept findings were all dismissed as decided, and records why', skip, () => {
  const { repo, t } = filtered();
  const refused = acceptJson(repo, t.id);
  assert.equal(refused.code, 1, 'a kept finding that is neither dismissed nor judged is refused as before');
  assert.match(refused.err, /did not go through the refuter/);
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'fine here').code, 0);
  const ok = acceptJson(repo, t.id);
  assert.equal(ok.code, 0, ok.err);
  const d = JSON.parse(ok.out);
  assert.equal(d.review_gap.kind, 'dismissed');
  assert.equal(d.review_gap.round, 1);
  const ev = events.read(project.findByCwd(repo).id, { types: 'task.accepted' }).filter((e) => e.task === t.id).pop();
  assert.equal(ev.data.closed_by, 'dismissals');
  assert.equal(ev.data.skip_refuter, undefined);
});

test('accept still refuses when one kept finding is neither dismissed nor judged by the refuter', skip, () => {
  const { repo, t } = filtered();
  assert.equal(run(repo, 'review', 'keep', t.id, 'f3', '--reason', 'real').code, 0);
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'fine here').code, 0);
  const r = acceptJson(repo, t.id);
  assert.equal(r.code, 1);
  assert.match(r.err, /2 finding\(s\) that did not go through the refuter/);
  // judged by the refuter (not finalized) and the other dismissed: decided
  assert.equal(submitIn(repo, t, [{ id: 'f3', verdict: 'refuted', evidence: 'src/x.js:1 handled' }], '--round', '1', '--kind', 'refutations').code, 0);
  assert.equal(acceptJson(repo, t.id).code, 0);
});

test('a dismissal of an earlier round does not close the latest round', skip, () => {
  const { repo, t } = filtered();
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'round one only').code, 0);
  run(repo, 'review', 'run', t.id);
  submitIn(repo, t, [fnd('f1', { snippet: 'b' })], '--round', '2');
  run(repo, 'review', 'filter', t.id);
  const r = acceptJson(repo, t.id);
  assert.equal(r.code, 1, 'f1 of round 2 is a different finding from f1 of round 1');
});

test('finalize with no refutations says in one line which command is missing', skip, () => {
  const { repo, t } = filtered();
  const r = run(repo, 'review', 'finalize', t.id);
  assert.equal(r.code, 2, 'a missing step is a usage error, as before the review-flow change');
  assert.equal(r.err.split('\n').length, 1);
  assert.match(r.err, new RegExp(`crew review submit ${t.id} --round 1 --kind refutations`));
});

// ---------------------------------------------------------------- 5. dismiss without --scope
test('dismiss without --scope uses once and says so; --reason stays required; an explicit scope says nothing extra', skip, () => {
  const { repo, t } = filtered();
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1').code, 2, 'reason is required');
  const d = json(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'fine here');
  assert.equal(d.code, 0, d.err);
  assert.equal(d.data.entry.scope, 'once');
  const text = run(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'again').out;
  assert.match(text, /No --scope given: used once/);
  const explicit = run(repo, 'review', 'dismiss', t.id, 'f1', '--scope', 'once', '--reason', 'again').out;
  assert.ok(!/No --scope given/.test(explicit));
});

// ---------------------------------------------------------------- 6. the scoped round with the Claude reviewer
test('--since-last-round with the Claude reviewer: one prompt, verdicts saved from the submitted JSON and shown', skip, () => {
  const { repo, t } = setup();
  run(repo, 'review', 'run', t.id);
  submitIn(repo, t, [fnd('f1')], '--round', '1');
  run(repo, 'review', 'filter', t.id);
  commit(repo, { 'src/x.js': 'a\nb\nc\nd\n' }, 'fix');
  const scoped = json(repo, 'review', 'run', t.id, '--since-last-round');
  assert.equal(scoped.code, 0, scoped.err);
  const prompt = scoped.data.prompt;
  assert.match(prompt, /"verdict": "addressed\|not addressed"/);
  assert.ok(!prompt.includes('one line each'), 'no text-verdict form');
  assert.ok(!/final message[^\n]*verdicts/.test(prompt), 'the final message is not asked for verdicts');
  assert.match(prompt, /Otherwise your final message must only say how many findings you saved/);
  hasRules(prompt, 'scoped prompt');

  const sub = json(repo, 'review', 'submit', t.id, '--round', String(scoped.data.round), '--file', u.writeFile(h.tmpDir(), 's.json', JSON.stringify([
    { id: 'f1', verdict: 'not addressed', evidence: 'src/x.js:1 still wrong' },
    fnd('f2', { line: 4, snippet: 'd' }),
  ])));
  assert.equal(sub.code, 0, sub.err);
  assert.equal(sub.data.count, 1, 'only the new finding is a finding');
  assert.deepEqual(sub.data.verdicts, [{ id: 'f1', verdict: 'not addressed', evidence: 'src/x.js:1 still wrong' }]);
  const dir = findingsDir(repo, t.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '2.raw.json'), 'utf8')).map((f) => f.id), ['f2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '2.verdicts.json'), 'utf8')).map((v) => v.id), ['f1']);
  const again = run(repo, 'review', 'submit', t.id, '--round', '2', '--file', u.writeFile(h.tmpDir(), 's2.json', JSON.stringify([{ id: 'f1', verdict: 'not addressed', evidence: 'src/x.js:1 still wrong' }])));
  assert.match(again.out, /Reviewer reviewer gave a verdict on 1 earlier finding/);
  assert.ok(!/Engine/.test(again.out), 'the Claude path does not say engine');
  assert.match(run(repo, 'review', 'submit', t.id, '--round', '2', '--file', path.join(h.tmpDir(), 'none.json')).err, /./, 'a missing file is still an error');
  run(repo, 'review', 'filter', t.id);
  const show = run(repo, 'review', 'show', t.id, '--round', '2');
  assert.match(show.out, /Earlier finding f1: not addressed/);
  // a later full round has no scope: entries with a "verdict" field are not split off
  const full = json(repo, 'review', 'run', t.id);
  assert.ok(!full.data.prompt.includes('not addressed'));
  assert.ok(!fs.existsSync(path.join(dir, '3.scope.json')));
});

// ---------------------------------------------------------------- 7. review.enforce off
test('with review.enforce off a zero-finding round that was never finalized is not "no review" in the accept output', skip, () => {
  const off = setup((c) => { c.review.enforce = 'off'; });
  run(off.repo, 'review', 'run', off.t.id);
  assert.equal(submitIn(off.repo, off.t, [], '--round', '1').code, 0);
  const r = h.crew(['--lang', 'en', '--json', 'task', 'accept', off.t.id], off.repo);
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.equal(d.review_gap, null);
  assert.equal(d.review_rule, undefined);
  assert.equal(events.read(project.findByCwd(off.repo).id, { types: 'review.rule_unmet' }).length, 0);
  // the rule on: the same round is "no review" and the big task is refused or recorded
  const on = setup((c) => { c.review.enforce = 'remind'; });
  run(on.repo, 'review', 'run', on.t.id);
  submitIn(on.repo, on.t, [], '--round', '1');
  const r2 = h.crew(['--lang', 'en', '--json', 'task', 'accept', on.t.id], on.repo);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(JSON.parse(r2.out).review_gap.kind, 'none');
});
