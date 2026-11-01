'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();

const doctor = (repo, args = []) => Object.fromEntries(JSON.parse(h.crew(['--json', ...args, 'doctor'], repo).out).checks.map((c) => [c.name, c]));
const setCleanup = (repo, v) => u.patchCfg(repo, (c) => {
  c.limits = c.limits || {};
  if (v === undefined) delete c.limits.session_cleanup; else c.limits.session_cleanup = v;
});
const ADVICE = /limits\.session_cleanup.*off.*\.claude\/crew\.json/;

test('doctor warns once when session_cleanup is on, in English and Traditional Chinese', () => {
  const repo = u.initRepo();
  setCleanup(repo, 'on');
  const c = doctor(repo).cleanup;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /cleanup is on in this project/i);
  assert.match(c.detail, /background processes/);
  assert.match(c.detail, /0\.20/);
  assert.match(c.detail, /Windows only/);
  assert.match(c.detail, ADVICE);
  assert.match(c.detail, /new session/);
  const zh = doctor(repo, ['--lang', 'zh-TW']).cleanup;
  assert.equal(zh.status, 'warn');
  assert.match(zh.detail, /session_cleanup/);
  assert.match(zh.detail, /Windows/);
  assert.notEqual(zh.detail, c.detail);
  const text = h.crew(['doctor'], repo).out.split('\n').filter((l) => /session_cleanup/.test(l));
  assert.equal(text.length, 1);
  assert.match(text[0], /^WARN/);
});

test('doctor has no cleanup check when session_cleanup is off', () => {
  const repo = u.initRepo();
  setCleanup(repo, 'off');
  assert.equal(doctor(repo).cleanup, undefined);
  assert.doesNotMatch(h.crew(['doctor'], repo).out, /session_cleanup/);
});

test('doctor has no cleanup check when session_cleanup is absent', () => {
  const repo = u.initRepo();
  setCleanup(repo, undefined);
  assert.equal(doctor(repo).cleanup, undefined);
  assert.doesNotMatch(h.crew(['doctor'], repo).out, /session_cleanup/);
});

test('crew init --force with cleanup on prints the advice, keeps on and still backs up', () => {
  const repo = u.initRepo();
  setCleanup(repo, 'on');
  const r = h.crew(['init', '--force'], repo);
  assert.equal(r.code, 0);
  assert.equal(r.out.split('\n').filter((l) => /session_cleanup/.test(l)).length, 1);
  assert.match(r.out, ADVICE);
  assert.match(r.out, /old copy saved as/);
  assert.equal(u.readCfg(repo).limits.session_cleanup, 'on');
  const zh = h.crew(['init', '--force', '--lang', 'zh-TW'], repo);
  assert.match(zh.out, /session_cleanup/);
});

test('a fresh crew init prints no cleanup line and writes off', () => {
  const repo = h.makeRepo();
  const r = h.crew(['init'], repo);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /session_cleanup/);
  assert.equal(u.readCfg(repo).limits.session_cleanup, 'off');
});
