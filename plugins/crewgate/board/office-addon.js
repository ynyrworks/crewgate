'use strict';

// The optional Office add-on (DESIGN section 14), a separate plugin the board only reads files from.
// It is looked for in three fixed places, never in a configured path and never on the network:
//   the folder next to this plugin (a checkout or a vendored copy)
//   <claude>/plugins/cache/crewgate/crewgate-office/<version>
//   <codex>/plugins/cache/crewgate/crewgate-office/<version>
// find() -> { state: missing } | { state: outdated, version } | { state: ok, version, root, scripts, styles }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseVersion, compareVersions } = require('../lib/core/update-check');
const { isManaged } = require('../lib/core/update-apply');

const OFFICE_API = 2;   // what office.json must declare; raise it when the page contract in app.js changes
const NAME = 'crewgate-office';
const ID = `${NAME}@crewgate`;
const COMMANDS = {
  install: [`claude plugin install ${ID}`],
  update: ['claude plugin marketplace update crewgate', `claude plugin update ${ID}`],
};
const CODE_NAME = /^[a-z0-9-]+\.(js|css)$/;
const ASSET_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(js|png|json)$/;   // loaded by the add-on itself when it needs them

function cachedVersions(configDir) {
  const base = path.join(configDir, 'plugins', 'cache', 'crewgate', NAME);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names.filter((n) => parseVersion(n)).sort((a, b) => compareVersions(b, a)).map((n) => path.join(base, n));
}

// An uninstall leaves the cache folder behind, so the tool's own list decides whether the add-on is installed.
function declared(file) {
  try { return fs.readFileSync(file, 'utf8').includes(ID); } catch { return false; }
}

function candidates(pluginRoot, env) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codex = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const inClaude = declared(path.join(claude, 'plugins', 'installed_plugins.json'));
  const inCodex = declared(path.join(codex, 'config.toml'));
  // A marketplace clone holds the add-on next to the plugin whether or not it was installed,
  // so an installed plugin only counts that folder when the tool lists the add-on.
  const sibling = !isManaged(pluginRoot, env) || inClaude || inCodex ? [path.join(pluginRoot, '..', NAME)] : [];
  return [
    ...sibling,
    ...(inClaude ? cachedVersions(claude) : []),
    ...(inCodex ? cachedVersions(codex) : []),
  ];
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const names = (list, re = CODE_NAME) => (Array.isArray(list) ? list.filter((f) => typeof f === 'string' && re.test(f)) : []);

function find({ pluginRoot = path.join(__dirname, '..'), env = process.env } = {}) {
  let outdated = null;
  for (const root of candidates(pluginRoot, env)) {
    const m = readJson(path.join(root, 'office.json'));
    if (!m) continue;
    const plugin = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
    const version = typeof plugin.version === 'string' ? plugin.version : null;
    if (m.office_api !== OFFICE_API) { outdated = outdated || { state: 'outdated', version }; continue; }
    return { state: 'ok', version, root, scripts: names(m.scripts), styles: names(m.styles), assets: names(m.assets, ASSET_NAME) };
  }
  return outdated || { state: 'missing' };
}

// What the page gets: never the folder on disk.
function describe(found) {
  const o = { state: found.state, version: found.version || null, install: COMMANDS.install, update: COMMANDS.update };
  if (found.state === 'ok') {
    o.scripts = found.scripts.map((f) => `/addon/office/${f}`);
    o.styles = found.styles.map((f) => `/addon/office/${f}`);
  }
  return o;
}

// A file the add-on listed in office.json, read from its public folder. -> Buffer or null
function readFile(found, name) {
  if (found.state !== 'ok' || ![found.scripts, found.styles, found.assets || []].some((l) => l.includes(name))) return null;
  try {
    const base = fs.realpathSync(path.join(found.root, 'public'));
    const real = fs.realpathSync(path.join(base, name));
    if (!real.startsWith(base + path.sep)) return null;
    return fs.readFileSync(real);
  } catch { return null; }
}

module.exports = { find, describe, readFile, OFFICE_API, ID, NAME, COMMANDS };
