'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/office-hd-model.js');

const row = (id, o = {}) => ({ id, status: 'working', project: 'p1', ...o });
const atDesk = () => 'desk';

test('one room per project; finished sessions are not in any room; waiting is counted, subagents are not', () => {
  const rows = [row('a'), row('b', { project: 'p2', status: 'waiting' }), row('c', { project: 'p2', status: 'waiting', subagent: true }), row('d', { project: 'p3' })];
  const rooms = H.roomsOf(rows, (r) => (r.id === 'd' ? 'out' : 'desk'));
  assert.deepEqual(rooms.map((r) => [r.key, r.rows.length, r.waiting]), [['p1', 1, 0], ['p2', 2, 1]]);
  assert.equal(H.roomsOf([row('x', { project: null })], atDesk)[0].key, '-');
});

test('the chosen room stays; without one, a room that needs the user comes first; a gone room is replaced', () => {
  const rooms = [{ key: 'a', waiting: 0 }, { key: 'b', waiting: 2 }];
  assert.equal(H.pickRoom(rooms, 'a').key, 'a');
  assert.equal(H.pickRoom(rooms, null).key, 'b');
  assert.equal(H.pickRoom(rooms, 'gone').key, 'b');
  assert.equal(H.pickRoom([{ key: 'a', waiting: 0 }], 'gone').key, 'a');
  assert.equal(H.pickRoom([], 'a'), null);
});

test('at most 8 characters: those waiting go first, the rest count as extra', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}`, { status: i >= 8 ? 'waiting' : 'working' }));
  const a = H.assignSeats(null, rows, atDesk);
  assert.equal(Object.keys(a.seats).length, H.MAX_SEATS);
  assert.equal(a.extra, 2);
  assert.ok('s8' in a.seats && 's9' in a.seats);
  assert.deepEqual([...new Set(Object.values(a.seats))].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a seated session keeps its desk when others come and go', () => {
  const first = H.assignSeats(null, [row('a'), row('b'), row('c')], atDesk).seats;
  const next = H.assignSeats(first, [row('c'), row('d')], atDesk).seats;
  assert.equal(next.c, first.c);
  assert.notEqual(next.d, next.c);
});

test('lounge sessions rest instead of taking a desk, and still count towards the limit', () => {
  const a = H.assignSeats(null, [row('a'), row('b', { status: 'idle' })], (r) => (r.id === 'b' ? 'lounge' : 'desk'));
  assert.deepEqual(Object.keys(a.seats), ['a']);
  assert.deepEqual(a.lounge, ['b']);
  assert.equal(a.extra, 0);
});

test('designs differ inside a room while there are enough, and a session keeps its design', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const cast = H.castFor(null, ids);
  assert.equal(new Set(Object.values(cast)).size, H.CAST);
  const more = H.castFor(cast, [...ids, 'g', 'h']);
  ids.forEach((id) => assert.equal(more[id], cast[id]));
  Object.values(more).forEach((c) => assert.ok(c >= 0 && c < H.CAST));
});

test('poses follow the activity', () => {
  assert.deepEqual(H.poseFor({ bubble: 'alert' }, true), { frames: [H.FRAME.sitHand], fps: 0, bubble: 'alert' });
  assert.deepEqual(H.poseFor({ bubble: 'alert' }, false).frames, [H.FRAME.hand], 'someone resting stands up to wave');
  assert.deepEqual(H.poseFor({ typing: true, fast: true, bubble: 'speech' }, true), { frames: [H.FRAME.sitA, H.FRAME.sitB], fps: 7, bubble: 'speech' });
  assert.equal(H.poseFor({ typing: true, bubble: null }, true).fps, 4);
  assert.deepEqual(H.poseFor({ bubble: 'think' }, true).frames, [H.FRAME.sit]);
  assert.deepEqual(H.poseFor({ bubble: 'think' }, false).frames, [H.FRAME.stand]);
  assert.equal(H.poseFor({ bubble: 'think' }, true).bubble, 'dots');
  assert.equal(H.poseFor({ bubble: null }, false).bubble, null);
});

test('the frame gauge skips the settling time and answers once', () => {
  const g = new H.Gauge(0);
  let answer = null;
  let answers = 0;
  for (let t = 0; t <= H.SETTLE_MS + H.MEASURE_MS + 100; t += 100) { const v = g.tick(t); if (v !== null) { answer = v; answers++; } }
  assert.equal(answers, 1);
  assert.ok(Math.abs(answer - 10) < 0.01, String(answer));
  assert.equal(H.tooSlow(answer), true);
  assert.equal(H.tooSlow(30), false);
  assert.equal(H.tooSlow(H.SLOW_FPS), false);
});

test('drawing is capped: a 120 Hz display draws every 4th frame or so, never faster than the cap', () => {
  let last = -1000;
  let drawn = 0;
  for (let t = 0; t < 1000; t += 1000 / 120) if (H.due(last, t)) { last = t; drawn++; }
  assert.ok(drawn <= H.CAP_FPS + 1 && drawn >= 24, String(drawn));
  last = -1000;
  drawn = 0;
  for (let t = 0; t < 1000; t += 1000 / 60) if (H.due(last, t)) { last = t; drawn++; }
  assert.ok(drawn >= 29 && drawn <= 31, String(drawn));
});
