(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeHDModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure logic of the HD office (no DOM, no WebGL): which room is shown, who gets a desk, which frames a
  // character uses, and when the machine is too slow for it.
  var MAX_SEATS = 8;      // characters in one room; the rest show as "+N" and stay in the list below
  var CAST = 6;           // character designs in the art
  var CAP_FPS = 30;       // frames drawn per second, whatever the display can do
  var SLOW_FPS = 20;      // below this average the page goes back to the pixel view
  var MEASURE_MS = 3000;  // how long the frame rate is measured
  var SETTLE_MS = 1000;   // first frames are skipped: textures and shaders are still being set up

  var STATUS_RANK = { waiting: 0, tool: 1, working: 2, idle: 3 };

  function hash(str) {
    var h = 2166136261;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  // One room per project. place(row) -> 'desk' | 'lounge' | 'out'; finished sessions have left.
  // -> [{ key, rows, waiting }] in a stable order
  function roomsOf(rows, place) {
    var byKey = {};
    var keys = [];
    rows.forEach(function (r) {
      if (place(r) === 'out') return;
      var key = r.project || '-';
      if (!byKey[key]) { byKey[key] = { key: key, rows: [], waiting: 0 }; keys.push(key); }
      byKey[key].rows.push(r);
      if (r.status === 'waiting' && !r.subagent) byKey[key].waiting++;
    });
    return keys.sort().map(function (k) { return byKey[k]; });
  }

  // The room the user chose while it exists, otherwise one that needs them, otherwise the first.
  function pickRoom(rooms, wanted) {
    var hit = rooms.filter(function (r) { return r.key === wanted; })[0];
    if (hit) return hit;
    return rooms.filter(function (r) { return r.waiting; })[0] || rooms[0] || null;
  }

  // Who is shown when more sessions exist than seats: those waiting for the user first, then busy ones.
  function seatOrder(a, b) {
    var ra = STATUS_RANK[a.status] === undefined ? 2 : STATUS_RANK[a.status];
    var rb = STATUS_RANK[b.status] === undefined ? 2 : STATUS_RANK[b.status];
    return ra - rb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  // assignSeats(prev, rows, place) -> { seats: { id: slot }, lounge: [id], extra }
  // Someone already seated keeps their desk across refreshes; newcomers take the lowest free slot.
  function assignSeats(prev, rows, place) {
    var shown = rows.slice().sort(seatOrder).slice(0, MAX_SEATS);
    var seats = {};
    var taken = {};
    var lounge = [];
    var atDesk = shown.filter(function (r) {
      if (place(r) === 'lounge') { lounge.push(r.id); return false; }
      return true;
    });
    atDesk.forEach(function (r) {
      var was = prev && prev[r.id];
      if (typeof was === 'number' && !taken[was]) { seats[r.id] = was; taken[was] = true; }
    });
    atDesk.forEach(function (r) {
      if (seats[r.id] !== undefined) return;
      for (var s = 0; s < MAX_SEATS; s++) if (!taken[s]) { seats[r.id] = s; taken[s] = true; break; }
    });
    return { seats: seats, lounge: lounge, extra: Math.max(0, rows.length - shown.length) };
  }

  // ---- where idle characters stand
  // The camera of the HD view (office-hd.js keeps the same numbers): a card faces it, so on the screen a floor point
  // (x, z) lands at u = sideways along RIGHT and v = FWD_SIN * depth (farther is higher), and a card of height h
  // covers [v, v + h]. Perspective (22 degrees) is ignored: over the room it changes sizes by a few percent, and
  // CARD_W / CARD_H carry a margin for it.
  var CAM = { x: 17.5, y: 20, z: 28.5, tx: -0.2, ty: 1.1, tz: -0.2 };
  var HORIZ = Math.sqrt(Math.pow(CAM.tx - CAM.x, 2) + Math.pow(CAM.tz - CAM.z, 2));
  var FWD = [(CAM.tx - CAM.x) / HORIZ, (CAM.tz - CAM.z) / HORIZ];   // along the floor, away from the camera
  var RIGHT = [-FWD[1], FWD[0]];                                      // to the right on the screen
  var ELEV = Math.atan2(CAM.y - CAM.ty, HORIZ);
  var CARD_W = 2.0;   // widest standing card: 37.5 art px * 0.82 (ACTOR) / 16 px per unit = 1.92, rounded up
  var CARD_H = 3.2;   // tallest: 62 px * 0.82 / 16 = 3.18
  var FOOT_MARGIN = 0.4;   // half a body between a character and the foot of furniture
  var BOUNDS = { x0: -7.0, x1: 7.0, z0: -5.0, z1: 5.2 };   // where one can stand: inside the walls and the cut edge
  var SEAT_BESIDE = 1.0;   // a seated character sits this far right of the slot (SEAT.beside in office-hd.js)
  var SEAT_LIFT = 2.05;    // and is raised this much (SEAT.lift)
  var STAND_PREFERRED = [[-1.8, 3.3], [2.4, 3.3], [-6.3, 3.2], [6.0, 3.3], [-6.3, -0.6], [6.4, -0.6], [-2.4, -0.4], [2.4, -0.4],
    [-6.2, -3.6], [6.3, -3.0], [-2.4, -3.6], [2.4, -3.6]];

  function screenU(x, z) { return x * RIGHT[0] + z * RIGHT[1]; }
  function depthOf(x, z) { return x * FWD[0] + z * FWD[1]; }
  function screenV(x, z) { return depthOf(x, z) * Math.sin(ELEV); }
  // The card of something standing on the floor at (x, z): [u0, u1, v0, v1]; lift raises it (world units)
  function cardBox(x, z, w, h, lift) {
    var u = screenU(x, z);
    var v = screenV(x, z) + (lift || 0) * Math.cos(ELEV);
    return [u - w / 2, u + w / 2, v, v + h];
  }
  function boxesOverlap(a, b) { return a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3]; }
  // Two standing characters hide each other when their cards overlap on the screen
  function cardsOverlap(a, b) { return boxesOverlap(cardBox(a[0], a[1], CARD_W, CARD_H), cardBox(b[0], b[1], CARD_W, CARD_H)); }

  // What a standing character must keep clear of, from the room's dressing and the desks in use.
  // props: [[art, x, z, scale]] (visible ones), sizes: { art: [w, h] } in art pixels,
  // desks: [{ slot: [x, z], deskArt }] for each occupied seat. -> { feet: [[u, d, hw, hd]], seated: [box] }
  function obstacles(props, sizes, desks) {
    var out = { feet: [], seated: [] };
    props.forEach(function (p) {
      var sz = sizes[p[0]];
      var w = sz[0] * p[3] / 16;
      out.feet.push([screenU(p[1], p[2]), depthOf(p[1], p[2]), w / 2 + FOOT_MARGIN, w / 2 + FOOT_MARGIN]);   // as deep as wide
    });
    (desks || []).forEach(function (d) {
      var sz = sizes[d.deskArt];
      var dx = d.slot[0] + 0.25;
      var dz = d.slot[1] + 0.7;
      out.feet.push([screenU(dx, dz), depthOf(dx, dz), sz[0] * 0.8 / 32 + FOOT_MARGIN, sz[0] * 0.8 / 32 + FOOT_MARGIN]);
      out.seated.push(cardBox(d.slot[0] + SEAT_BESIDE, d.slot[1], CARD_W, 2.7, SEAT_LIFT));   // the person at the desk
    });
    return out;
  }

  function standOk(x, z, taken, ob) {
    if (x < BOUNDS.x0 || x > BOUNDS.x1 || z < BOUNDS.z0 || z > BOUNDS.z1) return false;
    var u = screenU(x, z);
    var d = depthOf(x, z);
    var i;
    for (i = 0; i < ob.feet.length; i++) {
      var f = ob.feet[i];
      if (Math.abs(u - f[0]) < f[2] && Math.abs(d - f[1]) < f[3]) return false;
    }
    var box = cardBox(x, z, CARD_W, CARD_H);
    for (i = 0; i < ob.seated.length; i++) if (boxesOverlap(box, ob.seated[i])) return false;
    for (i = 0; i < taken.length; i++) if (cardsOverlap([x, z], taken[i])) return false;
    return true;
  }

  // standSpots(count, obstacles) -> [[x, z]] for up to `count` idle characters; none hides another, none stands in
  // furniture. The preferred spots come first, so the same people stand in the same places. When the desks in use
  // leave too little room for those, the floor is searched: always take the spot that blocks the fewest others.
  function standSpots(count, ob) {
    var cands = [];
    var i;
    var p;
    for (i = 0; i < STAND_PREFERRED.length; i++) if (standOk(STAND_PREFERRED[i][0], STAND_PREFERRED[i][1], [], ob)) cands.push(STAND_PREFERRED[i]);
    var out = [];
    for (i = 0; i < cands.length && out.length < count; i++) {
      if (standOk(cands[i][0], cands[i][1], out, ob)) out.push(cands[i]);
    }
    if (out.length >= count) return out.map(function (c) { return c.slice(); });
    cands = [];
    for (var z = BOUNDS.z0; z <= BOUNDS.z1 + 1e-9; z += 0.25) {
      for (var x = BOUNDS.x0; x <= BOUNDS.x1 + 1e-9; x += 0.25) {
        p = [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
        if (standOk(p[0], p[1], [], ob)) cands.push(p);
      }
    }
    var near = cands.map(function (c, k) {
      var list = [];
      for (var m = 0; m < cands.length; m++) if (m !== k && cardsOverlap(c, cands[m])) list.push(m);
      return list;
    });
    var alive = cands.map(function () { return true; });
    var left = cands.map(function (c, k) { return near[k].length; });
    out = [];
    while (out.length < count) {
      var best = -1;
      for (i = 0; i < cands.length; i++) if (alive[i] && (best < 0 || left[i] < left[best])) best = i;
      if (best < 0) break;
      out.push(cands[best]);
      alive[best] = false;
      near[best].forEach(function (m) {
        if (!alive[m]) return;
        alive[m] = false;
        near[m].forEach(function (q) { left[q]--; });
      });
    }
    return out.map(function (c) { return c.slice(); });
  }

  // Distinct designs inside one room while there are enough; a session keeps its design across refreshes.
  // -> { id: 0..CAST-1 }
  function castFor(prev, ids) {
    var out = {};
    var used = {};
    ids.forEach(function (id) { if (prev && prev[id] !== undefined) { out[id] = prev[id]; used[prev[id]] = true; } });
    ids.slice().sort().forEach(function (id) {
      if (out[id] !== undefined) return;
      var first = hash(id) % CAST;
      for (var k = 0; k < CAST; k++) {
        var c = (first + k) % CAST;
        if (!used[c]) { out[id] = c; used[c] = true; return; }
      }
      out[id] = first;
    });
    return out;
  }

  var FRAME = { stand: 0, walkA: 1, walkB: 2, hand: 3, typeA: 4, typeB: 5, sit: 6, sitA: 7, sitB: 8, sitHand: 9 };

  // The frames an activity uses, from OfficeModel.animFor(row): { frames, fps, bubble }
  function poseFor(anim, seated) {
    var bubble = anim.bubble === 'alert' ? 'alert' : anim.bubble ? 'dots' : null;
    if (anim.bubble === 'speech') bubble = 'speech';
    if (anim.bubble === 'alert') return { frames: [seated ? FRAME.sitHand : FRAME.hand], fps: 0, bubble: bubble };
    if (anim.typing && seated) return { frames: [FRAME.sitA, FRAME.sitB], fps: anim.fast ? 7 : 4, bubble: bubble };
    return { frames: [seated ? FRAME.sit : FRAME.stand], fps: 0, bubble: bubble };
  }

  // Tracks the frame rate while it is measured. tick(nowMs) -> null while measuring, then the average once.
  function Gauge(startMs) {
    this.start = startMs;
    this.count = 0;
    this.first = 0;
    this.done = false;
  }
  Gauge.prototype.tick = function (nowMs) {
    if (this.done) return null;
    var age = nowMs - this.start;
    if (age < SETTLE_MS) return null;
    if (!this.count) this.first = nowMs;
    this.count++;
    if (age < SETTLE_MS + MEASURE_MS) return null;
    this.done = true;
    var span = nowMs - this.first;
    return span > 0 ? ((this.count - 1) * 1000) / span : 0;
  };
  function tooSlow(fps) { return fps < SLOW_FPS; }

  // Is it time to draw? due(lastMs, nowMs) with a little slack, so a 60 Hz display settles at 30.
  function due(lastMs, nowMs, cap) { return nowMs - lastMs >= 1000 / (cap || CAP_FPS) - 2; }

  return {
    MAX_SEATS: MAX_SEATS, CAST: CAST, CAP_FPS: CAP_FPS, SLOW_FPS: SLOW_FPS, MEASURE_MS: MEASURE_MS, SETTLE_MS: SETTLE_MS, FRAME: FRAME,
    hash: hash, roomsOf: roomsOf, pickRoom: pickRoom, assignSeats: assignSeats, castFor: castFor, poseFor: poseFor,
    Gauge: Gauge, tooSlow: tooSlow, due: due,
    CARD_W: CARD_W, CARD_H: CARD_H, FOOT_MARGIN: FOOT_MARGIN, obstacles: obstacles, standSpots: standSpots, cardsOverlap: cardsOverlap,
    screenU: screenU, depthOf: depthOf, screenV: screenV
  };
}));
