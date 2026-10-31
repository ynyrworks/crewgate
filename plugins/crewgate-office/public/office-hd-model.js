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
    Gauge: Gauge, tooSlow: tooSlow, due: due
  };
}));
