'use strict';

// Runs the tests of both plugins and the repo-level test/*.test.js with node --test
// (no shell globbing needed).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// The node --test flags for this machine. node --test starts availableParallelism() - 1 files at once by
// default (97% CPU on a 32-thread machine); use max(2, cores / 4) instead, CREW_TEST_CONCURRENCY overrides it.
// Node 18 and Node < 20.10 (18 is still in CI) do not know --test-concurrency and would refuse to start.
function testFlags(cores, nodeVersion, env) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  if (!(major > 20 || (major === 20 && minor >= 10))) return [];
  const asked = Number.parseInt(env && env.CREW_TEST_CONCURRENCY, 10);
  const concurrency = asked >= 1 ? asked : Math.max(2, Math.floor(cores / 4));
  return [`--test-concurrency=${concurrency}`];
}

function main() {
  const root = path.join(__dirname, '..');
  const dirs = [path.join(root, 'plugins', 'crewgate', 'test'), path.join(root, 'plugins', 'crewgate-office', 'test'), path.join(root, 'test')];
  const files = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f)) : []));
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Below normal priority, set before spawning: the children inherit it.
  try {
    const below = os.constants.priority.PRIORITY_BELOW_NORMAL;
    if (os.getPriority(process.pid) < below) os.setPriority(process.pid, below);   // never raise
  } catch { /* keep the current priority */ }
  const r = spawnSync(process.execPath, ['--test', ...testFlags(cores, process.versions.node, process.env), ...files], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

if (require.main === module) main();

module.exports = { testFlags };
