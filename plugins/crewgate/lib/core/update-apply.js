'use strict';

// One-click update (DESIGN section 10). Runs ONLY these fixed commands, never anything a client sent:
//   claude plugin marketplace update crewgate ; claude plugin update crewgate@crewgate
//   codex  plugin marketplace upgrade crewgate
// Programs are resolved through lib/core/exec.js (PATH / PATHEXT, no shell), stdin is closed, each call
// has a time limit and its output is redacted and truncated. A development checkout, or a machine
// without either CLI, runs nothing: the commands are handed back for the user to copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const execx = require('./exec');
const paths = require('./paths');
const redact = require('./redact');
const { parseVersion, compareVersions } = require('./update-check');
const cleanup = require('./update-cleanup');

const ID = 'crewgate@crewgate';
const OFFICE_ID = 'crewgate-office@crewgate';   // the optional add-on, updated along with the plugin when it is installed
const COMMANDS = {
  claude: [['plugin', 'marketplace', 'update', 'crewgate'], ['plugin', 'update', ID]],
  codex: [['plugin', 'marketplace', 'upgrade', 'crewgate']],
};
const STEP_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 20000;
const OUT_MAX = 2000;
const CAPTURE_MAX = 64 * 1024;
const LOCK_STALE_MS = 15 * 60 * 1000;
const RESTART_WAIT_MS = 30000;
const RESTART_COMMAND = 'crew board start';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const display = (tool, args) => `${tool} ${args.join(' ')}`;
const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function configDirs(env = process.env) {
  return {
    claude: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codex: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}

// Is the running plugin an installed copy (under <claude>/plugins or <codex>/plugins)?
function isManaged(pluginRoot, env = process.env) {
  let real;
  try { real = fs.realpathSync(pluginRoot); } catch { real = path.resolve(pluginRoot); }
  const d = configDirs(env);
  return [d.claude, d.codex].some((dir) => {
    let base = path.join(dir, 'plugins');
    try { base = fs.realpathSync(base); } catch { /* keep the lexical path */ }
    return lower(real).startsWith(lower(base) + path.sep);
  });
}

// Codex ships through the Microsoft Store on Windows and is often not on PATH. C:\Program Files\WindowsApps
// cannot be listed by a normal user, so the package is asked for through PowerShell first.
// CREWGATE_CODEX_STORE_DIR replaces the WindowsApps folder and CREWGATE_POWERSHELL the PowerShell program (tests).
const APPX_QUERY = '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation';
const POWERSHELL_TIMEOUT_MS = 10000;

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const storeExe = (loc) => path.join(loc, 'app', 'resources', 'codex.exe');

function listedStoreCodex(env) {
  const dir = env.CREWGATE_CODEX_STORE_DIR || 'C:\Program Files\WindowsApps';
  try {
    const hits = fs.readdirSync(dir).filter((n) => /^OpenAI\.Codex_/i.test(n)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const n of hits) if (isFile(storeExe(path.join(dir, n)))) return storeExe(path.join(dir, n));
  } catch { /* a normal user may not list this folder */ }
  return null;
}

async function appxCodex(env, o) {
  const ps = env.CREWGATE_POWERSHELL
    || execx.resolveCommand('powershell.exe', { env, platform: 'win32' })
    || path.join(env.SystemRoot || env.windir || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await runCommand(ps, ['-NoProfile', '-NonInteractive', '-Command', APPX_QUERY], { env, platform: o.platform, timeoutMs: o.powershellTimeoutMs || POWERSHELL_TIMEOUT_MS });
  if (r.code !== 0 || r.timedOut || r.error) return null;
  const loc = r.output.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
  if (!loc || !path.isAbsolute(loc)) return null;
  const exe = storeExe(loc);
  return isFile(exe) ? exe : null;
}

function configuredCodex() {
  try {
    const c = require('./config').loadGlobal().config.engines;
    const cmd = c && c.codex && c.codex.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
  } catch { return null; }
}

// Order: engines.codex.command of the global config, `codex` on PATH, Get-AppxPackage (Windows), the
// WindowsApps listing. -> absolute path or null.
async function findCodex(env, platform, o = {}) {
  const configured = configuredCodex();
  for (const cmd of configured && configured !== 'codex' ? [configured, 'codex'] : ['codex']) {
    const found = execx.resolveCommand(cmd, { env, platform });
    if (found) return found;
  }
  if (platform !== 'win32') return null;
  try { const viaAppx = await appxCodex(env, { ...o, platform }); if (viaAppx) return viaAppx; } catch { /* next */ }
  return listedStoreCodex(env);
}

async function findCli(tool, env, platform, o = {}) {
  if (tool === 'codex') return findCodex(env, platform, o);
  return execx.resolveCommand(tool, { env, platform });
}

// Runs one fixed command. -> { code, timedOut, output, error }. stdin is closed.
function runCommand(file, args, { env, timeoutMs, platform, outMax = OUT_MAX }) {
  return new Promise((resolve) => {
    let plan;
    try { plan = execx.spawnPlan(file, args, { platform }); } catch (e) { resolve({ code: null, timedOut: false, output: '', error: e.message }); return; }
    let child;
    try {
      child = spawn(plan.file, plan.args, { ...plan.options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (e) { resolve({ code: null, timedOut: false, output: '', error: e.message }); return; }
    let out = '';
    let settled = false;
    const take = (c) => { if (out.length < CAPTURE_MAX) out += c.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ output: redact.clean(out, outMax), ...r }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } end({ code: null, timedOut: true }); }, timeoutMs);
    child.on('error', (e) => end({ code: null, timedOut: false, error: e.code || 'spawn error' }));
    child.on('close', (code) => end({ code, timedOut: false }));
  });
}

// The full list (a long one must not hide the plugin behind the output limit). -> text naming the installed plugins
async function claudeListing(file, o) {
  const probe = { ...o, timeoutMs: PROBE_TIMEOUT_MS, outMax: CAPTURE_MAX };
  const r = await runCommand(file, ['plugin', 'list', '--json'], probe);
  if (r.code === 0 && r.output.includes(ID)) return r.output;
  const t = await runCommand(file, ['plugin', 'list'], probe);
  return t.code === 0 ? t.output : '';
}

function codexInstalled(env) {
  try {
    const text = fs.readFileSync(path.join(configDirs(env).codex, 'config.toml'), 'utf8');
    return /^\s*\[plugins\.["']crewgate@crewgate["']\]/m.test(text);
  } catch { return false; }
}

const underDir = (root, dir) => {
  let real;
  try { real = fs.realpathSync(root); } catch { real = path.resolve(root); }
  let base = path.join(dir, 'plugins');
  try { base = fs.realpathSync(base); } catch { /* lexical */ }
  return lower(real).startsWith(lower(base) + path.sep);
};

// Is the plugin installed in Claude Code, judged from files (used when the CLI cannot be found)?
function claudeInstalledOnDisk(pluginRoot, env) {
  const dir = configDirs(env).claude;
  if (underDir(pluginRoot, dir)) return true;
  try { if (fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8').includes(ID)) return true; } catch { /* next */ }
  try { return fs.statSync(cleanup.cacheDir({ claude: dir }, 'claude')).isDirectory(); } catch { return false; }
}

// reason: why the commands are only shown (cliNotFound, devCheckout, notInstalled).
function manualList(reason, tools = Object.keys(COMMANDS)) {
  return tools.map((tool) => ({ tool, reason, commands: COMMANDS[tool].map((a) => display(tool, a)) }));
}

// -> { managed, steps: [{ tool, file, args, cmd }], tools: [{ tool, status: run|skipped|manual, reason }], manual }.
// Nothing is dropped silently: a tool that is installed but whose CLI cannot be found is `manual`.
async function plan(o) {
  const managed = isManaged(o.pluginRoot, o.env);
  if (!managed) {
    const manual = manualList('devCheckout');
    return { managed, steps: [], tools: manual.map((m) => ({ tool: m.tool, status: 'manual', reason: m.reason })), manual };
  }
  const steps = [];
  const tools = [];
  const claude = await findCli('claude', o.env, o.platform, o);
  if (claude) {
    const listing = await claudeListing(claude, o);
    if (listing.includes(ID)) {
      for (const a of COMMANDS.claude) steps.push({ tool: 'claude', file: claude, args: a, cmd: display('claude', a) });
      if (listing.includes(OFFICE_ID)) {
        const a = ['plugin', 'update', OFFICE_ID];
        steps.push({ tool: 'claude', file: claude, args: a, cmd: display('claude', a), optional: true });
      }
      tools.push({ tool: 'claude', status: 'run' });
    } else tools.push({ tool: 'claude', status: 'skipped', reason: 'notInstalled' });
  } else if (claudeInstalledOnDisk(o.pluginRoot, o.env)) tools.push({ tool: 'claude', status: 'manual', reason: 'cliNotFound' });
  else tools.push({ tool: 'claude', status: 'skipped', reason: 'notInstalled' });
  if (!codexInstalled(o.env)) tools.push({ tool: 'codex', status: 'skipped', reason: 'notInstalled' });
  else {
    const codex = await findCli('codex', o.env, o.platform, o);
    if (codex) {
      for (const a of COMMANDS.codex) steps.push({ tool: 'codex', file: codex, args: a, cmd: display('codex', a) });
      tools.push({ tool: 'codex', status: 'run' });
    } else tools.push({ tool: 'codex', status: 'manual', reason: 'cliNotFound' });
  }
  let manual = [];
  for (const t of tools) if (t.status === 'manual') manual.push(...manualList(t.reason, [t.tool]));
  if (!steps.length && !manual.length) {   // nothing recognised: show the commands rather than nothing
    manual = manualList('notInstalled');
    for (const t of tools) { t.status = 'manual'; t.reason = 'notInstalled'; }
  }
  return { managed, steps, tools, manual };
}

function readVersion(root) {
  for (const f of [path.join(root, '.claude-plugin', 'plugin.json'), path.join(root, '.codex-plugin', 'plugin.json')]) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (typeof v === 'string') return v; } catch { /* next */ }
  }
  return null;
}

const hasCli = (root) => { try { return fs.statSync(path.join(root, 'bin', 'crew.js')).isFile(); } catch { return false; } };

// Where the updated code lives: an installed copy in a version-named cache folder gets a new sibling
// folder, a marketplace clone is updated in place.
function locateNewRoot(pluginRoot) {
  let root;
  try { root = fs.realpathSync(pluginRoot); } catch { root = path.resolve(pluginRoot); }
  const here = path.basename(root);
  if (!parseVersion(here) || !/[\\/]cache[\\/]/.test(root)) return root;
  const parent = path.dirname(root);
  let best = { name: here, dir: root };
  let names = [];
  try { names = fs.readdirSync(parent); } catch { /* keep the current folder */ }
  for (const n of names) {
    const dir = path.join(parent, n);
    if (parseVersion(n) && compareVersions(n, best.name) > 0 && hasCli(dir)) best = { name: n, dir };
  }
  return best.dir;
}

// Starts `board serve` from newRoot on the same port and waits until it owns the state file and answers.
async function launchReplacement(newRoot, port, waitMs = RESTART_WAIT_MS) {
  const board = require('../commands/board');
  const child = board.spawnServe(path.join(newRoot, 'bin', 'crew.js'), port, {});
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !exited) {
    const st = board.readState();
    if (st && st.pid === child.pid && await board.health(st.port)) return { ok: true, pid: child.pid };
    await sleep(150);
  }
  try { child.kill(); } catch { /* already gone */ }
  return { ok: false };
}

// ---------------------------------------------------------------- cross-process lock
const lockFile = () => path.join(paths.home(), 'update.lock');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// -> release function, or null when another update is running.
function acquireLock() {
  fs.mkdirSync(paths.home(), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lockFile(), 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, created: Date.now() })); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(lockFile(), 'utf8')); } catch { /* unreadable: stale */ }
      const stale = !held || !alive(held.pid) || Date.now() - Number(held.created) > LOCK_STALE_MS;
      if (!stale) return null;
      try { fs.unlinkSync(lockFile()); } catch { /* raced */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------- runner
// opts: { pluginRoot, env, platform, stepTimeoutMs, restart(newRoot) -> { ok } }
// status(): { state: idle|running|restarting|manual|done|failed, current, steps, manual, error, new_version, restart_command }
function createRunner(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const pluginRoot = opts.pluginRoot || path.resolve(__dirname, '..', '..');

  function blank() {
    return { state: 'idle', current: null, steps: [], manual: [], results: [], old_versions: null, error: null, new_version: null, restart_command: RESTART_COMMAND };
  }
  let st = blank();
  let newRootDir = null;
  const status = () => JSON.parse(JSON.stringify(st));

  async function run(release) {
    let held = release;
    const drop = () => { held(); held = () => {}; };
    try {
      const p = await plan({ pluginRoot, env, platform });
      st.manual = p.manual;
      // updated | skipped (not installed) | manual (CLI not found) | failed
      const result = (tool) => { let x = st.results.find((y) => y.tool === tool); if (!x) { x = { tool, status: 'skipped', reason: null }; st.results.push(x); } return x; };
      for (const t of p.tools) Object.assign(result(t.tool), { status: t.status === 'run' ? 'skipped' : t.status, reason: t.reason || null });
      if (!p.steps.length) { st.state = 'manual'; return; }
      let allOk = true;
      for (const s of p.steps) {
        st.current = s.cmd;
        const r = await runCommand(s.file, s.args, { env, platform, timeoutMs: opts.stepTimeoutMs || STEP_TIMEOUT_MS });
        const ok = r.code === 0 && !r.timedOut && !r.error;
        st.steps.push({ tool: s.tool, cmd: s.cmd, ok, code: r.code, timed_out: r.timedOut, output: r.output || r.error || '' });
        if (s.optional) continue;   // a failed add-on update does not stop the plugin; its page then says it needs updating
        if (!ok) { allOk = false; Object.assign(result(s.tool), { status: 'failed', reason: null }); break; }
        result(s.tool).status = 'updated';
      }
      // a tool that was planned but never reached because an earlier command failed did not update either
      if (!allOk) for (const s of p.steps) { const x = result(s.tool); if (x.status === 'skipped') Object.assign(x, { status: 'failed', reason: 'notReached' }); }
      st.current = null;
      if (!allOk) { st.state = 'failed'; st.error = 'update.stepFailed'; return; }
      const newRoot = locateNewRoot(pluginRoot);
      newRootDir = newRoot;
      st.new_version = readVersion(newRoot);
      try { st.old_versions = cleanup.scan({ dirs: configDirs(env), pluginRoot }); } catch { st.old_versions = null; }
      if (!opts.restart) { st.state = 'done'; return; }
      if (!hasCli(newRoot)) { st.state = 'failed'; st.error = 'update.noNewRoot'; return; }
      st.state = 'restarting';
      drop();
      const r = await opts.restart(newRoot);
      if (!r || !r.ok) { st.state = 'failed'; st.error = 'update.restartFailed'; }
    } catch {
      st.state = 'failed';
      st.current = null;
      st.error = 'update.internal';
    } finally {
      drop();
    }
  }

  // -> { started: false } when an update is already running, else { started: true, done: Promise }.
  function start() {
    if (st.state === 'running' || st.state === 'restarting') return { started: false };
    const release = acquireLock();
    if (!release) return { started: false };
    st = blank();
    st.state = 'running';
    return { started: true, done: run(release) };
  }

  return { start, status, newRoot: () => newRootDir };
}

module.exports = {
  createRunner, plan, runCommand, isManaged, locateNewRoot, readVersion, launchReplacement, findCli, findCodex, codexInstalled,
  configDirs, manualList, COMMANDS, RESTART_COMMAND, RESTART_WAIT_MS,
};
