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

const claudeRoot = h.tmpDir('crew-sa-claude-');
const codexRoot = h.tmpDir('crew-sa-codex-');
let board;
let port;
let token;
let repo;
let proj;
let taskId;
const get = (p) => h.request(port, { path: p });
const post = (p, body) => h.post(port, token, p, body);
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const now = () => new Date().toISOString();

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  const tk = tasks.createTask(proj.id, { title: 'Add the thing', brief: h.GOOD_BRIEF });
  taskId = tk.id;
  events.append(proj.id, { type: 'task.dispatched', src: 'hook', session: 'sessA', task: taskId, data: { agent_type: 'crewgate:crew-worker', tool_use_id: 'tu9' } });
  events.append(proj.id, { type: 'subagent.start', src: 'hook', session: 'sessA', agent: 'wk1', task: taskId, data: { agent_type: 'crewgate:crew-worker' }, key: 'wk1' });
  const base = { cwd: repo, timestamp: now(), sessionId: 'sessA' };
  const dir = path.join(claudeRoot, 'proj');
  fs.mkdirSync(path.join(dir, 'sessA', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessA.jsonl'), jl([
    { ...base, type: 'user', message: { role: 'user', content: 'PRIVATE PROMPT for the orchestrator' } },
    { ...base, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'crewgate:crew-worker', prompt: 'PRIVATE BRIEF' } }] } },
  ]));
  fs.writeFileSync(path.join(dir, 'sessA', 'subagents', 'agent-wk1.jsonl'), jl([
    { ...base, type: 'user', isSidechain: true, agentId: 'wk1', message: { role: 'user', content: 'PRIVATE WORKER PROMPT' } },
    { ...base, type: 'assistant', isSidechain: true, agentId: 'wk1', message: { role: 'assistant', model: 'claude-sonnet-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: path.join(repo, 'src', 'secret-file.js'), old_string: 'a', new_string: 'b' } }] } },
  ]));
  board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  port = await board.listen(0);
  token = await h.tokenOf(port);
});
test.after(() => board.close());

test('sessions API: role, task with title, parent link and branch; nothing sensitive while text is off', async () => {
  const r = await get('/api/sessions');
  assert.equal(r.status, 200);
  assert.equal(r.json.show_text, false);
  const rows = r.json.sessions;
  assert.equal(rows.length, 2);
  const main = rows.find((s) => !s.subagent);
  const sub = rows.find((s) => s.subagent);
  assert.equal(main.role, 'orchestrator');
  assert.equal(main.project, proj.id);
  assert.equal(sub.role, 'worker');
  assert.deepEqual(sub.task, { id: taskId, title: 'Add the thing' });
  assert.equal(sub.parent, main.id);
  assert.equal(sub.activity.kind, 'tool');
  assert.equal(sub.activity.tool, 'Edit');
  assert.equal(typeof main.branch, 'string', 'the repo has a branch');
  assert.ok(!Object.hasOwn(main, 'cwd') && !Object.hasOwn(main, 'session'));
  assert.doesNotMatch(r.text, /PRIVATE|secret-file/);
  assert.ok(!r.text.includes(repo));
  for (const s of rows) for (const k of ['last_prompt', 'last_reply', 'title']) assert.ok(!(k in s), k);
  assert.ok(!('target' in sub.activity));
});

test('sessions API: with board.show_text the snippets and the tool target appear, redacted and short', async () => {
  await post('/api/config', { config: { board: { show_text: true } } });
  try {
    const r = await get('/api/sessions');
    assert.equal(r.json.show_text, true);
    const sub = r.json.sessions.find((s) => s.subagent);
    const main = r.json.sessions.find((s) => !s.subagent);
    assert.equal(sub.activity.target, 'src/secret-file.js');
    assert.match(sub.last_prompt, /PRIVATE WORKER PROMPT/);
    assert.match(main.last_prompt, /PRIVATE PROMPT/);
    assert.ok(!r.text.includes(repo), 'still no absolute paths');
    assert.doesNotMatch(r.text, /PRIVATE BRIEF/, 'tool arguments other than the target are never sent');
  } finally {
    await post('/api/config', { config: { board: { show_text: false } } });
  }
  const again = await get('/api/sessions');
  assert.doesNotMatch(again.text, /PRIVATE|secret-file/);
});

test('project detail carries the same session fields', async () => {
  const r = await get(`/api/project/${proj.id}`);
  assert.equal(r.status, 200);
  const sub = r.json.sessions.find((s) => s.subagent);
  assert.equal(sub.role, 'worker');
  assert.equal(sub.task.id, taskId);
});
