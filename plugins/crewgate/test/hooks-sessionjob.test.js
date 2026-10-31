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
  const deps = { platform: 'win32', describe: () => claude, spawn: sp, shell: 'pwsh.exe' };
  assert.strictEqual(sessionjob.start('pabcdef0123', { session_cpu_percent: 40, session_cleanup: 'off' }, 4242, deps), 'started');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].opts.detached, calls[0].opts.windowsHide, calls[0].opts.stdio], [true, true, 'ignore']);
  const a = calls[0].args[3].split(' ').map((x) => x.replace(/"/g, ''));
  assert.strictEqual(calls[0].args[2], '/c');
  assert.ok(calls[0].args[3].startsWith('"start "" /b "pwsh.exe" '));
  assert.strictEqual(a[a.indexOf('-CapPercent') + 1], '40');
  assert.strictEqual(a[a.indexOf('-Cleanup') + 1], 'off');
  assert.strictEqual(a[a.indexOf('-ClaudePid') + 1], '4242');
  assert.ok(a.includes(home));
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'started');   // the holder has not written its pid yet
  fs.writeFileSync(sessionjob.pidFile('pabcdef0123', 4242), String(process.pid));  // what the holder does
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'already');
  assert.strictEqual(calls.length, 2);
  fs.writeFileSync(sessionjob.pidFile('pabcdef0123', 4242), '2147483646');   // a stale file does not block
  assert.strictEqual(sessionjob.start('pabcdef0123', {}, 4242, deps), 'started');
  assert.strictEqual(calls.length, 3);
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
  const board = w('board.js', `const k = require('child_process').spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[2], String(k.pid)); setTimeout(() => {}, 60000);`);
  const det = w('det.js', `const k = require('child_process').spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'ignore', detached: true });
k.unref(); require('fs').writeFileSync(process.argv[2], String(k.pid));`);
  const session = w('session.ps1', `param($flag, $out, $detOut, $boardKid)
while (-not (Test-Path $flag)) { Start-Sleep -Milliseconds 100 }
$node = '${process.execPath}'
$a = Start-Process $node -ArgumentList '"${sleeper}"' -PassThru -WindowStyle Hidden
$d = Start-Process $node -ArgumentList '"${det}"', ('"' + $detOut + '"') -PassThru -WindowStyle Hidden
$b = Start-Process $node -ArgumentList '"${board}"', ('"' + $boardKid + '"') -PassThru -WindowStyle Hidden
Set-Content $out ('{"plain":' + $a.Id + ',"board":' + $b.Id + '}')
Start-Sleep -Seconds 60`);
  return session;
}

async function scenario(t, cleanup) {
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
    '-RecordScript', require.resolve('../lib/hooks/sessionjob'), '-CapPercent', '45', '-Cleanup', cleanup],
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
  fs.writeFileSync(path.join(f.home, 'board.json'), JSON.stringify({ pid: pids.board, port: 1, started: 'x', alive: 'x' }));
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

test('start() launches a real holder through cmd; it records the job and the cleanup, and removes its pid file', realHolder, async (t) => {
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
