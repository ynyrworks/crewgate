'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./hooks-helpers');
const { setupHome, makeRepo, tmpDir, hasGit } = require('./helpers');
const sessionjob = require('../lib/hooks/sessionjob');
const priority = require('../lib/hooks/priority');
const config = require('../lib/core/config');
const events = require('../lib/core/events');
const sessionStart = require('../lib/hooks/session-start');

const file0 = () => sessionjob.pidFile('pabcdef0123', 4242);
const WIN = process.platform === 'win32';
const claude = { name: 'claude.exe', args: '' };

test('limits.session_cpu_percent and session_cleanup: defaults and ranges', () => {
  assert.strictEqual(config.DEFAULTS.limits.session_cpu_percent, 60);
  assert.strictEqual(config.DEFAULTS.limits.session_cleanup, 'on');
  const text = (r) => JSON.stringify(r);
  for (const v of [10, 60, 100]) assert.ok(!text(config.validate({ limits: { session_cpu_percent: v } })).includes('session_cpu_percent'));
  for (const v of [9, 101, 'x']) assert.ok(text(config.validate({ limits: { session_cpu_percent: v } })).includes('session_cpu_percent'));
  assert.ok(text(config.validate({ limits: { session_cleanup: 'maybe' } })).includes('session_cleanup'));
});

test('start(): other platforms, a non-Claude parent and a bad cap do nothing', () => {
  setupHome();
  const spawned = [];
  const sp = (...a) => { spawned.push(a); return { pid: 1, unref() {}, on() {} }; };
  assert.strictEqual(sessionjob.start('p1', {}, 4242, { platform: 'linux', describe: () => claude, spawn: sp }), 'not-windows');
  assert.strictEqual(sessionjob.start('p1', {}, 4242, { platform: 'win32', describe: () => ({ name: 'bash.exe', args: '' }), spawn: sp }), 'not-claude');
  assert.strictEqual(sessionjob.start('p1', { session_cpu_percent: 5 }, 4242, { platform: 'win32', describe: () => claude, spawn: sp }), 'bad-cap');
  assert.strictEqual(spawned.length, 0);
});

test('start(): one detached hidden holder per Claude pid, with the settings; a live holder blocks a second', () => {
  const home = setupHome();
  const calls = [];
  const sp = (shell, args, opts) => { calls.push({ shell, args, opts }); return { pid: process.pid, unref() {}, on() {} }; };
  const deps = { platform: 'win32', describe: () => claude, spawn: sp, shell: 'pwsh.exe', wscript: 'C:/Windows/System32/wscript.exe' };
  assert.strictEqual(sessionjob.start('pabcdef0123', { session_cpu_percent: 40, session_cleanup: 'off' }, 4242, deps), 'started');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].opts.detached, calls[0].opts.windowsHide, calls[0].opts.stdio], [true, true, 'ignore']);
  // the command: wscript.exe running the static hidden-run.vbs, then the shell and its arguments; no cmd, no start
  assert.strictEqual(path.win32.basename(calls[0].shell).toLowerCase(), 'wscript.exe');
  assert.deepStrictEqual(calls[0].args.slice(0, 2), ['//B', '//Nologo']);
  assert.strictEqual(path.basename(calls[0].args[2]), 'hidden-run.vbs');
  assert.ok(fs.existsSync(calls[0].args[2]));
  assert.strictEqual(calls[0].args[3], 'pwsh.exe');
  assert.ok(!/cmd|start/i.test(path.win32.basename(calls[0].shell) + calls[0].args.slice(0, 3).join(' ')));
  const a = calls[0].args.slice(4);
  assert.strictEqual(a[a.indexOf('-CapPercent') + 1], '40');
  assert.strictEqual(a[a.indexOf('-Cleanup') + 1], 'off');
  assert.strictEqual(a[a.indexOf('-ClaudePid') + 1], '4242');
  assert.ok(a.includes(home));
  assert.ok(a.includes('-HookStart'));
  // a second start before the holder wrote its pid is refused by the claim; the claim is exclusive
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'already');
  assert.strictEqual(calls.length, 1);
  fs.writeFileSync(sessionjob.pidFile('pabcdef0123', 4242), String(process.pid));  // what the holder does
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'already');
  assert.strictEqual(calls.length, 1);
  // a live holder is found before any process lookup
  fs.writeFileSync(file0(), String(process.pid));
  let looked = 0;
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, { ...deps, describe: () => { looked++; return claude; } }), 'already');
  assert.strictEqual(looked, 0);
  // a dead pid in a claim older than the limit is stale; a fresh one is not
  const file = file0();
  fs.writeFileSync(file, '2147483646');
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'already');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'started');
  assert.strictEqual(calls.length, 2);
  // a spawn that fails right away gives the claim back
  fs.rmSync(file);
  const bad = { ...deps, spawn: () => { throw new Error('boom'); } };
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, bad), 'error');
  assert.ok(!fs.existsSync(file), 'the claim is given back');
  assert.ok(events.read('pabcdef0123', { types: 'session.job.error' }).some((e) => e.data.reason === 'spawn-failed'));
});

test('start(): no wscript.exe means no holder and an event, never another way of starting one', () => {
  const f = H.fixture();
  const sp = () => { throw new Error('must not spawn'); };
  assert.strictEqual(sessionjob.start(f.pid, {}, 4242, { platform: 'win32', describe: () => claude, shell: 'pwsh.exe', wscript: '', spawn: sp }), 'no-wscript');
  assert.ok(events.read(f.pid, { types: 'session.job.error' }).some((e) => e.data.reason === 'no-wscript'));
  assert.ok(!fs.existsSync(sessionjob.pidFile(f.pid, 4242)), 'no claim is left');
  // an argument with a quote is refused (the claim is given back)
  const calls = [];
  const deps = { platform: 'win32', describe: () => claude, shell: 'pwsh.exe', wscript: 'wscript.exe', script: 'a"b.ps1', spawn: (...a) => { calls.push(a); return {}; } };
  assert.strictEqual(sessionjob.start(f.pid, {}, 4243, deps), 'bad-path');
  assert.strictEqual(calls.length, 0);
  assert.ok(!fs.existsSync(sessionjob.pidFile(f.pid, 4243)));
  // a percent sign is refused too: WScript.Shell.Run expands %VAR% in the command line
  calls.length = 0;
  assert.strictEqual(sessionjob.start(f.pid, {}, 4244, { ...deps, script: 'C:/a/%TEMP%/x.ps1' }), 'bad-path');
  assert.strictEqual(calls.length, 0);
  assert.ok(!fs.existsSync(sessionjob.pidFile(f.pid, 4244)));
});

test('hidden-run.vbs: arguments with spaces reach the program intact, and it opens no window', { skip: !WIN || !sessionjob.findWscript(), timeout: 60000 }, async (t) => {
  const dir = tmpDir('crew-vbs-');
  const out = path.join(dir, 'argv.json');
  const js = path.join(dir, 'a b', 'dump.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');
  const vbs = path.join(__dirname, '..', 'scripts', 'hidden-run.vbs');
  const child = spawn(sessionjob.findWscript(), ['//B', '//Nologo', vbs, process.execPath, js, out, 'one two', 'x', 'C:/p q/r s'],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const got = JSON.parse(await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8'), 20000));
  assert.deepStrictEqual(got, ['one two', 'x', 'C:/p q/r s']);
});

test('start(): no PowerShell records an event and does not throw', () => {
  const f = H.fixture();
  const old = process.env.PATH, sr = process.env.SystemRoot;
  process.env.PATH = ''; process.env.SystemRoot = path.join(os.tmpdir(), 'no-such-root');
  try {
    assert.strictEqual(sessionjob.start(f.pid, {}, 4242, { platform: 'win32', describe: () => claude }), 'no-shell');
  } finally { process.env.PATH = old; process.env.SystemRoot = sr; }
  assert.ok(events.read(f.pid, { types: 'session.job.error' }).some((e) => e.data.reason === 'no-powershell'));
});

test('SessionStart calls priority and the session job with the configured values, only in a registered project', { skip: !hasGit() }, () => {
  const f = H.fixture({ config: { limits: { process_priority: 'normal', session_cpu_percent: 35, session_cleanup: 'off' } } });
  const origLower = priority.lower, origStart = sessionjob.start;
  const seen = { lower: [], start: [] };
  priority.lower = (...a) => { seen.lower.push(a); return 'stub'; };
  sessionjob.start = (...a) => { seen.start.push(a); return 'stub'; };
  try {
    sessionStart.run({ session_id: 's-wire', cwd: f.repo, source: 'startup' });
    assert.strictEqual(seen.lower.length, 1);
    assert.strictEqual(seen.lower[0][0], 'normal');
    assert.strictEqual(seen.start.length, 1);
    assert.strictEqual(seen.start[0][0], f.pid);
    assert.strictEqual(seen.start[0][1].session_cpu_percent, 35);
    assert.strictEqual(seen.start[0][1].session_cleanup, 'off');
    // an unregistered repo: neither is called
    seen.lower.length = 0; seen.start.length = 0;
    const other = makeRepo();
    assert.strictEqual(sessionStart.run({ session_id: 's-wire2', cwd: other, source: 'startup' }), null);
    assert.strictEqual(seen.lower.length, 0);
    assert.strictEqual(seen.start.length, 0);
    // a throwing stub never breaks the session
    sessionjob.start = () => { throw new Error('boom'); };
    assert.ok(sessionStart.run({ session_id: 's-wire3', cwd: f.repo, source: 'compact' }));
  } finally { priority.lower = origLower; sessionjob.start = origStart; }
});

// ---- real holder with stand-ins (Windows only, sleeping processes, no load) ----
const HOLDER = path.join(__dirname, '..', 'scripts', 'session-job.ps1');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(150); }
}

// Session stand-in: a sleeping PowerShell (a node parent would not do: libuv puts node's non-detached children in
// a kill-on-close job of their own, so they die with it whatever we do). It waits for a flag file, then starts a
// plain child, a child that starts a detached grandchild, and a "board" (a node with its own child).
function writeStandIns(dir) {
  const w = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const sleeper = w('sleeper.js', 'setTimeout(() => {}, 60000);');
  const binDir = path.join(dir, 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const board = path.join(binDir, 'crew.js');
  fs.writeFileSync(board, `const k = require('child_process').spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[process.argv.length - 1], String(k.pid)); setTimeout(() => {}, 60000);`);
  const det = w('det.js', `const k = require('child_process').spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'ignore', detached: true });
k.unref(); require('fs').writeFileSync(process.argv[2], String(k.pid));`);
  const session = w('session.ps1', `param($flag, $out, $detOut, $boardKid)
while (-not (Test-Path $flag)) { Start-Sleep -Milliseconds 100 }
$node = '${process.execPath}'
$a = Start-Process $node -ArgumentList '"${sleeper}"' -PassThru -WindowStyle Hidden
$d = Start-Process $node -ArgumentList '"${det}"', ('"' + $detOut + '"') -PassThru -WindowStyle Hidden
$b = Start-Process $node -ArgumentList '"${board}"', 'board', 'serve', ('"' + $boardKid + '"') -PassThru -WindowStyle Hidden
Set-Content $out ('{"plain":' + $a.Id + ',"board":' + $b.Id + '}')
Start-Sleep -Seconds 60`);
  return session;
}

async function scenario(t, cleanup, boardFile = 'pid', extraArgs = []) {
  const f = H.fixture();
  const dir = tmpDir('crew-sj-');
  const session = writeStandIns(dir);
  const flag = path.join(dir, 'go'), out = path.join(dir, 'pids.json'), boardKid = path.join(dir, 'kid.txt'), detOut = path.join(dir, 'det.txt');
  const started = [];
  const stop = (pid) => { if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } };
  t.after(() => started.forEach(stop));
  const sess = spawn(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', session, flag, out, detOut, boardKid],
    { stdio: 'ignore', windowsHide: true });
  started.push(sess.pid);
  const pidFile = path.join(dir, 'holder.pid');
  const holder = spawn(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOLDER,
    '-ClaudePid', String(sess.pid), '-ProjectId', f.pid, '-PidFile', pidFile, '-CrewHome', f.home, '-NodeExe', process.execPath,
    '-RecordScript', require.resolve('../lib/hooks/sessionjob'), '-CapPercent', '45', '-Cleanup', cleanup, ...extraArgs],
  { stdio: 'ignore', windowsHide: true, env: process.env });
  holder.unref();
  started.push(holder.pid);
  const job = await until(() => events.read(f.pid, { types: 'session.job' })[0]);
  assert.strictEqual(job.data.assigned, true);
  assert.strictEqual(job.data.cap_read, 45, 'the cap is read back from the job');
  fs.writeFileSync(flag, '1');
  const pids = JSON.parse(await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8')));
  pids.kid = Number(await until(() => fs.existsSync(boardKid) && fs.readFileSync(boardKid, 'utf8')));
  pids.det = Number(await until(() => fs.existsSync(detOut) && fs.readFileSync(detOut, 'utf8')));
  started.push(pids.plain, pids.det, pids.board, pids.kid);
  const bf = path.join(f.home, 'board.json');
  if (boardFile === 'pid') fs.writeFileSync(bf, JSON.stringify({ pid: pids.board, port: 1, started: 'x', alive: 'x' }));
  else if (boardFile === 'corrupt') fs.writeFileSync(bf, '{"pid": 12');
  else if (boardFile === 'nopid') fs.writeFileSync(bf, JSON.stringify({ port: 1 }));
  return { f, pids, sess, holder, pidFile, stop };
}

const realHolder = { skip: !WIN || !sessionjob.findShell(), timeout: 120000 };

test('holder: the session ends, its children go, the board and its child stay, the pid file goes', realHolder, async (t) => {
  const s = await scenario(t, 'on');
  assert.ok(alive(s.pids.plain) && alive(s.pids.det));
  s.stop(s.sess.pid);
  const ev = await until(() => events.read(s.f.pid, { types: 'session.cleanup' })[0]);
  assert.ok(ev.data.stopped >= 2, 'the plain and the detached child (and their console hosts) are stopped');
  assert.ok(ev.data.kept >= 2);
  await until(() => !alive(s.pids.plain) && !alive(s.pids.det));
  assert.ok(alive(s.pids.board) && alive(s.pids.kid), 'the board and its child survive');
  await until(() => !alive(s.holder.pid));
  assert.ok(!fs.existsSync(s.pidFile));
  assert.ok(!JSON.stringify(ev).includes('node'), 'no command lines in the event');
});

test('holder: cleanup off lists and records without stopping', realHolder, async (t) => {
  const s = await scenario(t, 'off');
  s.stop(s.sess.pid);
  const ev = await until(() => events.read(s.f.pid, { types: 'session.cleanup' })[0]);
  assert.strictEqual(ev.data.stopped, 0);
  assert.ok(ev.data.found >= 4);
  assert.ok(alive(s.pids.plain) && alive(s.pids.det));
});

test('holder killed first: the session and its children keep running and nothing is recorded', realHolder, async (t) => {
  const s = await scenario(t, 'on');
  s.stop(s.holder.pid);
  await until(() => !alive(s.holder.pid));
  await sleep(1500);
  assert.ok(alive(s.sess.pid) && alive(s.pids.plain) && alive(s.pids.det) && alive(s.pids.board));
  assert.strictEqual(events.read(s.f.pid, { types: 'session.cleanup' }).length, 0);
});

test('start() launches a real holder through wscript; it records the job and the cleanup, and removes its pid file', realHolder, async (t) => {
  const f = H.fixture();
  const sess = spawn(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore', windowsHide: true });
  const stopSess = () => { if (alive(sess.pid)) { try { process.kill(sess.pid); } catch { /* gone */ } } };
  t.after(stopSess);
  assert.strictEqual(sessionjob.start(f.pid, { session_cpu_percent: 30 }, sess.pid, { describe: () => claude }), 'started');
  const job = await until(() => events.read(f.pid, { types: 'session.job' })[0]);
  assert.deepStrictEqual([job.data.assigned, job.data.cap_read], [true, 30]);
  const file = sessionjob.pidFile(f.pid, sess.pid);
  const holder = Number(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8')));
  t.after(() => { if (alive(holder)) { try { process.kill(holder); } catch { /* gone */ } } });
  assert.strictEqual(sessionjob.start(f.pid, {}, sess.pid, { describe: () => claude }), 'already');
  stopSess();
  await until(() => events.read(f.pid, { types: 'session.cleanup' })[0]);
  await until(() => !alive(holder));
  assert.ok(!fs.existsSync(file));
});

test('holder: a corrupt board.json, or one without a pid, stops nothing and says so', realHolder, async (t) => {
  for (const mode of ['corrupt', 'nopid']) {
    const s = await scenario(t, 'on', mode);
    s.stop(s.sess.pid);
    const ev = await until(() => events.read(s.f.pid, { types: 'session.cleanup' })[0]);
    assert.strictEqual(ev.data.error, 'board-json-unreadable');
    assert.strictEqual(ev.data.stopped, 0);
    await sleep(500);
    assert.ok(alive(s.pids.plain) && alive(s.pids.det) && alive(s.pids.board) && alive(s.pids.kid), mode);
  }
});

test('holder: a missing board.json keeps a board serve command line and its children, and stops the rest', realHolder, async (t) => {
  const s = await scenario(t, 'on', 'missing');
  s.stop(s.sess.pid);
  const ev = await until(() => events.read(s.f.pid, { types: 'session.cleanup' })[0]);
  assert.ok(ev.data.stopped >= 2 && ev.data.kept >= 2 && !ev.data.error, JSON.stringify(ev.data));
  await until(() => !alive(s.pids.plain) && !alive(s.pids.det));
  assert.ok(alive(s.pids.board) && alive(s.pids.kid), 'the board and its child survive without a state file');
  assert.ok(!JSON.stringify(ev).includes('crew.js'), 'no command lines in the event');
});

test('holder: refuses a process that started after the hook took its pid, and caps nothing', realHolder, async (t) => {
  const f = H.fixture();
  const sess = spawn(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore', windowsHide: true });
  const holder = spawn(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOLDER,
    '-ClaudePid', String(sess.pid), '-ProjectId', f.pid, '-PidFile', path.join(f.home, 'h.pid'), '-CrewHome', f.home, '-NodeExe', process.execPath,
    '-RecordScript', require.resolve('../lib/hooks/sessionjob'), '-CapPercent', '45', '-HookStart', '1'], { stdio: 'ignore', windowsHide: true, env: process.env });
  t.after(() => { for (const p of [sess.pid, holder.pid]) if (alive(p)) { try { process.kill(p); } catch { /* gone */ } } });
  const ev = await until(() => events.read(f.pid, { types: 'session.job.error' })[0]);
  assert.strictEqual(ev.data.reason, 'pid-reused');
  await until(() => !alive(holder.pid));
  assert.strictEqual(events.read(f.pid, { types: 'session.job' }).length, 0);
});

// The keep decision, without any window: the real thing would flash one at the user.
test('keep decision: the board, visible windows, board-like processes and all their descendants are kept', { skip: !WIN || !sessionjob.findShell() }, () => {
  const dir = tmpDir('crew-keep-');
  const file = path.join(dir, 'in.json');
  const procs = [
    { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 },          // board and its tree
    { pid: 20, ppid: 1, window: true }, { pid: 21, ppid: 20 },                   // a visible program and its child
    { pid: 30, ppid: 1 }, { pid: 31, ppid: 30 },                                 // background leftovers
    { pid: 40, ppid: 1, boardlike: true }, { pid: 41, ppid: 40 },                // a board by command line
    { pid: 50, ppid: 999 },                                                      // a child whose parent has exited: not kept
  ];
  const run = (board, list) => {
    fs.writeFileSync(file, JSON.stringify({ board, procs: list }));
    const r = require('child_process').spawnSync(sessionjob.findShell(), ['-NoLogo', '-NoProfile', '-File', HOLDER, '-TestKeepFile', file], { encoding: 'utf8', windowsHide: true });
    return JSON.parse(r.stdout.trim());
  };
  assert.deepStrictEqual(run(10, procs.map((p) => ({ ...p, boardlike: false }))), [10, 11, 12, 20, 21]);
  assert.deepStrictEqual(run(10, procs), [10, 11, 12, 20, 21, 40, 41]);   // a board-like command line counts even with a board pid
  assert.deepStrictEqual(run(0, procs), [20, 21, 40, 41]);
  assert.deepStrictEqual(run(0, procs.map((p) => ({ ...p, window: false, boardlike: false }))), []);
});

test('SessionStart looks the parent process up once for the priority step and the session job', { skip: !hasGit() }, () => {
  const f = H.fixture();
  const origDescribe = priority.describe;
  let calls = 0;
  priority.describe = () => { calls++; return { name: 'bash.exe', args: '' }; };
  try { sessionStart.run({ session_id: 's-once', cwd: f.repo, source: 'compact' }); } finally { priority.describe = origDescribe; }
  assert.strictEqual(calls, 1);
});
