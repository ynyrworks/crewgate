'use strict';

// HTTP server of the board: 127.0.0.1 only, Host allow-list, no CORS, strict CSP, a per-process
// token for every state-changing request, path-traversal safe static files (DESIGN section 10).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createApi } = require('./api');
const { createUpdateRoutes } = require('./update-routes');
const { normalizeLang } = require('../lib/core/i18n');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;
const TOKEN_HEADER = 'x-crew-token';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

function pluginVersion() {
  const root = path.join(__dirname, '..');
  for (const f of [path.join(root, '.claude-plugin', 'plugin.json'), path.join(root, '..', '..', 'package.json'), path.join(root, 'package.json')]) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (typeof v === 'string') return v; } catch { /* next */ }
  }
  return '0.0.0';
}

function baseHeaders(extra) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function send(res, status, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, baseHeaders({ 'Content-Type': type, 'Content-Length': buf.length, ...extra }));
  res.end(buf);
}

const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
const fail = (res, status, key, message) => sendJson(res, status, { ok: false, error: { key, message } });

// createBoard({ port, host, claudeRoot, codexRoot, version, token }) -> { listen(), close(), token, server, port(), url() }
function createBoard(opts = {}) {
  const host = '127.0.0.1';
  const token = opts.token || crypto.randomBytes(24).toString('hex');
  const version = opts.version || pluginVersion();
  const watcherOpts = { ...(opts.watcher || {}) };
  if (opts.claudeRoot !== undefined) watcherOpts.claudeRoot = opts.claudeRoot;
  if (opts.codexRoot !== undefined) watcherOpts.codexRoot = opts.codexRoot;
  const { createWatcher } = require('./watcher');
  const { createUsage } = require('./usage');
  if (!watcherOpts.sessionEnds) {
    const projects = require('../lib/core/project');
    const paths = require('../lib/core/paths');
    watcherOpts.sessionEnds = require('./session-ends').createSessionEnds(() => projects.list().map((p) => paths.eventsFile(p.id)));
  }
  const api = createApi({ version, watcher: createWatcher(watcherOpts), usage: createUsage(watcherOpts), stats: opts.stats });
  const updates = createUpdateRoutes({ version, pluginRoot: path.join(__dirname, '..'), ...(opts.updates || {}) });
  let boundPort = opts.port || 0;
  let indexHtml = null;

  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);

  function page() {
    if (indexHtml === null) indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return indexHtml.replace('__CREW_TOKEN__', token);
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '/index.html') {
      if (req.method === 'HEAD') return send(res, 200, '', MIME['.html']);
      return send(res, 200, page(), MIME['.html']);
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return fail(res, 404, 'api.notFound', 'Not found'); }
    if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.')) return fail(res, 404, 'api.notFound', 'Not found');
    const file = path.resolve(PUBLIC_DIR, `.${rel}`);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, 'api.notFound', 'Not found');
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type || path.basename(file) === 'index.html') return fail(res, 404, 'api.notFound', 'Not found');
    let data;
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(PUBLIC_DIR) + path.sep)) return fail(res, 404, 'api.notFound', 'Not found');
      data = fs.readFileSync(real);
    } catch { return fail(res, 404, 'api.notFound', 'Not found'); }
    return send(res, 200, req.method === 'HEAD' ? '' : data, type);
  }

  function readBody(req, cb) {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > MAX_BODY) { dead = true; cb(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!dead) cb(null, Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { if (!dead) { dead = true; cb(new Error('read error')); } });
  }

  function onRequest(req, res) {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) fail(res, 500, 'api.internal', 'Internal error'); else res.end();
    }
  }

  function handle(req, res) {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(hostHeader)) return fail(res, 403, 'api.badHost', 'Host not allowed');
    const origin = req.headers.origin;
    const originOk = origin === undefined || origin === `http://${hostHeader}`;
    if (!originOk) return fail(res, 403, 'api.badOrigin', 'Foreign origin');
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'api.badOrigin', 'Foreign origin');

    let url;
    try { url = new URL(req.url, `http://${hostHeader}`); } catch { return fail(res, 400, 'api.badRequest', 'Bad request'); }
    const lang = normalizeLang(req.headers['x-crew-lang']);

    if (url.pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'api.method', 'Method not allowed');
      return sendJson(res, 200, { ok: true, name: 'crewgate', version });
    }

    if (url.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams);
      const isUpdate = url.pathname === '/api/update' || url.pathname.startsWith('/api/update/');
      const internal = () => fail(res, 500, 'api.internal', 'Internal error');
      if (req.method === 'GET') {
        if (isUpdate) return updates.handle({ method: 'GET', path: url.pathname, lang }).then((r) => sendJson(res, r.status, r.data), internal);
        const r = api.handle({ method: 'GET', path: url.pathname, query, lang });
        return sendJson(res, r.status, r.data);
      }
      if (req.method !== 'POST') return fail(res, 405, 'api.method', 'Method not allowed');
      // state-changing request: JSON content type, same origin (checked above), per-process token
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') return fail(res, 415, 'api.badContentType', 'Content-Type must be application/json');
      const given = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return fail(res, 403, 'api.badToken', 'Missing or wrong token');
      return readBody(req, (err, text) => {
        if (err) return fail(res, 413, 'api.tooLarge', 'Request body too large');
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { return fail(res, 400, 'api.badJson', 'Invalid JSON'); }
        if (isUpdate) return updates.handle({ method: 'POST', path: url.pathname, body, lang }).then((r) => sendJson(res, r.status, r.data), internal);
        const r = api.handle({ method: 'POST', path: url.pathname, query, body, lang });
        return sendJson(res, r.status, r.data);
      });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'api.method', 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  }

  const server = http.createServer(onRequest);
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;

  return {
    server,
    token,
    api,
    updates,
    port: () => boundPort,
    url: () => `http://127.0.0.1:${boundPort}/`,
    listen(port = opts.port || 0) {
      return new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
        const onOk = () => { server.removeListener('error', onErr); boundPort = server.address().port; updates.startAuto(); resolve(boundPort); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, host);
      });
    },
    close() {
      updates.stop();
      return new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
    },
  };
}

module.exports = { createBoard, CSP, pluginVersion };
