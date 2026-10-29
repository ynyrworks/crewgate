'use strict';

// Runs plugins/crewgate/test/*.test.js and the repo-level test/*.test.js with node --test
// (no shell globbing needed).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dirs = [path.join(root, 'plugins', 'crewgate', 'test'), path.join(root, 'test')];
const files = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f)) : []));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
