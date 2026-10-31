(function () {
  'use strict';

  // The HD view of the Office page: pixel-art cards in a lit 3D room, one room at a time. three.js is loaded only when
  // this view is shown; without WebGL, or when the machine turns out too slow, the page falls back to the pixel view.
  var H = window.OfficeHDModel;
  var M = window.OfficeModel;
  var BASE = '/addon/office/';
  var KEY = { view: 'crew.office.view', auto: 'crew.office.auto', ok: 'crew.office.ok', room: 'crew.office.room' };

  var PX = 1 / 16;   // one art pixel in world units
  var ROOM = { x: 8, z: 6, h: 6.2 };
  var SEAT = { lift: 2.05, back: 1.5, chairBack: 2.0, chairLift: 1.2, beside: 1.0 };   // beside: to the right of the monitor, as a person sits   // a seated character: raised, and moved back along the view line to stay behind the desk
  var ACTOR = 0.82;  // characters against the furniture
  var WALK = 2.6;    // world units per second
  var DOOR = { x: -5.6, z: -5 };
  var SLOTS = [[0.2, -2.0], [-4.6, -2.1], [4.9, -2.0], [-4.85, 1.4], [-0.1, 1.4], [4.6, 1.4], [-0.4, 4.8], [4.3, 4.8]];   // staggered as the camera sees them: no head or bubble lands on someone behind
  var REST = [[7.0, -3.1], [3.6, -3.3], [7.2, -1.9], [2.2, -3.5], [7.2, -0.6], [0.8, -3.7], [-0.6, -3.7], [-2.0, -3.7]];

  // Static dressing of the room: [art, x, z, scale]; cards face the camera, the art is drawn from that high angle.
  var PROPS = [
    ['bookshelf', 1.9, -6.0, 0.85], ['wallshelf', 4.0, -6.0, 0.8], ['bookshelf', 6.0, -6.0, 0.8], ['lowcabinet', -2.6, -5.9, 0.8],
    ['planter', -7.3, -5.2, 0.85], ['coatrack', -7.5, -3.0, 0.8], ['lowcabinet', -7.7, 0.6, 0.75], ['globe', -7.5, 4.0, 0.7],
    ['flowers', -7.4, 5.6, 0.9], ['tallplant', 7.6, -5.3, 0.95], ['sofa', 7.4, -3.4, 0.8], ['cabinet', 7.9, -0.8, 0.7],
    ['chest', 7.7, 1.6, 0.85], ['floorlantern', 7.8, 3.0, 0.8], ['crates', 7.6, 4.8, 0.75], ['chair', -3.8, 5.8, 0.75],
  ];
  var FRONT = [
    ['railing', -9.0, 10.2, 1.05], ['railing', -5.6, 10.8, 1.05], ['railing', -2.2, 11.4, 1.05], ['railing', 1.2, 12.0, 1.05], ['railing', 4.6, 12.6, 1.05],
    ['plant', 8.6, 7.6, 0.7], ['floorlantern', -3.4, 11.4, 0.9], ['tallplant', 6.6, 10.6, 0.9],
    ['crates', 10.4, 8.6, 1.0], ['tallplant', 11.2, 5.4, 0.85], ['railing', 8.2, 13.2, 1.05],
  ];
  // What stands where nobody works, so a room with few sessions is not a bare floor: [art, x, z, scale] for each desk place
  var FILLERS = {
    3: [['flowers', -4.0, 2.4, 1.0]],
    4: [['planter', -1.7, 0.8, 0.8], ['chest', -0.9, 1.3, 0.85]],
    5: [['planter', 5.4, 1.0, 0.9], ['chest', 6.2, 1.5, 0.8]],
    6: [['globe', -0.3, 5.2, 0.85]],
  };
  // Lights far out of focus around the diorama: [x, y on the screen from -1 to 1, size]
  var BOKEH = [[0.92, 0.84, 3.2], [0.98, 0.3, 2.2], [-0.96, 0.62, 2], [0.95, -0.7, 2.8]];
  // Small things standing on furniture: [art, x, height, z, scale]
  var ON_TOP = [['tablelantern', -1.5, 1.9, -5.7, 0.9], ['tablelantern', -7.5, 1.8, 1.6, 0.9]];
  var GLOWS = [
    [-1.5, 2.3, -5.6, 1.5], [-7.5, 2.2, 1.7, 1.5], [7.8, 2.65, 3.2, 1.3], [-3.4, 3.1, 11.6, 2.4],                  // warm halos at the lamps: x, y, z, size
    [-3.9, 4.35, -5.8, 1.9], [0.2, 5.05, -5.8, 1.9], [-7.8, 4.25, -0.4, 1.9],                                       // the wall lanterns
  ];
  var WINDOWS = [-3.2, 2.4];

  var engine = null;
  var loading = null;
  var selected = null;
  var seatsPrev = {};
  var castPrev = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function supported() {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
  }
  function wanted(ctx) { return supported() && ctx.store(KEY.view) === 'hd'; }   // opt-in: the pixel view is the default

  function setView(ctx, view) {
    ctx.store(KEY.view, view);
    ctx.store(KEY.auto, '');
    if (view === 'hd') ctx.store(KEY.ok, '');   // a new try: measure again
    ctx.refresh();
  }

  // The line above the pixel view: why it is shown and the way back.
  function pixelNote(ctx) {
    var box = el('p', 'o-view muted');
    if (!supported()) { box.appendChild(el('span', '', ctx.t('office.noWebgl'))); return box; }   // no switch: HD cannot run here
    var why = ctx.store(KEY.auto);
    if (why === '1') box.appendChild(el('span', '', ctx.t('office.slow') + ' '));
    else if (why === 'error') box.appendChild(el('span', '', ctx.t('office.loadFailed') + ' '));
    var b = el('button', 'o-view-btn', ctx.t('office.viewHd'));
    b.type = 'button';
    b.addEventListener('click', function () { setView(ctx, 'hd'); });
    box.appendChild(b);
    return box;
  }

  // why: '1' too slow, 'error' the view could not load or start, anything else a plain switch back
  function fallBack(ctx, why) {
    ctx.store(KEY.view, 'pixel');
    ctx.store(KEY.auto, why || '');
    if (engine) engine.stop();
    ctx.refresh();
  }

  // ------------------------------------------------------------------ engine
  function load(ctx) {
    if (engine) return Promise.resolve(engine);
    if (loading) return loading;
    loading = Promise.all([import(BASE + 'three.module.min.js'), fetch(BASE + 'art-sizes.json', { cache: 'force-cache' }).then(function (r) { return r.json(); })])
      .then(function (got) { return createEngine(got[0], got[1]); })
      .then(function (e) { engine = e; loading = null; return e; })
      .catch(function (err) { loading = null; throw err; });
    return loading;
  }

  function createEngine(THREE, sizes) {
    var names = Object.keys(sizes);
    var loader = new THREE.TextureLoader();
    function pixel(t) {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearFilter;   // the art has more pixels than a small screen: nearest would drop eyes
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    return Promise.all(names.map(function (n) {
      return new Promise(function (resolve, reject) {
        loader.load(BASE + 'art-' + n + '.png', function (t) { resolve([n, pixel(t)]); }, undefined, reject);
      });
    })).then(function (list) {
      var tex = {};
      list.forEach(function (p) { tex[p[0]] = p[1]; });
      return build(THREE, sizes, tex, pixel);
    });
  }

  function canvasTexture(THREE, pixel, w, h, draw) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'));
    return pixel(new THREE.CanvasTexture(c));
  }

  var FULL_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  function build(THREE, sizes, tex, pixel) {
    var canvas = el('canvas', 'o-hd-canvas');
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'default' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x24140a);
    var camera = new THREE.PerspectiveCamera(22, 1.5, 1, 120);
    camera.position.set(17.5, 20, 28.5);
    camera.lookAt(-0.2, 1.1, -0.2);
    camera.updateMatrixWorld();
    // Farther away along the line of sight through this point: the same place on screen, but behind what is in front of it.
    var sight = new THREE.Vector3();
    function pushBack(p, by) { p.addScaledVector(sight.copy(p).sub(camera.position).normalize(), by); }

    // ---- backdrop: floor and walls write no depth, because cards lean back toward them and must not be cut
    function surface(map, w, h) {
      var t = map.clone();
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(w / (88 * PX), h / (88 * PX));
      t.needsUpdate = true;
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.82, depthWrite: false }));
      m.renderOrder = -3;
      m.receiveShadow = true;
      return m;
    }
    var floor = surface(tex.floor, ROOM.x * 2, ROOM.z * 2);
    floor.rotation.x = -Math.PI / 2;
    var back = surface(tex.wall, ROOM.x * 2, ROOM.h);
    back.position.set(0, ROOM.h / 2, -ROOM.z);
    var left = surface(tex.wall, ROOM.z * 2, ROOM.h);
    left.position.set(-ROOM.x, ROOM.h / 2, 0);
    left.rotation.y = Math.PI / 2;
    scene.add(floor, back, left);

    var beamTex = tex.beam.clone();
    beamTex.wrapS = beamTex.wrapT = THREE.RepeatWrapping;
    beamTex.repeat.set(1, 3);
    beamTex.needsUpdate = true;
    var dark = new THREE.MeshStandardMaterial({ map: beamTex, roughness: 0.9, depthWrite: false });
    function beam(x, y, z, w, h, d) {
      var b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dark);
      b.position.set(x, y, z);
      b.receiveShadow = true;
      b.renderOrder = -2;
      scene.add(b);
    }
    beam(0, ROOM.h - 0.1, -ROOM.z + 0.14, ROOM.x * 2, 0.7, 0.3);                  // timber along the top of the walls
    beam(-ROOM.x + 0.14, ROOM.h - 0.1, 0, 0.3, 0.7, ROOM.z * 2);
    beam(0, ROOM.h + 0.45, -ROOM.z - 0.25, ROOM.x * 2 + 1.1, 0.7, 1);              // the thick wall top
    beam(-ROOM.x - 0.25, ROOM.h + 0.45, 0, 1, 0.7, ROOM.z * 2 + 1.1);
    beam(0, 0.3, -ROOM.z + 0.08, ROOM.x * 2, 0.6, 0.16);                           // skirting
    beam(-ROOM.x + 0.08, 0.3, 0, 0.16, 0.6, ROOM.z * 2);
    beam(0, -0.5, ROOM.z + 0.3, ROOM.x * 2 + 1.1, 1, 0.6);                         // the cut edge of the diorama
    beam(ROOM.x + 0.3, -0.5, 0, 0.6, 1, ROOM.z * 2 + 1.1);
    [-6.9, -3.0, 1.2, 7.2].forEach(function (x) { beam(x, ROOM.h / 2, -ROOM.z + 0.14, 0.42, ROOM.h, 0.28); });   // posts
    [-5.2, -0.4, 4.6].forEach(function (z) { beam(-ROOM.x + 0.14, ROOM.h / 2, z, 0.28, ROOM.h, 0.42); });

    // ---- cards: normals lean upward, so they take light like the floor beside them
    function card(map, wPx, hPx) {
      var geo = new THREE.PlaneGeometry(wPx * PX, hPx * PX);
      geo.translate(0, (hPx * PX) / 2, 0);
      var n = geo.attributes.normal;
      for (var i = 0; i < n.count; i++) n.setXYZ(i, -0.22, 0.86, 0.46);
      var m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: map, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide }));
      m.castShadow = true;
      m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map, alphaTest: 0.5 });
      m.quaternion.copy(camera.quaternion);
      return m;
    }
    function prop(name, x, z, scale) {
      var s = sizes[name];
      var m = card(tex[name], s[0] * scale, s[1] * scale);
      m.position.set(x, 0, z);
      scene.add(m);
      return m;
    }
    function wallPiece(name, x, y, z, onLeft, extra) {
      var s = sizes[name];
      var mat = new THREE.MeshStandardMaterial(Object.assign({ map: tex[name], alphaTest: 0.5, roughness: 0.9, depthWrite: false }, extra || {}));
      var m = new THREE.Mesh(new THREE.PlaneGeometry(s[0] * PX, s[1] * PX), mat);
      m.renderOrder = -1;
      m.position.set(x, y, z);
      if (onLeft) m.rotation.y = Math.PI / 2;
      scene.add(m);
      return m;
    }

    var rugSize = sizes.rug;
    var rug = new THREE.Mesh(new THREE.PlaneGeometry(rugSize[0] * PX, rugSize[1] * PX), new THREE.MeshStandardMaterial({ map: tex.rug, alphaTest: 0.5, roughness: 1, depthWrite: false }));
    rug.renderOrder = -1;
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.4, 0.012, 1.0);
    rug.receiveShadow = true;
    scene.add(rug);

    WINDOWS.forEach(function (z) { wallPiece('window', -ROOM.x + 0.03, 3.25, z, true, { emissive: 0xffffff, emissiveMap: tex['window-glow'], emissiveIntensity: 2 }); });
    wallPiece('notes', -0.9, 3.9, -ROOM.z + 0.03, false);
    wallPiece('painting', 2.9, 5.0, -ROOM.z + 0.03, false);
    wallPiece('door', DOOR.x, 1.95, -ROOM.z + 0.03, false);
    PROPS.concat(FRONT).forEach(function (p) { prop(p[0], p[1], p[2], p[3]); });
    ON_TOP.forEach(function (p) { prop(p[0], p[1], p[3], p[4]).position.y = p[2]; });

    var small = new THREE.Mesh(new THREE.PlaneGeometry(sizes.rugsmall[0] * PX, sizes.rugsmall[1] * PX), new THREE.MeshStandardMaterial({ map: tex.rugsmall, alphaTest: 0.5, roughness: 1, depthWrite: false }));
    small.renderOrder = -1;
    small.rotation.x = -Math.PI / 2;
    small.position.set(5.6, 0.012, 4.8);
    small.receiveShadow = true;
    scene.add(small);

    // soft halos at the lamps: painted, not lights, so they cost next to nothing
    var halo = document.createElement('canvas');
    halo.width = halo.height = 64;
    var hg = halo.getContext('2d');
    var hr = hg.createRadialGradient(32, 32, 0, 32, 32, 32);
    hr.addColorStop(0, 'rgba(255,200,120,0.42)');
    hr.addColorStop(0.35, 'rgba(255,170,80,0.14)');
    hr.addColorStop(1, 'rgba(255,150,60,0)');
    hg.fillStyle = hr;
    hg.fillRect(0, 0, 64, 64);
    var haloMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(halo), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    GLOWS.forEach(function (g) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(g[3], g[3]), haloMat);
      m.position.set(g[0], g[1], g[2]);
      m.quaternion.copy(camera.quaternion);
      m.renderOrder = 5;
      scene.add(m);
    });
    var disk = document.createElement('canvas');
    disk.width = disk.height = 64;
    var dg = disk.getContext('2d');
    var dr = dg.createRadialGradient(32, 32, 0, 32, 32, 32);
    dr.addColorStop(0, 'rgba(255,255,255,0.14)');
    dr.addColorStop(0.7, 'rgba(255,255,255,0.1)');
    dr.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = dr;
    dg.fillRect(0, 0, 64, 64);
    var bokehMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(disk), color: new THREE.Color(1, 0.5, 0.16), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    BOKEH.forEach(function (b) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(b[2], b[2]), bokehMat);
      var dir = new THREE.Vector3(b[0], b[1], 0.5).unproject(camera).sub(camera.position).normalize();
      m.position.copy(camera.position).addScaledVector(dir, 40);
      m.quaternion.copy(camera.quaternion);
      m.renderOrder = -4;
      scene.add(m);
    });

    var flames = [];
    function lantern(x, y, z, onLeft) {
      wallPiece('lantern', x, y, z, onLeft);
      var light = new THREE.PointLight(0xffb066, 7, 8.5, 1.8);
      light.position.set(x + (onLeft ? 0.45 : 0), y - 0.2, z + (onLeft ? 0 : 0.45));
      scene.add(light);
      var glow = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 2.6, 1) }));
      glow.position.set(x + (onLeft ? 0.12 : 0), y - 0.15, z + (onLeft ? 0 : 0.12));   // in the lantern: the light itself stands off the wall
      scene.add(glow);
      flames.push({ light: light, base: 7, seed: flames.length * 2.3 });
    }
    lantern(-3.9, 4.5, -ROOM.z + 0.03, false);
    lantern(0.2, 5.2, -ROOM.z + 0.03, false);
    lantern(-ROOM.x + 0.03, 4.4, -0.4, true);

    // ---- light: a fixed set, so nothing recompiles when sessions come and go
    scene.add(new THREE.HemisphereLight(0xffe2c0, 0x4a3420, 1.25));
    var gobo = document.createElement('canvas');
    gobo.width = gobo.height = 256;
    var gg = gobo.getContext('2d');
    gg.fillStyle = '#000';
    gg.fillRect(0, 0, 256, 256);
    gg.fillStyle = '#fff';
    [84, 172].forEach(function (cx) { for (var c = 0; c < 3; c++) for (var r = 0; r < 5; r++) gg.fillRect(cx - 27 + c * 19, 70 + r * 25, 16, 22); });
    var goboTex = new THREE.CanvasTexture(gobo);
    goboTex.colorSpace = THREE.SRGBColorSpace;
    var sun = new THREE.SpotLight(0xffc27a, 820, 60, 0.42, 0.25, 1.6);
    sun.position.set(-24, 17, 1);
    sun.target.position.set(-1.5, 0, -0.4);
    sun.map = goboTex;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0006;
    sun.shadow.camera.near = 8;
    sun.shadow.camera.far = 60;
    scene.add(sun, sun.target);

    var shaft = document.createElement('canvas');
    shaft.width = 64;
    shaft.height = 128;
    var sg = shaft.getContext('2d');
    var v = sg.createLinearGradient(0, 0, 0, 128);
    v.addColorStop(0, 'rgba(255,205,130,0)');
    v.addColorStop(0.22, 'rgba(255,205,130,0.6)');
    v.addColorStop(1, 'rgba(255,190,110,0)');
    sg.fillStyle = v;
    sg.fillRect(0, 0, 64, 128);
    sg.globalCompositeOperation = 'destination-in';
    var across = sg.createLinearGradient(0, 0, 64, 0);
    across.addColorStop(0, 'rgba(0,0,0,0)');
    across.addColorStop(0.5, 'rgba(0,0,0,1)');
    across.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = across;
    sg.fillRect(0, 0, 64, 128);
    var shaftMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shaft), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, opacity: 0.3 });
    WINDOWS.forEach(function (z) {
      var s = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 8.5), shaftMat);
      s.position.set(-ROOM.x + 3.1, 2.7, z + 0.1);
      s.rotation.z = -0.82;
      scene.add(s);
    });

    var DUST = 90;
    var dustPos = new Float32Array(DUST * 3);
    for (var i = 0; i < DUST; i++) dustPos.set([-7.5 + Math.random() * 11, Math.random() * 5.5, -5.5 + Math.random() * 10], i * 3);
    var dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })));

    // ---- desks: a fixed pool, shown when someone sits there
    var deskSize = sizes.desk;
    var desks = SLOTS.map(function (s, n) {
      var m = card(n % 2 ? tex.desk2 : tex.desk, deskSize[0] * 0.8, deskSize[1] * 0.8);
      m.position.set(s[0] + 0.25, 0, s[1] + 0.7);
      m.visible = false;
      scene.add(m);
      return m;
    });
    var chairSize = sizes.chair;
    var chairs = SLOTS.map(function (s) {
      var m = card(tex.chair, chairSize[0] * 0.9, chairSize[1] * 0.9);
      m.position.set(s[0] + SEAT.beside + 0.1, SEAT.chairLift, s[1]);
      pushBack(m.position, SEAT.chairBack);
      m.visible = false;
      scene.add(m);
      return m;
    });
    var fillers = SLOTS.map(function (s, n) { return (FILLERS[n] || []).map(function (f) { return prop(f[0], f[1], f[2], f[3]); }); });

    // ---- marks and bubbles, drawn by code
    var ROLE = {
      orchestrator: ['#e8b93f', ['..#.#.#..', '..#####..', '..#####..']], worker: ['#e0913a', ['...###...', '..#####..', '.#######.']],
      reviewer: ['#8d6bc7', ['...#.#...', '..#####..', '...#.#...']], refuter: ['#cf4a4a', ['.#.....#.', '..#...#..', '...###...']], other: ['#8a8f96', ['...###...', '...###...', '...###...']],
    };
    var marks = {};
    Object.keys(ROLE).forEach(function (r) {
      marks[r] = canvasTexture(THREE, pixel, 9, 3, function (g) {
        g.fillStyle = ROLE[r][0];
        ROLE[r][1].forEach(function (row, y) { row.split('').forEach(function (ch, x) { if (ch === '#') g.fillRect(x, y, 1, 1); }); });
      });
    });
    function bubbleTex(kind) {
      return canvasTexture(THREE, pixel, 13, 13, function (g) {
        g.fillStyle = '#2a1a14'; g.fillRect(1, 0, 11, 11); g.fillRect(0, 1, 13, 9); g.fillRect(5, 11, 3, 2);
        g.fillStyle = '#fff4dc'; g.fillRect(1, 1, 11, 9); g.fillRect(6, 10, 1, 2);
        if (kind === 'alert') { g.fillStyle = '#d23c3c'; g.fillRect(6, 2, 1, 5); g.fillRect(6, 8, 1, 1); }
        else if (kind === 'speech') { g.fillStyle = '#6b4a3a'; g.fillRect(3, 3, 7, 1); g.fillRect(3, 5, 7, 1); g.fillRect(3, 7, 4, 1); }
        else { g.fillStyle = '#6b4a3a'; [3, 6, 9].forEach(function (x) { g.fillRect(x, 5, 1, 1); }); }
      });
    }
    var BUBBLES = { alert: bubbleTex('alert'), dots: bubbleTex('dots'), speech: bubbleTex('speech') };
    function overlay(map, w, h) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w * PX, h * PX), new THREE.MeshBasicMaterial({ map: map, alphaTest: 0.5, color: new THREE.Color(0.8, 0.8, 0.8), depthTest: false, transparent: true }));
      m.renderOrder = 10;
      m.quaternion.copy(camera.quaternion);
      m.visible = false;
      scene.add(m);
      return m;
    }

    // ---- actors
    var actors = {};
    function frameTex(a, n) { return tex['c' + (a.cast + 1) + '-' + n]; }
    function setFrame(a, n) {
      var map = frameTex(a, n);
      if (a.mesh.material.map === map) return;
      // standing and seated frames differ in size; the card stands on its base, so scaling it is enough
      var size = sizes['c' + (a.cast + 1) + '-' + n];
      a.mesh.scale.set(size[0] / a.w, size[1] / a.h, 1);
      a.mesh.material.map = map;
      a.mesh.material.emissiveMap = map;
      a.mesh.customDepthMaterial.map = map;
    }
    function addActor(id, cast) {
      var s = sizes['c' + (cast + 1) + '-0'];
      var a = { id: id, cast: cast, w: s[0], h: s[1], sitH: sizes['c' + (cast + 1) + '-' + H.FRAME.sit][1], x: DOOR.x, z: DOOR.z + 0.6, tx: 0, tz: 0, mode: 'walk', seat: null, rest: null, pose: { frames: [H.FRAME.stand], fps: 0, bubble: null }, seed: (H.hash(id) % 628) / 100, role: 'other' };
      a.mesh = card(tex['c' + (cast + 1) + '-0'], s[0] * ACTOR, s[1] * ACTOR);
      a.mesh.userData.id = id;
      // Faces must stay readable in shade as well as in the sun: part of the colour does not depend on the light.
      a.mesh.material.color.setScalar(0.1);
      a.mesh.material.emissive.setRGB(1, 0.86, 0.72);   // warm, like the room: a neutral glow turns skin grey-white
      a.mesh.material.emissiveMap = a.mesh.material.map;
      a.mesh.material.emissiveIntensity = 0.3;
      a.mesh.material.transparent = true;   // drawn after the light shafts, which would grey them out; depth still hides them behind desks
      a.mesh.renderOrder = 6;
      scene.add(a.mesh);
      a.bubble = overlay(BUBBLES.dots, 13, 13);
      a.mark = overlay(marks.other, 9, 3);
      actors[id] = a;
      return a;
    }
    function removeActor(a) {
      scene.remove(a.mesh, a.bubble, a.mark);
      a.mesh.geometry.dispose();
      a.mesh.material.dispose();
      a.mesh.customDepthMaterial.dispose();
      a.bubble.geometry.dispose();
      a.bubble.material.dispose();
      a.mark.geometry.dispose();
      a.mark.material.dispose();
      delete actors[a.id];
    }

    // ---- what the page shows: called with the room and each session's place
    var calm = false;
    function show(room, seats, lounge, cast, poses, roles, instant) {
      Object.keys(actors).forEach(function (id) {
        var a = actors[id];
        if (seats[id] === undefined && lounge.indexOf(id) < 0) {
          if (instant) removeActor(a);
          else { a.mode = 'leave'; a.tx = DOOR.x; a.tz = DOOR.z + 0.6; a.seat = null; a.rest = null; }
        }
      });
      Object.keys(seats).concat(lounge).forEach(function (id) {
        var a = actors[id] || addActor(id, cast[id]);
        var seat = seats[id];
        var slot = seat !== undefined ? SLOTS[seat] : REST[lounge.indexOf(id) % REST.length];
        var tx = slot[0] + (seat !== undefined ? SEAT.beside : 0);
        var moved = a.tx !== tx || a.tz !== slot[1] || a.mode === 'leave';
        a.tx = tx;
        a.tz = slot[1];
        a.seat = seat === undefined ? null : seat;
        a.pose = poses[id];
        a.role = roles[id] || 'other';
        a.mark.material.map = marks[a.role] || marks.other;
        if (instant) { a.x = a.tx; a.z = a.tz; a.mode = 'here'; } else if (moved) a.mode = 'walk';
      });
      desks.forEach(function (d, i) {
        d.visible = Object.keys(seats).some(function (id) { return seats[id] === i; });
        chairs[i].visible = d.visible;
        fillers[i].forEach(function (f) { f.visible = !d.visible; });
      });
      dirty = true;
    }

    function place(a, t) {
      var seated = a.mode === 'here' && a.seat !== null;
      var bob = a.pose.fps && !calm ? (Math.floor(t * a.pose.fps + a.seed) % 2) * PX : 0;
      a.mesh.position.set(a.x, (seated ? SEAT.lift : 0) + bob, a.z);
      var hx = a.mesh.position.x;
      var hy = a.mesh.position.y + (seated ? a.sitH : a.h) * ACTOR * PX;
      var hz = a.mesh.position.z;
      if (seated) pushBack(a.mesh.position, SEAT.back);
      var frames = a.pose.frames;
      if (a.mode === 'walk' || a.mode === 'leave') setFrame(a, Math.floor(t * 5 + a.seed) % 2 ? H.FRAME.walkA : H.FRAME.walkB);
      else setFrame(a, frames[a.pose.fps && !calm ? Math.floor(t * a.pose.fps + a.seed) % frames.length : 0]);
      a.mark.visible = a.mode === 'here';
      a.mark.position.set(hx, hy + 2.5 * PX, hz);
      var kind = a.mode === 'here' ? a.pose.bubble : null;
      a.bubble.visible = !!kind;
      a.mark.position.y = hy + 2 * PX;
      if (kind) {
        a.bubble.material.map = BUBBLES[kind];
        a.bubble.position.set(hx, hy + 10 * PX + (calm ? 0 : Math.round(Math.sin(t * 3 + a.seed)) * PX), hz);
      }
    }

    function step(dt) {
      Object.keys(actors).forEach(function (id) {
        var a = actors[id];
        if (a.mode !== 'walk' && a.mode !== 'leave') return;
        var dx = a.tx - a.x;
        var dz = a.tz - a.z;
        var dist = Math.hypot(dx, dz);
        var go = WALK * dt;
        if (dist <= go) {
          a.x = a.tx;
          a.z = a.tz;
          if (a.mode === 'leave') removeActor(a); else a.mode = 'here';
        } else { a.x += (dx / dist) * go; a.z += (dz / dist) * go; }
      });
    }

    // ---- post: bloom, tilt shift, vignette, tone map. Written here because three's add-ons need an import map, which the CSP does not allow.
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    quad.frustumCulled = false;
    var quadScene = new THREE.Scene();
    quadScene.add(quad);
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    function shader(fragment, uniforms) {
      return new THREE.ShaderMaterial({ vertexShader: FULL_VERTEX, fragmentShader: fragment, uniforms: uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    }
    var opts = { type: THREE.HalfFloatType, depthBuffer: false };
    var main = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    var tilted = new THREE.WebGLRenderTarget(4, 4, opts);
    var glowA = new THREE.WebGLRenderTarget(4, 4, opts);
    var glowB = new THREE.WebGLRenderTarget(4, 4, opts);
    var bright = shader('uniform sampler2D map; varying vec2 vUv; void main() { vec3 c = texture2D(map, vUv).rgb; float l = dot(c, vec3(0.3, 0.6, 0.1)); gl_FragColor = vec4(c * smoothstep(0.95, 1.5, l), 1.0); }', { map: { value: null } });
    var blur = shader([
      'uniform sampler2D map; uniform vec2 step1; varying vec2 vUv;',
      'void main() { vec3 c = vec3(0.0); float t = 0.0; for (int i = -6; i <= 6; i++) { float k = float(i); float w = exp(-k * k / 14.0); c += texture2D(map, vUv + step1 * k).rgb * w; t += w; } gl_FragColor = vec4(c / t, 1.0); }',
    ].join('\n'), { map: { value: null }, step1: { value: new THREE.Vector2() } });
    var tiltH = shader([
      'uniform sampler2D map; uniform vec2 step1; varying vec2 vUv;',
      'float amount() { float d = max(0.0, abs(vUv.y - 0.56) - 0.3) / 0.7; return smoothstep(0.0, 0.42, d); }',
      'void main() { vec3 c = vec3(0.0); float t = 0.0; float r = amount(); for (int i = -6; i <= 6; i++) { float k = float(i); float w = exp(-k * k / 14.0); c += texture2D(map, vUv + step1 * k * r).rgb * w; t += w; } gl_FragColor = vec4(c / t, 1.0); }',
    ].join('\n'), { map: { value: null }, step1: { value: new THREE.Vector2() } });
    var final = shader([
      'uniform sampler2D map; uniform sampler2D glow; uniform vec2 step1; varying vec2 vUv;',
      'vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
      'void main() {',
      '  float d = max(0.0, abs(vUv.y - 0.56) - 0.3) / 0.7; float r = smoothstep(0.0, 0.42, d);',
      '  vec3 c = vec3(0.0); float t = 0.0;',
      '  for (int i = -6; i <= 6; i++) { float k = float(i); float w = exp(-k * k / 14.0); c += texture2D(map, vUv + step1 * k * r).rgb * w; t += w; }',
      '  c = c / t + texture2D(glow, vUv).rgb * vec3(0.6, 0.47, 0.3);',         // the glow is golden
      '  vec2 p = vUv - 0.5; c *= mix(1.0, 0.55, smoothstep(0.36, 0.85, length(p * vec2(1.05, 1.15))));',
      '  c += vec3(0.02, 0.012, 0.004);',                                        // a little warm haze in the shadows
      '  c = aces(c * vec3(0.86, 0.84, 0.8));',
      '  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));',
      '  gl_FragColor = vec4(c, 1.0);',
      '}',
    ].join('\n'), { map: { value: null }, glow: { value: null }, step1: { value: new THREE.Vector2() } });
    function pass(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    }

    var W = 4;
    var HT = 4;
    function resize(w, h) {
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (w * h * ratio * ratio > 2400000) ratio = Math.sqrt(2400000 / (w * h));   // keep the pixel count bounded on large, dense screens
      W = Math.max(4, Math.round(w * ratio));
      HT = Math.max(4, Math.round(h * ratio));
      renderer.setPixelRatio(1);
      renderer.setSize(W, HT, false);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      camera.aspect = W / HT;
      camera.updateProjectionMatrix();
      main.setSize(W, HT);
      tilted.setSize(W, HT);
      glowA.setSize(Math.max(2, W >> 2), Math.max(2, HT >> 2));
      glowB.setSize(Math.max(2, W >> 2), Math.max(2, HT >> 2));
      dirty = true;
    }

    function draw() {
      renderer.setRenderTarget(main);
      renderer.render(scene, camera);
      bright.uniforms.map.value = main.texture;
      pass(bright, glowA);
      blur.uniforms.map.value = glowA.texture;
      blur.uniforms.step1.value.set(1.4 / glowA.width, 0);
      pass(blur, glowB);
      blur.uniforms.map.value = glowB.texture;
      blur.uniforms.step1.value.set(0, 1.4 / glowA.height);
      pass(blur, glowA);
      var reach = 4 * (HT / 1000);
      tiltH.uniforms.map.value = main.texture;
      tiltH.uniforms.step1.value.set(reach / W, 0);
      pass(tiltH, tilted);
      final.uniforms.map.value = tilted.texture;
      final.uniforms.glow.value = glowA.texture;
      final.uniforms.step1.value.set(0, reach / HT);
      pass(final, null);
    }

    // ---- the loop: drawn at most CAP_FPS times a second, and not at all while the page is hidden or the canvas gone
    var running = false;
    var dirty = true;
    var lastDraw = 0;
    var startedAt = 0;
    var gauge = null;
    var onResult = null;
    var clock = 0;

    function frame(ts) {
      if (!running) return;
      if (!canvas.isConnected) { running = false; return; }
      window.requestAnimationFrame(frame);
      calm = reduced();
      if (calm && !dirty) return;
      if (!H.due(lastDraw, ts)) return;
      var dt = Math.min(0.1, (ts - lastDraw) / 1000);
      lastDraw = ts;
      clock += dt;
      var t = clock;
      if (!calm) {
        flames.forEach(function (f) { f.light.intensity = f.base * (0.88 + 0.12 * Math.sin(t * 9 + f.seed) * Math.sin(t * 3.7 + f.seed * 2)); });
        var p = dustGeo.attributes.position;
        for (var d = 0; d < DUST; d++) {
          var y = p.getY(d) + 0.0032 + Math.sin(t + d) * 0.0018;
          p.setY(d, y > 5.6 ? 0.1 : y);
          p.setX(d, p.getX(d) + Math.sin(t * 0.3 + d) * 0.0024);
        }
        p.needsUpdate = true;
        step(dt);
      } else step(1000);
      Object.keys(actors).forEach(function (id) { place(actors[id], t); });
      draw();
      dirty = false;
      if (gauge && !calm) {
        var fps = gauge.tick(ts);
        if (fps !== null) { gauge = null; if (onResult) onResult(fps); }
      }
    }

    function start(measure, result) {
      if (measure && !gauge) { gauge = new H.Gauge(window.performance.now()); onResult = result; }
      dirty = true;
      if (running) return;
      running = true;
      window.requestAnimationFrame(frame);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && gauge) gauge = new H.Gauge(window.performance.now() + 1e9);   // not measured while hidden
      else if (!document.hidden && gauge) gauge = new H.Gauge(window.performance.now());
    });

    var ray = new THREE.Raycaster();
    var pointer = new THREE.Vector2();
    function pick(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, camera);
      var meshes = Object.keys(actors).map(function (id) { return actors[id].mesh; });
      var hit = ray.intersectObjects(meshes, false);
      return hit.length ? hit[0].object.userData.id : null;
    }
    // Where a character stands on the canvas, in CSS pixels, for the details box.
    function screenOf(id) {
      var a = actors[id];
      if (!a) return null;
      var v3 = new THREE.Vector3(a.x, a.h * ACTOR * PX, a.z).project(camera);
      var r = canvas.getBoundingClientRect();
      return { x: ((v3.x + 1) / 2) * r.width, y: ((1 - v3.y) / 2) * r.height };
    }

    return {
      canvas: canvas, resize: resize, show: show, start: start, stop: function () { running = false; gauge = null; }, pick: pick, screenOf: screenOf,
    };
  }

  // ------------------------------------------------------------------ the page
  function activityText(ctx, d) {
    var line = M.activityLine(d);
    var s = ctx.t(line.key, line.vars);
    if (line.target) s += ' · ' + line.target;
    return s;
  }
  function projectText(ctx, d) {
    if (!d.project) return null;
    var name = ctx.pname({ id: d.project, name: d.projectName || d.project });
    return d.branch ? name + ' · ' + d.branch : name;
  }

  function fillTip(tip, ctx, row, d) {
    tip.textContent = '';
    var head = el('div', 'o-tip-head');
    if (d.role) head.appendChild(el('span', 'role r-' + d.role, ctx.t('role.' + d.role)));
    head.appendChild(el('span', '', ' ' + activityText(ctx, d)));
    tip.appendChild(head);
    if (d.taskId) tip.appendChild(el('div', 'o-tip-line', d.taskId + (d.taskTitle ? ' · ' + d.taskTitle : '')));
    tip.appendChild(el('div', 'o-tip-line muted', (d.engine === 'codex' ? 'Codex' : 'Claude') + (d.model ? ' · ' + d.model : '') + (d.subagent ? ' · ' + ctx.t('sessions.subagent') : '')));
    var where = projectText(ctx, d);
    if (where) tip.appendChild(el('div', 'o-tip-line muted', where));
    var st = ctx.stats ? ctx.stats(row) : null;
    if (st) tip.appendChild(el('div', 'o-tip-line muted', st));
    tip.appendChild(el('div', 'o-tip-line muted', ctx.ago(d.lastActivity)));
    tip.appendChild(el('div', 'o-tip-hint', ctx.t('office.open')));
  }

  function buildList(ctx, rows) {
    var list = el('ul', 'o-list');
    list.setAttribute('aria-label', ctx.t('office.list'));
    rows.forEach(function (r) {
      var d = M.describe(r, ctx.mask);
      var parts = [];
      if (d.role) parts.push(ctx.t('role.' + d.role));
      parts.push(activityText(ctx, d));
      if (d.taskId) parts.push(d.taskId + (d.taskTitle ? ' ' + d.taskTitle : ''));
      parts.push((d.engine === 'codex' ? 'Codex' : 'Claude') + (d.model ? ' ' + d.model : ''));
      var where = projectText(ctx, d);
      if (where) parts.push(where);
      parts.push(ctx.ago(d.lastActivity));
      var a = el('a', 'o-item', parts.join(' · '));
      a.setAttribute('href', ctx.href(r));
      a.addEventListener('click', function () { ctx.prepare(r); });
      var li = el('li', 'o-li' + (M.animFor(r).highlight ? ' is-waiting' : ''));
      li.appendChild(a);
      list.appendChild(li);
    });
    return list;
  }

  function page(d, ctx) {
    var rows = (d && Array.isArray(d.sessions)) ? d.sessions : [];
    var placeOf = function (r) { return M.placeFor(r, Date.now()); };
    var root = el('div', 'o-page');
    root.appendChild(el('h1', '', ctx.t('office.title')));
    root.appendChild(el('p', 'muted', ctx.mask ? ctx.t('office.private') : ctx.t('office.hdIntro')));
    var view = el('p', 'o-view');
    var toPixel = el('button', 'o-view-btn', ctx.t('office.viewPixel'));
    toPixel.type = 'button';
    toPixel.addEventListener('click', function () { setView(ctx, 'pixel'); });
    view.appendChild(toPixel);
    view.appendChild(el('span', 'muted', ' ' + ctx.t('office.testBadge')));
    root.appendChild(view);
    var rooms = H.roomsOf(rows, placeOf);
    if (!rooms.length) {
      root.appendChild(el('p', 'empty', ctx.t('office.none')));
      if (rows.length) { root.appendChild(el('h2', '', ctx.t('office.list'))); root.appendChild(buildList(ctx, rows)); }
      return root;
    }
    if (selected === null) selected = ctx.store(KEY.room) || null;
    var room = H.pickRoom(rooms, selected);

    if (rooms.length > 1) {
      var tabs = el('div', 'o-hd-tabs');
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', ctx.t('office.rooms'));
      rooms.forEach(function (r) {
        var first = r.rows[0];
        var name = r.key === '-' ? ctx.t('office.noProject') : ctx.pname({ id: r.key, name: (first && first.project_name) || r.key });
        var b = el('button', 'o-hd-tab', name);
        b.type = 'button';
        b.setAttribute('aria-pressed', r.key === room.key ? 'true' : 'false');
        if (r.waiting) b.appendChild(el('span', 'o-hd-alert', ' !'));
        b.addEventListener('click', function () { selected = r.key; ctx.store(KEY.room, r.key); ctx.refresh(); });
        tabs.appendChild(b);
      });
      root.appendChild(tabs);
    }

    var stage = el('div', 'o-stage o-hd-stage');
    var tip = el('div', 'o-tip');
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    var notice = el('p', 'muted', ctx.t('office.loading'));
    stage.appendChild(notice);
    stage.appendChild(tip);
    root.appendChild(stage);

    var seated = H.assignSeats(seatsPrev[room.key], room.rows, placeOf);
    seatsPrev[room.key] = seated.seats;
    if (seated.extra) root.appendChild(el('p', 'muted o-hd-extra', ctx.t('office.extra', { count: seated.extra })));
    var ids = Object.keys(seated.seats).concat(seated.lounge);
    var cast = H.castFor(castPrev[room.key], ids);
    castPrev[room.key] = cast;
    var byId = {};
    var poses = {};
    var roles = {};
    room.rows.forEach(function (r) {
      byId[r.id] = r;
      poses[r.id] = H.poseFor(M.animFor(r), seated.seats[r.id] !== undefined);
      roles[r.id] = M.looks(r).role;
    });
    root.appendChild(el('p', 'muted', ctx.t('office.hdStates')));
    root.appendChild(el('h2', '', ctx.t('office.list')));
    root.appendChild(buildList(ctx, rows));

    load(ctx).then(function (e) {
      // The board builds this page on every refresh and only attaches it when the data changed. A page that was
      // not attached by now must not take the canvas from the one on screen.
      if (!stage.isConnected) return;
      notice.remove();
      var host = stage;
      host.insertBefore(e.canvas, tip);
      e.canvas.setAttribute('role', 'img');
      e.canvas.setAttribute('aria-label', ctx.t('office.hdCanvas', { count: ids.length }));
      var fit = function () {
        var w = Math.min(host.clientWidth || 800, 1400);
        e.resize(w, Math.round(w * 0.66));
      };
      fit();
      if (window.ResizeObserver) { if (e.observer) e.observer.disconnect(); e.observer = new ResizeObserver(fit); e.observer.observe(host); }
      var first = e.lastRoom !== room.key;   // a different room is shown as it is, nobody walks in
      e.lastRoom = room.key;
      e.show(room, seated.seats, seated.lounge, cast, poses, roles, first || reduced());
      e.onMove = function (ev) {
        var id = e.pick(ev.clientX, ev.clientY);
        e.canvas.style.cursor = id ? 'pointer' : '';
        if (!id || !byId[id]) { tip.hidden = true; return; }
        fillTip(tip, ctx, byId[id], M.describe(byId[id], ctx.mask));
        tip.hidden = false;
        var at = e.screenOf(id);
        if (at) {
          tip.style.left = Math.max(0, Math.min(at.x + 12, host.clientWidth - tip.offsetWidth)) + 'px';
          tip.style.top = Math.max(0, at.y - tip.offsetHeight - 6) + 'px';
        }
      };
      e.onClick = function (ev) {
        var id = e.pick(ev.clientX, ev.clientY);
        if (!id || !byId[id]) return;
        ctx.prepare(byId[id]);
        window.location.hash = ctx.href(byId[id]).replace(/^#/, '');
      };
      if (!e.wired) {
        e.wired = true;
        e.canvas.addEventListener('pointermove', function (ev) { if (e.onMove) e.onMove(ev); });
        e.canvas.addEventListener('pointerleave', function () { if (e.onLeave) e.onLeave(); });
        e.canvas.addEventListener('click', function (ev) { if (e.onClick) e.onClick(ev); });
      }
      e.onLeave = function () { tip.hidden = true; };
      var measure = ctx.store(KEY.ok) !== '1';
      e.start(measure, function (fps) {
        if (H.tooSlow(fps)) fallBack(ctx, '1');
        else ctx.store(KEY.ok, '1');
      });
    }).catch(function () { fallBack(ctx, 'error'); });
    return root;
  }

  window.OfficeHD = { supported: supported, wanted: wanted, page: page, pixelNote: pixelNote, fallBack: fallBack };
}());
