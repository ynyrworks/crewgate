'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SM = require('../board/public/sessions-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const table = (l) => JSON.parse(read(`i18n/${l}.json`));

let n = 0;
const row = (o = {}) => ({ id: `r${++n}`, engine: 'claude', status: 'idle', lastActivity: new Date(1700000000000 + n * 1000).toISOString(), subagent: false, parent: null, project: 'p1', activity: { kind: 'idle' }, ...o });

test('filters: project, state (running / waiting for you / all) and engine', () => {
  const rows = [
    row({ id: 'a', status: 'working', project: 'p1' }),
    row({ id: 'b', status: 'tool', project: 'p2', engine: 'codex' }),
    row({ id: 'c', status: 'waiting', project: 'p1' }),
    row({ id: 'd', status: 'done', project: null }),
  ];
  const ids = (f) => SM.buildTree(rows, f).map((x) => x.row.id).sort();
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ state: 'running' }), ['a', 'b']);
  assert.deepEqual(ids({ state: 'waiting' }), ['c']);
  assert.deepEqual(ids({ engine: 'codex' }), ['b']);
  assert.deepEqual(ids({ project: 'p1' }), ['a', 'c']);
  assert.deepEqual(ids({ project: '-' }), ['d']);
  assert.deepEqual(ids({ project: 'p1', state: 'waiting', engine: 'claude' }), ['c']);
});

test('stored filters from localStorage are sanitised', () => {
  assert.deepEqual(SM.cleanFilter(null), { project: '', state: 'all', engine: 'all' });
  assert.deepEqual(SM.cleanFilter({ state: 'bogus', engine: 7, project: { x: 1 } }), { project: '', state: 'all', engine: 'all' });
  assert.deepEqual(SM.cleanFilter({ state: 'waiting', engine: 'codex', project: 'p9' }), { project: 'p9', state: 'waiting', engine: 'codex' });
  assert.equal(SM.cleanFilter({ project: 'x'.repeat(500) }).project.length, 40);
});

test('waiting-for-you sessions sort first, then newest first', () => {
  const rows = [
    row({ id: 'old', status: 'idle', lastActivity: '2026-01-01T00:00:00Z' }),
    row({ id: 'new', status: 'working', lastActivity: '2026-01-03T00:00:00Z' }),
    row({ id: 'wait', status: 'waiting', lastActivity: '2026-01-02T00:00:00Z' }),
  ];
  assert.deepEqual(SM.buildTree(rows).map((x) => x.row.id), ['wait', 'new', 'old']);
});

test('tree: subagents nest under their parent, with running counts; orphans stay top-level', () => {
  const rows = [
    row({ id: 'P', status: 'working' }),
    row({ id: 'c1', parent: 'P', subagent: true, status: 'tool' }),
    row({ id: 'c2', parent: 'P', subagent: true, status: 'done' }),
    row({ id: 'c3', parent: 'P', subagent: true, status: 'waiting' }),
    row({ id: 'orphan', parent: 'gone', subagent: true, status: 'working' }),
    row({ id: 'self', parent: 'self', status: 'idle' }),
  ];
  const tree = SM.buildTree(rows);
  assert.deepEqual(tree.map((x) => x.row.id).sort(), ['P', 'orphan', 'self']);
  const p = tree.find((x) => x.row.id === 'P');
  assert.equal(p.children.length, 3);
  assert.equal(p.running, 1, 'one running child (tool); waiting and done do not count');
  assert.equal(p.children[0].row.id, 'c3', 'a waiting child is listed first');
});

test('tree: a matching child keeps its ancestors; a non-matching child is dropped', () => {
  const rows = [
    row({ id: 'P', status: 'idle' }),
    row({ id: 'c1', parent: 'P', subagent: true, status: 'working' }),
    row({ id: 'c2', parent: 'P', subagent: true, status: 'done' }),
  ];
  const tree = SM.buildTree(rows, { state: 'running' });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].row.id, 'P');
  assert.deepEqual(tree[0].children.map((x) => x.row.id), ['c1']);
  assert.equal(tree[0].running, 1, 'the count covers all children, not only the visible ones');
});

test('collapse: explicit choice wins, otherwise open while a child runs', () => {
  const mk = (statuses) => {
    const rows = [row({ id: 'P' }), ...statuses.map((s, i) => row({ id: `k${i}`, parent: 'P', subagent: true, status: s }))];
    return SM.buildTree(rows)[0];
  };
  assert.equal(SM.isOpen(mk(['done', 'done']), {}), false);
  assert.equal(SM.isOpen(mk(['done', 'working']), {}), true);
  assert.equal(SM.isOpen(mk(['waiting']), {}), false, 'a subagent that ended its turn is finished');
  assert.equal(SM.isOpen(mk(['working']), { P: false }), false);
  assert.equal(SM.isOpen(mk(['done']), { P: true }), true);
});

test('private mode hides every snippet and name field, and never adds anything', () => {
  const r = row({
    last_prompt: 'p', last_reply: 'r', title: 't', branch: 'feat/x', worktree: 'wt', folder: 'repo',
    activity: { kind: 'tool', tool: 'Read', target: 'src/a.js' }, task: { id: 'T-1', title: 'Secret title' },
  });
  const open = SM.visible(r, false);
  assert.deepEqual(open, { prompt: 'p', reply: 'r', title: 't', target: 'src/a.js', taskTitle: 'Secret title', branch: 'feat/x', worktree: 'wt', folder: 'repo' });
  const priv = SM.visible(r, true);
  for (const [k, v] of Object.entries(priv)) assert.equal(v, null, k);
  // the server withheld the text: nothing appears even with the toggle off
  const bare = SM.visible(row({ activity: { kind: 'tool', tool: 'Read' } }), false);
  assert.equal(bare.prompt, null);
  assert.equal(bare.reply, null);
  assert.equal(bare.target, null);
  assert.equal(bare.taskTitle, null);
});

test('a subagent that ended its turn is shown as done, not as waiting for the user', () => {
  const sub = row({ status: 'waiting', subagent: true, parent: 'x' });
  assert.equal(SM.displayStatus(sub), 'done');
  assert.equal(SM.isWaiting(sub), false);
  assert.equal(SM.displayStatus(row({ status: 'waiting' })), 'waiting');
  assert.deepEqual(SM.buildTree([sub], { state: 'waiting' }), []);
});

test('counts', () => {
  assert.deepEqual(SM.counts([row({ status: 'working' }), row({ status: 'tool' }), row({ status: 'waiting' }), row({ status: 'done' })]), { all: 4, running: 2, waiting: 1 });
});

test('page source: private mode switch and filters persist through guarded storage; strings exist in both languages', () => {
  const src = read('app.js');
  assert.match(src, /role: 'switch'/);
  assert.match(src, /store\('crew\.mask'/);
  assert.match(src, /store\('crew\.sessionFilter'/);
  assert.match(src, /function store\(key, val\) \{\s*try \{/, 'every storage access goes through the try/catch wrapper');
  const outside = src.split('function store(')[1].split('\n  }\n').slice(1).join('');
  assert.doesNotMatch(outside, /localStorage/, 'localStorage only inside store()');
  assert.match(read('index.html'), /<script src="\/sessions-model\.js"><\/script>\s*<script src="\/update-model\.js"><\/script>\s*<script src="\/app\.js">/);
  assert.doesNotMatch(read('sessions-model.js'), /innerHTML|eval\(|https?:\/\//);
  const en = table('en');
  const zh = table('zh-TW');
  const keys = [];
  for (const k of ['thinking', 'tool', 'toolPlain', 'writing', 'waiting', 'idle', 'done']) keys.push(`act.${k}`);
  for (const k of ['orchestrator', 'worker', 'reviewer', 'refuter', 'other']) keys.push(`role.${k}`);
  for (const k of ['working', 'tool', 'waiting', 'idle', 'done']) keys.push(`state.${k}`);
  keys.push('maskHint', 'mask');
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(zh[k], `zh-TW ${k}`); }
  assert.match(en.mask, /Private mode/);
});

test('styles: waiting rows are highlighted, chips differ by more than colour, narrow screens are handled', () => {
  const css = read('app.css');
  assert.match(css, /\.sess\.is-waiting/);
  assert.match(css, /\.chip\.s-waiting/);
  assert.match(css, /\.s-tool\.chip \{ border-style: dashed/);
  assert.match(css, /max-width: 480px/);
  assert.match(css, /prefers-color-scheme: dark[\s\S]*--warn-bg/);
});

test('timeline search: case-insensitive words over names and kinds; text only when not private', () => {
  const tool = { kind: 'tool', tool: 'Bash', target: 'npm test --silent', ts: 1 };
  const prompt = { kind: 'prompt', text: 'Fix the Login bug', ts: 2 };
  const crew = { kind: 'crew', type: 'task.dispatched', task: 'T-12', ts: 3 };
  const sub = { kind: 'subagent', phase: 'stop', agent_type: 'crewgate:crew-worker', ts: 4 };
  assert.equal(SM.stepMatches(tool, '', false), true, 'empty search matches everything');
  assert.equal(SM.stepMatches(tool, '  ', false), true);
  assert.equal(SM.stepMatches(tool, 'BASH', false), true);
  assert.equal(SM.stepMatches(tool, 'npm silent', false), true, 'words are ANDed');
  assert.equal(SM.stepMatches(tool, 'npm yarn', false), false);
  assert.equal(SM.stepMatches(prompt, 'login', false), true);
  assert.equal(SM.stepMatches(crew, 'DISPATCHED', false), true);
  assert.equal(SM.stepMatches(crew, 't-12', false), true);
  assert.equal(SM.stepMatches(sub, 'crew-worker', false), true);
  assert.equal(SM.stepMatches(sub, 'finished', false), true);
  // private mode: names and kinds only
  assert.equal(SM.stepMatches(tool, 'npm', true), false);
  assert.equal(SM.stepMatches(tool, 'bash', true), true);
  assert.equal(SM.stepMatches(prompt, 'login', true), false);
  assert.equal(SM.stepMatches(prompt, 'prompt', true), true);
  assert.equal(SM.stepMatches(sub, 'crew-worker', true), false);
  assert.equal(SM.stepMatches(crew, 'dispatched', true), true);
});

test('timeline search: page wiring has no inline handlers and strings exist in both languages', () => {
  const src = read('app.js');
  assert.match(src, /type: 'search'/);
  assert.match(src, /SM\.stepMatches\(r\.ev, DET\.q, S\.mask\)/, 'the private-mode flag is passed to the matcher');
  assert.doesNotMatch(read('index.html'), /\son(?:input|click)=/);
  const en = table('en');
  const zh = table('zh-TW');
  for (const k of ['sessions.search', 'sessions.searchCount', 'sessions.searchLoaded', 'sessions.noMatch']) { assert.ok(en[k], `en ${k}`); assert.ok(zh[k], `zh-TW ${k}`); }
  assert.match(en['sessions.searchCount'], /\{shown\}.*\{total\}/);
  assert.match(zh['sessions.searchCount'], /\{shown\}/);
});
