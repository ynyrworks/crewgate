(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeSprites = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pixel sprites for the Office page, drawn from scratch as rows of palette letters ('.' is
  // transparent). Nothing here is third-party art. A theme palette maps each letter to a colour;
  // the engine (shirt) and the role (hat) override a few letters when a character is baked.

  // letter -> meaning
  var LEGEND = {
    o: 'outline', s: 'skin', h: 'hair', e: 'eye', b: 'shirt', d: 'shirt shade', p: 'trousers', z: 'shoes', r: 'role colour',
    w: 'white', g: 'light grey', G: 'mid grey', D: 'dark grey', t: 'wood', T: 'wood shade', c: 'screen off', C: 'screen on',
    y: 'lamp light', n: 'coffee', l: 'leaf', L: 'leaf shade', u: 'pot', k: 'red'
  };

  var PALETTES = {
    light: {
      o: '#2d2a36', s: '#f1c9a5', h: '#5a3b2a', e: '#2d2a36', b: '#d9774f', d: '#a85632', p: '#3d4a6b', z: '#26232e', r: '#f2b81f',
      w: '#ffffff', g: '#d9d9de', G: '#9a9aa6', D: '#4c4c5a', t: '#c99a62', T: '#9c7140', c: '#2a3340', C: '#7fe0ff',
      y: '#ffd84d', n: '#6b3f1f', l: '#4caf50', L: '#2e7d32', u: '#c8643c', k: '#e53935'
    },
    dark: {
      o: '#0c0b10', s: '#e0b48e', h: '#6e4a33', e: '#0c0b10', b: '#e58a62', d: '#b86440', p: '#2b3552', z: '#0f0e14', r: '#f2b81f',
      w: '#e8e8ee', g: '#a9a9b6', G: '#6d6d7c', D: '#2a2a34', t: '#a07848', T: '#7a5830', c: '#10161f', C: '#4fc3e8',
      y: '#ffd84d', n: '#6b3f1f', l: '#5fc067', L: '#3a8f43', u: '#c8643c', k: '#ff6b66'
    }
  };

  // Scene colours (floor, walls, highlight) per theme, used by the renderer.
  var SCENE = {
    light: { floorA: '#e8e2d4', floorB: '#e0d9c8', rug: '#d4dcec', wall: '#b9c6d8', wallDark: '#9fb0c8', base: '#7d8aa3', ring: '#f2a900', ringSoft: '#8aa6d6', away: '#00000022' },
    dark: { floorA: '#26262c', floorB: '#2b2b32', rug: '#2e3a52', wall: '#2f3a4f', wallDark: '#263042', base: '#1c2332', ring: '#ffc233', ringSoft: '#5b7fbf', away: '#00000033' }
  };

  var ENGINES = {   // shirt colours: Claude warm, Codex blue (colour only, no logos)
    light: { claude: { b: '#d9774f', d: '#a85632' }, codex: { b: '#4f86e0', d: '#335fae' } },
    dark: { claude: { b: '#e58a62', d: '#b86440' }, codex: { b: '#6a9cf0', d: '#4577cc' } }
  };
  var ROLE_COLORS = {
    light: { orchestrator: '#f2b81f', worker: '#3fae5a', reviewer: '#8e5bd6', refuter: '#e0443e' },
    dark: { orchestrator: '#ffc933', worker: '#52c76f', reviewer: '#a67df0', refuter: '#ff6b66' }
  };
  var HAIR = ['#5a3b2a', '#2a2118', '#b5833a', '#8a8a92'];
  var HAIR_DARK = ['#8a6048', '#4a3d30', '#d8a455', '#b4b4bc'];
  var SKIN = ['#f1c9a5', '#d9a77c', '#a8754f'];
  var SKIN_DARK = ['#e0b48e', '#c4936a', '#94623f'];

  var rep = function (ch, n) { return new Array(n + 1).join(ch); };
  var put = function (row, col, str) { return row.slice(0, col) + str + row.slice(col + str.length); };

  // ---- characters: 16 x 16, facing the viewer; the desk hides the legs when seated
  var STAND = [
    '................',
    '................',
    '.....oooooo.....',
    '....ohhhhhho....',
    '...ohhhhhhhho...',
    '...ohssssssho...',
    '...osesssseso...',
    '...osssssssso...',
    '....osssssso....',
    '.....oooooo.....',
    '...obbbbbbbbo...',
    '..osbbbbbbbbso..',
    '..osbbdbbdbbso..',
    '..osbbbbbbbbso..',
    '...oppppppppo...',
    '...ozzo..ozzo...'
  ];
  var variant = function (base, changes) {
    return base.map(function (row, i) { return changes[i] !== undefined ? changes[i] : row; });
  };
  var CHAR = {
    stand: STAND,
    blink: variant(STAND, { 6: '...osssssssso...' }),
    walkA: variant(STAND, { 15: '..ozzo....ozzo..' }),
    walkB: variant(STAND, { 15: '....ozzoozzo....' })
  };

  // ---- hats (role badge), laid over the top 4 rows of a character
  var HAT = {
    orchestrator: ['....r..rr..r....', '....rrrrrrrr....', '....rrrrrrrr....', '................'],
    worker: ['................', '.....rrrrrr.....', '....rrrrrrrr....', '...rrrrrrrrrr...'],
    reviewer: ['..rrrrrrrrrrrr..', '....rrrrrrrr....', '.....rrrrrr.....', '................'],
    refuter: ['...r........r...', '...rr......rr...', '....rr....rr....', '................']
  };

  // ---- furniture
  var deskRows = [rep('o', 30), 'o' + rep('t', 28) + 'o', 'o' + rep('t', 28) + 'o', 'o' + rep('t', 28) + 'o', 'o' + rep('T', 28) + 'o', rep('o', 30)];
  for (var i = 0; i < 5; i++) deskRows.push('..oTTo' + rep('.', 18) + 'oTTo..');
  deskRows.push('..oooo' + rep('.', 18) + 'oooo..');

  var chairRows = ['....' + rep('D', 6) + '....'];
  for (var j = 0; j < 8; j++) chairRows.push('..' + 'D' + rep(j % 3 === 0 ? 'G' : 'D', 8) + 'D' + '..');
  chairRows.push('..' + rep('D', 10) + '..');
  chairRows = chairRows.map(function (r) { return r.length === 14 ? r : (r + rep('.', 14)).slice(0, 14); });

  // ---- speech / thought bubbles: 16 x 12 (9 rows of body, 3 rows of tail)
  function bubble(kind) {
    var rows = [];
    rows.push('.' + rep('o', 14) + '.');
    for (var k = 0; k < 7; k++) rows.push('o' + rep('w', 14) + 'o');
    rows.push('.' + rep('o', 14) + '.');
    var tail = kind === 'think'
      ? [rep('.', 16), rep('.', 16), rep('.', 16)]
      : [put(rep('.', 16), 6, 'oo'), put(rep('.', 16), 6, 'o'), rep('.', 16)];
    return rows.concat(tail);
  }

  var SPRITES = {
    desk: deskRows,
    chair: chairRows,
    monitor: ['DDDDDDDDDD', 'DccccccccD', 'DccccccccD', 'DccccccccD', 'DccccccccD', 'DccccccccD', 'DDDDDDDDDD', '....DD....', '..DDDDDD..'],
    keyboard: ['GGGGGGGGGG', 'GgGgGgGgGg', 'GGGGGGGGGG'],
    handsA: ['.ss..ss.', '........'],
    handsB: ['ss....ss', '........'],
    mug: ['wwww.', 'wnnww', 'wwww.', '.ww..'],
    lampOn: ['..yyyy', '.yyyyy', '..GGG.', '...G..', '...G..', '..GGG.'],
    lampOff: ['..GGGG', '.GGGGG', '..GGG.', '...G..', '...G..', '..GGG.'],
    plant: ['...l..l...', '..lLl.lL..', '.llLllLll.', '..lLllLl..', '.l.lLLl.l.', '...lLLl...', '....LL....', '....LL....', '..uuuuuu..', '..uTuuTu..', '...uuuu...'],
    coffee: ['DDDDDDDDDDDD', 'DGGGGGGGGGGD', 'DGkGGDDDDGGD', 'DGGGGDwwDGGD', 'DGGGGDDDDGGD', 'DGGGGGGGGGGD', 'DDDDDDDDDDDD', 'DDDDDooDDDDD', 'D...DwwD...D', 'D...DnnD...D', 'DDDDDDDDDDDD', 'DGGGGGGGGGGD', 'DGGGGGGGGGGD', 'DDDDDDDDDDDD'],
    bubbleThink: bubble('think'),
    bubbleSpeech: bubble('speech'),
    excl: ['.k.', '.k.', '.k.', '.k.', '.k.', '...', '.k.'],
    iconFile: ['.ooooo.', '.owwwo.', '.owGwo.', '.owwwo.', '.owGwo.', '.owwwo.', '.ooooo.'],
    iconTerminal: ['ooooooo', 'oDDDDDo', 'oDlDDDo', 'oDDlDDo', 'oDlDDlo', 'oDDDDDo', 'ooooooo'],
    iconSearch: ['.ooo...', 'owwwo..', 'owwwo..', 'owwwo..', '.oooo..', '....oo.', '.....oo'],
    iconAgent: ['..ooo..', '..owo..', '..ooo..', '...o...', '.ooooo.', 'o..o..o', 'ooo.ooo'],
    iconGear: ['...o...', 'o.ooo.o', '.ooGoo.', 'oooGooo', '.ooGoo.', 'o.ooo.o', '...o...']
  };
  // the tail of the thought bubble is made of small circles
  SPRITES.bubbleThink = SPRITES.bubbleThink.slice(0, 9).concat([put(rep('.', 16), 5, 'oo'), put(rep('.', 16), 4, 'oo'), put(rep('.', 16), 3, 'o')]);

  // Where things sit inside a 32 x 44 desk cell (renderer and tests share these).
  var CELL = { w: 32, h: 44, charX: 10, charY: 12, deskX: 1, deskY: 24, monX: 1, monY: 16, kbX: 13, kbY: 25, handsX: 12, handsY: 22, mugX: 25, mugY: 26, lampX: 25, lampY: 19, chairX: 9, chairY: 14, bubbleX: 10, bubbleY: -2 };

  function size(rows) { return { w: rows[0].length, h: rows.length }; }

  // toIndices(rows) -> rows of palette-letter indices (into Object.keys(LEGEND)) or -1 for transparent.
  function toIndices(rows) {
    var keys = Object.keys(LEGEND);
    return rows.map(function (row) { return row.split('').map(function (ch) { return ch === '.' ? -1 : keys.indexOf(ch); }); });
  }

  function all() {
    var out = [];
    Object.keys(SPRITES).forEach(function (n) { out.push([n, SPRITES[n]]); });
    Object.keys(CHAR).forEach(function (n) { out.push(['char.' + n, CHAR[n]]); });
    Object.keys(HAT).forEach(function (n) { out.push(['hat.' + n, HAT[n]]); });
    return out;
  }

  return {
    LEGEND: LEGEND, PALETTES: PALETTES, SCENE: SCENE, ENGINES: ENGINES, ROLE_COLORS: ROLE_COLORS,
    HAIR: HAIR, HAIR_DARK: HAIR_DARK, SKIN: SKIN, SKIN_DARK: SKIN_DARK,
    CHAR: CHAR, HAT: HAT, SPRITES: SPRITES, CELL: CELL, size: size, toIndices: toIndices, all: all
  };
}));
