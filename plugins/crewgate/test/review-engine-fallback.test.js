'use strict';
// External engines for the reviewer and the refuter (task review and plan review), and the Claude fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const config = require('../lib/core/config');
const paths = require('../lib/core/paths');
const events = require('../lib/core/events');
const project = require('../lib/core/project');

const SRC = 'const total = compute(1);\nmodule.exports = total;\n';
const PLAN = [
  '# Demo plan', 'Ship a todo CLI with due dates.', '',
  '- [ ] Due dates <!-- id:n1 added:2026-10-01 origin:plan -->',
  '  - [ ] Add due dates <!-- id:n2 added:2026-10-01 origin:plan -->',
  '',
].join('\n');
const PLAN_FINDING = { node: 'n2', kind: 'missing-step', claim: 'no sort step', evidence: ['plan n2'], proposal: { action: 'add', text: 'Sort by due date', done_when: 'the sort test passes' } };

// argv: payload file for the reviewer, payload file for the refuter, mode. The role is told from the prompt.
const FAKE = [
  "const fs = require('fs');",
  "let input = '';",
  "process.stdin.on('data', (d) => { input += d; });",
  "process.stdin.on('end', () => {",
  "  const [rev, ref, mode] = process.argv.slice(2);",
  "  if (mode === 'fail') { process.stderr.write('Error: usage limit reached, try again later'); process.exit(1); }",
  "  if (mode === 'prose') { console.log('nothing to report, sorry'); return; }",
  "  const file = /You are the crew refuter/.test(input) ? ref : rev;",
  "  console.log('Done.\\n```json\\n' + fs.readFileSync(file, 'utf8') + '\\n```');",
  "});",
].join('\n');

function setGlobalEngines(engines) {
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines }));
}

function fakeEngine(mode, reviewerPayload, refuterPayload) {
  const scratch = h.tmpDir();
  const script = u.writeFile(scratch, 'fake-engine.js', FAKE);
  const rev = u.writeFile(scratch, 'rev.json', JSON.stringify(reviewerPayload || []));
  const ref = u.writeFile(scratch, 'ref.json', JSON.stringify(refuterPayload || []));
  setGlobalEngines({ fake: { command: process.execPath, args: [script, rev, ref, mode] } });
}

function taskSetup(mode, roles = {}) {
  const repo = u.initRepo();
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'crew init');
  h.git(repo, 'checkout', '-q', '-b', 'feat/e');
  u.writeFile(repo, 'src/x.js', SRC);
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', base);
  fakeEngine(mode, [u.finding('e1')], [{ id: 'e1', verdict: 'upheld', evidence: 'src/x.js:1 still true' }]);
  u.patchCfg(repo, (c) => {
    c.roles.reviewer = { engine: 'fake', model: 'inherit', agent: 'crew-reviewer', ...(roles.reviewer || {}) };
    c.roles.refuter = { engine: 'fake', model: 'inherit', agent: 'crew-refuter', ...(roles.refuter || {}) };
  });
  const t = u.createTask(repo, { branch: 'feat/e' });
  const pid = project.findByCwd(repo).id;
  return { repo, t, pid, fallbacks: () => events.read(pid, { types: 'review.engine_fallback' }) };
}

function planSetup(mode, roles = {}) {
  const repo = h.makeRepo();
  const proj = project.add(repo, { name: 'demo' }).project;
  fs.mkdirSync(path.join(repo, '.crew', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), PLAN);
  fakeEngine(mode, [PLAN_FINDING], [{ id: 'f1', verdict: 'upheld', evidence: 'plan n2 has no sort' }]);
  u.writeFile(repo, '.claude/crew.json', JSON.stringify({ version: 1, roles: {
    reviewer: { engine: 'fake', model: 'inherit', agent: 'crew-reviewer', ...(roles.reviewer || {}) },
    refuter: { engine: 'fake', model: 'inherit', agent: 'crew-refuter', ...(roles.refuter || {}) },
  } }));
  return { repo, proj, fallbacks: () => events.read(proj.id, { types: 'review.engine_fallback' }) };
}

// ---------------------------------------------------------------- task review
test('task review: a refuter engine writes refutations.json and finalize needs no --refutations-file', () => {
  const { repo, t } = taskSetup('ok');
  assert.equal(u.crewJson(['review', 'run', t.id], repo).code, 0);
  const f = u.crewJson(['review', 'filter', t.id], repo);
  assert.equal(f.code, 0, f.err);
  assert.deepEqual(f.data.kept.map((x) => x.id), ['e1']);
  assert.equal(f.data.refuter.engine, 'fake');
  assert.equal(f.data.refuter.count, 1);
  assert.ok(fs.existsSync(f.data.refuter.refutations_path));
  const text = h.crew(['review', 'filter', t.id, '--round', '1'], repo).out;
  assert.match(text, /crew review finalize/);
  assert.ok(!text.includes('--- prompt ---'));
  const fin = u.crewJson(['review', 'finalize', t.id], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.deepEqual(fin.data.findings.map((x) => [x.id, x.verdict]), [['e1', 'upheld']]);
});

test('task review: engine failure with "usage limit" falls back to the Claude dispatch and records an event', () => {
  const s = taskSetup('fail');
  const r = u.crewJson(['review', 'run', s.t.id], s.repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.subagent_type, 'crew-reviewer');
  assert.equal(r.data.model, 'inherit');
  assert.ok(r.data.prompt.includes('crew-task'));
  assert.equal(r.data.fallback.engine, 'fake');
  assert.match(r.data.fallback.reason, /usage limit/);
  const ev = s.fallbacks();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].task, s.t.id);
  assert.deepEqual({ ...ev[0].data, reason: undefined }, { role: 'reviewer', engine: 'fake', reason: undefined, round: 1, scope: 'task' });
  assert.match(ev[0].data.reason, /usage limit/);
  const txt = h.crew(['review', 'run', s.t.id, '--round', '2'], s.repo);
  assert.equal(txt.code, 0);
  assert.match(txt.out, /fake failed \(.*usage limit.*\); using the Claude subagent/);
  assert.match(txt.out, /subagent_type "crew-reviewer", model "inherit"/);
});

test('task review: refuter engine failure falls back to the crew-refuter dispatch (model sonnet by default)', () => {
  const s = taskSetup('ok');
  assert.equal(u.crewJson(['review', 'run', s.t.id], s.repo).code, 0);
  fakeEngine('fail');
  u.patchCfg(s.repo, (c) => { delete c.roles.refuter.model; });
  const f = u.crewJson(['review', 'filter', s.t.id], s.repo);
  assert.equal(f.code, 0, f.err);
  assert.equal(f.data.refuter.subagent_type, 'crew-refuter');
  assert.equal(f.data.refuter.model, 'sonnet');
  assert.equal(f.data.fallback.engine, 'fake');
  assert.ok(f.data.refuter.prompt.length > 0);
  const ev = s.fallbacks();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.role, 'refuter');
  assert.equal(ev[0].data.scope, 'task');
  assert.equal(fs.existsSync(path.join(paths.taskDir(s.pid, s.t.id), 'findings', '1.refutations.json')), false);
});

test('task review: an engine that prints no JSON falls back and keeps its output in engine.txt', () => {
  const s = taskSetup('prose');
  const r = u.crewJson(['review', 'run', s.t.id], s.repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.subagent_type, 'crew-reviewer');
  assert.match(r.data.fallback.reason, /no JSON/);
  assert.match(fs.readFileSync(path.join(paths.taskDir(s.pid, s.t.id), 'findings', '1.engine.txt'), 'utf8'), /nothing to report/);
  assert.equal(s.fallbacks().length, 1);
});

test('task review: fallback "none" keeps the old error and records no event', () => {
  const s = taskSetup('fail', { reviewer: { fallback: 'none' }, refuter: { fallback: 'none' } });
  const r = h.crew(['review', 'run', s.t.id], s.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /fake failed: .*usage limit/);
  const p = taskSetup('prose', { reviewer: { fallback: 'none' } });
  const x = h.crew(['review', 'run', p.t.id], p.repo);
  assert.equal(x.code, 1);
  assert.match(x.err, /no JSON array/);
  assert.equal(p.fallbacks().length, 0);
  assert.equal(s.fallbacks().length, 0);
});

// ---------------------------------------------------------------- plan review
test('plan review: reviewer and refuter engines save the round files and finalize works', () => {
  const { repo, proj } = planSetup('ok');
  const run = u.crewJson(['plan', 'review', 'run', 'demo'], repo);
  assert.equal(run.code, 0, run.err);
  assert.equal(run.data.engine, 'fake');
  assert.equal(run.data.count, 1);
  assert.ok(fs.existsSync(run.data.raw_path));
  const flt = u.crewJson(['plan', 'review', 'filter', 'demo'], repo);
  assert.equal(flt.code, 0, flt.err);
  assert.equal(flt.data.kept.length, 1);
  assert.equal(flt.data.refuter.engine, 'fake');
  assert.ok(fs.existsSync(flt.data.refuter.refutations_path));
  const fin = u.crewJson(['plan', 'review', 'finalize', 'demo'], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.equal(fin.data.created.length, 1);
  assert.match(fs.readFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), 'utf8'), /Sort by due date/);
  assert.equal(events.read(proj.id, { types: 'review.engine_fallback' }).length, 0);
});

test('plan review: engine failure falls back for the reviewer and the refuter; --engine claude skips the engine', () => {
  const s = planSetup('fail');
  const r = u.crewJson(['plan', 'review', 'run', 'demo'], s.repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.data.subagent_type, 'crew-reviewer');
  assert.equal(r.data.model, 'inherit');
  assert.match(r.data.fallback.reason, /usage limit/);
  // submit what the Claude reviewer would have saved, then fail the refuter
  assert.equal(u.crewIn(['plan', 'review', 'submit', 'demo'], s.repo, JSON.stringify([PLAN_FINDING])).code, 0);
  const f = u.crewJson(['plan', 'review', 'filter', 'demo'], s.repo);
  assert.equal(f.code, 0, f.err);
  assert.equal(f.data.refuter.subagent_type, 'crew-refuter');
  assert.equal(f.data.fallback.engine, 'fake');
  const ev = s.fallbacks();
  assert.deepEqual(ev.map((e) => [e.data.role, e.data.scope, e.data.round]), [['reviewer', 'plan', 1], ['refuter', 'plan', 1]]);
  assert.ok(!ev[0].task);
  const c = u.crewJson(['plan', 'review', 'run', 'demo', '--engine', 'claude', '--force'], s.repo);
  assert.equal(c.code, 0, c.err);
  assert.equal(c.data.fallback, undefined);
  assert.equal(s.fallbacks().length, 2);
});

test('plan review: no JSON falls back; fallback "none" keeps the error', () => {
  const s = planSetup('prose');
  const r = u.crewJson(['plan', 'review', 'run', 'demo'], s.repo);
  assert.equal(r.code, 0, r.err);
  assert.match(r.data.fallback.reason, /no JSON/);
  assert.equal(s.fallbacks().length, 1);
  const n = planSetup('prose', { reviewer: { fallback: 'none' } });
  const x = h.crew(['plan', 'review', 'run', 'demo'], n.repo);
  assert.equal(x.code, 1);
  assert.match(x.err, /no JSON array/);
  assert.equal(n.fallbacks().length, 0);
});

// ---------------------------------------------------------------- config
test('config: roles.*.fallback accepts claude and none and rejects anything else', () => {
  assert.deepEqual(config.validate({ roles: { refuter: { fallback: 'none' }, reviewer: { fallback: 'claude' } } }), []);
  const bad = config.validate({ roles: { refuter: { fallback: 'x' } } });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, 'roles.refuter.fallback');
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.roles.refuter.fallback = 'x'; });
  const d = JSON.parse(h.crew(['--json', 'doctor'], repo).out);
  assert.equal(d.checks.find((c) => c.name === 'config').status, 'fail');
});
