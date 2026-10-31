'use strict';

// ~/.crewgate/bin/crew.js runs the plugin version that last started a session (or ran `crew init`), so a project's own
// scripts can call the CLI without naming a version folder. Shared by SessionStart, `crew init` and `crew doctor`.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const targetFile = () => path.resolve(__dirname, '..', '..', 'bin', 'crew.js');

function shimText() {
  return `#!/usr/bin/env node\n// Written by crewgate at session start: the CLI of the plugin version that started the last session.\nrequire(${JSON.stringify(targetFile())});\n`;
}

// Writes the shim only when its text changed. Throws on a write failure: callers decide whether that matters.
function write() {
  const text = shimText();
  const file = paths.cliShimFile();
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  if (cur === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  require('./json').saveRaw(file, text);
  return true;
}

// -> { state: 'ok'|'missing'|'stale', file, target? }
function check() {
  const file = paths.cliShimFile();
  let cur;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { return { state: 'missing', file }; }
  const m = /require\((".*")\);/.exec(cur);
  let target = null;
  try { target = m ? JSON.parse(m[1]) : null; } catch { /* unreadable */ }
  if (!target || !fs.existsSync(target)) return { state: 'stale', file, target: target || '?' };
  return { state: 'ok', file, target };
}

module.exports = { write, check, shimText, targetFile };
