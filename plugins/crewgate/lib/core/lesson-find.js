'use strict';

// Plain lookups over recorded lessons (no index): `crew lesson find` and the "make it a check" hint of `crew lesson suggest`.

// One line, newest first; the latest matching entry per key; retired keys left out.
// entries: [{ date, kind, key, text }]; retired: Set of keys; opts: { words, globs, limit }
function find(entries, retired, { words = [], globs = [], limit = 5 } = {}) {
  const ws = words.map((w) => String(w).toLowerCase()).filter(Boolean);
  const gs = globs.map(toRegex);
  const best = new Map();
  entries.forEach((e, i) => {
    if (e.kind === 'retired' || retired.has(e.key)) return;
    const hay = `${e.key} ${e.text}`.toLowerCase();
    const hit = ws.some((w) => hay.includes(w)) || (gs.length > 0 && fileNames(e.text).some((f) => gs.some((g) => matches(g, f))));
    if (!hit) return;
    const cur = best.get(e.key);
    if (!cur || e.date >= cur.e.date) best.set(e.key, { e, i });
  });
  return [...best.values()]
    .sort((a, b) => (a.e.date === b.e.date ? b.i - a.i : a.e.date < b.e.date ? 1 : -1))
    .slice(0, limit).map((x) => ({ key: x.e.key, kind: x.e.kind, date: x.e.date, text: x.e.text.replace(/\s+/g, ' ').trim() }));
}

// Words in the text that look like a file: contain a slash, or end in .ext.
function fileNames(text) {
  const out = [];
  for (const raw of String(text).split(/[\s,;()[\]"'`<>]+/)) {
    const t = raw.replace(/^\.\//, '').replace(/[.:]+$/, '');
    if (t && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t))) out.push(t.replace(/[\\]/g, '/'));
  }
  return out;
}

function toRegex(glob) {
  const g = String(glob).replace(/[\\]/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp(`^${re}$`, 'i'), slash: g.includes('/') };
}

function matches(g, file) {
  return g.re.test(file) || (!g.slash && g.re.test(file.split('/').pop()));
}

// Does the text describe something a test, lint rule or hook could hold: a command, a file pattern, an option,
// a banned API or call? Deliberately loose; a false hint costs little.
const MECHANICAL = [
  /`[^`]+`/,                                                // anything quoted as code
  /(^|\s)--?[a-z][a-z0-9-]+/i,                              // an option
  /\b[A-Za-z_$][\w$.]*\(\)/,                                // a call: foo()
  /\b(npm|npx|git|node|crew|pip|yarn|pnpm|cargo|make|docker)\s+[a-z-]+/i, // a command line
  /(^|[\s(])[\w.*-]*\*[\w.*/-]*/,                           // a glob
  /[\w-]+\/[\w./*-]+|\.[a-z]{1,5}\b(?=[\s,.;:)]|$)/i,       // a path or file extension
  /\b(never use|do not use|don't use|must not use|avoid using|banned|forbidden|deprecated)\b/i,
  /(不要用|不可使用|禁止|不得使用|避免使用|指令|參數|選項)/,
];
const isMechanical = (text) => MECHANICAL.some((re) => re.test(String(text || '')));

module.exports = { find, fileNames, isMechanical };
