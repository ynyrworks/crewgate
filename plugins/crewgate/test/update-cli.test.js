'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const u = require('./update-helpers');

const HOME = u.setupHome();
const V = u.versions();
const empty = u.tmpDir('crew-cwd-');

test('crew update check: reports a newer release, honours --json, caches, and doctor shows it', async () => {
  u.writeGlobalConfig({});
  const gh = await u.fakeGithub(u.release(`v${V.minor}`));
  try {
    const env = { CREWGATE_HOME: HOME, CREWGATE_UPDATE_URL: gh.url };
    const r = await u.crewAsync(['update', 'check'], empty, env);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`${V.minor} is available (new features)`), r.out);
    assert.ok(r.out.includes(`releases/tag/v${V.minor}`), r.out);
    const j = JSON.parse((await u.crewAsync(['--json', 'update', 'check'], empty, env)).out);
    assert.equal(j.kind, 'minor');
    assert.equal(gh.hits(), 1, 'second call used the cache');
    const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], empty, env)).out);
    const row = d.checks.find((c) => c.name === 'update');
    assert.equal(row.status, 'warn');
    assert.ok(row.detail.includes(`${V.minor} is available`), row.detail);
    assert.equal(gh.hits(), 1, 'doctor never calls out');
  } finally { await gh.close(); }
});

// A cached answer from before the newest release, still inside its 24-hour window.
function writeOutdatedCache() {
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(`${HOME}/update-check.json`, JSON.stringify({ latest: V.current, rehook: false, checked_at: hourAgo, attempted_at: hourAgo, failures: 0, next_check_ms: Date.now() + 23 * 3600 * 1000 }));
}

test('crew update check without --force sees a release newer than the cached answer', async () => {
  u.writeGlobalConfig({});
  writeOutdatedCache();
  const gh = await u.fakeGithub(u.release(`v${V.minor}`));
  try {
    const r = await u.crewAsync(['update', 'check'], empty, { CREWGATE_HOME: HOME, CREWGATE_UPDATE_URL: gh.url });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`${V.minor} is available`), r.out);
    assert.equal(gh.hits(), 1);
  } finally { await gh.close(); fs.rmSync(`${HOME}/update-check.json`, { force: true }); }
});

test('crew update check does not call a cached version the latest when the check failed', async () => {
  u.writeGlobalConfig({});
  writeOutdatedCache();
  const gh = await u.fakeGithub((req, res) => { res.writeHead(500); res.end(); });
  try {
    const env = { CREWGATE_HOME: HOME, CREWGATE_UPDATE_URL: gh.url };
    const r = await u.crewAsync(['update', 'check'], empty, env);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes('is the latest release'), r.out);
    assert.match(r.out, /last check failed \(HTTP 500\)/);
    const j = JSON.parse((await u.crewAsync(['--json', 'update', 'check'], empty, env)).out);
    assert.equal(j.check_error, 'HTTP 500');
    assert.equal(gh.hits(), 1, 'the second call is inside the one-minute limit');
  } finally { await gh.close(); fs.rmSync(`${HOME}/update-check.json`, { force: true }); }
});

test('crew doctor says when the cached answer is from, instead of calling it the latest', async () => {
  u.writeGlobalConfig({});
  writeOutdatedCache();
  try {
    const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], empty, { CREWGATE_HOME: HOME })).out);
    const row = d.checks.find((c) => c.name === 'update');
    assert.equal(row.status, 'ok');
    assert.match(row.detail, /when last checked \(\d{4}-\d{2}-\d{2}\)/);
  } finally { fs.rmSync(`${HOME}/update-check.json`, { force: true }); }
});

test('crew update check with updates.check = false says so and makes no request', async () => {
  u.writeGlobalConfig({ updates: { check: false } });
  fs.rmSync(`${HOME}/update-check.json`, { force: true });
  const gh = await u.fakeGithub(u.release(`v${V.minor}`));
  try {
    const r = await u.crewAsync(['update', 'check'], empty, { CREWGATE_HOME: HOME, CREWGATE_UPDATE_URL: gh.url });
    assert.equal(r.code, 0);
    assert.match(r.out, /off/i);
    assert.equal(gh.hits(), 0);
  } finally { await gh.close(); u.writeGlobalConfig({}); }
});

test('crew update apply from a development checkout prints the commands and runs nothing', async () => {
  const r = await u.crewAsync(['update', 'apply'], empty, { CREWGATE_HOME: HOME });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claude plugin marketplace update crewgate/);
  assert.match(r.out, /claude plugin update crewgate@crewgate/);
  assert.match(r.out, /codex plugin marketplace upgrade crewgate/);
});

test('an unknown crew update action is a usage error', () => {
  assert.equal(u.crew(['update', 'bogus'], empty).code, 2);
});
