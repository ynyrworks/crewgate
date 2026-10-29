'use strict';

// Helpers for the update tests (not a test file): a fake "GitHub" HTTP server and fake claude/codex
// executables. Nothing here reaches the real network or runs a real CLI.
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const h = require('./board-helpers');

// handler(req, res, hit) decides the answer; every request is counted and its headers kept.
function fakeGithub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    handler(req, res, seen.length);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/repos/ynyrworks/crewgate/releases/latest`,
        seen,
        hits: () => seen.length,
        close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
      });
    });
  });
}

const release = (tag, extra = {}) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, body: 'notes', ...extra }));
};

// A fake executable `name` in `dir`. `body` is the JavaScript of the program; it can read
// `cfg` (the object written next to it) and use `log(line)` (appends to cfg.log).
function fakeCli(dir, name, cfg, body) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(path.join(dir, `${name}.cfg.json`), JSON.stringify(cfg));
  fs.writeFileSync(script, [
    "'use strict';",
    "const fs = require('fs'); const path = require('path');",
    `const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '${name}.cfg.json'), 'utf8'));`,
    'const log = (l) => fs.appendFileSync(cfg.log, l + "\\n");',
    'const args = process.argv.slice(2);',
    body,
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const sh = path.join(dir, name);
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }
}

// claude: `plugin list` prints cfg.list; `plugin update` runs cfg.onUpdate (JavaScript string) and may fail.
const CLAUDE_BODY = `
log('claude ' + args.join(' '));
if (args[0] === 'plugin' && args[1] === 'list') { process.stdout.write(cfg.list || ''); process.exit(0); }
if (cfg.noise) { process.stdout.write(cfg.noise); }
if (cfg.sleep) { setTimeout(() => {}, cfg.sleep); return; }
if (args[1] === 'update' && cfg.onUpdate) eval(cfg.onUpdate);
process.exit(cfg.fail && args[1] === 'update' ? 3 : 0);
`;

// codex: records whether its stdin ended at once (closed) or stayed open.
const CODEX_BODY = `
log('codex ' + args.join(' '));
let ended = false;
process.stdin.on('end', () => { ended = true; log('stdin-closed'); process.exit(0); });
process.stdin.resume();
setTimeout(() => { if (!ended) { log('stdin-open'); process.exit(9); } }, 3000);
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Environment for code that must find only the fake tools.
function fakeEnv({ bin, claudeDir, codexDir, extra = {} }) {
  const env = {
    PATH: bin,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    CREWGATE_CODEX_STORE_DIR: h.tmpDir('crew-store-'),
    CREWGATE_POWERSHELL: path.join(h.tmpDir('crew-nops-'), 'powershell-missing'),   // never the real PowerShell
    CREWGATE_HOME: process.env.CREWGATE_HOME,
    ...extra,
  };
  for (const k of ['SystemRoot', 'ComSpec', 'windir', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function writeGlobalConfig(obj) {
  fs.mkdirSync(process.env.CREWGATE_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CREWGATE_HOME, 'config.json'), JSON.stringify({ version: 1, ...obj }));
}

// The CLI as a child process with extra environment; async so a fake server in this process keeps answering.
function crewAsync(args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [h.BIN, ...args], { cwd, env: { ...process.env, ...extraEnv } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// Versions relative to the running one (the manifest), so no test hard-codes a release number.
function versions() {
  const cur = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const [a, b, c] = cur.split('.').map(Number);
  return { current: cur, same: cur, patch: `${a}.${b}.${c + 1}`, minor: `${a}.${b + 1}.0`, major: `${a + 1}.0.0`, older: a > 0 || b > 0 || c > 0 ? (c > 0 ? `${a}.${b}.${c - 1}` : b > 0 ? `${a}.${b - 1}.0` : `0.0.0`) : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ...h, fakeGithub, release, fakeCli, CLAUDE_BODY, CODEX_BODY, freePort, crewAsync, versions, fakeEnv, writeGlobalConfig, sleep };
