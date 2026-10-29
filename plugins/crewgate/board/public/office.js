(function () {
  'use strict';

  // The Office page: live sessions as a small pixel-art office on <canvas>. Everything is drawn from
  // the sprite data in office-sprites.js; office-model.js decides who sits where and what they do.
  // app.js calls Office.page(data, ctx) and mounts the returned node.
  var M = window.OfficeModel;
  var SP = window.OfficeSprites;
  if (!M || !SP) return;

  var FRAME_MS = 100;        // ~10 fps
  var WALK_MS = 3200;        // how long a finished session takes to leave
  var CELL = SP.CELL;
  var darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var motionMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  var layoutState = null;    // seats survive refreshes so nobody jumps
  var seen = {};             // id -> { shown, since }: when a session last changed state
  var current = null;        // the scene on screen
  var raf = 0;
  var lastTick = 0;
  var cache = {};

  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function theme() { return darkMq && darkMq.matches ? 'dark' : 'light'; }
  function reduced() { return !!(motionMq && motionMq.matches); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------------ sprites, baked once per theme
  function bake(rows, colorOf) {
    var c = document.createElement('canvas');
    c.width = rows[0].length;
    c.height = rows.length;
    var g = c.getContext('2d');
    if (!g) return c;
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
    return c;
  }
  function sprite(name) {
    var key = theme() + ':' + name;
    if (!cache[key]) {
      var pal = SP.PALETTES[theme()];
      cache[key] = bake(SP.SPRITES[name], function (ch) { return pal[ch]; });
    }
    return cache[key];
  }
  // a character frame with the shirt of its engine, the hat of its role and its own hair and skin
  function character(frame, look) {
    var th = theme();
    var key = th + ':c:' + frame + look.engine + look.role + look.hair + look.skin;
    if (!cache[key]) {
      var pal = SP.PALETTES[th];
      var eng = SP.ENGINES[th][look.engine];
      var hat = SP.HAT[look.role];
      var rows = SP.CHAR[frame].map(function (row, y) {
        if (!hat || y >= hat.length) return row;
        var out = '';
        for (var x = 0; x < row.length; x++) out += hat[y].charAt(x) !== '.' ? hat[y].charAt(x) : row.charAt(x);
        return out;
      });
      var color = function (ch) {
        if (ch === 'b') return eng.b;
        if (ch === 'd') return eng.d;
        if (ch === 'h') return (th === 'dark' ? SP.HAIR_DARK : SP.HAIR)[look.hair];
        if (ch === 's') return (th === 'dark' ? SP.SKIN_DARK : SP.SKIN)[look.skin];
        if (ch === 'r') return SP.ROLE_COLORS[th][look.role];
        return pal[ch];
      };
      cache[key] = bake(rows, color);
    }
    return cache[key];
  }
  var ICONS = { file: 'iconFile', terminal: 'iconTerminal', search: 'iconSearch', agent: 'iconAgent', other: 'iconGear' };

  // ------------------------------------------------------------------ room background (floor, wall, furniture)
  function drawBackground(room) {
    var th = theme();
    var sc = SP.SCENE[th];
    var c = document.createElement('canvas');
    c.width = room.w;
    c.height = room.h;
    var g = c.getContext('2d');
    if (!g) return c;
    var wallH = M.WALL_H;
    g.fillStyle = sc.wall; g.fillRect(0, 0, room.w, wallH);
    g.fillStyle = sc.wallDark; g.fillRect(0, wallH - 6, room.w, 3);
    g.fillStyle = sc.base; g.fillRect(0, wallH - 3, room.w, 3);
    for (var y = wallH; y < room.h; y += 8) {
      for (var x = 0; x < room.w; x += 8) {
        g.fillStyle = ((x + y) / 8) % 2 ? sc.floorA : sc.floorB;
        g.fillRect(x, y, Math.min(8, room.w - x), Math.min(8, room.h - y));
      }
    }
    room.pods.forEach(function (p) { g.fillStyle = sc.rug; g.fillRect(p.x + 1, p.y + 2, p.w - 2, p.h - 4); });
    g.drawImage(sprite('plant'), 4, wallH - 12);
    g.drawImage(sprite('coffee'), room.w - 22, wallH - 14);
    g.drawImage(sprite('plant'), room.w - 38, wallH - 12);
    room.desks.forEach(function (d) {
      g.drawImage(sprite('chair'), d.x + CELL.chairX, d.y + CELL.chairY);
      if (d.free) drawDesk(g, d, null);
    });
    return c;
  }

  function drawDesk(g, desk, anim, t) {
    g.drawImage(sprite('desk'), desk.x + CELL.deskX, desk.y + CELL.deskY);
    g.drawImage(sprite('monitor'), desk.x + CELL.monX, desk.y + CELL.monY);
    var screen = anim ? anim.screen : 'off';
    if (screen !== 'off') {
      var pal = SP.PALETTES[theme()];
      var sx = desk.x + CELL.monX + 1;
      var sy = desk.y + CELL.monY + 1;
      if (screen === 'busy') {
        g.fillStyle = pal.C; g.fillRect(sx, sy, 8, 5);
        g.fillStyle = pal.c;
        var f = Math.floor(t / 180);
        for (var i = 0; i < 3; i++) g.fillRect(sx + 1, sy + i * 2, 2 + ((f * (i + 2)) % 5), 1);
      } else {
        g.globalAlpha = 0.55; g.fillStyle = pal.C; g.fillRect(sx, sy, 8, 5); g.globalAlpha = 1;
      }
    }
    g.drawImage(sprite('keyboard'), desk.x + CELL.kbX, desk.y + CELL.kbY);
  }

  // ------------------------------------------------------------------ animation of one seat
  function awayProgress(id, t) {
    var a = seen[id];
    if (!a || a.shown !== 'done') return 0;
    if (reduced()) return 1;
    return Math.max(0, Math.min(1, (t - a.since) / WALK_MS));
  }

  function drawSeat(g, desk, it, t, hot) {
    var A = it.anim;
    var calm = reduced();
    var p = A.pose === 'away' ? awayProgress(it.row.id, t) : 0;
    var leaving = p > 0.08;
    var x = desk.x + CELL.charX;
    var y = desk.y + CELL.charY;
    var sip = A.coffee && !calm && Math.floor(t / 900) % 3 === 2;
    if (!leaving) {
      if (A.bounce && !calm) y -= Math.round(Math.abs(Math.sin(t / 260)) * 2);
      var frame = sip || (!calm && t % 4200 < 140) ? 'blink' : 'stand';
      g.drawImage(character(frame, it.look), x, y);
    }
    drawDesk(g, desk, leaving ? { screen: 'off' } : A, t);
    if (A.typing && !leaving) g.drawImage(sprite(!calm && Math.floor(t / 150) % 2 ? 'handsB' : 'handsA'), desk.x + CELL.handsX, desk.y + CELL.handsY);
    if (sip) g.drawImage(sprite('mug'), desk.x + CELL.mugX - 2, desk.y + CELL.mugY - 9);
    else g.drawImage(sprite('mug'), desk.x + CELL.mugX, desk.y + CELL.mugY);
    g.drawImage(sprite(A.lamp && !leaving ? 'lampOn' : 'lampOff'), desk.x + CELL.lampX, desk.y + CELL.lampY);
    var sc = SP.SCENE[theme()];
    if (A.highlight) {
      g.globalAlpha = calm ? 1 : 0.45 + 0.55 * Math.abs(Math.sin(t / 380));
      g.strokeStyle = sc.ring; g.lineWidth = 1;
      g.strokeRect(desk.x + 0.5, desk.y + 9.5, CELL.w - 1, 27);
      g.globalAlpha = 1;
    }
    if (hot) {
      g.strokeStyle = sc.ring; g.lineWidth = 1;
      g.strokeRect(desk.x + 0.5, desk.y + 9.5, CELL.w - 1, 27);
      g.strokeRect(desk.x + 1.5, desk.y + 10.5, CELL.w - 3, 25);
    }
  }

  function drawWalker(g, room, desk, it, t) {
    var p = awayProgress(it.row.id, t);
    if (p <= 0.08 || p >= 1) return;
    var q = (p - 0.08) / 0.92;
    var x0 = desk.x + CELL.charX;
    var y0 = desk.y + CELL.charY;
    var drop = Math.min(1, q * 6);
    var x = Math.round(x0 + q * (room.w - x0 + 4));
    var y = Math.round(y0 + drop * (desk.y + CELL.h - 17 - y0) - (Math.floor(t / 160) % 2));
    g.drawImage(character(Math.floor(t / 160) % 2 ? 'walkA' : 'walkB', it.look), x, y);
  }

  function drawBubble(g, desk, it, t) {
    var A = it.anim;
    if (!A.bubble || (A.pose === 'away' && awayProgress(it.row.id, t) > 0.08)) return;
    var calm = reduced();
    var x = desk.x + CELL.bubbleX;
    var y = desk.y + CELL.bubbleY;
    var pal = SP.PALETTES[theme()];
    if (A.bounce && !calm) y -= Math.round(Math.abs(Math.sin(t / 260)) * 2);
    var f = Math.floor(t / 350);
    if (A.bubble === 'think') {
      g.drawImage(sprite('bubbleThink'), x, y);
      var lit = calm ? -1 : f % 4;
      for (var i = 0; i < 3; i++) { g.fillStyle = calm || lit === i ? pal.D : pal.g; g.fillRect(x + 4 + i * 3, y + 4, 2, 2); }
    } else if (A.bubble === 'speech') {
      g.drawImage(sprite('bubbleSpeech'), x, y);
      g.fillStyle = pal.G;
      g.fillRect(x + 2, y + 2, calm ? 9 : 3 + (f % 8), 1);
      g.fillRect(x + 2, y + 5, calm ? 6 : 3 + ((f * 3) % 8), 1);
    } else if (A.bubble === 'icon') {
      g.drawImage(sprite('bubbleSpeech'), x, y);
      g.drawImage(sprite(ICONS[A.icon] || 'iconGear'), x + 4, y + 1);
    } else if (A.bubble === 'alert') {
      g.drawImage(sprite('bubbleSpeech'), x, y);
      g.drawImage(sprite('excl'), x + 6, y + 1);
    }
  }

  function drawRoom(rc, t) {
    var g = rc.g;
    if (!g) return;
    var sc = current;
    g.imageSmoothingEnabled = false;
    g.drawImage(rc.bg, 0, 0);
    var i;
    for (i = 0; i < rc.occupied.length; i++) {
      var d = rc.occupied[i];
      drawSeat(g, d, sc.items[d.id], t, sc.hot === d.id);
    }
    for (i = 0; i < rc.occupied.length; i++) drawWalker(g, rc.room, rc.occupied[i], sc.items[rc.occupied[i].id], t);
    for (i = 0; i < rc.occupied.length; i++) drawBubble(g, rc.occupied[i], sc.items[rc.occupied[i].id], t);
  }

  function drawAll(t) {
    if (!current) return;
    for (var i = 0; i < current.rcs.length; i++) drawRoom(current.rcs[i], t);
  }

  // ------------------------------------------------------------------ loop: ~10 fps, off when hidden or for reduced motion
  function tick(ts) {
    raf = 0;
    if (!current || !current.alive() || document.hidden || reduced()) return;
    if (ts - lastTick >= FRAME_MS) { lastTick = ts; drawAll(now()); }
    raf = window.requestAnimationFrame(tick);
  }
  function kick() {
    if (!current) return;
    if (reduced() || document.hidden) { drawAll(now()); return; }
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
      var a = seen[r.id];
      if (!a) seen[r.id] = { shown: s, since: -1e12 };     // already finished when first seen: nobody walks
      else if (a.shown !== s) { a.shown = s; a.since = t0; }
    });
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
    return this.ctx.pname({ id: key, name: name });
  };

  Scene.prototype.build = function () {
    if (!this.roomsEl) return;
    var self = this;
    var main = document.getElementById('main');
    var width = Math.min((main && main.clientWidth) || window.innerWidth || 800, 1400) - 32;
    this.plan = M.planFor(width);
    var lay = M.layout(layoutState, { maxCols: this.plan.maxCols });
    this.lay = lay;
    this.roomsEl.textContent = '';
    this.rcs = [];
    lay.rooms.forEach(function (room) {
      var sec = el('section', 'o-room');
      sec.appendChild(el('h2', 'o-room-name', self.roomLabel(room.key)));
      var canvas = el('canvas', 'o-canvas');
      canvas.width = room.w;
      canvas.height = room.h;
      canvas.style.width = (room.w * self.plan.scale) + 'px';
      canvas.style.height = (room.h * self.plan.scale) + 'px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', self.ctx.t('office.canvas', { count: room.desks.filter(function (x) { return x.id; }).length }));
      var rc = { room: room, canvas: canvas, g: canvas.getContext('2d'), bg: drawBackground(room), occupied: room.desks.filter(function (x) { return x.id && self.items[x.id]; }) };
      self.rcs.push(rc);
      self.bindCanvas(rc);
      sec.appendChild(canvas);
      self.roomsEl.appendChild(sec);
    });
    this.buildList();
    drawAll(now());
  };

  Scene.prototype.hit = function (rc, ev) {
    var r = rc.canvas.getBoundingClientRect();
    if (!r.width) return null;
    var x = (ev.clientX - r.left) * rc.canvas.width / r.width;
    var y = (ev.clientY - r.top) * rc.canvas.height / r.height;
    for (var i = 0; i < rc.occupied.length; i++) {
      var d = rc.occupied[i];
      if (x >= d.x && x < d.x + CELL.w && y >= d.y + 8 && y < d.y + 38) return d;
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

  Scene.prototype.rcOf = function (id) {
    for (var i = 0; i < this.rcs.length; i++) {
      for (var j = 0; j < this.rcs[i].occupied.length; j++) if (this.rcs[i].occupied[j].id === id) return { rc: this.rcs[i], desk: this.rcs[i].occupied[j] };
    }
    return null;
  };

  Scene.prototype.select = function (id, rc, desk) {
    if (!rc) { var f = this.rcOf(id); if (!f) return; rc = f.rc; desk = f.desk; }
    this.hot = id;
    this.tipId = id;
    this.fillTip(id);
    var sr = this.stage.getBoundingClientRect();
    var cr = rc.canvas.getBoundingClientRect();
    var k = cr.width / rc.canvas.width;
    var tip = this.tip;
    tip.hidden = false;
    var left = cr.left - sr.left + (desk.x + CELL.w / 2) * k - tip.offsetWidth / 2;
    var top = cr.top - sr.top + (desk.y - 2) * k - tip.offsetHeight - 6;
    if (top < 0) top = cr.top - sr.top + (desk.y + 38) * k + 6;
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
      if (!current.plan || plan.scale !== current.plan.scale || plan.maxCols !== current.plan.maxCols) current.build();
    }, 200);
  });
  document.addEventListener('visibilitychange', kick);
  var again = function () { cache = {}; if (current && current.alive()) { current.build(); kick(); } };
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', again);
  if (motionMq && motionMq.addEventListener) motionMq.addEventListener('change', function () { kick(); });

  window.Office = { page: page };
}());
