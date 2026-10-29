'use strict';
// Regression tests for the review round "fix/review-1" (items numbered as in the review report).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const config = require('../lib/core/config');
const paths = require('../lib/core/paths');
const store = require('../lib/core/store');
const execx = require('../lib/core/exec');
const { redact, MASK } = require('../lib/core/redact');
const rv = require('../lib/features/review');
const lessons = require('../lib/features/lessons');
const board = require('../lib/commands/board');
const { TIMEOUT_S, guardMs } = require('../lib/hooks/timeouts');
const project = require('../lib/core/project');

const j = (...p) => p.join(''); // secret-looking samples are assembled at runtime (repo hygiene scan)
const run = (repo, ...args) => h.crew(args, repo);
const SRC = 'const total = compute(1);\nmodule.exports = total;\n';

function setup() {
  const repo = u.initRepo();
  u.writeFile(repo, 'src/x.js', SRC);
  const t = u.createTask(repo);
  const dir = paths.taskDir(project.findByCwd(repo).id, t.id);
  const submit = (list, extra = []) => u.crewIn(['review', 'submit', t.id, ...extra], repo, JSON.stringify(list));
  return { repo, t, dir, submit };
}

// ---------------------------------------------------------------- 1. secrets never reach git
test('1: dismiss never writes snippet text; findings files are redacted; matching still works', () => {
  const { repo, t, dir, submit } = setup();
  const secret = j('pass', 'word=hunter2hunter2');
  const code = `const x = "${secret}";`;
  u.writeFile(repo, 'src/x.js', `${code}\nmodule.exports = x;\n`);
  const f = u.finding('s1', { snippet: code, claim: `leaks ${secret}`, suggestion: `drop ${secret}`, evidence: [`src/x.js:1 ${secret}`] });
  assert.equal(submit([f]).code, 0);
  const rawText = fs.readFileSync(path.join(dir, 'findings', '1.raw.json'), 'utf8');
  assert.ok(!rawText.includes('hunter2'), 'raw findings are redacted');
  const filt = u.crewJson(['review', 'filter', t.id], repo);
  assert.equal(filt.code, 0, filt.err);
  assert.ok(!fs.readFileSync(path.join(dir, 'findings', '1.kept.json'), 'utf8').includes('hunter2'));
  const d = u.crewJson(['review', 'dismiss', t.id, 's1', '--scope', 'once', '--reason', 'known'], repo);
  assert.equal(d.code, 0, d.err);
  const ledgerText = fs.readFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), 'utf8');
  assert.ok(!ledgerText.includes('hunter2') && !ledgerText.includes('"snippet"'), 'no snippet text in the ledger');
  assert.match(ledgerText, /"snippet_hash":"[0-9a-f]{64}"/);
  // the fingerprint was taken before redaction, so the same finding is recognised in the next round
  submit([{ ...f, id: 's2' }], ['--round', '2']);
  const again = u.crewJson(['review', 'filter', t.id, '--round', '2'], repo);
  assert.deepEqual(again.data.dropped.map((x) => x.reason), ['dismissed']);
  // once: the code changes, the hash no longer finds the snippet in the file
  u.writeFile(repo, 'src/x.js', 'module.exports = 1;\n');
  submit([{ ...f, id: 's3' }], ['--round', '3']);
  assert.deepEqual(u.crewJson(['review', 'filter', t.id, '--round', '3'], repo).data.kept.map((x) => x.id), ['s3']);
});

test('1: refutations are redacted too, and an old ledger entry that still has "snippet" keeps matching', () => {
  const { repo, t, dir, submit } = setup();
  const secret = j('tok', 'en=abcdef123456');
  submit([u.finding('a')]);
  u.crewJson(['review', 'filter', t.id], repo);
  u.crewIn(['review', 'submit', t.id, '--kind', 'refutations'], repo, JSON.stringify([{ id: 'a', verdict: 'upheld', evidence: `src/x.js:1 ${secret}` }]));
  assert.ok(!fs.readFileSync(path.join(dir, 'findings', '1.refutations.json'), 'utf8').includes('abcdef123456'));
  const fin = u.crewJson(['review', 'finalize', t.id], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.ok(!fs.readFileSync(path.join(dir, 'findings', '1.json'), 'utf8').includes('abcdef123456'));
  // legacy entry
  const f = u.finding('b');
  const legacy = { fingerprint: rv.fingerprint(f), category: f.category, file: f.file, symbol: f.symbol, snippet: f.snippet, reason: 'old', scope: 'once', decided_by: 'x', date: '2026-01-01' };
  fs.writeFileSync(path.join(repo, '.crew', 'dismissed.jsonl'), `${JSON.stringify(legacy)}\n`);
  submit([f], ['--round', '2']);
  assert.deepEqual(u.crewJson(['review', 'filter', t.id, '--round', '2'], repo).data.dropped.map((x) => x.reason), ['dismissed']);
});

test('1: snippet digest matches any window of the normalised file and ignores whitespace', () => {
  const d = rv.snippetDigest('foo(  1,\n   2 )');
  const dir = h.tmpDir();
  u.writeFile(dir, 'a.js', 'x = 1;\nbar = foo( 1,\n\t2 );\n');
  const fnd = { file: 'a.js', snippet: 'REDACTED', ...d };
  assert.equal(rv.snippetPresent([dir], fnd), true);
  u.writeFile(dir, 'a.js', 'x = 1;\nbar = foo(1, 3);\n');
  assert.equal(rv.snippetPresent([dir], fnd), false);
  assert.ok(!JSON.stringify(d).includes('foo'));
});

// ---------------------------------------------------------------- 5. ".." prefix check
test('5: a file called "..x" inside the base is inside; real escapes are outside', () => {
  assert.equal(paths.isOutside('..evil.js'), false);
  assert.equal(paths.isOutside(path.join('sub', '..evil.js')), false);
  assert.equal(paths.isOutside('..'), true);
  assert.equal(paths.isOutside(path.join('..', 'x')), true);
  assert.equal(paths.isOutside(path.resolve('/')), true);
  const dir = h.tmpDir();
  u.writeFile(dir, '..evil.js', 'const total = compute(1);');
  const f = { file: '..evil.js', snippet: 'const total = compute(1);' };
  assert.equal(rv.snippetPresent([dir], { ...f, ...rv.snippetDigest(f.snippet) }), true);
  assert.equal(rv.snippetPresent([dir], f), true);
});

// ---------------------------------------------------------------- 6. redaction gaps
test('6: suffixed keys, Authorization token, npm, Stripe and Google keys are masked', () => {
  assert.equal(redact('SECRET_KEY=abc123xyz'), `SECRET_KEY=${MASK}`);
  assert.equal(redact('DB_PASSWORD_PROD=pw123456'), `DB_PASSWORD_PROD=${MASK}`);
  assert.equal(redact('api-token: abcdef12345'), `api-token: ${MASK}`);
  assert.equal(redact('report_max_tokens: 1500'), 'report_max_tokens: 1500');
  assert.equal(redact(`Authorization: ${j('tok', 'en')} abcdef1234567890`), `Authorization: ${j('tok', 'en')} ${MASK}`);
  assert.equal(redact('Authorization: plainvalue12345'), `Authorization: ${MASK}`);
  for (const s of [j('npm', '_', 'a1B2'.repeat(9)), j('sk', '_live_', 'A1b2C3d4E5f6G7h8'), j('rk', '_live_', 'A1b2C3d4E5f6G7h8'), j('AI', 'za', 'Sy', 'A'.repeat(33))]) {
    assert.equal(redact(`key ${s} end`), `key ${MASK} end`, s);
  }
  const once = redact(`Authorization: ${j('tok', 'en')} abcdef1234567890 SECRET_KEY=zz1`);
  assert.equal(redact(once), once);
});

// ---------------------------------------------------------------- 4. Windows / PATH engine resolution
test('4: resolveCommand finds a bare command on PATH (+ PATHEXT on win32) and a plain executable elsewhere', () => {
  const dir = h.tmpDir();
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'fakecodex.cmd');
    fs.writeFileSync(cmd, '@echo off\r\necho got %1\r\n');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(execx.resolveCommand('fakecodex', { env }).toLowerCase(), cmd.toLowerCase());
    assert.equal(execx.resolveCommand('nothere', { env }), null);
    // really run it through the cmd.exe plan: arguments with spaces survive
    const plan = execx.spawnPlan(cmd, ['hello world']);
    assert.equal(plan.options.windowsVerbatimArguments, true);
    const r = require('node:child_process').spawnSync(plan.file, plan.args, { encoding: 'utf8', ...plan.options });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /got "hello world"/);
    assert.throws(() => execx.spawnPlan(cmd, ['a"b']), /cannot be passed safely/);
    assert.throws(() => execx.spawnPlan(cmd, ['%PATH%']), /cannot be passed safely/);
  } else {
    const exe = path.join(dir, 'fakecodex');
    fs.writeFileSync(exe, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const noexec = path.join(dir, 'plain');
    fs.writeFileSync(noexec, 'x', { mode: 0o644 });
    assert.equal(execx.resolveCommand('fakecodex', { env: { PATH: dir } }), exe);
    assert.equal(execx.resolveCommand('plain', { env: { PATH: dir } }), null);
    assert.equal(execx.resolveCommand('nothere', { env: { PATH: dir } }), null);
    assert.deepEqual(execx.spawnPlan(exe, ['a b']), { file: exe, args: ['a b'], options: {} });
  }
});

test('4: win32 resolution logic (PATHEXT order, extension given, no shell) is testable on any OS', () => {
  const dir = h.tmpDir();
  fs.writeFileSync(path.join(dir, 'tool.cmd'), 'x');
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  assert.equal(execx.resolveCommand('tool', { env, platform: 'win32' }).toLowerCase(), path.join(dir, 'tool.cmd').toLowerCase());
  assert.equal(execx.resolveCommand('tool.cmd', { env, platform: 'win32' }).toLowerCase(), path.join(dir, 'tool.cmd').toLowerCase());
  assert.equal(execx.resolveCommand('plain', { env, platform: 'win32' }), null);
  const plan = execx.spawnPlan('C:\\Program Files\\x\\tool.cmd', ['exec', 'a b', '-'], { platform: 'win32', comspec: 'cmd.exe' });
  assert.equal(plan.file, 'cmd.exe');
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.args[3], '""C:\\Program Files\\x\\tool.cmd" exec "a b" -"');
  assert.equal(plan.options.windowsVerbatimArguments, true);
  const direct = execx.spawnPlan('C:\\bin\\tool.exe', ['a'], { platform: 'win32' });
  assert.deepEqual(direct, { file: 'C:\\bin\\tool.exe', args: ['a'], options: {} });
});

test('4+8: doctor reports each global engine; a project engines block is ignored with a warning', async () => {
  const repo = u.initRepo();
  const script = u.writeFile(h.tmpDir(), 'e.js', '');
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines: { good: { command: process.execPath, args: [script] }, ghost: { command: 'definitely-not-installed-xyz', args: [] } } }));
  u.patchCfg(repo, (c) => { c.engines = { evil: { command: process.execPath, args: ['-e', 'process.exit(0)'] } }; });
  const r = await u.crewAsync(['--json', 'doctor'], repo);
  const d = JSON.parse(r.out);
  const engines = d.checks.filter((c) => c.name === 'engine');
  assert.ok(engines.some((c) => c.status === 'ok' && c.detail.startsWith('good:')));
  assert.ok(engines.some((c) => c.status === 'warn' && c.detail.startsWith('ghost:')));
  assert.equal(engines.some((c) => c.detail.startsWith('evil')), false);
  const cfg = d.checks.find((c) => c.name === 'config');
  assert.equal(cfg.status, 'warn');
  assert.match(cfg.detail, /engines in this project config are ignored/);
  fs.rmSync(paths.configFile(), { force: true });
});

// ---------------------------------------------------------------- 8. trust boundary
test('8: project engines are never used; review run warns; rules_file must stay inside the project', () => {
  const repo = u.initRepo();
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'init');
  const marker = path.join(h.tmpDir(), 'pwned.txt');
  u.patchCfg(repo, (c) => {
    c.engines = { evil: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } };
  });
  const loaded = config.load(repo);
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.warnings[0].path, 'engines');
  assert.equal('engines' in loaded.config, false);
  assert.deepEqual(config.validate({ roles: { r: { engine: 'evil' } }, engines: { evil: {} } }).map((e) => e.key), ['config.err.engine']);
  assert.throws(() => config.save(repo, { engines: { x: { command: 'y' } } }), /engines cannot be defined/);
  const t = u.createTask(repo);
  const r = run(repo, 'review', 'run', t.id, '--engine', 'evil');
  assert.equal(r.code, 1);
  assert.match(r.err, /No engine named "evil" in the global config/);
  assert.match(r.err, /engines in this project config are ignored/);
  assert.equal(fs.existsSync(marker), false, 'the project-defined program was not started');
  // rules_file
  for (const bad of ['../outside.md', path.resolve(h.tmpDir(), 'abs.md')]) {
    assert.equal(config.validate({ lessons: { rules_file: bad } }, repo).length, 1, bad);
  }
  assert.deepEqual(config.validate({ lessons: { rules_file: 'docs/RULES.md' } }, repo), []);
  assert.deepEqual(config.validate({ lessons: { rules_file: '..rules.md' } }, repo), []);
});

// ---------------------------------------------------------------- 9. init --force
test('9: init --force keeps REVIEW.md and LESSONS.md; --reset-review-files replaces them with a backup', () => {
  const repo = u.initRepo();
  fs.appendFileSync(path.join(repo, '.crew', 'REVIEW.md'), '\nmy rule\n');
  fs.appendFileSync(path.join(repo, '.crew', 'LESSONS.md'), '- 2026-01-01 [correction] k: mine\n');
  const r = u.crewJson(['init', '--force'], repo);
  assert.equal(r.code, 0, r.err);
  const by = Object.fromEntries(r.data.files.map((f) => [f.file, f]));
  assert.equal(by['.crew/REVIEW.md'].action, 'kept');
  assert.equal(by['.crew/LESSONS.md'].action, 'kept');
  assert.ok(fs.readFileSync(path.join(repo, '.crew', 'REVIEW.md'), 'utf8').includes('my rule'));
  assert.ok(fs.readFileSync(path.join(repo, '.crew', 'LESSONS.md'), 'utf8').includes('mine'));
  const z = u.crewJson(['init', '--reset-review-files'], repo);
  assert.equal(z.code, 0, z.err);
  const zb = Object.fromEntries(z.data.files.map((f) => [f.file, f]));
  assert.equal(zb['.crew/REVIEW.md'].action, 'overwritten');
  assert.ok(fs.readFileSync(path.join(repo, zb['.crew/REVIEW.md'].backup), 'utf8').includes('my rule'));
  assert.ok(!fs.readFileSync(path.join(repo, '.crew', 'REVIEW.md'), 'utf8').includes('my rule'));
});

// ---------------------------------------------------------------- 10. reserved keys
test('10: validate set refuses __proto__, constructor and prototype', () => {
  const repo = u.initRepo();
  const pid = project.findByCwd(repo).id;
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const r = run(repo, 'validate', 'set', k, '2026-01-02', 'host', 'ok');
    assert.equal(r.code, 2, k);
    assert.match(r.err, /reserved name/);
    assert.throws(() => store.validateSet(pid, { templateId: k, date: '2026-01-02', host: 'h', result: 'r' }), /reserved/);
  }
  assert.deepEqual(store.validateList(pid), {});
  assert.equal(run(repo, 'validate', 'set', 'T-1', '2026-01-02', 'host', 'ok').code, 0);
  const merged = config.deepMerge({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "b": 2}'));
  assert.equal(merged.b, 2);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal({}.polluted, undefined);
});

// ---------------------------------------------------------------- 11. browser open
test('11: openPlan only opens http://127.0.0.1:<port>/... and quotes nothing on Windows', () => {
  const win = board.openPlan('http://127.0.0.1:8781/', 'win32');
  assert.equal(win.cmd, 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'start', '""', 'http://127.0.0.1:8781/']);
  assert.equal(win.options.windowsVerbatimArguments, true);
  assert.equal(win.options.detached, true);
  assert.equal(board.openPlan('http://127.0.0.1:8781/', 'darwin').cmd, 'open');
  assert.equal(board.openPlan('http://127.0.0.1:8781/', 'linux').cmd, 'xdg-open');
  for (const bad of ['http://evil.test/', 'https://127.0.0.1:8781/', 'http://127.0.0.1:8781/ & calc', 'http://127.0.0.1:8781/"x', 'file:///c:/x', 'http://127.0.0.1/', 'http://127.0.0.1:8781/%PATH%', '']) {
    assert.equal(board.openPlan(bad, 'win32'), null, bad);
  }
});

// ---------------------------------------------------------------- 12. hook guard vs timeout
test('12: hook guards come from one table that agrees with hooks.json', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const kebab = (n) => n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const seen = new Set();
  for (const [name, groups] of Object.entries(hooks)) {
    const ev = kebab(name);
    seen.add(ev);
    const timeouts = groups.flatMap((g) => g.hooks.map((x) => x.timeout));
    assert.ok(ev in TIMEOUT_S, `${ev} missing from the table`);
    assert.equal(TIMEOUT_S[ev], Math.min(...timeouts), `${ev}: table and hooks.json disagree`);
    assert.ok(guardMs(ev) < TIMEOUT_S[ev] * 1000, `${ev}: guard must fire before the timeout`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(TIMEOUT_S).sort());
  assert.equal(guardMs('user-prompt-submit'), 4000);
  assert.equal(guardMs('pre-tool-use'), 4000);
  assert.equal(guardMs('session-end'), 1200);
  assert.equal(guardMs('session-start'), 9000);
  assert.ok(guardMs('nope') >= 500);
});

// ---------------------------------------------------------------- 13. lesson rules
test('13: rule text is one bounded line without markers; other lines in the block survive', () => {
  const repo = u.initRepo();
  const add = (key, date) => assert.equal(run(repo, 'lesson', 'add', '--key', key, '--text', 'x', '--date', date).code, 0);
  add('k1', '2026-01-01');
  add('k2', '2026-01-02');
  const bad = (text) => run(repo, 'lesson', 'promote', 'k1', '--rule', text);
  assert.match(bad(`one\ntwo`).err, /single line/);
  assert.match(bad(`a ${lessons.END} b`).err, /markers/);
  assert.match(bad(`a ${lessons.START}`).err, /markers/);
  assert.match(bad('x'.repeat(301)).err, /at most 300/);
  assert.equal(bad('x'.repeat(300)).code, 0);
  const file = path.join(repo, 'CLAUDE.md');
  // a hand-written note and a blank line inside the block
  const text = fs.readFileSync(file, 'utf8').replace(lessons.START, `${lessons.START}\n<!-- keep me -->\nuser note`);
  fs.writeFileSync(file, text);
  assert.equal(run(repo, 'lesson', 'promote', 'k2', '--rule', 'Second.').code, 0);
  let now = fs.readFileSync(file, 'utf8');
  assert.ok(now.includes('<!-- keep me -->\nuser note'));
  assert.equal(run(repo, 'lesson', 'retire', 'k1').code, 0);
  now = fs.readFileSync(file, 'utf8');
  assert.ok(now.includes('<!-- keep me -->\nuser note') && now.includes('Second.') && !now.includes('xxxxxxxxxx'));
});

test('4: review run starts an engine given without extension (a .cmd on Windows, a script elsewhere) found via PATH', () => {
  const repo = u.initRepo();
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'init');
  h.git(repo, 'checkout', '-q', '-b', 'feat/e');
  u.writeFile(repo, 'src/x.js', SRC);
  h.git(repo, 'add', '.');
  h.git(repo, 'commit', '-q', '-m', 'work');
  h.git(repo, 'checkout', '-q', '-');
  const bin = h.tmpDir();
  const finding = JSON.stringify([u.finding('c1')]);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'fakereviewer.cmd'), `@echo off\r\nmore >nul\r\necho ${finding.replace(/[<>&|^%"]/g, '^$&')}\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'fakereviewer'), `#!/bin/sh\ncat >/dev/null\nprintf '%s\n' '${finding}'\n`, { mode: 0o755 });
  }
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines: { shim: { command: 'fakereviewer', args: ['exec', 'a b', '-'] } } }));
  const t = u.createTask(repo, { branch: 'feat/e' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const r = u.crewJson(['review', 'run', t.id, '--engine', 'shim'], repo);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.data.count, 1);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(paths.configFile(), { force: true });
  }
});
