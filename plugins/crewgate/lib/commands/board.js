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
const LOCK_WAIT_MS = 8000;  // how long a manual start waits for an autostart in progress
const LOCK_MS = 30000;   // an autostart lock older than this is stale (the board it was for never came up)
const BIN = path.join(__dirname, '..', '..', 'bin', 'crew.js');

const stateFile = () => path.join(paths.home(), 'board.json');
const logFile = () => path.join(paths.home(), 'board.log');
const lockFile = () => path.join(paths.home(), 'board.starting');
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

// One timestamped line in board.log, written synchronously so it survives an exit in progress. Never throws.
function logLine(text) {
  try { fs.appendFileSync(logFile(), `${new Date().toISOString()} ${text}
`); } catch { /* the log is best effort */ }
}

// The state file when it points at a dead process: the board was killed and could not say why
// (a clean stop removes the file). Read-only. Null when there is no state file or its pid lives.
function staleState() {
  const st = readState();
  return st && !alive(st.pid) ? st : null;
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
  if (!alive(st.pid)) logLine(`previous board (pid ${st.pid}, started ${st.started || 'unknown'}) is gone and left no stop line; state file removed`);
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

// Prefixes every line written through a stream with an ISO timestamp (board.log has none otherwise).
// Chunks that end mid-line keep the prefix for the line that continues them.
function stampLines(stream, now = () => new Date()) {
  const write = stream.write.bind(stream);
  let atStart = true;
  stream.write = (chunk, enc, cb) => {
    let text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (!text) return write(chunk, enc, cb);
    const ts = `${now().toISOString()} `;
    const endsNl = text.endsWith('\n');
    text = text.split('\n').map((l, i, a) => ((i === 0 && !atStart) || (i === a.length - 1 && endsNl) ? l : ts + l)).join('\n');
    atStart = endsNl;
    return write(text, enc, cb);
  };
}

// Launches `board serve` detached from the given crew.js; its output goes to the board log.
function spawnServe(bin, port, { search = false } = {}) {
  fs.mkdirSync(paths.home(), { recursive: true });
  const fd = fs.openSync(logFile(), 'a');
  try { fs.writeSync(fd, `${new Date().toISOString()} starting board serve (port ${port})\n`); } catch { /* the log is best effort */ }
  const child = spawn(process.execPath, [bin, 'board', 'serve', '--port', String(port), ...(search ? ['--search'] : [])], {
    detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  return child;
}

// Records why the server stops: one line per signal, crash and exit. A process killed outright (SIGKILL,
// a job object closing) runs none of this; `board status` and `doctor` report the leftover state file instead.
function installStopLog() {
  const pid = process.pid;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => logLine(`board (pid ${pid}) received ${sig}`));
  process.on('uncaughtException', (e) => {
    logLine(`board (pid ${pid}) uncaught exception: ${(e && e.stack) || e}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    logLine(`board (pid ${pid}) unhandled rejection: ${(e && e.stack) || e}`);
    process.exit(1);
  });
  process.on('exit', (code) => logLine(`board (pid ${pid}) exit, code ${code}`));
}

// Foreground server. Without `search` the exact port is required; with it the next free ports are tried.
async function serve(ctx, port, search) {
  const { createBoard } = require('../../board/server');
  stampLines(process.stdout);
  stampLines(process.stderr);
  let bound = null;
  // After a one-click update: free the port, start the updated code on it, and leave only when it answers.
  // If it never does, take the port back so the old board keeps working.
  const restart = async (newRoot) => {
    await board.close();
    const r = await require('../core/update-apply').launchReplacement(newRoot, bound);
    if (r.ok) { setTimeout(() => process.exit(0), 200); return r; }
    await board.listen(bound);
    writeState(bound);
    return r;
  };
  const board = createBoard({ updates: { auto: true, restart } });
  const last = search ? port + SEARCH_SPAN : port;
  for (let p = port; p <= last && bound === null; p++) {
    if (p > 65535) break;
    try { bound = await board.listen(p); } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
  }
  if (bound === null) throw new CrewError(search ? 'board.noPort' : 'board.portBusy', { port, from: port, to: last });
  writeState(bound);
  try { fs.unlinkSync(lockFile()); } catch { /* no autostart lock */ }
  const cleanup = () => {
    const st = readState();
    if (st && st.pid === process.pid) { try { fs.unlinkSync(stateFile()); } catch { /* ignore */ } }
  };
  process.on('exit', cleanup);
  installStopLog();
  const stop = () => { board.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // A closing terminal or session sends SIGHUP: shut down cleanly (the stop line above records it).
  process.on('SIGHUP', stop);
  ctx.out(ctx.t('board.serving', { url: board.url() }));
  return new Promise(() => { /* runs until a signal ends the process */ });
}

// Takes the start-up lock (board.starting, created exclusively) so two sessions starting at once spawn one board.
function takeLock() {
  const f = lockFile();
  try { fs.mkdirSync(paths.home(), { recursive: true }); } catch { return false; }
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(f).mtimeMs <= LOCK_MS) return false; fs.unlinkSync(f); } catch { return false; }
    }
  }
  return false;
}

// Spawns `board serve` for an autostart, holding the start-up lock. -> 'started' | 'busy' | 'error'
function launch(g, opts) {
  if (!takeLock()) return 'busy';
  const port = Number.isInteger(g.port) ? g.port : (g.board && Number.isInteger(g.board.port) ? g.board.port : DEFAULT_PORT);
  try {
    (opts.spawn || spawnServe)(BIN, port, { search: false });
  } catch (e) {
    try { fs.unlinkSync(lockFile()); } catch { /* ignore */ }
    logLine(`autostart could not spawn the board: ${e && e.message}`);
    return 'error';
  }
  return 'started';
}

// Detached `crew board ensure`: does the slow part (does the recorded board answer?) outside the hook.
function spawnEnsure() {
  const c = spawn(process.execPath, [BIN, 'board', 'ensure'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  c.on('error', () => { /* best effort */ });
  c.unref();
}

// SessionStart autostart (global config board.autostart, default off). Synchronous and quick: checks the global switch
// and the state file, then spawns detached and does not wait. It never throws.
//   no state file or a dead pid -> spawn the server (under the start lock)
//   a live pid                  -> the pid may belong to an unrelated process (reused), so a detached `board ensure`
//                                  checks that the board answers and starts one if not ('checking')
// The exact port is required (no search), so a board already listening there without a state file makes the new one exit.
// -> 'off' | 'checking' | 'busy' | 'started' | 'error'
function ensureStarted(opts = {}) {
  try {
    const g = (opts.global || config.loadGlobal().config);
    if (!(g.board && g.board.autostart === true)) return 'off';
    const st = readState();
    if (st && alive(st.pid)) {
      (opts.spawnEnsure || spawnEnsure)();
      return 'checking';
    }
    return launch(g, opts);
  } catch { return 'error'; }
}

// What `board ensure` runs: like ensureStarted, but a live pid only counts when the board answers. It runs detached
// and nothing waits for it, so a busy machine gets 2 s before a healthy board is taken for a dead one.
// -> 'off' | 'running' | 'busy' | 'started' | 'error'
async function ensureChecked(opts = {}) {
  try {
    const g = (opts.global || config.loadGlobal().config);
    if (!(g.board && g.board.autostart === true)) return 'off';
    const st = readState();
    if (st && alive(st.pid)) {
      if (await health(st.port, 2000)) return 'running';
      logLine(`state file names pid ${st.pid} (started ${st.started || 'unknown'}) but no board answers on port ${st.port}; starting one`);
    }
    return launch(g, opts);
  } catch { return 'error'; }
}

async function start(ctx, a) {
  const cur = await running();
  if (cur) {
    ctx.emit({ running: true, started: false, pid: cur.pid, port: cur.port, url: urlOf(cur.port) }, ctx.t('board.alreadyRunning', { url: urlOf(cur.port) }));
    if (!a.noOpen) openBrowser(urlOf(cur.port));
    return 0;
  }
  // An autostart may be bringing a board up right now (the state file is written once it listens): wait for it
  // and report that board instead of starting a second one.
  if (!takeLock()) {
    const end = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < end && fs.existsSync(lockFile())) {
      const got = await running();
      if (got) {
        ctx.emit({ running: true, started: false, pid: got.pid, port: got.port, url: urlOf(got.port) }, ctx.t('board.alreadyRunning', { url: urlOf(got.port) }));
        if (!a.noOpen) openBrowser(urlOf(got.port));
        return 0;
      }
      await sleep(100);
    }
    const got = await running();
    if (got) {
      ctx.emit({ running: true, started: false, pid: got.pid, port: got.port, url: urlOf(got.port) }, ctx.t('board.alreadyRunning', { url: urlOf(got.port) }));
      if (!a.noOpen) openBrowser(urlOf(got.port));
      return 0;
    }
    // the other start never produced a board: go on (a stale lock is replaced by the next takeLock)
  }
  const explicit = a.port !== undefined;
  const port = explicit ? a.port : defaultPort();
  if (explicit && !(await portFree(port))) { try { fs.unlinkSync(lockFile()); } catch { /* ignore */ } throw new CrewError('board.portBusy', { port }); }
  const child = spawnServe(BIN, port, { search: !explicit });
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
  try { fs.unlinkSync(lockFile()); } catch { /* ignore */ }
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
  const stale = staleState();
  const cur = await running();
  if (!cur) {
    if (stale) {
      ctx.emit({ running: false, stale: true, pid: stale.pid, started: stale.started || null },
        [ctx.t('board.notRunning'), ctx.t('board.stale', { pid: stale.pid, started: stale.started || '?', log: logFile() })]);
      return 1;
    }
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
  ensure: { positionals: [], options: {} },   // internal: the detached check behind board.autostart
};

async function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('board.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  if (a.port !== undefined && (a.port < 1 || a.port > 65535)) throw new UsageError('args.badChoice', { name: '--port', choices: '1-65535' });
  if (sub === 'start') return start(ctx, a);
  if (sub === 'stop') return stop(ctx);
  if (sub === 'status') return status(ctx);
  if (sub === 'ensure') { logLine(`autostart check: ${await ensureChecked()}`); return 0; }
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
  spawnServe,
  ensureStarted,
  ensureChecked,
  installStopLog,
  staleState,
  logFile,
  stampLines,
  readState,
  health,
  running,
  alive,
};
