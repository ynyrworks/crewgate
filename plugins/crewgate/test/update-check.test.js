'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const u = require('./update-helpers');

u.setupHome();
const uc = require('../lib/core/update-check');

const CURRENT = '0.10.1';
const DAY = 24 * 3600 * 1000;
let t0 = Date.parse('2026-11-01T00:00:00Z');
const opts = (gh, extra = {}) => ({ current: CURRENT, apiUrl: gh.url, now: t0, timeoutMs: 400, ...extra });
const reset = () => { try { fs.unlinkSync(uc.cacheFile()); } catch { /* none */ } u.writeGlobalConfig({}); };

test('version helpers: parse, compare and kind', () => {
  assert.deepEqual(uc.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(uc.parseVersion('1.2'), null);
  assert.equal(uc.parseVersion('1.2.3-rc1'), null);
  assert.equal(uc.compareVersions('0.10.2', '0.9.9'), 1);
  assert.equal(uc.kindOf('0.10.1', '0.10.2'), 'patch');
  assert.equal(uc.kindOf('0.10.1', '0.11.0'), 'minor');
  assert.equal(uc.kindOf('0.10.1', '1.0.0'), 'major');
  assert.equal(uc.kindOf('0.10.1', '0.10.1'), null);
  assert.equal(uc.kindOf('0.10.1', '0.9.0'), null);
});

test('the URL override only accepts the real API host or loopback', () => {
  assert.equal(uc.apiUrl('http://example.com/x'), uc.DEFAULT_API);
  assert.equal(uc.apiUrl('https://evil.example/repos'), uc.DEFAULT_API);
  assert.equal(uc.apiUrl('http://127.0.0.1:9/x'), 'http://127.0.0.1:9/x');
});

for (const [tag, kind] of [['v0.10.2', 'patch'], ['v0.11.0', 'minor'], ['v1.0.0', 'major'], ['v0.10.1', null], ['v0.9.0', null]]) {
  test(`release ${tag} -> kind ${kind}`, async () => {
    reset();
    const gh = await u.fakeGithub(u.release(tag));
    try {
      const s = await uc.check(opts(gh));
      assert.equal(s.enabled, true);
      assert.equal(s.current, CURRENT);
      assert.equal(s.latest, tag.slice(1));
      assert.equal(s.kind, kind);
      assert.equal(s.rehook, false);
      assert.equal(s.notes_url, `https://github.com/ynyrworks/crewgate/releases/tag/${tag}`);
      assert.equal(s.checked_at, new Date(t0).toISOString());
    } finally { await gh.close(); }
  });
}

test('the request is a plain GET: crewgate user agent, JSON accept, no cookie, no auth, nothing else', async () => {
  reset();
  const gh = await u.fakeGithub(u.release('v0.10.2'));
  try {
    await uc.check(opts(gh));
    assert.equal(gh.hits(), 1);
    const r = gh.seen[0];
    assert.equal(r.method, 'GET');
    assert.equal(r.headers['user-agent'], `crewgate/${CURRENT}`);
    assert.equal(r.headers.accept, 'application/vnd.github+json');
    for (const k of ['cookie', 'authorization', 'x-crew-token', 'referer', 'origin']) assert.equal(r.headers[k], undefined, k);
  } finally { await gh.close(); }
});

test('the rehook marker line in the release body sets rehook, only for a newer version', async () => {
  reset();
  const gh = await u.fakeGithub(u.release('v0.10.2', { body: `Fixes.\n${uc.REHOOK_MARKER}\n` }));
  try {
    assert.equal((await uc.check(opts(gh))).rehook, true);
  } finally { await gh.close(); }
  reset();
  const same = await u.fakeGithub(u.release('v0.10.1', { body: uc.REHOOK_MARKER }));
  try {
    assert.equal((await uc.check(opts(same))).rehook, false);
  } finally { await same.close(); }
});

test('drafts, pre-releases, malformed JSON, wrong shapes, HTTP 500 and a hung server all give "no answer"', async () => {
  const cases = {
    draft: u.release('v9.0.0', { draft: true }),
    prerelease: u.release('v9.0.0', { prerelease: true }),
    rc: u.release('v9.0.0-rc1'),
    notJson: (req, res) => { res.writeHead(200); res.end('{nope'); },
    wrongShape: (req, res) => { res.writeHead(200); res.end(JSON.stringify({ tag: 1 })); },
    http500: (req, res) => { res.writeHead(500); res.end('boom'); },
    hung: () => { /* never answers */ },
  };
  for (const [name, handler] of Object.entries(cases)) {
    reset();
    const gh = await u.fakeGithub(handler);
    try {
      const s = await uc.check(opts(gh));
      assert.equal(s.latest, null, name);
      assert.equal(s.kind, null, name);
      assert.equal(gh.hits(), 1, name);
    } finally { await gh.close(); }
  }
});

test('a good answer is cached for 24 hours: no second request', async () => {
  reset();
  const gh = await u.fakeGithub(u.release('v0.10.2'));
  try {
    await uc.check(opts(gh));
    const again = await uc.check(opts(gh, { now: t0 + DAY - 1000 }));
    assert.equal(gh.hits(), 1);
    assert.equal(again.latest, '0.10.2');
    assert.equal(uc.checkState({ current: CURRENT }).latest, '0.10.2', 'checkState reads the cache without a request');
    await uc.check(opts(gh, { now: t0 + DAY + 1000 }));
    assert.equal(gh.hits(), 2);
  } finally { await gh.close(); }
});

test('failures are cached and back off (1 h, then 2 h); the last good answer survives', async () => {
  reset();
  let fail = false;
  const gh = await u.fakeGithub((req, res) => (fail ? (res.writeHead(500), res.end()) : u.release('v0.10.2')(req, res)));
  try {
    await uc.check(opts(gh));
    fail = true;
    await uc.check(opts(gh, { now: t0 + DAY + 1000 }));            // fails, retried in 1 h
    assert.equal(gh.hits(), 2);
    const kept = await uc.check(opts(gh, { now: t0 + DAY + 30 * 60 * 1000 }));
    assert.equal(gh.hits(), 2, 'inside the back-off window');
    assert.equal(kept.latest, '0.10.2');
    await uc.check(opts(gh, { now: t0 + DAY + 61 * 60 * 1000 }));   // fails again, retried in 2 h
    assert.equal(gh.hits(), 3);
    await uc.check(opts(gh, { now: t0 + DAY + 61 * 60 * 1000 + 90 * 60 * 1000 }));
    assert.equal(gh.hits(), 3, 'second back-off is longer');
    await uc.check(opts(gh, { now: t0 + DAY + 61 * 60 * 1000 + 121 * 60 * 1000 }));
    assert.equal(gh.hits(), 4);
  } finally { await gh.close(); }
});

test('force re-checks, but not more than once a minute', async () => {
  reset();
  const gh = await u.fakeGithub(u.release('v0.10.2'));
  try {
    await uc.check(opts(gh));
    await uc.check(opts(gh, { force: true, now: t0 + 10 * 1000 }));
    assert.equal(gh.hits(), 1, 'too soon');
    await uc.check(opts(gh, { force: true, now: t0 + 61 * 1000 }));
    assert.equal(gh.hits(), 2);
  } finally { await gh.close(); }
});

test('updates.check = false: no request at all, even when forced; the answer says disabled', async () => {
  reset();
  u.writeGlobalConfig({ updates: { check: false } });
  const gh = await u.fakeGithub(u.release('v0.10.2'));
  try {
    const a = await uc.check(opts(gh));
    const b = await uc.check(opts(gh, { force: true, now: t0 + DAY * 3 }));
    for (const s of [a, b, uc.checkState({ current: CURRENT })]) {
      assert.deepEqual(s, { enabled: false, current: CURRENT, latest: null, kind: null, notes_url: null, rehook: false, checked_at: null });
    }
    assert.equal(gh.hits(), 0);
    assert.equal(fs.existsSync(uc.cacheFile()), false, 'nothing cached either');
  } finally { await gh.close(); }
});

test('the default is on, and the schema documents the key in both languages', () => {
  const config = require('../lib/core/config');
  const e = config.GLOBAL_SCHEMA.find((x) => x.path === 'updates.check');
  assert.equal(e.type, 'boolean');
  assert.equal(e.default, true);
  assert.ok(e.description.en && e.description['zh-TW']);
});
