'use strict';

// The optional Office add-on: where the board looks for it, what it serves, and that the board works without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const addon = require('../board/office-addon');
const { createBoard } = require('../board/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-addon-'));

// An add-on folder with an office.json, a plugin.json and its public files.
function makeAddon(root, { api = addon.OFFICE_API, version = '0.15.0', scripts = ['a.js'], styles = ['a.css'] } = {}) {
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'office.json'), JSON.stringify({ office_api: api, scripts, styles }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'crewgate-office', version }));
  fs.writeFileSync(path.join(root, 'public', 'a.js'), 'window.A = 1;');
  fs.writeFileSync(path.join(root, 'public', 'a.css'), 'a {}');
  fs.writeFileSync(path.join(root, 'public', 'secret.js'), 'not listed');
  return root;
}

function machine() {
  const root = tmp();
  const pluginRoot = path.join(root, 'plugins', 'crewgate');
  fs.mkdirSync(pluginRoot, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const cached = (dir, v) => path.join(dir, 'plugins', 'cache', 'crewgate', 'crewgate-office', v);
  // what each tool's own list says after an install
  fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'crewgate-office@crewgate': [] } }));
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), '[plugins."crewgate-office@crewgate"]\nenabled = true\n');
  return { root, pluginRoot, env, sibling: path.join(root, 'plugins', 'crewgate-office'), claude: (v) => cached(env.CLAUDE_CONFIG_DIR, v), codex: (v) => cached(env.CODEX_HOME, v) };
}

const find = (m) => addon.find({ pluginRoot: m.pluginRoot, env: m.env });

test('without the add-on the state is missing and the page gets the install command', () => {
  const m = machine();
  const d = addon.describe(find(m));
  assert.equal(d.state, 'missing');
  assert.deepEqual(d.install, ['claude plugin install crewgate-office@crewgate']);
  assert.equal(d.scripts, undefined);
});

test('found next to the plugin, in the Claude cache (newest first) and in the Codex cache', () => {
  let m = machine();
  makeAddon(m.sibling);
  assert.equal(find(m).root, m.sibling);
  m = machine();
  makeAddon(m.claude('0.9.0'), { version: '0.9.0' });
  makeAddon(m.claude('0.15.0'), { version: '0.15.0' });
  assert.equal(find(m).version, '0.15.0');
  m = machine();
  makeAddon(m.codex('0.15.0'));
  assert.equal(find(m).state, 'ok');
});

test('an uninstalled add-on leaves its cache folder behind, and that does not count as installed', () => {
  const m = machine();
  makeAddon(m.claude('0.15.0'));
  makeAddon(m.codex('0.15.0'));
  assert.equal(find(m).state, 'ok');
  fs.writeFileSync(path.join(m.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'crewgate@crewgate': [] } }));
  fs.rmSync(path.join(m.env.CODEX_HOME, 'config.toml'));
  assert.equal(find(m).state, 'missing');
});

test('a plugin running from a marketplace clone does not count the add-on next to it until the tool lists it', () => {
  const m = machine();
  const clone = path.join(m.env.CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'crewgate', 'plugins');
  const pluginRoot = path.join(clone, 'crewgate');
  fs.mkdirSync(pluginRoot, { recursive: true });
  makeAddon(path.join(clone, 'crewgate-office'));
  assert.equal(addon.find({ pluginRoot, env: m.env }).state, 'ok', 'listed');
  fs.writeFileSync(path.join(m.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'crewgate@crewgate': [] } }));
  fs.rmSync(path.join(m.env.CODEX_HOME, 'config.toml'));
  assert.equal(addon.find({ pluginRoot, env: m.env }).state, 'missing', 'not listed');
});

test('an add-on with another office_api is not loaded and says it needs updating; a matching one wins', () => {
  const m = machine();
  makeAddon(m.claude('0.15.0'), { api: 99 });
  const d = addon.describe(find(m));
  assert.equal(d.state, 'outdated');
  assert.equal(d.scripts, undefined);
  assert.ok(d.update.includes('claude plugin update crewgate-office@crewgate'));
  makeAddon(m.codex('0.15.0'));
  assert.equal(find(m).state, 'ok');
});

test('the page is never told the folder, and only listed files with plain names are offered', () => {
  const m = machine();
  makeAddon(m.sibling, { scripts: ['a.js', '../evil.js', 'b.exe', 7] });
  const f = find(m);
  assert.deepEqual(f.scripts, ['a.js']);
  assert.doesNotMatch(JSON.stringify(addon.describe(f)), new RegExp(path.basename(m.root)));
  assert.equal(addon.readFile(f, 'a.js').toString(), 'window.A = 1;');
  assert.equal(addon.readFile(f, 'secret.js'), null);
  assert.equal(addon.readFile(f, '../office.json'), null);
  assert.equal(addon.readFile({ state: 'missing' }, 'a.js'), null);
});

async function withBoard(m, fn) {
  const board = createBoard({ port: 0, addon: { pluginRoot: m.pluginRoot, env: m.env } });
  await board.listen(0);
  try { await fn(`http://127.0.0.1:${board.port()}`); } finally { await board.close(); }
}

test('board: /api/addons reports the add-on and its files are served only when it is installed', async () => {
  const m = machine();
  await withBoard(m, async (url) => {
    let d = await (await fetch(`${url}/api/addons`)).json();
    assert.equal(d.office.state, 'missing');
    assert.equal((await fetch(`${url}/addon/office/a.js`)).status, 404);
    assert.equal((await fetch(`${url}/`)).status, 200, 'the board works without it');

    makeAddon(m.sibling);   // no restart needed: a reload of the page finds it
    d = await (await fetch(`${url}/api/addons`)).json();
    assert.equal(d.office.state, 'ok');
    assert.deepEqual(d.office.scripts, ['/addon/office/a.js']);
    const r = await fetch(`${url}/addon/office/a.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${url}/addon/office/secret.js`)).status, 404);
    assert.equal((await fetch(`${url}/addon/office/..%2Foffice.json`)).status, 404);
    assert.equal((await fetch(`${url}/api/addons`, { method: 'POST' })).status, 405);
  });
});

test('the plugin page holds nothing of the add-on, and the real add-on matches this board', () => {
  const pub = path.join(__dirname, '..', 'board', 'public');
  assert.doesNotMatch(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), /office/);
  for (const f of ['office.js', 'office-model.js', 'office-sprites.js', 'office.css']) assert.equal(fs.existsSync(path.join(pub, f)), false, f);
  const real = path.join(__dirname, '..', '..', 'crewgate-office');
  const f = addon.find({ pluginRoot: path.join(__dirname, '..'), env: { CLAUDE_CONFIG_DIR: tmp(), CODEX_HOME: tmp() } });
  assert.equal(f.state, 'ok');
  assert.equal(path.resolve(f.root), path.resolve(real));
  for (const n of [...f.scripts, ...f.styles]) assert.ok(addon.readFile(f, n).length > 0, n);
});

test('the add-on has the same version as the plugin everywhere, and the marketplace lists both', () => {
  const repo = path.join(__dirname, '..', '..', '..');
  const json = (...p) => JSON.parse(fs.readFileSync(path.join(repo, ...p), 'utf8'));
  const v = json('plugins', 'crewgate', '.claude-plugin', 'plugin.json').version;
  assert.equal(json('plugins', 'crewgate-office', '.claude-plugin', 'plugin.json').version, v);
  assert.equal(json('plugins', 'crewgate-office', '.codex-plugin', 'plugin.json').version, v);
  const listed = json('.claude-plugin', 'marketplace.json').plugins;
  assert.deepEqual(listed.map((p) => [p.name, p.version]), [['crewgate', v], ['crewgate-office', v]]);
});
