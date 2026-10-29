'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const u = require('./update-helpers');

u.setupHome();
const ua = require('../lib/core/update-apply');

const LIST_OK = JSON.stringify([{ id: 'crewgate@crewgate', version: '0.12.0' }]);
const TOML = '[plugins."crewgate@crewgate"]\nenabled = true\n';
// fake PowerShell: prints cfg.out and exits with cfg.code; records its arguments
const PS_BODY = `
log('powershell ' + args.join(' '));
if (cfg.sleep) { setTimeout(() => {}, cfg.sleep); return; }
process.stdout.write(cfg.out || '');
process.exit(cfg.code || 0);
`;

// An Appx-style install: <loc>\app\resources\codex.exe
function appx(withExe = true) {
  const loc = u.tmpDir('crew-appx-');
  const exe = path.join(loc, 'app', 'resources', 'codex.exe');
  if (withExe) { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, ''); }
  return { loc, exe };
}

function fakePowerShell(cfg) {
  const dir = u.tmpDir('crew-ps-');
  const log = path.join(dir, 'ps.log');
  u.fakeCli(dir, 'powershell', { log, ...cfg }, PS_BODY);
  const file = path.join(dir, process.platform === 'win32' ? 'powershell.cmd' : 'powershell');
  return { file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

function envWith(extra = {}) {
  return { PATH: u.tmpDir('crew-empty-'), CREWGATE_CODEX_STORE_DIR: path.join(u.tmpDir('crew-nostore-'), 'missing'), ...extra };
}

test('codex on PATH wins and PowerShell is not asked', async () => {
  const onPath = u.tmpDir('crew-bin-');
  fs.writeFileSync(path.join(onPath, 'codex.exe'), '');
  const ps = fakePowerShell({ out: appx().loc });
  const found = await ua.findCodex(envWith({ PATH: onPath, CREWGATE_POWERSHELL: ps.file }), 'win32');
  assert.equal(found.toLowerCase(), path.join(onPath, 'codex.exe').toLowerCase());
  assert.deepEqual(ps.calls(), []);
});

test('PATH miss: PowerShell answers with an InstallLocation and its codex.exe is used', async () => {
  const a = appx();
  const ps = fakePowerShell({ out: `${a.loc}\r\n` });
  const found = await ua.findCodex(envWith({ CREWGATE_POWERSHELL: ps.file }), 'win32');
  assert.equal(found, a.exe);
  const calls = ps.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /-NoProfile -NonInteractive -Command/);
  assert.match(calls[0], /Get-AppxPackage -Name OpenAI\.Codex/);
});

test('PowerShell is only used on Windows', async () => {
  const a = appx();
  const ps = fakePowerShell({ out: a.loc });
  assert.equal(await ua.findCodex(envWith({ CREWGATE_POWERSHELL: ps.file }), 'linux'), null);
  assert.deepEqual(ps.calls(), []);
});

test('a bad PowerShell answer (no folder, no codex.exe, relative path, failure) falls through without throwing', async () => {
  const noExe = appx(false);
  for (const cfg of [{ out: '' }, { out: noExe.loc }, { out: 'relative\\path' }, { out: 'x', code: 1 }]) {
    const ps = fakePowerShell(cfg);
    assert.equal(await ua.findCodex(envWith({ CREWGATE_POWERSHELL: ps.file }), 'win32'), null, JSON.stringify(cfg));
  }
  assert.equal(await ua.findCodex(envWith({ CREWGATE_POWERSHELL: path.join(noExe.loc, 'nope') }), 'win32'), null, 'program missing');
});

test('a PowerShell that hangs is killed after the time limit and the listing is used last', async () => {
  const store = u.tmpDir('crew-store-');
  const exe = path.join(store, 'OpenAI.Codex_26.1.0.0_x64__abc', 'app', 'resources', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const ps = fakePowerShell({ sleep: 20000 });
  const t0 = Date.now();
  const found = await ua.findCodex(envWith({ CREWGATE_POWERSHELL: ps.file, CREWGATE_CODEX_STORE_DIR: store }), 'win32', { powershellTimeoutMs: 400 });
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(found, exe);
});

test('engines.codex.command of the global config is honoured as an explicit path', async () => {
  const dir = u.tmpDir('crew-custom-');
  const custom = path.join(dir, process.platform === 'win32' ? 'mycodex.exe' : 'mycodex');
  fs.writeFileSync(custom, '');
  if (process.platform !== 'win32') fs.chmodSync(custom, 0o755);
  u.writeGlobalConfig({ engines: { codex: { command: custom, args: ['exec', '-'] } } });
  try {
    assert.equal(await ua.findCodex(envWith(), process.platform), custom);
  } finally { u.writeGlobalConfig({}); }
});

// ---------------------------------------------------------------- the plan and the final status
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
  if (codexConfigured) fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "x"\n${TOML}`);
  const env = u.fakeEnv({ bin, claudeDir, codexDir });
  return { root, bin, claudeDir, codexDir, pluginRoot, env };
}

async function runIt(m) {
  const runner = ua.createRunner({ pluginRoot: m.pluginRoot, env: m.env });
  const r = runner.start();
  assert.equal(r.started, true);
  await r.done;
  return runner.status();
}

const brief = (s) => s.results.map((x) => `${x.tool}:${x.status}${x.reason ? `:${x.reason}` : ''}`);

test('both updated: every tool reports `updated`, nothing left for the user', async () => {
  const s = await runIt(machine());
  assert.equal(s.state, 'done', JSON.stringify(s));
  assert.deepEqual(brief(s), ['claude:updated', 'codex:updated']);
  assert.deepEqual(s.manual, []);
});

test('Codex installed but its CLI cannot be found: not skipped silently, a manual entry with the exact command', async () => {
  const s = await runIt(machine({ codex: false }));
  assert.equal(s.state, 'done');
  assert.deepEqual(brief(s), ['claude:updated', 'codex:manual:cliNotFound']);
  assert.deepEqual(s.manual, [{ tool: 'codex', reason: 'cliNotFound', commands: ['codex plugin marketplace upgrade crewgate'] }]);
});

test('Claude installed but its CLI cannot be found: manual entry too (here only Codex can run)', async () => {
  const s = await runIt(machine({ claude: false }));
  assert.equal(s.state, 'done');
  assert.deepEqual(brief(s), ['claude:manual:cliNotFound', 'codex:updated']);
  assert.deepEqual(s.manual.map((g) => [g.tool, g.reason, g.commands.length]), [['claude', 'cliNotFound', 2]]);
});

test('not installed is `skipped`, a failing command is `failed`', async () => {
  const s = await runIt(machine({ codex: false, codexConfigured: false }));
  assert.deepEqual(brief(s), ['claude:updated', 'codex:skipped:notInstalled']);
  assert.deepEqual(s.manual, []);
  const f = await runIt(machine({ claudeCfg: { fail: true } }));
  assert.equal(f.state, 'failed');
  assert.deepEqual(brief(f), ['claude:failed', 'codex:failed:notReached']);
});

test('a development checkout reports manual with the reason devCheckout', async () => {
  const m = machine();
  const dev = path.join(m.root, 'checkout', 'plugins', 'crewgate');
  fs.mkdirSync(dev, { recursive: true });
  const runner = ua.createRunner({ pluginRoot: dev, env: m.env });
  await runner.start().done;
  const s = runner.status();
  assert.equal(s.state, 'manual');
  assert.deepEqual(brief(s), ['claude:manual:devCheckout', 'codex:manual:devCheckout']);
});

test('plan: Windows Store Codex found through PowerShell becomes a step (Claude CLI missing -> manual)', async () => {
  const m = machine({ claude: false, codex: false });
  const a = appx();
  const ps = fakePowerShell({ out: a.loc });
  const env = { ...m.env, CREWGATE_POWERSHELL: ps.file };
  const p = await ua.plan({ pluginRoot: m.pluginRoot, env, platform: 'win32' });
  assert.deepEqual(p.steps.map((x) => [x.tool, x.file, x.cmd]), [['codex', a.exe, 'codex plugin marketplace upgrade crewgate']]);
  assert.deepEqual(p.tools.map((x) => `${x.tool}:${x.status}`), ['claude:manual', 'codex:run']);
});

test('plan: neither executable found anywhere -> manual entries for both with the reason', async () => {
  const m = machine({ claude: false, codex: false });
  const p = await ua.plan({ pluginRoot: m.pluginRoot, env: m.env, platform: 'win32' });
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.manual.map((g) => `${g.tool}:${g.reason}`), ['claude:cliNotFound', 'codex:cliNotFound']);
  assert.deepEqual(p.manual[1].commands, ['codex plugin marketplace upgrade crewgate']);
});

test('the board banner shows manual entries with a Copy button and the reason', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'board', 'public', 'app.js'), 'utf8');
  assert.match(app, /function manualBlocks/);
  assert.match(app, /Remove old versions|update\.removeOld/);
  assert.match(app, /'\/api\/update\/cleanup'/);
  for (const dir of ['en', 'zh-TW']) {
    const tbl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'board', 'public', 'i18n', `${dir}.json`), 'utf8'));
    for (const code of ['cliNotFound', 'notInstalled', 'devCheckout', 'notReached']) assert.ok(tbl[`update.reason.${code}`], `${dir} reason ${code}`);
    for (const st of ['updated', 'skipped', 'manual', 'failed']) assert.ok(tbl[`update.result.${st}`], `${dir} result ${st}`);
    for (const k of ['update.oldVersions', 'update.removeOld', 'update.removing', 'update.removedOld', 'update.keptOld', 'update.restartLine']) assert.ok(tbl[k], `${dir} ${k}`);
  }
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'board', 'public', 'i18n', 'en.json'), 'utf8'));
  assert.equal(en['update.reason.cliNotFound'], '{tool} CLI not found on PATH');
});
