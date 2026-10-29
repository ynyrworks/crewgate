'use strict';

// crew board start|stop|status|serve — the local board (127.0.0.1 only).
// State file: <home>/board.json = { pid, port, started }. `start` launches `serve` detached.
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const paths = require('../core/paths');
const json = require('../core/json');
const config = require('../core/config');

const DEFAULT_PORT = 8781;
const SEARCH_SPAN = 20;
const START_WAIT_MS = 15000;
const BIN = path.join(__dirname, '..', '..', 'bin', 'crew.js');

const stateFile = () => path.join(paths.home(), 'board.json');
const logFile = () => path.join(paths.home(), 'board.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlOf = (port) => `http://127.0.0.1:${port}/`;

function readState() {
  const r = json.readJson(stateFile(), {});
  const d = r.data;
  return r.status === 'ok' && Number.isInteger(d.pid) && Number.isInteger(d.port) ? d : null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// GET /api/health -> parsed body or null
function health(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; if (s.length > 4096) req.destroy(); });
      res.on('end', () => { try { const o = JSON.parse(s); resolve(o && o.name === 'crewgate' ? o : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// { pid, port } of a live board of this data dir, else null (a stale state file is removed).
async function running() {
  const st = readState();
  if (!st) return null;
  if (alive(st.pid) && await health(st.port)) return st;
  try { fs.unlinkSync(stateFile()); } catch { /* already gone */ }
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function defaultPort() {
  try {
    const g = config.loadGlobal().config;
    if (Number.isInteger(g.port)) return g.port;
    if (g.board && Number.isInteger(g.board.port)) return g.board.port;
  } catch { /* use the built-in default */ }
  return DEFAULT_PORT;
}

// Only the local board is ever opened: http://127.0.0.1:<port>/<path without shell metacharacters>.
const LOCAL_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[A-Za-z0-9._~\/?=#-]*)?$/;

// -> { cmd, args, options } for opening a URL with the system browser, or null for an unsafe URL.
// On Windows cmd.exe's own "start" is used with verbatim arguments, so the empty window title ""
// reaches it untouched and the URL is never re-parsed by a shell layer of ours.
function openPlan(url, platform = process.platform) {
  if (typeof url !== 'string' || !LOCAL_URL_RE.test(url)) return null;
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '""', url], options: { ...options, windowsVerbatimArguments: true } };
  return { cmd: platform === 'darwin' ? 'open' : 'xdg-open', args: [url], options };
}

function openBrowser(url) {
  const plan = openPlan(url);
  if (!plan) return;
  try {
    const c = spawn(plan.cmd, plan.args, plan.options);
    c.on('error', () => { /* no browser available: the URL was printed */ });
    c.unref();
  } catch { /* ignore */ }
}

function writeState(port) {
  json.save(stateFile(), { pid: process.pid, port, started: new Date().toISOString() });
}

// Foreground server. Without `search` the exact port is required; with it the next free ports are tried.
async function serve(ctx, port, search) {
  const { createBoard } = require('../../board/server');
  const board = createBoard({});
  let bound = null;
  const last = search ? port + SEARCH_SPAN : port;
  for (let p = port; p <= last && bound === null; p++) {
    if (p > 65535) break;
    try { bound = await board.listen(p); } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
  }
  if (bound === null) throw new CrewError(search ? 'board.noPort' : 'board.portBusy', { port, from: port, to: last });
  writeState(bound);
  const cleanup = () => {
    const st = readState();
    if (st && st.pid === process.pid) { try { fs.unlinkSync(stateFile()); } catch { /* ignore */ } }
  };
  process.on('exit', cleanup);
  const stop = () => { board.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  ctx.out(ctx.t('board.serving', { url: board.url() }));
  return new Promise(() => { /* runs until a signal ends the process */ });
}

async function start(ctx, a) {
  const cur = await running();
  if (cur) {
    ctx.emit({ running: true, started: false, pid: cur.pid, port: cur.port, url: urlOf(cur.port) }, ctx.t('board.alreadyRunning', { url: urlOf(cur.port) }));
    if (!a.noOpen) openBrowser(urlOf(cur.port));
    return 0;
  }
  const explicit = a.port !== undefined;
  const port = explicit ? a.port : defaultPort();
  if (explicit && !(await portFree(port))) throw new CrewError('board.portBusy', { port });
  fs.mkdirSync(paths.home(), { recursive: true });
  const fd = fs.openSync(logFile(), 'a');
  const child = spawn(process.execPath, [BIN, 'board', 'serve', '--port', String(port), ...(explicit ? [] : ['--search'])], {
    detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline && !exited) {
    const st = readState();
    if (st && st.pid === child.pid && await health(st.port)) {
      ctx.emit({ running: true, started: true, pid: st.pid, port: st.port, url: urlOf(st.port) }, ctx.t('board.started', { url: urlOf(st.port) }));
      if (!a.noOpen) openBrowser(urlOf(st.port));
      return 0;
    }
    await sleep(100);
  }
  throw new CrewError('board.startFailed', { log: logFile() });
}

async function stop(ctx) {
  const cur = await running();
  if (!cur) {
    ctx.emit({ running: false }, ctx.t('board.notRunning'));
    return 0;
  }
  try { process.kill(cur.pid, 'SIGTERM'); } catch { throw new CrewError('board.stopFailed', { pid: cur.pid }); }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (alive(cur.pid) || await health(cur.port, 300))) await sleep(100);
  try { fs.unlinkSync(stateFile()); } catch { /* the server may have removed it already */ }
  if (alive(cur.pid)) throw new CrewError('board.stopFailed', { pid: cur.pid });
  ctx.emit({ running: false, stopped: true }, ctx.t('board.stopped'));
  return 0;
}

async function status(ctx) {
  const cur = await running();
  if (!cur) {
    ctx.emit({ running: false }, ctx.t('board.notRunning'));
    return 1;
  }
  ctx.emit({ running: true, pid: cur.pid, port: cur.port, url: urlOf(cur.port) }, ctx.t('board.running', { url: urlOf(cur.port), pid: cur.pid }));
  return 0;
}

const SPECS = {
  start: { positionals: [], options: { '--port': { dest: 'port', int: true }, '--no-open': { dest: 'noOpen', flag: true } } },
  stop: { positionals: [], options: {} },
  status: { positionals: [], options: {} },
  serve: { positionals: [], options: { '--port': { dest: 'port', int: true }, '--search': { dest: 'search', flag: true } } },
};

async function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('board.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  if (a.port !== undefined && (a.port < 1 || a.port > 65535)) throw new UsageError('args.badChoice', { name: '--port', choices: '1-65535' });
  if (sub === 'start') return start(ctx, a);
  if (sub === 'stop') return stop(ctx);
  if (sub === 'status') return status(ctx);
  return serve(ctx, a.port === undefined ? defaultPort() : a.port, a.port === undefined || a.search === true);
}

module.exports = {
  name: 'board',
  summary: { en: 'Local board (start, stop, status, serve)', 'zh-TW': '本機看板（start、stop、status、serve）' },
  usage: {
    en: '  crew board start [--port N] [--no-open]\n  crew board stop\n  crew board status        (exit 1 when not running)\n  crew board serve [--port N]   (foreground)',
    'zh-TW': '  crew board start [--port N] [--no-open]\n  crew board stop\n  crew board status        （未執行時 exit 1）\n  crew board serve [--port N]   （前景執行）',
  },
  run,
  openPlan,
};
