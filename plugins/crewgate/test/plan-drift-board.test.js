'use strict';

// Drift on the project page: the API returns the last 10 drift events and the --outside-plan count; a project
// with none shows no heading; text from an event is shown as text; the skills name the commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const events = require('../lib/core/events');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'board', 'public');
const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const TYPES = ['plan.drift_asked', 'plan.drift_answered', 'plan.drift_unasked', 'plan.drift_denied', 'task.outside_plan', 'task.scope_widened', 'task.scope_warned'];

let board;
let port;
let busy;
let quiet;
const get = (p) => h.request(port, { path: p });
let n = 0;
const ev = (pid, type, data, task) => events.append(pid, { type, src: 'cli', task, data, key: `${type}:${++n}` });

test.before(async () => {
  busy = projects.add(h.makeRepo(), { name: 'busy' }).project;
  quiet = projects.add(h.makeRepo(), { name: 'quiet' }).project;
  for (let i = 0; i < 12; i++) ev(busy.id, 'task.outside_plan', { reason: i === 11 ? '<script>alert(1)</script>' : `fix ${i}`, plans: [] }, 't-20260101-aaaa');
  ev(busy.id, 'plan.drift_asked', { slug: 'demo', kind: 'new-step', gate: 'g1' });
  ev(busy.id, 'plan.drift_answered', { slug: 'demo', kind: 'new-step', answer: 'add', gate: 'g1' });
  ev(busy.id, 'plan.drift_unasked', { slug: 'demo', kind: 'new-step' });
  ev(busy.id, 'plan.drift_denied', { slug: 'demo', kind: 'out-of-scope' });
  ev(busy.id, 'task.scope_widened', { reason: 'agreed', files: ['a'], gate: 'g2' }, 't-20260101-aaaa');
  ev(busy.id, 'task.scope_warned', { files: ['a', 'b'], count: 2 }, 't-20260101-aaaa');
  ev(busy.id, 'task.created', { title: 'not drift' });
  board = createBoard({ claudeRoot: h.tmpDir('crew-claude-'), codexRoot: h.tmpDir('crew-codex-'), watcher: { ttlMs: 0 } });
  port = await board.listen(0);
});
test.after(() => board.close());

test('project API returns the last 10 drift events (newest first) and the --outside-plan count', async () => {
  const d = (await get(`/api/project/${busy.id}`)).json;
  assert.ok(d.plan_drift, 'plan_drift present');
  assert.equal(d.plan_drift.recent.length, 10);
  assert.equal(d.plan_drift.outside_plan, 12);
  for (const e of d.plan_drift.recent) assert.ok(TYPES.includes(e.type), e.type);
  assert.equal(d.plan_drift.recent[0].type, 'task.scope_warned');
  assert.equal(d.plan_drift.recent[0].count, 2);
  assert.ok(d.plan_drift.recent.some((e) => e.type === 'plan.drift_answered' && e.answer === 'add' && e.slug === 'demo' && e.kind === 'new-step'));
  assert.ok(d.plan_drift.recent.every((e) => Date.parse(e.ts) > 0));
});

test('a project with no drift events returns an empty list and the page draws nothing for it', async () => {
  const d = (await get(`/api/project/${quiet.id}`)).json;
  assert.deepEqual(d.plan_drift, { recent: [], outside_plan: 0 });
  // the page code: a null note when there is no count and no row, so no heading
  const note = new Function('t', 'h', 'S', 'when', `${driftSource()}; return driftNote;`)(
    (k) => k, () => { throw new Error('built a node'); }, { mask: false }, (x) => x);
  assert.equal(note(d.plan_drift), null);
  assert.equal(note(undefined), null);
});

// The drift helpers of app.js, cut out of the source so they run with a stub DOM builder.
function driftSource() {
  const a = appSrc.indexOf('var DRIFT_LINE');
  const b = appSrc.indexOf('// Project page card: one row per plan');
  assert.ok(a > 0 && b > a, 'drift helpers found');
  return appSrc.slice(a, b);
}

test('event text reaches the page only as text, never as markup', () => {
  const src = driftSource();
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const en = JSON.parse(fs.readFileSync(path.join(PUB, 'i18n', 'en.json'), 'utf8'));
  const tt = (k, v) => String(en[k] === undefined ? k : en[k]).replace(/\{(\w+)\}/g, (m, x) => (v && v[x] !== undefined ? String(v[x]) : m));
  // a builder like the page's h(): text goes in `text` or as a child string, markup is never parsed
  const node = (tag, attrs, ...kids) => ({ tag, text: attrs && attrs.text, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) });
  const build = new Function('t', 'h', 'S', 'when', `${src}; return driftNote;`)(tt, node, { mask: false }, (x) => x);
  const out = build({ outside_plan: 1, recent: [{ ts: '2026-11-01T00:00:00Z', type: 'task.outside_plan', task: 't-1', reason: '<script>alert(1)</script>' }] });
  const flat = JSON.stringify(out);
  assert.ok(flat.includes('<script>alert(1)</script>'), 'the reason is shown');
  // it sits in a plain string child (a text node), not in a tag name or attribute
  const li = out.kids[2].kids[0];
  assert.ok(li.kids.includes('Task started outside any plan. Reason: <script>alert(1)</script>'));
  assert.ok(!/<script/.test(JSON.stringify(Object.keys(li)) + li.tag));
});

test('the page shows the --outside-plan count and a list in both languages', () => {
  for (const lang of ['en', 'zh-TW']) {
    const t = JSON.parse(fs.readFileSync(path.join(PUB, 'i18n', `${lang}.json`), 'utf8'));
    for (const k of ['plan.driftTitle', 'plan.driftOutside', 'plan.driftOutsideOne', 'plan.driftOutsideHigh', 'plan.drift.asked', 'plan.drift.answered', 'plan.drift.unasked', 'plan.drift.denied', 'plan.drift.outside', 'plan.drift.widened', 'plan.drift.warned']) assert.ok(t[k], `${lang} ${k}`);
  }
  assert.match(appSrc, /driftNote\(d\.plan_drift\)/);
});

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\s+/g, ' ');

test('plan skill: "When work drifts" names the commands and the rules', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'skills', 'plan', 'SKILL.md'), 'utf8');
  assert.ok(raw.split('\n').length < 133);
  const s = read('skills', 'plan', 'SKILL.md');
  assert.ok(s.includes('When work drifts'));
  for (const c of ['crew plan drift', '--gate', '--answer', '--outside-plan', 'end the turn', 'Never edit the plan file', '`add`', '`goal`', '`new`', '`drop`', '`defer`']) assert.ok(s.includes(c), c);
});

test('crew skill points at the drift section; commands.md lists the drift commands', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'skills', 'crew', 'SKILL.md'), 'utf8');
  assert.ok(raw.split('\n').length < 250);
  const s = read('skills', 'crew', 'SKILL.md');
  assert.ok(s.includes('When work drifts'));
  assert.ok(s.includes('task accept <id> --widen'));
  const cmds = read('skills', 'crew', 'references', 'commands.md');
  for (const c of ['crew plan drift', 'crew plan drift-stats', '--outside-plan', 'task accept', '--widen']) assert.ok(cmds.includes(c), c);
});
