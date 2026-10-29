'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const u = require('./update-helpers');

u.setupHome();
const ua = require('../lib/core/update-apply');

const LIST_OK = JSON.stringify([{ id: 'crewgate@crewgate', version: '0.10.1' }]);
const CODEX_TOML = '[plugins."crewgate@crewgate"]\nenabled = true\n';

// A fake machine: a bin folder with fake CLIs, a Claude config dir (the plugin is "installed" in it)
// and a Codex home. Returns what a runner needs.
function machine({ claude = true, codex = true, claudeListed = true, codexConfigured = true, claudeCfg = {}, codexCfg = {} } = {}) {
  const root = u.tmpDir('crew-machine-');
  const bin = path.join(root, 'bin');
  const claudeDir = path.join(root, '.claude');
  const codexDir = path.join(root, '.codex');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const pluginRoot = path.join(claudeDir, 'plugins', 'marketplaces', 'crewgate', 'plugins', 'crewgate');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  if (claude) u.fakeCli(bin, 'claude', { log, list: claudeListed ? LIST_OK : '[]', ...claudeCfg }, u.CLAUDE_BODY);
  if (codex) u.fakeCli(bin, 'codex', { log, ...codexCfg }, u.CODEX_BODY);
  if (codexConfigured) fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "x"\n${CODEX_TOML}`);
  const env = u.fakeEnv({ bin, claudeDir, codexDir });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { root, bin, claudeDir, codexDir, pluginRoot, env, calls };
}

async function runIt(m, extra = {}) {
  const runner = ua.createRunner({ pluginRoot: m.pluginRoot, env: m.env, ...extra });
  const r = runner.start();
  assert.equal(r.started, true);
  await r.done;
  return runner;
}

test('both installed: the three fixed commands run in order, stdin of codex is closed', async () => {
  const m = machine();
  const runner = await runIt(m);
  const s = runner.status();
  assert.equal(s.state, 'done', JSON.stringify(s));
  assert.deepEqual(s.steps.map((x) => x.cmd), [
    'claude plugin marketplace update crewgate',
    'claude plugin update crewgate@crewgate',
    'codex plugin marketplace upgrade crewgate',
  ]);
  assert.ok(s.steps.every((x) => x.ok));
  assert.deepEqual(m.calls().filter((c) => !c.startsWith('claude plugin list')), [
    'claude plugin marketplace update crewgate',
    'claude plugin update crewgate@crewgate',
    'codex plugin marketplace upgrade crewgate',
    'stdin-closed',
  ]);
  assert.equal(m.calls().includes('stdin-open'), false);
});

test('only Claude installed: no codex command is run', async () => {
  const m = machine({ codex: false, codexConfigured: false });
  const s = (await runIt(m)).status();
  assert.equal(s.state, 'done');
  assert.deepEqual(s.steps.map((x) => x.tool), ['claude', 'claude']);
  assert.equal(m.calls().some((c) => c.startsWith('codex')), false);
});

test('a CLI that exists but does not have the plugin installed is skipped', async () => {
  const m = machine({ claudeListed: false });          // codex still has it
  const s = (await runIt(m)).status();
  assert.deepEqual(s.steps.map((x) => x.tool), ['codex']);
  const m2 = machine({ codexConfigured: false });      // codex binary but no [plugins."crewgate@crewgate"]
  const s2 = (await runIt(m2)).status();
  assert.deepEqual(s2.steps.map((x) => x.tool), ['claude', 'claude']);
});

test('plain-text `plugin list` output is accepted when --json shows nothing', async () => {
  const m = machine({ codex: false, codexConfigured: false, claudeCfg: { list: 'crewgate@crewgate  0.10.1  enabled' } });
  assert.equal((await runIt(m)).status().state, 'done');
});

test('neither CLI found: nothing runs, the exact commands come back for copying', async () => {
  const m = machine({ claude: false, codex: false });
  const s = (await runIt(m)).status();
  assert.equal(s.state, 'manual');
  assert.deepEqual(s.steps, []);
  assert.deepEqual(s.manual, [
    { tool: 'claude', reason: 'cliNotFound', commands: ['claude plugin marketplace update crewgate', 'claude plugin update crewgate@crewgate'] },
    { tool: 'codex', reason: 'cliNotFound', commands: ['codex plugin marketplace upgrade crewgate'] },
  ]);
  assert.deepEqual(s.results.map((x) => [x.tool, x.status, x.reason]), [['claude', 'manual', 'cliNotFound'], ['codex', 'manual', 'cliNotFound']]);
  assert.deepEqual(m.calls(), []);
});

test('development checkout (not under ~/.claude/plugins or ~/.codex/plugins): nothing runs, even with both CLIs', async () => {
  const m = machine();
  const dev = path.join(m.root, 'checkout', 'plugins', 'crewgate');
  fs.mkdirSync(dev, { recursive: true });
  const runner = ua.createRunner({ pluginRoot: dev, env: m.env });
  await runner.start().done;
  assert.equal(runner.status().state, 'manual');
  assert.deepEqual(m.calls(), [], 'not even the probe ran');
  assert.equal(ua.isManaged(dev, m.env), false);
  assert.equal(ua.isManaged(m.pluginRoot, m.env), true);
  assert.equal(ua.isManaged(path.join(m.codexDir, 'plugins', 'cache', 'crewgate', 'crewgate', '1.0.0'), m.env), true);
});

test('a failing command stops the run, is reported, and its output is redacted and truncated', async () => {
  const noise = `password=hunter2 token=abc ${'x'.repeat(5000)}`;
  const m = machine({ claudeCfg: { fail: true, noise } });
  const s = (await runIt(m)).status();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'update.stepFailed');
  assert.equal(s.steps.length, 2, 'stopped at the failing command');
  const bad = s.steps[1];
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.ok(bad.output.length <= 2000);
  assert.doesNotMatch(bad.output, /hunter2/);
  assert.equal(m.calls().some((c) => c.startsWith('codex')), false, 'nothing after a failure');
});

test('a command that hangs is killed after the time limit', async () => {
  const m = machine({ codex: false, codexConfigured: false, claudeCfg: { sleep: 20000 } });
  const t0 = Date.now();
  const s = (await runIt(m, { stepTimeoutMs: 400 })).status();
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(s.state, 'failed');
  assert.equal(s.steps[0].timed_out, true);
});

test('only one update at a time: a second start is refused until the first ends', async () => {
  const m = machine({ codex: false, codexConfigured: false, claudeCfg: { sleep: 1500 } });
  const first = ua.createRunner({ pluginRoot: m.pluginRoot, env: m.env, stepTimeoutMs: 400 });
  const other = ua.createRunner({ pluginRoot: m.pluginRoot, env: m.env });
  const a = first.start();
  assert.equal(a.started, true);
  assert.equal(first.start().started, false, 'same runner');
  assert.equal(other.start().started, false, 'another runner (another process) sees the lock file');
  await a.done;
  const again = other.start();
  assert.equal(again.started, true, 'lock released');
  await again.done;
});

test('a stale lock of a dead process is taken over', async () => {
  const m = machine({ codex: false, codexConfigured: false });
  const lock = path.join(process.env.CREWGATE_HOME, 'update.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, created: Date.now() }));
  const r = ua.createRunner({ pluginRoot: m.pluginRoot, env: m.env }).start();
  assert.equal(r.started, true);
  await r.done;
});

test('Windows Store codex is only used when codex is not on PATH', async () => {
  const store = u.tmpDir('crew-store-');
  const exe = path.join(store, 'OpenAI.Codex_26.1.0.0_x64__abc', 'app', 'resources', 'codex.exe');
  const older = path.join(store, 'OpenAI.Codex_9.0.0.0_x64__abc', 'app', 'resources', 'codex.exe');
  for (const f of [exe, older]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  const env = { PATH: u.tmpDir('crew-empty-'), CREWGATE_CODEX_STORE_DIR: store };
  env.CREWGATE_POWERSHELL = path.join(store, 'no-powershell');
  assert.equal(await ua.findCli('codex', env, 'win32'), exe, 'newest package');
  assert.equal(await ua.findCli('codex', env, 'linux'), null, 'only on Windows');
  assert.equal(await ua.findCli('claude', env, 'win32'), null, 'only codex has the fallback');
  const onPath = u.tmpDir('crew-bin-');
  fs.writeFileSync(path.join(onPath, 'codex.exe'), '');
  assert.equal((await ua.findCli('codex', { ...env, PATH: onPath }, 'win32')).toLowerCase(), path.join(onPath, 'codex.exe').toLowerCase());
});

test('locateNewRoot: a version-named cache folder moves to the newest sibling, a marketplace clone stays', () => {
  const cache = u.tmpDir('crew-cache-');
  const base = path.join(cache, 'plugins', 'cache', 'crewgate', 'crewgate');
  for (const v of ['0.10.1', '0.10.2', '0.9.0', 'junk']) {
    fs.mkdirSync(path.join(base, v, 'bin'), { recursive: true });
    if (v !== 'junk') fs.writeFileSync(path.join(base, v, 'bin', 'crew.js'), '');
  }
  fs.mkdirSync(path.join(base, '0.11.0'), { recursive: true });   // no bin/crew.js: not usable yet
  assert.equal(ua.locateNewRoot(path.join(base, '0.10.1')), fs.realpathSync(path.join(base, '0.10.2')));
  const clone = path.join(cache, 'plugins', 'marketplaces', 'crewgate', 'plugins', 'crewgate');
  fs.mkdirSync(clone, { recursive: true });
  assert.equal(ua.locateNewRoot(clone), fs.realpathSync(clone));
});
