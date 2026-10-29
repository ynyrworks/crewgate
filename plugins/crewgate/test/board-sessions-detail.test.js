'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createWatcher, targetOf, roleOf } = require('../board/watcher');
const { createSessionEnds } = require('../board/session-ends');
const { createGitInfo, parseHead } = require('../board/gitinfo');

h.setupHome();
const iso = (ms) => new Date(ms).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const CWD = path.join(h.tmpDir('crew-d-cwd-'), 'repo');

const user = (content = 'hi', extra = {}) => ({ type: 'user', cwd: CWD, sessionId: 'sess1', timestamp: iso(Date.now()), message: { role: 'user', content }, ...extra });
const asst = (content, stop = null, extra = {}) => ({ type: 'assistant', cwd: CWD, sessionId: 'sess1', timestamp: iso(Date.now()), message: { role: 'assistant', model: 'claude-x', stop_reason: stop, content }, ...extra });
const tool = (name, input) => ({ type: 'tool_use', id: 'tu1', name, input });
const result = () => user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]);

function setup(files) {
  const claudeRoot = h.tmpDir('crew-d-claude-');
  for (const [rel, objs, extra] of files) {
    const f = path.join(claudeRoot, 'proj', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, jl(objs) + (extra || ''));
  }
  return claudeRoot;
}
function rowsOf(claudeRoot, call = {}, opts = {}) {
  return createWatcher({ claudeRoot, codexRoot: null, ttlMs: 0, ...opts }).sessions(call);
}
function one(objs, call = {}) {
  const rows = rowsOf(setup([['s.jsonl', objs]]), call);
  assert.equal(rows.length, 1);
  return rows[0];
}

test('activity: thinking, writing, tool, waiting for every last-record shape', () => {
  assert.equal(one([user(), asst([{ type: 'thinking', thinking: 'x' }])]).activity.kind, 'thinking');
  assert.equal(one([user()]).activity.kind, 'thinking', 'a fresh prompt: the model is about to think');
  assert.equal(one([asst([tool('Bash', { command: 'ls' })], 'tool_use'), result()]).activity.kind, 'thinking', 'after a tool result');
  assert.equal(one([user(), asst([{ type: 'text', text: 'partial' }])]).activity.kind, 'writing');
  const t = one([user(), asst([{ type: 'text', text: 'ok' }, tool('Read', { file_path: path.join(CWD, 'a.js') })], 'tool_use')]);
  assert.deepEqual(t.activity, { kind: 'tool', tool: 'Read' }, 'tool name only without text');
  const w = one([user(), asst([{ type: 'text', text: 'done' }], 'end_turn')]);
  assert.deepEqual(w.activity, { kind: 'waiting' });
  assert.equal(w.status, 'waiting');
  assert.equal(one([user('[Request interrupted by user]')]).activity.kind, 'waiting');
});

test('activity: a question to the user counts as waiting even though the last line is a tool call', () => {
  const r = one([user(), asst([tool('AskUserQuestion', { questions: [] })], 'tool_use')]);
  assert.equal(r.status, 'waiting');
  assert.equal(r.activity.kind, 'waiting');
});

test('activity: idle and done follow the status rules', () => {
  const claudeRoot = setup([['s.jsonl', [user(), asst([tool('Bash', { command: 'ls' })], 'tool_use')]]]);
  const t0 = fs.statSync(path.join(claudeRoot, 'proj', 's.jsonl')).mtimeMs;
  const kind = (min) => rowsOf(claudeRoot, { now: t0 + min * 60000 }, { windowMs: 48 * 3600000 })[0].activity.kind;
  assert.equal(kind(1), 'tool');
  assert.equal(kind(20), 'idle');
  assert.equal(kind(7 * 60), 'done');
});

test('tool target: relative path, first command words, subagent type, pattern; only with text enabled', () => {
  const cases = [
    [tool('Read', { file_path: path.join(CWD, 'src', 'a.js') }), 'src/a.js'],
    [tool('Edit', { file_path: path.join(CWD, 'lib', 'b.js'), old_string: 'SECRET', new_string: 'x' }), 'lib/b.js'],
    [tool('Write', { file_path: path.join(CWD, 'c.md'), content: 'SECRET BODY' }), 'c.md'],
    [tool('NotebookEdit', { notebook_path: path.join(CWD, 'n.ipynb') }), 'n.ipynb'],
    [tool('Bash', { command: 'FOO=1 npm test -- --watch SECRET' }), 'npm test'],
    [tool('Agent', { subagent_type: 'crewgate:crew-worker', prompt: 'SECRET' }), 'crewgate:crew-worker'],
    [tool('Grep', { pattern: 'needle' }), 'needle'],
    [tool('Glob', { pattern: '**/*.js' }), '**/*.js'],
  ];
  for (const [tu, want] of cases) {
    const objs = [user(), asst([tu], 'tool_use')];
    const shown = one(objs, { showText: true });
    assert.equal(shown.activity.tool, tu.name);
    assert.equal(shown.activity.target, want, tu.name);
    const hidden = one(objs);
    assert.equal(hidden.activity.target, undefined, `${tu.name} target is withheld`);
    assert.ok(!JSON.stringify(shown).includes('SECRET'), 'no argument bodies');
  }
});

test('tool target: redacted and at most 60 characters', () => {
  const r = one([user(), asst([tool('Bash', { command: 'export TOKEN=abcdef0123456789xyz' })], 'tool_use')], { showText: true });
  assert.doesNotMatch(r.activity.target, /abcdef0123456789/);
  const longPath = `/elsewhere/${'deep/'.repeat(30)}file.js`;
  const lp = one([user(), asst([tool('Read', { file_path: longPath })], 'tool_use')], { showText: true });
  assert.ok(lp.activity.target.length <= 60 && lp.activity.target.startsWith('…') && lp.activity.target.endsWith('file.js'));
  const gp = one([user(), asst([tool('Grep', { pattern: 'x'.repeat(200) })], 'tool_use')], { showText: true });
  assert.ok(gp.activity.target.length <= 60);
  assert.equal(targetOf(null, CWD), null);
  assert.equal(targetOf({ k: 'path', v: 'C:\\Work\\Repo\\src\\a.js' }, 'c:\\work\\repo'), 'src/a.js', 'Windows paths, case-insensitive prefix');
});

test('snippets: last prompt, last reply and title are redacted, short, and only with text enabled', () => {
  const objs = [
    { type: 'custom-title', customTitle: 'My session token=abcdef0123456789', sessionId: 'sess1' },
    user(`Please fix this. password=hunter2hunter2 ${'p'.repeat(400)}`),
    user('<system-reminder>ignore me</system-reminder>', { isMeta: true }),
    asst([{ type: 'text', text: `All done. api_key=ZZZZ1234567890 ${'r'.repeat(400)}` }], 'end_turn'),
  ];
  const plain = one(objs);
  for (const k of ['last_prompt', 'last_reply', 'title']) assert.equal(plain[k], undefined, k);
  const s = one(objs, { showText: true });
  assert.match(s.last_prompt, /^Please fix this\./);
  assert.match(s.last_reply, /^All done\./);
  assert.match(s.title, /^My session/);
  for (const k of ['last_prompt', 'last_reply', 'title']) assert.ok(s[k].length <= 160, k);
  assert.doesNotMatch(JSON.stringify(s), /hunter2hunter2|ZZZZ1234567890|abcdef0123456789/);
});

test('snippets: tool results and system wrappers are not prompts; the last-prompt record wins when newer', () => {
  const s = one([user('first real prompt'), user([{ type: 'tool_result', content: 'RESULT TEXT' }]), user('<local-command-stdout>x</local-command-stdout>'),
    asst([{ type: 'text', text: 'ok' }], 'end_turn'), { type: 'last-prompt', lastPrompt: 'closing prompt', sessionId: 'sess1' }], { showText: true });
  assert.equal(s.last_prompt, 'closing prompt');
  assert.ok(!JSON.stringify(s).includes('RESULT TEXT'));
});

test('title: custom title beats ai title; both come from the tail only', () => {
  const objs = [{ type: 'ai-title', aiTitle: 'AI named', sessionId: 'sess1' }, user(), asst([{ type: 'text', text: 'x' }], 'end_turn')];
  assert.equal(one(objs, { showText: true }).title, 'AI named');
  assert.equal(one([{ type: 'custom-title', customTitle: 'Mine' }, ...objs], { showText: true }).title, 'Mine');
});

test('role mapping with or without the plugin prefix', () => {
  assert.equal(roleOf('crewgate:crew-worker'), 'worker');
  assert.equal(roleOf('crew-reviewer'), 'reviewer');
  assert.equal(roleOf('crewgate:crew-refuter'), 'refuter');
  assert.equal(roleOf('worker'), 'worker');
  assert.equal(roleOf('Explore'), 'other');
  assert.equal(roleOf(undefined), 'other');
});

test('role and task come from the project events; subagents nest under their parent session', () => {
  const claudeRoot = setup([
    ['sess1.jsonl', [user(), asst([tool('Agent', { subagent_type: 'crewgate:crew-worker' })], 'tool_use')]],
    ['sess1/subagents/agent-aaa.jsonl', [user('work', { isSidechain: true, agentId: 'aaa' }), asst([tool('Bash', { command: 'ls' })], 'tool_use', { isSidechain: true })]],
    ['sess1/subagents/agent-bbb.jsonl', [user('review', { isSidechain: true }), asst([{ type: 'text', text: 'x' }], 'end_turn', { isSidechain: true })]],
    ['sess1/subagents/agent-ccc.jsonl', [user('explore', { isSidechain: true }), asst([{ type: 'text', text: 'x' }], 'end_turn', { isSidechain: true })]],
    ['sess2.jsonl', [user(), asst([{ type: 'text', text: 'plain' }], 'end_turn')]],
  ]);
  const evFile = path.join(h.tmpDir('crew-d-ev-'), 'events.jsonl');
  const ev = (type, o) => JSON.stringify({ v: 1, ts: iso(Date.now()), id: `${type}${Math.random()}`, type, src: 'hook', session: null, task: null, agent: null, data: {}, ...o });
  fs.writeFileSync(evFile, [
    ev('task.dispatched', { session: 'sess1', task: 'T-001', data: { agent_type: 'crewgate:crew-worker' } }),
    ev('subagent.start', { session: 'sess1', agent: 'aaa', task: 'T-001', data: { agent_type: 'crewgate:crew-worker' } }),
    ev('subagent.start', { session: 'sess1', agent: 'bbb', task: 'T-001', data: { agent_type: 'crewgate:crew-reviewer' } }),
    ev('subagent.start', { session: 'sess1', agent: 'ccc', data: { agent_type: 'Explore' } }),
    'not json',
  ].join('\n') + '\n');
  const rows = rowsOf(claudeRoot, {}, { sessionEnds: createSessionEnds(() => [evFile]) });
  const by = (pred) => rows.find(pred);
  const main = by((r) => !r.subagent && r.role === 'orchestrator');
  assert.ok(main, 'the dispatching session is the orchestrator');
  const plain = by((r) => !r.subagent && r.role !== 'orchestrator');
  assert.equal(plain.role, null, 'a session that dispatched nothing has no role');
  assert.equal(plain.parent, null);
  const subs = rows.filter((r) => r.subagent);
  assert.equal(subs.length, 3);
  assert.ok(subs.every((r) => r.parent === main.id), 'children point at the parent row');
  assert.deepEqual(subs.map((r) => r.role).sort(), ['other', 'reviewer', 'worker']);
  assert.deepEqual(subs.find((r) => r.role === 'worker').task, { id: 'T-001', title: null });
  assert.equal(subs.find((r) => r.role === 'worker').agent_type, 'crew-worker');
  assert.equal(subs.find((r) => r.role === 'other').task, null);
});

test('subagent without any crewgate event is "other"; without an index there is no role at all', () => {
  const claudeRoot = setup([['sess1/subagents/agent-zzz.jsonl', [user('x', { isSidechain: true }), asst([{ type: 'text', text: 'x' }], 'end_turn', { isSidechain: true })]]]);
  assert.equal(rowsOf(claudeRoot, {}, { sessionEnds: createSessionEnds(() => []) })[0].role, 'other');
  assert.equal(rowsOf(claudeRoot)[0].role, null);
});

// ---------------------------------------------------------------- branch and worktree
function fakeRepo() {
  const root = h.tmpDir('crew-d-git-');
  fs.mkdirSync(path.join(root, 'main', '.git', 'refs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'main', 'sub', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main', '.git', 'HEAD'), 'ref: refs/heads/feat/one\n');
  return root;
}

test('branch: normal repo (also from a subfolder), linked worktree, detached HEAD, no repo', () => {
  const root = fakeRepo();
  const g = createGitInfo();
  assert.deepEqual(g.get(path.join(root, 'main')), { branch: 'feat/one', detached: false, worktree: null });
  assert.equal(g.get(path.join(root, 'main', 'sub', 'dir')).branch, 'feat/one');
  // linked worktree: .git is a file pointing into <main>/.git/worktrees/<name>
  const gd = path.join(root, 'main', '.git', 'worktrees', 'wt1');
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/fix/two\n');
  const wt = path.join(root, 'wt1');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
  assert.deepEqual(g.get(wt), { branch: 'fix/two', detached: false, worktree: 'wt1' });
  // detached HEAD
  const sha = 'a'.repeat(40);
  fs.writeFileSync(path.join(gd, 'HEAD'), `${sha}\n`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(gd, 'HEAD'), later, later);
  assert.deepEqual(g.get(wt), { branch: 'aaaaaaa', detached: true, worktree: 'wt1' });
  assert.equal(g.get(path.join(h.tmpDir('crew-d-nogit-'), 'missing')), null, 'a folder that does not exist');
  assert.equal(g.get(null), null);
  assert.deepEqual(parseHead('ref: refs/heads/main'), { branch: 'main', detached: false });
  assert.equal(parseHead('garbage'), null);
});

test('branch: a changed HEAD is picked up (cached by mtime) and rows carry branch and worktree', () => {
  const root = fakeRepo();
  const cwd = path.join(root, 'main');
  const claudeRoot = setup([['s.jsonl', [{ ...user(), cwd }, { ...asst([{ type: 'text', text: 'x' }], 'end_turn'), cwd }]]]);
  const w = createWatcher({ claudeRoot, codexRoot: null, ttlMs: 0 });
  assert.equal(w.sessions()[0].branch, 'feat/one');
  fs.writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cwd, '.git', 'HEAD'), later, later);
  const r = w.sessions()[0];
  assert.equal(r.branch, 'other');
  assert.equal(r.worktree, null);
  assert.equal(r.detached, false);
});

test('branch: falls back to the branch recorded in the transcript when the folder is gone', () => {
  const r = one([{ ...user(), cwd: path.join(h.tmpDir('crew-d-gone-'), 'missing'), gitBranch: 'recorded' }, asst([{ type: 'text', text: 'x' }], 'end_turn')]);
  assert.equal(r.branch, 'recorded');
});

test('branch detection does not spawn processes', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'board', 'gitinfo.js'), 'utf8'), /child_process|spawn|execSync|execFile/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'board', 'watcher.js'), 'utf8'), /child_process/);
});

// ---------------------------------------------------------------- Codex
test('Codex: status, last tool with target, model, prompt and reply; no role or task', () => {
  const ts = () => iso(Date.now());
  const meta = { type: 'session_meta', timestamp: ts(), payload: { cwd: '/tmp/cx-repo', source: 'cli' } };
  const ctx = { type: 'turn_context', timestamp: ts(), payload: { cwd: '/tmp/cx-repo', model: 'gpt-x' } };
  const ev = (type, p = {}) => ({ type: 'event_msg', timestamp: ts(), payload: { type, ...p } });
  const call = { type: 'response_item', timestamp: ts(), payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status --short'] }) } };
  const reasoning = { type: 'response_item', timestamp: ts(), payload: { type: 'reasoning' } };
  const msg = { type: 'response_item', timestamp: ts(), payload: { type: 'message', role: 'assistant' } };
  const run = (lines, call2) => {
    const codexRoot = h.tmpDir('crew-d-codex-');
    const dir = path.join(codexRoot, '2026', '10', '29');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-1.jsonl'), jl(lines));
    const rows = createWatcher({ claudeRoot: null, codexRoot, ttlMs: 0 }).sessions(call2);
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const t = run([meta, ctx, ev('task_started'), ev('user_message', { message: 'run the tests' }), call], { showText: true });
  assert.equal(t.status, 'tool');
  assert.deepEqual(t.activity, { kind: 'tool', tool: 'shell', target: 'git status' });
  assert.equal(t.last_prompt, 'run the tests');
  assert.equal(t.model, 'gpt-x');
  assert.equal(t.role, null);
  assert.equal(t.task, null);
  assert.deepEqual(run([meta, ctx, ev('task_started'), call], {}).activity, { kind: 'tool', tool: 'shell' });
  assert.equal(run([meta, ctx, ev('task_started'), reasoning]).activity.kind, 'thinking');
  assert.equal(run([meta, ctx, ev('task_started'), msg]).activity.kind, 'writing');
  const done = run([meta, ctx, ev('task_started'), ev('task_complete', { last_agent_message: 'finished it' })], { showText: true });
  assert.equal(done.activity.kind, 'waiting');
  assert.equal(done.last_reply, 'finished it');
  assert.equal(run([meta, ctx, ev('task_started'), ev('task_complete', { last_agent_message: 'x' })]).last_reply, undefined);
});

// ---------------------------------------------------------------- performance
test('performance: 200 synthetic transcripts are listed quickly, and a repeat scan is cheaper', () => {
  const claudeRoot = h.tmpDir('crew-d-perf-');
  const filler = JSON.stringify({ type: 'attachment', cwd: CWD, pad: 'z'.repeat(900) }) + '\n';
  for (let i = 0; i < 200; i++) {
    const f = path.join(claudeRoot, `proj${i % 10}`, `sess${i}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, filler.repeat(120) + jl([user(`prompt ${i}`, { sessionId: `sess${i}` }), asst([tool('Read', { file_path: path.join(CWD, `f${i}.js`) })], 'tool_use', { sessionId: `sess${i}` })]));
  }
  const w = createWatcher({ claudeRoot, codexRoot: null, ttlMs: 0, maxFiles: 300 });
  const t0 = Date.now();
  const first = w.sessions({ showText: true });
  const firstMs = Date.now() - t0;
  assert.equal(first.length, 200);
  assert.ok(first.every((r) => r.activity.kind === 'tool' && r.activity.target));
  const t1 = Date.now();
  w.sessions({ showText: true });
  const secondMs = Date.now() - t1;
  assert.ok(firstMs < 5000, `first scan took ${firstMs} ms`);
  assert.ok(secondMs < 3000, `second scan took ${secondMs} ms`);
});
