'use strict';

// Test helper (Windows only): watches for new visible console or terminal windows while a test runs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'win-windows.ps1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// watch(shell, dir) -> { stop() -> Promise<string[]>, kill() }; resolves once the watcher has taken its baseline.
// stop() ends the watcher and returns the windows that appeared (each "handle|class"). The watcher is hidden.
async function watch(shell, dir) {
  const stopFile = path.join(dir, 'ww.stop'), readyFile = path.join(dir, 'ww.ready'), out = path.join(dir, 'ww.out');
  for (const f of [stopFile, readyFile, out]) fs.rmSync(f, { force: true });
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-StopFile', stopFile, '-ReadyFile', readyFile, '-Out', out], { stdio: 'ignore', windowsHide: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const kill = () => { if (!exited) { try { process.kill(child.pid); } catch { /* gone */ } } };
  const t0 = Date.now();
  while (!fs.existsSync(readyFile)) {
    if (exited || Date.now() - t0 > 60000) { kill(); throw new Error('the window watcher did not start'); }
    await sleep(100);
  }
  const stop = async () => {
    fs.writeFileSync(stopFile, '1');
    const t1 = Date.now();
    while (!fs.existsSync(out)) {
      if (Date.now() - t1 > 30000) { kill(); throw new Error('the window watcher did not finish'); }
      await sleep(100);
    }
    await sleep(100);
    return fs.readFileSync(out, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  };
  return { stop, kill };
}

module.exports = { watch };
