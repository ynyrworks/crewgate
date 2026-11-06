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
  "  const refuter = input.includes('refuter of code review findings');",
  "  fs.writeFileSync(process.argv[2] + (refuter ? '.refuter' : '.reviewer'), input);",
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
    assert.deepEqual(r.data.refuter, { engine: 'codex', count: 1 });
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
