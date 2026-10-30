'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const tasks = require('../lib/core/tasks');
const PM = require('../board/public/plan-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let board;
let port;
let repo;
let proj;
let merged;
let running;
const get = (p) => h.request(port, { path: p });

const PLAN = (a, b) => [
  '# Demo plan',
  'The goal in words.',
  '',
  '- [ ] Plan tree <!-- id:n1 added:2026-10-30 origin:plan -->',
  `  - [ ] Format <!-- id:n2 task:${a} added:2026-10-30 -->`,
  `  - [ ] Board <!-- id:n3 task:${b} added:2026-10-31 origin:user -->`,
  '  - [ ] Unlinked <!-- id:n6 task:t-20200101-gone -->',
  '- [~] Dropped idea <!-- id:n4 origin:review added:2026-10-31 -->',
  '- [?] Proposed <!-- id:n5 origin:refute added:2026-10-31 -->',
  '',
].join('\n');

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  const a = tasks.createTask(proj.id, { title: 'Alpha', brief: h.GOOD_BRIEF });
  tasks.transition(proj.id, a.id, 'dispatched');
  tasks.transition(proj.id, a.id, 'returned');
  tasks.transition(proj.id, a.id, 'accepted');
  tasks.transition(proj.id, a.id, 'merged');
  merged = a.id;
  const b = tasks.createTask(proj.id, { title: 'Beta', brief: h.GOOD_BRIEF });
  tasks.transition(proj.id, b.id, 'dispatched');
  running = b.id;
  fs.mkdirSync(path.join(repo, '.crew', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), PLAN(merged, running));
  board = createBoard({ claudeRoot: h.tmpDir('crew-claude-'), codexRoot: h.tmpDir('crew-codex-'), watcher: { ttlMs: 0 } });
  port = await board.listen(0);
});
test.after(() => board.close());

test('GET /plans lists each plan with title, counts and percentage', async () => {
  const r = await get(`/api/project/${proj.id}/plans`);
  assert.equal(r.status, 200);
  assert.equal(r.json.plans.length, 1);
  const p = r.json.plans[0];
  assert.equal(p.slug, 'demo');
  assert.equal(p.title, 'Demo plan');
  assert.equal(p.done, 1);
  assert.equal(p.total, 3);      // Format (merged), Board (dispatched), Unlinked (unknown task); dropped/proposed excluded
  assert.equal(p.pct, 33);
  assert.equal(p.proposed, 1);
  assert.equal(p.dropped, 1);
  assert.equal(p.truncated, false);
  assert.ok(Date.parse(p.updated) > 0);
  assert.ok(!JSON.stringify(r.json).includes(repo), 'no repository path');
});

test('project detail carries the same plan rows', async () => {
  const d = (await get(`/api/project/${proj.id}`)).json;
  assert.equal(d.plans.length, 1);
  assert.equal(d.plans[0].slug, 'demo');
});

test('GET /plan/<slug>: tree with derived state, task state, origin and added date', async () => {
  const r = await get(`/api/project/${proj.id}/plan/demo`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.slug, 'demo');
  assert.equal(d.title, 'Demo plan');
  assert.equal(d.goal, 'The goal in words.');
  assert.deepEqual(d.nodes.map((n) => n.id), ['n1', 'n4', 'n5']);
  const n1 = d.nodes[0];
  assert.equal(n1.state, 'doing');
  assert.equal(n1.pct, 33);
  assert.deepEqual(n1.children.map((c) => [c.id, c.state]), [['n2', 'done'], ['n3', 'doing'], ['n6', 'todo']]);
  assert.deepEqual(n1.children[0].task, { id: merged, state: 'merged', missing: false });
  assert.deepEqual(n1.children[1].task, { id: running, state: 'dispatched', missing: false });
  assert.equal(n1.children[2].task.missing, true);
  assert.equal(n1.children[1].origin, 'user');
  assert.equal(n1.children[1].added, '2026-10-31');
  assert.equal(n1.children[0].origin, 'plan');
  assert.equal(d.nodes[1].state, 'dropped');
  assert.equal(d.nodes[1].origin, 'review');
  assert.equal(d.nodes[2].state, 'proposed');
  assert.equal(d.summary.total, 3);
});

test('the board follows the file and the tasks on every request', async () => {
  fs.appendFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), '- [x] Late addition <!-- id:n7 added:2026-11-01 origin:implementation -->\n');
  let d = (await get(`/api/project/${proj.id}/plan/demo`)).json;
  assert.equal(d.nodes.length, 4);
  assert.equal(d.summary.total, 4);
  tasks.transition(proj.id, running, 'returned');
  d = (await get(`/api/project/${proj.id}/plan/demo`)).json;
  assert.equal(d.nodes[0].children[1].state, 'review');
  tasks.transition(proj.id, running, 'accepted');
  tasks.transition(proj.id, running, 'merged');
  d = (await get(`/api/project/${proj.id}/plan/demo`)).json;
  assert.equal(d.nodes[0].children[1].state, 'done');
});

test('plan API: bad slug, unknown plan, unknown project, wrong method', async () => {
  assert.equal((await get(`/api/project/${proj.id}/plan/nope`)).status, 404);
  assert.equal((await get(`/api/project/${proj.id}/plan/..%2Fx`)).status, 404);
  assert.equal((await get(`/api/project/${proj.id}/plan/UPPER`)).status, 404);
  assert.equal((await get('/api/project/pffffffffff/plan/demo')).status, 404);
  assert.equal((await get('/api/project/pffffffffff/plans')).status, 404);
  const post = await h.post(port, await h.tokenOf(port), `/api/project/${proj.id}/plan/demo`, {});
  assert.equal(post.status, 405);
});

test('a plan larger than 500 nodes or 256 KiB is cut and marked truncated', async () => {
  const lines = ['# Big'];
  for (let i = 0; i < 600; i++) lines.push(`- [ ] step ${i}`);
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'big.md'), `${lines.join('\n')}\n`);
  let d = (await get(`/api/project/${proj.id}/plan/big`)).json;
  assert.equal(d.nodes.length, 500);
  assert.equal(d.truncated, true);
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'huge.md'), `# Huge\n${'x'.repeat(300 * 1024)}\n- [ ] after the cut\n`);
  d = (await get(`/api/project/${proj.id}/plan/huge`)).json;
  assert.equal(d.truncated, true);
  assert.equal(d.nodes.length, 0);
  fs.rmSync(path.join(repo, '.crew', 'plans', 'huge.md'));
  fs.rmSync(path.join(repo, '.crew', 'plans', 'big.md'));
});

test('an unreadable or malformed plan file never breaks the API', async () => {
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'junk.md'), '\u0000\u0001 garbage\n- [ ]\n- [q] x\n');
  const r = await get(`/api/project/${proj.id}/plan/junk`);
  assert.equal(r.status, 200);
  assert.equal(r.json.nodes.length, 0);
  fs.rmSync(path.join(repo, '.crew', 'plans', 'junk.md'));
});

// ---------------------------------------------------------------- front end
test('plan model: private mode shows ids and states only', () => {
  const n = { id: 'n3', text: 'Secret step' };
  assert.equal(PM.nodeText(n, false), 'Secret step');
  assert.equal(PM.nodeText(n, true), 'n3');
  const p = { slug: 'demo', title: 'Secret title' };
  assert.equal(PM.planTitle(p, false), 'Secret title');
  assert.equal(PM.planTitle(p, true), 'demo');
  assert.equal(PM.planTitle({ slug: 'demo', title: '' }, false), 'demo');
});

test('plan model: growth groups additions by day and origin and flags the recent ones', () => {
  const nodes = [
    { id: 'a', added: '2026-10-30', origin: 'plan', children: [{ id: 'b', added: '2026-10-30', origin: 'user', children: [] }] },
    { id: 'c', added: '2026-10-31', origin: 'review', children: [] },
    { id: 'd', added: null, origin: 'plan', children: [] },
    { id: 'e', added: '2026-10-01', origin: 'plan', children: [] },
  ];
  const now = new Date(2026, 9, 31, 15, 0, 0).getTime();
  const g = PM.growth(nodes, now, 7);
  assert.deepEqual(g.groups.map((x) => x.date), ['2026-10-31', '2026-10-30', '2026-10-01']);
  assert.deepEqual(g.groups[1].origins.map((o) => [o.origin, o.items.map((n) => n.id)]), [['plan', ['a']], ['user', ['b']]]);
  assert.deepEqual(Object.keys(g.recent).sort(), ['a', 'b', 'c']);
  assert.equal(g.recentCount, 3);
  assert.equal(g.groups[2].recent, false);
  assert.equal(PM.isRecent('2026-11-05', now, 7), false, 'a future date is not recent');
  assert.equal(PM.isRecent('garbage', now, 7), false);
  assert.deepEqual(PM.flatten(nodes).map((n) => n.id), ['a', 'b', 'c', 'd', 'e']);
});

test('plan model: browser-stored collapse state is validated', () => {
  assert.deepEqual(PM.cleanCollapsed({ 'p1/demo/n1': true, 'p1/demo/n2': 'yes', '<script>': true, 'p1/Bad Slug/n1': true }), { 'p1/demo/n1': true });
  assert.deepEqual(PM.cleanCollapsed(null), {});
  assert.deepEqual(PM.cleanCollapsed([1]), {});
  assert.equal(PM.collapseKey('p1', 'demo', 'n1'), 'p1/demo/n1');
  assert.equal(PM.validTask('t-20260101-abcd'), true);
  assert.equal(PM.validTask('<x>'), false);
});

test('plan page: strings exist in both tables, the model is loaded before app.js and holds no unsafe code', () => {
  const en = JSON.parse(read('i18n/en.json'));
  const zh = JSON.parse(read('i18n/zh-TW.json'));
  const keys = new Set(['project.plans']);
  for (const m of read('app.js').matchAll(/\bt\('(plan\.[A-Za-z.]+)'/g)) keys.add(m[1]);
  for (const s of Object.keys(PM.MARKS)) keys.add(`plan.state.${s}`);
  for (const o of ['plan', 'user', 'review', 'refute', 'implementation', 'send-back']) keys.add(`plan.origin.${o}`);
  for (const m of read('app.js').matchAll(/empty\('(plan\.[A-Za-z]+)'\)/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k.endsWith('.') || (k in en && k in zh), k);
  const html = read('index.html');
  assert.ok(html.indexOf('/plan-model.js') > 0 && html.indexOf('/plan-model.js') < html.indexOf('/app.js'));
  assert.doesNotMatch(read('plan-model.js'), /innerHTML|eval\(|https?:\/\//);
  // every state the server can derive has a mark
  for (const s of ['todo', 'doing', 'review', 'done', 'blocked', 'dropped', 'proposed']) assert.ok(PM.MARKS[s], s);
});

test('plan page: route, card and tree are wired in app.js and the page is served', async () => {
  const src = read('app.js');
  assert.match(src, /p\[2\] === 'plan'/);
  assert.match(src, /plansCard\(d\)/);
  assert.match(src, /aria-expanded/);
  assert.match(src, /'aria-pressed': S\.pgrowth/);
  assert.match(src, /<progress|h\('progress'/);
  const js = await h.request(port, { path: '/plan-model.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('plan CLI string tables are in sync', () => {
  const dir = path.join(__dirname, '..', 'lib', 'i18n');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'plan.en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'plan.zh-TW.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const k of Object.keys(en)) {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(vars(zh[k]), vars(en[k]), k);
  }
});
