(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure logic of the Office page (no DOM, no canvas): which animation a session gets, where each
  // session sits, and what its tooltip may say. office.js draws what these return.

  var CELL_W = 32;
  var CELL_H = 44;
  var POD_COLS = 3;          // a pod is 3 desks wide and grows a row per 3 members: orchestrator in the middle of the top row
  var POD_MIN_ROWS = 1;
  var POD_W = POD_COLS * CELL_W;
  var POD_GAP = 4;
  var ROOM_PAD = 8;
  var WALL_H = 26;
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
    if (/grep|glob|search|fetch|^ls$|find/.test(s)) return 'search';
    if (/bash|shell|powershell|exec|command|terminal/.test(s)) return 'terminal';
    if (/read|edit|write|patch|notebook|todo/.test(s)) return 'file';
    return 'other';
  }

  // animFor(row) -> what the character does.
  //   pose: 'sit' | 'away'; typing: hands move; coffee: sips from a mug; bounce: gentle hop;
  //   bubble: null | 'think' | 'speech' | 'icon' | 'alert'; icon: tool kind for 'icon';
  //   screen: 'busy' | 'glow' | 'off'; lamp: desk lamp on; highlight: pulse the desk
  function animFor(row) {
    var shown = shownStatus(row);
    var kind = activityKind(row);
    var out = { state: shown, pose: 'sit', typing: false, coffee: false, bounce: false, bubble: null, icon: null, screen: 'glow', lamp: true, highlight: false };
    if (shown === 'done') { out.pose = 'away'; out.screen = 'off'; out.lamp = false; return out; }
    if (shown === 'waiting') { out.bubble = 'alert'; out.bounce = true; out.highlight = true; return out; }
    if (shown === 'idle') { out.coffee = true; out.screen = 'off'; return out; }
    // working / tool (and anything unknown, which is treated as busy)
    if (shown === 'tool' || kind === 'tool') {
      var tool = (row.activity || {}).tool;
      out.typing = true; out.screen = 'busy'; out.bubble = 'icon'; out.icon = toolKind(tool);
      return out;
    }
    if (kind === 'writing') { out.typing = true; out.screen = 'busy'; out.bubble = 'speech'; return out; }
    if (kind === 'waiting') { out.bubble = 'alert'; out.bounce = true; out.highlight = true; return out; }
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
    return { engine: row.engine === 'codex' ? 'codex' : 'claude', role: ROLES.indexOf(row.role) >= 0 ? row.role : 'other', hair: n % 4, skin: (n >>> 8) % 3 };
  }

  // ---------------------------------------------------------------- layout
  // Position of slot n inside a pod (col, row): 0 = orchestrator (top middle), then top-left,
  // top-right, then the next rows left to right.
  function slotPos(n) {
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

  // layout(state, opts { maxCols }) -> { rooms: [{ key, w, h, cols, pods: [{ x, y, w, h }], desks: [{ id, x, y, orch, free }] }], pos: { id: desk } }
  // `desks` has one entry per seat of every pod; `id` is null for a free seat. Desk x/y is the top-left
  // of its 32 x 44 cell inside the room. maxCols (pods per row) only reflows rows, never reassigns seats.
  function layout(state, opts) {
    var maxCols = Math.max(1, Math.floor((opts && opts.maxCols) || 1));
    var pos = {};
    var rooms = state.roomOrder.map(function (key) {
      var room = state.rooms[key];
      var n = Math.max(1, room.pods.length);
      var cols = Math.min(n, maxCols);
      var podRows = Math.ceil(n / cols);
      // rows used by each pod
      var heights = [];
      for (var i = 0; i < n; i++) {
        var id = room.pods[i];
        var used = 1;
        if (id) (room.kids[id] || []).forEach(function (kid, j) { if (kid) used = Math.max(used, slotPos(j + 1).row + 1); });
        heights.push(Math.max(POD_MIN_ROWS, used));
      }
      var rowH = [];
      for (var r = 0; r < podRows; r++) {
        var m = POD_MIN_ROWS;
        for (var c = 0; c < cols; c++) if (heights[r * cols + c] !== undefined) m = Math.max(m, heights[r * cols + c]);
        rowH.push(m);
      }
      var pods = [];
      var desks = [];
      var y = WALL_H + ROOM_PAD;
      for (r = 0; r < podRows; r++) {
        for (c = 0; c < cols; c++) {
          var idx = r * cols + c;
          if (idx >= n) break;
          var px = ROOM_PAD + c * (POD_W + POD_GAP);
          pods.push({ x: px, y: y, w: POD_W, h: rowH[r] * CELL_H });
          var head = room.pods[idx] || null;
          var seats = [head].concat(head ? (room.kids[head] || []) : []);
          var count = Math.max(seats.length, 1);
          // draw every seat of the pod grid so free desks show up as empty furniture
          var total = Math.max(1, Math.ceil(count / POD_COLS)) * POD_COLS;
          for (var s = 0; s < total; s++) {
            var sp = slotPos(s);
            if (sp.row >= rowH[r]) continue;
            var desk = { id: seats[s] || null, x: px + sp.col * CELL_W, y: y + sp.row * CELL_H, orch: s === 0, free: !seats[s] };
            desks.push(desk);
            if (desk.id) pos[desk.id] = desk;
          }
        }
        y += rowH[r] * CELL_H + POD_GAP;
      }
      return { key: key, cols: cols, w: ROOM_PAD * 2 + cols * POD_W + (cols - 1) * POD_GAP, h: y - POD_GAP + ROOM_PAD, pods: pods, desks: desks };
    });
    return { rooms: rooms, pos: pos };
  }

  // Pods per row for a content width in CSS pixels at an integer scale.
  function planFor(widthPx) {
    var w = Math.max(200, Math.floor(widthPx || 0));
    var scale = w >= 300 ? 3 : 2;
    var maxCols = Math.max(1, Math.min(3, Math.floor((w / scale - ROOM_PAD * 2 + POD_GAP) / (POD_W + POD_GAP))));
    return { scale: scale, maxCols: maxCols };
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
    shownStatus: shownStatus, activityKind: activityKind, toolKind: toolKind, animFor: animFor, hash: hash, looks: looks,
    slotPos: slotPos, rootOf: rootOf, assign: assign, layout: layout, planFor: planFor, describe: describe, activityLine: activityLine
  };
}));
