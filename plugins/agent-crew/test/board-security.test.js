'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');

let board;
let port;
let token;
test.before(async () => {
  const empty = h.tmpDir('crew-empty-');
  board = createBoard({ claudeRoot: empty, codexRoot: empty });
  port = await board.listen(0);
  token = await h.tokenOf(port);
});
test.after(() => board.close());

test('health answers with the exact shape crew doctor relies on', async () => {
  const r = await h.request(port, { path: '/api/health' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.name, 'agent-crew');
  assert.equal(typeof r.json.version, 'string');
});

test('binds to loopback only', () => {
  assert.equal(board.server.address().address, '127.0.0.1');
});

test('Host allow-list: other hosts are refused (DNS rebinding), localhost and [::1] names pass', async () => {
  for (const host of ['evil.example', `127.0.0.1:${port + 1}`, 'localhost', `192.0.2.7:${port}`]) {
    const r = await h.request(port, { path: '/api/health', host });
    assert.equal(r.status, 403, `host ${JSON.stringify(host)}`);
  }
  assert.equal((await h.request(port, { path: '/api/health', host: `localhost:${port}` })).status, 200);
  assert.equal((await h.request(port, { path: '/api/health', host: `[::1]:${port}` })).status, 200);
});

test('security headers on pages, assets and API; no CORS headers; strict CSP without inline script or style', async () => {
  for (const p of ['/', '/app.js', '/app.css', '/api/health', '/api/overview', '/nope']) {
    const r = await h.request(port, { path: p });
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.ok(!Object.keys(r.headers).some((k) => k.startsWith('access-control-')), p);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  }
  const page = await h.request(port, { path: '/' });
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline script');
  assert.doesNotMatch(page.text, /<style|\sstyle=/i, 'no inline style');
});

test('the token is embedded in the page and differs per process', async () => {
  assert.match(token, /^[0-9a-f]{48}$/);
  const other = createBoard({ claudeRoot: h.tmpDir('c-'), codexRoot: h.tmpDir('x-') });
  const p2 = await other.listen(0);
  try { assert.notEqual(await h.tokenOf(p2), token); } finally { await other.close(); }
});

test('state-changing requests: POST only, JSON only, token required, no foreign Origin', async () => {
  const json = { 'Content-Type': 'application/json' };
  const eq = (r, code) => assert.equal(r.status, code, r.text);
  // wrong method
  eq(await h.request(port, { method: 'PUT', path: '/api/config', body: {}, headers: { ...json, 'X-Crew-Token': token } }), 405);
  eq(await h.request(port, { method: 'DELETE', path: '/api/config', headers: { 'X-Crew-Token': token } }), 405);
  // missing and wrong token
  eq(await h.request(port, { method: 'POST', path: '/api/config', body: { config: {} }, headers: json }), 403);
  eq(await h.post(port, 'f'.repeat(48), '/api/config', { config: {} }), 403);
  eq(await h.post(port, 'short', '/api/config', { config: {} }), 403);
  // not a JSON content type (a form post from another site)
  eq(await h.request(port, { method: 'POST', path: '/api/config', body: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Crew-Token': token } }), 415);
  eq(await h.request(port, { method: 'POST', path: '/api/config', body: '{}', headers: { 'Content-Type': 'text/plain', 'X-Crew-Token': token } }), 415);
  // foreign origin, even with a valid token; cross-site fetch metadata
  eq(await h.post(port, token, '/api/config', { config: {} }, { Origin: 'https://evil.example' }), 403);
  eq(await h.post(port, token, '/api/config', { config: {} }, { Origin: 'null' }), 403);
  eq(await h.post(port, token, '/api/config', { config: {} }, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  eq(await h.request(port, { path: '/api/overview', headers: { Origin: 'https://evil.example' } }), 403);
  // malformed JSON and oversized body
  eq(await h.request(port, { method: 'POST', path: '/api/config', body: '{nope', headers: { ...json, 'X-Crew-Token': token } }), 400);
  const big = JSON.stringify({ config: { x: 'a'.repeat(300 * 1024) } });
  eq(await h.request(port, { method: 'POST', path: '/api/config', body: big, headers: { ...json, 'X-Crew-Token': token } }), 413);
  // same-origin with the token passes the gate (an unknown project is a clean 404)
  eq(await h.post(port, token, '/api/project/p0000000000/need', { text: 'x' }, { Origin: `http://127.0.0.1:${port}` }), 404);
});

test('static files: traversal, encoded traversal, backslashes, NUL, unknown file types are refused', async () => {
  const paths = [
    '/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2f%2e%2e%2fpackage.json', '/i18n/../../server.js',
    '/..\\server.js', '/%5c..%5cserver.js', '/app.js%00.png', '/%00', '/i18n/', '/i18n', '/%zz', '//etc/passwd',
    '/../../../../../../../../windows/win.ini',
  ];
  for (const p of paths) {
    const r = await h.request(port, { path: p });
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.text, /createBoard|\[fonts\]/, p);
  }
  const good = await h.request(port, { path: '/i18n/en.json' });
  assert.equal(good.status, 200);
  assert.match(good.headers['content-type'], /application\/json/);
  assert.equal((await h.request(port, { path: '/app.js' })).status, 200);
  assert.equal((await h.request(port, { method: 'POST', path: '/app.js', body: {}, headers: { 'Content-Type': 'application/json' } })).status, 405);
});
