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
const events = require('../lib/core/events');

const claudeRoot = h.tmpDir('crew-ssa-claude-');
const codexRoot = h.tmpDir('crew-ssa-codex-');
let board;
let port;
let token;
let repo;
let proj;
let taskId;
const get = (p) => h.request(port, { path: p });
const post = (p, body) => h.post(port, token, p, body);
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const T0 = Date.now() - 3600 * 1000;   // one base time, so fixture timestamps never drift by a millisecond
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const U = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  taskId = tasks.createTask(proj.id, { title: 'Add the thing', brief: h.GOOD_BRIEF }).id;
  events.append(proj.id, { type: 'task.dispatched', src: 'hook', session: 'sessA', task: taskId, data: { agent_type: 'crewgate:crew-worker', tool_use_id: 'tu9' } });
  events.append(proj.id, { type: 'subagent.start', src: 'hook', session: 'sessA', agent: 'wk1', task: taskId, data: { agent_type: 'crewgate:crew-worker' }, key: 'wk1' });
  const base = (s) => ({ cwd: repo, sessionId: 'sessA', timestamp: iso(s) });
  const dir = path.join(claudeRoot, 'proj');
  fs.mkdirSync(path.join(dir, 'sessA', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessA.jsonl'), jl([
    { ...base(0), type: 'user', message: { role: 'user', content: 'PRIVATE PROMPT for the orchestrator' } },
    { ...base(10), type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-x', usage: U(1000, 100), content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'crewgate:crew-worker', prompt: 'PRIVATE BRIEF' } }] } },
    { ...base(20), type: 'user', toolUseResult: { agentId: 'wk1', status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } },
    { ...base(30), type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-opus-x', usage: U(500, 50), content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'git status' } }] } },
  ]));
  fs.writeFileSync(path.join(dir, 'sessA', 'subagents', 'agent-wk1.jsonl'), jl([
    { ...base(11), type: 'user', isSidechain: true, agentId: 'wk1', message: { role: 'user', content: 'PRIVATE WORKER PROMPT' } },
    { ...base(15), type: 'assistant', isSidechain: true, agentId: 'wk1', message: { id: 'w1', role: 'assistant', model: 'claude-sonnet-x', usage: U(2000, 300), content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: path.join(repo, 'src', 'secret-file.js'), old_string: 'a', new_string: 'b' } }] } },
  ]));
  fs.writeFileSync(path.join(codexRoot, 'rollout.jsonl'), jl([
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'cx1', cwd: repo } },
    { timestamp: iso(1), type: 'event_msg', payload: { type: 'user_message', message: 'codex prompt' } },
    { timestamp: iso(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } },
  ]));
  board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  port = await board.listen(0);
  token = await h.tokenOf(port);
  await post('/api/config', { config: { prices: { 'claude-opus-x': { input: 15, output: 75 }, 'claude-sonnet-x': { input: 3, output: 15 } } } });
});
test.after(() => board.close());

test('sessions list carries statistics per row and totals (with subagents) per parent; numbers only', async () => {
  const r = await get('/api/sessions');
  const main = r.json.sessions.find((s) => !s.subagent && s.engine === 'claude');
  const sub = r.json.sessions.find((s) => s.subagent);
  assert.equal(main.stats.prompts, 1);
  assert.deepEqual(main.stats.tools, { Agent: 1, Bash: 1 });
  assert.equal(main.stats.subagents, 1);
  assert.equal(main.stats.duration_ms, 30000);
  assert.deepEqual(main.stats.tokens, { input: 1500, output: 150, cache_write: 0, cache_read: 0 });
  assert.equal(main.stats.cost, (1000 * 15 + 100 * 75 + 500 * 15 + 50 * 75) / 1e6);
  assert.equal(sub.stats.tool_calls, 1);
  assert.ok(!('totals' in sub));
  assert.equal(main.totals.sessions, 2);
  assert.equal(main.totals.tool_calls, 3);
  assert.deepEqual(main.totals.tokens, { input: 3500, output: 450, cache_write: 0, cache_read: 0 });
  assert.equal(main.totals.cost, (1500 * 15 + 150 * 75 + 2000 * 3 + 300 * 15) / 1e6);
  const cx = r.json.sessions.find((s) => s.engine === 'codex');
  assert.equal(cx.stats.prompts, 1);
  assert.deepEqual(cx.stats.tools, { shell: 1 });
  assert.doesNotMatch(r.text, /PRIVATE|secret-file|git status/, 'statistics never carry text');
  assert.ok(!r.text.includes(repo));
});

test('project detail carries the statistics too, and the stats cache lives under the data home', async () => {
  const r = await get(`/api/project/${proj.id}`);
  assert.ok(r.json.sessions.every((s) => s.stats && typeof s.stats.prompts === 'number'));
  const cache = path.join(process.env.CREWGATE_HOME, 'cache', 'sessions');
  assert.ok(fs.readdirSync(cache).filter((n) => n.endsWith('.json')).length >= 3);
});

test('session detail: header, text-free timeline while show_text is off, link from the Agent call to the subagent page', async () => {
  const list = (await get('/api/sessions')).json.sessions;
  const main = list.find((s) => !s.subagent && s.engine === 'claude');
  const sub = list.find((s) => s.subagent);
  const r = await get(`/api/session/${main.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.show_text, false);
  assert.equal(r.json.session.id, main.id);
  assert.equal(r.json.session.project_name, 'demo');
  assert.equal(r.json.session.stats.prompts, 1);
  assert.ok(!('cwd' in r.json.session) && !('session' in r.json.session));
  const starts = r.json.events.filter((e) => e.kind === 'subagent' && e.phase === 'start');
  assert.equal(starts.length, 1, 'the crewgate start and the transcript Agent call are one step');
  assert.equal(starts[0].agent, sub.id);
  assert.ok(r.json.events.some((e) => e.kind === 'crew' && e.type === 'task.dispatched' && e.task === taskId));
  assert.doesNotMatch(r.text, /PRIVATE|secret-file|git status/);
  assert.ok(!r.text.includes(repo));
  assert.equal(r.json.events.find((e) => e.tool === 'Bash').target, undefined);
  // the subagent's own page
  const s = await get(`/api/session/${sub.id}`);
  assert.equal(s.status, 200);
  assert.equal(s.json.session.subagent, true);
  assert.deepEqual(s.json.events.map((e) => e.kind).filter((k) => k !== 'crew'), ['prompt', 'tool', 'subagent']);
  assert.doesNotMatch(s.text, /PRIVATE|secret-file/);
});

test('session detail with show_text: prompt snippets and redacted targets; switched off again afterwards', async () => {
  await post('/api/config', { config: { board: { show_text: true } } });
  try {
    const list = (await get('/api/sessions')).json.sessions;
    const main = list.find((s) => !s.subagent && s.engine === 'claude');
    const r = await get(`/api/session/${main.id}`);
    assert.equal(r.json.show_text, true);
    assert.match(r.json.events[0].text, /PRIVATE PROMPT/);
    assert.equal(r.json.events.find((e) => e.tool === 'Bash').target, 'git status');
    assert.doesNotMatch(r.text, /PRIVATE BRIEF/, 'tool arguments other than the target are never sent');
    assert.ok(!r.text.includes(repo));
  } finally { await post('/api/config', { config: { board: { show_text: false } } }); }
  const list = (await get('/api/sessions')).json.sessions;
  const again = await get(`/api/session/${list.find((s) => !s.subagent && s.engine === 'claude').id}`);
  assert.doesNotMatch(again.text, /PRIVATE|git status/);
});

test('session detail: paging parameters and kind filter; bad ids and unknown sessions are 404', async () => {
  const list = (await get('/api/sessions')).json.sessions;
  const main = list.find((s) => !s.subagent && s.engine === 'claude');
  const r = await get(`/api/session/${main.id}?kinds=tool&limit=1`);
  assert.equal(r.json.events.length, 1);
  assert.equal(r.json.events[0].tool, 'Bash', 'the newest tool call');
  assert.ok(r.json.cursor > 0);
  const older = await get(`/api/session/${main.id}?kinds=tool&limit=5&before=${r.json.cursor}&before_ts=${r.json.cursor_ts}`);
  assert.deepEqual(older.json.events.map((e) => e.kind), []);
  const bad = await get(`/api/session/${main.id}?before=-5&limit=abc&kinds=bogus`);
  assert.equal(bad.status, 200);
  assert.ok(bad.json.events.length >= 3, 'bad parameters fall back to defaults');
  for (const id of ['zzzzzzzzzzzz', '0123456789ab', '..%2F..%2Fetc', 'a'.repeat(40)]) {
    const x = await get(`/api/session/${id}`);
    assert.equal(x.status, 404, id);
  }
  const cx = list.find((s) => s.engine === 'codex');
  const c = await get(`/api/session/${cx.id}`);
  assert.deepEqual(c.json.events.map((e) => e.kind), ['prompt', 'tool']);
});
