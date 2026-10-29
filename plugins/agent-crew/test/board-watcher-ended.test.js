'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createWatcher } = require('../board/watcher');
const { createSessionEnds } = require('../board/session-ends');

h.setupHome();
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const CWD = '/tmp/x';
const user = (ts) => ({ type: 'user', cwd: CWD, timestamp: iso(ts), message: { role: 'user', content: 'hi' } });
const asst = (ts) => ({ type: 'assistant', cwd: CWD, timestamp: iso(ts), message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } });

function setup() {
  const claudeRoot = h.tmpDir('crew-e-claude-');
  const events = path.join(h.tmpDir('crew-e-ev-'), 'events.jsonl');
  const ends = createSessionEnds(() => [events]);
  const w = createWatcher({ claudeRoot, codexRoot: null, ttlMs: 0, sessionEnds: ends });
  return { claudeRoot, events, w };
}
function writeSession(root, sid, objs, extra = '') {
  const f = path.join(root, 'proj', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jl(objs) + extra);
  return f;
}
function writeSub(root, sid, name, objs) {
  const f = path.join(root, 'proj', sid, 'subagents', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, jl(objs));
  return f;
}
const endEvent = (sid, ts) => JSON.stringify({ v: 1, ts: iso(ts), id: '0123456789abcdef', type: 'session.end', src: 'hook', session: sid, task: null, agent: null, data: {} }) + '\n';
const byFile = (rows) => rows.map((r) => `${r.subagent ? 'sub' : 'main'}:${r.status}`).sort();

test('rule a: a session.end event newer than the last message makes the session and its subagent done', () => {
  const { claudeRoot, events, w } = setup();
  const t = Date.now() - 2 * MIN;
  writeSession(claudeRoot, 'sess-1', [user(t - 5000), asst(t)]);
  writeSub(claudeRoot, 'sess-1', 'agent-a', [user(t - 4000), asst(t - 3000)]);
  assert.deepEqual(byFile(w.sessions()), ['main:waiting', 'sub:waiting']);
  fs.writeFileSync(events, endEvent('sess-1', t + 1000));
  assert.deepEqual(byFile(w.sessions()), ['main:done', 'sub:done']);
});

test('rule a: an end event older than the last message (resumed session) does not count; other ids are unaffected', () => {
  const { claudeRoot, events, w } = setup();
  const t = Date.now() - 2 * MIN;
  writeSession(claudeRoot, 'sess-1', [user(t - 60000), asst(t)]);
  writeSession(claudeRoot, 'sess-2', [user(t - 5000), asst(t)]);
  fs.writeFileSync(events, endEvent('sess-1', t - 30000));
  const rows = w.sessions();
  assert.deepEqual(byFile(rows), ['main:waiting', 'main:waiting']);
});

test('rule b: a closing record at the tail makes a quiet session done; a following message cancels it', () => {
  const { claudeRoot, w } = setup();
  const t = Date.now() - 10 * MIN;
  const closing = [{ type: 'last-prompt', sessionId: 's' }, { type: 'cost-state', sessionId: 's' }];
  const f = writeSession(claudeRoot, 'sess-1', [user(t - 5000), asst(t), ...closing]);
  fs.utimesSync(f, new Date(t), new Date(t));
  assert.deepEqual(byFile(w.sessions()), ['main:done']);
  // resumed: a message after the closing record
  fs.appendFileSync(f, jl([user(t + 1000)]));
  fs.utimesSync(f, new Date(t + 1000), new Date(t + 1000));
  assert.deepEqual(byFile(w.sessions({ now: t + 2000 })), ['main:working']);
  // just written (a prompt may still follow): not yet closed
  const roots2 = setup();
  const t2 = Date.now() - 10 * 1000;
  writeSession(roots2.claudeRoot, 'sess-2', [user(t2 - 1000), asst(t2), ...closing]);
  assert.deepEqual(byFile(roots2.w.sessions()), ['main:waiting']);
});

test('rule c: idle and done thresholds are configurable', () => {
  const { claudeRoot, w } = setup();
  const f = writeSession(claudeRoot, 'sess-1', [user(Date.now() - 1000), asst(Date.now())]);
  const m = fs.statSync(f).mtimeMs;
  const at = (min, extra = {}) => w.sessions({ now: m + min * MIN, ...extra })[0].status;
  assert.equal(at(20), 'waiting');
  assert.equal(at(31), 'idle');
  assert.equal(at(20, { idleMs: 10 * MIN }), 'idle');
  assert.equal(at(50, { idleMs: 60 * MIN }), 'waiting');
  assert.equal(at(7 * 60), 'done');
  assert.equal(at(3 * 60, { idleMs: 10 * MIN, doneMs: 2 * 60 * MIN }), 'done');
  assert.equal(at(3 * 60, { doneMs: 4 * 60 * MIN, idleMs: 10 * MIN }), 'idle');
});

test('a subagent takes its parent state when the parent is done, and keeps its own otherwise', () => {
  const { claudeRoot, w } = setup();
  const t = Date.now() - 3 * MIN;
  const parent = writeSession(claudeRoot, 'sess-1', [user(t - 9000), asst(t - 6000), { type: 'last-prompt' }]);
  const sub = writeSub(claudeRoot, 'sess-1', 'agent-a', [user(t - 8000), asst(t - 7000)]);
  const other = writeSub(claudeRoot, 'sess-2', 'agent-b', [user(t - 8000), asst(t - 7000)]);
  for (const f of [parent, sub, other]) fs.utimesSync(f, new Date(t), new Date(t));
  const rows = w.sessions().sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(rows.filter((r) => r.status === 'done').length, 2);   // parent + its subagent
  assert.equal(rows.filter((r) => r.status === 'waiting').length, 1);   // the unrelated subagent
});

test('session-ends index: incremental, tolerant of torn lines and rewritten files', () => {
  const dir = h.tmpDir('crew-e-idx-');
  const file = path.join(dir, 'events.jsonl');
  const idx = createSessionEnds(() => [file, path.join(dir, 'missing.jsonl')]);
  idx.refresh();
  assert.equal(idx.get('a'), null);
  fs.writeFileSync(file, endEvent('a', 1000) + '{"type":"session.end","ts":"2026-01-01T00:00:00.000Z","session":"b"');   // torn tail
  idx.refresh();
  assert.equal(idx.get('a'), 1000);
  assert.equal(idx.get('b'), null);
  fs.appendFileSync(file, '}\n' + endEvent('a', 5000) + 'not json\n');
  idx.refresh();
  assert.equal(idx.get('b'), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(idx.get('a'), 5000);
  // unchanged file: no re-read
  const realRead = fs.readSync;
  let reads = 0;
  fs.readSync = (...a) => { reads++; return realRead(...a); };
  try { idx.refresh(); } finally { fs.readSync = realRead; }
  assert.equal(reads, 0);
  // rewritten shorter file: starts over
  fs.writeFileSync(file, endEvent('c', 9000));
  idx.refresh();
  assert.equal(idx.get('c'), 9000);
});
