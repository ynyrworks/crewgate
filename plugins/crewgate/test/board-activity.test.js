'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

const HOME = h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const tasks = require('../lib/core/tasks');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');
const store = require('../lib/core/store');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let board;
let port;
let repo;
const get = (p) => h.request(port, { path: p });
const claudeRoot = h.tmpDir('crew-claude-');
const codexRoot = h.tmpDir('crew-codex-');

test.before(async () => {
  repo = h.makeRepo();
  board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  port = await board.listen(0);
});
test.after(() => board.close());

function newProject(name) { return projects.add(h.makeRepo(), { name }).project; }
const ev = (pid, type, ts, extra) => events.append(pid, { type, src: 'cli', ts, ...extra });

test('activity: a project with no events has an empty list', async () => {
  const p = newProject('quiet');
  const r = await get(`/api/project/${p.id}`);
  assert.deepEqual(r.json.activity, []);
});

test('activity: real task flow gives steps with task titles, merges carry branch and commit', async () => {
  const p = newProject('flow');
  const a = tasks.createTask(p.id, { title: 'Alpha thing', brief: h.GOOD_BRIEF });
  tasks.transition(p.id, a.id, 'dispatched');
  tasks.transition(p.id, a.id, 'returned');
  tasks.transition(p.id, a.id, 'dispatched', { note: 'fix' });
  tasks.transition(p.id, a.id, 'returned');
  tasks.transition(p.id, a.id, 'accepted');
  tasks.transition(p.id, a.id, 'merged', { data: { branch: 'crew/alpha' }, note: 'abc1234' });
  ev(p.id, 'git.push', new Date().toISOString(), { data: { command: 'git push', remote: 'origin', refs: ['main'], flags: [] } });
  const d = (await get(`/api/project/${p.id}`)).json;
  const types = d.activity.map((x) => x.type);
  for (const t of ['task.created', 'task.returned', 'task.sent_back', 'task.accepted', 'task.merged', 'git.push']) assert.ok(types.includes(t), t);
  const merged = d.activity.find((x) => x.type === 'task.merged');
  assert.equal(merged.title, 'Alpha thing');
  assert.equal(merged.task, a.id);
  assert.equal(merged.data.note, 'abc1234');
  const push = d.activity.find((x) => x.type === 'git.push');
  assert.equal(push.data.remote, 'origin');
  assert.deepEqual(push.data.refs, ['main']);
  // newest first
  const ts = d.activity.map((x) => x.ts);
  assert.deepEqual(ts, ts.slice().sort().reverse());
});

test('activity: bounds, and a merge far back is still found beyond the 40-event tail', async () => {
  const p = newProject('long');
  ev(p.id, 'task.merged', '2026-01-01T00:00:00.000Z', { task: 't-old', data: { branch: 'old-branch', note: 'deadbee' }, key: 'old' });
  for (let i = 0; i < 300; i++) ev(p.id, 'tool.used', new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(), { key: `n${i}`, data: { n: i } });
  for (let i = 0; i < 30; i++) ev(p.id, 'task.created', new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(), { task: `t-${i}`, key: `c${i}` });
  for (let i = 0; i < 5; i++) ev(p.id, 'git.push', new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString(), { key: `p${i}`, data: { remote: 'origin', refs: [`r${i}`] } });
  const d = (await get(`/api/project/${p.id}`)).json;
  assert.equal(d.events.length, 40);
  assert.ok(!d.events.some((e) => e.type === 'task.merged'), 'the old merge is outside the event tail');
  const steps = d.activity.filter((x) => x.type === 'task.created');
  const pushes = d.activity.filter((x) => x.type === 'git.push');
  const merges = d.activity.filter((x) => x.type === 'task.merged');
  assert.equal(steps.length, 15);
  assert.equal(pushes.length, 5);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].data.branch, 'old-branch');
  assert.equal(merges[0].title, null);
  assert.ok(d.activity.filter((x) => x.type === 'task.merged' || x.type === 'git.push').length <= 10);
});

test('activity: gate answers and plan creation; no free text, `last` stays out', async () => {
  const p = newProject('gates');
  ev(p.id, 'gate.answered', '2026-02-01T00:00:00.000Z', { key: 'g', data: { id: 'g1', gate: 'push', answer: 'yes', last: 'SECRET-TEXT' } });
  ev(p.id, 'plan.created', '2026-02-02T00:00:00.000Z', { key: 'pl', data: { slug: 'big', title: 'Big plan' } });
  const d = (await get(`/api/project/${p.id}`)).json;
  const g = d.activity.find((x) => x.type === 'gate.answered');
  assert.equal(g.data.gate, 'push');
  assert.equal(g.data.answer, 'yes');
  assert.ok(d.activity.some((x) => x.type === 'plan.created' && x.data.slug === 'big'));
  assert.ok(!JSON.stringify(d.activity).includes('SECRET-TEXT'));
});

test('activity does not disturb the stored cards: work, log, mrs, validation come back as before', async () => {
  const p = newProject('filled');
  store.workSet(p.id, { stream: 'main', title: 'item', state: 'parked', note: 'few users' });
  store.logAdd(p.id, 'orchestrator', 'user agreed');
  store.mrSet(p.id, 7, 'MR seven', { ci: 'passed' });
  const d = (await get(`/api/project/${p.id}`)).json;
  assert.equal(d.work[0].items[0].note, 'few users');
  assert.equal(d.log[0].text, 'user agreed');
  assert.equal(d.mrs[0].iid, 7);
  assert.deepEqual(d.validation, {});
});

test('project page source: the model decides, empty cards fold, validation is never filled from events', () => {
  const src = read('app.js');
  const en = JSON.parse(read('i18n/en.json'));
  const zh = JSON.parse(read('i18n/zh-TW.json'));
  assert.equal(en['project.recentMerges'], 'Recent merges');
  assert.equal(zh['project.recentMerges'], '最近合併');
  assert.match(read('index.html'), /<script src="\/activity-model\.js"><\/script>/);
  assert.match(src, /AM\.forms\(d\)/);
  assert.match(src, /t\('remove'\)/);
  assert.match(src, /function foldCard[\s\S]*?h\('details'/);
  assert.match(src, /foldCard\(t\('project\.work'\)[\s\S]*?workBody/);
  assert.match(src, /foldCard\(t\('project\.log'\)[\s\S]*?logBody/);
  assert.match(src, /foldCard\(t\('project\.validation'\)/);
  const val = src.slice(src.indexOf('var vrows = []'), src.indexOf('// handoffs'));
  assert.ok(!/activity/.test(val), 'validation does not read events');
  assert.match(read('app.css'), /\.card\.fold \{[^}]*align-self: start/);
  for (const k of ['act.task.created', 'act.task.returned', 'act.task.sent_back', 'act.task.accepted', 'act.merged', 'act.push', 'act.gate', 'act.plan']) {
    assert.ok(en[k] && zh[k], k);
  }
});

const AM = require('../board/public/activity-model.js');
const en = JSON.parse(read('i18n/en.json'));
const tr = (k, v) => String(en[k] || k).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] !== undefined ? v[n] : m));
const merged = { ts: '2026-03-01T00:00:00Z', type: 'task.merged', task: 't-1', title: 'Secret title', data: { branch: 'crew/x', note: 'abc123' } };
const pushed = { ts: '2026-03-02T00:00:00Z', type: 'git.push', task: null, title: null, data: { remote: 'origin', refs: ['main'] } };
const step = { ts: '2026-03-03T00:00:00Z', type: 'task.accepted', task: 't-1', title: 'Secret title', data: {} };

test('activity model: filled data keeps the stored cards', () => {
  const f = AM.forms({
    work: [{ name: 's', items: [{}, {}] }], log: [{ text: 'x' }], mrs: [{ iid: 1 }],
    validation: { a: [{ date: 'd', host: 'h', result: 'ok' }] }, activity: [merged, step],
  });
  assert.deepEqual(f, { work: 'card', log: 'log', mrs: 'mrs', validation: 'card', workItems: 2 });
});

test('activity model: empty data folds, or falls back to events; validation never reads events', () => {
  assert.deepEqual(AM.forms({ work: [], log: [], mrs: [], validation: {}, activity: [] }), { work: 'fold', log: 'fold', mrs: 'none', validation: 'fold', workItems: 0 });
  const f = AM.forms({ work: [], log: [], mrs: [], validation: {}, activity: [merged, pushed, step] });
  assert.equal(f.log, 'acts');
  assert.equal(f.mrs, 'merges');
  assert.equal(f.validation, 'fold');
  assert.equal(AM.forms({ work: [], log: [], mrs: [], validation: {}, activity: [merged] }).log, 'fold');
  assert.equal(AM.forms({ work: [], log: [], mrs: [], validation: {}, activity: [step] }).mrs, 'none');
});

test('activity model: row text, and private mode shows ids and types only', () => {
  assert.equal(AM.rowText(step, false, tr), 'Secret title \u00b7 ' + tr('act.task.accepted'));
  assert.equal(AM.rowText(step, true, tr), 't-1 \u00b7 ' + tr('act.task.accepted'));
  assert.equal(AM.detailText(merged, false, tr), ' \u00b7 ' + [tr('act.merged'), 'crew/x', 'abc123'].join(' \u00b7 '));
  assert.equal(AM.detailText(merged, true, tr), ' \u00b7 ' + tr('act.merged'));
  assert.equal(AM.detailText(pushed, false, tr), [tr('act.push'), 'origin', 'main'].join(' \u00b7 '));
  assert.equal(AM.detailText(pushed, true, tr), tr('act.push'));
  const plan = { type: 'plan.created', task: null, data: { slug: 'big' } };
  assert.match(AM.rowText(plan, false, tr), /big/);
  assert.ok(!/big/.test(AM.rowText(plan, true, tr)));
  assert.ok(!/Secret|crew\/x|abc123|origin/.test([merged, pushed, step].map((a) => AM.rowText(a, true, tr) + AM.detailText(a, true, tr)).join('')));
});

test('activity is cached while events.jsonl is unchanged, and rescanned when it grows; only UI fields come back', async () => {
  const p = newProject('cache');
  ev(p.id, 'task.merged', '2026-04-01T00:00:00.000Z', { key: 'c1', data: { branch: 'b1', note: 'n1', base: 'main', command: 'git merge', title: 'x' } });
  // a whole-second mtime survives the float round trip through utimesSync on Windows
  const fixed = 1775000000;
  fs.utimesSync(paths.eventsFile(p.id), fixed, fixed);
  const first = (await get(`/api/project/${p.id}`)).json.activity;
  assert.equal(first.length, 1);
  assert.deepEqual(Object.keys(first[0].data).sort(), ['branch', 'note']);
  const file = paths.eventsFile(p.id);
  const orig = fs.readFileSync(file);
  // same size, same mtime, different content: a cached answer is returned
  fs.writeFileSync(file, Buffer.from(orig.toString().replace('"b1"', '"b2"')));
  fs.utimesSync(file, fixed, fixed);
  assert.equal((await get(`/api/project/${p.id}`)).json.activity[0].data.branch, 'b1');
  // the file changes: rescanned
  ev(p.id, 'task.merged', '2026-04-02T00:00:00.000Z', { key: 'c2', data: { branch: 'b3' } });
  const again = (await get(`/api/project/${p.id}`)).json.activity;
  assert.equal(again.length, 2);
  assert.equal(again[0].data.branch, 'b3');
});

test('SKILL.md tells the orchestrator what only it can record, before Background work', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'skills', 'crew', 'SKILL.md'), 'utf8');
  const i = s.indexOf('## What only you can record');
  assert.ok(i > 0 && i < s.indexOf('## Background work'));
  const sec = s.slice(i, s.indexOf('## Background work'));
  assert.match(sec, /crew log add orchestrator/);
  assert.match(sec, /crew work set/);
  assert.match(sec, /automatically/);
});
