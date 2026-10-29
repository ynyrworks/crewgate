'use strict';

// Board side of the usage-analysis gaps: gate history, hooks last seen, subagent text only with show_text,
// the event row notes (via, branches).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const hookseen = require('../lib/core/hookseen');

let board;
let port;
let token;
let pid;
const get = (p) => h.request(port, { path: p });
const post = (p, body) => h.post(port, token, p, body);

test.before(async () => {
  pid = projects.add(h.makeRepo(), { name: 'demo' }).project.id;
  board = createBoard({ claudeRoot: h.tmpDir('crew-claude-'), codexRoot: h.tmpDir('crew-codex-'), watcher: { ttlMs: 0 } });
  port = await board.listen(0);
  token = await h.tokenOf(port);
});
test.after(() => board.close());

test('project detail lists gate history: asked, answered, auto, missing', async () => {
  const a = gates.ask(pid, {}, { gate: 'push', detail: 'push feat/x' });
  gates.answer(pid, a.id, 'yes', 'ok');
  gates.ask(pid, {}, { gate: 'merge' }); // still open
  gates.ask(pid, { gates: { open_pr: 'auto' } }, { gate: 'open_pr' });
  events.append(pid, { type: 'gate.missing', src: 'hook', data: { gate: 'push', mode: 'ask', command: 'git push' }, key: 'miss-1' });
  const d = (await get(`/api/project/${pid}`)).json;
  assert.equal(d.gates.length, 4);
  const by = (g, pred) => d.gates.find((r) => r.gate === g && pred(r));
  assert.equal(by('push', (r) => !r.missing).answer, 'yes');
  assert.equal(by('push', (r) => !r.missing).note, 'ok');
  assert.equal(by('merge', () => true).answer, null);
  assert.equal(by('open_pr', () => true).auto, true);
  assert.equal(by('push', (r) => r.missing).detail, 'git push');
});

test('project detail reports which hooks fired and which lifecycle hooks never did', async () => {
  let d = (await get(`/api/project/${pid}`)).json;
  assert.deepEqual(d.hook_seen.missing, ['SessionStart', 'Stop', 'SessionEnd']);
  assert.equal(d.hook_seen.rows.length, 9);
  hookseen.note(pid, 'session-start');
  hookseen.note(pid, 'stop');
  d = (await get(`/api/project/${pid}`)).json;
  assert.deepEqual(d.hook_seen.missing, ['SessionEnd']);
  assert.ok(d.hook_seen.rows.find((r) => r.event === 'Stop').last);
});

test('a subagent last message reaches the page only while show_text is on; via and branches always do', async () => {
  events.append(pid, { type: 'subagent.stop', src: 'hook', agent: 'a1', data: { agent_type: 'crew-worker', agent_type_raw: 'crewgate:crew-worker', last: 'all green', last_src: 'payload' }, key: 'ss1' });
  events.append(pid, { type: 'git.merge', src: 'cli', data: { command: 'crew task merge', branches: ['feat/x'], via: 'cli-merge' }, key: 'gm1' });
  const find = (d, type) => d.events.find((e) => e.type === type);
  let d = (await get(`/api/project/${pid}`)).json;
  assert.equal(d.show_text, false);
  assert.ok(!('last' in find(d, 'subagent.stop').data));
  assert.equal(find(d, 'subagent.stop').data.agent_type, 'crew-worker');
  assert.equal(find(d, 'git.merge').data.via, 'cli-merge');
  assert.deepEqual(find(d, 'git.merge').data.branches, ['feat/x']);

  await post('/api/config', { config: { board: { show_text: true } } });
  try {
    d = (await get(`/api/project/${pid}`)).json;
    assert.equal(find(d, 'subagent.stop').data.last, 'all green');
  } finally {
    await post('/api/config', { config: { board: { show_text: false } } });
  }
});

test('the page code renders the gate card, the hooks table and the event notes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'board', 'public', 'app.js'), 'utf8');
  for (const needle of ["t('project.gates')", "t('project.hooks')", 'eventNote(e, d.show_text)', "t('events.via')", 'hs.missing']) assert.ok(src.includes(needle), needle);
});
