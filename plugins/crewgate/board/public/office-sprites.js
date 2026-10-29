(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeSprites = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pixel sprites for the Office page, drawn from scratch by the small raster helpers below and
  // stored as rows of palette letters ('.' is transparent). Nothing here is third-party art.
  // A theme palette maps each letter to a colour; skin, hair, engine (shirt) and role (hat) swap
  // groups of letters when a character is baked.
  //
  // Light comes from the upper left (the window side). Every material has three tones plus a rim
  // or outline tone; highlights lean toward yellow and shadows toward purple. Outlines are per
  // region (hair, skin, shirt, trousers, wood ...) instead of one black line: the lit upper-left
  // edge uses one step darker than the fill, the lower-right edge the darkest tone.

  var LEGEND = {
    o: 'ink outline', O: 'hair outline', i: 'hair outline lit', K: 'skin outline', j: 'skin outline lit', E: 'shirt outline', f: 'shirt outline lit',
    V: 'trousers outline', v: 'trousers outline lit', F: 'role outline',
    s: 'skin', S: 'skin shade', q: 'skin light', h: 'hair', H: 'hair shade', J: 'hair rim', e: 'eye', M: 'iris light', w: 'white',
    x: 'blush', m: 'mouth', b: 'shirt', d: 'shirt shade', B: 'shirt light', N: 'sleeve', r: 'role colour', R: 'role shade',
    p: 'trousers', P: 'trousers shade', z: 'shoes', g: 'light grey', G: 'mid grey', D: 'dark grey',
    t: 'wood', T: 'wood shade', Y: 'wood light', W: 'wood dark', c: 'screen off', C: 'screen light', Q: 'screen mid', I: 'screen deep',
    y: 'lamp light', n: 'coffee', l: 'leaf light', L: 'leaf', X: 'leaf shade', u: 'pot', U: 'pot shade', k: 'red', a: 'shadow light', A: 'shadow dark'
  };

  // ------------------------------------------------------------------ colour helpers and the 32-colour palette
  function rgbOf(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hexOf(c) {
    return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  function mixHex(a, b, k) {
    var x = rgbOf(a);
    var y = rgbOf(b);
    return hexOf([0, 1, 2].map(function (i) { return x[i] * (1 - k) + y[i] * k; }));
  }
  function toHsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      t = (t + 1) % 1;
      return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  // shift(hex, hue degrees, saturation, lightness)
  function shift(h, dh, ds, dl) {
    var c = toHsl(rgbOf(h));
    return hexOf(fromHsl(c[0] + dh, clamp01(c[1] + ds), clamp01(c[2] + dl)));
  }
  // A hue-shifted ramp: highlights ~+10 deg toward yellow, shadows ~-20 deg toward purple.
  function ramp(base) {
    return {
      light: shift(base, 10, -0.02, 0.09), shade: shift(base, -20, 0.04, -0.12),
      lit: shift(base, -24, 0.04, -0.17), dark: shift(base, -30, 0.06, -0.27)
    };
  }

  // The whole art uses these 32 colours (hair, skin and the night theme are ramps derived from them).
  var PALETTE32 = [
    '#2b2038', '#3d2f4f', '#5a4a6e',                                       // ink
    '#f3dcc8', '#e2c1ae', '#c79c92', '#8f6d7a',                            // wall
    '#f0c48a', '#d49a62', '#a86a45', '#6e4540',                            // wood
    '#e8c9a0', '#d2a97f',                                                  // floor
    '#ffe0c8', '#f3b999', '#d98a78',                                       // skin
    '#7a4e3c', '#4a3040',                                                  // hair
    '#bfe8f5', '#6fb7e6', '#4a78c4', '#2f4a8c',                            // blue
    '#9bd67a', '#4fa36a', '#2f6b5a',                                       // green
    '#ee6a73', '#ffd25a', '#fff8ee',                                       // red, yellow, white
    '#9b7fd4', '#6c4fa8', '#f0975f', '#c2603f'                             // purple, orange
  ];
  var P = {
    ink0: PALETTE32[0], ink1: PALETTE32[1], ink2: PALETTE32[2],
    wall0: PALETTE32[3], wall1: PALETTE32[4], wall2: PALETTE32[5], wall3: PALETTE32[6],
    wood0: PALETTE32[7], wood1: PALETTE32[8], wood2: PALETTE32[9], wood3: PALETTE32[10],
    floor0: PALETTE32[11], floor1: PALETTE32[12], skin0: PALETTE32[13], skin1: PALETTE32[14], skin2: PALETTE32[15],
    hair0: PALETTE32[16], hair1: PALETTE32[17], blue0: PALETTE32[18], blue1: PALETTE32[19], blue2: PALETTE32[20], blue3: PALETTE32[21],
    green0: PALETTE32[22], green1: PALETTE32[23], green2: PALETTE32[24], red: PALETTE32[25], yellow: PALETTE32[26], white: PALETTE32[27],
    purple: PALETTE32[28], purpleD: PALETTE32[29], orange: PALETTE32[30], orangeD: PALETTE32[31]
  };

  // ------------------------------------------------------------------ hair, skin, engine and role colour groups
  function hairSet(base, outline) {
    var r = ramp(base);
    return { h: base, H: r.shade, J: r.light, O: outline || r.dark, i: mixHex(base, outline || r.dark, 0.5) };
  }
  var HAIR_SET = [
    hairSet(P.hair0, P.hair1), hairSet('#3c3552'), hairSet('#e0a94e'), hairSet('#cbc4d4'), hairSet('#c85a4a'), hairSet('#7e60b0')
  ];
  function skinSet(base, shade, light, outline) {
    var r = ramp(base);
    return { s: base, S: shade || r.shade, q: light || r.light, K: outline || r.dark, j: mixHex(base, outline || r.dark, 0.45) };
  }
  var SKIN_SET = [
    skinSet(P.skin0, P.skin1, '#fff0e4', P.skin2), skinSet('#f3c19b'), skinSet('#d9a074'), skinSet('#a8714a')
  ];
  var ENGINES_LIGHT = {
    claude: { b: P.orange, d: P.orangeD, B: shift(P.orange, 10, 0, 0.1), E: mixHex(P.orangeD, P.ink0, 0.5), f: mixHex(P.orangeD, P.ink0, 0.22) },
    codex: { b: P.blue1, d: P.blue2, B: P.blue0, E: P.blue3, f: mixHex(P.blue2, P.blue3, 0.5) }
  };
  var ROLE_LIGHT = {
    orchestrator: { r: P.yellow, R: P.wood1, F: P.wood2 },
    worker: { r: P.green0, R: P.green1, F: P.green2 },
    reviewer: { r: P.purple, R: P.purpleD, F: mixHex(P.purpleD, P.ink0, 0.45) },
    refuter: { r: P.red, R: mixHex(P.red, P.ink1, 0.4), F: mixHex(P.red, P.ink0, 0.62) }
  };

  // Night: the same colours pulled toward the purple ink ramp.
  function night(h, k) { return mixHex(h, P.ink1, k); }
  function nightSet(set, k) {
    var out = {};
    Object.keys(set).forEach(function (key) { out[key] = typeof set[key] === 'string' ? night(set[key], k) : nightSet(set[key], k); });
    return out;
  }

  var LIGHT = {
    o: P.ink0, O: HAIR_SET[0].O, i: HAIR_SET[0].i, K: SKIN_SET[0].K, j: SKIN_SET[0].j, E: ENGINES_LIGHT.claude.E, f: ENGINES_LIGHT.claude.f,
    V: P.ink0, v: P.ink1, F: ROLE_LIGHT.worker.F,
    s: SKIN_SET[0].s, S: SKIN_SET[0].S, q: SKIN_SET[0].q, h: HAIR_SET[0].h, H: HAIR_SET[0].H, J: HAIR_SET[0].J,
    e: P.ink0, M: P.ink2, w: P.white, x: 'rgba(238,106,115,0.75)', m: P.hair1,
    b: ENGINES_LIGHT.claude.b, d: ENGINES_LIGHT.claude.d, B: ENGINES_LIGHT.claude.B, N: ENGINES_LIGHT.claude.b, r: ROLE_LIGHT.worker.r, R: ROLE_LIGHT.worker.R,
    p: P.ink2, P: P.ink1, z: P.ink1, g: P.wall1, G: P.wall3, D: P.ink2,
    t: P.wood1, T: P.wood2, Y: P.wood0, W: P.wood3, c: P.ink0, C: P.blue0, Q: P.blue1, I: P.blue3,
    y: P.yellow, n: P.hair0, l: P.green0, L: P.green1, X: P.green2, u: P.orange, U: P.orangeD, k: P.red,
    a: 'rgba(199,156,146,0.50)', A: 'rgba(143,109,122,0.50)'
  };
  var PALETTES = { light: LIGHT, dark: {} };
  (function () {
    var keep = { e: 1, M: 1, w: 1, x: 1, c: 1, C: 1, Q: 1, I: 1, y: 1 };
    Object.keys(LIGHT).forEach(function (ch) {
      if (ch === 'a') PALETTES.dark[ch] = 'rgba(20,12,30,0.40)';
      else if (ch === 'A') PALETTES.dark[ch] = 'rgba(20,12,30,0.55)';
      else if (ch === 'x') PALETTES.dark[ch] = 'rgba(238,106,115,0.65)';
      else PALETTES.dark[ch] = keep[ch] ? LIGHT[ch] : night(LIGHT[ch], 0.24);
    });
    PALETTES.dark.c = P.ink0;
    PALETTES.dark.e = P.ink0;
  }());

  // Room colours per theme, used by the renderer.
  var SCENE = {
    light: {
      wallTop: P.wall0, wallRail: P.wall1, wainscot: '#e8cbb8', panel: P.wall2, skirt: P.wall2, skirtHi: P.wall0, skirtLo: P.wall3,
      floorA: P.floor0, floorB: P.floor1, floorHi: P.wall0, floorJoint: '#bf9a7e', floorDither: P.wall3,
      rug: P.blue0, rugB: '#a9d6ec', rugEdge: P.blue1, rugStitch: P.white,
      skyTop: P.blue1, skyLow: P.blue0, cloud: P.white, frame: P.white, frameShade: P.wall1, frameLine: P.wall3, sill: P.wood0, sheen: 'rgba(255,248,238,0.55)',
      shaft: P.white, shaftAlpha: 0.12, ring: P.yellow, glow: P.blue1, tag: P.ink0,
      cork: P.wood1, corkHi: P.wood0, corkLo: P.wood2, corkFrame: P.wood3, corkText: P.white, bulb: [P.yellow, P.red, P.blue1, P.green0], wire: P.wall3,
      away: 'rgba(0,0,0,0.13)', bubble: P.white, bubbleInk: P.ink2, stars: 0, lamp: P.yellow
    },
    dark: {
      wallTop: '#3d2f4f', wallRail: '#483a5c', wainscot: '#352a45', panel: '#2b2038', skirt: '#2b2038', skirtHi: '#5a4a6e', skirtLo: '#1f1730',
      floorA: '#4a3a50', floorB: '#413247', floorHi: '#5a4a6e', floorJoint: '#2b2038', floorDither: '#1f1730',
      rug: '#3d4a78', rugB: '#34406a', rugEdge: '#4a78c4', rugStitch: '#8f9fd0',
      skyTop: '#1b1f45', skyLow: '#3d4a8c', cloud: '#5a4a6e', frame: '#6c5a86', frameShade: '#4f4068', frameLine: '#2b2038', sill: '#8f6d7a', sheen: 'rgba(191,232,245,0.28)',
      shaft: P.blue0, shaftAlpha: 0.07, ring: P.yellow, glow: P.blue1, tag: P.ink0,
      cork: '#8a5a4e', corkHi: '#a8684f', corkLo: '#6e4540', corkFrame: '#4a2f36', corkText: '#fff8ee', bulb: [P.yellow, P.red, P.blue1, P.green0], wire: '#5a4a6e',
      away: 'rgba(0,0,0,0.25)', bubble: '#e9dcf0', bubbleInk: P.ink1, stars: 1, lamp: P.yellow
    }
  };

  var ENGINES = { light: ENGINES_LIGHT, dark: nightSet(ENGINES_LIGHT, 0.14) };
  var ROLE_COLORS = { light: ROLE_LIGHT, dark: nightSet(ROLE_LIGHT, 0.08) };
  var HAIR = { light: HAIR_SET, dark: HAIR_SET.map(function (s) { return nightSet(s, 0.16); }) };
  var SKIN = { light: SKIN_SET, dark: SKIN_SET.map(function (s) { return nightSet(s, 0.12); }) };
  var STYLES = 4;
  var ROLE_NAMES = ['orchestrator', 'worker', 'reviewer', 'refuter', 'other'];
  var FRAME_NAMES = ['stand', 'blink', 'happy', 'tilt', 'walkA', 'walkB', 'walkS', 'alert', 'armB', 'look'];
  var ACCESSORIES = ['none', 'glasses', 'phones', 'scarf', 'cap', 'headset'];   // random ones: the first five (a cap only for other agents); reviewers get glasses, orchestrators a headset

  // Animation timings shared by the renderer and the tests (spec: 15 fps loop, 2.5-5 s blinks ...).
  var ANIM = {
    frameMs: 66, idleStepMs: 400, blinkMs: 120, blinkMin: 2500, blinkMax: 5000, typeMs: 140, thinkMs: 350, bounceMs: 500, bounceHeight: 2,
    sipStepMs: 400, sipSteps: 4, steamMs: 1200, steamRise: 3, coffeeCycleMs: 7000, walkMs: 160, walkFrames: 4, hopHeight: 6,
    cloudMs: 3000, typewriterMs: 55
  };
  // Seeded gap between two blinks of one character: ANIM.blinkMin .. ANIM.blinkMax milliseconds.
  function blinkGap(seed, k) {
    var h = (Math.imul((seed >>> 0) ^ Math.imul(k + 1, 2654435761), 2246822519) >>> 0);
    h = (Math.imul(h ^ (h >>> 15), 3266489917) >>> 0);
    h ^= h >>> 13;
    return ANIM.blinkMin + (h >>> 0) % (ANIM.blinkMax - ANIM.blinkMin + 1);
  }

  // ------------------------------------------------------------------ tiny raster helpers
  function grid(w, h) {
    var g = [];
    for (var y = 0; y < h; y++) { var r = []; for (var x = 0; x < w; x++) r.push('.'); g.push(r); }
    return g;
  }
  function px(g, x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = c;
  }
  function rect(g, x, y, w, h, c) { for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) px(g, x + i, y + j, c); }
  // ellipse; pick(x, y, u, v) returns the letter for a covered pixel (u, v in -1..1) or a falsy value to skip it
  function ell(g, cx, cy, rx, ry, pick) {
    for (var y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (var x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        var u = (x - cx) / (rx + 0.4);
        var v = (y - cy) / (ry + 0.4);
        if (u * u + v * v > 1) continue;
        var c = typeof pick === 'function' ? pick(x, y, u, v) : pick;
        if (c) px(g, x, y, c);
      }
    }
  }
  // three-tone sphere: light from the upper left
  function shaded(a, dark, light) {
    return function (x, y, u, v) { var k = u * 0.55 + v * 0.83; return k > 0.5 ? dark : k < -0.55 ? light : a; };
  }

  // Region outlines: a filled letter -> [outline on a lit (upper/left) edge, outline on a shadow (lower/right) edge].
  var REGION_CHAR = {
    h: ['i', 'O'], H: ['i', 'O'], J: ['i', 'O'], s: ['j', 'K'], S: ['j', 'K'], q: ['j', 'K'], x: ['j', 'K'], m: ['j', 'K'], e: ['j', 'K'], M: ['j', 'K'], w: ['j', 'K'],
    b: ['f', 'E'], d: ['f', 'E'], B: ['f', 'E'], N: ['f', 'E'], p: ['v', 'V'], P: ['v', 'V'], r: ['F', 'F'], R: ['F', 'F']
  };
  var REGION_FURN = {
    t: ['T', 'W'], T: ['W', 'W'], Y: ['T', 'W'], W: ['W', 'W'], l: ['L', 'X'], L: ['X', 'X'], X: ['X', 'X'], u: ['U', 'W'], U: ['W', 'W'],
    g: ['D', 'o'], G: ['D', 'o'], D: ['o', 'o'], k: ['D', 'o'], w: ['G', 'D'], c: ['o', 'o'], C: ['o', 'o'], y: ['T', 'W']
  };
  function outlineBy(g, map) {
    var add = [];
    var H = g.length;
    var Wd = g[0].length;
    var at = function (x, y) { return x >= 0 && y >= 0 && x < Wd && y < H ? g[y][x] : '.'; };
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < Wd; x++) {
        if (g[y][x] !== '.') continue;
        var below = at(x, y + 1);
        var right = at(x + 1, y);
        var above = at(x, y - 1);
        var left = at(x - 1, y);
        if (below === '.' && right === '.' && above === '.' && left === '.') continue;
        var lit = (below !== '.' || right !== '.') && above === '.' && left === '.';
        var src = below !== '.' ? below : right !== '.' ? right : above !== '.' ? above : left;
        var pair = map[src] || ['o', 'o'];
        add.push([x, y, lit ? pair[0] : pair[1]]);
      }
    }
    add.forEach(function (p) { g[p[1]][p[0]] = p[2]; });
  }
  // inner line: pixels of `from` (letters) that touch one of `to` (letters) on a side get `line`
  function innerLine(g, from, to, line) {
    var mark = [];
    for (var y = 0; y < g.length; y++) {
      for (var x = 0; x < g[0].length; x++) {
        if (from.indexOf(g[y][x]) < 0) continue;
        var near = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(function (p) {
          return p[1] >= 0 && p[1] < g.length && p[0] >= 0 && p[0] < g[0].length && to.indexOf(g[p[1]][p[0]]) >= 0;
        });
        if (near) mark.push([x, y]);
      }
    }
    mark.forEach(function (p) { g[p[1]][p[0]] = line; });
  }
  function rows(g) { return g.map(function (r) { return r.join(''); }); }
  function mirror(x, w) { return w - 1 - x; }

  // ------------------------------------------------------------------ characters: 24 x 32 chibi, head about 40% of the height
  var CW = 24;
  var CH = 32;
  var HEAD_ROWS = 16;      // rows 0..15 are the head (and hat); the renderer bobs the rest on its own

  function headSpan(y) { return y === 3 || y === 15 ? [8, 15] : y === 4 || y === 14 ? [6, 17] : [5, 18]; }

  function hairMask(style, x, y) {
    if (y <= 7) return true;
    if (y === 8) {
      if (style === 0) return x <= 8 || x >= 12;
      if (style === 1) return x <= 10 || x >= 13;
      if (style === 2) return x % 3 !== 0;
      return x <= 12;
    }
    var left = x <= 6;
    var rightSide = x >= 17;
    if (!left && !rightSide) return false;
    if (style === 1) return y <= 14;
    if (style === 3) return left ? y <= 11 : y <= 9;
    if (style === 2) return y <= 9;
    return y <= 10;
  }
  function hairLetter(x, y) {
    if ((y === 4 && x >= 8 && x <= 11) || (y === 5 && x >= 7 && x <= 8) || (y === 3 && x >= 9 && x <= 11)) return 'J';
    if (y === 7 || y >= 9) return 'H';
    return 'h';
  }

  function drawHead(g, hx, hy, style) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    var y, x;
    for (y = 3; y <= 15; y++) {
      var sp = headSpan(y);
      for (x = sp[0]; x <= sp[1]; x++) {
        var u = (x - 11.5) / 7.5;
        var v = (y - 9) / 7;
        var k = u * 0.5 + v * 0.85;
        px(g, X(x), Y(y), k > 0.62 ? 'S' : k < -0.78 ? 'q' : 's');
      }
    }
    for (y = 3; y <= 14; y++) {
      sp = headSpan(y);
      for (x = sp[0]; x <= sp[1]; x++) if (hairMask(style, x, y)) px(g, X(x), Y(y), hairLetter(x, y));
    }
    if (style === 2) [[7, 3], [8, 2], [11, 2], [12, 1], [12, 2], [15, 2], [16, 3]].forEach(function (p) { px(g, X(p[0]), Y(p[1]), p[1] === 3 ? 'H' : 'h'); });
    else { px(g, X(13), Y(2), 'h'); px(g, X(14), Y(1), 'h'); }
    if (style === 3) {   // a small ponytail on the right
      rect(g, X(18), Y(4), 4, 3, 'h'); rect(g, X(19), Y(7), 3, 4, 'h'); rect(g, X(20), Y(11), 2, 2, 'H');
      px(g, X(18), Y(4), 'J'); px(g, X(19), Y(4), 'J'); rect(g, X(21), Y(7), 1, 4, 'H');
    }
  }

  // Role mark: a small 4-8 px wide icon on the head (colour = role), not a full-width cap.
  function drawHat(g, role, hx, hy) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    if (role === 'orchestrator') {              // a little crown
      [9, 11, 12, 14].forEach(function (x) { px(g, X(x), Y(1), 'r'); });
      rect(g, X(9), Y(2), 6, 1, 'r'); rect(g, X(9), Y(3), 6, 1, 'R'); px(g, X(11), Y(2), 'w'); px(g, X(12), Y(2), 'k');
    } else if (role === 'worker') {             // a hard hat
      rect(g, X(10), Y(1), 4, 1, 'r'); rect(g, X(9), Y(2), 6, 1, 'r'); rect(g, X(8), Y(3), 8, 1, 'R');
      px(g, X(10), Y(2), 'w'); px(g, X(12), Y(1), 'R'); px(g, X(12), Y(2), 'R');
    } else if (role === 'reviewer') {           // a bow
      [[7, 1], [8, 1], [10, 1], [11, 1], [7, 2], [8, 2], [10, 2], [11, 2], [7, 3], [8, 3], [10, 3], [11, 3]].forEach(function (p) { px(g, X(p[0]), Y(p[1]), 'r'); });
      px(g, X(9), Y(2), 'R'); px(g, X(8), Y(3), 'R'); px(g, X(11), Y(3), 'R');
    } else if (role === 'refuter') {            // two little horns
      [[7, 3], [7, 2], [6, 2], [6, 1]].forEach(function (p, i) { px(g, X(p[0]), Y(p[1]), i === 0 ? 'R' : 'r'); px(g, X(mirror(p[0], CW)), Y(p[1]), i === 0 ? 'R' : 'r'); });
    }
  }

  // Cute face: wide-set 3x3 eyes with a highlight (they read at 2x), blush, a 1-2 px mouth that depends on the pose.
  function drawFace(g, hx, hy, mood) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    rect(g, X(6), Y(13), 2, 1, 'x'); rect(g, X(16), Y(13), 2, 1, 'x');
    [7, 14].forEach(function (ex0) {
      var ex = mood === 'look' ? ex0 - 1 : ex0;
      if (mood === 'blink') {
        rect(g, X(ex), Y(11), 3, 1, 'e');
      } else if (mood === 'happy') {
        px(g, X(ex), Y(11), 'e'); px(g, X(ex + 1), Y(10), 'e'); px(g, X(ex + 2), Y(11), 'e');
      } else {
        rect(g, X(ex), Y(10), 3, 2, 'e'); rect(g, X(ex), Y(12), 3, 1, 'M');
        px(g, X(ex), Y(10), 'w');
      }
    });
    if (mood === 'alert') { rect(g, X(11), Y(13), 2, 2, 'm'); }
    else if (mood === 'happy') { px(g, X(10), Y(13), 'm'); px(g, X(13), Y(13), 'm'); px(g, X(11), Y(14), 'm'); px(g, X(12), Y(14), 'm'); }
    else { px(g, X(11), Y(14), 'm'); px(g, X(12), Y(14), 'm'); }
  }

  // Accessories (colour-neutral so the role mark and the engine shirt stay readable).
  function drawAcc(g, acc, role, hx, hy) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    if (acc === 'glasses') {
      // thin frames: a top rim and the sides of each lens, the eyes stay open; a bridge and two temples
      [6, 13].forEach(function (x0) { rect(g, X(x0), Y(9), 5, 1, 'G'); px(g, X(x0), Y(10), 'G'); px(g, X(x0 + 4), Y(10), 'G'); px(g, X(x0), Y(11), 'G'); px(g, X(x0 + 4), Y(11), 'G'); });
      px(g, X(11), Y(10), 'G'); px(g, X(12), Y(10), 'G'); px(g, X(5), Y(10), 'G'); px(g, X(18), Y(10), 'G');
    } else if (acc === 'phones' || acc === 'headset') {
      rect(g, X(4), Y(8), 2, 5, 'D'); rect(g, X(18), Y(8), 2, 5, 'D'); px(g, X(4), Y(8), 'G'); px(g, X(18), Y(8), 'G');
      [[5, 4], [6, 3], [7, 3], [16, 3], [17, 3], [18, 4]].forEach(function (p) { px(g, X(p[0]), Y(p[1]), 'D'); });
      if (acc === 'headset') { px(g, X(4), Y(13), 'D'); px(g, X(5), Y(14), 'D'); px(g, X(6), Y(14), 'k'); }
    } else if (acc === 'scarf') {
      rect(g, X(8), Y(16), 8, 2, 'Q'); rect(g, X(8), Y(17), 8, 1, 'I'); rect(g, X(15), Y(18), 2, 4, 'Q'); px(g, X(16), Y(21), 'I'); px(g, X(15), Y(20), 'I');
    } else if (acc === 'cap') {
      rect(g, X(6), Y(3), 12, 3, 'I'); rect(g, X(7), Y(2), 10, 1, 'I'); rect(g, X(8), Y(3), 4, 1, 'Q'); rect(g, X(14), Y(6), 7, 1, 'I'); rect(g, X(6), Y(6), 12, 1, 'I'); px(g, X(12), Y(2), 'Q');
    }
  }

  var cache = {};
  function buildChar(frame, style, role, acc) {
    var g = grid(CW, CH);
    var walk = frame === 'walkA' ? 1 : frame === 'walkB' ? -1 : 0;
    var hx = frame === 'tilt' ? 1 : 0;
    var hy = frame === 'tilt' ? 1 : 0;
    // legs and shoes
    var lUp = walk > 0 ? 1 : 0;
    var rUp = walk < 0 ? 1 : 0;
    rect(g, 8, 25 - lUp, 4, 4, 'p'); rect(g, 12, 25 - rUp, 4, 4, 'p');
    rect(g, 11, 25 - lUp, 1, 4, 'P'); rect(g, 15, 25 - rUp, 1, 4, 'P');
    rect(g, 7, 29 - lUp, 5, 2, 'z'); rect(g, 12, 29 - rUp, 5, 2, 'z');
    // torso, arms
    rect(g, 7, 16, 10, 9, 'b'); rect(g, 8, 17, 2, 3, 'B'); rect(g, 15, 17, 2, 8, 'd'); rect(g, 7, 23, 10, 2, 'd');
    px(g, 11, 16, 'S'); px(g, 12, 16, 'S');
    var ay = walk * -1;
    var raise = frame === 'armB' ? -1 : 0;
    rect(g, 5, 17 + ay, 2, 6, 'N'); rect(g, 17, 17 - ay + raise, 2, 6, 'N');
    rect(g, 5, 23 + ay, 2, 2, 's'); rect(g, 17, 23 - ay + raise, 2, 2, 's');
    px(g, 5, 18 + ay, 'B');
    // head
    drawHead(g, hx, hy, style);
    drawFace(g, hx, hy, frame === 'blink' ? 'blink' : frame === 'happy' ? 'happy' : frame === 'alert' ? 'alert' : frame === 'look' ? 'look' : 'open');
    if (acc && acc !== 'none' && !(acc === 'cap' && role !== 'other')) drawAcc(g, acc, role, hx, hy);
    if (role !== 'other') drawHat(g, role, hx, hy);
    if (role === 'orchestrator') {   // lanyard with a badge
      [[9, 16], [10, 17], [11, 18], [14, 16], [13, 17], [12, 18]].forEach(function (p) { px(g, p[0], p[1], 'k'); });
      rect(g, 11, 19, 2, 3, 'w'); px(g, 11, 19, 'Q');
    }
    if (role === 'refuter' && frame !== 'walkA' && frame !== 'walkB') {   // arms crossed, a red pen in the sleeve
      rect(g, 7, 19, 10, 2, 'N'); rect(g, 5, 20, 2, 1, 'N'); rect(g, 17, 20, 2, 1, 'N'); rect(g, 7, 21, 3, 1, 's'); rect(g, 14, 21, 3, 1, 's');
      px(g, 17, 18, 'k'); px(g, 18, 17, 'k');
    }
    // 1 px inner lines: hair against face, sleeve against torso
    innerLine(g, ['h', 'J'], ['s', 'S', 'q'], 'H');
    innerLine(g, ['N'], ['b', 'd', 'B'], 'd');
    for (var y = 0; y < CH; y++) for (var x = 0; x < CW; x++) if (g[y][x] === 'N') g[y][x] = x > 11 ? 'd' : 'b';
    outlineBy(g, REGION_CHAR);
    return rows(g);
  }
  // character(frame, style, role) -> rows (memoised)
  function character(frame, style, role, acc) {
    acc = acc || 'none';
    var key = frame + '.' + style + '.' + role + '.' + acc;
    if (!cache[key]) cache[key] = buildChar(frame, style, role, acc);
    return cache[key];
  }

  // ------------------------------------------------------------------ furniture and props
  function make(w, h, draw, edge) {
    var g = grid(w, h);
    draw(g);
    if (edge !== false) outlineBy(g, REGION_FURN);
    return rows(g);
  }

  // desk: top surface (10 rows, lit edge at the back), front panel with a drawer, legs
  var desk = make(42, 18, function (g) {
    rect(g, 1, 1, 40, 8, 't'); rect(g, 1, 1, 40, 1, 'Y'); rect(g, 1, 8, 40, 1, 'T');
    rect(g, 3, 4, 8, 1, 'T'); rect(g, 25, 5, 9, 1, 'T');                       // grain
    rect(g, 2, 9, 38, 6, 'T'); rect(g, 2, 9, 38, 1, 'W'); rect(g, 2, 10, 38, 1, 't');
    rect(g, 14, 11, 14, 4, 't'); rect(g, 14, 11, 14, 1, 'Y'); rect(g, 14, 14, 14, 1, 'W'); rect(g, 19, 12, 4, 1, 'G'); px(g, 19, 12, 'g');
    rect(g, 3, 15, 3, 2, 'W'); rect(g, 36, 15, 3, 2, 'W');
  });
  var chair = make(20, 16, function (g) {
    ell(g, 10, 6, 7, 6, shaded('Q', 'I', 'C'));
    rect(g, 6, 12, 9, 3, 'I'); rect(g, 6, 12, 9, 1, 'Q');
  });
  // monitor: bezel with a rim tone, a 12 x 7 screen at (3, 3), neck and foot (small next to the people, so faces read bigger)
  var monitor = make(18, 16, function (g) {
    rect(g, 1, 1, 16, 10, 'D'); rect(g, 1, 1, 16, 1, 'G'); rect(g, 1, 1, 1, 10, 'G'); rect(g, 16, 2, 1, 9, 'c');
    rect(g, 3, 3, 12, 7, 'c');
    rect(g, 7, 11, 4, 2, 'D'); rect(g, 7, 11, 1, 2, 'G'); rect(g, 4, 13, 10, 2, 'D'); rect(g, 4, 13, 10, 1, 'G');
  });
  var keyboard = make(16, 5, function (g) {
    rect(g, 1, 1, 14, 3, 'g'); rect(g, 1, 3, 14, 1, 'G');
    for (var i = 2; i < 14; i += 2) { px(g, i, 1, 'w'); px(g, i, 2, 'G'); }
  });
  var handsA = make(12, 3, function (g) { rect(g, 1, 0, 3, 2, 's'); rect(g, 8, 0, 3, 2, 's'); rect(g, 1, 1, 3, 1, 'S'); rect(g, 8, 1, 3, 1, 'S'); }, false);
  var handsB = make(12, 3, function (g) { rect(g, 2, 0, 3, 2, 's'); rect(g, 7, 0, 3, 2, 's'); rect(g, 2, 1, 3, 1, 'S'); rect(g, 7, 1, 3, 1, 'S'); }, false);
  var mug = make(9, 8, function (g) {
    rect(g, 1, 1, 5, 6, 'w'); rect(g, 5, 1, 1, 6, 'g'); rect(g, 1, 1, 5, 1, 'n');
    px(g, 6, 2, 'w'); px(g, 7, 3, 'w'); px(g, 7, 4, 'w'); px(g, 6, 5, 'w');
  });
  function lamp(on) {
    return make(10, 13, function (g) {
      ell(g, 5, 3, 4, 3, on ? shaded('y', 'Y', 'w') : shaded('G', 'D', 'g'));
      rect(g, 5, 6, 1, 5, 'D'); rect(g, 3, 10, 5, 2, 'D'); rect(g, 3, 10, 5, 1, 'G');
    });
  }
  var plant = make(18, 24, function (g) {
    ell(g, 6, 8, 4, 6, shaded('L', 'X', 'l')); ell(g, 12, 7, 4, 6, shaded('L', 'X', 'l')); ell(g, 9, 5, 3, 5, shaded('l', 'L', 'l'));
    rect(g, 4, 15, 10, 8, 'u'); rect(g, 11, 15, 3, 8, 'U'); rect(g, 3, 14, 12, 2, 'U'); rect(g, 4, 14, 8, 1, 'u');
  });
  var plant2 = make(14, 28, function (g) {          // snake plant: tall pointed leaves
    [[3, 4, 3], [6, 1, 3], [9, 3, 3], [11, 7, 2]].forEach(function (p) { rect(g, p[0], p[1], p[2], 17 - p[1], 'L'); rect(g, p[0], p[1] + 1, 1, 15 - p[1], 'l'); rect(g, p[0] + p[2] - 1, p[1] + 3, 1, 14 - p[1], 'X'); });
    rect(g, 2, 19, 10, 8, 'u'); rect(g, 9, 19, 3, 8, 'U'); rect(g, 1, 18, 12, 2, 'U'); rect(g, 2, 18, 8, 1, 'u');
  });
  var bookcase = make(24, 30, function (g) {
    rect(g, 1, 1, 22, 28, 't'); rect(g, 1, 1, 22, 1, 'Y'); rect(g, 20, 2, 3, 27, 'T');
    var colors = ['k', 'Q', 'l', 'y', 'k', 'I'];
    [0, 1, 2].forEach(function (s) {
      var y0 = 3 + s * 9;
      rect(g, 2, y0 + 6, 18, 2, 'W'); rect(g, 2, y0, 18, 6, 'c');
      var x = 3;
      for (var i = 0; i < 6; i++) { var w = 2 + ((i + s) % 2); rect(g, x, y0 + 1 + ((i * 2 + s) % 2), w, 5 - ((i * 2 + s) % 2), colors[(i + s * 2) % colors.length]); px(g, x, y0 + 1 + ((i * 2 + s) % 2), 'w'); x += w; }
    });
    rect(g, 3, 28, 18, 1, 'W');
  });
  var coffee = make(20, 26, function (g) {
    rect(g, 1, 1, 18, 24, 'D'); rect(g, 1, 1, 18, 1, 'G'); rect(g, 2, 2, 16, 8, 'G'); rect(g, 3, 3, 7, 5, 'g'); px(g, 13, 4, 'k'); px(g, 15, 4, 'l'); px(g, 3, 3, 'w');
    rect(g, 7, 12, 6, 3, 'D'); rect(g, 7, 15, 6, 5, 'c'); rect(g, 8, 18, 4, 3, 'w'); rect(g, 8, 18, 4, 1, 'n'); rect(g, 3, 22, 14, 2, 'G'); rect(g, 3, 22, 14, 1, 'g');
  });
  // wall props (static, baked into the background)
  var shelf = make(30, 14, function (g) {
    rect(g, 0, 10, 30, 3, 't'); rect(g, 0, 10, 30, 1, 'Y'); rect(g, 0, 12, 30, 1, 'T');
    var books = [['k', 7], ['Q', 6], ['l', 8], ['y', 6], ['r', 7], ['I', 6]];
    var x = 1;
    books.slice(0, 5).forEach(function (b, i) { var w = 2 + (i % 2); rect(g, x, 10 - b[1], w, b[1], b[0]); px(g, x, 10 - b[1], 'w'); x += w; });
    rect(g, 18, 3, 5, 7, 'w'); rect(g, 22, 3, 1, 7, 'g'); rect(g, 18, 3, 5, 1, 'n'); px(g, 23, 4, 'w'); px(g, 24, 5, 'w'); px(g, 24, 6, 'w'); px(g, 23, 7, 'w');
    rect(g, 26, 5, 3, 5, 'u'); rect(g, 26, 5, 1, 5, 'U'); px(g, 27, 3, 'l'); px(g, 28, 4, 'L'); px(g, 26, 4, 'L');
  });
  var picture = make(16, 20, function (g) {
    rect(g, 1, 1, 14, 18, 'T'); rect(g, 1, 1, 14, 1, 'Y'); rect(g, 1, 1, 1, 18, 'Y');
    rect(g, 3, 3, 10, 14, 'C'); rect(g, 3, 9, 10, 8, 'l');
    ell(g, 5, 6, 2, 2, 'y'); rect(g, 7, 10, 6, 7, 'L'); rect(g, 9, 8, 4, 2, 'L'); rect(g, 3, 14, 10, 3, 'X'); px(g, 11, 5, 'w'); px(g, 12, 5, 'w');
  });
  var clock = make(15, 15, function (g) {
    ell(g, 7, 7, 6, 6, shaded('w', 'g', 'w'));
    rect(g, 7, 3, 1, 5, 'D'); rect(g, 7, 7, 3, 1, 'D'); px(g, 7, 7, 'k'); px(g, 7, 2, 'G'); px(g, 7, 12, 'G'); px(g, 2, 7, 'G'); px(g, 12, 7, 'G');
  });
  // two-tone drop shadows, offset right and down by the renderer
  var shadowDesk = make(48, 8, function (g) { ell(g, 23.5, 3.5, 23, 3.5, 'a'); ell(g, 21.5, 3, 19, 2.2, 'A'); }, false);
  var shadowChar = make(22, 6, function (g) { ell(g, 10.5, 2.5, 10, 2.5, 'a'); ell(g, 9.5, 2.5, 6.5, 1.4, 'A'); }, false);
  var shadowProp = make(26, 6, function (g) { ell(g, 12.5, 2.5, 12, 2.5, 'a'); ell(g, 11.5, 2.5, 8, 1.4, 'A'); }, false);
  var sofaBack = make(60, 18, function (g) {
    rect(g, 1, 1, 58, 15, 'Q'); rect(g, 1, 1, 58, 2, 'C'); rect(g, 1, 13, 58, 3, 'I');
    [20, 40].forEach(function (x) { rect(g, x, 3, 1, 10, 'I'); });
  });
  var sofaFront = make(60, 18, function (g) {
    rect(g, 1, 4, 58, 9, 'Q'); rect(g, 1, 4, 58, 2, 'C'); rect(g, 1, 11, 58, 2, 'I');
    rect(g, 0, 0, 5, 14, 'I'); rect(g, 0, 0, 5, 2, 'Q'); rect(g, 55, 0, 5, 14, 'I'); rect(g, 55, 0, 5, 2, 'Q');
    [20, 40].forEach(function (x) { rect(g, x, 6, 1, 6, 'I'); });
    rect(g, 3, 14, 3, 3, 'W'); rect(g, 54, 14, 3, 3, 'W');
  });
  var paper = make(7, 9, function (g) { rect(g, 1, 1, 5, 7, 'w'); rect(g, 2, 3, 3, 1, 'G'); rect(g, 2, 5, 3, 1, 'G'); px(g, 5, 1, 'g'); });
  var clipboard = make(8, 10, function (g) { rect(g, 1, 1, 6, 8, 'T'); rect(g, 2, 2, 4, 6, 'w'); rect(g, 3, 0, 2, 2, 'D'); rect(g, 3, 4, 2, 1, 'G'); rect(g, 3, 6, 2, 1, 'G'); });
  var magnifier = make(9, 9, function (g) { ell(g, 3, 3, 2.6, 2.6, 'D'); ell(g, 3, 3, 1.5, 1.5, 'C'); px(g, 2, 2, 'w'); rect(g, 6, 6, 2, 2, 'W'); });
  var cloud = make(16, 6, function (g) { rect(g, 2, 3, 12, 3, 'w'); rect(g, 4, 1, 5, 3, 'w'); rect(g, 8, 2, 5, 2, 'w'); rect(g, 2, 5, 12, 1, 'g'); }, false);
  var arrow = make(7, 5, function (g) { rect(g, 0, 0, 7, 1, 'y'); rect(g, 1, 1, 5, 1, 'y'); rect(g, 2, 2, 3, 1, 'y'); px(g, 3, 3, 'y'); }, false);

  function icon(draw) { var g = grid(11, 11); draw(g); outlineBy(g, REGION_FURN); return rows(g); }
  var iconFile = icon(function (g) {
    rect(g, 2, 0, 7, 11, 'w'); rect(g, 6, 0, 3, 3, 'g'); rect(g, 6, 3, 3, 1, 'g');
    rect(g, 3, 5, 5, 1, 'G'); rect(g, 3, 7, 5, 1, 'G'); rect(g, 3, 9, 3, 1, 'G');
  });
  var iconTerminal = icon(function (g) {
    rect(g, 0, 1, 11, 9, 'D');
    [[2, 3], [3, 4], [2, 5]].forEach(function (p) { px(g, p[0], p[1], 'l'); });
    rect(g, 5, 6, 3, 1, 'l');
  });
  var iconSearch = icon(function (g) {
    ell(g, 4, 4, 3.4, 3.4, 'D');
    ell(g, 4, 4, 2.2, 2.2, 'C'); px(g, 3, 3, 'w');
    [[7, 7], [8, 8], [9, 9], [7, 8], [8, 7], [8, 9], [9, 8], [10, 10]].forEach(function (p) { px(g, p[0], p[1], 'W'); });
  });
  var iconAgent = icon(function (g) {
    rect(g, 4, 3, 1, 3, 'D'); rect(g, 2, 5, 7, 1, 'D'); rect(g, 2, 5, 1, 3, 'D'); rect(g, 8, 5, 1, 3, 'D');
    [[5, 1], [2, 8], [8, 8]].forEach(function (p) { ell(g, p[0], p[1], 1.6, 1.6, 'D'); ell(g, p[0], p[1], 0.9, 0.9, 'C'); });
  });
  var iconGear = icon(function (g) {
    ell(g, 5, 5, 3.4, 3.4, 'G');
    [[5, 0], [5, 10], [0, 5], [10, 5], [1, 1], [9, 1], [1, 9], [9, 9]].forEach(function (p) { px(g, p[0], p[1], 'G'); });
    ell(g, 5, 5, 1.2, 1.2, 'w');
  });
  var iconGlobe = icon(function (g) {
    ell(g, 5, 5, 4.4, 4.4, shaded('Q', 'I', 'C'));
    rect(g, 3, 3, 3, 2, 'l'); rect(g, 6, 6, 2, 3, 'l'); rect(g, 5, 0, 1, 11, 'I'); rect(g, 0, 5, 11, 1, 'I');
  });
  var excl = make(11, 11, function (g) { rect(g, 4, 0, 3, 7, 'k'); rect(g, 4, 8, 3, 3, 'k'); rect(g, 5, 1, 1, 4, 'q'); }, false);

  var SPRITES = {
    desk: desk, chair: chair, monitor: monitor, keyboard: keyboard, handsA: handsA, handsB: handsB, mug: mug,
    lampOn: lamp(true), lampOff: lamp(false), plant: plant, plant2: plant2, bookcase: bookcase, coffee: coffee,
    cloud: cloud, shelf: shelf, picture: picture, clock: clock, arrow: arrow,
    shadowDesk: shadowDesk, shadowChar: shadowChar, shadowProp: shadowProp,
    excl: excl, iconFile: iconFile, iconTerminal: iconTerminal, iconSearch: iconSearch, iconAgent: iconAgent, iconGear: iconGear, iconGlobe: iconGlobe,
    sofaBack: sofaBack, sofaFront: sofaFront, paper: paper, clipboard: clipboard, magnifier: magnifier
  };

  // Where things sit inside a 48 x 72 desk cell (renderer and tests share these).
  var CELL = {
    w: 48, h: 72, charX: 18, charY: 28, deskX: 3, deskY: 53, monX: 3, monY: 41, kbX: 21, kbY: 56, handsX: 22, handsY: 54,
    mugX: 37, mugY: 54, lampX: 37, lampY: 42, chairX: 20, chairY: 44, bubbleX: 16, bubbleY: 0, shadowX: 1, shadowY: 67,
    screen: { x: 3, y: 3, w: 12, h: 7 }
  };
  // The lounge corner (offsets inside the lounge strip of a room; office-model.js places the seats with the same numbers).
  var LOUNGE = { sofaX: 2, sofaBackY: 8, sofaFrontY: 26, coffeeX: 70, coffeeY: 14, plantX: 98, plantY: 12 };

  // ------------------------------------------------------------------ 5 x 7 pixel font (name tags, project name on the cork board)
  var FONT = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], 3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], 9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'], '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'], '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
    ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'], '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
    '…': ['.....', '.....', '.....', '.....', '.....', '.....', '#.#.#'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....']
  };
  // 3 x 5 pixels, letters only: small name plates
  var FONT_SMALL = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'], G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
    I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'], K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['.#.', '#.#', '#.#', '#.#', '.#.'], P: ['##.', '#.#', '##.', '#..', '#..'],
    Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'], S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###']
  };
  function glyphSmall(ch) { return FONT_SMALL[String(ch).toUpperCase()] || null; }
  function textWidthSmall(s) { return s.length ? s.length * 4 - 1 : 0; }
  var FONT_W = 5;
  var FONT_H = 7;
  // glyph(ch) -> 7 strings of 5 chars ('#' = ink). Unknown characters give null (the renderer skips them).
  function glyph(ch) { return FONT[String(ch).toUpperCase()] || null; }
  function textWidth(s) { return s.length ? s.length * (FONT_W + 1) - 1 : 0; }

  function size(rows2) { return { w: rows2[0].length, h: rows2.length }; }

  // toIndices(rows) -> rows of palette-letter indices (into Object.keys(LEGEND)) or -1 for transparent.
  function toIndices(rows2) {
    var keys = Object.keys(LEGEND);
    return rows2.map(function (row) { return row.split('').map(function (ch) { return ch === '.' ? -1 : keys.indexOf(ch); }); });
  }

  function all() {
    var out = [];
    Object.keys(SPRITES).forEach(function (n) { out.push([n, SPRITES[n]]); });
    FRAME_NAMES.forEach(function (f) {
      for (var s = 0; s < STYLES; s++) ROLE_NAMES.forEach(function (r) { out.push(['char.' + f + '.' + s + '.' + r, character(f, s, r)]); });
    });
    return out;
  }

  return {
    LEGEND: LEGEND, PALETTES: PALETTES, PALETTE32: PALETTE32, SCENE: SCENE, ENGINES: ENGINES, ROLE_COLORS: ROLE_COLORS, HAIR: HAIR, SKIN: SKIN,
    STYLES: STYLES, ROLE_NAMES: ROLE_NAMES, FRAME_NAMES: FRAME_NAMES, CHAR_W: CW, CHAR_H: CH, HEAD_ROWS: HEAD_ROWS, ANIM: ANIM, blinkGap: blinkGap,
    character: character, SPRITES: SPRITES, CELL: CELL, LOUNGE: LOUNGE, ACCESSORIES: ACCESSORIES, size: size, toIndices: toIndices, all: all,
    FONT: FONT, FONT_W: FONT_W, FONT_H: FONT_H, glyph: glyph, textWidth: textWidth, glyphSmall: glyphSmall, textWidthSmall: textWidthSmall, FONT_SMALL: FONT_SMALL, mixHex: mixHex
  };
}));
