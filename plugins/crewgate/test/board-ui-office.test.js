'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SP = require('../board/public/office-sprites.js');
const OM = require('../board/public/office-model.js');
const SM = require('../board/public/sessions-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
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
    SP.HAIR[theme].forEach((h) => assert.deepEqual(Object.keys(h).sort(), ['H', 'J', 'h']));
    SP.SKIN[theme].forEach((k) => assert.deepEqual(Object.keys(k).sort(), ['S', 'q', 's']));
  }
  assert.equal(SP.STYLES, OM.STYLES);
  assert.equal(SP.HAIR.light.length, OM.HAIRS);
  assert.equal(SP.SKIN.light.length, OM.SKINS);
  // furniture fits a desk cell and the model agrees with the sprite file about the cell
  assert.equal(SP.CELL.w, OM.CELL_W);
  assert.equal(SP.CELL.h, OM.CELL_H);
  assert.ok(SP.SPRITES.desk[0].length <= SP.CELL.w);
  assert.ok(SP.SPRITES.bubbleSpeech[0].length <= SP.CELL.w);
  assert.ok(SP.CELL.charX + SP.CHAR_W <= SP.CELL.w && SP.CELL.charY + SP.CHAR_H <= SP.CELL.h);
});

test('state -> animation mapping', () => {
  const a = (o) => OM.animFor(row(o));
  assert.deepEqual([a({ status: 'working', activity: { kind: 'thinking' } }).bubble, a({ status: 'working', activity: { kind: 'thinking' } }).typing], ['think', false]);
  const tool = a({ status: 'tool', activity: { kind: 'tool', tool: 'Bash' } });
  assert.deepEqual([tool.bubble, tool.icon, tool.typing, tool.screen], ['icon', 'terminal', true, 'busy']);
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
  assert.equal(k('WebFetch'), 'search');
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
  assert.ok(lay.rooms.every((r) => r.desks.length >= 3 && r.desks.length % 3 === 0));
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
  assert.equal(three.rooms[0].cols, 3);
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
  const html = read('index.html');
  for (const s of ['/office-sprites.js', '/office-model.js', '/office.js', '/office.css']) assert.ok(html.includes(`"${s}"`), s);
  // the models load before the page script
  assert.ok(html.indexOf('/office-model.js') < html.indexOf('/office.js') && html.indexOf('/office.js') < html.indexOf('/app.js'));
  // reduced motion and hidden tabs are respected
  const src = read('office.js');
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /document\.hidden/);
  assert.match(src, /imageSmoothingEnabled = false/);
});

test('the board serves the office files and the nav links to #/office', () => {
  const app = read('app.js');
  assert.match(app, /'#\/office'/);
  assert.match(app, /\['sessions', 'office'/);
});
