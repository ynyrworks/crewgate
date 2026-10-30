(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure logic of the Office page (no DOM, no canvas): which animation a session gets, where each
  // session sits, and what its tooltip may say. office.js draws what these return.

  var CELL_W = 48;
  var CELL_H = 72;
  var POD_COLS = 3;          // a pod is 3 desks wide and grows a row per 3 members: orchestrator in the middle of the top row
  var POD_MIN_ROWS = 1;
  var POD_W = POD_COLS * CELL_W;
  var POD_GAP = 6;
  var ROOM_PAD = 10;
  var WALL_H = 44;
  var LOUNGE_H = 44;         // the lounge strip (sofa, coffee machine, plant) under the last row of pods
  var LOUNGE_AFTER_MS = 90000;   // an idle session this long goes to rest in the lounge
  var DOOR_W = 24;
  var LOUNGE_MAX = 12;       // most rest spots in a lounge; more residents show as a "+N" badge
  var MIN_ROOM_W = 200;      // wide enough for the lounge (sofa, coffee machine, plant, a few standing spots)
  var ACCS = ['none', 'glasses', 'phones', 'scarf', 'cap'];
  var STYLES = 4;            // hair styles, hair colours and skin tones a look can pick from
  var HAIRS = 6;
  var SKINS = 4;
  var ROLES = ['orchestrator', 'worker', 'reviewer', 'refuter'];
  var KINDS = ['thinking', 'tool', 'writing', 'waiting', 'idle', 'done'];

  // ---------------------------------------------------------------- state -> animation
  // A subagent that ended its turn is reporting back to its parent: show it as done (same rule as the list).
  function shownStatus(row) { return row.subagent && row.status === 'waiting' ? 'done' : row.status; }

  function activityKind(row) {
    var a = row.activity || {};
    var k = KINDS.indexOf(a.kind) >= 0 ? a.kind : 'thinking';
    var shown = shownStatus(row);
    if (shown === 'done' && k === 'waiting') k = 'done';
    return k;
  }

  // The kind of tool decides the little icon in the bubble.
  function toolKind(name) {
    var s = String(name || '').toLowerCase();
    if (!s) return 'other';
    if (/^(task|agent)|subagent|spawn/.test(s)) return 'agent';
    if (/web|http|browse|fetch|url/.test(s)) return 'web';
    if (/grep|glob|search|^ls$|find/.test(s)) return 'search';
    if (/bash|shell|powershell|exec|command|terminal/.test(s)) return 'terminal';
    if (/read|edit|write|patch|notebook|todo/.test(s)) return 'file';
    return 'other';
  }

  // The kind of work a tool call is: decides pose, prop and what the monitor shows.
  function toolAct(name) {
    var k = toolKind(name);
    var s = String(name || '').toLowerCase();
    if (k === 'terminal') return 'run';
    if (k === 'search') return 'search';
    if (k === 'web') return 'web';
    if (k === 'agent') return 'dispatch';
    if (k === 'file') return /read|view|cat|open/.test(s) && !/edit|write|patch|notebook|todo/.test(s) ? 'read' : 'edit';
    return 'work';
  }

  // animFor(row) -> what the character does.
  //   act: think | read | search | web | run | edit | work | dispatch | wait | idle | away  (the behaviour; the rest are details)
  //   prop: 'doc' | 'magnifier' | null held while working; fast: typing fast; look: 'screen' | 'viewer' | null
  //   pose: 'sit' | 'away'; typing: hands move; coffee: sips from a mug; bounce: gentle hop;
  //   bubble: null | 'think' | 'speech' | 'icon' | 'alert'; icon: tool kind for 'icon';
  //   screen: 'busy' | 'glow' | 'off'; lamp: desk lamp on; highlight: pulse the desk
  function animFor(row) {
    var shown = shownStatus(row);
    var kind = activityKind(row);
    var out = { state: shown, pose: 'sit', typing: false, coffee: false, bounce: false, bubble: null, icon: null, screen: 'glow', lamp: true, highlight: false, act: 'think', prop: null, fast: false, look: null };
    if (shown === 'done') { out.pose = 'away'; out.screen = 'off'; out.lamp = false; out.act = 'away'; return out; }
    if (shown === 'waiting') { out.bubble = 'alert'; out.bounce = true; out.highlight = true; out.act = 'wait'; out.look = 'viewer'; return out; }
    if (shown === 'idle') { out.coffee = true; out.screen = 'off'; out.act = 'idle'; return out; }
    // working / tool (and anything unknown, which is treated as busy)
    if (shown === 'tool' || kind === 'tool') {
      var tool = (row.activity || {}).tool;
      var act = toolAct(tool);
      out.act = act; out.bubble = 'icon'; out.icon = toolKind(tool);
      if (act === 'run') { out.screen = 'run'; out.look = 'screen'; }
      else if (act === 'read') { out.screen = 'read'; out.prop = 'doc'; }
      else if (act === 'search') { out.screen = 'search'; out.prop = 'magnifier'; }
      else if (act === 'web') { out.screen = 'web'; }
      else if (act === 'dispatch') { out.screen = 'busy'; }
      else { out.typing = true; out.screen = 'busy'; out.fast = act === 'edit'; }
      return out;
    }
    if (kind === 'writing') { out.typing = true; out.fast = true; out.screen = 'busy'; out.bubble = 'speech'; out.act = 'edit'; return out; }
    if (kind === 'waiting') { out.bubble = 'alert'; out.bounce = true; out.highlight = true; out.act = 'wait'; out.look = 'viewer'; return out; }
    out.bubble = 'think';
    return out;
  }

  // Appearance, stable per session: engine -> shirt colour, role -> hat, id -> hair and skin.
  function hash(str) {
    var h = 2166136261;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function looks(row) {
    var n = hash(row.id);
    var role = ROLES.indexOf(row.role) >= 0 ? row.role : 'other';
    // accessory: seeded by the id, but roles keep a signature one (reviewer glasses, orchestrator headset); a cap only for other agents
    var acc = ACCS[(n >>> 16) % ACCS.length];
    if (role === 'reviewer') acc = 'glasses';
    else if (role === 'orchestrator') acc = 'headset';
    else if (acc === 'cap' && role !== 'other') acc = 'none';
    return {
      engine: row.engine === 'codex' ? 'codex' : 'claude', role: role,
      style: n % STYLES, hair: (n >>> 4) % HAIRS, skin: (n >>> 9) % SKINS, phase: (n >>> 13) % 2400, acc: acc
    };
  }

  // ---------------------------------------------------------------- layout
  // Position of slot n inside a pod (col, row): 0 = orchestrator (top middle), then top-left,
  // top-right, then the next rows left to right. A pod narrower than 3 desks (1-2 desks in all) fills left to right.
  function slotPos(n, cols) {
    if (cols !== undefined && cols < 3) return { col: n, row: 0 };
    if (n === 0) return { col: 1, row: 0 };
    if (n === 1) return { col: 0, row: 0 };
    if (n === 2) return { col: 2, row: 0 };
    return { col: (n - 3) % 3, row: 1 + Math.floor((n - 3) / 3) };
  }

  // The topmost present ancestor. A cycle (or a missing parent) makes the row its own root.
  function rootOf(row, byId) {
    var seen = {};
    var cur = row;
    for (var i = 0; i < 8; i++) {
      seen[cur.id] = true;
      var p = cur.parent && cur.parent !== cur.id ? byId[cur.parent] : null;
      if (!p) return cur;
      if (seen[p.id]) return row;
      cur = p;
    }
    return row;
  }

  function roomKey(root) { return root.project || '-'; }
  function byIdAsc(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function fillSlots(list, wanted) {
    // keep existing positions, free the gone, put new ids into the first hole (or the end)
    var set = {};
    wanted.forEach(function (id) { set[id] = true; });
    var seen = {};
    var out = (Array.isArray(list) ? list : []).map(function (id) {
      if (typeof id === 'string' && set[id] && !seen[id]) { seen[id] = true; return id; }
      return null;
    });
    wanted.slice().sort(byIdAsc).forEach(function (id) {
      if (seen[id]) return;
      var hole = out.indexOf(null);
      if (hole >= 0) out[hole] = id; else out.push(id);
      seen[id] = true;
    });
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  }

  // assign(prev, rows) -> state { roomOrder: [key], rooms: { key: { pods: [rootId|null], kids: { rootId: [id|null] } } } }
  // Rooms are projects. A top-level session (and every descendant of it) shares one pod. Existing
  // seats are never moved: leavers leave a hole, newcomers take the first free seat. Feed the result
  // back in as `prev` on the next refresh.
  function assign(prev, rows) {
    prev = prev && typeof prev === 'object' ? prev : {};
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var rootsBy = {};   // room key -> [root ids]
    var kidsBy = {};    // root id -> [kid ids]
    rows.forEach(function (r) {
      var root = rootOf(r, byId);
      if (root === r) { (rootsBy[roomKey(r)] = rootsBy[roomKey(r)] || []).push(r.id); kidsBy[r.id] = kidsBy[r.id] || []; }
    });
    rows.forEach(function (r) {
      var root = rootOf(r, byId);
      if (root !== r) kidsBy[root.id].push(r.id);
    });
    var keys = Object.keys(rootsBy);
    var order = (Array.isArray(prev.roomOrder) ? prev.roomOrder : []).filter(function (k) { return rootsBy[k]; });
    keys.sort(byIdAsc).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var rooms = {};
    order.forEach(function (k) {
      var before = (prev.rooms && prev.rooms[k]) || {};
      var pods = fillSlots(before.pods, rootsBy[k]);
      var kids = {};
      pods.forEach(function (id) { if (id) kids[id] = fillSlots(before.kids && before.kids[id], kidsBy[id] || []); });
      rooms[k] = { pods: pods, kids: kids };
    });
    return { roomOrder: order, rooms: rooms };
  }

  // The lounge corner: 3 sofa seats, two standing spots by the coffee machine and the plant, then more standing spots
  // along the strip (two staggered rows), at most LOUNGE_MAX in all. x, y are the top-left of a 24 x 32 character, so
  // the foot line is y + 31. office-sprites.js LOUNGE holds the furniture offsets. The page shows "+N" for anyone beyond the cap.
  function loungeSpots(lounge) {
    var spots = [];
    for (var i = 0; i < 3; i++) spots.push({ x: lounge.x + 2 + i * 17, y: lounge.y + 4, kind: 'sofa' });
    spots.push({ x: lounge.x + 66, y: lounge.y + 11, kind: 'stand' });
    spots.push({ x: lounge.x + 94, y: lounge.y + 11, kind: 'stand' });
    for (var k = 0, x = lounge.x + 120; x + 24 <= lounge.x + lounge.w && spots.length < LOUNGE_MAX; k++, x += 20) spots.push({ x: x, y: lounge.y + (k % 2 ? 2 : 11), kind: 'stand' });
    return spots;
  }
  // Lounge seat list (one entry per resting resident, index = spot, null = free). rebalanceSeats(list, visible) moves the first
  // resident waiting beyond the visible spots into the lowest free visible spot, repeatedly, then trims trailing nulls.
  // It changes the list in place and returns the moves [{ id, from, to }].
  function rebalanceSeats(list, visible) {
    var moves = [];
    for (var i = 0; i < visible && i < list.length; i++) {
      if (list[i]) continue;
      var j = -1;
      for (var k = visible; k < list.length; k++) if (list[k]) { j = k; break; }
      if (j < 0) break;
      moves.push({ id: list[j], from: j, to: i });
      list[i] = list[j];
      list[j] = null;
    }
    while (list.length && !list[list.length - 1]) list.pop();
    return moves;
  }
  // The door in the back wall; a finished session walks to `at` (top-left of its sprite) and disappears.
  function doorFor(roomW) {
    var x = roomW - DOOR_W - 10;
    return { x: x, w: DOOR_W, at: { x: x + (DOOR_W - 24) / 2 + 0, y: WALL_H + 8 - 31 } };
  }

  // The topmost of several drawn characters under a point: [{ id, x, y, w, h }] -> id | null (the larger foot line, y + h, wins; the later one on a tie).
  function pickActor(cands, x, y) {
    var best = null;
    var bestFoot = -Infinity;
    cands.forEach(function (c) {
      if (x < c.x || x >= c.x + c.w || y < c.y || y >= c.y + c.h) return;
      if (c.y + c.h >= bestFoot) { best = c.id; bestFoot = c.y + c.h; }
    });
    return best;
  }
  // Forget everything keyed by an id that is gone: prune(map, aliveSet) deletes the other keys and returns how many.
  function prune(map, alive) {
    var n = 0;
    Object.keys(map).forEach(function (k) { if (!alive[k]) { delete map[k]; n++; } });
    return n;
  }

  // ---- which sessions get a desk
  // A desk is drawn for a session that is (or was, since the last full rebuild) not finished. `drawn` is a map the page keeps
  // between refreshes: once somebody has a desk it stays (empty) until the next full rebuild, so nobody jumps when others leave;
  // a full rebuild starts from an empty map and compacts everything.
  function visibleRows(rows, placeOf, drawn) {
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var keep = {};
    rows.forEach(function (r) { if ((drawn && drawn[r.id]) || placeOf(r) !== 'out') keep[r.id] = true; });
    Object.keys(keep).forEach(function (id) {   // a pod keeps its head: ancestors stay in the room structure
      var cur = byId[id];
      for (var n = 0; n < 8 && cur && cur.parent && cur.parent !== cur.id && byId[cur.parent]; n++) { keep[cur.parent] = true; cur = byId[cur.parent]; }
    });
    var out = rows.filter(function (r) { return keep[r.id]; });
    return out.length ? out : rows;
  }
  function markDrawn(drawn, rows, placeOf) {
    var alive = {};
    rows.forEach(function (r) { alive[r.id] = true; alive['+' + r.id] = true; if (placeOf(r) !== 'out') drawn[r.id] = true; });
    prune(drawn, alive);
    return drawn;
  }

  // The order a pod fills its cells (col, row): the middle of the top row first (the orchestrator), then left, then right, then the next rows.
  function cellOrder(n) {
    var out = [];
    for (var r = 0; out.length < n; r++) [1, 0, 2].forEach(function (c) { out.push({ col: c, row: r }); });
    return out;
  }

  // layout(state, opts { maxCols, drawn, seated, placed }) -> { rooms: [{ key, w, h, cols, pods: [{ x, y, w, h }], desks: [{ id, x, y, orch, free }] }], pos: { id: desk } }
  // Pods are sized to the people in them: one desk per drawn seat, plus one spare desk when somebody of the pod is seated
  // (opts.seated: map of ids at their desk; all when omitted), at most 3 desks wide, another row per 3. A pod nobody has a desk
  // in is not drawn. Pods are packed like masonry (lowest free spot, left first), so a tall pod does not stretch its neighbours.
  // Stability: `opts.placed` (a map the page keeps between refreshes and empties on a full rebuild) remembers each pod's
  // rectangle and every desk's cell. A pod only ever grows into free space; when it cannot, the new desk gets a spot of its own
  // (a one-desk pod), so nothing that is already placed moves until the next full rebuild. Desk x/y is the top-left of its 48 x 72 cell.
  function layout(state, opts) {
    var maxCols = Math.max(1, Math.floor((opts && opts.maxCols) || 1));
    var drawn = opts && opts.drawn;
    var seatedMap = opts && opts.seated;
    var keep = !!(opts && opts.placed);
    var placed = (opts && opts.placed) || {};
    var STEP = POD_GAP;                                   // the packing grid: 6 px; every pod width plus gap is a multiple
    var limit = Math.floor(maxCols * (POD_W + POD_GAP) / STEP) * STEP;   // widest a row may be, plus one trailing gap
    var visited = {};
    var pos = {};
    var hit = function (a, b) { return a.x < b.x + b.w + POD_GAP && b.x < a.x + a.w + POD_GAP && a.y < b.y + b.h + POD_GAP && b.y < a.y + a.h + POD_GAP; };
    var rooms = state.roomOrder.map(function (key) {
      var room = state.rooms[key];
      var rects = [];                                      // every placed rectangle of this room, x from ROOM_PAD, y from the top of the pods
      var free = function (r, self) {                      // inside the width and clear of every other rectangle
        if (r.x < 0 || r.x + r.w + POD_GAP > limit) return false;
        return !rects.some(function (o) { return o !== self && hit(r, o); });
      };
      var search = function (w, h) {                       // the lowest, then leftmost free spot
        var ys = [0];
        rects.forEach(function (o) { ys.push(o.y + o.h + POD_GAP); });
        ys.sort(function (p, q) { return p - q; });
        for (var yi = 0; yi < ys.length; yi++) {
          for (var x = 0; x + w + POD_GAP <= limit; x += STEP) {
            var r = { x: x, y: ys[yi], w: w, h: h };
            if (free(r, null)) return r;
          }
        }
        return { x: 0, y: ys[ys.length - 1], w: w, h: h };
      };
      // one entry per pod that has somebody to draw
      var specs = [];
      room.pods.forEach(function (head) {
        if (!head) return;
        var seats = [head].concat(room.kids[head] || []);
        var show = seats.map(function (id) { return !!id && (!drawn || !!drawn[id]); });
        if (!show.some(Boolean)) return;
        var anySeated = !seatedMap || seats.some(function (id) { return id && seatedMap[id]; });
        var spare = !!(drawn && drawn['+' + head]) || anySeated;
        if (seats.length >= POD_COLS && seats.length % POD_COLS === 0) spare = false;   // a spare desk never opens a new row on its own
        if (drawn && spare) drawn['+' + head] = true;
        var items = [];
        seats.forEach(function (id, sl) { if (show[sl]) items.push({ id: id, k: id, slot: sl }); });
        if (spare) items.push({ id: null, k: '+' + head, slot: seats.length });
        var mk = key + '|' + head;
        visited[mk] = true;
        specs.push({ head: head, items: items, total: seats.length + (spare ? 1 : 0), mk: mk, mem: placed[mk] || null });
      });
      // pods already placed keep their rectangles
      specs.forEach(function (sp) {
        if (!sp.mem) return;
        rects.push(sp.mem.rect);
        Object.keys(sp.mem.sat).forEach(function (k) { rects.push(sp.mem.sat[k]); });
      });
      var pods = [];
      var desks = [];
      var widest = 0;
      var bottom = 0;
      var xs = {};
      specs.forEach(function (sp) {
        var mem = sp.mem;
        var keys = {};
        sp.items.forEach(function (it) { keys[it.k] = it; });
        if (!mem) {   // a new pod: the tidy layout (orchestrator in the middle of the top row)
          var cols = Math.min(POD_COLS, sp.total);
          var cellsMap = {};
          var rowsN = 1;
          sp.items.forEach(function (it) { var p = slotPos(it.slot, cols); cellsMap[it.k] = p; rowsN = Math.max(rowsN, p.row + 1); });
          var rect = search(cols * CELL_W, rowsN * CELL_H);
          mem = { rect: rect, cells: cellsMap, sat: {} };
          rects.push(rect);
          if (keep) placed[sp.mk] = mem;
        } else {
          // desks that are gone free their cell; a real newcomer takes over the spare desk
          Object.keys(mem.cells).forEach(function (k) { if (!keys[k]) delete mem.cells[k]; });
          Object.keys(mem.sat).forEach(function (k) { if (!keys[k]) { rects.splice(rects.indexOf(mem.sat[k]), 1); delete mem.sat[k]; } });
          var fresh = sp.items.filter(function (it) { return !mem.cells[it.k] && !mem.sat[it.k]; });
          fresh.sort(function (p, q) { return (p.id ? 0 : 1) - (q.id ? 0 : 1); });   // real people before the spare desk
          fresh.forEach(function (it) {
            var spareKey = '+' + sp.head;
            if (it.id && mem.cells[spareKey]) { mem.cells[it.k] = mem.cells[spareKey]; delete mem.cells[spareKey]; return; }
            var used = {};
            Object.keys(mem.cells).forEach(function (k) { used[mem.cells[k].col + ',' + mem.cells[k].row] = true; });
            var cand = cellOrder(12).filter(function (c) { return !used[c.col + ',' + c.row]; });
            for (var ci = 0; ci < cand.length; ci++) {
              var c = cand[ci];
              var grown = { x: mem.rect.x, y: mem.rect.y, w: Math.max(mem.rect.w, (c.col + 1) * CELL_W), h: Math.max(mem.rect.h, (c.row + 1) * CELL_H) };
              if (!free(grown, mem.rect)) continue;
              mem.rect.w = grown.w; mem.rect.h = grown.h;
              mem.cells[it.k] = c;
              return;
            }
            if (!it.id) return;                                       // no room for a spare desk: none
            var sat = search(CELL_W, CELL_H);                          // a person with no cell: a one-desk pod of their own
            rects.push(sat);
            mem.sat[it.k] = sat;
          });
        }
        var drawPod = function (r, list) {
          pods.push({ x: ROOM_PAD + r.x, y: WALL_H + ROOM_PAD + r.y, w: r.w, h: r.h });
          xs[r.x] = true;
          widest = Math.max(widest, r.x + r.w);
          bottom = Math.max(bottom, r.y + r.h);
          list.forEach(function (e) {
            var desk = { id: e.id, x: ROOM_PAD + r.x + e.col * CELL_W, y: WALL_H + ROOM_PAD + r.y + e.row * CELL_H, orch: e.orch, free: !e.id };
            desks.push(desk);
            if (desk.id) pos[desk.id] = desk;
          });
        };
        var main = [];
        sp.items.forEach(function (it) { if (mem.cells[it.k]) main.push({ id: it.id, col: mem.cells[it.k].col, row: mem.cells[it.k].row, orch: it.slot === 0 }); });
        if (main.length) drawPod(mem.rect, main);
        sp.items.forEach(function (it) { if (mem.sat[it.k]) drawPod(mem.sat[it.k], [{ id: it.id, col: 0, row: 0, orch: false }]); });
      });
      if (keep) Object.keys(placed).forEach(function (k) { if (k.indexOf(key + '|') === 0 && !visited[k]) delete placed[k]; });
      var rw = Math.max(MIN_ROOM_W, ROOM_PAD * 2 + widest);
      var lounge = { x: ROOM_PAD, y: WALL_H + ROOM_PAD + bottom + 4, w: rw - ROOM_PAD * 2, h: LOUNGE_H };
      return { key: key, cols: Math.max(1, Object.keys(xs).length), w: rw, h: lounge.y + LOUNGE_H + 6, pods: pods, desks: desks, lounge: lounge, spots: loungeSpots(lounge), door: doorFor(rw) };
    });
    if (keep) {   // rooms that are gone take their memory with them
      var roomKeys = {};
      state.roomOrder.forEach(function (k) { roomKeys[k] = true; });
      Object.keys(placed).forEach(function (k) { if (!roomKeys[k.slice(0, k.indexOf('|'))]) delete placed[k]; });
    }
    return { rooms: rooms, pos: pos };
  }

  // Pods per row for a content width in CSS pixels at an integer scale (2x; 1x only on very narrow screens).
  function planFor(widthPx) {
    var w = Math.max(200, Math.floor(widthPx || 0));
    var scale = w >= 2 * Math.max(POD_W + ROOM_PAD * 2, MIN_ROOM_W) ? 2 : 1;
    var maxCols = Math.max(1, Math.min(4, Math.floor((w / scale - ROOM_PAD * 2 + POD_GAP) / (POD_W + POD_GAP))));
    return { scale: scale, maxCols: maxCols };
  }

  // ---------------------------------------------------------------- lifecycle and interactions
  // placeFor(row, nowMs) -> 'desk' | 'lounge' | 'out'
  //   out: finished (a subagent is gone for good, others have left for the day); lounge: idle for LOUNGE_AFTER_MS or more,
  //   resting on the sofa until active again; desk: everything else (a session waiting for you stays visible at its desk).
  function placeFor(row, nowMs) {
    var s = shownStatus(row);
    if (s === 'done') return 'out';
    if (s === 'idle') {
      var t = Date.parse(row.lastActivity);
      if (isFinite(t) && nowMs - t >= LOUNGE_AFTER_MS) return 'lounge';
    }
    return 'desk';
  }

  function isActive(s) { return s === 'working' || s === 'tool'; }

  // detectEvents(prev, rows) -> { events, next }. prev is the `next` of the last call (null on the first call: nothing
  // happens for sessions already on screen). Events are short errands the page plays when it can:
  //   report   a subagent finished: walks to its parent with a paper          { type, who, to }
  //   review   a reviewer got busy: goes to look at the reviewed worker's screen
  //   debate   a refuter got busy: stands next to the reviewer, both show "?"
  //   dispatch a new subagent appeared: its parent walks over and hands it a paper
  function detectEvents(prev, rows) {
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var next = {};
    var events = [];
    rows.forEach(function (r) {
      next[r.id] = { shown: shownStatus(r), role: r.role || null, parent: r.parent || null };
    });
    if (!prev) return { events: events, next: next };
    var sibling = function (row, role) {
      var best = null;
      rows.forEach(function (o) {
        if (o.id === row.id || !row.parent || o.parent !== row.parent || o.role !== role) return;
        var same = row.task && o.task && row.task.id && row.task.id === o.task.id;
        if (!best || (same && !best.same)) best = { id: o.id, same: !!same };
      });
      return best && best.id;
    };
    rows.slice().sort(function (a, b) { return byIdAsc(a.id, b.id); }).forEach(function (r) {
      var was = prev[r.id];
      var now = next[r.id];
      var parent = r.parent && r.parent !== r.id && byId[r.parent] ? r.parent : null;
      if (!was) { if (parent) events.push({ type: 'dispatch', who: parent, to: r.id }); return; }
      if (was.shown === now.shown) return;
      if (r.subagent && now.shown === 'done' && parent) events.push({ type: 'report', who: r.id, to: parent });
      else if (r.role === 'reviewer' && isActive(now.shown) && !isActive(was.shown)) { var w = sibling(r, 'worker'); if (w) events.push({ type: 'review', who: r.id, to: w }); }
      else if (r.role === 'refuter' && isActive(now.shown) && !isActive(was.shown)) { var v = sibling(r, 'reviewer'); if (v) events.push({ type: 'debate', who: r.id, to: v }); }
    });
    return { events: events, next: next };
  }

  // ---------------------------------------------------------------- text, with the same privacy rules as the list
  // describe(row, priv) -> the facts a tooltip or label may use. Private mode only ever removes things.
  function describe(row, priv) {
    var act = row.activity || {};
    var task = row.task || null;
    var shown = shownStatus(row);
    var kind = activityKind(row);
    return {
      id: row.id,
      role: ROLES.indexOf(row.role) >= 0 ? row.role : (row.role ? 'other' : null),
      status: shown,
      kind: kind,
      tool: kind === 'tool' && act.tool ? String(act.tool) : null,
      target: priv ? null : act.target || null,
      taskId: task && task.id ? String(task.id) : null,
      taskTitle: priv || !task ? null : task.title || null,
      engine: row.engine === 'codex' ? 'codex' : 'claude',
      model: row.model || null,
      subagent: !!row.subagent,
      project: row.project || null,                                  // an id; the page aliases it in private mode
      projectName: priv ? null : row.project_name || row.project || null,
      branch: priv ? null : row.branch || null,
      lastActivity: row.lastActivity || null
    };
  }

  // The i18n key (and variable) for the activity line, like the sessions list.
  function activityLine(d) {
    if (d.status === 'done') return { key: 'act.done' };
    if (d.kind === 'tool') return d.tool ? { key: 'act.tool', vars: { tool: d.tool }, target: d.target } : { key: 'act.toolPlain' };
    return { key: 'act.' + d.kind };
  }

  return {
    CELL_W: CELL_W, CELL_H: CELL_H, POD_W: POD_W, POD_GAP: POD_GAP, ROOM_PAD: ROOM_PAD, WALL_H: WALL_H, ROLES: ROLES,
    LOUNGE_H: LOUNGE_H, LOUNGE_AFTER_MS: LOUNGE_AFTER_MS, DOOR_W: DOOR_W, ACCS: ACCS, toolAct: toolAct, placeFor: placeFor, detectEvents: detectEvents, loungeSpots: loungeSpots, rebalanceSeats: rebalanceSeats, visibleRows: visibleRows, markDrawn: markDrawn, pickActor: pickActor, prune: prune, LOUNGE_MAX: LOUNGE_MAX, MIN_ROOM_W: MIN_ROOM_W, doorFor: doorFor, fillSlots: fillSlots,
    shownStatus: shownStatus, activityKind: activityKind, toolKind: toolKind, animFor: animFor, hash: hash, looks: looks,
    STYLES: STYLES, HAIRS: HAIRS, SKINS: SKINS, slotPos: slotPos, rootOf: rootOf, assign: assign, layout: layout, planFor: planFor, describe: describe, activityLine: activityLine
  };
}));
