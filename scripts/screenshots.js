#!/usr/bin/env node
'use strict';

// Takes the README screenshots of a running board with a locally installed Chromium-based browser
// (Edge or Chrome), headless, through the DevTools protocol. No dependencies; needs Node >= 22
// (global WebSocket). Point it at the demo board, never at a board with real data:
//
//   node scripts/demo-board.js            # prints http://127.0.0.1:<port>/
//   node scripts/screenshots.js http://127.0.0.1:<port>/ [--out docs/images] [--browser <path>] [--only <page>]
//
// Writes <page>-<light|dark>[-zh-TW].png for overview, project, plan, sessions, history, office, usage and settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const url = process.argv[2];
function opt(name, dflt) { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) { console.error('usage: node scripts/screenshots.js http://127.0.0.1:<port>/ [--out dir] [--browser path]'); process.exit(2); }
const origin = url.replace(/\/$/, '');
const out = path.resolve(opt('out', path.join(__dirname, '..', 'docs', 'images')));
const W = 1400;
const MAX_H = 1500;

function findBrowser() {
  const given = opt('browser', process.env.CHROME_PATH);
  if (given) return given;
  const c = process.platform === 'win32'
    ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) { console.error('no Chrome/Edge found; pass --browser <path>'); process.exit(2); }
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crewgate-shots-'));
  const child = spawn(findBrowser(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* not yet */ }
    }
    if (!port) throw new Error('browser did not start');
    let targets = [];
    for (let i = 0; i < 50 && !targets.length; i++) {
      try { targets = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter((t) => t.type === 'page'); } catch { /* retry */ }
      if (!targets.length) await sleep(100);
    }
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

    const project = (await getJson(`${origin}/api/overview`)).projects.find((p) => p.name === 'todo-cli').id;
    const pages = [['overview', '#/'], ['project', `#/p/${project}`], ['plan', `#/p/${project}/plan/todo-cli-0-2`], ['sessions', '#/sessions'], ['history', '#/history'], ['office', '#/office'], ['settings', '#/settings'], ['usage', '#/usage']];
    const only = opt('only', '');
    await send('Page.enable');
    for (const lang of ['en', 'zh-TW']) {
      for (const theme of ['light', 'dark']) {
        for (const [name, hash] of pages) {
          if (only && name !== only) continue;
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
          await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: false });
          await send('Page.navigate', { url: `${origin}/` });
          await sleep(400);
          await evalJs(`localStorage.setItem('crew.lang', '${lang}'); localStorage.removeItem('crew.sessionFilter'); localStorage.removeItem('crew.sessionOpen'); location.hash = '${hash}'; location.reload();`);
          await sleep(500);
          for (let i = 0; i < 40; i++) {
            if (await evalJs("document.body && !/Loading|載入中/.test(document.body.innerText) && document.body.innerText.length > 200")) break;
            await sleep(150);
          }
          await sleep(400);
          const h = Math.min(MAX_H, Math.max(560, await evalJs('document.documentElement.scrollHeight')));
          await send('Emulation.setDeviceMetricsOverride', { width: W, height: h, deviceScaleFactor: 1, mobile: false });
          await sleep(200);
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          const file = path.join(out, `${name}-${theme}${lang === 'en' ? '' : '-zh-TW'}.png`);
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          console.log(`${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
        }
      }
    }
    ws.close();
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
