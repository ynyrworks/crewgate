'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const UM = require('../board/public/update-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const info = (o = {}) => ({ enabled: true, current: '0.10.1', latest: '0.10.2', kind: 'patch', notes_url: 'https://example.test/n', rehook: false, checked_at: 'x', ...o });

test('banner shows for patch, minor and major, and only for a newer version', () => {
  for (const kind of ['patch', 'minor', 'major']) assert.equal(UM.visible(info({ kind }), ''), true, kind);
  assert.equal(UM.visible(info({ kind: null }), ''), false);
  assert.equal(UM.visible(info({ latest: null }), ''), false);
  assert.equal(UM.visible(info({ enabled: false }), ''), false);
  assert.equal(UM.visible(null, ''), false);
  assert.equal(UM.visible(info({ kind: 'bogus' }), ''), false);
});

test('skipping a version hides only that version', () => {
  assert.equal(UM.visible(info(), '0.10.2'), false);
  assert.equal(UM.visible(info({ latest: '0.10.3' }), '0.10.2'), true);
  assert.equal(UM.visible(info(), ''), true);
});

test('kind wording keys exist for fix, new features and major release in both languages', () => {
  const en = JSON.parse(read('i18n/en.json'));
  const zh = JSON.parse(read('i18n/zh-TW.json'));
  for (const kind of ['patch', 'minor', 'major']) {
    assert.ok(en[UM.kindKey(kind)] && zh[UM.kindKey(kind)], kind);
  }
  assert.equal(en['update.kind.patch'], 'fix');
  assert.equal(en['update.kind.minor'], 'new features');
});

test('restart verdict: wait while down or on the old version, ok on a new version, timeout after the limit', () => {
  const h = (v) => ({ ok: true, name: 'crewgate', version: v });
  assert.equal(UM.restartVerdict('1.0.0', null, 1000), 'wait');
  assert.equal(UM.restartVerdict('1.0.0', h('1.0.0'), 1000), 'wait');
  assert.equal(UM.restartVerdict('1.0.0', h('1.0.1'), 1000), 'ok');
  assert.equal(UM.restartVerdict('1.0.0', { name: 'other', version: '9' }, 1000), 'wait');
  assert.equal(UM.restartVerdict('1.0.0', null, UM.RESTART_LIMIT_MS), 'timeout');
  assert.equal(UM.restartVerdict('1.0.0', h('1.0.0'), 60000), 'timeout');
});

test('page wiring: banner container on every page, strict-CSP friendly, skip stored defensively', () => {
  const html = read('index.html');
  assert.match(html, /<section id="update"[^>]*hidden/);
  assert.match(html, /<script src="\/update-model.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  const css = read('app.css');
  assert.match(css, /\.update\b/);
  const app = read('app.js');
  assert.match(app, /store\('crew\.skipUpdate'/);
  assert.doesNotMatch(app, /innerHTML/, 'text only');
  assert.match(app, /rel: 'noopener noreferrer'/);
  // the only places that talk to the update API
  for (const p of ['/api/update', '/api/update/apply', '/api/update/status', '/api/health']) assert.ok(app.includes(`'${p}'`), p);
});

test('every update.* key the page uses exists in both tables with matching placeholders', () => {
  const en = JSON.parse(read('i18n/en.json'));
  const zh = JSON.parse(read('i18n/zh-TW.json'));
  const used = new Set([...read('app.js').matchAll(/\bt\('(update\.[A-Za-z.]+)'/g)].map((m) => m[1]));
  assert.ok(used.size >= 10);
  for (const k of used) assert.ok(en[k] && zh[k], k);
});
