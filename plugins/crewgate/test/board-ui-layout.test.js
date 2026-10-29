'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

test('capped lists: focusable named scroll areas, no cap on phones, count strings in both languages', () => {
  const js = read('app.js');
  const css = read('app.css');
  assert.match(js, /function cap\(label, child, mod\)[\s\S]*tabindex: '0'[\s\S]*role: 'region'[\s\S]*'aria-label': label/);
  assert.match(css, /\.cap \{[^}]*max-height: var\(--cap-h\)[^}]*overflow-y: auto/);
  const phone = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
  assert.match(phone, /\.cap \{ max-height: none;/);
  for (const l of ['en', 'zh-TW']) {
    const tbl = JSON.parse(read(`i18n/${l}.json`));
    assert.ok(tbl['cap.items'] && tbl['cap.items1'], l);
  }
});

test('wide screens: fluid main up to 2400px and more grid columns', () => {
  const css = read('app.css');
  assert.match(css, /main \{[^}]*max-width: 2400px/);
  assert.match(css, /@media \(min-width: 1600px\)/);
  assert.match(css, /@media \(min-width: 2200px\)/);
});
