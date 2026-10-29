'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers');

h.setupHome();
const json = require('../lib/core/json');
const dir = h.tmpDir('crew-json-');

test('save writes pretty JSON atomically and leaves no temp files', () => {
  const f = path.join(dir, 'a', 'x.json');
  json.save(f, { a: 1, b: [1, 2] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1, b: [1, 2] });
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')), []);
  json.save(f, { a: 2 });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 2);
});

test('readJson: missing, ok, wrong top-level type, corrupt; never touches the file', () => {
  const f = path.join(dir, 'r.json');
  assert.deepEqual(json.readJson(f, { d: 1 }), { status: 'missing', data: { d: 1 } });
  fs.writeFileSync(f, '[1,2]');
  assert.equal(json.readJson(f, {}).status, 'corrupt');
  assert.equal(json.readJson(f, []).status, 'ok');
  fs.writeFileSync(f, '{broken');
  assert.equal(json.readJson(f, {}).status, 'corrupt');
  assert.ok(fs.existsSync(f));
  fs.writeFileSync(f, '﻿{"bom":true}');
  assert.deepEqual(json.readJson(f, {}).data, { bom: true });
});

test('readJson returns a private copy of the fallback', () => {
  const fb = { list: [] };
  const r = json.readJson(path.join(dir, 'nope.json'), fb);
  r.data.list.push(1);
  assert.deepEqual(fb.list, []);
});

test('read: a corrupt file is moved aside and a warning returned', () => {
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, 'not json');
  const r = json.read(f, { ok: true });
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.data, { ok: true });
  assert.match(r.warning, /c\.json/);
  assert.ok(!fs.existsSync(f));
  const moved = fs.readdirSync(dir).filter((n) => n.startsWith('c.json.corrupt-'));
  assert.equal(moved.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, moved[0]), 'utf8'), 'not json');
  assert.equal(json.read(f, {}).warning, null);
});

test('update: read-modify-write, result passthrough, nothing written when fn throws', () => {
  const f = path.join(dir, 'u.json');
  const out = json.update(f, { n: 0 }, (d) => { d.n += 1; return d.n; });
  assert.equal(out, 1);
  assert.throws(() => json.update(f, { n: 0 }, (d) => { d.n = 99; throw new Error('boom'); }), /boom/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 1);
  assert.ok(!fs.existsSync(`${f}.lock`));
});

test('update on a corrupt file moves it aside first and warns', () => {
  const f = path.join(dir, 'uc.json');
  fs.writeFileSync(f, '{{{');
  const warnings = [];
  json.update(f, { n: 0 }, (d) => { d.n = 5; }, (m) => warnings.push(m));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 5);
  assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('uc.json.corrupt-')));
});

test('a stale lock (dead owner, old) is taken over; a fresh foreign lock times out', () => {
  const f = path.join(dir, 'l.json');
  const lock = `${f}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x', created: Date.now() - 120000 }));
  assert.equal(json.withLock(f, () => 'got it'), 'got it');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'y', created: Date.now() }));
  process.env.CREWGATE_LOCK_WAIT_MS = '300';
  assert.throws(() => json.withLock(f, () => 1), (e) => e.key === 'json.lockTimeout');
  process.env.CREWGATE_LOCK_WAIT_MS = '3000';
  fs.unlinkSync(lock);
});

test('parallel processes do not lose updates', async () => {
  const f = path.join(dir, 'p.json');
  const script = `
    const json = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'core', 'json.js'))});
    for (let i = 0; i < 15; i++) json.update(process.argv[1], { n: 0 }, (d) => { d.n += 1; });`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, f], { env: { ...process.env, CREWGATE_LOCK_WAIT_MS: '20000' }, stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 60);
});
