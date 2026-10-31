'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SP = require('../public/office-sprites.js');
const OM = require('../public/office-model.js');
const SM = require('../../crewgate/board/public/sessions-model.js');

const OWN = path.join(__dirname, '..', 'public');
const PUB = path.join(__dirname, '..', '..', 'crewgate', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(/^office/.test(f) ? OWN : PUB, f), 'utf8');
const table = (l) => JSON.parse(read(`i18n/${l}.json`));

let n = 0;
const row = (o = {}) => ({ id: `r${++n}`, engine: 'claude', status: 'idle', lastActivity: new Date(1700000000000 + n * 1000).toISOString(), subagent: false, parent: null, project: 'p1', activity: { kind: 'idle' }, ...o });

test('sprites: every row has the same width and uses only known palette letters', () => {
  for (const [name, rows] of SP.all()) {
    assert.ok(Array.isArray(rows) && rows.length > 0, name);
    const w = rows[0].length;
    rows.forEach((r, i) => {
      assert.equal(typeof r, 'string', `${name}[${i}]`);
      assert.equal(r.length, w, `${name} row ${i} is ${r.length} wide, expected ${w}`);
      for (const ch of r) assert.ok(ch === '.' || ch in SP.LEGEND, `${name}: unknown letter ${ch}`);
    });
    const idx = SP.toIndices(rows);
    const keys = Object.keys(SP.LEGEND);
    idx.flat().forEach((v) => assert.ok(v === -1 || (v >= 0 && v < keys.length), name));
  }
});

test('sprites: characters are 24x32 in every frame, style and role; every theme defines every palette letter', () => {
  assert.deepEqual([SP.CHAR_W, SP.CHAR_H], [24, 32]);
  for (const f of SP.FRAME_NAMES) for (let s = 0; s < SP.STYLES; s++) for (const r of SP.ROLE_NAMES) assert.deepEqual(SP.size(SP.character(f, s, r)), { w: 24, h: 32 }, `${f}.${s}.${r}`);
  assert.deepEqual(SP.ROLE_NAMES.slice(0, 4).sort(), ['orchestrator', 'refuter', 'reviewer', 'worker']);
  // a role hat changes the picture, and so does every hair style
  const px = (rows) => rows.join('|');
  assert.notEqual(px(SP.character('stand', 0, 'worker')), px(SP.character('stand', 0, 'other')));
  const styles = new Set([0, 1, 2, 3].map((s) => px(SP.character('stand', s, 'other'))));
  assert.equal(styles.size, SP.STYLES);
  assert.notEqual(px(SP.character('stand', 0, 'other')), px(SP.character('blink', 0, 'other')));
  for (const theme of ['light', 'dark']) {
    for (const ch of Object.keys(SP.LEGEND)) assert.match(SP.PALETTES[theme][ch] || '', /^(#[0-9a-f]{6}|rgba\(.+\))$/i, `${theme}.${ch}`);
    assert.deepEqual(Object.keys(SP.ENGINES[theme]).sort(), ['claude', 'codex']);
    assert.deepEqual(Object.keys(SP.ROLE_COLORS[theme]).sort(), SP.ROLE_NAMES.slice(0, 4).sort());
    assert.notEqual(SP.ENGINES[theme].claude.b, SP.ENGINES[theme].codex.b);
    assert.ok(SP.HAIR[theme].length >= OM.HAIRS && SP.SKIN[theme].length >= OM.SKINS);
    SP.HAIR[theme].forEach((h) => assert.deepEqual(Object.keys(h).sort(), ['H', 'J', 'O', 'h', 'i']));
    SP.SKIN[theme].forEach((k) => assert.deepEqual(Object.keys(k).sort(), ['K', 'S', 'j', 'q', 's']));
    SP.ROLE_NAMES.slice(0, 4).forEach((r) => assert.deepEqual(Object.keys(SP.ROLE_COLORS[theme][r]).sort(), ['F', 'R', 'r']));
    ['claude', 'codex'].forEach((e) => assert.deepEqual(Object.keys(SP.ENGINES[theme][e]).sort(), ['B', 'E', 'b', 'd', 'f']));
  }
  assert.equal(SP.STYLES, OM.STYLES);
  assert.equal(SP.HAIR.light.length, OM.HAIRS);
  assert.equal(SP.SKIN.light.length, OM.SKINS);
  // furniture fits a desk cell and the model agrees with the sprite file about the cell
  assert.equal(SP.CELL.w, OM.CELL_W);
  assert.equal(SP.CELL.h, OM.CELL_H);
  assert.ok(SP.SPRITES.desk[0].length <= SP.CELL.w);
  assert.ok(SP.CELL.charX + SP.CHAR_W <= SP.CELL.w && SP.CELL.charY + SP.CHAR_H <= SP.CELL.h);
});

test('state -> animation mapping', () => {
  const a = (o) => OM.animFor(row(o));
  assert.deepEqual([a({ status: 'working', activity: { kind: 'thinking' } }).bubble, a({ status: 'working', activity: { kind: 'thinking' } }).typing], ['think', false]);
  const tool = a({ status: 'tool', activity: { kind: 'tool', tool: 'Bash' } });
  assert.deepEqual([tool.bubble, tool.icon, tool.typing, tool.screen, tool.act, tool.look], ['icon', 'terminal', false, 'run', 'run', 'screen']);
  const writing = a({ status: 'working', activity: { kind: 'writing' } });
  assert.deepEqual([writing.bubble, writing.typing], ['speech', true]);
  const waiting = a({ status: 'waiting', activity: { kind: 'waiting' } });
  assert.deepEqual([waiting.bubble, waiting.bounce, waiting.highlight], ['alert', true, true]);
  const idle = a({ status: 'idle' });
  assert.deepEqual([idle.coffee, idle.bubble, idle.typing], [true, null, false]);
  const done = a({ status: 'done' });
  assert.deepEqual([done.pose, done.lamp, done.screen], ['away', false, 'off']);
  // a subagent that ended its turn reports back to its parent: done, not "waiting for you"
  const sub = a({ status: 'waiting', subagent: true, parent: 'x', activity: { kind: 'waiting' } });
  assert.equal(sub.pose, 'away');
  assert.equal(sub.highlight, false);
  // unknown activity falls back to thinking
  assert.equal(a({ status: 'working', activity: { kind: 'bogus' } }).bubble, 'think');
  assert.equal(a({ status: 'working' }).bubble, 'think');
});

test('tool kinds pick the icon', () => {
  const k = OM.toolKind;
  assert.equal(k('Read'), 'file');
  assert.equal(k('Edit'), 'file');
  assert.equal(k('apply_patch'), 'file');
  assert.equal(k('Bash'), 'terminal');
  assert.equal(k('exec_command'), 'terminal');
  assert.equal(k('Grep'), 'search');
  assert.equal(k('WebFetch'), 'web');
  assert.equal(k('WebSearch'), 'web');
  assert.equal(k('Task'), 'agent');
  assert.equal(k('Agent'), 'agent');
  assert.equal(k('mcp__thing'), 'other');
  assert.equal(k(undefined), 'other');
});

test('looks: engine colour, role hat and appearance map deterministically from the session id', () => {
  const r = row({ id: 'abc', engine: 'codex', role: 'reviewer' });
  assert.deepEqual(OM.looks(r), OM.looks({ ...r }));
  assert.deepEqual(OM.looks(r), OM.looks({ ...r, status: 'working', task: { id: 'x' } }), 'only the id, engine and role matter');
  assert.equal(OM.looks(r).engine, 'codex');
  assert.equal(OM.looks(r).role, 'reviewer');
  assert.equal(OM.looks(row({ role: 'weird' })).role, 'other');
  assert.equal(OM.looks(row({ engine: 'whatever' })).engine, 'claude');
  const seen = { style: new Set(), hair: new Set(), skin: new Set() };
  for (let i = 0; i < 300; i++) {
    const l = OM.looks(row({ id: `id-${i}` }));
    assert.deepEqual(l, OM.looks(row({ id: `id-${i}` })));
    assert.ok(l.style >= 0 && l.style < SP.STYLES && Number.isInteger(l.style));
    assert.ok(l.hair >= 0 && l.hair < SP.HAIR.light.length && Number.isInteger(l.hair));
    assert.ok(l.skin >= 0 && l.skin < SP.SKIN.light.length && Number.isInteger(l.skin));
    assert.ok(l.phase >= 0 && l.phase < 2400);
    seen.style.add(l.style); seen.hair.add(l.hair); seen.skin.add(l.skin);
  }
  // people look distinct: every option gets used
  assert.equal(seen.style.size, SP.STYLES);
  assert.equal(seen.hair.size, SP.HAIR.light.length);
  assert.equal(seen.skin.size, SP.SKIN.light.length);
});

const ids = (arr) => arr.filter(Boolean);

test('layout: one room per project, orchestrator in the middle of the top row, children around it', () => {
  const rows = [
    row({ id: 'P', project: 'p1', role: 'orchestrator', status: 'working' }),
    row({ id: 'c1', parent: 'P', subagent: true, role: 'worker', project: 'p1' }),
    row({ id: 'c2', parent: 'P', subagent: true, role: 'reviewer', project: 'p1' }),
    row({ id: 'c3', parent: 'P', subagent: true, project: 'p1' }),
    row({ id: 'Q', project: 'p2' }),
    row({ id: 'N', project: null }),
  ];
  const st = OM.assign(null, rows);
  assert.deepEqual(st.roomOrder.slice().sort(), ['-', 'p1', 'p2']);
  const lay = OM.layout(st, { maxCols: 2 });
  assert.equal(lay.rooms.length, 3);
  const p = lay.pos;
  assert.equal(p.P.orch, true);
  // orchestrator is the middle desk of the pod's top row; its children are on the sides, then below
  assert.equal(p.c1.x, p.P.x - OM.CELL_W);
  assert.equal(p.c2.x, p.P.x + OM.CELL_W);
  assert.equal(p.c1.y, p.P.y);
  assert.equal(p.c3.y, p.P.y + OM.CELL_H);
  // everyone gets exactly one desk, and desks never overlap
  assert.deepEqual(Object.keys(p).sort(), ['N', 'P', 'Q', 'c1', 'c2', 'c3']);
  lay.rooms.forEach((room) => {
    const seen = new Set();
    room.desks.forEach((d) => { const k = `${d.x},${d.y}`; assert.ok(!seen.has(k), `overlap at ${k}`); seen.add(k); assert.ok(d.x >= 0 && d.x + OM.CELL_W <= room.w && d.y + OM.CELL_H <= room.h, 'inside the room'); });
  });
  // free seats are still drawn so the pod looks like an office
  assert.ok(lay.rooms.every((r) => r.desks.length >= 2));
});

test('layout: stable seats across refreshes; leavers leave a hole, newcomers take it', () => {
  let rows = [row({ id: 'P', project: 'p1' }), row({ id: 'a', parent: 'P', subagent: true, project: 'p1' }), row({ id: 'b', parent: 'P', subagent: true, project: 'p1' }), row({ id: 'X', project: 'p1' })];
  let st = OM.assign(null, rows);
  const before = OM.layout(st, { maxCols: 2 }).pos;
  // same data again, different order: nothing moves
  st = OM.assign(st, rows.slice().reverse());
  let after = OM.layout(st, { maxCols: 2 }).pos;
  for (const id of Object.keys(before)) assert.deepEqual([after[id].x, after[id].y], [before[id].x, before[id].y], id);
  // a leaves: b and X stay where they were, and the new subagent d takes a's seat
  rows = rows.filter((r) => r.id !== 'a').concat(row({ id: 'd', parent: 'P', subagent: true, project: 'p1' }));
  st = OM.assign(st, rows);
  after = OM.layout(st, { maxCols: 2 }).pos;
  for (const id of ['P', 'b', 'X']) assert.deepEqual([after[id].x, after[id].y], [before[id].x, before[id].y], id);
  assert.deepEqual([after.d.x, after.d.y], [before.a.x, before.a.y]);
  const mid = after;
  // a brand new top-level session does not move the existing ones either
  rows = rows.concat(row({ id: 'Z', project: 'p1' }));
  st = OM.assign(st, rows);
  after = OM.layout(st, { maxCols: 2 }).pos;
  for (const id of ['P', 'b', 'X', 'd']) assert.deepEqual([after[id].x, after[id].y], [mid[id].x, mid[id].y], id);
});

test('layout: assign is deterministic and tolerates junk previous state', () => {
  const rows = [row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c', parent: 'a', subagent: true })];
  const x = OM.assign(null, rows);
  const y = OM.assign(null, rows.slice().reverse());
  assert.deepEqual(x, y);
  for (const junk of [undefined, 5, 'x', [], { roomOrder: 'no', rooms: 7 }, { roomOrder: ['p1'], rooms: { p1: { pods: [3, 'a', 'a', null], kids: { a: 'nope' } } } }]) {
    const st = OM.assign(junk, rows);
    const lay = OM.layout(st, { maxCols: 3 });
    assert.deepEqual(Object.keys(lay.pos).sort(), ['a', 'b', 'c']);
  }
});

test('layout: grouping edge cases (orphans, self parent, cycles, grandchildren, many children)', () => {
  const rows = [
    row({ id: 'orphan', parent: 'gone', subagent: true }),
    row({ id: 'self', parent: 'self' }),
    row({ id: 'A', parent: 'B' }),
    row({ id: 'B', parent: 'A' }),
    row({ id: 'G', project: 'g' }),
    row({ id: 'G1', parent: 'G', subagent: true, project: 'g' }),
    row({ id: 'G2', parent: 'G1', subagent: true, project: 'g' }),
  ];
  for (let i = 0; i < 9; i++) rows.push(row({ id: `m${i}`, parent: 'G', subagent: true, project: 'g' }));
  const st = OM.assign(null, rows);
  const lay = OM.layout(st, { maxCols: 1 });
  assert.equal(Object.keys(lay.pos).length, rows.length);
  // the grandchild sits in the same pod as G
  const pod = lay.rooms.find((r) => r.key === 'g').pods[0];
  ['G', 'G1', 'G2', 'm8'].forEach((id) => {
    const d = lay.pos[id];
    assert.ok(d.x >= pod.x && d.x + OM.CELL_W <= pod.x + pod.w && d.y >= pod.y && d.y + OM.CELL_H <= pod.y + pod.h, id);
  });
  // a cycle must not hang or drop anyone
  assert.ok(lay.pos.A && lay.pos.B);
});

test('layout: pods per row follow maxCols but never reassign seats', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(row({ id: `s${i}`, project: 'p1' }));
  const st = OM.assign(null, rows);
  const one = OM.layout(st, { maxCols: 1 });
  const three = OM.layout(st, { maxCols: 3 });
  assert.equal(one.rooms[0].cols, 1);
  assert.ok(three.rooms[0].cols >= 3 && three.rooms[0].cols <= 4);
  assert.ok(three.rooms[0].w > one.rooms[0].w);
  assert.ok(three.rooms[0].h < one.rooms[0].h);
  assert.equal(OM.layout(st, { maxCols: 99 }).rooms[0].cols, 5);
});

test('planFor: integer scale, fits a 375 px phone', () => {
  for (const w of [0, 200, 343, 600, 900, 1400]) {
    const p = OM.planFor(w);
    assert.ok(Number.isInteger(p.scale) && p.scale >= 1, `scale at ${w}`);
    assert.ok(p.maxCols >= 1 && p.maxCols <= 4);
  }
  const phone = OM.planFor(375 - 32);
  const pod = OM.layout(OM.assign(null, [row({ id: 'only' })]), { maxCols: phone.maxCols });
  assert.ok(pod.rooms[0].w * phone.scale <= 375 - 32, 'one pod fits the phone width');
  assert.ok(OM.planFor(1400).maxCols >= OM.planFor(343).maxCols);
  assert.equal(OM.planFor(1400).scale, 2, 'finer pixels: 2x on desktop');
});

test('privacy gating of tooltip facts matches the sessions list', () => {
  const r = row({
    id: 's', role: 'worker', branch: 'feat/secret', project: 'pp', project_name: 'Secret Project', model: 'opus',
    task: { id: 'T-1', title: 'Rotate the keys' }, activity: { kind: 'tool', tool: 'Bash', target: 'rm -rf /private' }, status: 'tool',
  });
  const open = OM.describe(r, false);
  assert.equal(open.branch, 'feat/secret');
  assert.equal(open.projectName, 'Secret Project');
  assert.equal(open.taskTitle, 'Rotate the keys');
  assert.equal(open.target, 'rm -rf /private');
  const priv = OM.describe(r, true);
  assert.equal(priv.branch, null);
  assert.equal(priv.projectName, null);
  assert.equal(priv.taskTitle, null);
  assert.equal(priv.target, null);
  // ids, roles, engines stay (the list shows them in private mode too)
  assert.equal(priv.taskId, 'T-1');
  assert.equal(priv.role, 'worker');
  assert.equal(priv.engine, 'claude');
  assert.equal(priv.tool, 'Bash');
  assert.equal(JSON.stringify(priv).includes('Secret'), false);
  assert.equal(JSON.stringify(priv).includes('secret'), false);
  assert.equal(JSON.stringify(priv).includes('private'), false);
  // same nulls as the list's own rule
  const v = SM.visible(r, true);
  assert.equal(v.branch, priv.branch);
  assert.equal(v.target, priv.target);
  assert.equal(v.taskTitle, priv.taskTitle);
  const v2 = SM.visible(r, false);
  assert.equal(v2.branch, open.branch);
  assert.equal(v2.target, open.target);
  // nothing is invented when the server left the text out (board.show_text off)
  const bare = OM.describe(row({ task: { id: 'T-2', title: null }, status: 'working', activity: { kind: 'thinking' } }), false);
  assert.equal(bare.taskTitle, null);
  assert.equal(bare.target, null);
  assert.deepEqual(OM.activityLine(OM.describe(r, true)), { key: 'act.tool', vars: { tool: 'Bash' }, target: null });
  assert.deepEqual(OM.activityLine(OM.describe(r, false)).target, 'rm -rf /private');
  assert.equal(OM.activityLine(OM.describe(row({ status: 'done', activity: { kind: 'done' } }), false)).key, 'act.done');
});

test('office strings exist in both languages and the page uses only keys that exist', () => {
  const en = table('en');
  const zh = table('zh-TW');
  const used = new Set();
  for (const f of ['office.js', 'app.js']) for (const m of read(f).matchAll(/\bt\('(office\.[A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of read('app.js').matchAll(/empty\('(office\.[A-Za-z]+)'\)/g)) used.add(m[1]);
  assert.ok(used.size >= 8);
  for (const k of used) { assert.ok(k in en, `en ${k}`); assert.ok(k in zh, `zh-TW ${k}`); }
  for (const k of ['act.thinking', 'act.tool', 'act.toolPlain', 'act.writing', 'act.waiting', 'act.idle', 'act.done', 'role.orchestrator', 'role.worker', 'role.reviewer', 'role.refuter', 'role.other', 'sessions.subagent']) assert.ok(k in en && k in zh, k);
});

test('office code keeps the strict front-end rules: DOM nodes only, no eval, no inline styles, no network', () => {
  for (const f of ['office.js', 'office-model.js', 'office-sprites.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]style/, f);
    assert.doesNotMatch(src, /https?:\/\/|fetch\(|XMLHttpRequest|WebSocket|localStorage|\bimport\s/, f);
  }
  assert.doesNotMatch(read('office.css'), /@import|url\(/);
  // the board loads what office.json lists, in that order: the models before the page script
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'office.json'), 'utf8'));
  assert.deepEqual(m.scripts, ['office-sprites.js', 'office-model.js', 'office-hd-model.js', 'office-hd.js', 'office.js']);
  assert.deepEqual(m.styles, ['office.css']);
  assert.doesNotMatch(read('index.html'), /office/, 'nothing of the add-on is in the plugin page');
  // reduced motion and hidden tabs are respected
  const src = read('office.js');
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /document\.hidden/);
  assert.match(src, /imageSmoothingEnabled = false/);
});

test('the nav can link to #/office', () => {
  const app = read('app.js');
  assert.match(app, /'#\/office'/);
  assert.match(app, /\['sessions', 'office'/);
});

test('sprites: new 32 colour palette, per-region outlines and a pixel font', () => {
  assert.equal(new Set(SP.PALETTE32.map((c) => c.toLowerCase())).size, 32);
  SP.PALETTE32.forEach((c) => assert.match(c, /^#[0-9a-f]{6}$/i));
  assert.ok(!SP.PALETTE32.includes('#000000'), 'no pure black');
  for (const theme of ['light', 'dark']) assert.ok(!Object.values(SP.PALETTES[theme]).includes('#000000'));
  // hair, skin and shirt each get their own outline letters, not one shared ink line
  const rows = SP.character('stand', 0, 'worker', 'none').join('');
  for (const ch of ['O', 'K', 'E', 'V']) assert.ok(rows.includes(ch), 'outline ' + ch);
  assert.ok(!SP.character('stand', 0, 'other', 'none').join('').includes('F'), 'role outline only with a role mark');
  for (const ch of 'AZ09-.?') { const g = SP.glyph(ch); assert.equal(g.length, SP.FONT_H, ch); g.forEach((r) => assert.equal(r.length, SP.FONT_W, ch)); }
  assert.equal(SP.glyph('€'), null);
  assert.equal(SP.textWidth('AB'), 11);
  for (const f of SP.FRAME_NAMES) assert.ok(SP.character(f, 0, 'other').length === 32);
  // accessories change the picture
  const base = SP.character('stand', 1, 'other', 'none').join('|');
  for (const acc of SP.ACCESSORIES.slice(1)) assert.notEqual(SP.character('stand', 1, 'other', acc).join('|'), base, acc);
});

test('animation timings: 15 fps, blink every 2.5-5 s per character, seeded', () => {
  assert.equal(SP.ANIM.frameMs, 66);
  const seen = new Set();
  for (let seed = 1; seed < 50; seed++) {
    for (let k = 0; k < 20; k++) {
      const gap = SP.blinkGap(seed, k);
      assert.ok(gap >= 2500 && gap <= 5000, String(gap));
      assert.equal(gap, SP.blinkGap(seed, k));
      seen.add(gap);
    }
  }
  assert.ok(seen.size > 100, 'blink gaps differ between characters');
});

test('behaviour follows the work: activity -> pose, prop, screen, typing', () => {
  const a = (o) => OM.animFor(row({ status: 'tool', ...o }));
  const tool = (name) => a({ activity: { kind: 'tool', tool: name } });
  const cases = [
    ['Read', 'read', 'doc', 'read', false], ['Edit', 'edit', null, 'busy', true], ['apply_patch', 'edit', null, 'busy', true],
    ['Grep', 'search', 'magnifier', 'search', false], ['WebFetch', 'web', null, 'web', false], ['WebSearch', 'web', null, 'web', false],
    ['Bash', 'run', null, 'run', false], ['Task', 'dispatch', null, 'busy', false], ['mcp__thing', 'work', null, 'busy', true],
  ];
  for (const [name, act, prop, screen, typing] of cases) {
    const x = tool(name);
    assert.deepEqual([x.act, x.prop, x.screen, x.typing], [act, prop, screen, typing], name);
  }
  assert.equal(tool('Edit').fast, true);
  assert.equal(tool('Read').fast, false);
  assert.equal(tool('WebFetch').icon, 'web');
  const writing = OM.animFor(row({ status: 'working', activity: { kind: 'writing' } }));
  assert.deepEqual([writing.act, writing.fast, writing.typing], ['edit', true, true]);
  const think = OM.animFor(row({ status: 'working', activity: { kind: 'thinking' } }));
  assert.deepEqual([think.act, think.bubble, think.screen], ['think', 'think', 'glow']);
  const wait = OM.animFor(row({ status: 'waiting', activity: { kind: 'waiting' } }));
  assert.deepEqual([wait.act, wait.look, wait.bubble], ['wait', 'viewer', 'alert']);
  assert.equal(OM.animFor(row({ status: 'idle' })).act, 'idle');
  assert.equal(OM.animFor(row({ status: 'done' })).act, 'away');
});

test('lifecycle: finished leaves, long idle rests in the lounge, waiting stays visible', () => {
  const t0 = Date.parse('2026-01-01T12:00:00Z');
  const at = (msAgo) => new Date(t0 - msAgo).toISOString();
  const place = (o, msAgo) => OM.placeFor(row({ lastActivity: at(msAgo), ...o }), t0);
  assert.equal(place({ status: 'done', subagent: true, parent: 'x' }, 0), 'out');
  assert.equal(place({ status: 'done' }, 0), 'out');
  assert.equal(place({ status: 'waiting', subagent: true, parent: 'x' }, 0), 'out', 'a subagent that ended its turn is finished');
  assert.equal(place({ status: 'idle' }, 5000), 'desk');
  assert.equal(place({ status: 'idle' }, OM.LOUNGE_AFTER_MS), 'lounge');
  assert.equal(place({ status: 'idle' }, OM.LOUNGE_AFTER_MS * 10), 'lounge');
  assert.equal(place({ status: 'working' }, OM.LOUNGE_AFTER_MS * 10), 'desk', 'active sessions return to their desk');
  assert.equal(place({ status: 'tool' }, OM.LOUNGE_AFTER_MS * 10), 'desk');
  assert.equal(place({ status: 'waiting' }, OM.LOUNGE_AFTER_MS * 10), 'desk', 'waiting for the user stays at the desk');
  assert.equal(OM.placeFor(row({ status: 'idle', lastActivity: null }), t0), 'desk', 'unknown time: stay');
});

test('interactions: report, review, debate and dispatch events come from state changes only', () => {
  const orch = row({ id: 'O', role: 'orchestrator', project: 'p', status: 'working' });
  const kid = (id, role, status, extra = {}) => row({ id, role, parent: 'O', subagent: true, project: 'p', status, ...extra });
  let rows = [orch, kid('w1', 'worker', 'working', { task: { id: 'T1' } }), kid('rv', 'reviewer', 'idle'), kid('rf', 'refuter', 'idle')];
  let r = OM.detectEvents(null, rows);
  assert.deepEqual(r.events, [], 'nothing happens for sessions already on screen');
  // the worker finishes: it reports to the orchestrator; the reviewer starts: it visits the worker; the refuter starts: debates with the reviewer
  rows = [orch, kid('w1', 'worker', 'done', { task: { id: 'T1' } }), kid('rv', 'reviewer', 'working', { task: { id: 'T1' } }), kid('rf', 'refuter', 'tool')];
  r = OM.detectEvents(r.next, rows);
  const key = (e) => e.type + ':' + e.who + '>' + e.to;
  assert.deepEqual(r.events.map(key).sort(), ['debate:rf>rv', 'report:w1>O', 'review:rv>w1']);
  // same data again: no new events
  assert.deepEqual(OM.detectEvents(r.next, rows).events, []);
  // a new subagent: its parent hands it a paper
  const fresh = kid('w2', 'worker', 'working');
  r = OM.detectEvents(r.next, rows.concat(fresh));
  assert.deepEqual(r.events.map(key), ['dispatch:O>w2']);
  // the reviewer prefers the worker with the same task
  const rows2 = [orch, kid('wa', 'worker', 'done'), kid('wb', 'worker', 'done', { task: { id: 'T9' } }), kid('rv2', 'reviewer', 'idle', { task: { id: 'T9' } })];
  const p = OM.detectEvents(null, rows2);
  const rows3 = rows2.map((x) => (x.id === 'rv2' ? { ...x, status: 'working' } : x));
  assert.deepEqual(OM.detectEvents(p.next, rows3).events.map(key), ['review:rv2>wb']);
  // a refuter without a reviewer has nobody to talk to; a top-level finished session reports to nobody
  const solo = [orch, kid('rf2', 'refuter', 'idle')];
  const s0 = OM.detectEvents(null, solo);
  assert.deepEqual(OM.detectEvents(s0.next, solo.map((x) => (x.id === 'rf2' ? { ...x, status: 'working' } : x))).events, []);
  const top = [row({ id: 'T', status: 'working' })];
  const t1 = OM.detectEvents(null, top);
  assert.deepEqual(OM.detectEvents(t1.next, [{ ...top[0], status: 'done' }]).events, []);
});

test('layout: every room has a lounge, a door and enough rest spots inside the room', () => {
  const st = OM.assign(null, [row({ id: 'a', project: 'p1' }), row({ id: 'b', project: 'p1' })]);
  const room = OM.layout(st, { maxCols: 1 }).rooms[0];
  assert.ok(room.spots.length >= 5 && room.spots.length <= OM.LOUNGE_MAX);
  assert.equal(room.spots.filter((s) => s.kind === 'sofa').length, 3);
  const last = Math.max(...room.desks.map((d) => d.y + OM.CELL_H));
  assert.ok(room.lounge.y >= last - 20 && room.lounge.y + room.lounge.h <= room.h, 'lounge sits under the pods, inside the room');
  room.spots.forEach((s) => assert.ok(s.x >= 0 && s.x + SP.CHAR_W <= room.w && s.y + SP.CHAR_H <= room.h, 'spot inside the room'));
  assert.ok(room.door.x >= 0 && room.door.x + room.door.w <= room.w);
  assert.equal(room.door.at.y + SP.CHAR_H - 1, OM.WALL_H + 8, 'the door is at the back wall base');
});

test('looks: roles keep a signature accessory, everyone else varies with the id', () => {
  assert.equal(OM.looks(row({ role: 'reviewer' })).acc, 'glasses');
  assert.equal(OM.looks(row({ role: 'orchestrator' })).acc, 'headset');
  const combos = new Set();
  const accs = new Set();
  for (let i = 0; i < 400; i++) {
    const l = OM.looks(row({ id: 'who-' + i, role: i % 3 ? 'worker' : 'other' }));
    assert.ok(SP.ACCESSORIES.includes(l.acc));
    if (l.role !== 'other') assert.notEqual(l.acc, 'cap', 'a cap would hide the role mark');
    accs.add(l.acc);
    combos.add([l.style, l.hair, l.skin, l.acc].join());
  }
  assert.ok(accs.size >= 4);
  assert.ok(combos.size > 150, 'two characters rarely look the same: ' + combos.size);
});

test('layout: pods are sized to the people in them, plus one spare desk, and stay put between refreshes', () => {
  const kid = (id, parent) => row({ id, parent, subagent: true, project: 'p1' });
  const solo = OM.layout(OM.assign(null, [row({ id: 'S', project: 'p1' })]), { maxCols: 3 }).rooms[0];
  assert.equal(solo.desks.length, 2, 'one person: their desk and one spare');
  assert.equal(solo.desks.filter((d) => d.id).length, 1);
  const pair = OM.layout(OM.assign(null, [row({ id: 'P', project: 'p1' }), kid('k1', 'P')]), { maxCols: 3 }).rooms[0];
  assert.equal(pair.desks.length, 3);
  const five = OM.layout(OM.assign(null, [row({ id: 'P', project: 'p1' }), kid('a', 'P'), kid('b', 'P'), kid('c', 'P'), kid('d', 'P')]), { maxCols: 3 }).rooms[0];
  assert.equal(five.desks.length, 6, 'five people: a row of three plus a row of three, one spare');
  assert.ok(five.desks.every((d) => !d.free || d.y > five.desks[0].y), 'the spare desk is in the last row');
  // five lone sessions no longer get 15 desks
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(row({ id: 'q' + i, project: 'p1' }));
  const many = OM.layout(OM.assign(null, rows), { maxCols: 4 }).rooms[0];
  assert.equal(many.desks.length, 10);
  assert.ok(many.w >= OM.MIN_ROOM_W);
  // an unchanged refresh gives the same coordinates; a newcomer in another pod moves nobody who was already placed
  const st1 = OM.assign(null, rows);
  const a1 = OM.layout(st1, { maxCols: 4 }).pos;
  const st2 = OM.assign(st1, rows.slice().reverse());
  const a2 = OM.layout(st2, { maxCols: 4 }).pos;
  assert.deepEqual(a2, a1);
  const st3 = OM.assign(st2, rows.concat(row({ id: 'q9', project: 'p1' })));
  const a3 = OM.layout(st3, { maxCols: 4 }).pos;
  for (const id of Object.keys(a1)) assert.deepEqual([a3[id].x, a3[id].y], [a1[id].x, a1[id].y], id);
});

test('lounge: more spots in wider rooms, capped; hit-picking takes the topmost character; per-id state is pruned', () => {
  const narrow = OM.loungeSpots({ x: 10, y: 100, w: 144, h: 44 });
  const wide = OM.loungeSpots({ x: 10, y: 100, w: 700, h: 44 });
  assert.ok(wide.length > narrow.length);
  assert.equal(wide.length, OM.LOUNGE_MAX);
  assert.equal(new Set(wide.map((s) => s.x + ',' + s.y)).size, wide.length, 'no two spots on the same pixel');
  // a walker in front of a desk wins over characters behind it; outside everyone: null
  const cands = [{ id: 'back', x: 10, y: 10, w: 24, h: 32 }, { id: 'front', x: 20, y: 30, w: 24, h: 32 }];
  assert.equal(OM.pickActor(cands, 25, 35), 'front');
  assert.equal(OM.pickActor(cands, 12, 12), 'back');
  assert.equal(OM.pickActor(cands, 100, 100), null);
  assert.equal(OM.pickActor([], 1, 1), null);
  // departed ids leave every per-id map
  const blinks = { a: 1, b: 2, c: 3 };
  assert.equal(OM.prune(blinks, { a: true }), 2);
  assert.deepEqual(Object.keys(blinks), ['a']);
});

test('office page strings describe the v3 office', () => {
  for (const l of ['en', 'zh-TW']) {
    const s = table(l)['office.states'];
    assert.doesNotMatch(s, /Empty desk|空桌/, l + ' no longer says an empty desk means done');
  }
  assert.match(table('en')['office.states'], /door/i);
  assert.match(table('en')['office.states'], /sofa/i);
  assert.match(table('zh-TW')['office.states'], /門/);
  assert.match(table('zh-TW')['office.states'], /沙發/);
});

test('layout: pods collapse when nobody sits there, spare desk only with seated people, no jumping on refresh', () => {
  const T0 = Date.parse('2026-01-01T12:00:00Z');
  const place = (r) => OM.placeFor(r, T0);
  const old = new Date(T0 - OM.LOUNGE_AFTER_MS * 2).toISOString();
  const cur = new Date(T0).toISOString();
  const mk = (id, status, extra = {}) => row({ id, status, project: 'p1', lastActivity: cur, ...extra });
  const kid = (id, parent, status, extra = {}) => mk(id, status, { parent, subagent: true, ...extra });
  const rows = [
    mk('P', 'working', { role: 'orchestrator' }), kid('a', 'P', 'working'), kid('b', 'P', 'done'), kid('c', 'P', 'done'),
    mk('Q', 'done'),                                    // nobody there at all: finished
    mk('R', 'idle', { lastActivity: old }),             // resting in the lounge: keeps one desk to return to, no spare
    mk('S', 'working'),
  ];
  const build = (rs, drawn, st) => {
    OM.markDrawn(drawn, rs, place);
    const state = OM.assign(st || null, OM.visibleRows(rs, place, drawn));
    const seated = {};
    rs.forEach((r) => { if (place(r) === 'desk') seated[r.id] = true; });
    return { state, lay: OM.layout(state, { maxCols: 4, drawn, seated }) };
  };
  const drawn = {};
  const b = build(rows, drawn);
  const room = b.lay.rooms[0];
  const ids = room.desks.filter((d) => d.id).map((d) => d.id).sort();
  assert.deepEqual(ids, ['P', 'R', 'S', 'a'], 'finished sessions get no desk');
  assert.equal(room.desks.filter((d) => d.free).length, 2, 'spare desks only in pods with seated people (P and S), none for the lounge resident');
  assert.equal(room.pods.length, 3, 'the finished pod Q is not drawn');
  assert.equal(room.pods.find((p) => p.w === OM.CELL_W).h, OM.CELL_H, 'the lounge resident has a one-desk pod');
  assert.ok(room.desks.length <= 6);
  // a refresh in which b is still done and a goes done: nobody moves, a keeps its (empty) desk
  const before = b.lay.pos;
  const rows2 = rows.map((r) => (r.id === 'a' ? { ...r, status: 'done' } : r));
  const b2 = build(rows2, drawn, b.state);
  for (const id of ['P', 'a', 'R', 'S']) assert.deepEqual([b2.lay.pos[id].x, b2.lay.pos[id].y], [before[id].x, before[id].y], id);
  // a full rebuild (nothing drawn yet) compacts: a is gone now and the pod shrinks to its orchestrator and a spare
  const fresh = build(rows2, {});
  assert.equal(fresh.lay.pos.a, undefined);
  assert.ok(fresh.lay.rooms[0].desks.length < room.desks.length);
  // a finished session that comes back active gets a desk again
  const back = build(rows2.map((r) => (r.id === 'Q' ? { ...r, status: 'working' } : r)), drawn, b2.state);
  assert.ok(back.lay.pos.Q);
  // everything finished: no desks, but the room (lounge, door) is still there
  const allDone = rows.map((r) => ({ ...r, status: 'done' }));
  const d3 = {};
  OM.markDrawn(d3, allDone, place);
  const lay3 = OM.layout(OM.assign(null, OM.visibleRows(allDone, place, d3)), { maxCols: 3, drawn: d3 });
  assert.equal(lay3.rooms.length, 1);
  assert.equal(lay3.rooms[0].desks.length, 0);
});

test('layout: pods are packed like masonry, a tall pod does not stretch its neighbours', () => {
  const kid = (id, parent) => row({ id, parent, subagent: true, project: 'p1' });
  const rows = [row({ id: 'T', project: 'p1' })];
  for (let i = 0; i < 4; i++) rows.push(kid('k' + i, 'T'));          // a 3 x 2 pod (5 people and a spare)
  for (let i = 0; i < 2; i++) rows.push(row({ id: 'z' + i, project: 'p1' }));
  const lay = OM.layout(OM.assign(null, rows), { maxCols: 2 });
  const room = lay.rooms[0];
  const tall = room.pods.find((p) => p.h === 2 * OM.CELL_H);
  assert.ok(tall);
  const small = room.pods.filter((p) => p.h === OM.CELL_H);
  assert.equal(small.length, 2);
  // small pods sit side by side with and underneath each other, not each in a row as tall as the tall pod
  assert.ok(small.some((p) => p.y > tall.y), 'a small pod is packed below the first row');
  const bottom = Math.max(...room.pods.map((p) => p.y + p.h));
  assert.ok(bottom - room.pods[0].y <= 2 * OM.CELL_H + 2 * OM.POD_GAP, 'two rows are enough');
  // no overlaps
  room.pods.forEach((p, i) => room.pods.forEach((q, j) => {
    if (i < j) assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, `pods ${i} and ${j} overlap`);
  }));
  room.desks.forEach((d) => assert.ok(room.pods.some((p) => d.x >= p.x && d.x + OM.CELL_W <= p.x + p.w && d.y >= p.y && d.y + OM.CELL_H <= p.y + p.h), 'every desk is inside a pod'));
  // earlier pods never move when another one is added
  const more = OM.layout(OM.assign(OM.assign(null, rows), rows.concat(row({ id: 'zz', project: 'p1' }))), { maxCols: 2 }).rooms[0];
  room.pods.forEach((p, i) => assert.deepEqual([more.pods[i].x, more.pods[i].y], [p.x, p.y]));
});

test('name plate font: 3 x 5 letters', () => {
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = SP.glyphSmall(ch); assert.equal(g.length, 5, ch); g.forEach((r) => assert.equal(r.length, 3, ch)); }
  assert.equal(SP.glyphSmall('1'), null);
  assert.equal(SP.textWidthSmall('LEAD'), 15);
  assert.deepEqual(SP.CELL.screen, { x: 3, y: 3, w: 12, h: 7 });
  const mon = SP.SPRITES.monitor;
  assert.ok(SP.CELL.screen.x + SP.CELL.screen.w <= mon[0].length && SP.CELL.screen.y + SP.CELL.screen.h <= mon.length);
});

test('layout: between full rebuilds a pod only grows into free space, nothing already placed moves', () => {
  const kid = (id, parent) => row({ id, parent, subagent: true, project: 'p1' });
  const A = row({ id: 'A', project: 'p1' });
  const B = row({ id: 'B', project: 'p1' });
  const placed = {};
  let st = OM.assign(null, [A, B]);
  let lay = OM.layout(st, { maxCols: 2, placed });
  const at = (l, id) => [l.pos[id].x, l.pos[id].y];
  const a0 = at(lay, 'A');
  const b0 = at(lay, 'B');
  assert.deepEqual([a0[0], b0[0]], [10, 112], 'two solo pods side by side');
  // A gets its first child: A and B stay exactly where they are, the child sits in the pod's spare desk
  const rows1 = [A, B, kid('a1', 'A')];
  st = OM.assign(st, rows1);
  lay = OM.layout(st, { maxCols: 2, placed });
  assert.deepEqual(at(lay, 'A'), a0);
  assert.deepEqual(at(lay, 'B'), b0);
  assert.ok(lay.pos.a1, 'the child has a desk');
  // a fresh layout without memory is allowed to tidy (orchestrator in the middle), that is the full rebuild
  assert.notDeepEqual(at(OM.layout(st, { maxCols: 2 }), 'A'), a0);
  // more children: still nothing moves, desks never overlap, and everybody has a desk
  let rows = rows1;
  for (let i = 2; i <= 7; i++) {
    rows = rows.concat(kid('a' + i, 'A'));
    st = OM.assign(st, rows);
    lay = OM.layout(st, { maxCols: 2, placed });
    assert.deepEqual(at(lay, 'A'), a0, 'A after child ' + i);
    assert.deepEqual(at(lay, 'B'), b0, 'B after child ' + i);
    for (let j = 1; j <= i; j++) assert.ok(lay.pos['a' + j], 'a' + j);
    const ds = lay.rooms[0].desks;
    ds.forEach((d, x) => ds.forEach((e, y) => { if (x < y) assert.ok(d.x + OM.CELL_W <= e.x || e.x + OM.CELL_W <= d.x || d.y + OM.CELL_H <= e.y || e.y + OM.CELL_H <= d.y, 'desks overlap'); }));
    lay.rooms[0].desks.forEach((d) => assert.ok(lay.rooms[0].pods.some((p) => d.x >= p.x && d.x + OM.CELL_W <= p.x + p.w && d.y >= p.y && d.y + OM.CELL_H <= p.y + p.h), 'every desk is inside a pod'));
  }
  // when the pod cannot grow (maxCols 1: B sits right below A) the newcomer gets a one-desk pod of its own
  const placed1 = {};
  let s1 = OM.assign(null, [A, B]);
  let l1 = OM.layout(s1, { maxCols: 1, placed: placed1 });
  const a1 = at(l1, 'A');
  const b1 = at(l1, 'B');
  assert.ok(b1[1] > a1[1], 'stacked');
  let r1 = [A, B];
  for (let i = 1; i <= 5; i++) {
    r1 = r1.concat(kid('c' + i, 'A'));
    s1 = OM.assign(s1, r1);
    l1 = OM.layout(s1, { maxCols: 1, placed: placed1 });
    assert.deepEqual(at(l1, 'A'), a1);
    assert.deepEqual(at(l1, 'B'), b1);
    assert.ok(l1.pos['c' + i], 'c' + i);
  }
  assert.ok(l1.rooms[0].pods.length >= 3, 'a one-desk pod was added');
  // leavers and gone rooms take their memory with them
  OM.layout(OM.assign(null, [A]), { maxCols: 2, placed: placed1 });
  assert.ok(Object.keys(placed1).every((k) => k === 'p1|A'));
  OM.layout(OM.assign(null, [row({ id: 'Z', project: 'other' })]), { maxCols: 2, placed: placed1 });
  assert.deepEqual(Object.keys(placed1), ['other|Z']);
});

test('lounge seats: overflow residents move into freed visible spots, lists are trimmed', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];                 // 5 visible spots, f and g wait behind the badge
  assert.deepEqual(OM.rebalanceSeats(list, 5), []);
  list[1] = null;                                                    // b goes back to work
  assert.deepEqual(OM.rebalanceSeats(list, 5), [{ id: 'f', from: 5, to: 1 }]);
  assert.deepEqual(list, ['a', 'f', 'c', 'd', 'e', null, 'g']);
  list[0] = null; list[3] = null;                                    // two more leave: g takes the lowest free spot, nobody is left waiting
  assert.deepEqual(OM.rebalanceSeats(list, 5), [{ id: 'g', from: 6, to: 0 }]);
  assert.deepEqual(list, ['g', 'f', 'c', null, 'e']);
  assert.deepEqual(OM.rebalanceSeats(['a', null, null], 5), [], 'trailing nulls are trimmed');
  const l2 = ['x', null, null];
  OM.rebalanceSeats(l2, 5);
  assert.deepEqual(l2, ['x']);
  assert.deepEqual(OM.rebalanceSeats([], 5), []);
});
