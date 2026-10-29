(function () {
  'use strict';

  // The Office page: live sessions as a small pixel-art office on <canvas>. Everything is drawn from
  // the sprite data in office-sprites.js; office-model.js decides who sits where and what they do.
  // app.js calls Office.page(data, ctx) and mounts the returned node.
  //
  // World pixels: 1 world px = `scale` CSS px (an integer) = `k` device px. The backing store is room.w * k wide
  // (k = round(scale * devicePixelRatio)) and imageSmoothingEnabled is switched off after every resize.
  var M = window.OfficeModel;
  var SP = window.OfficeSprites;
  if (!M || !SP) return;

  var A = SP.ANIM;
  var CELL = SP.CELL;
  var LNG = SP.LOUNGE;
  var HEAD = SP.HEAD_ROWS;
  var CHW = SP.CHAR_W;
  var CHH = SP.CHAR_H;
  var WALK_SPEED = 38;       // world px per second
  var darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var motionMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  var layoutState = null;    // seats survive refreshes so nobody jumps
  var seen = {};             // id -> { shown, since, bkey, bsince }: when a session last changed state / bubble
  var current = null;        // the scene on screen
  var raf = 0;
  var lastTick = 0;
  var frameMs = A.frameMs;   // grows if drawing gets slow
  var cache = {};
  var actors = {};           // id -> Actor: where each character is and what it is walking to
  var evPrev = null;         // detectEvents state
  var events = [];           // errands waiting for a free character
  var blinks = {};           // id -> { seed, k, next, until }
  var loungeSeats = {};      // room key -> [id|null] per lounge spot

  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function theme() { return darkMq && darkMq.matches ? 'dark' : 'light'; }
  function reduced() { return !!(motionMq && motionMq.matches); }
  function dpr() { return Math.max(1, window.devicePixelRatio || 1); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    var g = c.getContext('2d');
    if (g) g.imageSmoothingEnabled = false;
    return { c: c, g: g };
  }
  function fill(g, color, x, y, w, h, alpha) {
    if (w <= 0 || h <= 0) return;
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 1;
  }
  function rng(seed) {   // small seeded generator: decoration stays the same between frames and refreshes
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function ellFill(g, cx, cy, rx, ry) {
    for (var y = -ry; y <= ry; y++) {
      var w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))) + 0.5);
      g.fillRect(cx - w, cy + y, w * 2, 1);
    }
  }

  // ------------------------------------------------------------------ sprites, baked once per theme
  function bake(rows, colorOf) {
    var o = canvasOf(rows[0].length, rows.length);
    var g = o.g;
    if (!g) return o.c;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < rows[y].length; x++) {
        var ch = rows[y].charAt(x);
        if (ch === '.') continue;
        var col = colorOf(ch);
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    return o.c;
  }
  function sprite(name) {
    var key = theme() + ':' + name;
    if (!cache[key]) {
      var pal = SP.PALETTES[theme()];
      cache[key] = bake(SP.SPRITES[name], function (ch) { return pal[ch]; });
    }
    return cache[key];
  }
  // a character frame: its hair style, hair colour and skin tone, the shirt of its engine, the hat of its role, an accessory
  function character(frame, look) {
    var th = theme();
    var key = th + ':c:' + frame + look.style + look.engine + look.role + look.hair + look.skin + look.acc;
    if (!cache[key]) {
      var pal = SP.PALETTES[th];
      var eng = SP.ENGINES[th][look.engine];
      var hair = SP.HAIR[th][look.hair];
      var skin = SP.SKIN[th][look.skin];
      var role = SP.ROLE_COLORS[th][look.role] || {};
      cache[key] = bake(SP.character(frame, look.style, look.role, look.acc), function (ch) { return eng[ch] || hair[ch] || skin[ch] || role[ch] || pal[ch]; });
    }
    return cache[key];
  }
  // a one-colour copy of a sprite (for the monitor light on a face)
  function tinted(canvas, color) {
    if (canvas._tint && canvas._tint.color === color) return canvas._tint.c;
    var o = canvasOf(canvas.width, canvas.height);
    if (!o.g) return canvas;
    o.g.drawImage(canvas, 0, 0);
    o.g.globalCompositeOperation = 'source-in';
    o.g.fillStyle = color;
    o.g.fillRect(0, 0, canvas.width, canvas.height);
    canvas._tint = { color: color, c: o.c };
    return o.c;
  }
  // soft two-tone ellipse of light (halo, pool, desk glow): a big faint ellipse and a smaller brighter one
  function halo(name, color, w, h, a1, a2) {
    var key = theme() + ':h:' + name;
    if (!cache[key]) {
      var o = canvasOf(w, h);
      if (o.g) {
        o.g.fillStyle = color;
        o.g.globalAlpha = a1; ellFill(o.g, w / 2, h / 2, w / 2 - 0.5, h / 2 - 0.5);
        o.g.globalAlpha = a2; ellFill(o.g, w / 2, h / 2, w * 0.33, h * 0.33);
      }
      cache[key] = o.c;
    }
    return cache[key];
  }
  // soft rounded frame of light around a desk (hover and "waiting for you")
  function deskGlow(color) {
    var key = theme() + ':dg:' + color;
    if (!cache[key]) {
      var w = CELL.w + 6;
      var h = 56;
      var o = canvasOf(w, h);
      if (o.g) {
        o.g.fillStyle = color;
        [[0, 0.12], [1, 0.2], [2, 0.34]].forEach(function (p) {
          o.g.globalAlpha = p[1];
          o.g.fillRect(p[0] + 2, p[0], w - 2 * p[0] - 4, 1); o.g.fillRect(p[0] + 2, h - 1 - p[0], w - 2 * p[0] - 4, 1);
          o.g.fillRect(p[0], p[0] + 2, 1, h - 2 * p[0] - 4); o.g.fillRect(w - 1 - p[0], p[0] + 2, 1, h - 2 * p[0] - 4);
          o.g.fillRect(p[0] + 1, p[0] + 1, 1, 1); o.g.fillRect(w - 2 - p[0], p[0] + 1, 1, 1); o.g.fillRect(p[0] + 1, h - 2 - p[0], 1, 1); o.g.fillRect(w - 2 - p[0], h - 2 - p[0], 1, 1);
        });
      }
      cache[key] = o.c;
    }
    return cache[key];
  }

  // ------------------------------------------------------------------ pixel text: name tags, cork board
  function drawText(g, str, x, y, color) {
    g.fillStyle = color;
    for (var i = 0; i < str.length; i++) {
      var gl = SP.glyph(str.charAt(i));
      if (!gl) continue;
      for (var r = 0; r < gl.length; r++) for (var c = 0; c < gl[r].length; c++) if (gl[r].charAt(c) === '#') g.fillRect(x + i * 6 + c, y + r, 1, 1);
    }
  }
  function printable(s, max) {
    var out = '';
    String(s || '').toUpperCase().split('').forEach(function (ch) { if (SP.glyph(ch) && ch !== ' ' && out.length < max) out += ch; });
    return out;
  }
  var TAGS = { orchestrator: 'LEAD', worker: 'WORK', reviewer: 'REVIEW', refuter: 'REFUTE', other: 'AGENT' };
  function tagCanvas(role) {
    var key = theme() + ':tag:' + role;
    if (!cache[key]) {
      var text = TAGS[role] || TAGS.other;
      var cols = SP.ROLE_COLORS[theme()][role] || { r: SP.PALETTES[theme()].G, R: SP.PALETTES[theme()].D };
      var w = SP.textWidth(text) + 5;
      var o = canvasOf(w, 9);
      var g = o.g;
      if (g) {
        fill(g, cols.R, 1, 0, w - 2, 9); fill(g, cols.R, 0, 1, w, 7);
        fill(g, cols.r, 1, 1, w - 2, 7); fill(g, cols.r, 0, 2, w, 5);
        fill(g, '#ffffff', 2, 1, w - 4, 1, 0.35);
        drawText(g, text, 2, 1, SP.PALETTES[theme()].o);
      }
      cache[key] = o.c;
    }
    return cache[key];
  }

  // ------------------------------------------------------------------ room background (static, baked once per room and theme)
  function mix(a, b, k) { return SP.mixHex(a, b, k); }
  function rug(g, sc, x, y, w, h) {
    fill(g, sc.rug, x + 2, y, w - 4, h); fill(g, sc.rug, x, y + 2, w, h - 4); fill(g, sc.rug, x + 1, y + 1, w - 2, h - 2);
    for (var yy = y + 8, row = 0; yy < y + h - 6; yy += 8, row++) {
      for (var xx = x + 8 + (row % 2) * 4; xx < x + w - 6; xx += 8) { fill(g, sc.rugB, xx - 1, yy, 3, 1); fill(g, sc.rugB, xx, yy - 1, 1, 3); }
    }
    g.fillStyle = sc.rugEdge;
    g.fillRect(x + 2, y, w - 4, 2); g.fillRect(x + 2, y + h - 2, w - 4, 2); g.fillRect(x, y + 2, 2, h - 4); g.fillRect(x + w - 2, y + 2, 2, h - 4);
    g.fillStyle = sc.rugStitch;
    for (var i = 5; i < w - 5; i++) if (i % 3 < 2) { g.fillRect(x + i, y + 4, 1, 1); g.fillRect(x + i, y + h - 5, 1, 1); }
    for (i = 5; i < h - 5; i++) if (i % 3 < 2) { g.fillRect(x + 4, y + i, 1, 1); g.fillRect(x + w - 5, y + i, 1, 1); }
  }

  function windowRects(room) {
    var n = Math.max(1, Math.floor((room.w - 90) / 60));
    var out = [];
    for (var i = 0; i < n; i++) {
      var span = room.w - 34 - 56 - 30;
      out.push({ x: n === 1 ? Math.round((room.w - 30) / 2) : Math.round(34 + i * span / (n - 1)), y: 8, w: 30, h: 24 });
    }
    return out;
  }

  function drawDeskStatic(g, d) {   // an empty desk: baked into the background
    g.drawImage(sprite('shadowChar'), d.x + CELL.chairX - 1, d.y + CELL.chairY + 12);
    g.drawImage(sprite('shadowDesk'), d.x + CELL.shadowX + 2, d.y + CELL.shadowY);
    g.drawImage(sprite('chair'), d.x + CELL.chairX, d.y + CELL.chairY);
    g.drawImage(sprite('desk'), d.x + CELL.deskX, d.y + CELL.deskY);
    g.drawImage(sprite('monitor'), d.x + CELL.monX, d.y + CELL.monY);
    var s = CELL.screen;
    drawScreen(g, d.x + CELL.monX + s.x, d.y + CELL.monY + s.y, 'off', 0, 1, 0);
    g.drawImage(sprite('keyboard'), d.x + CELL.kbX, d.y + CELL.kbY);
    g.drawImage(sprite('mug'), d.x + CELL.mugX, d.y + CELL.mugY);
    g.drawImage(sprite('lampOff'), d.x + CELL.lampX, d.y + CELL.lampY);
  }

  // returns { bg, frame, light, windows, label } for one room
  function drawBackground(room, label) {
    var th = theme();
    var sc = SP.SCENE[th];
    var H = M.WALL_H;
    var bo = canvasOf(room.w, room.h);
    var g = bo.g;
    var out = { bg: bo.c, frame: null, light: null, windows: windowRects(room) };
    if (!g) return out;
    var r = rng(room.w * 31 + room.h);
    var x, y;
    // wall in bands: top, picture rail, wainscot with panels, skirting with a highlight line
    fill(g, sc.wallTop, 0, 0, room.w, H - 20);
    fill(g, sc.wallRail, 0, H - 20, room.w, 2);
    fill(g, '#ffffff', 0, H - 20, room.w, 1, 0.25);
    fill(g, sc.wainscot, 0, H - 18, room.w, 15);
    for (x = 8; x < room.w; x += 16) fill(g, sc.panel, x, H - 16, 1, 11, 0.35);
    fill(g, sc.panel, 0, H - 16, room.w, 1, 0.3); fill(g, sc.panel, 0, H - 6, room.w, 1, 0.3);
    fill(g, sc.skirt, 0, H - 3, room.w, 3); fill(g, sc.skirtHi, 0, H - 3, room.w, 1); fill(g, sc.skirtLo, 0, H - 1, room.w, 1);
    // floor: 8 px planks, two tones, a highlight on each top edge, staggered joints, a little grain
    for (y = H, rowN = 0; y < room.h; y += 8, rowN++) {
      var off = (rowN * 11) % 32;
      for (var x0 = -off, idx = 0; x0 < room.w; x0 += 32, idx++) {
        var xa = Math.max(0, x0);
        var wd = Math.min(room.w, x0 + 32) - xa;
        var hh = Math.min(8, room.h - y);
        fill(g, (idx + rowN) % 2 ? sc.floorA : sc.floorB, xa, y, wd, hh);
        fill(g, sc.floorHi, xa, y, wd, 1, 0.4);
        fill(g, sc.floorJoint, xa, y + hh - 1, wd, 1, 0.22);
        if (x0 >= 0) fill(g, sc.floorJoint, x0, y, 1, hh, 0.55);
        for (var q = 0; q < 2; q++) fill(g, sc.floorJoint, xa + 3 + Math.floor(r() * (wd - 8)), y + 2 + Math.floor(r() * 4), 2 + Math.floor(r() * 3), 1, 0.18);
      }
    }
    var rowN;
    // dithered contact shadow along the wall
    for (x = 0; x < room.w; x++) {
      fill(g, sc.floorDither, x, H, 1, 1, 0.3);
      if ((x + 0) % 2 === 0) fill(g, sc.floorDither, x, H + 1, 1, 1, 0.28);
      if (x % 4 === 1) fill(g, sc.floorDither, x, H + 2, 1, 1, 0.22);
      if (x % 4 === 3) fill(g, sc.floorDither, x, H + 1, 1, 1, 0.12);
    }
    // rugs under the pods and the lounge
    room.pods.forEach(function (p) { rug(g, sc, p.x, p.y + 2, p.w, p.h - 4); });
    var lg = room.lounge;
    rug(g, sc, lg.x, lg.y + 10, Math.min(lg.w, 118), lg.h - 8);

    // windows: sky with dithered bands (clouds drift in front, see drawRoom), frame on its own layer
    var fo = canvasOf(room.w, room.h);
    var lo = canvasOf(room.w, room.h);
    out.frame = fo.c;
    out.light = lo.c;
    out.windows.forEach(function (w) {
      var prev = null;
      for (var b = 0; b < 12; b++) {
        var col = mix(sc.skyTop, sc.skyLow, b / 11);
        fill(g, col, w.x, w.y + b * 2, w.w, 2);
        if (prev) for (var xx = 0; xx < w.w; xx += 2) fill(g, prev, w.x + xx + (b % 2), w.y + b * 2, 1, 1);
        prev = col;
      }
      if (sc.stars) for (var s = 0; s < 7; s++) fill(g, '#fff8ee', w.x + 2 + Math.floor(r() * 26), w.y + 1 + Math.floor(r() * 14), 1, 1, 0.8);
      var f = fo.g;
      if (f) {
        fill(f, sc.frameLine, w.x - 3, 5, 36, 30);
        fill(f, sc.frame, w.x - 2, 6, 34, 28);
        fill(f, sc.frameShade, w.x - 2, 32, 34, 2); fill(f, sc.frameShade, w.x + 30, 6, 2, 28);
        f.clearRect(w.x, 8, 30, 24);
        fill(f, sc.frame, w.x + 8, 8, 2, 24); fill(f, sc.frame, w.x + 20, 8, 2, 24);
        fill(f, sc.frameShade, w.x + 9, 8, 1, 24); fill(f, sc.frameShade, w.x + 21, 8, 1, 24);
        fill(f, sc.sill, w.x - 4, 34, 38, 2); fill(f, sc.frameLine, w.x - 4, 36, 38, 1, 0.6);
        [[2, 10], [4, 14], [12, 12], [14, 16], [24, 9]].forEach(function (p) { fill(f, sc.sheen, w.x + p[0], 8 + p[1], 2, 1); fill(f, sc.sheen, w.x + p[0] + 1, 9 + p[1], 1, 1); });
      }
      // a light shaft onto the floor: three panes, shifted down-right, two dithered rows at the far edge
      var l = lo.g;
      if (l) {
        var len = Math.min(48, room.h - H - 2);
        for (var i = 0; i < len; i++) {
          var yy = H + 2 + i;
          var sh = Math.round(i * 0.8) + 6;
          [[0, 8], [10, 10], [22, 8]].forEach(function (pn) {
            var x1 = w.x + pn[0] + sh;
            if (i >= len - 2) { for (var cx = 0; cx < pn[1]; cx++) if ((cx + yy + (i === len - 1 ? 1 : 0)) % 2 === 0) fill(l, sc.shaft, x1 + cx, yy, 1, 1, sc.shaftAlpha); }
            else fill(l, sc.shaft, x1, yy, pn[1], 1, sc.shaftAlpha);
          });
        }
      }
    });

    // wall props placed in the free spans of the back wall
    var door = room.door;
    var spans = [];
    var blocks = out.windows.map(function (w) { return [w.x - 4, w.x + 34]; }).concat([[door.x - 4, door.x + door.w + 4]]).sort(function (a, b) { return a[0] - b[0]; });
    var cur = 2;
    blocks.forEach(function (bk) { if (bk[0] - cur > 8) spans.push([cur, bk[0]]); cur = Math.max(cur, bk[1]); });
    if (room.w - 2 - cur > 8) spans.push([cur, room.w - 2]);
    var place = function (wd) {
      for (var i = 0; i < spans.length; i++) if (spans[i][1] - spans[i][0] >= wd + 2) { var px = spans[i][0] + 1; spans[i][0] += wd + 5; return px; }
      return -1;
    };
    var chars = printable(label, 6) || '...';
    var cw = SP.textWidth(chars) + 8;
    var px0 = place(cw);
    if (px0 < 0 && chars.length > 3) { chars = chars.slice(0, 3); cw = SP.textWidth(chars) + 8; px0 = place(cw); }
    if (px0 >= 0) {   // cork board with the project name
      fill(g, sc.corkFrame, px0, 6, cw, 17); fill(g, sc.cork, px0 + 1, 7, cw - 2, 15); fill(g, sc.corkHi, px0 + 1, 7, cw - 2, 1, 0.7); fill(g, sc.corkLo, px0 + 1, 21, cw - 2, 1, 0.7);
      for (var cp = 0; cp < 5; cp++) fill(g, sc.corkLo, px0 + 2 + Math.floor(r() * (cw - 5)), 8 + Math.floor(r() * 12), 1, 1, 0.5);
      drawText(g, chars, px0 + 5, 12, sc.corkLo);
      drawText(g, chars, px0 + 4, 11, sc.corkText);
      fill(g, '#ee6a73', px0 + 2, 8, 2, 2); fill(g, '#ffd25a', px0 + cw - 4, 8, 2, 2);
    }
    [['picture', 16, 5], ['clock', 15, 6], ['shelf', 30, 8]].forEach(function (p) {
      var px = place(p[1]);
      if (px >= 0) { g.drawImage(sprite('shadowProp'), px + 2, p[2] + SP.SPRITES[p[0]].length - 2, SP.SPRITES[p[0]][0].length - 4, 3); g.drawImage(sprite(p[0]), px, p[2]); }
    });
    // floor props against the wall: plant, bookcase, second plant (foot line just below the skirting)
    var prop = function (name, px) {
      var hgt = SP.SPRITES[name].length;
      g.drawImage(sprite('shadowProp'), px + 2, H + 2);
      g.drawImage(sprite(name), px, H + 5 - hgt);
    };
    prop('plant', 6);
    var bx = place(24); if (bx >= 0) prop('bookcase', bx);
    var p2 = place(14); if (p2 >= 0) prop('plant2', p2);
    // string lights along the top of the wall
    for (x = 0; x < room.w; x++) {
      var seg = (x % 30) / 30;
      var wy = 1 + Math.round(3 * Math.sin(Math.PI * seg));
      fill(g, sc.wire, x, wy, 1, 1, 0.9);
      if (x % 10 === 5) {
        var bc = sc.bulb[Math.floor(x / 10) % sc.bulb.length];
        fill(g, bc, x, wy + 1, 1, 2); fill(g, '#ffffff', x, wy + 1, 1, 1, 0.6);
        if (th === 'dark') { fill(g, bc, x - 2, wy, 5, 5, 0.12); fill(g, bc, x - 1, wy + 1, 3, 3, 0.18); }
      }
    }
    // the door (a finished session walks out through it)
    var dy = H - 33;
    fill(g, sc.frameLine, door.x - 2, dy - 2, door.w + 4, H - dy + 2);
    fill(g, SP.PALETTES[th].T, door.x, dy, door.w, H - dy);
    fill(g, SP.PALETTES[th].Y, door.x, dy, door.w, 1, 0.8);
    fill(g, SP.PALETTES[th].t, door.x + 3, dy + 4, 7, 11); fill(g, SP.PALETTES[th].t, door.x + 13, dy + 4, 7, 11);
    fill(g, SP.PALETTES[th].t, door.x + 3, dy + 18, 7, 11); fill(g, SP.PALETTES[th].t, door.x + 13, dy + 18, 7, 11);
    fill(g, SP.PALETTES[th].y, door.x + 10, dy + 16, 2, 2); fill(g, SP.PALETTES[th].W, door.x + door.w - 1, dy, 1, H - dy, 0.6);
    fill(g, SP.PALETTES[th].c, door.x - 1, dy - 11, SP.textWidth('EXIT') + 4, 9);
    drawText(g, 'EXIT', door.x + 1, dy - 10, sc.ring === '#ffd25a' ? '#ee6a73' : '#ee6a73');

    // lounge furniture shadows and the free desks
    g.drawImage(sprite('shadowDesk'), lg.x + 4, lg.y + LNG.sofaFrontY + 14, 58, 6);
    g.drawImage(sprite('shadowProp'), lg.x + LNG.coffeeX + 2, lg.y + LNG.coffeeY + 24);
    g.drawImage(sprite('shadowProp'), lg.x + LNG.plantX, lg.y + LNG.plantY + 25);
    room.desks.forEach(function (d) { if (d.free) drawDeskStatic(g, d); else { g.drawImage(sprite('shadowDesk'), d.x + CELL.shadowX + 2, d.y + CELL.shadowY); g.drawImage(sprite('shadowChar'), d.x + CELL.chairX - 1, d.y + CELL.chairY + 12); } });
    return out;
  }

  // ------------------------------------------------------------------ monitor contents
  var CODE_COLORS = ['Q', 'y', 'l', 'k', 'w', 'C'];
  function codePattern(seed) {
    var key = 'code:' + seed;
    if (!cache[key]) {
      var r = rng(seed * 7919 + 13);
      var lines = [];
      for (var i = 0; i < 16; i++) {
        var toks = [];
        var n = 1 + Math.floor(r() * 3);
        var ind = Math.floor(r() * 3);
        for (var j = 0; j < n; j++) { toks.push([j === 0 ? ind : 1, 1 + Math.floor(r() * 4), Math.floor(r() * CODE_COLORS.length)]); }
        lines.push(toks);
      }
      cache[key] = lines;
    }
    return cache[key];
  }
  // modes: off | glow | busy (code) | run (terminal with progress bar) | read | search | web
  function drawScreen(g, sx, sy, mode, t, seed, beat) {
    var pal = SP.PALETTES[theme()];
    var i;
    if (mode === 'off') {
      fill(g, pal.c, sx, sy, 14, 9); fill(g, pal.D, sx + 1, sy + 1, 3, 1, 0.8); fill(g, pal.G, sx + 10, sy + 6, 3, 2, 0.35);
    } else if (mode === 'glow') {
      fill(g, pal.I, sx, sy, 14, 9);
      [[8, 2], [6, 4], [9, 6]].forEach(function (p) { fill(g, pal.Q, sx + 2, sy + p[1], p[0], 1, 0.7); });
    } else if (mode === 'busy') {
      fill(g, pal.c, sx, sy, 14, 9);
      var pat = codePattern(seed);
      var scroll = Math.floor(t / 420);
      for (i = 0; i < 4; i++) {
        var x = sx + 1;
        pat[(i + scroll) % pat.length].forEach(function (tk) { x += tk[0]; fill(g, pal[CODE_COLORS[tk[2]]], x, sy + 1 + i * 2, Math.min(tk[1], sx + 13 - x), 1); x += tk[1]; });
      }
      fill(g, pal.w, sx + 1 + ((scroll * 3 + seed) % 9), sy + 7, 1, 1, beat ? 1 : 0.25);
    } else if (mode === 'run') {
      fill(g, pal.c, sx, sy, 14, 9);
      var sc = Math.floor(t / 700);
      for (i = 0; i < 3; i++) fill(g, pal.l, sx + 1, sy + 1 + i * 2, 3 + (((i + sc) * 5 + seed) % 8), 1, i === 2 ? 1 : 0.7);
      fill(g, pal.D, sx + 1, sy + 7, 12, 1); fill(g, pal.l, sx + 1, sy + 7, Math.max(1, Math.floor(12 * ((t / 3500) % 1))), 1);
    } else if (mode === 'read') {
      fill(g, pal.w, sx, sy, 14, 9);
      var sr = Math.floor(t / 650);
      for (i = 0; i < 4; i++) fill(g, i % 2 ? pal.G : pal.D, sx + 1, sy + 1 + i * 2, 7 + ((i + sr) * 3 % 6), 1);
    } else if (mode === 'search') {
      fill(g, pal.C, sx, sy, 14, 9);
      var ss = Math.floor(t / 500) % 3;
      for (i = 0; i < 3; i++) { fill(g, i === ss ? pal.k : pal.G, sx + 1, sy + 1 + i * 3, 2, 2); fill(g, pal.I, sx + 4, sy + 1 + i * 3, 7 - i, 1); fill(g, pal.Q, sx + 4, sy + 2 + i * 3, 5, 1); }
    } else if (mode === 'web') {
      fill(g, pal.I, sx, sy, 14, 9);
      g.fillStyle = pal.Q; ellFill(g, sx + 7, sy + 4, 4, 4);
      fill(g, pal.C, sx + 4, sy + 4, 6, 1, 0.8); fill(g, pal.C, sx + 7, sy, 1, 9, 0.8);
      fill(g, pal.l, sx + 5 + (Math.floor(t / 600) % 3), sy + 2, 2, 2);
    }
  }

  // ------------------------------------------------------------------ actors: who is where, walking, resting
  function Actor(id) {
    this.id = id; this.state = 'seated'; this.x = 0; this.y = 0; this.path = []; this.steps = []; this.arrive = null; this.busy = false;
    this.wait = 0; this.waitTotal = 0; this.hopping = false; this.fading = false; this.carry = null; this.say = null; this.echo = null; this.dir = 1;
    this.walking = false; this.spot = -1; this.geo = ''; this.look = false; this.pendingEnd = null;
  }
  function seatPos(d) { return { x: d.x + CELL.charX, y: d.y + CELL.charY }; }
  function besidePos(room, td) { return { x: td.x + (td.x > room.w / 2 ? -8 : 40), y: td.y + 24 }; }
  function wantOf(row) { return M.placeFor(row, Date.now()); }

  function spotOf(rc, a) {
    var key = rc.room.key;
    var list = loungeSeats[key] = loungeSeats[key] || [];
    var i = list.indexOf(a.id);
    if (i < 0) { i = list.indexOf(null); if (i < 0) { i = list.length; list.push(a.id); } else list[i] = a.id; }
    a.spot = i;
    return rc.room.spots[i % rc.room.spots.length];
  }
  function releaseSpot(rc, a) {
    var list = loungeSeats[rc.room.key] || [];
    var i = list.indexOf(a.id);
    if (i >= 0) list[i] = null;
    a.spot = -1;
  }
  function homePos(rc, a, d) {
    if (a.state === 'rest') { var sp = spotOf(rc, a); return { x: sp.x, y: sp.y }; }
    return seatPos(d);
  }
  function resolve(rc, a, d, to) {
    if (to === 'seat') return seatPos(d);
    if (to === 'door') return rc.room.door.at;
    if (to === 'lounge') { var sp = spotOf(rc, a); return { x: sp.x, y: sp.y }; }
    return to;
  }
  // a walking route: up to the lane in front of the back wall, along it, then down; the lounge is reached along the left aisle
  function route(rc, a, d, to) {
    var pt = resolve(rc, a, d, to);
    var room = rc.room;
    var lane = M.WALL_H + 2;
    var lounge = room.lounge.y - 12;
    var fromLounge = a.y >= lounge;
    var toLounge = pt.y >= lounge;
    if (!fromLounge && !toLounge && to !== 'door' && Math.abs(a.y - pt.y) < 40) return [pt];
    var pts = [];
    if (fromLounge) { pts.push({ x: 0, y: a.y }); pts.push({ x: 0, y: lane }); } else pts.push({ x: a.x, y: lane });
    if (toLounge) { pts.push({ x: 0, y: lane }); pts.push({ x: 0, y: pt.y }); } else pts.push({ x: pt.x, y: lane });
    pts.push(pt);
    return pts;
  }

  function begin(rc, a, d, st) {
    a.hopping = false;
    if (st.say !== undefined) a.say = st.say;
    if (st.carry !== undefined) a.carry = st.carry;
    if (st.look !== undefined) a.look = st.look;
    if (st.to) { a.path = route(rc, a, d, st.to); a.arrive = st; } else arrived(rc, a, d, st);
  }
  function arrived(rc, a, d, st) {
    if (st.hop) a.hopping = true;
    if (st.fade) a.fading = true;
    if (st.wait) { a.wait = st.wait; a.waitTotal = st.wait; }
    if (st.echoTo && actors[st.echoTo]) actors[st.echoTo].echo = { kind: st.echo, until: now() + (st.wait || 0) };
    a.pendingEnd = st.end || null;
    if (!st.wait) flushEnd(rc, a);
  }
  function flushEnd(rc, a) {
    var end = a.pendingEnd;
    a.pendingEnd = null;
    if (!end) return;
    if (a.state === 'rest' && end !== 'rest') releaseSpot(rc, a);
    a.state = end;
    if (end === 'gone') { a.steps = []; a.path = []; a.busy = false; a.say = null; a.carry = null; a.fading = false; a.hopping = false; }
  }
  function program(a, steps) { a.steps = steps; a.busy = true; a.path = []; a.arrive = null; a.wait = 0; }

  function errandFor(ev, scene) {
    var who = scene.where(ev.who);
    var to = scene.where(ev.to);
    if (!who || !to) return null;
    var stand = besidePos(to.rc.room, to.desk);
    if (ev.type === 'report') return [{ to: stand, carry: 'paper', say: 'paper', wait: 1600 }, { to: 'seat', carry: null, say: null, end: 'seated' }];
    if (ev.type === 'review') return [{ to: stand, say: 'search', look: true, wait: 3200 }, { to: 'seat', say: null, look: false, end: 'seated' }];
    if (ev.type === 'debate') return [{ to: stand, say: 'q', wait: 2800, echoTo: ev.to, echo: 'q' }, { to: 'seat', say: null, end: 'seated' }];
    if (ev.type === 'dispatch') return [{ to: stand, carry: 'paper', wait: 1700, echoTo: ev.to, echo: 'paper' }, { to: 'seat', carry: null, end: 'seated' }];
    return null;
  }

  function stepActor(scene, a, rc, d, it, dt) {
    if (a.busy) {
      if (a.wait > 0) { a.wait -= dt; if (a.wait > 0) return; a.wait = 0; a.hopping = false; flushEnd(rc, a); if (!a.busy) return; }
      if (a.path.length) {
        var p = a.path[0];
        var dx = p.x - a.x;
        var dy = p.y - a.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var len = WALK_SPEED * dt / 1000;
        if (dist <= len) { a.x = p.x; a.y = p.y; a.path.shift(); } else { a.x += dx / dist * len; a.y += dy / dist * len; }
        if (Math.abs(dx) > 0.5) a.dir = dx > 0 ? 1 : -1;
        a.walking = a.path.length > 0 || dist > len;
        if (a.path.length) return;
      }
      a.walking = false;
      if (a.arrive) { var st = a.arrive; a.arrive = null; arrived(rc, a, d, st); if (a.wait > 0) return; }
      var nx = a.steps.shift();
      if (nx) { begin(rc, a, d, nx); return; }
      a.busy = false; a.say = null; a.carry = null; a.fading = false; a.look = false;
      return;
    }
    var want = wantOf(it.row);
    if (a.state === 'gone') {
      if (want !== 'out') { a.state = 'seated'; a.fading = false; var s0 = seatPos(d); a.x = s0.x; a.y = s0.y; }
      return;
    }
    // errands first (a finished subagent reports before it leaves)
    if (a.state === 'seated') {
      for (var i = 0; i < events.length; i++) {
        if (events[i].who !== a.id) continue;
        var steps = errandFor(events[i], scene);
        events.splice(i, 1);
        if (steps) { program(a, steps); return; }
        i--;
      }
    }
    if (want === 'out') {
      program(a, a.state === 'seated' ? [{ hop: true, wait: 700 }, { to: 'door', fade: true, wait: 350, end: 'gone' }] : [{ to: 'door', fade: true, wait: 350, end: 'gone' }]);
    } else if (want === 'lounge' && a.state === 'seated') {
      program(a, [{ to: 'lounge', end: 'rest' }]);
    } else if (want === 'desk' && a.state === 'rest') {
      program(a, [{ to: 'seat', end: 'seated' }]);
    }
  }

  function stepActors(scene, dt) {
    for (var i = 0; i < scene.rcs.length; i++) {
      var rc = scene.rcs[i];
      for (var j = 0; j < rc.occupied.length; j++) {
        var d = rc.occupied[j];
        var a = actors[d.id];
        if (a) stepActor(scene, a, rc, d, scene.items[d.id], dt);
      }
    }
  }
  // snap everyone to where they belong (reduced motion, first draw, new geometry)
  function settle(rc, a, d, row) {
    var want = wantOf(row);
    a.busy = false; a.pendingEnd = null; a.path = []; a.steps = []; a.arrive = null; a.wait = 0; a.hopping = false; a.fading = false; a.carry = null; a.say = null; a.walking = false;
    if (a.state === 'rest') releaseSpot(rc, a);
    a.state = want === 'out' ? 'gone' : want === 'lounge' ? 'rest' : 'seated';
    var h = homePos(rc, a, d);
    a.x = h.x; a.y = h.y;
  }

  // ------------------------------------------------------------------ drawing one frame
  function blinking(id, t) {
    var b = blinks[id];
    if (!b) { var seed = M.hash(id); b = blinks[id] = { seed: seed, k: 0, next: t + SP.blinkGap(seed, 0), until: 0 }; }
    if (t >= b.next && t >= b.until) { b.until = t + A.blinkMs; b.k++; b.next = b.until + SP.blinkGap(b.seed, b.k); }
    return t < b.until;
  }

  function charSliced(g, cv, x, y, bob) {
    g.drawImage(cv, 0, 0, CHW, HEAD, x, y, CHW, HEAD);
    g.drawImage(cv, 0, HEAD, CHW, CHH - HEAD, x, y + HEAD + bob, CHW, CHH - HEAD);
    if (bob > 0) g.drawImage(cv, 0, HEAD, CHW, 1, x, y + HEAD, CHW, bob);
  }

  function frameFor(it, a, t, calm, ph) {
    var an = it.anim;
    if (calm) return an.act === 'wait' ? 'alert' : 'stand';
    if (a.state === 'seated' && !a.busy) {
      if (an.act === 'wait') return 'alert';
      if (blinking(it.row.id, t)) return 'blink';
      if (an.look === 'screen') return 'look';
      if (an.act === 'think' && Math.floor(ph / 1300) % 2) return 'tilt';
      if (!an.typing && Math.floor(ph / A.idleStepMs) % 4 === 2) return 'armB';
      return 'stand';
    }
    return blinking(it.row.id, t) ? 'blink' : 'stand';
  }

  function drawBubbleBox(g, x, y, kind) {
    var sc = SP.SCENE[theme()];
    var line = { think: '#4a78c4', speech: '#4fa36a', icon: '#9b7fd4', alert: '#ee6a73', q: '#9b7fd4', paper: '#f0975f' }[kind] || '#9b7fd4';
    var w = 28;
    var h = 17;
    g.fillStyle = line;
    g.fillRect(x + 1, y, w - 2, h); g.fillRect(x, y + 1, w, h - 2);
    g.fillStyle = sc.bubble;
    g.fillRect(x + 2, y + 1, w - 4, h - 2); g.fillRect(x + 1, y + 2, w - 2, h - 4);
    var cx = x + 13;   // 3 px tail
    g.fillStyle = line; g.fillRect(cx - 2, y + h - 1, 5, 1); g.fillRect(cx - 1, y + h, 3, 1); g.fillRect(cx, y + h + 1, 1, 1);
    g.fillStyle = sc.bubble; g.fillRect(cx - 1, y + h - 1, 3, 1); g.fillRect(cx, y + h, 1, 1);
  }

  var ICONS = { file: 'iconFile', terminal: 'iconTerminal', search: 'iconSearch', agent: 'iconAgent', web: 'iconGlobe', other: 'iconGear' };

  function bubbleKind(an, a, calm, t) {
    if (a.echo && a.echo.until > t) return { kind: a.echo.kind === 'q' ? 'q' : 'paper' };
    if (a.say === 'q') return { kind: 'q' };
    if (a.say === 'paper') return { kind: 'paper' };
    if (a.say === 'search') return { kind: 'icon', icon: 'search' };
    if (a.state !== 'seated' || a.busy) return null;
    if (!an.bubble) return null;
    return { kind: an.bubble, icon: an.icon };
  }

  function drawBubble(g, a, it, t, calm) {
    var an = it.anim;
    var bk = bubbleKind(an, a, calm, t);
    if (!bk) return;
    var pal = SP.PALETTES[theme()];
    var x = Math.round(a.x - 2);
    var y = Math.round(a.y - 22);
    if (an.bounce && !calm && bk.kind === 'alert') y -= Math.round(Math.abs(Math.sin(t * Math.PI / A.bounceMs)) * A.bounceHeight);
    var kind = bk.kind;
    drawBubbleBox(g, x, y, kind);
    var f = Math.floor(t / A.thinkMs);
    if (kind === 'think') {
      var lit = calm ? -1 : f % 4;
      for (var i = 0; i < 3; i++) { g.fillStyle = calm || lit === i ? pal.D : pal.G; g.fillRect(x + 7 + i * 5, y + 7 - (lit === i ? 1 : 0), 3, 3); }
    } else if (kind === 'speech') {
      var s = seen[it.row.id];
      var chars = calm || !s ? 99 : Math.floor((t - s.bsince) / A.typewriterMs);
      g.fillStyle = pal.G;
      g.fillRect(x + 5, y + 5, Math.min(18, chars), 2);
      if (chars > 18) g.fillRect(x + 5, y + 10, Math.min(12, chars - 18), 2);
      if (!calm && (chars < 30 || Math.floor(t / 400) % 2)) {   // a blinking cursor at the end of the typed text
        var second = chars > 18;
        g.fillStyle = pal.D;
        g.fillRect(x + 6 + Math.min(second ? 12 : 18, second ? chars - 18 : chars), second ? y + 10 : y + 5, 1, 2);
      }
    } else if (kind === 'icon') {
      g.drawImage(sprite(ICONS[bk.icon] || 'iconGear'), x + 8, y + 3);
    } else if (kind === 'alert') {
      g.drawImage(sprite('excl'), x + 9, y + 3);
    } else if (kind === 'q') {
      var wob = calm ? 0 : Math.round(Math.sin(t / 180));
      drawText(g, '?', x + 11, y + 5 + 1, pal.G); drawText(g, '?', x + 11, y + 5 + wob, '#9b7fd4');
    } else if (kind === 'paper') {
      g.drawImage(sprite('paper'), x + 10, y + 4);
    }
  }

  function drawZ(g, a, t, calm) {
    var pal = SP.PALETTES[theme()];
    var u = calm ? 0 : (t / 1400 + a.spot * 0.37) % 1;
    for (var i = 0; i < 2; i++) {
      var v = calm ? i * 0.5 : (u + i * 0.5) % 1;
      g.globalAlpha = 1 - v * 0.7;
      drawText(g, 'Z', Math.round(a.x + 16 + v * 4 + i * 3), Math.round(a.y - 3 - v * 9), i ? pal.G : pal.C);
    }
    g.globalAlpha = 1;
  }

  // one seat: chair + character (sorted by the character's foot line) and the desk with everything on it
  function pushSeat(list, rc, d, it, a, t, hot, calm) {
    var an = it.anim;
    var pal = SP.PALETTES[theme()];
    var sc = SP.SCENE[theme()];
    var seated = a.state === 'seated' && !a.busy;
    var ph = t + it.look.phase;
    var busyScr = seated && (an.screen === 'busy' || an.screen === 'run' || an.screen === 'read' || an.screen === 'search' || an.screen === 'web');
    var beat = Math.floor(t / (an.fast ? 90 : A.typeMs)) % 2;
    var cyc = ph % A.coffeeCycleMs;
    var sipStep = an.coffee && !calm && seated && cyc < A.sipSteps * A.sipStepMs ? Math.floor(cyc / A.sipStepMs) : -1;
    var lifts = [5, 11, 15, 9];

    // chair (+ the seated character)
    list.push({ y: d.y + CELL.charY + CHH - 0.5, f: function (g) {
      g.drawImage(sprite('chair'), d.x + CELL.chairX, d.y + CELL.chairY);
      if (!seated) return;
      var frame = sipStep === 2 || sipStep === 3 ? 'blink' : frameFor(it, a, t, calm, ph);
      var cv = character(frame, it.look);
      var bob = calm || an.typing ? 0 : (Math.floor(ph / A.idleStepMs) % 4 === 1 || Math.floor(ph / A.idleStepMs) % 4 === 2 ? 1 : 0);
      var x = d.x + CELL.charX;
      var y = d.y + CELL.charY;
      charSliced(g, cv, x, y, bob);
      if (busyScr) { g.globalAlpha = calm ? 0.14 : (beat ? 0.2 : 0.12); g.drawImage(tinted(cv, sc.glow), 0, 0, CHW, HEAD, x, y, CHW, HEAD); g.globalAlpha = 1; }
      if (an.prop === 'doc') g.drawImage(sprite(it.look.role === 'reviewer' ? 'clipboard' : 'paper'), x + 15, y + 15 + bob);
      else if (an.prop === 'magnifier') g.drawImage(sprite('magnifier'), x + 15, y + 14 + bob + (calm ? 0 : Math.round(Math.sin(t / 300))));
    } });

    // desk group
    list.push({ y: d.y + CELL.deskY + 22, f: function (g) {
      var s = CELL.screen;
      var sx = d.x + CELL.monX + s.x;
      var sy = d.y + CELL.monY + s.y;
      var mode = seated ? an.screen : 'off';
      if (mode !== 'off') {
        g.globalAlpha = busyScr ? (calm || beat ? 1 : 0.7) : 0.6;
        g.drawImage(halo('mon', sc.glow, 34, 26, 0.10, 0.16), sx - 10, sy - 8);
        g.globalAlpha = 1;
      }
      g.drawImage(sprite('desk'), d.x + CELL.deskX, d.y + CELL.deskY);
      if (busyScr) { g.globalAlpha = calm || beat ? 1 : 0.75; g.drawImage(halo('deskglow', sc.glow, 30, 8, 0.12, 0.2), d.x + CELL.deskX + 2, d.y + CELL.deskY + 3); g.globalAlpha = 1; }
      g.drawImage(sprite('monitor'), d.x + CELL.monX, d.y + CELL.monY);
      drawScreen(g, sx, sy, mode, t, M.hash(d.id) % 997, beat);
      g.drawImage(sprite(an.lamp && seated ? 'lampOn' : 'lampOff'), d.x + CELL.lampX, d.y + CELL.lampY);
      g.drawImage(sprite('keyboard'), d.x + CELL.kbX, d.y + CELL.kbY);
      if (an.typing && seated) g.drawImage(sprite(!calm && beat ? 'handsB' : 'handsA'), d.x + CELL.handsX, d.y + CELL.handsY);
      var lift = sipStep >= 0 ? lifts[sipStep] : 0;
      if (!seated) g.drawImage(sprite('mug'), d.x + CELL.mugX, d.y + CELL.mugY);
      else g.drawImage(sprite('mug'), d.x + CELL.mugX - (lift ? 4 : 0), d.y + CELL.mugY - lift);
      if (an.coffee && !calm && seated && cyc >= A.sipSteps * A.sipStepMs && cyc < A.sipSteps * A.sipStepMs + A.steamMs) {   // steam: 3 px, rising and fading
        var k = (cyc - A.sipSteps * A.sipStepMs) / A.steamMs;
        g.globalAlpha = 0.8 * (1 - k); g.fillStyle = pal.w;
        g.fillRect(d.x + CELL.mugX + 2, d.y + CELL.mugY - 1 - Math.round(k * A.steamRise), 1, 2);
        g.fillRect(d.x + CELL.mugX + 4, d.y + CELL.mugY - 2 - Math.round(k * A.steamRise), 1, 2);
        g.globalAlpha = 1;
      }
      if (seated && an.pose !== 'away' && an.coffee && calm) { g.fillStyle = pal.w; g.globalAlpha = 0.6; g.fillRect(d.x + CELL.mugX + 2, d.y + CELL.mugY - 2, 1, 2); g.globalAlpha = 1; }
      // name tag on the desk front: on hover, always for the orchestrator
      if (seated && (hot || it.look.role === 'orchestrator')) g.drawImage(tagCanvas(it.look.role), Math.round(d.x + CELL.w / 2 - tagCanvas(it.look.role).width / 2), d.y + CELL.deskY + 12);
    } });
  }

  function pushWalker(list, a, it, t, calm) {
    var cvName;
    var walking = a.walking;
    var hop = 0;
    if (a.hopping && a.waitTotal) hop = Math.round(Math.abs(Math.sin((1 - a.wait / a.waitTotal) * Math.PI * 2)) * A.hopHeight);
    if (a.hopping) cvName = 'happy';
    else if (walking) cvName = ['walkA', 'walkS', 'walkB', 'walkS'][Math.floor(t / A.walkMs) % A.walkFrames];
    else cvName = a.look ? 'look' : blinking(it.row.id, t) ? 'blink' : 'stand';
    list.push({ y: a.y + CHH - 1, f: function (g) {
      var x = Math.round(a.x);
      var y = Math.round(a.y) - hop;
      var alpha = a.fading && a.waitTotal ? Math.max(0, a.wait / a.waitTotal) : 1;
      g.drawImage(sprite('shadowChar'), x + 2, y + 29);
      g.globalAlpha = alpha;
      g.drawImage(character(cvName, it.look), x, y);
      if (a.carry === 'paper') g.drawImage(sprite(it.look.role === 'reviewer' ? 'clipboard' : 'paper'), x + (a.dir > 0 ? 17 : -1), y + 16);
      g.globalAlpha = 1;
    } });
  }

  function pushRest(list, rc, a, it, t, calm) {
    var spot = rc.room.spots[a.spot % rc.room.spots.length];
    var ph = t + it.look.phase;
    var sofa = spot.kind === 'sofa';
    list.push({ y: a.y + CHH - 1, f: function (g) {
      var x = Math.round(a.x);
      var y = Math.round(a.y);
      var sipStep = !sofa && !calm ? (function () { var c = ph % A.coffeeCycleMs; return c < A.sipSteps * A.sipStepMs ? Math.floor(c / A.sipStepMs) : -1; }()) : -1;
      var frame = sofa ? 'blink' : (sipStep === 2 || sipStep === 3 ? 'blink' : (blinking(it.row.id, t) ? 'blink' : 'stand'));
      if (calm && !sofa) frame = 'stand';
      var bob = calm ? 0 : (Math.floor(ph / 900) % 2);
      g.drawImage(sprite('shadowChar'), x + 2, y + 29);
      charSliced(g, character(frame, it.look), x, y, bob);
      if (!sofa) {
        var lift = sipStep >= 0 ? [2, 6, 9, 5][sipStep] : 0;
        g.drawImage(sprite('mug'), x + 16, y + 20 - lift);
      }
      if (sofa) drawZ(g, a, t, calm);
    } });
  }

  function drawRoom(rc, t) {
    var g = rc.g;
    if (!g) return;
    var sc = current;
    var calm = reduced();
    g.setTransform(rc.k, 0, 0, rc.k, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(rc.bg, 0, 0);
    var pal = SP.PALETTES[theme()];
    var scn = SP.SCENE[theme()];
    var i;
    // clouds drift 1 px per 3 s behind the window frames
    rc.windows.forEach(function (w, wi) {
      g.save();
      g.beginPath(); g.rect(w.x, w.y, w.w, w.h); g.clip();
      var drift = calm ? 0 : t / A.cloudMs;
      g.globalAlpha = theme() === 'dark' ? 0.7 : 0.95;
      g.drawImage(sprite('cloud'), Math.round(w.x + ((drift + wi * 17) % 44) - 14), w.y + 4);
      g.drawImage(sprite('cloud'), Math.round(w.x + ((drift * 0.7 + 22 + wi * 9) % 44) - 14), w.y + 13);
      g.restore();
    });
    g.drawImage(rc.frame, 0, 0);
    // soft glow around hovered desks and desks that wait for you
    var list = rc.list;
    list.length = 0;
    for (i = 0; i < rc.occupied.length; i++) {
      var d = rc.occupied[i];
      var it = sc.items[d.id];
      var hot = sc.hot === d.id;
      if (it.anim.highlight || hot) {
        g.globalAlpha = hot ? 1 : (calm ? 0.9 : 0.45 + 0.5 * (0.5 + 0.5 * Math.sin(t / 420)));
        g.drawImage(deskGlow(scn.ring), d.x - 3, d.y + 17);
        g.globalAlpha = 1;
      }
      if (theme() === 'dark' && it.anim.lamp && actors[d.id] && actors[d.id].state === 'seated' && !actors[d.id].busy) {   // lamp pool
        g.drawImage(halo('pool', scn.lamp, 64, 26, 0.07, 0.12), d.x + CELL.lampX - 26, d.y + CELL.lampY + 2);
      }
    }
    // lounge furniture and everything that moves, sorted by foot line
    var lg = rc.room.lounge;
    list.push({ y: lg.y + LNG.sofaBackY + 10, s: -3, f: function (gg) { gg.drawImage(sprite('sofaBack'), lg.x + LNG.sofaX, lg.y + LNG.sofaBackY); } });
    list.push({ y: lg.y + LNG.sofaFrontY + 18, s: -3, f: function (gg) { gg.drawImage(sprite('sofaFront'), lg.x + LNG.sofaX, lg.y + LNG.sofaFrontY); } });
    list.push({ y: lg.y + LNG.coffeeY + 24, s: -3, f: function (gg) { gg.drawImage(sprite('coffee'), lg.x + LNG.coffeeX, lg.y + LNG.coffeeY); } });
    list.push({ y: lg.y + LNG.plantY + 24, s: -3, f: function (gg) { gg.drawImage(sprite('plant'), lg.x + LNG.plantX, lg.y + LNG.plantY); } });
    for (i = 0; i < rc.occupied.length; i++) {
      var dd = rc.occupied[i];
      var item = sc.items[dd.id];
      var a = actors[dd.id];
      if (!a) continue;
      pushSeat(list, rc, dd, item, a, t, sc.hot === dd.id, calm);
      if (a.state === 'gone') continue;
      if (a.state === 'rest' && !a.busy) pushRest(list, rc, a, item, t, calm);
      else if (a.state !== 'seated' || a.busy) pushWalker(list, a, item, t, calm);
    }
    list.forEach(function (e, n) { e.n = n; if (e.s === undefined) e.s = 0; });
    list.sort(function (p, q) { return p.y - q.y || p.s - q.s || p.n - q.n; });
    for (i = 0; i < list.length; i++) list[i].f(g);
    g.drawImage(rc.light, 0, 0);
    // bubbles, name arrows on top of everything
    for (i = 0; i < rc.occupied.length; i++) {
      var d2 = rc.occupied[i];
      var a2 = actors[d2.id];
      if (!a2 || a2.state === 'gone') continue;
      drawBubble(g, a2, sc.items[d2.id], t, calm);
      if (sc.hot === d2.id) g.drawImage(sprite('arrow'), d2.x + 8, d2.y + 8 + (calm ? 0 : Math.round(Math.abs(Math.sin(t / 220)) * 2)));
    }
    if (pal) g.globalAlpha = 1;
  }

  function drawAll(t) {
    if (!current) return;
    for (var i = 0; i < current.rcs.length; i++) drawRoom(current.rcs[i], t);
  }

  // ------------------------------------------------------------------ loop: 15 fps, off when hidden or for reduced motion
  var lastT = 0;
  function tick(ts) {
    raf = 0;
    if (!current || !current.alive() || document.hidden || reduced()) return;
    if (ts - lastTick >= frameMs) {
      lastTick = ts;
      var t0 = now();
      var dt = Math.min(120, t0 - (lastT || t0));
      lastT = t0;
      stepActors(current, dt);
      drawAll(t0);
      var cost = now() - t0;     // slow frames: lower the rate a little, recover when cheap again
      if (cost > 24 && frameMs < 100) frameMs += 6;
      else if (cost < 8 && frameMs > A.frameMs) frameMs -= 3;
    }
    raf = window.requestAnimationFrame(tick);
  }
  function kick() {
    if (!current) return;
    lastT = 0;
    if (reduced() || document.hidden) { current.settleAll(); drawAll(now()); return; }
    if (raf) window.cancelAnimationFrame(raf);
    raf = window.requestAnimationFrame(tick);
  }
  function redraw() { if (current && (reduced() || document.hidden)) drawAll(now()); }

  // ------------------------------------------------------------------ the page
  function page(d, ctx) {
    var rows = (d && Array.isArray(d.sessions)) ? d.sessions : [];
    var t0 = now();
    rows.forEach(function (r) {
      var s = M.shownStatus(r);
      var bkey = String(M.animFor(r).bubble) + ':' + (r.activity && r.activity.kind);
      var a = seen[r.id];
      if (!a) seen[r.id] = { shown: s, since: -1e12, bkey: bkey, bsince: -1e12 };     // already there when first seen: no animation
      else {
        if (a.shown !== s) { a.shown = s; a.since = t0; }
        if (a.bkey !== bkey) { a.bkey = bkey; a.bsince = t0; }
      }
    });
    var det = M.detectEvents(evPrev, rows);
    evPrev = det.next;
    if (!reduced()) events = events.concat(det.events).slice(-12);
    layoutState = M.assign(layoutState, rows);
    var scene = new Scene(rows, ctx);
    current = scene;
    scene.build();
    window.setTimeout(kick, 0);
    return scene.root;
  }

  function Scene(rows, ctx) {
    this.rows = rows;
    this.ctx = ctx;
    this.items = {};
    this.rcs = [];
    this.hot = null;        // hovered or keyboard-focused session id
    this.tipId = null;
    this.plan = null;
    this.lastType = 'mouse';
    var self = this;
    rows.forEach(function (r) { self.items[r.id] = { row: r, anim: M.animFor(r), look: M.looks(r), desc: M.describe(r, ctx.mask) }; });
    this.root = el('div', 'o-page');
    this.root.appendChild(el('h1', '', ctx.t('office.title')));
    this.root.appendChild(el('p', 'muted', ctx.mask ? ctx.t('office.private') : ctx.t('office.intro')));
    if (!rows.length) { this.root.appendChild(el('p', 'empty', ctx.t('office.none'))); this.alive = function () { return false; }; return; }
    this.root.appendChild(this.legend());
    this.stage = el('div', 'o-stage');
    this.roomsEl = el('div', 'o-rooms');
    this.tip = el('div', 'o-tip');
    this.tip.hidden = true;
    this.tip.setAttribute('aria-hidden', 'true');
    this.stage.appendChild(this.roomsEl);
    this.stage.appendChild(this.tip);
    this.root.appendChild(this.stage);
    this.listEl = el('ul', 'o-list');
    this.listEl.setAttribute('aria-label', ctx.t('office.list'));
    this.root.appendChild(el('h2', '', ctx.t('office.list')));
    this.root.appendChild(this.listEl);
    this.alive = function () { return this.root.isConnected && current === this; };
  }

  Scene.prototype.legend = function () {
    var c = this.ctx;
    var box = el('div', 'o-legend');
    var line = function (label, items) {
      var p = el('p', 'o-legend-row');
      p.appendChild(el('span', 'muted', label + ' '));
      items.forEach(function (it) {
        var s = el('span', 'o-key');
        s.appendChild(el('span', 'o-sw ' + it[0]));
        s.appendChild(document.createTextNode(it[1]));
        p.appendChild(s);
      });
      return p;
    };
    box.appendChild(line(c.t('office.shirt'), [['e-claude', 'Claude'], ['e-codex', 'Codex']]));
    box.appendChild(line(c.t('office.hat'), M.ROLES.map(function (r) { return ['h-' + r, c.t('role.' + r)]; })));
    box.appendChild(el('p', 'muted', c.t('office.states')));
    return box;
  };

  Scene.prototype.roomLabel = function (key) {
    if (key === '-') return this.ctx.t('office.noProject');
    var name = key;
    for (var i = 0; i < this.rows.length; i++) if (this.rows[i].project === key && this.rows[i].project_name) { name = this.rows[i].project_name; break; }
    return this.ctx.pname({ id: key, name: name });   // aliased in private mode
  };

  // where a session sits: { rc, desk }
  Scene.prototype.where = function (id) {
    for (var i = 0; i < this.rcs.length; i++) {
      for (var j = 0; j < this.rcs[i].occupied.length; j++) if (this.rcs[i].occupied[j].id === id) return { rc: this.rcs[i], desk: this.rcs[i].occupied[j] };
    }
    return null;
  };

  Scene.prototype.settleAll = function () {
    var self = this;
    this.rcs.forEach(function (rc) {
      rc.occupied.forEach(function (d) {
        var a = actors[d.id];
        if (a) settle(rc, a, d, self.items[d.id].row);
      });
    });
    events = [];
  };

  Scene.prototype.build = function () {
    if (!this.roomsEl) return;
    var self = this;
    var main = document.getElementById('main');
    var width = Math.min((main && main.clientWidth) || window.innerWidth || 800, 1400) - 32;
    this.plan = M.planFor(width);
    this.plan.dpr = dpr();
    var k = Math.max(1, Math.round(this.plan.scale * this.plan.dpr));
    var lay = M.layout(layoutState, { maxCols: this.plan.maxCols });
    this.lay = lay;
    this.roomsEl.textContent = '';
    this.rcs = [];
    lay.rooms.forEach(function (room) {
      var sec = el('section', 'o-room');
      sec.appendChild(el('h2', 'o-room-name', self.roomLabel(room.key)));
      var canvas = el('canvas', 'o-canvas');
      canvas.width = room.w * k;
      canvas.height = room.h * k;
      canvas.style.width = (room.w * self.plan.scale) + 'px';
      canvas.style.height = (room.h * self.plan.scale) + 'px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', self.ctx.t('office.canvas', { count: room.desks.filter(function (x) { return x.id; }).length }));
      var g = canvas.getContext('2d');
      if (g) g.imageSmoothingEnabled = false;      // resizing a canvas resets this
      var bgs = drawBackground(room, self.roomLabel(room.key));
      var rc = {
        room: room, canvas: canvas, g: g, k: k, bg: bgs.bg, frame: bgs.frame, light: bgs.light, windows: bgs.windows, list: [],
        occupied: room.desks.filter(function (x) { return x.id && self.items[x.id]; })
      };
      self.rcs.push(rc);
      self.bindCanvas(rc);
      sec.appendChild(canvas);
      self.roomsEl.appendChild(sec);
    });
    // actors: new characters appear where they belong; known ones keep walking unless the room geometry changed
    var alive = {};
    this.rcs.forEach(function (rc) {
      rc.occupied.forEach(function (d) {
        alive[d.id] = true;
        var a = actors[d.id] || (actors[d.id] = new Actor(d.id));
        var geo = rc.room.key + ':' + rc.room.w + 'x' + rc.room.h + ':' + d.x + ',' + d.y;
        if (a.geo !== geo) { a.geo = geo; settle(rc, a, d, self.items[d.id].row); }
      });
    });
    Object.keys(actors).forEach(function (id) { if (!alive[id]) delete actors[id]; });
    Object.keys(loungeSeats).forEach(function (key) { loungeSeats[key] = loungeSeats[key].map(function (id) { return id && alive[id] ? id : null; }); });
    if (reduced()) this.settleAll();
    this.buildList();
    drawAll(now());
  };

  Scene.prototype.hit = function (rc, ev) {
    var r = rc.canvas.getBoundingClientRect();
    if (!r.width) return null;
    var x = (ev.clientX - r.left) * rc.room.w / r.width;
    var y = (ev.clientY - r.top) * rc.room.h / r.height;
    for (var i = 0; i < rc.occupied.length; i++) {
      var d = rc.occupied[i];
      if (x >= d.x + 2 && x < d.x + CELL.w - 2 && y >= d.y + 20 && y < d.y + 70) return d;
    }
    return null;
  };

  Scene.prototype.bindCanvas = function (rc) {
    var self = this;
    var c = rc.canvas;
    c.addEventListener('pointerdown', function (e) { self.lastType = e.pointerType || 'mouse'; });
    c.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      var d = self.hit(rc, e);
      c.style.cursor = d ? 'pointer' : 'default';
      if (!d) self.clear(); else if (self.tipId !== d.id) self.select(d.id, rc, d);
    });
    c.addEventListener('pointerleave', function () { self.clear(); });
    c.addEventListener('click', function (e) {
      var d = self.hit(rc, e);
      if (!d) { self.clear(); return; }
      if (self.lastType === 'touch' && self.tipId !== d.id) { self.select(d.id, rc, d); return; }
      self.go(d.id);
    });
  };

  Scene.prototype.go = function (id) {
    var it = this.items[id];
    if (!it) return;
    this.ctx.prepare(it.row);
    window.location.hash = this.ctx.href(it.row);
  };

  Scene.prototype.rcOf = function (id) { return this.where(id); };

  Scene.prototype.select = function (id, rc, desk) {
    if (!rc) { var f = this.rcOf(id); if (!f) return; rc = f.rc; desk = f.desk; }
    this.hot = id;
    this.tipId = id;
    this.fillTip(id);
    var sr = this.stage.getBoundingClientRect();
    var cr = rc.canvas.getBoundingClientRect();
    var k = cr.width / rc.room.w;
    var tip = this.tip;
    tip.hidden = false;
    var left = cr.left - sr.left + (desk.x + CELL.w / 2) * k - tip.offsetWidth / 2;
    var top = cr.top - sr.top + (desk.y + 4) * k - tip.offsetHeight - 6;
    if (top < 0) top = cr.top - sr.top + (desk.y + CELL.h - 4) * k + 6;
    left = Math.max(0, Math.min(left, Math.max(0, sr.width - tip.offsetWidth)));
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    redraw();
  };

  Scene.prototype.clear = function () {
    if (this.hot === null && this.tipId === null) return;
    this.hot = null;
    this.tipId = null;
    this.tip.hidden = true;
    redraw();
  };

  Scene.prototype.activityText = function (d) {
    var line = M.activityLine(d);
    var s = this.ctx.t(line.key, line.vars);
    if (line.target) s += ' · ' + line.target;
    return s;
  };

  Scene.prototype.projectText = function (d) {
    if (!d.project) return null;
    var name = this.ctx.pname({ id: d.project, name: d.projectName || d.project });
    return d.branch ? name + ' · ' + d.branch : name;
  };

  Scene.prototype.fillTip = function (id) {
    var c = this.ctx;
    var it = this.items[id];
    var d = it.desc;
    var tip = this.tip;
    tip.textContent = '';
    var head = el('div', 'o-tip-head');
    if (d.role) head.appendChild(el('span', 'role r-' + d.role, c.t('role.' + d.role)));
    head.appendChild(el('span', '', ' ' + this.activityText(d)));
    tip.appendChild(head);
    if (d.taskId) tip.appendChild(el('div', 'o-tip-line', d.taskId + (d.taskTitle ? ' · ' + d.taskTitle : '')));
    tip.appendChild(el('div', 'o-tip-line muted', (d.engine === 'codex' ? 'Codex' : 'Claude') + (d.model ? ' · ' + d.model : '') + (d.subagent ? ' · ' + c.t('sessions.subagent') : '')));
    var where = this.projectText(d);
    if (where) tip.appendChild(el('div', 'o-tip-line muted', where));
    var st = c.stats ? c.stats(it.row) : null;
    if (st) tip.appendChild(el('div', 'o-tip-line muted', st));
    tip.appendChild(el('div', 'o-tip-line muted', c.ago(d.lastActivity)));
    tip.appendChild(el('div', 'o-tip-hint', c.t('office.open')));
  };

  // The same sessions as real links: focusable, readable by screen readers.
  Scene.prototype.buildList = function () {
    var self = this;
    var c = this.ctx;
    this.listEl.textContent = '';
    this.lay.rooms.forEach(function (room) {
      room.desks.forEach(function (desk) {
        var it = desk.id && self.items[desk.id];
        if (!it) return;
        var d = it.desc;
        var parts = [];
        if (d.role) parts.push(c.t('role.' + d.role));
        parts.push(self.activityText(d));
        if (d.taskId) parts.push(d.taskId + (d.taskTitle ? ' ' + d.taskTitle : ''));
        parts.push((d.engine === 'codex' ? 'Codex' : 'Claude') + (d.model ? ' ' + d.model : ''));
        var where = self.projectText(d);
        if (where) parts.push(where);
        var st = c.stats ? c.stats(it.row) : null;
        if (st) parts.push(st);
        parts.push(c.ago(d.lastActivity));
        var a = el('a', 'o-item', parts.join(' · '));
        a.setAttribute('href', c.href(it.row));
        a.addEventListener('click', function () { c.prepare(it.row); });
        a.addEventListener('focus', function () { self.select(desk.id); });
        a.addEventListener('blur', function () { self.clear(); });
        var li = el('li', 'o-li' + (it.anim.highlight ? ' is-waiting' : ''));
        li.appendChild(a);
        self.listEl.appendChild(li);
      });
    });
  };

  // ------------------------------------------------------------------ global listeners (added once)
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (!current || !current.alive()) return;
      var main = document.getElementById('main');
      var w = Math.min((main && main.clientWidth) || 800, 1400) - 32;
      var plan = M.planFor(w);
      if (!current.plan || plan.scale !== current.plan.scale || plan.maxCols !== current.plan.maxCols || current.plan.dpr !== dpr()) current.build();   // zoom changes devicePixelRatio too
    }, 200);
  });
  document.addEventListener('visibilitychange', kick);
  var again = function () { cache = {}; if (current && current.alive()) { current.build(); kick(); } };
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', again);
  if (motionMq && motionMq.addEventListener) motionMq.addEventListener('change', function () { kick(); });

  window.Office = { page: page };
}());
