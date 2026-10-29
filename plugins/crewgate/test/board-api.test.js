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

let board;
let port;
let token;
let proj;
let repo;
const claudeRoot = h.tmpDir('crew-claude-');
const codexRoot = h.tmpDir('crew-codex-');
const get = (p, headers) => h.request(port, { path: p, headers });
const post = (p, body) => h.post(port, token, p, body);

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  // tasks: one still running, one sent back once and accepted, with findings
  const a = tasks.createTask(proj.id, { title: 'Alpha', brief: h.GOOD_BRIEF });
  tasks.transition(proj.id, a.id, 'dispatched');
  const b = tasks.createTask(proj.id, { title: 'Beta', brief: h.GOOD_BRIEF });
  tasks.transition(proj.id, b.id, 'dispatched');
  tasks.transition(proj.id, b.id, 'returned');
  tasks.transition(proj.id, b.id, 'dispatched', { note: 'fix it' });
  tasks.transition(proj.id, b.id, 'returned');
  tasks.transition(proj.id, b.id, 'accepted');
  const fdir = path.join(paths.taskDir(proj.id, b.id), 'findings');
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, 'r1.raw.json'), JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
  fs.writeFileSync(path.join(fdir, 'r1.filtered.json'), JSON.stringify([{ id: 'c', reason: 'low confidence' }]));
  fs.writeFileSync(path.join(fdir, 'r1.json'), JSON.stringify([{ id: 'a', category: 'correctness', verdict: 'upheld' }, { id: 'b', category: 'nit', verdict: 'uncertain' }]));
  fs.writeFileSync(path.join(fdir, 'broken.json'), '{ not json');
  proj.tasks = { running: a.id, accepted: b.id };
  // handoffs
  for (const [state, id] of [['open', 'h1'], ['accepted', 'h2']]) {
    fs.mkdirSync(paths.handoffDir(proj.id, state), { recursive: true });
    fs.writeFileSync(paths.handoffFile(proj.id, state, id), JSON.stringify({ id, title: `Handoff ${id}`, body: 'SECRET-BODY', created: '2026-01-01T00:00:00.000Z' }));
  }
  // lessons: key "k1" on 3 distinct days is a candidate, "k2" is not
  fs.mkdirSync(path.join(repo, '.crew'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.crew', 'LESSONS.md'), [
    '# Lessons', '', '- 2026-01-01 [correction] k1: first', '- 2026-01-02 [correction] k1: second',
    '- 2026-01-02 [send-back] k1: same day again', '- 2026-01-04 [dismissal] k1: third day', '- 2026-01-04 [takeover] k2: once', 'not a lesson line', '',
  ].join('\n'));
  store.needAdd(proj.id, 'decide A');
  store.workSet(proj.id, { stream: 'main', title: 'item', state: 'doing' });
  store.logAdd(proj.id, 'tester', 'hello');
  store.mrSet(proj.id, 7, 'MR seven', { ci: 'passed' });
  board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  port = await board.listen(0);
  token = await h.tokenOf(port);
});
test.after(() => board.close());

test('meta and schema', async () => {
  const m = await get('/api/meta');
  assert.equal(m.json.name, 'crewgate');
  assert.equal(m.json.show_text, false);
  const s = await get('/api/schema');
  assert.ok(s.json.project.some((e) => e.path === 'limits.max_parallel_workers' && e.min === 1));
  assert.ok(s.json.global.some((e) => e.path === 'port'));
  assert.equal((await get('/api/nothing')).status, 404);
  assert.equal((await post('/api/overview', {})).status, 405);
});

test('overview counts tasks by state, open needs and last activity per project', async () => {
  const r = await get('/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.projects.length, 1);
  const p = r.json.projects[0];
  assert.equal(p.id, proj.id);
  assert.equal(p.name, 'demo');
  assert.deepEqual(p.tasks, { dispatched: 1, accepted: 1 });
  assert.equal(p.tasks_open, 2);
  assert.equal(p.needs, 1);
  assert.equal(p.live.subagents, 0);
  assert.ok(Date.parse(p.last_activity) > 0);
  assert.equal(p.config_errors, 0);
});

test('project detail: tasks with history and review stats, store, handoffs without bodies, lessons, events', async () => {
  const r = await get(`/api/project/${proj.id}`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.project.name, 'demo');
  assert.ok(!JSON.stringify(d).includes(repo), 'no repository path in the response');
  assert.ok(!JSON.stringify(d).includes('SECRET-BODY'), 'handoff bodies are never sent');
  const beta = d.tasks.find((x) => x.id === proj.tasks.accepted);
  assert.equal(beta.state, 'accepted');
  assert.equal(beta.returns, 1);
  assert.deepEqual(beta.history.map((x) => x.state), ['created', 'dispatched', 'returned', 'dispatched', 'returned', 'accepted']);
  assert.equal(beta.review.rounds, 1);
  assert.equal(beta.review.raw, 3);
  assert.equal(beta.review.filtered, 1);
  assert.equal(beta.review.final, 2);
  assert.equal(beta.review.uncertain, 1);
  assert.deepEqual(beta.review.by_category, { correctness: 1, nit: 1 });
  const alpha = d.tasks.find((x) => x.id === proj.tasks.running);
  assert.equal(alpha.review.rounds, 0);
  assert.equal(d.needs.open[0].text, 'decide A');
  assert.equal(d.work[0].items[0].title, 'item');
  assert.equal(d.log[0].text, 'hello');
  assert.equal(d.mrs[0].iid, 7);
  assert.deepEqual(d.handoffs.open.map((x) => x.id), ['h1']);
  assert.deepEqual(d.handoffs.accepted.map((x) => x.id), ['h2']);
  assert.deepEqual(d.handoffs.cancelled, []);
  assert.equal(d.lessons.total, 5);
  assert.equal(d.lessons.candidates, 1);
  assert.equal(d.lessons.keys[0].key, 'k1');
  assert.equal(d.lessons.keys[0].days, 3);
  assert.equal(d.lessons.keys[0].candidate, true);
  assert.equal(d.lessons.keys.find((k) => k.key === 'k2').candidate, false);
  assert.ok(d.events.length > 5);
  assert.equal(d.events[0].ts >= d.events[d.events.length - 1].ts, true, 'newest first');
  assert.ok(d.events.some((e) => e.type === 'task.accepted'));
});

test('unknown or malformed project ids are a clean 404', async () => {
  for (const id of ['p0000000000', 'nope', '..%2f..', '%zz']) assert.equal((await get(`/api/project/${id}`)).status, 404, id);
  assert.equal((await get('/api/project/p0000000000/config')).status, 404);
});

test('store writes: need add/done, work set/rm, log add; bad input is a 400 with a message', async () => {
  const id = proj.id;
  const n = await post(`/api/project/${id}/need`, { text: 'from the board' });
  assert.equal(n.status, 200);
  assert.equal(n.json.need.text, 'from the board');
  assert.equal((await post(`/api/project/${id}/need/done`, { id: n.json.need.id })).json.need.done, true);
  assert.equal((await post(`/api/project/${id}/need/done`, { id: 999 })).status, 400);
  assert.equal((await post(`/api/project/${id}/need`, { text: '  ' })).status, 400);
  assert.equal((await post(`/api/project/${id}/need`, {})).status, 400);
  const w = await post(`/api/project/${id}/work`, { stream: 's', title: 't', state: 'waiting', note: 'n' });
  assert.equal(w.json.item.state, 'waiting');
  assert.equal((await post(`/api/project/${id}/work`, { stream: 's', title: 't', state: 'bogus' })).status, 400);
  assert.equal((await post(`/api/project/${id}/work/rm`, { stream: 's', title: 't' })).status, 200);
  assert.equal((await post(`/api/project/${id}/work/rm`, { stream: 's', title: 't' })).status, 400);
  const l = await post(`/api/project/${id}/log`, { text: 'logged by board' });
  assert.equal(l.json.entry.who, 'board');
  const bad = await post(`/api/project/${id}/log`, { text: 'x'.repeat(5000) });
  assert.equal(bad.status, 400);
  const ev = events.read(id).filter((e) => e.src === 'board').map((e) => e.type);
  for (const t of ['need.added', 'need.done', 'work.set', 'work.removed', 'log.added']) assert.ok(ev.includes(t), t);
  // secrets in free text are redacted before they are stored
  const ip = ['10', '1', '2', '3'].join('.');
  const secret = await post(`/api/project/${id}/log`, { text: `token=abcdef123456789 on ${ip}` });
  assert.doesNotMatch(secret.json.entry.text, /abcdef123456789|10\.1\.2\.3/);
});

test('global settings round trip: invalid fields are rejected with paths, unknown keys survive', async () => {
  const file = paths.configFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, custom_key: { keep: [1, 2] }, prices: { sonnet: { input: 3, output: 15, note: 'mine' } } }));
  const view = await get('/api/config');
  assert.equal(view.json.config.port, 8781);
  assert.equal(view.json.config.prices.sonnet.input, 3);
  const bad = await post('/api/config', { config: { port: 80, usage_days: 'many', prices: { opus: { input: -1 } } } });
  assert.equal(bad.status, 400);
  const byPath = Object.fromEntries(bad.json.errors.map((e) => [e.path, e.message]));
  assert.ok(byPath.port && byPath.usage_days && byPath['prices.opus.input'], JSON.stringify(bad.json.errors));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, undefined, 'nothing written on error');
  const ok = await post('/api/config', { config: { port: 9100, usage_days: 7, prices: { opus: { input: 15, output: 75 } } } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.config.port, 9100);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.custom_key, { keep: [1, 2] });
  assert.equal(disk.prices.sonnet.note, 'mine');
  assert.equal(disk.prices.opus.output, 75);
  assert.equal(disk.usage_days, 7);
  // prototype-pollution style keys are refused
  const evil = await h.request(port, { method: 'POST', path: '/api/config', body: '{"config":{"__proto__":{"polluted":true}}}', headers: { 'Content-Type': 'application/json', 'X-Crew-Token': token } });
  assert.equal(evil.status, 400);
  assert.equal({}.polluted, undefined);
  assert.equal((await post('/api/config', { config: 'nope' })).status, 400);
});

test('project settings: validation with field paths, unknown keys preserved, config.changed recorded', async () => {
  const file = paths.projectConfigFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, extra: { a: 1 }, limits: { max_parallel_workers: 2, mystery: true } }));
  const view = await get(`/api/project/${proj.id}/config`);
  assert.equal(view.json.config.limits.max_parallel_workers, 2);
  assert.equal(view.json.config.gates.push, 'ask', 'defaults are filled in');
  const bad = await post(`/api/project/${proj.id}/config`, { config: { limits: { max_parallel_workers: 0, orchestrator_edit: 'sometimes' }, gates: { push: 'maybe' } } });
  assert.equal(bad.status, 400);
  const paths_ = bad.json.errors.map((e) => e.path).sort();
  assert.deepEqual(paths_, ['gates.push', 'limits.max_parallel_workers', 'limits.orchestrator_edit']);
  assert.match(bad.json.errors.find((e) => e.path === 'limits.max_parallel_workers').message, /1/);
  const zh = await h.post(port, token, `/api/project/${proj.id}/config`, { config: { gates: { push: 'maybe' } } }, { 'X-Crew-Lang': 'zh-TW' });
  assert.match(zh.json.errors[0].message, /[一-鿿]/, 'messages follow the UI language');
  const before = events.read(proj.id, { types: 'config.changed' }).length;
  const ok = await post(`/api/project/${proj.id}/config`, { config: { limits: { max_parallel_workers: 4 }, gates: { push: 'never' }, board: { port: 8800 } } });
  assert.equal(ok.status, 200, ok.text);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.limits.max_parallel_workers, 4);
  assert.equal(disk.limits.mystery, true);
  assert.deepEqual(disk.extra, { a: 1 });
  assert.equal(disk.gates.push, 'never');
  assert.equal(events.read(proj.id, { types: 'config.changed' }).length, before + 1);
  // a broken config file shows up in the overview and the detail instead of failing
  fs.writeFileSync(file, '{ broken');
  const d = await get(`/api/project/${proj.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.json.config_errors.length >= 1);
  assert.equal((await get('/api/overview')).json.projects[0].config_errors >= 1, true);
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
});

test('sessions endpoint hides paths and text by default and links sessions to projects', async () => {
  const dir = path.join(claudeRoot, 'proj-a');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', cwd: repo, sessionId: 's', timestamp: new Date().toISOString(), message: { role: 'user', content: 'PRIVATE PROMPT' } },
    { type: 'assistant', cwd: repo, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE REPLY' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = await get('/api/sessions');
  assert.equal(r.status, 200);
  assert.equal(r.json.show_text, false);
  assert.equal(r.json.sessions.length, 1);
  const s = r.json.sessions[0];
  assert.equal(s.project, proj.id);
  assert.equal(s.project_name, 'demo');
  assert.equal(s.status, 'waiting');
  assert.equal(s.model, 'claude-sonnet-x');
  assert.ok(!r.text.includes('PRIVATE'), 'no prompt or reply text');
  assert.ok(!r.text.includes(repo), 'no full path');
  const ov = await get('/api/overview');
  assert.equal(ov.json.projects[0].live.sessions, 1);
  // opt in through the global config
  await post('/api/config', { config: { board: { show_text: true } } });
  const t = await get('/api/sessions');
  assert.equal(t.json.show_text, true);
  assert.match(t.json.sessions[0].last_reply, /PRIVATE REPLY/);
  assert.match(t.json.sessions[0].last_prompt, /PRIVATE PROMPT/);
  await post('/api/config', { config: { board: { show_text: false } } });
});

test('usage endpoint reads days and prices from the global config', async () => {
  const r = await get('/api/usage?days=3');
  assert.equal(r.status, 200);
  assert.equal(r.json.days.length, 3);
  assert.ok(Array.isArray(r.json.models));
  assert.equal((await get('/api/usage?days=0')).json.days.length, 7, 'invalid days fall back to the configured window');
});

test('HOME stays inside the temp dir', () => {
  assert.ok(HOME.startsWith(fs.realpathSync.native(require("os").tmpdir())));
});

test('reviewStats: one finding in one round counts as rounds=1, final=1 (kept/refutations files are not rounds)', () => {
  const { reviewStats } = require('../board/api');
  const id = 't-20260101-aaaa';
  const dir = path.join(paths.taskDir(proj.id, id), 'findings');
  fs.mkdirSync(dir, { recursive: true });
  const finding = { id: 'f1', category: 'correctness', verdict: 'upheld' };
  fs.writeFileSync(path.join(dir, '1.raw.json'), JSON.stringify([finding]));
  fs.writeFileSync(path.join(dir, '1.kept.json'), JSON.stringify([finding]));
  fs.writeFileSync(path.join(dir, '1.refutations.json'), JSON.stringify([{ id: 'f1', verdict: 'upheld' }]));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify([finding]));
  const s = reviewStats(proj.id, id);
  assert.equal(s.rounds, 1);
  assert.equal(s.final, 1);
  assert.equal(s.raw, 1);
  fs.rmSync(paths.taskDir(proj.id, id), { recursive: true, force: true });
});

test('settings: a project-level engines block is reported as ignored, never as a field', async () => {
  const file = path.join(repo, '.claude', 'crew.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, JSON.stringify({ version: 1, engines: { evil: { command: 'x', args: [] } } }));
  try {
    const r = await get(`/api/project/${proj.id}/config`);
    assert.equal(r.status, 200);
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0].message, /ignored/);
    assert.equal(r.json.errors.length, 0);
    assert.ok(!(await get('/api/schema')).json.project.some((e) => e.path.startsWith('engines')));
  } finally {
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
});
