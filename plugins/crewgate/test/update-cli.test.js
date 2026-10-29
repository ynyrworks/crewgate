'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const u = require('./update-helpers');

const HOME = u.setupHome();
const empty = u.tmpDir('crew-cwd-');

test('crew update check: reports a newer release, honours --json, caches, and doctor shows it', async () => {
  u.writeGlobalConfig({});
  const gh = await u.fakeGithub(u.release('v0.11.0'));
  try {
    const env = { CREWGATE_HOME: HOME, CREWGATE_UPDATE_URL: gh.url };
    const r = await u.crewAsync(['update', 'check'], empty, env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /0.11.0 is available \(new features\)/);
    assert.match(r.out, /releases\/tag\/v0.11.0/);
    const j = JSON.parse((await u.crewAsync(['--json', 'update', 'check'], empty, env)).out);
    assert.equal(j.kind, 'minor');
    assert.equal(gh.hits(), 1, 'second call used the cache');
    const d = JSON.parse((await u.crewAsync(['--json', 'doctor'], empty, env)).out);
    const row = d.checks.find((c) => c.name === 'update');
    assert.equal(row.status, 'warn');
    assert.match(row.detail, /0.11.0 is available/);
    assert.equal(gh.hits(), 1, 'doctor never calls out');
  } finally { await gh.close(); }
});

test('crew update check with updates.check = false says so and makes no request', async () => {
  u.writeGlobalConfig({ updates: { check: false } });
  fs.rmSync(`${HOME}/update-check.json`, { force: true });
  const gh = await u.fakeGithub(u.release('v0.11.0'));
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
