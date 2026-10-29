'use strict';

// Every module owns lib/i18n/<module>.en.json and <module>.zh-TW.json; all of them are
// merged into one table per language on first use.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'i18n');
const LANGS = ['en', 'zh-TW'];
let tables = null;

function load() {
  tables = { en: {}, 'zh-TW': {} };
  let names = [];
  try { names = fs.readdirSync(DIR).sort(); } catch { return; }
  for (const n of names) {
    for (const lang of LANGS) {
      if (!n.endsWith(`.${lang}.json`)) continue;
      try { Object.assign(tables[lang], JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'))); } catch { /* skip a broken table */ }
    }
  }
}

function normalizeLang(lang) {
  if (!lang) return 'en';
  const s = String(lang).replace('_', '-').toLowerCase();
  if (s === 'zh-tw' || s === 'zh-hant' || s === 'zh') return 'zh-TW';
  return 'en';
}

// t(lang, key, vars): {name} placeholders are replaced from vars. Falls back to en, then to the key.
function t(lang, key, vars) {
  if (!tables) load();
  const l = normalizeLang(lang);
  let s = tables[l][key];
  if (s === undefined) s = tables.en[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

function reload() { tables = null; }

module.exports = { t, normalizeLang, reload, LANGS };
