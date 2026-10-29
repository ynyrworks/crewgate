'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const h = require('./board-helpers');

const HOME = h.setupHome();
const empty = h.tmpDir('crew-cli-roots-');
const env = { AGENT_CREW_HOME: HOME, AGENT_CREW_CLAUDE_ROOT: empty, AGENT_CREW_CODEX_ROOT: empty };
const crew = (args) => h.crew(args, empty, env);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test.after(() => { crew(['board', 'stop']); });

test('board lifecycle: start, health, start again, status, stop, status', async () => {
  const port = await freePort();
  assert.equal(crew(['board', 'status']).code, 1, 'not running yet');
  const stopped = crew(['board', 'stop']);
  assert.equal(stopped.code, 0);
  assert.match(stopped.out, /not running/i);

  const s = crew(['board', 'start', '--port', String(port), '--no-open']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, new RegExp(`http://127.0.0.1:${port}/`));
  const health = await h.request(port, { path: '/api/health' });
  assert.equal(health.json.name, 'agent-crew');

  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'board.json'), 'utf8'));
  assert.equal(state.port, port);
  assert.ok(Number.isInteger(state.pid));

  const again = crew(['board', 'start', '--no-open', '--json']);
  assert.equal(again.code, 0, again.err);
  const j = JSON.parse(again.out);
  assert.equal(j.started, false);
  assert.equal(j.port, port);
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'board.json'), 'utf8')).pid, state.pid, 'no second server');

  const st = crew(['board', 'status', '--json']);
  assert.equal(st.code, 0);
  assert.equal(JSON.parse(st.out).running, true);

  const stop = crew(['board', 'stop']);
  assert.equal(stop.code, 0, stop.err);
  await assert.rejects(h.request(port, { path: '/api/health' }));
  assert.equal(fs.existsSync(path.join(HOME, 'board.json')), false);
  assert.equal(crew(['board', 'status']).code, 1);
});

test('start: an explicit busy port fails; the default port searches upwards', async () => {
  const blocker = net.createServer();
  const busy = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  try {
    const r = crew(['board', 'start', '--port', String(busy), '--no-open']);
    assert.equal(r.code, 1);
    assert.match(r.err, /in use/);
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1, port: busy }));
    const s = crew(['board', 'start', '--no-open', '--json']);
    assert.equal(s.code, 0, s.err);
    const j = JSON.parse(s.out);
    assert.ok(j.port > busy && j.port <= busy + 20, `picked ${j.port} for busy ${busy}`);
    assert.equal((await h.request(j.port, { path: '/api/health' })).status, 200);
  } finally {
    crew(['board', 'stop']);
    blocker.close();
    fs.rmSync(path.join(HOME, 'config.json'), { force: true });
  }
});

test('a stale state file (dead process) counts as not running and is cleaned up', () => {
  fs.writeFileSync(path.join(HOME, 'board.json'), JSON.stringify({ pid: 2147483000, port: 65000, started: 'x' }));
  assert.equal(crew(['board', 'status']).code, 1);
  assert.equal(fs.existsSync(path.join(HOME, 'board.json')), false);
});

test('usage errors', () => {
  assert.equal(crew(['board']).code, 2);
  assert.equal(crew(['board', 'frobnicate']).code, 2);
  assert.equal(crew(['board', 'start', '--port', 'abc']).code, 2);
  assert.equal(crew(['board', 'start', '--port', '70000']).code, 2);
  assert.equal(crew(['board', '--help']).code, 0);
});
