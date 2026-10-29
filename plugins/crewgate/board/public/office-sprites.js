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

  var LEGEND = {
    o: 'outline', s: 'skin', S: 'skin shade', q: 'skin light', h: 'hair', H: 'hair shade', J: 'hair light', e: 'eye', w: 'white',
    x: 'blush', m: 'mouth', b: 'shirt', d: 'shirt shade', B: 'shirt light', r: 'role colour', R: 'role shade', p: 'trousers', P: 'trousers shade',
    z: 'shoes', g: 'light grey', G: 'mid grey', D: 'dark grey', t: 'wood', T: 'wood shade', Y: 'wood light', c: 'screen off', C: 'screen on',
    y: 'lamp light', n: 'coffee', l: 'leaf', L: 'leaf shade', u: 'pot', U: 'pot shade', k: 'red', a: 'soft shadow'
  };

  var PALETTES = {
    light: {
      o: '#6a4a5e', s: '#ffd9bd', S: '#f0b998', q: '#ffe9d6', h: '#6b4a3a', H: '#4d3328', J: '#8d6a55', e: '#3a2740', w: '#ffffff',
      x: '#ff9fa8', m: '#c4495b', b: '#f29b6b', d: '#d4764a', B: '#ffc29a', r: '#f7c531', R: '#d99a12', p: '#5d6f9e', P: '#485884',
      z: '#4a3b55', g: '#e6e3ec', G: '#b3aec0', D: '#6c667c', t: '#e0b07a', T: '#c08c58', Y: '#f2cfa0', c: '#3a4357', C: '#9fe6ff',
      y: '#ffe27a', n: '#7a4a2a', l: '#6fcf7f', L: '#46a65a', u: '#e58a62', U: '#c26a48', k: '#ee5f6a', a: 'rgba(80,55,70,0.20)'
    },
    dark: {
      o: '#140e1c', s: '#ffd9bd', S: '#f0b998', q: '#ffe9d6', h: '#6b4a3a', H: '#4d3328', J: '#8d6a55', e: '#2a1c33', w: '#f4f2f8',
      x: '#ff9fa8', m: '#c4495b', b: '#f0a074', d: '#c97a50', B: '#ffc9a6', r: '#ffd24d', R: '#e0a82a', p: '#56679a', P: '#41507f',
      z: '#2f2538', g: '#bdb9c8', G: '#8a8598', D: '#464258', t: '#b98852', T: '#946a3c', Y: '#d4a674', c: '#161b28', C: '#6fd3f2',
      y: '#ffe27a', n: '#7a4a2a', l: '#6fcf7f', L: '#46a65a', u: '#d9794f', U: '#b05a38', k: '#ff6b76', a: 'rgba(0,0,0,0.30)'
    }
  };

  // Room colours per theme, used by the renderer.
  var SCENE = {
    light: {
      wall: '#f6e8dc', wallLow: '#ecd4c0', base: '#c9a58a', floorA: '#ecd0a3', floorB: '#e5c698', grain: '#d9b684', rug: '#cddcf3', rugEdge: '#e2ecfa',
      skyTop: '#a9dcff', skyLow: '#e4f5ff', cloud: '#ffffff', frame: '#fffaf3', ring: '#f2a900', away: 'rgba(0,0,0,0.13)'
    },
    dark: {
      wall: '#3d3552', wallLow: '#342d47', base: '#241f33', floorA: '#4d3d36', floorB: '#473831', grain: '#3a2d28', rug: '#3e4b72', rugEdge: '#4f5e8c',
      skyTop: '#1c2751', skyLow: '#37477f', cloud: '#5d6ca3', frame: '#6b5f86', ring: '#ffc233', away: 'rgba(0,0,0,0.25)'
    }
  };

  var ENGINES = {   // shirt colours: Claude warm, Codex blue (colour only, no logos)
    light: { claude: { b: '#f29b6b', d: '#d4764a', B: '#ffc29a' }, codex: { b: '#6fa0f2', d: '#4c78cc', B: '#a5c6ff' } },
    dark: { claude: { b: '#f0a074', d: '#c97a50', B: '#ffc9a6' }, codex: { b: '#82aef7', d: '#5a86d6', B: '#b3d0ff' } }
  };
  var ROLE_COLORS = {
    light: {
      orchestrator: { r: '#f7c531', R: '#d99a12' }, worker: { r: '#56c27a', R: '#34995a' },
      reviewer: { r: '#9b72e0', R: '#7650b8' }, refuter: { r: '#ef6a64', R: '#c94842' }
    },
    dark: {
      orchestrator: { r: '#ffd24d', R: '#e0a82a' }, worker: { r: '#6bd68f', R: '#46ad6b' },
      reviewer: { r: '#b08cf2', R: '#8a66cc' }, refuter: { r: '#ff827b', R: '#d95a54' }
    }
  };
  var HAIR_SET = [
    { h: '#6b4a3a', H: '#4d3328', J: '#8d6a55' }, { h: '#2f2a38', H: '#1f1b27', J: '#4b4458' }, { h: '#d9a24a', H: '#b57f2b', J: '#f2c673' },
    { h: '#c9c2d0', H: '#9f98a8', J: '#e8e3ee' }, { h: '#c85a4a', H: '#a03f33', J: '#e68a78' }, { h: '#7a5ca8', H: '#5b4283', J: '#9d82c8' }
  ];
  var SKIN_SET = [
    { s: '#ffd9bd', S: '#f0b998', q: '#ffe9d6' }, { s: '#f3c19b', S: '#dc9f78', q: '#fbd6b8' },
    { s: '#d9a074', S: '#b87c52', q: '#e8b992' }, { s: '#a8714a', S: '#86553a', q: '#c08a62' }
  ];
  var HAIR = { light: HAIR_SET, dark: HAIR_SET };
  var SKIN = { light: SKIN_SET, dark: SKIN_SET };
  var STYLES = 4;
  var ROLE_NAMES = ['orchestrator', 'worker', 'reviewer', 'refuter', 'other'];
  var FRAME_NAMES = ['stand', 'blink', 'happy', 'tilt', 'walkA', 'walkB'];

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
    return function (x, y, u, v) { var k = u * 0.55 + v * 0.83; return k > 0.66 ? dark : k < -0.7 ? light : a; };
  }
  function outline(g, c) {
    var add = [];
    for (var y = 0; y < g.length; y++) {
      for (var x = 0; x < g[0].length; x++) {
        if (g[y][x] !== '.') continue;
        var n = (y > 0 && g[y - 1][x] !== '.') || (y < g.length - 1 && g[y + 1][x] !== '.') || (x > 0 && g[y][x - 1] !== '.') || (x < g[0].length - 1 && g[y][x + 1] !== '.');
        if (n) add.push([x, y]);
      }
    }
    add.forEach(function (p) { g[p[1]][p[0]] = c; });
  }
  function rows(g) { return g.map(function (r) { return r.join(''); }); }
  function mirror(x, w) { return w - 1 - x; }

  // ------------------------------------------------------------------ characters: 24 x 32 chibi
  var CW = 24;
  var CH = 32;

  function fringeAt(style, lx) {
    if (style === 0) return lx >= 4 && lx <= 20 && lx % 4 !== 1;
    if (style === 1) return (lx >= 3 && lx <= 10) || (lx >= 14 && lx <= 21);
    if (style === 2) return lx >= 4 && lx <= 20 && lx % 3 !== 0;
    return lx >= 3 && lx <= 16;
  }

  function drawHair(g, hx, hy, style) {
    ell(g, 12 + hx, 11 + hy, 10, 9, function (x, y) {
      var ly = y - hy;
      var lx = x - hx;
      var side = style === 1 ? (ly <= 17 && (lx <= 4 || lx >= 20))
        : style === 3 ? ((ly <= 12 && lx >= 20) || (ly <= 16 && lx <= 3))
          : (ly <= 12 && (lx <= 3 || lx >= 21));
      var on = ly <= 7 || side || (ly === 8 && fringeAt(style, lx)) || (style === 1 && ly === 9 && (lx <= 5 || lx >= 19));
      if (!on) return null;
      if ((ly === 4 || ly === 5) && lx >= 6 && lx <= 10) return 'J';
      if (ly === 7 || ly === 8 || (side && ly > 11)) return 'H';
      return 'h';
    });
    if (style === 2) [[6, 1], [10, 0], [10, 1], [14, 0], [14, 1], [18, 1], [6, 2], [18, 2]].forEach(function (p) { px(g, p[0] + hx, p[1] + hy, 'h'); });
    if (style === 3) ell(g, 18 + hx, 3 + hy, 3, 3, shaded('h', 'H', 'J'));
  }

  function drawHat(g, role, hx, hy) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    var i;
    if (role === 'orchestrator') {
      rect(g, X(6), Y(4), 12, 3, 'r');
      rect(g, X(6), Y(6), 12, 1, 'R');
      [6, 11, 12, 17].forEach(function (x) { px(g, X(x), Y(3), 'r'); px(g, X(x), Y(2), 'r'); });
      [11, 12].forEach(function (x) { px(g, X(x), Y(1), 'r'); });
      px(g, X(6), Y(1), 'r'); px(g, X(17), Y(1), 'r');
      px(g, X(12), Y(5), 'w');
    } else if (role === 'worker') {
      ell(g, X(12), Y(6), 8, 5, function (x, y) { return y - hy <= 7 ? (y - hy >= 7 ? 'R' : 'r') : null; });
      rect(g, X(3), Y(7), 18, 1, 'r');
      rect(g, X(3), Y(8), 18, 1, 'R');
      rect(g, X(11), Y(1), 2, 6, 'R');
    } else if (role === 'reviewer') {
      for (i = 0; i < 3; i++) rect(g, X(8 - i * 3), Y(1 + i), 8 + i * 6, 1, 'r');
      rect(g, X(7), Y(4), 10, 3, 'R');
      rect(g, X(21), Y(3), 1, 6, 'y');
      px(g, X(21), Y(9), 'y');
    } else if (role === 'refuter') {
      [[3, 5], [3, 4], [3, 3], [3, 2], [4, 2], [4, 1], [5, 0], [4, 3], [4, 4], [4, 5], [5, 5], [5, 6]].forEach(function (p) { px(g, X(p[0]), Y(p[1]), 'r'); px(g, X(mirror(p[0], CW)), Y(p[1]), 'r'); });
      px(g, X(5), Y(0), 'w'); px(g, X(18), Y(0), 'w');
    }
  }

  function drawFace(g, hx, hy, eyes) {
    var X = function (x) { return x + hx; };
    var Y = function (y) { return y + hy; };
    rect(g, X(4), Y(16), 3, 2, 'x');
    rect(g, X(17), Y(16), 3, 2, 'x');
    [8, 16].forEach(function (cx) {
      if (eyes === 'blink') {
        [[-2, 0], [-1, 1], [0, 1], [1, 1], [2, 0]].forEach(function (p) { px(g, X(cx + p[0]), Y(14 + p[1]), 'e'); });
      } else if (eyes === 'happy') {
        [[-2, 1], [-1, 0], [0, -1], [1, 0], [2, 1]].forEach(function (p) { px(g, X(cx + p[0]), Y(14 + p[1]), 'e'); px(g, X(cx + p[0]), Y(15 + p[1]), 'e'); });
      } else {
        ell(g, X(cx), Y(14), 2, 3, 'e');
        px(g, X(cx - 1), Y(12), 'w'); px(g, X(cx), Y(12), 'w'); px(g, X(cx - 1), Y(13), 'w');
        px(g, X(cx + 1), Y(16), 'w');
      }
    });
    if (eyes === 'happy') { rect(g, X(11), Y(18), 3, 2, 'm'); px(g, X(12), Y(19), 'k'); } else { px(g, X(11), Y(18), 'm'); px(g, X(12), Y(19), 'm'); px(g, X(13), Y(18), 'm'); }
  }

  var cache = {};
  function buildChar(frame, style, role) {
    var g = grid(CW, CH);
    var walk = frame === 'walkA' ? 1 : frame === 'walkB' ? -1 : 0;
    var hx = frame === 'tilt' ? 1 : 0;
    var hy = frame === 'tilt' ? 1 : 0;
    // legs and shoes
    rect(g, 8, 27 - (walk > 0 ? 1 : 0), 4, 3, 'p'); rect(g, 12, 27 - (walk < 0 ? 1 : 0), 4, 3, 'p');
    rect(g, 11, 27, 1, 3, 'P'); rect(g, 15, 27, 1, 3, 'P');
    rect(g, 7, 30 - (walk > 0 ? 1 : 0), 5, 1, 'z'); rect(g, 12, 30 - (walk < 0 ? 1 : 0), 5, 1, 'z');
    // torso, arms
    rect(g, 7, 20, 10, 7, 'b'); rect(g, 15, 20, 2, 7, 'd'); rect(g, 7, 25, 10, 2, 'd'); rect(g, 8, 21, 2, 2, 'B');
    var ay = walk * -1;
    rect(g, 5, 21 + ay, 2, 5, 'b'); rect(g, 17, 21 - ay, 2, 5, 'd');
    rect(g, 5, 25 + ay, 2, 2, 's'); rect(g, 17, 25 - ay, 2, 2, 's');
    // head
    ell(g, 12 + hx, 11 + hy, 10, 9, shaded('s', 'S', 'q'));
    drawHair(g, hx, hy, style);
    if (role !== 'other') drawHat(g, role, hx, hy);
    drawFace(g, hx, hy, frame === 'blink' ? 'blink' : frame === 'happy' ? 'happy' : 'open');
    outline(g, 'o');
    return rows(g);
  }
  // character(frame, style, role) -> rows (memoised)
  function character(frame, style, role) {
    var key = frame + '.' + style + '.' + role;
    if (!cache[key]) cache[key] = buildChar(frame, style, role);
    return cache[key];
  }

  // ------------------------------------------------------------------ furniture and props
  function make(w, h, draw, edge) { var g = grid(w, h); draw(g); if (edge !== false) outline(g, 'o'); return rows(g); }

  var desk = make(40, 20, function (g) {
    rect(g, 0, 0, 40, 7, 't'); rect(g, 1, 0, 38, 1, 'Y'); rect(g, 0, 6, 40, 1, 'T');
    rect(g, 1, 7, 38, 6, 't'); rect(g, 1, 12, 38, 1, 'T');
    rect(g, 15, 8, 10, 4, 'T'); rect(g, 16, 9, 8, 2, 't'); rect(g, 19, 9, 2, 1, 'G');
    rect(g, 3, 13, 3, 7, 'T'); rect(g, 34, 13, 3, 7, 'T');
  });
  var chair = make(18, 14, function (g) {
    ell(g, 9, 6, 7, 6, shaded('p', 'P', 'p'));
    rect(g, 5, 11, 8, 3, 'P');
  });
  var monitor = make(16, 16, function (g) {
    rect(g, 0, 0, 16, 11, 'D'); rect(g, 1, 1, 14, 9, 'c'); rect(g, 1, 0, 14, 1, 'G');
    rect(g, 7, 11, 2, 2, 'D'); rect(g, 4, 13, 8, 2, 'G');
  });
  var keyboard = make(14, 4, function (g) {
    rect(g, 0, 0, 14, 3, 'G');
    for (var i = 1; i < 13; i += 2) { px(g, i, 0, 'g'); px(g, i, 1, 'g'); }
  });
  var handsA = make(12, 3, function (g) { rect(g, 1, 0, 3, 2, 's'); rect(g, 8, 0, 3, 2, 's'); rect(g, 1, 1, 3, 1, 'S'); rect(g, 8, 1, 3, 1, 'S'); }, false);
  var handsB = make(12, 3, function (g) { rect(g, 2, 0, 3, 2, 's'); rect(g, 7, 0, 3, 2, 's'); rect(g, 2, 1, 3, 1, 'S'); rect(g, 7, 1, 3, 1, 'S'); }, false);
  var mug = make(8, 7, function (g) {
    rect(g, 0, 1, 5, 5, 'w'); rect(g, 4, 1, 1, 5, 'g'); rect(g, 0, 1, 5, 1, 'n'); rect(g, 5, 2, 2, 1, 'w'); rect(g, 6, 3, 1, 2, 'w'); rect(g, 5, 5, 2, 1, 'w');
  });
  function lamp(on) {
    return make(9, 12, function (g) {
      ell(g, 4, 3, 4, 3, on ? 'y' : 'G');
      rect(g, 4, 6, 1, 4, 'D'); rect(g, 2, 10, 5, 2, 'D');
    });
  }
  var plant = make(16, 22, function (g) {
    ell(g, 5, 7, 4, 6, shaded('l', 'L', 'l')); ell(g, 11, 6, 4, 6, shaded('l', 'L', 'l')); ell(g, 8, 4, 3, 5, shaded('l', 'L', 'l'));
    rect(g, 3, 14, 10, 8, 'u'); rect(g, 10, 14, 3, 8, 'U'); rect(g, 2, 13, 12, 2, 'U');
  });
  var coffee = make(18, 24, function (g) {
    rect(g, 0, 0, 18, 24, 'D'); rect(g, 1, 1, 16, 8, 'G'); rect(g, 2, 2, 7, 5, 'g'); px(g, 13, 3, 'k'); px(g, 15, 3, 'l');
    rect(g, 6, 11, 6, 3, 'D'); rect(g, 6, 14, 6, 5, 'c'); rect(g, 7, 17, 4, 3, 'w'); rect(g, 7, 17, 4, 1, 'n'); rect(g, 2, 21, 14, 2, 'G');
  });
  var shadowDesk = make(46, 8, function (g) { ell(g, 22.5, 3.5, 22, 3.5, 'a'); }, false);
  var shadowChar = make(22, 6, function (g) { ell(g, 10.5, 2.5, 10, 2.5, 'a'); }, false);

  function bubble(kind) {
    var g = grid(28, 22);
    rect(g, 1, 0, 26, 18, 'w'); rect(g, 0, 1, 28, 16, 'w');
    if (kind === 'speech') { rect(g, 12, 18, 4, 1, 'w'); rect(g, 13, 19, 2, 1, 'w'); rect(g, 13, 20, 1, 1, 'w'); }
    else { ell(g, 11, 19, 1.5, 1.5, 'w'); ell(g, 9, 21, 1, 1, 'w'); }
    outline(g, 'o');
    return rows(g);
  }
  function icon(draw) { var g = grid(11, 11); draw(g); return rows(g); }
  var iconFile = icon(function (g) {
    rect(g, 2, 0, 7, 11, 'w'); rect(g, 6, 0, 3, 3, 'g'); rect(g, 6, 3, 3, 1, 'g');
    rect(g, 3, 5, 5, 1, 'G'); rect(g, 3, 7, 5, 1, 'G'); rect(g, 3, 9, 3, 1, 'G');
    outline(g, 'o');
  });
  var iconTerminal = icon(function (g) {
    rect(g, 0, 1, 11, 9, 'D');
    [[2, 3], [3, 4], [2, 5]].forEach(function (p) { px(g, p[0], p[1], 'l'); });
    rect(g, 5, 6, 3, 1, 'l');
    outline(g, 'o');
  });
  var iconSearch = icon(function (g) {
    ell(g, 4, 4, 3.4, 3.4, 'C');
    var g2 = grid(11, 11);
    ell(g2, 4, 4, 3.4, 3.4, 'o');
    for (var y = 0; y < 11; y++) for (var x = 0; x < 11; x++) if (g2[y][x] === 'o' && g[y][x] === '.') g[y][x] = 'o';
    [[7, 7], [8, 8], [9, 9], [7, 8], [8, 7], [8, 9], [9, 8], [10, 10]].forEach(function (p) { px(g, p[0], p[1], 'D'); });
    ell(g, 4, 4, 2.4, 2.4, 'C'); px(g, 3, 3, 'w');
  });
  var iconAgent = icon(function (g) {
    rect(g, 4, 3, 1, 3, 'D'); rect(g, 2, 5, 7, 1, 'D'); rect(g, 2, 5, 1, 3, 'D'); rect(g, 8, 5, 1, 3, 'D');
    [[5, 1], [2, 8], [8, 8]].forEach(function (p) { ell(g, p[0], p[1], 1.6, 1.6, 'o'); ell(g, p[0], p[1], 0.9, 0.9, 'C'); });
  });
  var iconGear = icon(function (g) {
    ell(g, 5, 5, 3.4, 3.4, 'G');
    [[5, 0], [5, 10], [0, 5], [10, 5], [1, 1], [9, 1], [1, 9], [9, 9]].forEach(function (p) { px(g, p[0], p[1], 'G'); });
    ell(g, 5, 5, 1.2, 1.2, 'w');
    outline(g, 'o');
  });
  var excl = icon(function (g) { rect(g, 4, 0, 3, 7, 'k'); rect(g, 4, 8, 3, 3, 'k'); rect(g, 5, 1, 1, 4, 'q'); });

  var SPRITES = {
    desk: desk, chair: chair, monitor: monitor, keyboard: keyboard, handsA: handsA, handsB: handsB, mug: mug,
    lampOn: lamp(true), lampOff: lamp(false), plant: plant, coffee: coffee, shadowDesk: shadowDesk, shadowChar: shadowChar,
    bubbleThink: bubble('think'), bubbleSpeech: bubble('speech'),
    excl: excl, iconFile: iconFile, iconTerminal: iconTerminal, iconSearch: iconSearch, iconAgent: iconAgent, iconGear: iconGear
  };

  // Where things sit inside a 48 x 70 desk cell (renderer and tests share these).
  var CELL = {
    w: 48, h: 72, charX: 18, charY: 22, deskX: 4, deskY: 50, monX: 4, monY: 34, kbX: 23, kbY: 53, handsX: 24, handsY: 48,
    mugX: 33, mugY: 57, lampX: 39, lampY: 41, chairX: 21, chairY: 40, bubbleX: 16, bubbleY: 0, shadowX: 1, shadowY: 66
  };

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
    LEGEND: LEGEND, PALETTES: PALETTES, SCENE: SCENE, ENGINES: ENGINES, ROLE_COLORS: ROLE_COLORS, HAIR: HAIR, SKIN: SKIN,
    STYLES: STYLES, ROLE_NAMES: ROLE_NAMES, FRAME_NAMES: FRAME_NAMES, CHAR_W: CW, CHAR_H: CH,
    character: character, SPRITES: SPRITES, CELL: CELL, size: size, toIndices: toIndices, all: all
  };
}));
