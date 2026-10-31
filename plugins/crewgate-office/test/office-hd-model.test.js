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

// ---- standing places: read the room's real dressing out of office-hd.js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hdSrc = fs.readFileSync(path.join(__dirname, '../public/office-hd.js'), 'utf8');
const literal = (name) => vm.runInNewContext("(" + hdSrc.match(new RegExp(String.raw`var ${name} = (\[[\s\S]*?\]|\{[\s\S]*?\});`))[1] + ")");
const SIZES = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/art-sizes.json'), 'utf8'));
const SLOTS = literal('SLOTS');
const PROPS = literal('PROPS');
const FILLERS = literal('FILLERS');

// The room as it is drawn when `seated` slots are occupied: the dressing, the fillers of empty desks, the desks in use
function room(seated) {
  const props = PROPS.slice();
  SLOTS.forEach((_, n) => { if (!seated.includes(n)) props.push(...(FILLERS[n] || [])); });
  const desks = seated.map((n) => ({ slot: SLOTS[n], deskArt: n % 2 ? 'desk2' : 'desk' }));
  return { props, desks, ob: H.obstacles(props, SIZES, desks) };
}
const clearOfSeated = (spot, ob) => {
  const u = H.screenU(spot[0], spot[1]);
  const v = H.screenV(spot[0], spot[1]);
  return ob.seated.every((b) => !(u - H.CARD_W / 2 < b[1] && b[0] < u + H.CARD_W / 2 && v < b[3] && b[2] < v + H.CARD_H));
};
const subsets = [];
for (let m = 0; m < 256; m++) subsets.push(SLOTS.map((_, n) => n).filter((n) => m & (1 << n)));

test('card size used for standing places matches the art and the actor scale', () => {
  const widest = Math.max(...Object.keys(SIZES).filter((k) => /^c\d-0$/.test(k)).map((k) => SIZES[k][0]));
  const tallest = Math.max(...Object.keys(SIZES).filter((k) => /^c\d-0$/.test(k)).map((k) => SIZES[k][1]));
  const actor = Number(hdSrc.match(/var ACTOR = ([\d.]+)/)[1]);
  assert.ok(H.CARD_W >= widest * actor / 16, `${H.CARD_W} < ${widest * actor / 16}`);
  assert.ok(H.CARD_H >= tallest * actor / 16, `${H.CARD_H} < ${tallest * actor / 16}`);
});

test('idle characters: for 1 to 8 of them and every mix with seated ones, none hides another or stands in furniture', () => {
  let cases = 0;
  for (const seated of subsets) {
    const { props, desks, ob } = room(seated);
    for (let n = 1; n <= 8 - seated.length; n++) {
      const spots = H.standSpots(n, ob);
      const tag = `seated ${seated} idle ${n}`;
      assert.equal(spots.length, n, `${tag}: only ${spots.length} places`);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) assert.ok(!H.cardsOverlap(spots[i], spots[j]), `${tag}: ${spots[i]} and ${spots[j]} overlap`);
        const [x, z] = spots[i];
        assert.ok(clearOfSeated(spots[i], ob), `${tag}: ${spots[i]} overlaps a seated card`);
        const u = H.screenU(x, z);
        const d = H.depthOf(x, z);
        for (const [art, px, pz, sc] of props) {
          const half = SIZES[art][0] * sc / 32 + H.FOOT_MARGIN;
          const inside = Math.abs(u - H.screenU(px, pz)) < half && Math.abs(d - H.depthOf(px, pz)) < half;
          assert.ok(!inside, `${tag}: ${spots[i]} is inside ${art} at ${px},${pz}`);
        }
        for (const dk of desks) {
          const half = SIZES[dk.deskArt][0] * 0.8 / 32 + H.FOOT_MARGIN;
          const inside = Math.abs(u - H.screenU(dk.slot[0] + 0.25, dk.slot[1] + 0.7)) < half && Math.abs(d - H.depthOf(dk.slot[0] + 0.25, dk.slot[1] + 0.7)) < half;
          assert.ok(!inside, `${tag}: ${spots[i]} is inside a desk`);
        }
      }
      cases++;
    }
  }
  assert.ok(cases > 500, String(cases));
});

test('idle characters sorted by screen depth are separated sideways whenever their cards share a screen height', () => {
  for (const seated of [[], [0, 1, 2, 3], [4, 5, 6, 7], [1, 4, 6]]) {
    const { ob } = room(seated);
    const spots = H.standSpots(8 - seated.length, ob).sort((a, b) => H.depthOf(a[0], a[1]) - H.depthOf(b[0], b[1]));
    spots.forEach((sp) => assert.ok(clearOfSeated(sp, ob), `seated ${seated}: ${sp} overlaps a seated card`));
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const dv = H.screenV(spots[j][0], spots[j][1]) - H.screenV(spots[i][0], spots[i][1]);
        if (dv < H.CARD_H) assert.ok(Math.abs(H.screenU(spots[j][0], spots[j][1]) - H.screenU(spots[i][0], spots[i][1])) >= H.CARD_W, `seated ${seated}: ${spots[i]} / ${spots[j]}`);
      }
    }
  }
});

test('standing places are the same for the same room and stay inside the room', () => {
  const { ob } = room([]);
  assert.deepEqual(H.standSpots(8, ob), H.standSpots(8, ob));
  assert.equal(H.standSpots(8, ob).length, 8);
  H.standSpots(8, ob).forEach(([x, z]) => assert.ok(x >= -8 && x <= 8 && z >= -6 && z <= 6));
});

test('the camera and seat numbers of the model are the ones office-hd.js draws with', () => {
  const m = fs.readFileSync(path.join(__dirname, '../public/office-hd-model.js'), 'utf8');
  assert.match(hdSrc, /camera\.position\.set\(17\.5, 20, 28\.5\)/);
  assert.match(hdSrc, /camera\.lookAt\(-0\.2, 1\.1, -0\.2\)/);
  assert.match(m, /CAM = \{ x: 17\.5, y: 20, z: 28\.5, tx: -0\.2, ty: 1\.1, tz: -0\.2 \}/);
  assert.match(hdSrc, /lift: 2\.05/);
  assert.match(hdSrc, /beside: 1\.0/);
  assert.match(m, /SEAT_BESIDE = 1\.0/);
  assert.match(m, /SEAT_LIFT = 2\.05/);
});
