'use strict';

// Helpers for the board tests (not a test file itself).
const http = require('http');
const h = require('./helpers');

// request(port, { method, path, headers, body, host }) -> { status, headers, text, json }
function request(port, o = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: o.host === undefined ? `127.0.0.1:${port}` : o.host, ...(o.headers || {}) };
    let payload = o.body;
    if (payload !== undefined && typeof payload !== 'string') payload = JSON.stringify(payload);
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method: o.method || 'GET', path: o.path || '/', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// POST with the page token and JSON content type.
function post(port, token, path, body, extra = {}) {
  return request(port, { method: 'POST', path, body, headers: { 'Content-Type': 'application/json', 'X-Crew-Token': token, ...extra } });
}

// The token is delivered in the served page.
async function tokenOf(port) {
  const r = await request(port, { path: '/' });
  const m = /<meta name="crew-token" content="([0-9a-f]+)">/.exec(r.text);
  return m ? m[1] : null;
}

module.exports = { ...h, request, post, tokenOf };
