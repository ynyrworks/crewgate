'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const config = require('../lib/core/config');
const rv = require('../lib/features/review');
const project = require('../lib/core/project');
const paths = require('../lib/core/paths');
const events = require('../lib/core/events');

const run = (repo, ...args) => h.crew(args, repo);
const cfgOf = () => structuredClone(config.DEFAULTS);
const SRC = 'const total = compute(1);\nmodule.exports = total;\n';

// ---------------------------------------------------------------- pure pieces
test('validateFinding reports every problem instead of throwing', () => {
  const cats = cfgOf().review.categories;
  assert.deepEqual(rv.validateFinding(u.finding('f1'), cats), []);
  assert.deepEqual(rv.validateFinding(null, cats), ['not an object']);
  assert.deepEqual(rv.validateFinding('x', cats), ['not an object']);
  const p = rv.validateFinding({ id: 'a', category: 'bogus', severity: 'huge', line: 0, evidence: [], verified_by: 'guess', confidence: 3 }, cats);
  for (const key of ['category', 'severity', 'file', 'line', 'snippet', 'claim', 'evidence', 'verified_by', 'confidence']) {
    assert.ok(p.some((x) => x.startsWith(`${key}:`)), `expected a problem for ${key}`);
  }
  assert.ok(rv.validateFinding(u.finding('f1', { evidence: ['ok', ''] }), cats).length);
});

test('fingerprint ignores whitespace in the snippet and path separators, but not category or symbol', () => {
  const a = rv.fingerprint(u.finding('a', { snippet: 'const  x =\n 1;', file: 'src\\x.js' }));
  const b = rv.fingerprint(u.finding('b', { snippet: 'const x = 1;', file: 'src/x.js' }));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, rv.fingerprint(u.finding('c', { snippet: 'const x = 1;', category: 'regression' })));
  assert.notEqual(a, rv.fingerprint(u.finding('d', { snippet: 'const x = 1;', symbol: 'other' })));
});

test('filter: schema failures are dropped with a reason, duplicates too, and nothing crashes', () => {
  const cfg = cfgOf();
  const { kept, dropped } = rv.filterFindings([
    u.finding('ok'), null, 'text', 5, { id: 'broken' }, u.finding('ok'),
  ], { cfg });
  assert.deepEqual(kept.map((f) => f.id), ['ok']);
  assert.equal(dropped.length, 5);
  assert.ok(dropped.every((d) => d.reason === 'invalid'));
  assert.ok(dropped.some((d) => /duplicate/.test(d.detail)));
});

test('filter: inference, low confidence, downgrade patterns and the nit cap', () => {
  const cfg = cfgOf();
  const list = [
    u.finding('inf', { verified_by: 'inference' }),
    u.finding('low', { confidence: 0.3 }),
    u.finding('edge', { confidence: 0.6 }),
    u.finding('race', { pattern: 'theoretical-race', snippet: 'race();' }),
    u.finding('race-repro', { pattern: 'theoretical-race', verified_by: 'repro', snippet: 'race2();' }),
    u.finding('sty', { category: 'style', tags: ['style'] }),
  ];
  cfg.review.categories.push('style');
  let r = rv.filterFindings(list, { cfg });
  const why = Object.fromEntries(r.dropped.map((d) => [d.finding.id, d.reason]));
  assert.equal(why.inf, 'inference');
  assert.equal(why.low, 'low-confidence');
  assert.deepEqual(r.kept.map((f) => f.id), ['edge', 'race', 'race-repro', 'sty']);
  const byId = Object.fromEntries(r.kept.map((f) => [f.id, f]));
  assert.equal(byId.race.category, 'nit');
  assert.equal(byId.race.severity, 'nit');
  assert.equal(byId.race.downgraded_from.pattern, 'theoretical-race');
  assert.equal(byId['race-repro'].category, 'correctness', 'a reproducible race keeps its category');
  assert.equal(byId.sty.category, 'nit');
  cfg.review.report_inference = true;
  r = rv.filterFindings([u.finding('inf', { verified_by: 'inference' })], { cfg });
  assert.equal(r.kept.length, 1);

  const nits = Array.from({ length: 8 }, (_, i) => u.finding(`n${i}`, { category: 'nit', severity: 'nit', confidence: 0.6 + i * 0.01, snippet: `s${i}` }));
  r = rv.filterFindings(nits, { cfg: cfgOf() });
  assert.equal(r.kept.length, 5);
  assert.deepEqual(r.dropped.map((d) => d.finding.id).sort(), ['n0', 'n1', 'n2']);
  assert.ok(r.dropped.every((d) => d.reason === 'nit-cap'));
});

test('ledger: always matches regardless of the file; once matches only while the snippet exists', () => {
  const dir = h.tmpDir();
  u.writeFile(dir, 'src/x.js', SRC);
  const f = u.finding('f1');
  const entry = (scope) => ({ fingerprint: rv.fingerprint(f), scope, reason: 'r' });
  const cfg = cfgOf();
  const filt = (scope, extra) => rv.filterFindings([f], { cfg, ledger: [entry(scope)], baseDirs: [dir], ...extra });
  assert.equal(filt('once').dropped[0].reason, 'dismissed');
  assert.equal(filt('always').dropped[0].reason, 'dismissed');
  // the snippet disappears from the file: once stops matching, always keeps matching
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'const total = other();\n');
  assert.equal(filt('once').kept.length, 1);
  assert.equal(filt('always').kept.length, 0);
  // whitespace changes alone do not break a once entry
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'const   total =\n   compute(1);\n');
  assert.equal(filt('once').kept.length, 0);
  // a missing file or a path escaping the base never matches a once entry
  assert.equal(filt('once', { baseDirs: [h.tmpDir()] }).kept.length, 1);
  const escape = rv.filterFindings([{ ...f, file: '../x.js' }], { cfg, ledger: [{ ...entry('once'), fingerprint: rv.fingerprint({ ...f, file: '../x.js' }) }], baseDirs: [path.join(dir, 'src')] });
  assert.equal(escape.kept.length, 1);
});

test('applyRefutations: refuted dropped, upheld and uncertain kept, bad entries reported', () => {
  const kept = [u.finding('a'), u.finding('b'), u.finding('c'), u.finding('d'), u.finding('e')];
  const { findings, dropped, problems } = rv.applyRefutations(kept, [
    { id: 'a', verdict: 'upheld', evidence: 'x.js:1' },
    { id: 'b', verdict: 'refuted', evidence: 'x.js:9 handled' },
    { id: 'c', verdict: 'refuted' },
    { id: 'd', verdict: 'maybe' },
    { id: 'zzz', verdict: 'upheld' },
    null,
  ]);
  assert.deepEqual(findings.map((f) => [f.id, f.verdict]), [['a', 'upheld'], ['c', 'uncertain'], ['d', 'uncertain'], ['e', 'uncertain']]);
  assert.deepEqual(dropped.map((d) => d.finding.id), ['b']);
  assert.ok(problems.length >= 4);
});

test('extractJsonArray handles plain, fenced and prose-wrapped output', () => {
  assert.deepEqual(rv.extractJsonArray('[1,2]'), [1, 2]);
  assert.deepEqual(rv.extractJsonArray('Here you go:\n```json\n[{"a":1}]\n```\nDone'), [{ a: 1 }]);
  assert.deepEqual(rv.extractJsonArray('note [see below] then [{"a":"]"}] end'), [{ a: ']' }]);
  assert.equal(rv.extractJsonArray('nothing here'), null);
  assert.equal(rv.extractJsonArray('{"a":1}'), null);
});

// ---------------------------------------------------------------- CLI pipeline
function setup() {
  const repo = u.initRepo();
  u.writeFile(repo, 'src/x.js', SRC);
  const t = u.createTask(repo);
  const dir = paths.taskDir(project.findByCwd(repo).id, t.id);
  const submit = (list, extra = []) => u.crewIn(['review', 'submit', t.id, ...extra], repo, JSON.stringify(list));
  return { repo, t, dir, submit };
}

test('review run (claude) prints the reviewer prompt and the raw findings path', () => {
  const { repo, t, dir } = setup();
  const r = u.crewJson(['review', 'run', t.id], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.round, 1);
  assert.equal(r.data.subagent_type, 'crew-reviewer');
  assert.equal(r.data.raw_path, path.join(dir, 'findings', '1.raw.json'));
  assert.ok(r.data.prompt.includes(`crew-task: ${t.id}`));
  assert.ok(r.data.prompt.includes('review submit'));
  assert.ok(r.data.prompt.includes('.crew'));
  assert.ok(!/worker report/i.test(r.data.prompt.replace(/worker's own description/g, '')));
  const text = run(repo, 'review', 'run', t.id);
  assert.match(text.out, /Dispatch the reviewer/);
  assert.equal(run(repo, 'review', 'run', 't-20000101-zzzz').code, 1);
  assert.equal(run(repo, 'review', 'run', t.id, '--engine', 'nope').code, 1);
});

test('review submit stores stdin or --file input and rejects non-arrays', () => {
  const { repo, t, dir, submit } = setup();
  const r = submit([u.finding('f1')]);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(dir, 'findings', '1.raw.json')));
  assert.equal(submit({ findings: [u.finding('f2')] }, ['--round', '2']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'findings', '2.raw.json'), 'utf8'))[0].id, 'f2');
  assert.equal(u.crewIn(['review', 'submit', t.id], repo, '{"nope":1}').code, 1);
  assert.equal(u.crewIn(['review', 'submit', t.id], repo, 'not json').code, 1);
  assert.equal(u.crewIn(['review', 'submit', t.id], repo, '   ').code, 1);
  const f = u.writeFile(h.tmpDir(), 'raw.json', JSON.stringify([u.finding('f3')]));
  assert.equal(run(repo, 'review', 'submit', t.id, '--file', f, '--round', '3').code, 0);
  assert.equal(submit([], ['--kind', 'refutations', '--round', '1']).code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'findings', '1.refutations.json')));
});

test('full pipeline: filter -> finalize -> show; task show lists the survivors', () => {
  const { repo, t, dir, submit } = setup();
  assert.equal(run(repo, 'review', 'filter', t.id).code, 1, 'no raw findings yet');
  submit([
    u.finding('keep', { claim: 'unchecked return value' }),
    u.finding('weak', { confidence: 0.2, snippet: 'weak()' }),
    u.finding('guess', { verified_by: 'inference', snippet: 'guess()' }),
    { id: 'bad' },
    u.finding('wrong', { snippet: 'wrong()' }),
  ]);
  const f = u.crewJson(['review', 'filter', t.id], repo);
  assert.equal(f.code, 0, f.err);
  assert.deepEqual(f.data.kept.map((x) => x.id), ['keep', 'wrong']);
  assert.deepEqual(f.data.dropped.map((d) => d.reason).sort(), ['inference', 'invalid', 'low-confidence']);
  assert.equal(f.data.refuter.subagent_type, 'crew-refuter');
  assert.ok(f.data.refuter.prompt.includes('review submit'));
  const filtered = JSON.parse(fs.readFileSync(path.join(dir, 'findings', '1.filtered.json'), 'utf8'));
  assert.equal(filtered.length, 3);
  assert.match(run(repo, 'review', 'filter', t.id).out, /invalid entry bad/);

  assert.equal(run(repo, 'review', 'finalize', t.id).code, 2, 'refutations are required when something survived');
  const refs = u.writeFile(h.tmpDir(), 'ref.json', JSON.stringify([
    { id: 'keep', verdict: 'upheld', evidence: 'src/x.js:1 confirmed' },
    { id: 'wrong', verdict: 'refuted', evidence: 'src/x.js:2 already handled' },
  ]));
  const fin = u.crewJson(['review', 'finalize', t.id, '--refutations-file', refs], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.deepEqual(fin.data.findings.map((x) => [x.id, x.verdict]), [['keep', 'upheld']]);
  assert.equal(fin.data.refuted, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'findings', '1.json'), 'utf8')).length, 1);
  const filtered2 = JSON.parse(fs.readFileSync(path.join(dir, 'findings', '1.filtered.json'), 'utf8'));
  assert.ok(filtered2.some((d) => d.reason === 'refuted' && d.finding.id === 'wrong'));
  assert.equal(filtered2.length, 4);

  const show = u.crewJson(['review', 'show', t.id], repo);
  assert.equal(show.data.final, true);
  assert.equal(show.data.findings[0].id, 'keep');
  assert.match(run(repo, 'review', 'show', t.id).out, /unchecked return value/);
  assert.match(run(repo, 'task', 'show', t.id).out, /Findings, round 1: 1 \(major 1\)/);
});

test('finalize moves a returned task to reviewing and accepts a stored refutations file', () => {
  const { repo, t, submit } = setup();
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  submit([u.finding('a')]);
  run(repo, 'review', 'filter', t.id);
  assert.equal(u.crewIn(['review', 'submit', t.id, '--kind', 'refutations'], repo, JSON.stringify([{ id: 'a', verdict: 'uncertain', evidence: 'cannot tell' }])).code, 0);
  const fin = u.crewJson(['review', 'finalize', t.id], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.equal(fin.data.findings[0].verdict, 'uncertain');
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'reviewing');
  assert.equal(run(repo, 'task', 'accept', t.id).code, 0, 'reviewing -> accepted');
});

test('accept refuses findings that skipped the refuter, unless a reason is given, and the reason is kept', () => {
  const { repo, t, submit } = setup();
  run(repo, 'task', 'report', t.id, '--report-file', u.reportFiles().report);
  submit([u.finding('a')]);
  const raw = run(repo, 'task', 'accept', t.id);
  assert.notEqual(raw.code, 0, 'not even filtered');
  run(repo, 'review', 'filter', t.id);
  const refused = run(repo, 'task', 'accept', t.id);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /round 1.*crew review finalize/s);
  assert.equal(u.crewJson(['task', 'show', t.id], repo).data.task.state, 'returned', 'still waiting');

  const acc = u.crewJson(['task', 'accept', t.id, '--skip-refuter', 'typo fix, checked by hand'], repo);
  assert.equal(acc.code, 0, acc.err);
  assert.deepEqual(acc.data.review_gap, { kind: 'unfinalized', round: 1, n: 1 });
  assert.equal(acc.data.skip_refuter, 'typo fix, checked by hand');
});

test('accept notes a task with no review round, but not a finalized one', () => {
  const none = setup();
  run(none.repo, 'task', 'report', none.t.id, '--report-file', u.reportFiles().report);
  assert.match(run(none.repo, 'task', 'accept', none.t.id).out, /no review round was recorded/);

  const clean = setup();
  run(clean.repo, 'task', 'report', clean.t.id, '--report-file', u.reportFiles().report);
  clean.submit([]);
  run(clean.repo, 'review', 'filter', clean.t.id);
  run(clean.repo, 'review', 'finalize', clean.t.id);
  assert.equal(u.crewJson(['task', 'accept', clean.t.id], clean.repo).data.review_gap, null);
});

test('finalize with no survivors needs no refutations; missing verdicts become uncertain with a warning', () => {
  const { repo, t, submit } = setup();
  submit([u.finding('weak', { confidence: 0.1 })]);
  run(repo, 'review', 'filter', t.id);
  const fin = u.crewJson(['review', 'finalize', t.id], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.deepEqual(fin.data.findings, []);
  submit([u.finding('a'), u.finding('b', { snippet: 'other()' })], ['--round', '2']);
  run(repo, 'review', 'filter', t.id, '--round', '2');
  const refs = u.writeFile(h.tmpDir(), 'r.json', JSON.stringify([{ id: 'a', verdict: 'upheld', evidence: 'x' }]));
  const f2 = u.crewJson(['review', 'finalize', t.id, '--round', '2', '--refutations-file', refs], repo);
  assert.equal(f2.data.findings.length, 2);
  assert.ok(f2.data.problems.some((p) => /no refutation for b/.test(p)));
  assert.equal(run(repo, 'review', 'finalize', t.id, '--round', '2', '--refutations-file', path.join(repo, 'gone.json')).code, 1);
});

test('review show without findings fails clearly; kept-but-not-final is labelled', () => {
  const { repo, t, submit } = setup();
  assert.equal(run(repo, 'review', 'show', t.id).code, 1);
  submit([u.finding('a')]);
  run(repo, 'review', 'filter', t.id);
  const s = run(repo, 'review', 'show', t.id);
  assert.equal(s.code, 0);
  assert.match(s.out, /not finalized yet/);
});

test('dismiss: once stops matching when the snippet is gone, always keeps matching and records a lesson', () => {
  const { repo, t, submit } = setup();
  submit([u.finding('f1')]);
  run(repo, 'review', 'filter', t.id);
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1', '--scope', 'once').code, 2, 'reason is required');
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'f1', '--reason', 'x').code, 2, 'scope is required');
  assert.equal(run(repo, 'review', 'dismiss', t.id, 'nope', '--scope', 'once', '--reason', 'x').code, 1);
  const d = u.crewJson(['review', 'dismiss', t.id, 'f1', '--scope', 'once', '--reason', 'fine here'], repo);
  assert.equal(d.code, 0, d.err);
  assert.equal(d.data.entry.scope, 'once');
  assert.equal(d.data.entry.fingerprint, rv.fingerprint(u.finding('f1')));
  assert.equal(d.data.lesson, null);
  const ledger = fs.readFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.deepEqual(Object.keys(ledger[0]).sort(), ['category', 'date', 'decided_by', 'file', 'fingerprint', 'reason', 'scope', 'snippet_bytes', 'snippet_hash', 'symbol']);
  assert.ok(!('snippet' in ledger[0]), 'the committed ledger never carries snippet text');
  // the same finding in the next round is filtered out as dismissed
  submit([u.finding('g1')], ['--round', '2']);
  let f = u.crewJson(['review', 'filter', t.id, '--round', '2'], repo);
  assert.deepEqual(f.data.dropped.map((x) => x.reason), ['dismissed']);
  // the code changes: the once entry no longer matches
  fs.writeFileSync(path.join(repo, 'src', 'x.js'), 'const total = changed();\n');
  submit([u.finding('g2')], ['--round', '3']);
  f = u.crewJson(['review', 'filter', t.id, '--round', '3'], repo);
  assert.deepEqual(f.data.kept.map((x) => x.id), ['g2']);
  // dismissing twice does not duplicate the entry
  const again = u.crewJson(['review', 'dismiss', t.id, 'f1', '--scope', 'once', '--reason', 'again'], repo);
  assert.equal(again.data.duplicate, true);
  assert.equal(fs.readFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), 'utf8').trim().split('\n').length, 1);
  // always: survives the change and leaves a lesson candidate
  const always = u.crewJson(['review', 'dismiss', t.id, 'g2', '--scope', 'always', '--reason', 'known pattern'], repo);
  assert.equal(always.code, 0, always.err);
  assert.equal(always.data.lesson.key, 'review-dismissed-correctness');
  submit([u.finding('g3')], ['--round', '4']);
  f = u.crewJson(['review', 'filter', t.id, '--round', '4'], repo);
  assert.deepEqual(f.data.kept, []);
  assert.match(fs.readFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'utf8'), /\[dismissal\] review-dismissed-correctness: .*REVIEW\.md/);
  const ev = events.read(project.findByCwd(repo).id, { types: 'review.finding_dismissed' });
  assert.ok(ev.length >= 2);
});

test('dismissing a downgraded finding fingerprints the reported category', () => {
  const { repo, t, submit } = setup();
  submit([u.finding('r', { pattern: 'theoretical-race' })]);
  run(repo, 'review', 'filter', t.id);
  const d = u.crewJson(['review', 'dismiss', t.id, 'r', '--scope', 'always', '--reason', 'theoretical'], repo);
  assert.equal(d.data.entry.category, 'correctness');
  assert.equal(d.data.entry.fingerprint, rv.fingerprint(u.finding('r')));
});

// ---------------------------------------------------------------- external engine
const FAKE = [
  "const fs = require('fs');",
  "let input = '';",
  "process.stdin.on('data', (d) => { input += d; });",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(process.argv[2], input);",
  "  const mode = process.argv[3] || 'ok';",
  "  if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }",
  "  if (mode === 'prose') { console.log('no findings today'); return; }",
  "  const f = { id: 'e1', category: 'correctness', severity: 'major', file: 'src/x.js', line: 1, symbol: 'compute',",
  "    snippet: 'const total = compute(1);', claim: 'engine claim', evidence: ['src/x.js:1'], verified_by: 'code-trace', confidence: 0.8 };",
  "  console.log('Review done.\\n```json\\n' + JSON.stringify([f]) + '\\n```');",
  "});",
].join('\n');

// Engine definitions are only honoured from the global config.
function setGlobalEngines(engines) {
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines }));
}

function engineSetup(mode = 'ok') {
  const repo = u.initRepo();
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'crew init');
  h.git(repo, 'checkout', '-q', '-b', 'feat/e');
  u.writeFile(repo, 'src/x.js', SRC);
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', base);
  const scratch = h.tmpDir();
  const script = u.writeFile(scratch, 'fake-engine.js', FAKE);
  const stdinCopy = path.join(scratch, 'stdin.txt');
  u.patchCfg(repo, (c) => {
    c.roles.reviewer = { engine: 'fake', model: 'inherit', agent: 'crew-reviewer' };
  });
  setGlobalEngines({ fake: { command: process.execPath, args: [script, stdinCopy, mode] } });
  const t = u.createTask(repo, { branch: 'feat/e' });
  return { repo, t, stdinCopy };
}

test('review run with an external engine: prompt on stdin, JSON extracted into the raw file', () => {
  const { repo, t, stdinCopy } = engineSetup();
  const r = u.crewJson(['review', 'run', t.id], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.engine, 'fake');
  assert.equal(r.data.count, 1);
  const raw = JSON.parse(fs.readFileSync(r.data.raw_path, 'utf8'));
  assert.equal(raw[0].id, 'e1');
  const sent = fs.readFileSync(stdinCopy, 'utf8');
  assert.ok(sent.includes('## Brief') && sent.includes('## Review rules') && sent.includes('## Diff'));
  assert.ok(sent.includes('compute(1)'), 'the diff is part of the prompt');
  assert.ok(sent.includes('Add the thing.'), 'the brief is part of the prompt');
  assert.ok(sent.includes('severity'), 'the schema is part of the prompt');
  const f = u.crewJson(['review', 'filter', t.id], repo);
  assert.deepEqual(f.data.kept.map((x) => x.id), ['e1']);
});

test('external engine: explicit --engine on a claude-default project, failures and non-JSON output', () => {
  const failing = engineSetup('fail');
  const r = h.crew(['review', 'run', failing.t.id], failing.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /fake failed: .*boom/);
  const prose = engineSetup('prose');
  const p = h.crew(['review', 'run', prose.t.id], prose.repo);
  assert.equal(p.code, 1);
  assert.match(p.err, /no JSON array/);
  assert.equal(rv.latestRound(paths.taskDir(project.findByCwd(prose.repo).id, prose.t.id), 'raw.json'), 0);
  // no branch -> no diff to hand the engine
  const nb = engineSetup();
  const t2 = u.createTask(nb.repo, { title: 'no branch' });
  const x = h.crew(['review', 'run', t2.id], nb.repo);
  assert.equal(x.code, 1);
  assert.match(x.err, /no branch that exists in git/);
  const other = u.initRepo();
  setGlobalEngines({ fake: { command: process.execPath, args: ['-e', ''] } });
  const t3 = u.createTask(other);
  assert.equal(h.crew(['review', 'run', t3.id, '--engine', 'missing'], other).code, 1);
});
