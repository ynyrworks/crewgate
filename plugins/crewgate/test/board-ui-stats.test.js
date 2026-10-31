'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SM = require('../board/public/sessions-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const table = (l) => JSON.parse(read(`i18n/${l}.json`));

test('durations and token counts are compact and stable', () => {
  assert.equal(SM.fmtDuration(0), '0s');
  assert.equal(SM.fmtDuration(400), '<1s');
  assert.equal(SM.fmtDuration(8000), '8s');
  assert.equal(SM.fmtDuration(252000), '4m 12s');
  assert.equal(SM.fmtDuration(3900000), '1h 05m');
  assert.equal(SM.fmtDuration(2 * 86400000 + 3 * 3600000), '2d 3h');
  assert.equal(SM.fmtDuration(-5), '–');
  assert.equal(SM.compact(950), '950');
  assert.equal(SM.compact(12345), '12.3k');
  assert.equal(SM.compact(3400000), '3.4M');
  assert.equal(SM.compact(999999), '1M');
});

test('the card shows a parent\'s totals (with subagents) and its own numbers otherwise', () => {
  const own = { duration_ms: 1000, prompts: 2, tool_calls: 3, tokens: { input: 10, output: 5, cache_write: 0, cache_read: 100 }, cost: 0.5, cost_complete: true, partial: false };
  assert.equal(SM.cardStats({}), null);
  const solo = SM.cardStats({ stats: own });
  assert.deepEqual([solo.prompts, solo.tools, solo.tokens, solo.cost, solo.sessions], [2, 3, 115, 0.5, 1]);
  const parent = SM.cardStats({ stats: own, totals: { ...own, tool_calls: 9, sessions: 3, partial: true } });
  assert.deepEqual([parent.tools, parent.sessions, parent.partial], [9, 3, true]);
});

const ev = (key, ts, extra = {}) => ({ key, ts, kind: 'tool', tool: 'Bash', ...extra });

test('timeline merging: refresh adds new steps and keeps older pages; load older prepends without duplicates', () => {
  let st = SM.mergeLatest(SM.emptyTimeline(), { events: [ev('a', 3), ev('b', 4)], cursor: 100, cursor_ts: 3 });
  assert.deepEqual(st.events.map((e) => e.key), ['a', 'b']);
  st = SM.mergeOlder(st, { events: [ev('x', 1), ev('y', 2), ev('a', 3)], cursor: 40, cursor_ts: 1 });
  assert.deepEqual(st.events.map((e) => e.key), ['x', 'y', 'a', 'b']);
  assert.equal(st.cursor, 40);
  // the next refresh brings the latest page again, with one more step and a duration for an old one
  st = SM.mergeLatest(st, { events: [ev('a', 3), ev('b', 4, { dur_ms: 5000 }), ev('c', 5)], cursor: 100, cursor_ts: 3 });
  assert.deepEqual(st.events.map((e) => e.key), ['x', 'y', 'a', 'b', 'c']);
  assert.equal(st.events[3].dur_ms, 5000);
  assert.equal(st.cursor, 40, 'the older cursor is kept');
  // a page that does not touch what is loaded (a lot happened in between) replaces it
  st = SM.mergeLatest(st, { events: [ev('p', 50), ev('q', 51)], cursor: 900, cursor_ts: 50 });
  assert.deepEqual(st.events.map((e) => e.key), ['p', 'q']);
  assert.equal(st.cursor, 900);
});

test('gaps between steps and day changes', () => {
  const day = 86400000;
  const rows = SM.withGaps([ev('a', 1000), ev('b', 4000), ev('c', 4000 + day * 2), { key: 'd', ts: null, kind: 'error' }]);
  assert.deepEqual(rows.map((r) => r.gap), [null, 3000, day * 2, null]);
  assert.equal(rows[0].newDay, true);
  assert.equal(rows[2].newDay, true);
  assert.deepEqual(SM.kindCounts([ev('a', 1), ev('b', 2, { kind: 'prompt' }), ev('c', 3)]), { tool: 2, prompt: 1 });
});

test('private mode only removes text from steps; ids in links are validated', () => {
  const step = { text: 'hello', target: 'a.js', agent_type: 'x' };
  assert.deepEqual(SM.stepText(step, false), { text: 'hello', target: 'a.js', agentType: 'x' });
  assert.deepEqual(SM.stepText(step, true), { text: null, target: null, agentType: null });
  assert.deepEqual(SM.stepText({}, false), { text: null, target: null, agentType: null });
  assert.equal(SM.validId('0123456789ab'), true);
  for (const bad of ['0123456789a', '0123456789abc', 'zzzzzzzzzzzz', '../../x', null, undefined, 12]) assert.equal(SM.validId(bad), false);
});

test('page wiring: route, links, accessible controls, only DOM text nodes, both languages complete', () => {
  const src = read('app.js');
  assert.match(src, /p\[0\] === 's' && p\[1\]\) return \{ page: 'session'/);
  assert.match(src, /href: '#\/s\/'/);
  assert.match(src, /'aria-pressed'/);
  assert.match(src, /SM\.validId\(r\.id\)/, 'the id from the address is checked before it reaches a request');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(read('index.html'), /<script src="\/sessions-model\.js"><\/script>\s*<script src="\/update-model\.js"><\/script>\s*<script src="\/activity-model\.js"><\/script>\s*<script src="\/app\.js">/, 'no new script tag: the helpers live in sessions-model.js');
  const en = table('en');
  const zh = table('zh-TW');
  const keys = new Set();
  for (const m of src.matchAll(/'((?:stats|sessions)\.[A-Za-z0-9]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/plural\('([^']+)'/g)) { keys.add(m[1]); keys.add(`${m[1]}1`); }
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(zh[k], `zh-TW ${k}`); }
  assert.ok(keys.has('stats.linePrompts1') && keys.has('sessions.kindError'));
  for (const k of ['Prompt', 'Tool', 'Subagent', 'Crew', 'Error']) assert.ok(en[`sessions.kind${k}`], k);
});

test('styles: timeline and stats work in both themes and on a phone', () => {
  const css = read('app.css');
  assert.match(css, /\.tl-item\.is-err/);
  assert.match(css, /\.kinds button\[aria-pressed="true"\]::before/, 'the selected filter differs by more than colour');
  assert.match(css, /\.tl-item:focus-visible/);
  assert.match(css, /max-width: 480px[\s\S]*\.tl-item/);
  assert.doesNotMatch(css.split('session statistics and activity timeline')[1], /#[0-9a-fA-F]{3,8}\b/, 'colours come from the theme variables');
});
