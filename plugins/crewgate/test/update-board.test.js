'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const u = require('./update-helpers');

u.setupHome();
const { createBoard } = require('../board/server');

const PLUGIN = path.join(__dirname, '..');
const empty = u.tmpDir('crew-empty-');

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await u.sleep(150);
  }
}

// ---------------------------------------------------------------- routes (in process, fake GitHub)
let gh;
let board;
let port;
let token;
test.before(async () => {
  u.writeGlobalConfig({});
  gh = await u.fakeGithub(u.release('v99.0.0', { body: `<!-- crewgate:rehook -->` }));
  board = createBoard({ version: '0.10.1', claudeRoot: empty, codexRoot: empty, updates: { apiUrl: gh.url, timeoutMs: 400 } });
  port = await board.listen(0);
  token = await u.tokenOf(port);
});
test.after(async () => { await board.close(); await gh.close(); });

test('GET /api/update before any check: enabled, nothing known, no request made', async () => {
  const r = await u.request(port, { path: '/api/update' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { enabled: true, current: '0.10.1', latest: null, kind: null, notes_url: null, rehook: false, checked_at: null });
  assert.equal(gh.hits(), 0, 'a board created without updates.auto never calls out by itself');
});

test('POST /api/update/check asks GitHub and GET /api/update then serves the cached answer', async () => {
  const r = await u.post(port, token, '/api/update/check', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.latest, '99.0.0');
  assert.equal(r.json.kind, 'major');
  assert.equal(r.json.rehook, true);
  assert.equal(r.json.notes_url, 'https://github.com/ynyrworks/crewgate/releases/tag/v99.0.0');
  assert.equal(gh.hits(), 1);
  const g = await u.request(port, { path: '/api/update' });
  assert.deepEqual(Object.keys(g.json).sort(), ['checked_at', 'current', 'enabled', 'kind', 'latest', 'notes_url', 'rehook']);
  assert.equal(g.json.latest, '99.0.0');
  assert.equal(gh.hits(), 1);
});

test('writes under /api/update need the token, JSON, and no foreign origin; wrong methods are refused', async () => {
  for (const p of ['/api/update/check', '/api/update/apply']) {
    assert.equal((await u.request(port, { method: 'POST', path: p, body: {}, headers: { 'Content-Type': 'application/json' } })).status, 403, `${p} without token`);
    assert.equal((await u.post(port, 'f'.repeat(48), p, {})).status, 403, `${p} wrong token`);
    assert.equal((await u.post(port, token, p, {}, { Origin: 'http://evil.example' })).status, 403, `${p} foreign origin`);
    assert.equal((await u.request(port, { method: 'POST', path: p, body: '{}', headers: { 'Content-Type': 'text/plain', 'X-Crew-Token': token } })).status, 415, `${p} content type`);
    assert.equal((await u.request(port, { path: p })).status, 405, `${p} GET`);
  }
  assert.equal((await u.post(port, token, '/api/update', {})).status, 405);
  assert.equal((await u.request(port, { method: 'POST', path: '/api/update/status', body: {}, headers: { 'Content-Type': 'application/json', 'X-Crew-Token': token } })).status, 405);
  assert.equal(gh.hits(), 1, 'refused requests started nothing');
});

test('apply takes no parameters from the client', async () => {
  const r = await u.post(port, token, '/api/update/apply', { command: 'calc.exe', args: ['x'] });
  assert.equal(r.status, 400);
  const st = await u.request(port, { path: '/api/update/status' });
  assert.equal(st.json.state, 'idle');
});

test('apply from a development checkout runs nothing and returns the commands to copy', async () => {
  // this test file lives in the repository checkout, which is not under ~/.claude/plugins or ~/.codex/plugins
  const r = await u.post(port, token, '/api/update/apply', {});
  assert.equal(r.status, 200);
  const st = await until(async () => { const s = (await u.request(port, { path: '/api/update/status' })).json; return s.state === 'running' ? null : s; });
  assert.equal(st.state, 'manual');
  assert.deepEqual(st.steps, []);
  assert.deepEqual(st.manual.map((g) => g.tool), ['claude', 'codex']);
  assert.equal(st.restart_command, 'crew board start');
});

test('updates.check = false: the board makes no request, even when asked to check', async () => {
  u.writeGlobalConfig({ updates: { check: false } });
  const gh2 = await u.fakeGithub(u.release('v99.0.0'));
  const b = createBoard({ version: '0.10.1', claudeRoot: empty, codexRoot: empty, updates: { apiUrl: gh2.url, auto: true } });
  try {
    const p = await b.listen(0);
    const tk = await u.tokenOf(p);
    const r = await u.post(p, tk, '/api/update/check', {});
    assert.equal(r.json.enabled, false);
    assert.equal((await u.request(p, { path: '/api/update' })).json.enabled, false);
    await u.sleep(300);
    assert.equal(gh2.hits(), 0);
  } finally { await b.close(); await gh2.close(); u.writeGlobalConfig({}); }
});

test('with updates.auto the board checks in the background when the page asks', async () => {
  fs.rmSync(require('../lib/core/update-check').cacheFile(), { force: true });
  const gh2 = await u.fakeGithub(u.release('v0.10.2'));
  const b = createBoard({ version: '0.10.1', claudeRoot: empty, codexRoot: empty, updates: { apiUrl: gh2.url, auto: true, timeoutMs: 400 } });
  try {
    const p = await b.listen(0);
    const first = (await u.request(p, { path: '/api/update' })).json;
    assert.equal(first.latest, null, 'does not wait for the network');
    await until(() => gh2.hits() === 1);
    const later = await until(async () => { const j = (await u.request(p, { path: '/api/update' })).json; return j.latest ? j : null; });
    assert.equal(later.kind, 'patch');
    assert.equal(gh2.hits(), 1, 'one request, not one per page load');
  } finally { await b.close(); await gh2.close(); }
});

// ---------------------------------------------------------------- restart flow (a real board process)
function copyPlugin(dest, version) {
  fs.cpSync(PLUGIN, dest, { recursive: true, filter: (src) => !/[\\/]test([\\/]|$)/.test(path.relative(PLUGIN, src)) });
  const f = path.join(dest, '.claude-plugin', 'plugin.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), version }));
  return f;
}

async function realBoard(onUpdate) {
  const root = u.tmpDir('crew-real-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, updates: { check: false } }));
  const claudeDir = path.join(root, '.claude');
  const dest = path.join(claudeDir, 'plugins', 'marketplaces', 'crewgate', 'plugins', 'crewgate');
  const pluginJson = copyPlugin(dest, '1.0.0');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  u.fakeCli(bin, 'claude', { log, list: '[{"id":"crewgate@crewgate"}]', pluginJson, crewJs: path.join(dest, 'bin', 'crew.js'), onUpdate }, u.CLAUDE_BODY);
  const env = u.fakeEnv({ bin, claudeDir, codexDir: path.join(root, '.codex'), extra: { CREWGATE_HOME: home, CREWGATE_CLAUDE_ROOT: empty, CREWGATE_CODEX_ROOT: empty } });
  const p = await u.freePort();
  const child = spawn(process.execPath, [path.join(dest, 'bin', 'crew.js'), 'board', 'serve', '--port', String(p)], { env, stdio: 'ignore', windowsHide: true });
  const stateFile = path.join(home, 'board.json');
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
  await until(async () => { const s = state(); return s && s.pid === child.pid && (await u.request(p, { path: '/api/health' }).catch(() => null)); });
  const stop = () => { for (const pid of new Set([child.pid, (state() || {}).pid])) { try { process.kill(pid); } catch { /* gone */ } } };
  return { port: p, child, state, stop, log };
}

const health = (p) => u.request(p, { path: '/api/health' }).then((r) => r.json, () => null);

test('one-click update restarts the board from the updated code on the same port', async () => {
  const bump = "fs.writeFileSync(cfg.pluginJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg.pluginJson, 'utf8')), version: '1.0.1' }));";
  const b = await realBoard(bump);
  try {
    assert.equal((await health(b.port)).version, '1.0.0');
    const before = b.state().pid;
    const tk = await u.tokenOf(b.port);
    const r = await u.post(b.port, tk, '/api/update/apply', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'running');
    await until(async () => { const h = await health(b.port); return h && h.version === '1.0.1'; }, 40000);
    const after = b.state();
    assert.notEqual(after.pid, before, 'a new process');
    assert.equal(after.port, b.port, 'same port');
    const st = (await u.request(b.port, { path: '/api/update/status' })).json;
    assert.equal(st.state, 'idle', 'the new board starts clean');
    await until(() => { try { process.kill(before, 0); return false; } catch { return true; } }, 10000);
    assert.equal(fs.readFileSync(b.log, 'utf8').includes('claude plugin update crewgate@crewgate'), true);
  } finally { b.stop(); }
});

test('if the updated board does not come up, the old board takes its port back and reports it', async () => {
  const breakIt = "fs.writeFileSync(cfg.crewJs, 'process.exit(1);');";
  const b = await realBoard(breakIt);
  try {
    const before = b.state().pid;
    const tk = await u.tokenOf(b.port);
    assert.equal((await u.post(b.port, tk, '/api/update/apply', {})).status, 200);
    const st = await until(async () => {
      const r = await u.request(b.port, { path: '/api/update/status' }).catch(() => null);
      return r && r.json && r.json.state === 'failed' ? r.json : null;
    }, 40000);
    assert.equal(st.error, 'update.restartFailed');
    assert.equal(st.restart_command, 'crew board start');
    assert.equal((await health(b.port)).version, '1.0.0', 'the old board answers again');
    const s = b.state();
    assert.equal(s.pid, before);
    assert.equal(s.port, b.port);
    process.kill(before, 0);   // still alive
  } finally { b.stop(); }
});
