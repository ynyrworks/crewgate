'use strict';

// Runs the tests of both plugins and the repo-level test/*.test.js with node --test
// (no shell globbing needed).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

// The node --test flags for this machine. node --test starts availableParallelism() - 1 files at once by
// default (97% CPU on a 32-thread machine); use max(2, cores / 4) instead, CREW_TEST_CONCURRENCY overrides it.
// Node 18 and Node < 20.10 (18 is still in CI) do not know --test-concurrency and would refuse to start.
function supportsConcurrencyFlag(nodeVersion) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function concurrencyFor(cores, env) {
  const asked = Number.parseInt(env && env.CREW_TEST_CONCURRENCY, 10);
  return asked >= 1 ? asked : Math.max(2, Math.floor(cores / 4));
}

function testFlags(cores, nodeVersion, env) {
  if (!supportsConcurrencyFlag(nodeVersion)) return [];
  return [`--test-concurrency=${concurrencyFor(cores, env)}`];
}

// Which way the files are limited: 'flag' (node --test --test-concurrency) or 'pool' (this script starts each file).
// CREW_TEST_RUNNER_MODE=pool forces the pool on a newer Node (for trying it out).
function runnerMode(nodeVersion, env) {
  if (env && env.CREW_TEST_RUNNER_MODE === 'pool') return 'pool';
  return supportsConcurrencyFlag(nodeVersion) ? 'flag' : 'pool';
}

// Runs every file with at most `limit` running at once. startOne(file) -> Promise<{ code, output }>; a rejection
// (file cannot be started) counts as failed. A failed file never stops the others. onDone(file, result) is called as each
// file ends. -> Promise<{ ran, failed: [file], code }>
async function runPool(files, limit, startOne, onDone) {
  const failed = [];
  let next = 0;
  let ran = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      let result;
      try { result = await startOne(file); } catch (e) { result = { code: 1, output: `cannot start ${file}: ${e && e.message}
` }; }
      if (!result || result.code !== 0) failed.push(file);
      ran++;
      try { if (onDone) onDone(file, result || { code: 1, output: '' }); } catch { /* output only */ }
    }
  }
  const n = Math.max(1, Math.min(limit, files.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { ran, failed, code: failed.length ? 1 : 0 };
}

// The real "start one file": node --test <file>, output buffered until the file ends.
function startFile(file) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(process.execPath, ['--test', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, output: Buffer.concat(chunks).toString() }));
  });
}

async function runPoolAndReport(files, limit) {
  const r = await runPool(files, limit, startFile, (file, res) => { process.stdout.write(res.output); });
  console.log(`pool: ${r.ran} files ran, ${r.failed.length} failed${r.failed.length ? ': ' + r.failed.join(', ') : ''}`);
  return r.code;
}

// Which files to run. Arguments name files only for the internal pool call (--pool-worker); otherwise they are
// ignored, as before. CREW_TEST_POOL_FILES (comma separated), read only in pool mode, names files for a trial run.
function selectFiles(argv, env, mode, defaults) {
  if (argv.includes('--pool-worker')) {
    const given = argv.filter((a) => a !== '--pool-worker');
    if (given.length) return given.map((f) => path.resolve(f));
  }
  const listed = mode === 'pool' && env && env.CREW_TEST_POOL_FILES ? env.CREW_TEST_POOL_FILES.split(',').filter(Boolean) : [];
  return listed.length ? listed.map((f) => path.resolve(f)) : defaults;
}

function main() {
  const root = path.join(__dirname, '..');
  const dirs = [path.join(root, 'plugins', 'crewgate', 'test'), path.join(root, 'plugins', 'crewgate-office', 'test'), path.join(root, 'test')];
  const defaults = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f)) : []));
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Below normal priority, set before spawning: the children inherit it.
  try {
    const below = os.constants.priority.PRIORITY_BELOW_NORMAL;
    if (os.getPriority(process.pid) < below) os.setPriority(process.pid, below);   // never raise
  } catch { /* keep the current priority */ }
  const mode = runnerMode(process.versions.node, process.env);
  const files = selectFiles(process.argv.slice(2), process.env, mode, defaults);
  const limit = concurrencyFor(cores, process.env);
  const poolWorker = process.argv.includes('--pool-worker');
  if (!poolWorker) console.log(`test runner: ${limit} files at once (${mode === 'flag' ? '--test-concurrency flag' : 'pool'})`);
  // Pool mode runs inside the one slot too: the slot command is this script again with --pool-worker.
  if (mode === 'pool' && poolWorker) { runPoolAndReport(files, limit).then((code) => process.exit(code), () => process.exit(1)); return; }
  const argv = mode === 'pool' ? [process.execPath, __filename, '--pool-worker', ...files] : [process.execPath, '--test', ...testFlags(cores, process.versions.node, process.env), ...files];
  // One full run at a time on the machine: take a slot first (see lib/core/slots.js). A nested run inside
  // `crew slot run` shares its holder's slot. If the slot code cannot be loaded or fails, the tests run anyway.
  let slots = null;
  try { slots = require(path.join(root, 'plugins', 'crewgate', 'lib', 'core', 'slots')); } catch { /* run without a slot */ }
  if (!slots) {
    if (mode === 'pool') { runPoolAndReport(files, limit).then((code) => process.exit(code), () => process.exit(1)); return; }
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
  }
  slots.run(argv, {
    say: (key, vars) => { try { console.error(require(path.join(root, 'plugins', 'crewgate', 'lib', 'core', 'i18n')).t('en', key, vars)); } catch { /* plain output only */ } },
    onTimeout: ({ waitedSeconds }) => {
      const p = require(path.join(root, 'plugins', 'crewgate', 'lib', 'core', 'project')).findByCwd(process.cwd());
      if (p) require(path.join(root, 'plugins', 'crewgate', 'lib', 'core', 'events')).append(p.id, { type: 'slot.timeout', data: { waited_seconds: waitedSeconds } });
    },
  }).then((code) => process.exit(code), () => process.exit(1));
}

if (require.main === module) main();

module.exports = { testFlags, concurrencyFor, runnerMode, runPool, selectFiles };
