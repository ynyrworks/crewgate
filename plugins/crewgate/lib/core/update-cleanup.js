'use strict';

// Old plugin versions left behind by an update (DESIGN section 10). Claude Code and Codex keep every
// installed version in <config>/plugins/cache/crewgate/crewgate/<version>; open sessions may still use the
// hooks of the version they started with, so nothing is removed unless the user asks.
//   scan({ dirs, pluginRoot })    -> { count, bytes, items: [{ tool, version, bytes }] }
//   cleanup({ dirs, pluginRoot }) -> { removed: [...], kept: [{ tool, version, reason }], freed }
// Only a folder that is a direct child of one of the two cache folders, is named like a version, is strictly
// older than the newest one there and is not the folder the running code lives in is ever removed.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { parseVersion, compareVersions } = require('./update-check');

const TOOLS = ['claude', 'codex'];
const SIZE_LIMIT = 200000;   // entries counted per folder; a bigger tree is reported with what was counted

const cacheDir = (dirs, tool) => path.join(dirs[tool], 'plugins', 'cache', 'crewgate', 'crewgate');
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function folderBytes(dir) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < SIZE_LIMIT) {
    const d = stack.pop();
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      seen++;
      const p = path.join(d, n);
      try {
        const s = fs.lstatSync(p);
        if (s.isDirectory()) stack.push(p);
        else total += s.size;
      } catch { /* vanished */ }
    }
  }
  return total;
}

// Folders that may be removed, per tool: [{ tool, version, dir, base }].
function candidates(dirs, pluginRoot) {
  const running = pluginRoot ? paths.canonical(pluginRoot) : null;
  const out = [];
  for (const tool of TOOLS) {
    if (!dirs || !dirs[tool]) continue;
    const base = cacheDir(dirs, tool);
    // a cache folder that is a link to somewhere else is not touched
    if (!same(paths.canonical(base), cacheDir({ [tool]: paths.canonical(dirs[tool]) }, tool))) continue;
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    const versions = names.filter((n) => parseVersion(n) && n === n.trim() && !/^v/i.test(n));
    if (!versions.length) continue;
    const newest = versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    for (const n of versions) {
      if (compareVersions(n, newest) >= 0) continue;
      const dir = path.join(base, n);
      let st;
      try { st = fs.lstatSync(dir); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const real = paths.canonical(dir);
      if (running && (same(real, running) || !paths.isOutside(path.relative(real, running)))) continue;   // the running code is inside it
      out.push({ tool, version: n, dir, base });
    }
  }
  return out;
}

function scan(o) {
  const items = candidates(o.dirs, o.pluginRoot).map((c) => ({ tool: c.tool, version: c.version, bytes: folderBytes(c.dir) }));
  return { count: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0), items };
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function cleanup(o) {
  const removed = [];
  const kept = [];
  for (const c of candidates(o.dirs, o.pluginRoot)) {
    const baseReal = paths.canonical(c.base);
    const real = paths.canonical(c.dir);
    const rel = path.relative(baseReal, real);
    if (paths.isOutside(rel) || rel === '' || rel.includes(path.sep) || rel !== c.version) {
      kept.push({ tool: c.tool, version: c.version, reason: 'outside' });
      continue;
    }
    const bytes = folderBytes(c.dir);
    try {
      fs.rmSync(c.dir, { recursive: true, force: true, maxRetries: 0 });
      removed.push({ tool: c.tool, version: c.version, bytes });
    } catch (e) {
      kept.push({ tool: c.tool, version: c.version, reason: BUSY.has(e && e.code) ? 'inUse' : 'error' });
    }
  }
  return { removed, kept, freed: removed.reduce((s, i) => s + i.bytes, 0) };
}

module.exports = { scan, cleanup, candidates, cacheDir };
