'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const config = require('../lib/core/config');
const project = require('../lib/core/project');
const { renderAgent, AGENTS } = require('../lib/features/init');

const TEMPLATES = path.join(__dirname, '..', 'templates');

test('template crew.json equals the built-in defaults and validates', () => {
  const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'crew.json'), 'utf8'));
  assert.deepEqual(t, JSON.parse(JSON.stringify(config.DEFAULTS)));
  assert.deepEqual(config.validate(t), []);
});

test('init creates every file, registers the project and prints a summary', () => {
  const repo = h.makeRepo();
  const r = u.crewJson(['init'], repo);
  assert.equal(r.code, 0, r.err);
  const files = r.data.files.map((f) => f.file).sort();
  assert.deepEqual(files, [
    '.claude/agents/crew-refuter.md', '.claude/agents/crew-reviewer.md', '.claude/agents/crew-worker.md',
    '.claude/crew.json', '.crew/LESSONS.md', '.crew/REVIEW.md', '.crew/dismissed.jsonl',
  ]);
  assert.ok(r.data.files.every((f) => f.action === 'created'));
  for (const f of files) assert.ok(fs.existsSync(path.join(repo, ...f.split('/'))), f);
  assert.equal(fs.readFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), 'utf8'), '');
  assert.ok(project.findByCwd(repo), 'registered');
  assert.equal(r.data.created, true);
  assert.equal(u.readCfg(repo).language, 'en');
});

test('rendered agent files have no leftover placeholders and a valid frontmatter', () => {
  const repo = u.initRepo();
  for (const n of AGENTS) {
    const text = fs.readFileSync(path.join(repo, '.claude', 'agents', `${n}.md`), 'utf8');
    assert.ok(!/\{\{\w+\}\}/.test(text), `${n} has a placeholder`);
    assert.match(text, new RegExp(`^---\\nname: ${n}\\n`));
    assert.match(text, /\nmodel: sonnet\n/);
  }
  const reviewer = fs.readFileSync(path.join(repo, '.claude', 'agents', 'crew-reviewer.md'), 'utf8');
  assert.match(reviewer, /tools: Read, Grep, Glob, Bash/);
  assert.ok(reviewer.includes('correctness, security-exploitable'));
});

test('init is idempotent: a second run keeps every file untouched', () => {
  const repo = u.initRepo();
  const before = {};
  const list = ['.claude/crew.json', '.claude/agents/crew-worker.md', '.crew/REVIEW.md'];
  for (const f of list) before[f] = fs.readFileSync(path.join(repo, f), 'utf8');
  fs.appendFileSync(path.join(repo, '.crew', 'REVIEW.md'), '\nmy own rule\n');
  const r = u.crewJson(['init'], repo);
  assert.equal(r.code, 0);
  assert.ok(r.data.files.every((f) => f.action === 'kept'));
  assert.equal(r.data.created, false);
  assert.equal(fs.readFileSync(path.join(repo, '.claude/crew.json'), 'utf8'), before['.claude/crew.json']);
  assert.ok(fs.readFileSync(path.join(repo, '.crew/REVIEW.md'), 'utf8').includes('my own rule'));
  assert.deepEqual(fs.readdirSync(path.join(repo, '.claude', 'agents')).sort(), AGENTS.map((n) => `${n}.md`).sort());
});

test('init --force backs up every replaced file, keeps config values and the dismissed ledger', () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.checks = ['npm test']; c.forbidden = { paths: ['secrets/**'], actions: ['delete branches'] }; });
  fs.writeFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), '{"fingerprint":"x","scope":"always"}\n');
  const r = u.crewJson(['init', '--force'], repo);
  assert.equal(r.code, 0, r.err);
  const byFile = Object.fromEntries(r.data.files.map((f) => [f.file, f]));
  assert.equal(byFile['.claude/crew.json'].action, 'overwritten');
  assert.match(byFile['.claude/crew.json'].backup, /^\.claude\/crew\.json\.bak-\d+/);
  assert.ok(fs.existsSync(path.join(repo, byFile['.claude/crew.json'].backup)));
  assert.equal(byFile['.crew/dismissed.jsonl'].action, 'kept');
  assert.ok(fs.readFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), 'utf8').includes('"x"'));
  assert.deepEqual(u.readCfg(repo).checks, ['npm test']);
  const worker = fs.readFileSync(path.join(repo, '.claude', 'agents', 'crew-worker.md'), 'utf8');
  assert.ok(worker.includes('`npm test`'));
  assert.ok(worker.includes('secrets/**'));
  assert.ok(worker.includes('delete branches'));
  // the backup of an agent file holds the old text
  const bk = fs.readdirSync(path.join(repo, '.claude', 'agents')).filter((n) => n.includes('.bak-'));
  assert.equal(bk.length, 3);
});

test('init --lang zh-TW sets the language and the report headings', () => {
  const repo = h.makeRepo();
  const r = h.crew(['init', '--lang', 'zh-TW'], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(u.readCfg(repo).language, 'zh-TW');
  const worker = fs.readFileSync(path.join(repo, '.claude', 'agents', 'crew-worker.md'), 'utf8');
  assert.ok(worker.includes('Traditional Chinese'));
  assert.ok(worker.includes('## 分支與提交'));
  // the zh-TW headings are accepted by the report validator
  const { REPORT_SECTIONS } = require('../lib/core/tasks');
  assert.equal(REPORT_SECTIONS.length, 5);
  const { validateReport } = require('../lib/core/tasks');
  const rep = ['分支與提交', '改了什麼與原因', '測試', '假設與未完成', '需要實機確認']
    .map((x) => `## ${x}\nx\n`).join('\n');
  assert.equal(validateReport(rep).ok, true);
  // CLI output follows the project language afterwards
  assert.match(h.crew(['task', 'list'], repo).out, /沒有任務/);
});

test('renderAgent applies models, checks, forbidden lists, cap and language', () => {
  const cfg = config.load(h.tmpDir()).config;
  cfg.roles.reviewer.model = 'haiku';
  cfg.checks = ['npm test', 'npm run lint'];
  cfg.limits.report_max_tokens = 900;
  cfg.forbidden = { paths: ['vendor/**'], actions: [] };
  assert.match(renderAgent('crew-reviewer', cfg), /\nmodel: haiku\n/);
  const w = renderAgent('crew-worker', cfg);
  assert.ok(w.includes('- `npm test`') && w.includes('- `npm run lint`'));
  assert.ok(w.includes('at most 900 tokens'));
  assert.ok(w.includes('vendor/**'));
});

test('init in a linked worktree writes to the main checkout', () => {
  const repo = h.makeRepo();
  const wt = path.join(h.tmpDir(), 'wt');
  h.git(repo, 'worktree', 'add', '-q', '-b', 'feat/w', wt);
  const r = h.crew(['init'], wt);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'crew.json')));
  assert.ok(!fs.existsSync(path.join(wt, '.claude', 'crew.json')));
});

test('init usage error: unknown option exits 2', () => {
  const repo = h.makeRepo();
  assert.equal(h.crew(['init', '--bogus'], repo).code, 2);
});

// ---------------------------------------------------------------- doctor
test('doctor: healthy project reports each check; board down is not an error', async () => {
  const repo = u.initRepo();
  const port = await freePort();
  u.patchCfg(repo, (c) => { c.board = { enabled: true, port }; });
  const r = await u.crewAsync(['--json', 'doctor'], repo);
  const d = JSON.parse(r.out);
  const by = Object.fromEntries(d.checks.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by), ['node', 'config', 'registration', 'files', 'engine', 'hooks', 'board']);
  assert.equal(by.node.status, 'ok');
  assert.equal(by.config.status, 'ok');
  assert.equal(by.registration.status, 'ok');
  assert.equal(by.files.status, 'ok');
  assert.equal(by.board.status, 'ok');
  assert.match(by.board.detail, /not running/);
  const hooks = path.join(__dirname, '..', 'hooks', 'hooks.json');
  assert.equal(by.hooks.status, fs.existsSync(hooks) ? 'ok' : 'fail');
  assert.equal(r.code, d.ok ? 0 : 1);
});

test('doctor: board answering with the agent-crew health JSON is running', async () => {
  const repo = u.initRepo();
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/health' ? JSON.stringify({ ok: true, name: 'agent-crew' }) : '{}');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    u.patchCfg(repo, (c) => { c.board = { enabled: true, port: srv.address().port }; });
    const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    const board = d.checks.find((c) => c.name === 'board');
    assert.equal(board.status, 'ok');
    assert.match(board.detail, /running/);
  } finally { srv.close(); }
});

test('doctor: a foreign service on the board port is a warning', async () => {
  const repo = u.initRepo();
  const srv = http.createServer((req, res) => { res.statusCode = 404; res.end('nope'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    u.patchCfg(repo, (c) => { c.board = { enabled: true, port: srv.address().port }; });
    const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
    assert.equal(d.checks.find((c) => c.name === 'board').status, 'warn');
  } finally { srv.close(); }
});

test('doctor: invalid config fails with the field path', async () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.limits = { max_parallel_workers: 0 }; });
  const r = await u.crewAsync(['--json', 'doctor'], repo);
  const d = JSON.parse(r.out);
  const cfg = d.checks.find((c) => c.name === 'config');
  assert.equal(cfg.status, 'fail');
  assert.match(cfg.detail, /limits\.max_parallel_workers/);
  assert.equal(r.code, 1);
});

test('doctor: outside any project warns instead of crashing; unregistered project warns', async () => {
  const plain = h.tmpDir('crew-plain-');
  const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], plain)).out);
  assert.equal(d.checks.find((c) => c.name === 'config').status, 'warn');
  assert.equal(d.checks.find((c) => c.name === 'registration').status, 'warn');
  const repo = u.initRepo();
  h.crew(['project', 'rm', repo], repo);
  const d2 = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
  assert.equal(d2.checks.find((c) => c.name === 'registration').status, 'warn');
});

test('doctor: disabled board is skipped; missing files are listed', async () => {
  const repo = u.initRepo();
  u.patchCfg(repo, (c) => { c.board = { enabled: false, port: 8781 }; });
  fs.rmSync(path.join(repo, '.crew', 'REVIEW.md'));
  const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], repo)).out);
  assert.match(d.checks.find((c) => c.name === 'board').detail, /disabled/);
  const files = d.checks.find((c) => c.name === 'files');
  assert.equal(files.status, 'warn');
  assert.match(files.detail, /REVIEW\.md/);
});

// ---------------------------------------------------------------- i18n
test('workflow i18n tables have identical keys and cover every key used in the code', () => {
  const dir = path.join(__dirname, '..', 'lib', 'i18n');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.zh-TW.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  const used = new Set();
  for (const sub of ['commands', 'features']) {
    const d = path.join(__dirname, '..', 'lib', sub);
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(d, f), 'utf8');
      for (const m of src.matchAll(/'(wf\.[A-Za-z.]+)'/g)) used.add(m[1]);
    }
  }
  for (const a of ['created', 'kept', 'overwritten']) used.add(`wf.init.${a}`);
  for (const n of ['node', 'config', 'registration', 'files', 'engine', 'hooks', 'board']) used.add(`wf.doctor.name.${n}`);
  const missing = [...used].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
  for (const k of Object.keys(en)) {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(vars(zh[k]), vars(en[k]), `placeholders differ for ${k}`);
  }
});

function freePort() {
  return new Promise((ok) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}
