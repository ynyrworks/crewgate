'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const table = (l) => JSON.parse(read(`i18n/${l}.json`));
const CLI = path.join(__dirname, '..', 'lib', 'i18n');

test('UI string tables have the same keys and no empty values', () => {
  const en = table('en');
  const zh = table('zh-TW');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [k, v] of [...Object.entries(en), ...Object.entries(zh)]) assert.ok(typeof v === 'string' && v.trim(), k);
  // placeholders agree between languages
  for (const k of Object.keys(en)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(en[k]), ph(zh[k]), k);
  }
});

test('every key the UI code asks for exists in both tables', () => {
  const src = read('app.js');
  const en = table('en');
  const keys = new Set();
  for (const m of src.matchAll(/\bt\('([^']+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/empty\('([^']+)'\)/g)) keys.add(m[1]);
  for (const m of src.matchAll(/'(overview|project|task|sessions|usage|settings|work|log|mr|validation|lessons|need|review|config)\.[A-Za-z]+'/g)) keys.add(m[0].slice(1, -1));
  // dynamic families: t('state.' + x), t('handoff.' + x)
  for (const s of ['created', 'dispatched', 'returned', 'reviewing', 'accepted', 'merged', 'cancelled', 'working', 'tool', 'waiting', 'idle', 'done', 'todo', 'doing', 'parked', 'passed', 'failed']) keys.add(`state.${s}`);
  for (const s of ['open', 'accepted', 'cancelled']) keys.add(`handoff.${s}`);
  const missing = [...keys].filter((k) => !k.endsWith('.') && !(k in en));
  assert.deepEqual(missing, []);
});

test('CLI string tables (board) are in sync', () => {
  const en = JSON.parse(fs.readFileSync(path.join(CLI, 'board.en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(CLI, 'board.zh-TW.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('the front end builds DOM nodes only: no innerHTML, eval, inline handlers or external URLs', () => {
  const src = read('app.js');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]style/);
  assert.doesNotMatch(src, /https?:\/\//);
  const html = read('index.html');
  assert.doesNotMatch(html, /\son[a-z]+=|javascript:|<style|\sstyle=/i);
  assert.doesNotMatch(read('app.css'), /@import|url\(\s*['"]?https?:/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="crew-token" content="__CREW_TOKEN__">/);
});

test('settings form is generated from the schema served by the API (every top-level group appears)', () => {
  const config = require('../lib/core/config');
  const tops = new Set(config.SCHEMA.filter((e) => ['string', 'integer', 'number', 'boolean', 'array'].includes(e.type)).map((e) => e.path.split('.')[0]));
  for (const e of config.SCHEMA.concat(config.GLOBAL_SCHEMA)) {
    assert.ok(e.description && e.description.en && e.description['zh-TW'], `${e.path} has both descriptions`);
  }
  assert.ok(tops.has('limits') && tops.has('gates') && tops.has('roles'));
  const src = read('app.js');
  for (const type of ['string', 'integer', 'number', 'boolean', 'array']) assert.ok(src.includes(`'${type}'`), type);
});
