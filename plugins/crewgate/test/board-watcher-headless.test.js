'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createWatcher } = require('../board/watcher');
const { createSessionEnds } = require('../board/session-ends');

h.setupHome();
const iso = (ms) => new Date(ms).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const SID = '0192aaaa-bbbb-cccc-dddd-eeeeffff0001';

function codexLines(payload, last = 'task_complete') {
  const ts = iso(Date.now() - 60 * 1000);
  return [
    { type: 'session_meta', timestamp: ts, payload: { id: SID, cwd: '/tmp/demo', cli_version: '0.0.0', ...payload } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: ts, payload: { type: last } },
  ];
}
function codexOne(payload, last, opts = {}) {
  const root = h.tmpDir('crew-hl-codex-');
  const dir = path.join(root, '2026', '10', '29');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-x-${SID}.jsonl`), jl(codexLines(payload, last)));
  const w = createWatcher({ claudeRoot: null, codexRoot: root, ttlMs: 0, ...opts });
  return w.sessions()[0];
}

test('codex exec (originator codex_exec) with a completed turn is done, not waiting', () => {
  assert.equal(codexOne({ originator: 'codex_exec', source: 'exec' }).status, 'done');
  assert.equal(codexOne({ originator: 'codex_exec', source: 'exec' }, 'turn_aborted').status, 'done');
  assert.equal(codexOne({ source: 'exec' }).status, 'done');
});

test('interactive codex sessions with a completed turn stay waiting', () => {
  assert.equal(codexOne({ originator: 'Codex Desktop', source: 'vscode' }).status, 'waiting');
  assert.equal(codexOne({ originator: 'codex_cli_rs', source: 'cli' }).status, 'waiting');
});

test('a codex exec run that finished long ago is done, not idle', () => {
  const root = h.tmpDir('crew-hl-codex-');
  const f = path.join(root, '2026', '10', '29', `rollout-x-${SID}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jl(codexLines({ originator: 'codex_exec', source: 'exec' })));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(f, old, old);
  const lines = codexLines({ originator: 'codex_exec', source: 'exec' }).map((o) => ({ ...o, timestamp: old.toISOString() }));
  fs.writeFileSync(f, jl(lines));
  fs.utimesSync(f, old, old);
  assert.equal(createWatcher({ claudeRoot: null, codexRoot: root, ttlMs: 0 }).sessions()[0].status, 'done');
});

test('a codex exec run that is still working is not forced to done', () => {
  assert.equal(codexOne({ originator: 'codex_exec', source: 'exec' }, 'task_started').status, 'working');
});

test('a session.end event (Codex SessionEnd hook) ends an interactive codex session, keyed by the rollout session id', () => {
  const events = path.join(h.tmpDir('crew-hl-ev-'), 'events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ v: 1, ts: iso(Date.now()), id: '0123456789abcdef', type: 'session.end', src: 'hook', session: SID, task: null, agent: null, data: {} }) + '\n');
  const ends = createSessionEnds(() => [events]);
  const row = codexOne({ originator: 'Codex Desktop', source: 'vscode' }, 'task_complete', { sessionEnds: ends });
  assert.equal(row.session, SID);
  assert.equal(row.status, 'done');
});

function claudeOne(entrypoint, stop) {
  const root = h.tmpDir('crew-hl-claude-');
  const ts = Date.now() - 60 * 1000;
  const f = path.join(root, 'proj', 'sess-1.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jl([
    { type: 'user', cwd: '/tmp/demo', entrypoint, timestamp: iso(ts - 1000), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', cwd: '/tmp/demo', entrypoint, timestamp: iso(ts), message: { role: 'assistant', model: 'm', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } },
  ]));
  return createWatcher({ claudeRoot: root, codexRoot: null, ttlMs: 0 }).sessions()[0];
}

test('headless claude -p (entrypoint sdk-cli) whose turn ended is done; interactive entrypoints wait', () => {
  assert.equal(claudeOne('sdk-cli', 'end_turn').status, 'done');
  assert.equal(claudeOne('cli', 'end_turn').status, 'waiting');
  assert.equal(claudeOne('claude-desktop', 'end_turn').status, 'waiting');
});
