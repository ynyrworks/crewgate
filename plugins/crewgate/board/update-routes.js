'use strict';

// /api/update* routes. The HTTP layer (server.js) has already checked Host, Origin, content type and
// the per-process token for every POST. Nothing the client sends is used: the check URL and the
// commands to run are fixed (lib/core/update-check.js, lib/core/update-apply.js).
//   GET  /api/update          cached answer { enabled, current, latest, kind, notes_url, rehook, checked_at }
//   POST /api/update/check    ask GitHub now (rate limited), return the answer
//   POST /api/update/apply    start the update in the background (one at a time)
//   GET  /api/update/status   progress of the update
//   GET  /api/update/cleanup  old plugin versions that could be removed { count, bytes, items }
//   POST /api/update/cleanup  remove them (no parameters; never the newest or the running one)
const { t } = require('../lib/core/i18n');
const updateCheck = require('../lib/core/update-check');
const updateApply = require('../lib/core/update-apply');
const updateCleanup = require('../lib/core/update-cleanup');

const TICK_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 3000;

function failure(lang, status, key) {
  return { status, data: { ok: false, error: { key, message: t(lang, key) } } };
}

// opts: { version, auto, apiUrl, timeoutMs, restart, pluginRoot, env, stepTimeoutMs }
function createUpdateRoutes(opts) {
  const current = opts.version;
  const runner = updateApply.createRunner({
    pluginRoot: opts.pluginRoot, env: opts.env, stepTimeoutMs: opts.stepTimeoutMs, restart: opts.restart,
  });
  const checkOpts = (extra) => ({ current, apiUrl: opts.apiUrl, timeoutMs: opts.timeoutMs, ...extra });
  const pluginRoot = opts.pluginRoot || require('path').resolve(__dirname, '..');
  const cleanupOpts = () => ({ dirs: updateApply.configDirs(opts.env || process.env), pluginRoot });
  let timers = [];

  const backgroundCheck = () => { updateCheck.check(checkOpts()).catch(() => { /* the notice is optional */ }); };

  async function handle({ method, path, body, lang }) {
    if (path === '/api/update' && method === 'GET') {
      if (opts.auto) backgroundCheck();
      return { status: 200, data: updateCheck.checkState({ current }) };
    }
    if (path === '/api/update/status' && method === 'GET') return { status: 200, data: { ok: true, ...runner.status() } };
    if (path === '/api/update/check' && method === 'POST') {
      return { status: 200, data: { ok: true, ...await updateCheck.check(checkOpts({ force: true })) } };
    }
    if (path === '/api/update/apply' && method === 'POST') {
      if (body && Object.keys(body).length) return failure(lang, 400, 'api.badRequest');
      const r = runner.start();
      if (!r.started) return failure(lang, 409, 'update.busy');
      r.done.catch(() => { /* recorded in the status */ });
      return { status: 200, data: { ok: true, ...runner.status() } };
    }
    if (path === '/api/update/cleanup' && method === 'GET') return { status: 200, data: { ok: true, ...updateCleanup.scan(cleanupOpts()) } };
    if (path === '/api/update/cleanup' && method === 'POST') {
      if (body && Object.keys(body).length) return failure(lang, 400, 'api.badRequest');
      const state = runner.status().state;
      if (state === 'running' || state === 'restarting') return failure(lang, 409, 'update.busy');
      return { status: 200, data: { ok: true, ...updateCleanup.cleanup(cleanupOpts()) } };
    }
    if (path === '/api/update/cleanup' || path === '/api/update' || path === '/api/update/status' || path === '/api/update/check' || path === '/api/update/apply') {
      return failure(lang, 405, 'api.method');
    }
    return null;
  }

  function startAuto() {
    if (!opts.auto || timers.length) return;
    const first = setTimeout(backgroundCheck, FIRST_DELAY_MS);
    const tick = setInterval(backgroundCheck, TICK_MS);
    for (const x of [first, tick]) if (x.unref) x.unref();
    timers = [first, tick];
  }

  function stop() {
    for (const x of timers) { clearTimeout(x); clearInterval(x); }
    timers = [];
  }

  return { handle, startAuto, stop, runner };
}

module.exports = { createUpdateRoutes };
