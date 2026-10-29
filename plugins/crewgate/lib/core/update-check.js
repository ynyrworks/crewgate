'use strict';

// Update notice: asks GitHub once a day whether a newer crewgate release exists (DESIGN section 10).
// This is the ONLY outbound request crewgate makes, and only while the global config key
// `updates.check` is on. It sends no cookies, no credentials and nothing about the user or their
// projects: a GET with a User-Agent that names the running version.
//   checkState(opts)  -> the cached answer, never touches the network
//   check(opts)       -> asks GitHub when the cache is due (or forced), then returns the answer
// opts: { current, force, now, apiUrl, timeoutMs }. Answer shape: see publicState().
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const paths = require('./paths');
const json = require('./json');
const config = require('./config');

const DEFAULT_API = 'https://api.github.com/repos/ynyrworks/crewgate/releases/latest';
const RELEASES_PAGE = 'https://github.com/ynyrworks/crewgate/releases/tag/';
const REHOOK_MARKER = '<!-- crewgate:rehook -->';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FORCE_MIN_MS = 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;

const cacheFile = () => path.join(paths.home(), 'update-check.json');

// "v1.2.3" -> [1, 2, 3]; anything else (pre-release suffix, missing parts) -> null.
function parseVersion(s) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(s).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// What a newer version means for the user: 'patch' (fix), 'minor' (new features), 'major', or null.
function kindOf(current, latest) {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l || compareVersions(current, latest) >= 0) return null;
  if (l[0] !== c[0]) return 'major';
  if (l[1] !== c[1]) return 'minor';
  return 'patch';
}

// The test hook CREWGATE_UPDATE_URL only accepts the real API host or a loopback address.
function apiUrl(override) {
  const u = override || process.env.CREWGATE_UPDATE_URL || DEFAULT_API;
  try {
    const p = new URL(u);
    if (p.protocol === 'https:' && p.hostname === 'api.github.com') return u;
    if (p.protocol === 'http:' && p.hostname === '127.0.0.1') return u;
  } catch { /* fall through */ }
  return DEFAULT_API;
}

function enabled() {
  try { return config.loadGlobal().config.updates.check !== false; } catch { return true; }
}

// One GET. Resolves { version, rehook } or rejects with an Error whose message names the cause.
function fetchLatest(url, current, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = mod.get(url, {
      headers: { 'User-Agent': `crewgate/${current}`, Accept: 'application/vnd.github+json' },
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(reject, new Error(`HTTP ${res.statusCode}`)); req.destroy(); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { finish(reject, new Error('response too large')); req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let o;
        try { o = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(reject, new Error('bad JSON')); }
        if (!o || typeof o !== 'object' || typeof o.tag_name !== 'string' || !parseVersion(o.tag_name)) return finish(reject, new Error('unexpected release data'));
        if (o.draft === true || o.prerelease === true) return finish(reject, new Error('not a final release'));
        const v = o.tag_name.trim().replace(/^v/, '');
        finish(resolve, { version: v, rehook: typeof o.body === 'string' && o.body.includes(REHOOK_MARKER) });
      });
      res.on('error', (e) => finish(reject, e));
    });
    req.on('error', (e) => finish(reject, e));
    const timer = setTimeout(() => { finish(reject, new Error('timeout')); req.destroy(); }, timeoutMs);
  });
}

function readCache() {
  const r = json.readJson(cacheFile(), {});
  return r.status === 'ok' ? r.data : {};
}

function publicState(current, c, on) {
  if (!on) return { enabled: false, current, latest: null, kind: null, notes_url: null, rehook: false, checked_at: null };
  const latest = typeof c.latest === 'string' && parseVersion(c.latest) ? c.latest : null;
  const kind = latest ? kindOf(current, latest) : null;
  return {
    enabled: true,
    current,
    latest,
    kind,
    notes_url: latest ? `${RELEASES_PAGE}v${latest}` : null,
    rehook: kind !== null && c.rehook === true,
    checked_at: typeof c.checked_at === 'string' ? c.checked_at : null,
  };
}

// Cached answer. Never makes a request.
function checkState(opts = {}) {
  return publicState(opts.current, readCache(), enabled());
}

const inflight = new Map();

// Asks GitHub when due. A failure is cached too and backs off (1 h, 2 h, 4 h ... up to 24 h).
async function check(opts = {}) {
  const on = enabled();
  if (!on) return publicState(opts.current, {}, false);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cache = readCache();
  const last = Date.parse(cache.attempted_at || '') || 0;
  const next = Number(cache.next_check_ms) || 0;
  const due = opts.force ? now - last >= FORCE_MIN_MS : now >= next;
  if (!due) return publicState(opts.current, cache, on);
  const key = cacheFile();
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const entry = { ...cache, attempted_at: new Date(now).toISOString() };
      try {
        const r = await fetchLatest(apiUrl(opts.apiUrl), opts.current, opts.timeoutMs || TIMEOUT_MS);
        Object.assign(entry, { latest: r.version, rehook: r.rehook, checked_at: new Date(now).toISOString(), failures: 0, next_check_ms: now + DAY_MS, error: undefined });
      } catch (e) {
        const failures = (Number(cache.failures) || 0) + 1;
        Object.assign(entry, { failures, next_check_ms: now + Math.min(DAY_MS, HOUR_MS * 2 ** (failures - 1)), error: String(e.message).slice(0, 80) });
      }
      try { json.save(cacheFile(), entry); } catch { /* the notice just checks again next time */ }
      return entry;
    })().finally(() => inflight.delete(key)));
  }
  return publicState(opts.current, await inflight.get(key), on);
}

module.exports = { check, checkState, parseVersion, compareVersions, kindOf, apiUrl, cacheFile, REHOOK_MARKER, DEFAULT_API, DAY_MS };
