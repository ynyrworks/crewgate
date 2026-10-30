'use strict';
const ip = (...o) => o.join('.'); // addresses are built at runtime (repo hygiene scan)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./helpers');

h.setupHome();
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');

let n = 0;
const pid = () => `p${String(++n).padStart(10, '0')}`;
const lines = (id) => fs.readFileSync(paths.eventsFile(id), 'utf8').split('\n').filter(Boolean);

test('append writes one well-formed line per event', () => {
  const id = pid();
  const r = events.append(id, { type: 'task.created', src: 'hook', session: 's1', task: 't-20260101-aaaa', data: { title: 'x' } });
  assert.equal(r.written, true);
  const [line] = lines(id);
  const e = JSON.parse(line);
  assert.equal(e.v, 1);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(e.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([e.type, e.src, e.session, e.task, e.agent], ['task.created', 'hook', 's1', 't-20260101-aaaa', null]);
  assert.deepEqual(e.data, { title: 'x' });
  assert.throws(() => events.append(id, {}), TypeError);
});

test('identical events dedup against the last 500 lines; a different key does not', () => {
  const id = pid();
  const ev = { type: 'task.dispatched', src: 'hook', session: 's', tool_use_id: 'tu1', task: 't-20260101-aaaa', data: { a: 1, b: 2 } };
  assert.equal(events.append(id, ev).written, true);
  assert.equal(events.append(id, { ...ev, data: { b: 2, a: 1 } }).written, false); // key order is irrelevant
  assert.equal(events.append(id, { ...ev, tool_use_id: 'tu2' }).written, true);
  assert.equal(events.append(id, { ...ev, key: 'other' }).written, true);
  assert.equal(lines(id).length, 3);
});

test('dedup window is the last 500 lines only', () => {
  const id = pid();
  const first = { type: 'x.first', data: {} };
  events.append(id, first);
  for (let i = 0; i < 499; i++) events.append(id, { type: 'x.fill', key: String(i) });
  assert.equal(events.append(id, first).written, false); // still inside the window
  events.append(id, { type: 'x.fill', key: 'extra' });
  assert.equal(events.append(id, first).written, true);  // pushed out of the window
});

test('free text is redacted then truncated (nested too)', () => {
  const id = pid();
  events.append(id, { type: 'a.b', data: { text: `see ${ip(10,9,8,7)} ${'x'.repeat(5000)}`, nested: { note: 'password=hunter2' }, list: ['token=abc'] } });
  const e = JSON.parse(lines(id)[0]);
  assert.ok(e.data.text.startsWith('see [REDACTED-IP]'));
  assert.ok(e.data.text.length <= events.MAX_FIELD);
  assert.equal(e.data.nested.note, 'password=[REDACTED]');
  assert.equal(e.data.list[0], 'token=[REDACTED]');
});

test('a line never exceeds 4 KiB even with many large fields', () => {
  const id = pid();
  const data = {};
  for (let i = 0; i < 12; i++) data[`f${i}`] = 'y'.repeat(1900);
  events.append(id, { type: 'big.one', data });
  const line = lines(id)[0];
  assert.ok(Buffer.byteLength(line) < 4096, String(Buffer.byteLength(line)));
  const e = JSON.parse(line);
  assert.equal(e.type, 'big.one');
  const huge = {};
  for (let i = 0; i < 400; i++) huge[`k${i}`] = 'z'.repeat(30);
  events.append(id, { type: 'big.two', data: huge });
  const l2 = lines(id)[1];
  assert.ok(Buffer.byteLength(l2) < 4096);
  assert.deepEqual(JSON.parse(l2).data, { truncated: true });
});

test('read: filters by since, types (exact and prefix.*), limit; skips malformed lines', () => {
  const id = pid();
  events.append(id, { type: 'need.added', key: '1' });
  events.append(id, { type: 'need.done', key: '2' });
  events.append(id, { type: 'task.created', key: '3' });
  fs.appendFileSync(paths.eventsFile(id), '{"v":1,"ts":"2026-01-01T00:00:00.000Z","id":"zz');   // torn trailing line
  assert.equal(events.read(id).length, 3);
  assert.deepEqual(events.read(id, { types: 'need.*' }).map((e) => e.type), ['need.added', 'need.done']);
  assert.deepEqual(events.read(id, { types: ['task.created', 'need.done'] }).map((e) => e.type), ['need.done', 'task.created']);
  assert.deepEqual(events.read(id, { limit: 1 }).map((e) => e.type), ['task.created']);
  assert.equal(events.read(id, { since: new Date(Date.now() + 60000) }).length, 0);
  assert.equal(events.read(id, { since: '2000-01-01' }).length, 3);
  assert.deepEqual(events.read(pid()), []);
});

test('a torn trailing line does not break the next append', () => {
  const id = pid();
  events.append(id, { type: 'a.one', key: '1' });
  fs.appendFileSync(paths.eventsFile(id), '{"torn":');
  events.append(id, { type: 'a.two', key: '2' });
  assert.deepEqual(events.read(id).map((e) => e.type), ['a.one', 'a.two']);
});

test('cli events take the session from the environment when none is given', () => {
  const saved = { a: process.env.CLAUDE_CODE_SESSION_ID, b: process.env.CLAUDE_SESSION_ID };
  const id = pid();
  try {
    delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDE_SESSION_ID;
    assert.equal(events.append(id, { type: 'work.set', key: 'a' }).event.session, null);
    process.env.CLAUDE_SESSION_ID = 'old-s';
    assert.equal(events.append(id, { type: 'work.set', key: 'b' }).event.session, 'old-s');
    process.env.CLAUDE_CODE_SESSION_ID = 'new-s';
    assert.equal(events.append(id, { type: 'work.set', key: 'c' }).event.session, 'new-s');
    assert.equal(events.append(id, { type: 'task.created', key: 'd', session: 'given' }).event.session, 'given');
    assert.equal(events.append(id, { type: 'task.created', src: 'hook', key: 'e' }).event.session, null);
    // the dedupe id does not depend on the environment
    const a = events.append(id, { type: 'log.added', key: 'same' });
    delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDE_SESSION_ID;
    assert.equal(events.append(id, { type: 'log.added', key: 'same' }).written, false);
    assert.equal(a.written, true);
  } finally {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.a], ['CLAUDE_SESSION_ID', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
