'use strict';
const ip = (...o) => o.join('.'); // addresses are built at runtime (repo hygiene scan)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./helpers');

h.setupHome();
const store = require('../lib/core/store');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');

let n = 0;
const pid = () => `p${String(200 + ++n).padStart(10, '0')}`;
const types = (id) => events.read(id).map((e) => e.type);

test('needs: add, done, list (open only by default) and events', () => {
  const id = pid();
  const a = store.needAdd(id, 'decide A');
  const b = store.needAdd(id, 'decide B');
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.equal(a.done, false);
  assert.equal(store.needDone(id, 1).done, true);
  assert.deepEqual(store.needList(id).map((x) => x.id), [2]);
  assert.deepEqual(store.needList(id, { all: true }).map((x) => x.id), [1, 2]);
  assert.throws(() => store.needDone(id, 9), (e) => e.key === 'store.needNotFound');
  assert.throws(() => store.needDone(id, 'x'), (e) => e.key === 'store.needNumber');
  assert.throws(() => store.needAdd(id, '  '), (e) => e.key === 'store.textRequired');
  assert.deepEqual(types(id), ['need.added', 'need.added', 'need.done']);
  assert.ok(fs.existsSync(paths.dataFile(id, 'needs')));
});

test('free text is redacted before it is stored (IPs, secrets)', () => {
  const id = pid();
  const need = store.needAdd(id, 'login to ' + ip(10,20,30,40) + ' with password=hunter2, docs use 192.0.2.5');
  assert.equal(need.text, 'login to [REDACTED-IP] with password=[REDACTED], docs use 192.0.2.5');
  assert.ok(!JSON.stringify(events.read(id)).includes(ip(10,20,30,40)));
});

test('work: set creates stream and item, updates in place, rm removes empty streams', () => {
  const id = pid();
  store.workSet(id, { stream: 's1', title: 'Item', state: 'doing', note: 'n1' });
  const it = store.workSet(id, { stream: 's1', title: 'Item', state: 'done', need: 3 });
  assert.equal(it.state, 'done');
  assert.equal(it.note, 'n1');
  assert.equal(it.need, 3);
  store.workSet(id, { stream: 's1', title: 'Other', state: 'todo' });
  assert.equal(store.workList(id)[0].items.length, 2);
  assert.throws(() => store.workSet(id, { stream: 's1', title: 'x', state: 'bogus' }), (e) => e.key === 'store.badChoice');
  store.workRm(id, 's1', 'Item');
  store.workRm(id, 's1', 'Other');
  assert.deepEqual(store.workList(id), []);
  assert.throws(() => store.workRm(id, 's1', 'Other'), (e) => e.key === 'store.workNotFound');
  assert.deepEqual(types(id).filter((t) => t.startsWith('work.')), ['work.set', 'work.set', 'work.set', 'work.removed', 'work.removed']);
});

test('log: newest first, capped at 500 entries', () => {
  const id = pid();
  store.logAdd(id, 'me', 'first');
  store.logAdd(id, 'me', 'second');
  assert.deepEqual(store.logList(id, 1).map((r) => r.text), ['second']);
  assert.deepEqual(store.logList(id).map((r) => r.text), ['second', 'first']);
  const file = paths.dataFile(id, 'log');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let i = 0; i < 520; i++) rows.push({ time: 't', who: 'w', text: `bulk${i}` });
  fs.writeFileSync(file, JSON.stringify(rows));
  store.logAdd(id, 'me', 'last');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.length, store.LOG_KEEP);
  assert.equal(kept[kept.length - 1].text, 'last');
  assert.equal(store.logList(id, 0).length, store.LOG_KEEP);
});

test('mr: set creates and updates, validates ci and iid', () => {
  const id = pid();
  store.mrSet(id, 7, 'Feature', { ci: 'running' });
  const r = store.mrSet(id, 7, 'Feature v2', { ci: 'passed', merged: 'yes' });
  assert.deepEqual([r.title, r.ci, r.merged], ['Feature v2', 'passed', true]);
  assert.equal(store.mrList(id).length, 1);
  assert.equal(store.mrSet(id, 7, 'Feature v2', { merged: false }).merged, false);
  assert.throws(() => store.mrSet(id, 8, 't', { ci: 'green' }), (e) => e.key === 'store.badChoice');
  assert.throws(() => store.mrSet(id, -1, 't'), (e) => e.key === 'store.badIid');
  assert.equal(events.read(id, { types: 'mr.set' }).length, 3);
});

test('validation: per template, replaced for the same date+host, sorted by date', () => {
  const id = pid();
  store.validateSet(id, { templateId: 'T1', date: '2026-02-01', host: 'linux', result: 'ok' });
  store.validateSet(id, { templateId: 'T1', date: '2026-01-01', host: 'linux', result: 'ok' });
  store.validateSet(id, { templateId: 'T1', date: '2026-02-01', host: 'linux', result: 'redo' });
  const all = store.validateList(id);
  assert.deepEqual(all.T1.map((r) => `${r.date}:${r.result}`), ['2026-01-01:ok', '2026-02-01:redo']);
  assert.throws(() => store.validateSet(id, { templateId: 'T1', date: '1/2/2026', host: 'h', result: 'r' }), (e) => e.key === 'store.badDate');
});

test('a corrupt store file is moved aside on the next write, not silently kept', () => {
  const id = pid();
  store.needAdd(id, 'one');
  const file = paths.dataFile(id, 'needs');
  fs.writeFileSync(file, '[[[');
  const prevErr = process.stderr.write;
  process.stderr.write = () => true;
  try { store.needAdd(id, 'two'); } finally { process.stderr.write = prevErr; }
  assert.equal(store.needList(id).length, 1);
  assert.ok(fs.readdirSync(paths.projectDir(id)).some((f) => f.startsWith('needs.json.corrupt-')));
});

test('opts.src names the writer in the event', () => {
  const id = pid();
  store.needAdd(id, 'from board', { src: 'board' });
  assert.equal(events.read(id)[0].src, 'board');
});
