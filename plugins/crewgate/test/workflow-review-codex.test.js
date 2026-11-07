'use strict';
// Default review engine: Claude implements, Codex reviews and refutes when the global config
// defines a usable codex engine; otherwise reviewer and refuter fall back to claude (sonnet).
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

const SRC = 'const total = compute(1);\nmodule.exports = total;\n';

// A fake "codex": answers a review prompt with one finding and a refuter prompt with one verdict
// (refuted when its mode is "refute", else upheld). Each prompt is copied next to argv[2].
const FAKE_CODEX = [
  "const fs = require('fs');",
  "let input = '';",
  "process.stdin.on('data', (d) => { input += d; });",
  "process.stdin.on('end', () => {",
  "  const refuter = /You are the crew refuter for (task|plan)/.test(input);",
  "  fs.writeFileSync(process.argv[2] + (refuter ? '.refuter' : '.reviewer'), input);",
  "  if (refuter && process.argv[3] === 'refuter-fail') { process.stderr.write('usage limit reached'); process.exit(2); }",
  '  if (refuter) {',
  "    const verdict = process.argv[3] === 'refute' ? 'refuted' : 'upheld';",
  "    console.log(JSON.stringify([{ id: 'e1', verdict, evidence: 'src/x.js:1 checked' }]));",
  '    return;',
  '  }',
  "  const f = { id: 'e1', category: 'correctness', severity: 'major', file: 'src/x.js', line: 1, symbol: 'compute',",
  "    snippet: 'const total = compute(1);', claim: 'codex claim', evidence: ['src/x.js:1'], verified_by: 'code-trace', confidence: 0.8 };",
  '  console.log(JSON.stringify([f]));',
  '});',
].join('\n');

function setGlobal(obj) {
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, ...obj }));
}
const setGlobalEngines = (engines) => setGlobal({ engines });
const resetGlobal = () => setGlobal({});

function codexSetup(mode = 'ok', patch) {
  const repo = u.initRepo();
  const base = h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'crew init');
  h.git(repo, 'checkout', '-q', '-b', 'feat/c');
  u.writeFile(repo, 'src/x.js', SRC);
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', base);
  const scratch = h.tmpDir();
  const script = u.writeFile(scratch, 'fake-codex.js', FAKE_CODEX);
  const copy = path.join(scratch, 'stdin');
  if (patch) u.patchCfg(repo, patch);
  setGlobalEngines({ codex: { command: process.execPath, args: [script, copy, mode] } });
  const t = u.createTask(repo, { branch: 'feat/c' });
  return { repo, t, copy };
}

test('default review roles: codex when the global config defines a usable codex engine, else claude; worker stays claude', () => {
  try {
    const repo = u.initRepo();
    resetGlobal();
    let l = config.load(repo);
    assert.equal(l.config.roles.reviewer.engine, 'claude');
    assert.equal(l.config.roles.refuter.engine, 'claude');
    assert.deepEqual(l.roleEngines.reviewer, { engine: 'claude', source: 'default' });
    assert.equal(config.reviewEngineDefault().reason, 'not-defined', 'the built-in codex entry alone does not count');
    setGlobalEngines({ codex: { command: path.join(h.tmpDir(), 'no-such-codex') } });
    assert.equal(config.reviewEngineDefault().reason, 'not-found');
    assert.equal(config.load(repo).config.roles.reviewer.engine, 'claude');
    setGlobalEngines({ codex: { command: process.execPath, args: [] } });
    l = config.load(repo);
    assert.equal(l.config.roles.reviewer.engine, 'codex');
    assert.equal(l.config.roles.refuter.engine, 'codex');
    assert.equal(l.config.roles.worker.engine, 'claude');
    assert.equal(l.config.roles.worker.model, 'sonnet');
    assert.deepEqual(l.roleEngines.refuter, { engine: 'codex', source: 'default' });
    // no project file at all: same defaults
    assert.equal(config.load(h.tmpDir()).config.roles.reviewer.engine, 'codex');
    // a project that names claude keeps it; the other role still follows the default
    u.patchCfg(repo, (c) => { c.roles.reviewer = { engine: 'claude', model: 'sonnet', agent: 'crew-reviewer' }; });
    l = config.load(repo);
    assert.equal(l.config.roles.reviewer.engine, 'claude');
    assert.deepEqual(l.roleEngines.reviewer, { engine: 'claude', source: 'project' });
    assert.equal(l.config.roles.refuter.engine, 'codex');
    // an unknown engine name is an error and falls back to the default, not to a pinned claude
    u.patchCfg(repo, (c) => { c.roles.refuter = { engine: 'nope' }; });
    l = config.load(repo);
    assert.ok(l.errors.some((e) => e.path === 'roles.refuter.engine'));
    assert.equal(l.config.roles.refuter.engine, 'codex');
  } finally { resetGlobal(); }
});

test('init writes no engine for reviewer and refuter, so they follow the global default', () => {
  const repo = u.initRepo();
  const c = u.readCfg(repo);
  assert.equal('engine' in c.roles.reviewer, false);
  assert.equal('engine' in c.roles.refuter, false);
  assert.equal(c.roles.worker.engine, 'claude');
});

test('doctor reports the review roles and hints when Codex is not set up', async () => {
  try {
    const repo = u.initRepo();
    resetGlobal();
    let d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    let roles = d.checks.find((c) => c.name === 'roles');
    assert.equal(roles.status, 'warn');
    assert.match(roles.detail, /reviewer claude \(default\)/);
    assert.match(roles.detail, /add engines\.codex/);
    setGlobalEngines({ codex: { command: process.execPath, args: [] } });
    d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    roles = d.checks.find((c) => c.name === 'roles');
    assert.equal(roles.status, 'ok');
    assert.match(roles.detail, /reviewer codex \(default\), refuter codex \(default\)/);
    u.patchCfg(repo, (c) => { c.roles.reviewer = { engine: 'claude' }; });
    d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    assert.match(d.checks.find((c) => c.name === 'roles').detail, /reviewer claude \(set in \.claude\/crew\.json\)/);
  } finally { resetGlobal(); }
});

test('review run with the default codex roles: Codex reviews and refutes, then the round is finalized', () => {
  try {
    const { repo, t, copy } = codexSetup();
    const r = u.crewJson(['review', 'run', t.id], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.engine, 'codex');
    assert.equal(r.data.prompt, undefined, 'no subagent prompt is printed');
    assert.equal(r.data.refuter.engine, 'codex');
    assert.equal(r.data.refuter.count, 1);
    assert.deepEqual(r.data.findings.map((f) => [f.id, f.verdict]), [['e1', 'upheld']]);
    const sent = fs.readFileSync(`${copy}.refuter`, 'utf8');
    assert.ok(sent.includes('codex claim') && sent.includes('## Diff') && sent.includes('compute(1)'));
    const dir = paths.taskDir(project.findByCwd(repo).id, t.id);
    assert.equal(rv.readArray(rv.roundFile(dir, 1, 'refutations.json'), 'r')[0].verdict, 'upheld');
    assert.equal(rv.readArray(rv.roundFile(dir, 1, 'json'), 'f').length, 1);
    // refuted by Codex: dropped from the final list
    const b = codexSetup('refute');
    const r2 = u.crewJson(['review', 'run', b.t.id], b.repo);
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(r2.data.findings, []);
    assert.equal(r2.data.refuted, 1);
  } finally { resetGlobal(); }
});

test('external refuter with a claude reviewer: filter runs the engine, finalize applies its verdicts', () => {
  try {
    const { repo, t, copy } = codexSetup('refute', (c) => { c.roles.reviewer = { engine: 'claude', model: 'sonnet', agent: 'crew-reviewer' }; });
    const r = u.crewJson(['review', 'run', t.id], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.engine, 'claude', 'an explicit claude reviewer is not overridden');
    assert.ok(r.data.prompt);
    const found = [u.finding('e1', { file: 'src/x.js', snippet: 'const total = compute(1);' })];
    assert.equal(u.crewIn(['review', 'submit', t.id], repo, JSON.stringify(found)).code, 0);
    const f = u.crewJson(['review', 'filter', t.id], repo);
    assert.equal(f.code, 0, f.err);
    assert.equal(f.data.refuter.engine, 'codex');
    assert.equal(f.data.refuter.prompt, undefined);
    assert.ok(fs.existsSync(`${copy}.refuter`));
    const fin = u.crewJson(['review', 'finalize', t.id], repo);
    assert.equal(fin.code, 0, fin.err);
    assert.equal(fin.data.refuted, 1);
    // --refuter-engine claude prints the subagent prompt instead
    const c = u.crewJson(['review', 'filter', t.id, '--refuter-engine', 'claude'], repo);
    assert.equal(c.data.refuter.engine, 'claude');
    assert.match(c.data.refuter.prompt, /crew refuter/);
  } finally { resetGlobal(); }
});

test('external reviewer with a claude refuter: review run stops at the refuter prompt', () => {
  try {
    const { repo, t } = codexSetup('ok', (c) => { c.roles.refuter = { engine: 'claude', model: 'sonnet', agent: 'crew-refuter' }; });
    const r = u.crewJson(['review', 'run', t.id], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.engine, 'codex');
    assert.equal(r.data.refuter.subagent_type, 'crew-refuter');
    assert.equal(r.data.findings, undefined, 'not finalized before the refuter answers');
  } finally { resetGlobal(); }
});

test('review run: a refuter engine that fails falls back to the Claude refuter prompt and does not finalize', () => {
  try {
    const { repo, t } = codexSetup('refuter-fail');
    const r = u.crewJson(['review', 'run', t.id], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.engine, 'codex');
    assert.equal(r.data.refuter.subagent_type, 'crew-refuter');
    assert.match(r.data.fallback.reason, /usage limit/);
    assert.equal(r.data.findings, undefined);
    const dir = paths.taskDir(project.findByCwd(repo).id, t.id);
    assert.equal(fs.existsSync(rv.roundFile(dir, 1, 'refutations.json')), false);
    assert.equal(fs.existsSync(rv.roundFile(dir, 1, 'json')), false);
  } finally { resetGlobal(); }
});

test('review run: a bad --refuter-engine name is refused before a round is used, also with a claude reviewer', () => {
  try {
    const { repo, t } = codexSetup('ok', (c) => { c.roles.reviewer = { engine: 'claude', model: 'sonnet', agent: 'crew-reviewer' }; });
    const dir = paths.taskDir(project.findByCwd(repo).id, t.id);
    const bad = u.crewJson(['review', 'run', t.id, '--refuter-engine', 'no-such-engine'], repo);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /no-such-engine/);
    assert.equal(rv.latestRound(dir, 'raw.json'), 0, 'no round was used');
    const bad2 = u.crewJson(['review', 'run', t.id, '--engine', 'claude', '--refuter-engine', 'no-such-engine'], repo);
    assert.notEqual(bad2.code, 0);
    assert.equal(rv.latestRound(dir, 'raw.json'), 0);
  } finally { resetGlobal(); }
});

test('review run ending at the Claude reviewer dispatch carries --refuter-engine to the next step', () => {
  try {
    const { repo, t } = codexSetup('ok', (c) => { c.roles.reviewer = { engine: 'claude', model: 'sonnet', agent: 'crew-reviewer' }; });
    const r = u.crewJson(['review', 'run', t.id, '--refuter-engine', 'codex'], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.engine, 'claude');
    assert.equal(r.data.refuter_engine, 'codex');
    const text = h.crew(['review', 'run', t.id, '--refuter-engine', 'codex', '--round', '2'], repo);
    assert.equal(text.code, 0, text.err);
    assert.ok(text.out.includes(`crew review filter ${t.id} --refuter-engine codex`), text.out);
    const plain = h.crew(['review', 'run', t.id, '--round', '3'], repo);
    assert.ok(plain.out.includes(`crew review filter ${t.id}`) && !plain.out.includes('--refuter-engine'), plain.out);
    // a reviewer engine that fails and falls back to Claude carries it too
    const b = codexSetup('ok', (c) => { c.roles.reviewer = { engine: 'codex' }; });
    setGlobalEngines({ codex: { command: path.join(h.tmpDir(), 'no-such-codex') }, other: { command: process.execPath, args: [] } });
    const f = h.crew(['review', 'run', b.t.id, '--refuter-engine', 'other'], b.repo);
    assert.equal(f.code, 0, f.err);
    assert.ok(f.out.includes(`crew review filter ${b.t.id} --refuter-engine other`), f.out);
  } finally { resetGlobal(); }
});

test('doctor hints at a role pinned to claude by an older init, and warns only when Codex is available', async () => {
  try {
    const repo = u.initRepo();
    u.patchCfg(repo, (c) => { c.roles.reviewer = { engine: 'claude' }; c.roles.refuter = { engine: 'claude' }; });
    resetGlobal();
    let d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    let roles = d.checks.find((c) => c.name === 'roles');
    assert.match(roles.detail, /reviewer is pinned to claude in \.claude\/crew\.json; remove roles\.reviewer\.engine/);
    assert.match(roles.detail, /refuter is pinned to claude/);
    assert.match(roles.detail, /add engines\.codex/);
    assert.equal(roles.status, 'ok', 'no Codex available: status as before');
    setGlobalEngines({ codex: { command: process.execPath, args: [] } });
    d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    roles = d.checks.find((c) => c.name === 'roles');
    assert.equal(roles.status, 'warn');
    assert.match(roles.detail, /remove roles\.refuter\.engine from that file to make it follow the Codex default/);
    // not pinned: no hint
    u.patchCfg(repo, (c) => { delete c.roles.reviewer.engine; delete c.roles.refuter.engine; });
    d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    roles = d.checks.find((c) => c.name === 'roles');
    assert.equal(roles.status, 'ok');
    assert.doesNotMatch(roles.detail, /pinned/);
  } finally { resetGlobal(); }
});

test('plan review follows the Codex default: run uses the codex reviewer, filter runs the codex refuter', () => {
  try {
    const repo = u.initRepo();
    const scratch = h.tmpDir();
    const script = u.writeFile(scratch, 'fake-codex.js', FAKE_CODEX);
    const copy = path.join(scratch, 'stdin');
    setGlobalEngines({ codex: { command: process.execPath, args: [script, copy, 'ok'] } });
    assert.equal('engine' in u.readCfg(repo).roles.reviewer, false);
    u.writeFile(repo, '.crew/plans/demo.md', [
      '# Demo plan', 'Ship a todo CLI.', '',
      '- [ ] Due dates <!-- id:n1 added:2026-10-01 origin:plan -->', '',
    ].join('\n'));
    const run = u.crewJson(['plan', 'review', 'run', 'demo'], repo);
    assert.equal(run.code, 0, run.err);
    assert.equal(run.data.engine, 'codex');
    assert.equal(run.data.prompt, undefined, 'no subagent prompt is printed');
    assert.match(fs.readFileSync(`${copy}.reviewer`, 'utf8'), /You are the crew reviewer for plan demo/);
    const found = [{
      node: 'n1', kind: 'missing-step', claim: 'claim', evidence: ['plan n1'],
      proposal: { action: 'add', text: 'Reject past dates', done_when: 'past dates are rejected, checked by a test' },
    }];
    const sub = u.crewIn(['--json', 'plan', 'review', 'submit', 'demo', '--round', String(run.data.round)], repo, JSON.stringify(found));
    assert.equal(sub.code, 0, sub.err);
    const flt = u.crewJson(['plan', 'review', 'filter', 'demo', '--round', String(run.data.round)], repo);
    assert.equal(flt.code, 0, flt.err);
    assert.equal(flt.data.refuter.engine, 'codex');
    assert.equal(flt.data.refuter.prompt, undefined);
    assert.match(fs.readFileSync(`${copy}.refuter`, 'utf8'), /You are the crew refuter for plan demo/);
  } finally { resetGlobal(); }
});
