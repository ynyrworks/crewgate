'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');
const paths = require('../lib/core/paths');

h.setupHome();

const checksOf = (repo, args = []) => Object.fromEntries(JSON.parse(h.crew(['--json', ...args, 'doctor'], repo).out).checks.map((c) => [c.name, c]));

test('doctor gates line names project gates with their modes, apart from the built-in list', () => {
  const repo = u.initRepo();
  const base = checksOf(repo).gates.detail;
  assert.doesNotMatch(base, /project gates/);
  assert.match(base, /ask gates: push, open_pr, merge$/);
  u.patchCfg(repo, (c) => { c.gates = { ...(c.gates || {}), release: 'ask', deploy: 'never' }; });
  const en = checksOf(repo).gates.detail;
  assert.match(en, /ask gates: push, open_pr, merge; project gates: release ask, deploy never/);
  const zh = checksOf(repo, ['--lang', 'zh-TW']).gates.detail;
  assert.match(zh, /ask 關卡：push, open_pr, merge；專案關卡：release ask, deploy never/);
});

test('crew init writes the shim so a project script works right away', () => {
  const home = process.env.CREWGATE_HOME;
  fs.rmSync(path.join(home, 'bin'), { recursive: true, force: true });
  const repo = u.initRepo();
  const shim = paths.cliShimFile();
  assert.ok(fs.existsSync(shim));
  const r = require('child_process').spawnSync(process.execPath, [shim, '--help'], { cwd: repo, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0);
});

test('doctor warns when the shim is missing or points at a removed plugin version, OK otherwise', () => {
  const repo = u.initRepo();
  const shim = paths.cliShimFile();
  assert.equal(checksOf(repo).shim.status, 'ok');
  fs.rmSync(shim);
  let c = checksOf(repo).shim;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /missing/);
  assert.match(c.detail, /crew init/);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, `require(${JSON.stringify(path.join(process.env.CREWGATE_HOME, 'gone', 'bin', 'crew.js'))});\n`);
  c = checksOf(repo).shim;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /no longer exists/);
  assert.match(c.detail, /gone/);
  assert.match(checksOf(repo, ['--lang', 'zh-TW']).shim.detail, /已不存在/);
  // init repairs it
  h.crew(['init'], repo);
  assert.equal(checksOf(repo).shim.status, 'ok');
});
