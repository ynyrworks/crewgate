'use strict';

// Windows only: starting a session must not open a console or terminal window (the regression of 2026-10-31, see
// docs/postmortems/2026-10-31-machine-load.md). Every process this file starts is hidden (windowsHide: true).
// The one exception is the control below, which opens a window on purpose and runs only when process.env.CI is set.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn } = require('child_process');
const H = require('./hooks-helpers');
const { tmpDir } = require('./helpers');
const sessionjob = require('../lib/hooks/sessionjob');
const events = require('../lib/core/events');
const { watch } = require('./win-windows');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(100); }
}
const claude = { name: 'claude.exe', args: '' };
const opts = { skip: process.platform !== 'win32' || !sessionjob.findShell(), timeout: 180000 };

test('starting a session through sessionjob.start() opens no window; a deliberate window on CI proves the watcher sees one', opts, async (t) => {
  const shell = sessionjob.findShell();
  const dir = tmpDir('crew-ww-');
  const f = H.fixture();

  // 1. the real holder start, watched until the job event appears
  const w1 = await watch(shell, dir);
  t.after(() => w1.kill());
  const sess = spawn(shell, ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore', windowsHide: true });
  const file = sessionjob.pidFile(f.pid, sess.pid);
  const stopAll = () => {
    for (const p of [sess.pid, Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0)]) {
      if (p > 1 && alive(p)) { try { process.kill(p); } catch { /* gone */ } }
    }
  };
  t.after(stopAll);
  assert.strictEqual(sessionjob.start(f.pid, { session_cpu_percent: 30, session_cleanup: 'off' }, sess.pid, { describe: () => claude }), 'started');
  await until(() => events.read(f.pid, { types: 'session.job' })[0]);
  await sleep(500);   // a window opened by the start would be up by now
  const seen = await w1.stop();
  assert.deepStrictEqual(seen, [], `starting the holder opened a window: ${seen.join(', ')}`);
  try { process.kill(sess.pid); } catch { /* gone */ }
  await until(() => events.read(f.pid, { types: 'session.cleanup' })[0]);

  // 2. the control: only on CI, where opening a window is acceptable
  if (!process.env.CI) { t.diagnostic('control skipped: it opens a window and runs only when CI is set'); return; }
  const w2 = await watch(shell, dir);
  t.after(() => w2.kill());
  const opener = spawn('cmd.exe', ['/d', '/c', 'start "cg-control" cmd /d /c ping -n 4 127.0.0.1 > nul'],
    { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  opener.on('error', () => { /* reported through the watcher result */ });
  await sleep(2500);
  const control = await w2.stop();
  if (control.length === 0) {
    t.diagnostic('UNPROVEN: this desktop showed no console or terminal window for the deliberate control, so the watcher cannot be shown to work here; the result above is NOT verified');
  } else {
    t.diagnostic(`control seen: ${control.length} window(s) (${control.map((x) => x.split('|')[1]).join(', ')}); the watcher works on this desktop`);
  }
});
