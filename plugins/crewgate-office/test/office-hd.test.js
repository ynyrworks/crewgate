'use strict';
// The HD view's files: what it may load, and the rules every page script of the board follows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADDON = path.join(__dirname, '..');
const PUB = path.join(ADDON, 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ADDON, 'office.json'), 'utf8'));
const sizes = JSON.parse(read('art-sizes.json'));
const table = (l) => JSON.parse(fs.readFileSync(path.join(ADDON, '..', 'crewgate', 'board', 'public', 'i18n', `${l}.json`), 'utf8'));

test('every asset office.json lists exists, and every art file is listed', () => {
  for (const a of manifest.assets) assert.ok(fs.existsSync(path.join(PUB, a)), a);
  const listed = new Set(manifest.assets);
  for (const f of fs.readdirSync(PUB).filter((n) => n.startsWith('art-'))) assert.ok(listed.has(f), `${f} is not listed`);
  for (const name of Object.keys(sizes)) assert.ok(listed.has(`art-${name}.png`), name);
});

test('asset names pass the board\'s filter, so none is silently left out', () => {
  const addon = require('../../crewgate/board/office-addon');
  const f = addon.find({ pluginRoot: path.join(ADDON, '..', 'crewgate'), env: { CLAUDE_CONFIG_DIR: PUB, CODEX_HOME: PUB } });
  assert.equal(f.state, 'ok');
  assert.deepEqual(f.assets, manifest.assets);
  assert.equal(manifest.office_api, addon.OFFICE_API);
});

test('all six characters have all standing and seated frames, of one size per kind', () => {
  for (let c = 1; c <= 6; c++) {
    const first = sizes[`c${c}-0`];
    const sit = sizes[`c${c}-6`];
    assert.ok(first && sit, `character ${c}`);
    for (let f = 0; f < 6; f++) assert.deepEqual(sizes[`c${c}-${f}`], first, `c${c}-${f}`);
    for (let f = 6; f < 10; f++) assert.deepEqual(sizes[`c${c}-${f}`], sit, `c${c}-${f}`);
  }
});

test('all art that ships is used by the room, so nobody downloads images nothing shows', () => {
  const src = read('office-hd.js');
  for (const name of Object.keys(sizes)) {
    if (/^c\d-\d$/.test(name)) continue;
    assert.ok(src.includes(`'${name}'`) || src.includes(`tex.${name}`) || src.includes(`sizes.${name}`), `${name} is not used`);
  }
});

test('everything the room places exists in the art', () => {
  const src = read('office-hd.js');
  const used = new Set();
  for (const m of src.matchAll(/\['([a-z]+)', -?[\d.]+, -?[\d.]+, [\d.]+\]/g)) used.add(m[1]);
  for (const m of src.matchAll(/wallPiece\('([a-z]+)'/g)) used.add(m[1]);
  ['floor', 'wall', 'rug', 'desk', 'window-glow'].forEach((n) => used.add(n));
  assert.ok(used.size >= 15, [...used].join());
  for (const n of used) assert.ok(sizes[n], `${n} is not in the art`);
});

test('the HD view keeps the board\'s rules: DOM nodes only, no eval, only its own files over the network', () => {
  for (const f of ['office-hd.js', 'office-hd-model.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]style/, f);
    assert.doesNotMatch(src, /https?:\/\/|XMLHttpRequest|WebSocket|localStorage/, f);
  }
  const hd = read('office-hd.js');
  assert.deepEqual([...hd.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]), ["BASE + 'art-sizes.json'"]);
  assert.deepEqual([...hd.matchAll(/import\(([^)]+)\)/g)].map((m) => m[1]), ["BASE + 'three.module.min.js'"]);
  assert.match(hd, /prefers-reduced-motion/);
  assert.match(hd, /H\.due\(lastDraw, ts\)/, 'drawing is capped');
  assert.match(hd, /canvas\.isConnected/, 'the loop stops with the page');
  assert.doesNotMatch(read('office.css'), /@import|url\(/);
});

test('three.js is present once, unmodified in name, with its licence', () => {
  assert.ok(manifest.assets.includes('three.module.min.js'));
  assert.ok(!manifest.scripts.includes('three.module.min.js'), 'loaded only when the HD view is shown');
  assert.match(fs.readFileSync(path.join(ADDON, 'THREE-LICENSE.txt'), 'utf8'), /MIT License/);
  assert.ok(fs.existsSync(path.join(ADDON, 'ART.md')), 'where the art came from is written down');
});

test('the HD strings exist in both languages and only keys that exist are used', () => {
  const en = table('en');
  const zh = table('zh-TW');
  const used = new Set();
  for (const f of ['office-hd.js']) for (const m of read(f).matchAll(/\bt\('(office\.[A-Za-z]+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 8);
  for (const k of used) { assert.ok(k in en, `en ${k}`); assert.ok(k in zh, `zh-TW ${k}`); }
});

test('the HD view is opt-in: only a stored "hd" shows it, and both languages label it a test version', () => {
  const vm = require('node:vm');
  const run = (stored) => {
    const win = {};
    const doc = { createElement: () => ({ getContext: (k) => (k === 'webgl2' ? {} : null) }) };
    vm.runInNewContext(read('office-hd.js'), { window: win, document: doc, console }, { filename: 'office-hd.js' });
    return win.OfficeHD.wanted({ store: () => stored });
  };
  assert.equal(run(null), false, 'nothing stored: pixel');
  assert.equal(run(''), false);
  assert.equal(run('pixel'), false);
  assert.equal(run('hd'), true);
  assert.match(table('en')['office.viewHd'], /Test version/i);
  assert.match(table('zh-TW')['office.viewHd'], /測試版/);
  assert.ok(table('en')['office.testBadge'] && table('zh-TW')['office.testBadge']);
});

test('the pixel note says why: no WebGL (no switch), too slow, or a load failure, each with its own stored value', () => {
  const vm = require('node:vm');
  const node = (tag) => ({ tag, children: [], className: '', textContent: '', appendChild(c) { this.children.push(c); }, addEventListener() {} });
  const texts = (n) => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean);
  const buttons = (n) => (n.tag === 'button' ? 1 : 0) + n.children.reduce((a, c) => a + buttons(c), 0);
  const load = (webgl) => {
    const win = {};
    const doc = { createElement: (t) => (t === 'canvas' ? { getContext: () => (webgl ? {} : null) } : node(t)) };
    vm.runInNewContext(read('office-hd.js'), { window: win, document: doc, console }, { filename: 'office-hd.js' });
    return win.OfficeHD;
  };
  const ctxOf = (data) => ({ t: (k) => k, store: (k, v) => { if (v === undefined) return data[k]; data[k] = v; }, refresh() {} });
  const none = load(false).pixelNote(ctxOf({}));
  assert.deepEqual(texts(none), ['office.noWebgl']);
  assert.equal(buttons(none), 0, 'no HD switch without WebGL');
  const hd = load(true);
  const slow = {}; const failed = {};
  hd.fallBack(ctxOf(slow), '1');
  hd.fallBack(ctxOf(failed), 'error');
  assert.notEqual(slow['crew.office.auto'], failed['crew.office.auto']);
  assert.ok(texts(hd.pixelNote(ctxOf(slow))).includes('office.slow '));
  assert.ok(texts(hd.pixelNote(ctxOf(failed))).includes('office.loadFailed '));
  assert.equal(buttons(hd.pixelNote(ctxOf(failed))), 1);
  assert.match(read('office-hd.js'), /catch\(function \(\) \{ fallBack\(ctx, 'error'\); \}\)/, 'a load failure is not reported as slow');
  for (const k of ['office.noWebgl', 'office.loadFailed']) assert.ok(table('en')[k] && table('zh-TW')[k], k);
});
