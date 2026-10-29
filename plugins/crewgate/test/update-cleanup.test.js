'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const u = require('./update-helpers');

u.setupHome();
const cleanup = require('../lib/core/update-cleanup');
const { createBoard } = require('../board/server');

// A fake machine with Claude and Codex plugin caches holding the given version folders.
function caches(claudeVersions, codexVersions = []) {
  const root = u.tmpDir('crew-clean-');
  const dirs = { claude: path.join(root, '.claude'), codex: path.join(root, '.codex') };
  const make = (tool, names) => {
    const base = cleanup.cacheDir(dirs, tool);
    fs.mkdirSync(base, { recursive: true });
    for (const n of names) {
      fs.mkdirSync(path.join(base, n, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(base, n, 'hooks', 'x.txt'), 'x'.repeat(1000));
    }
    return base;
  };
  const cb = make('claude', claudeVersions);
  const xb = make('codex', codexVersions);
  const left = (base) => fs.readdirSync(base).sort();
  return { root, dirs, cb, xb, left };
}

test('scan and cleanup remove only folders strictly older than the newest, never the current one', () => {
  const m = caches(['0.10.0', '0.11.0', '0.12.1'], ['0.12.0', '0.12.1']);
  const s = cleanup.scan({ dirs: m.dirs });
  assert.equal(s.count, 3);
  assert.deepEqual(s.items.map((i) => `${i.tool} ${i.version}`).sort(), ['claude 0.10.0', 'claude 0.11.0', 'codex 0.12.0']);
  assert.ok(s.bytes >= 3000);
  const r = cleanup.cleanup({ dirs: m.dirs });
  assert.equal(r.removed.length, 3);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(m.left(m.cb), ['0.12.1']);
  assert.deepEqual(m.left(m.xb), ['0.12.1']);
  assert.equal(cleanup.cleanup({ dirs: m.dirs }).removed.length, 0, 'nothing left to do');
});

test('the folder the running code lives in is kept, even when an older one', () => {
  const m = caches(['0.11.0', '0.12.1']);
  const running = path.join(m.cb, '0.11.0', 'hooks');
  const r = cleanup.cleanup({ dirs: m.dirs, pluginRoot: running });
  assert.equal(r.removed.length, 0);
  assert.deepEqual(m.left(m.cb), ['0.11.0', '0.12.1']);
});

test('names that are not plain versions and plain files are ignored', () => {
  const m = caches(['0.1.0', 'junk', '1.2', 'v0.2.0', '0.3.0-beta', '9.9.9']);
  fs.writeFileSync(path.join(m.cb, '0.0.5'), 'a file');
  const r = cleanup.cleanup({ dirs: m.dirs });
  assert.deepEqual(r.removed.map((i) => i.version), ['0.1.0']);
  assert.deepEqual(m.left(m.cb), ['0.0.5', '0.3.0-beta', '1.2', '9.9.9', 'junk', 'v0.2.0']);
});

test('a link inside the cache is never followed and a linked cache folder is left alone', () => {
  const m = caches(['0.1.0', '9.9.9']);
  const outside = u.tmpDir('crew-outside-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  try { fs.symlinkSync(outside, path.join(m.cb, '0.2.0'), 'junction'); } catch { return; }   // no link rights: nothing to prove
  const r = cleanup.cleanup({ dirs: m.dirs });
  assert.deepEqual(r.removed.map((i) => i.version), ['0.1.0']);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));

  const m2 = caches([], []);
  const real = u.tmpDir('crew-realcache-');
  for (const v of ['0.1.0', '9.9.9']) fs.mkdirSync(path.join(real, v), { recursive: true });
  fs.rmSync(m2.cb, { recursive: true });
  fs.symlinkSync(real, m2.cb, 'junction');
  assert.equal(cleanup.scan({ dirs: m2.dirs }).count, 0, 'cache folder pointing elsewhere');
  assert.equal(cleanup.cleanup({ dirs: m2.dirs }).removed.length, 0);
  assert.deepEqual(fs.readdirSync(real).sort(), ['0.1.0', '9.9.9']);
});

test('a folder that is in use (EBUSY / EPERM) is reported and kept', () => {
  const m = caches(['0.1.0', '0.2.0', '9.9.9']);
  const real = fs.rmSync;
  fs.rmSync = (p, o) => {
    if (String(p).endsWith(`${path.sep}0.1.0`)) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return real(p, o);
  };
  let r;
  try { r = cleanup.cleanup({ dirs: m.dirs }); } finally { fs.rmSync = real; }
  assert.deepEqual(r.removed.map((i) => i.version), ['0.2.0']);
  assert.deepEqual(r.kept, [{ tool: 'claude', version: '0.1.0', reason: 'inUse' }]);
  assert.deepEqual(m.left(m.cb), ['0.1.0', '9.9.9']);
});

test('missing cache folders are fine', () => {
  const root = u.tmpDir('crew-nocache-');
  const s = cleanup.scan({ dirs: { claude: path.join(root, 'a'), codex: path.join(root, 'b') } });
  assert.deepEqual(s, { count: 0, bytes: 0, items: [] });
});

// ---------------------------------------------------------------- the board route
test('GET/POST /api/update/cleanup: token, origin, content type, no parameters; removes only older versions', async () => {
  const m = caches(['0.10.0', '0.12.1'], ['0.11.0', '0.12.1']);
  const running = path.join(m.cb, '0.12.1');
  const empty = u.tmpDir('crew-empty-');
  const board = createBoard({
    version: '0.12.1', claudeRoot: empty, codexRoot: empty,
    updates: { pluginRoot: running, env: { CLAUDE_CONFIG_DIR: m.dirs.claude, CODEX_HOME: m.dirs.codex } },
  });
  const port = await board.listen(0);
  try {
    const token = await u.tokenOf(port);
    const p = '/api/update/cleanup';
    const g = await u.request(port, { path: p });
    assert.equal(g.status, 200);
    assert.equal(g.json.count, 2);
    assert.equal((await u.request(port, { method: 'POST', path: p, body: {}, headers: { 'Content-Type': 'application/json' } })).status, 403, 'no token');
    assert.equal((await u.post(port, 'f'.repeat(48), p, {})).status, 403, 'wrong token');
    assert.equal((await u.post(port, token, p, {}, { Origin: 'http://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await u.request(port, { method: 'POST', path: p, body: '{}', headers: { 'Content-Type': 'text/plain', 'X-Crew-Token': token } })).status, 415);
    assert.equal((await u.post(port, token, p, { dir: 'C:\\' })).status, 400, 'no parameters');
    assert.equal(m.left(m.cb).length, 2, 'refused requests removed nothing');
    const r = await u.post(port, token, p, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.removed.map((i) => `${i.tool} ${i.version}`).sort(), ['claude 0.10.0', 'codex 0.11.0']);
    assert.deepEqual(m.left(m.cb), ['0.12.1']);
    assert.deepEqual(m.left(m.xb), ['0.12.1']);
  } finally { await board.close(); }
});

test('crew update cleanup --dry-run lists, cleanup removes (CLI)', async () => {
  const m = caches(['0.0.1', '99.0.0']);
  const env = { CLAUDE_CONFIG_DIR: m.dirs.claude, CODEX_HOME: m.dirs.codex };
  const cwd = u.tmpDir('crew-cwd-');
  const dry = await u.crewAsync(['update', 'cleanup', '--dry-run', '--json'], cwd, env);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(JSON.parse(dry.out).count, 1);
  assert.deepEqual(m.left(m.cb), ['0.0.1', '99.0.0']);
  const real = await u.crewAsync(['update', 'cleanup', '--json'], cwd, env);
  assert.equal(real.code, 0, real.err);
  assert.deepEqual(m.left(m.cb), ['99.0.0']);
});
