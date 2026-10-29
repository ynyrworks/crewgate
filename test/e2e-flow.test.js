'use strict';

// Scripted end-to-end flow, no model involved: the real CLI and the real hook script are spawned
// with realistic payloads, then the board API is asked what a user would see.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'crewgate');
const h = require(path.join(PLUGIN, 'test', 'helpers'));
const hk = require(path.join(PLUGIN, 'test', 'hooks-helpers'));
const wf = require(path.join(PLUGIN, 'test', 'workflow-util'));
const bh = require(path.join(PLUGIN, 'test', 'board-helpers'));

h.setupHome();
const events = require(path.join(PLUGIN, 'lib', 'core', 'events'));
const projects = require(path.join(PLUGIN, 'lib', 'core', 'project'));
const rv = require(path.join(PLUGIN, 'lib', 'features', 'review'));
const { createBoard } = require(path.join(PLUGIN, 'board', 'server'));

const SID = 'e2e-session-1';
const BRANCH = 'feat/todo-due';

const GOOD = wf.finding('F-1', { file: 'src/todo.js', symbol: 'addTodo', snippet: 'todos.push({ title });', claim: 'addTodo keeps duplicates' });
const INFERRED = wf.finding('F-2', { file: 'src/todo.js', symbol: 'list', snippet: 'return todos;', verified_by: 'inference', confidence: 0.95, claim: 'list may leak the array' });
const DISMISSED = wf.finding('F-3', { category: 'maintainability', severity: 'minor', file: 'src/todo.js', symbol: 'fmt', snippet: 'const  fmt = (t) =>  t.title;', claim: 'rename fmt' });

const sha = (repo) => h.git(repo, 'rev-parse', '--short', 'HEAD');

test('init inside a linked worktree maps to the same project id as the main checkout', () => {
  h.setupHome();
  const repo = h.makeRepo();
  const wt = path.join(h.tmpDir('crew-wt-'), 'linked');
  h.git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  const fromWt = wf.crewJson(['init'], wt);
  assert.equal(fromWt.code, 0, fromWt.err);
  const fromMain = wf.crewJson(['init'], repo);
  assert.equal(fromMain.code, 0, fromMain.err);
  assert.equal(fromWt.data.project.id, fromMain.data.project.id);
  assert.equal(fromWt.data.project.id, projects.projectId(repo));
  assert.equal(projects.list().length, 1);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'crew.json')), 'files go to the main checkout');
  assert.ok(!fs.existsSync(path.join(wt, '.claude', 'crew.json')), 'the linked worktree is left alone');
  assert.equal(wf.crewJson(['task', 'list'], wt).code, 0, 'commands in the worktree resolve the project');
});

test('full delegated flow: dispatch, report, review, send-back, accept, merge', async () => {
  h.setupHome();
  const repo = h.makeRepo();
  const wt = path.join(h.tmpDir('crew-wt-'), 'worker');
  h.git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  assert.equal(wf.crewJson(['init'], repo).code, 0);
  const pid = projects.projectId(repo);
  const base = (extra) => ({ session_id: SID, cwd: repo, transcript_path: path.join(repo, 'transcript.jsonl'), ...extra });
  const hook = (event, payload) => {
    const r = hk.runHook(event, payload, { cwd: repo });
    assert.equal(r.code, 0, `${event}: ${r.err}`);
    assert.ok(r.json && typeof r.json === 'object', `${event} printed one JSON object`);
    return r.json;
  };

  // a dismissal recorded earlier (by `crew review dismiss`) that must suppress F-3 now
  rv.appendLedger(repo, {
    fingerprint: rv.fingerprint(DISMISSED), category: DISMISSED.category, file: DISMISSED.file, symbol: DISMISSED.symbol,
    snippet: rv.normSnippet(DISMISSED.snippet), reason: 'naming is fine here', scope: 'always', decided_by: 'user', date: '2026-10-01',
  });

  // ---- session start, task creation
  const start = hook('session-start', base({ hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(JSON.stringify(start), /additionalContext/);
  hook('user-prompt-submit', base({ hook_event_name: 'UserPromptSubmit', prompt: 'add due dates to the todo list' }));
  const briefFile = wf.writeFile(h.tmpDir('crew-brief-'), 'brief.md', h.GOOD_BRIEF);
  const created = wf.crewJson(['task', 'create', '--title', 'Add due dates', '--brief-file', briefFile, '--branch', BRANCH, '--worktree', wt], repo);
  assert.equal(created.code, 0, created.err);
  const id = created.data.task.id;
  assert.match(created.data.prompt, new RegExp(`crew-task: ${id}`));

  // ---- first dispatch (background) and worker run
  const agent = (n) => base({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_${n}`,
    tool_input: { prompt: created.data.prompt, subagent_type: 'crew-worker', description: 'Add due dates', model: 'sonnet', run_in_background: true },
  });
  hook('pre-tool-use', agent(1));
  hook('pre-tool-use', agent(1)); // a duplicate delivery must not duplicate anything
  hook('subagent-start', base({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'crew-worker' }));
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'todo.js'), 'const todos = [];\nconst addTodo = (title) => { todos.push({ title }); };\nmodule.exports = { addTodo };\n');
  h.git(wt, 'add', '.');
  h.git(wt, 'commit', '-q', '-m', 'add due dates (first pass)');
  const files = wf.reportFiles(h.GOOD_REPORT.replace('abc123', sha(wt)));
  const rep1 = h.crew(['task', 'report', id, '--report-file', files.report, '--packet-file', files.packet], wt);
  assert.equal(rep1.code, 0, rep1.err);
  const stop1 = hook('subagent-stop', base({
    hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'crew-worker', stop_hook_active: false,
    last_assistant_message: `Done. crew-task: ${id}`, agent_transcript_path: path.join(repo, 'agent-1.jsonl'),
  }));
  assert.match(JSON.stringify(stop1), new RegExp(id), 'the orchestrator is told which task returned');
  const mid = hook('stop', base({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Worker returned.' }));
  assert.ok(!('decision' in mid), 'Stop never blocks');

  // ---- orchestrator reads the report, review round 1
  const shown = wf.crewJson(['task', 'show', id], repo);
  assert.equal(shown.data.task.state, 'returned');
  assert.match(shown.data.report, /add thing/);
  const rawFile = wf.writeFile(h.tmpDir('crew-find-'), 'raw.json', JSON.stringify([GOOD, INFERRED, DISMISSED]));
  assert.equal(h.crew(['review', 'submit', id, '--round', '1', '--file', rawFile], repo).code, 0);
  const filt = wf.crewJson(['review', 'filter', id], repo);
  assert.equal(filt.code, 0, filt.err);
  assert.deepEqual(filt.data.kept.map((f) => f.id), ['F-1']);
  assert.deepEqual(filt.data.dropped.map((d) => `${d.finding.id}:${d.reason}`).sort(), ['F-2:inference', 'F-3:dismissed']);
  const refFile = wf.writeFile(h.tmpDir('crew-ref-'), 'ref.json', JSON.stringify([{ id: 'F-1', verdict: 'upheld', evidence: 'src/todo.js:2 pushes without checking' }]));
  assert.equal(h.crew(['review', 'submit', id, '--kind', 'refutations', '--round', '1', '--file', refFile], repo).code, 0);
  const fin = wf.crewJson(['review', 'finalize', id], repo);
  assert.equal(fin.code, 0, fin.err);
  assert.equal(fin.data.findings.length, 1);
  assert.equal(wf.crewJson(['task', 'show', id], repo).data.task.state, 'reviewing');

  // ---- send-back, second dispatch, second report
  assert.equal(h.crew(['task', 'send-back', id, '--note', 'dedupe titles (F-1)'], repo).code, 0);
  hook('pre-tool-use', agent(2));
  hook('subagent-start', base({ hook_event_name: 'SubagentStart', agent_id: 'agent-2', agent_type: 'crew-worker' }));
  fs.writeFileSync(path.join(wt, 'src', 'todo.js'), 'const todos = [];\nconst addTodo = (title) => { if (!todos.some((t) => t.title === title)) todos.push({ title }); };\nmodule.exports = { addTodo };\n');
  h.git(wt, 'commit', '-q', '-am', 'dedupe titles');
  const files2 = wf.reportFiles(h.GOOD_REPORT.replace('abc123', sha(wt)));
  assert.equal(h.crew(['task', 'report', id, '--report-file', files2.report, '--packet-file', files2.packet], wt).code, 0);
  hook('subagent-stop', base({
    hook_event_name: 'SubagentStop', agent_id: 'agent-2', agent_type: 'crew-worker', stop_hook_active: false,
    last_assistant_message: `Done again. crew-task: ${id}`, agent_transcript_path: path.join(repo, 'agent-2.jsonl'),
  }));

  // ---- accept, merge
  const accepted = wf.crewJson(['task', 'accept', id, '--note', 'dedupe verified'], repo);
  assert.equal(accepted.code, 0, accepted.err);
  h.git(repo, 'merge', '-q', '--no-ff', '-m', 'merge todo-due', BRANCH);
  hook('post-tool-use', base({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_merge',
    tool_input: { command: `git merge --no-ff ${BRANCH}` }, tool_response: { stdout: 'Merge made', stderr: '' },
  }));
  assert.equal(h.crew(['task', 'merge', id], repo).code, 0);
  hook('stop', base({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Merged.' }));
  hook('session-end', base({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }));

  // ---- the event log
  const all = events.read(pid);
  const ids = all.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate event ids');
  assert.deepEqual(all.map((e) => e.type), [
    'session.start', 'task.created', 'task.dispatched', 'subagent.start', 'task.returned', 'subagent.stop',
    'task.reviewed', 'task.sent_back', 'task.dispatched', 'subagent.start', 'task.returned', 'subagent.stop',
    'task.accepted', 'git.merge', 'task.merged', 'session.end',
  ]);
  const dispatches = all.filter((e) => e.type === 'task.dispatched');
  assert.equal(dispatches[0].data.agent_type, 'crew-worker');
  assert.equal(dispatches[0].data.background, true);
  assert.equal(dispatches[1].data.redispatch, true);

  // ---- the board shows the same story
  const board = createBoard({ claudeRoot: h.tmpDir('crew-claude-'), codexRoot: h.tmpDir('crew-codex-'), watcher: { ttlMs: 0 } });
  const port = await board.listen(0);
  try {
    const detail = await bh.request(port, { path: `/api/project/${pid}` });
    assert.equal(detail.status, 200);
    const d = detail.json;
    assert.equal(d.tasks.length, 1);
    const t = d.tasks[0];
    assert.equal(t.id, id);
    assert.equal(t.state, 'merged');
    assert.equal(t.returns, 1);
    assert.deepEqual(t.history.map((x) => x.state), ['created', 'dispatched', 'returned', 'reviewing', 'dispatched', 'returned', 'accepted', 'merged']);
    assert.equal(t.review.raw, 3);
    assert.equal(t.review.filtered, 2);
    assert.equal(t.review.final, 1);
    assert.equal(t.review.upheld, 1);
    assert.equal(t.review.rounds, 1);
    const dropped = JSON.parse(fs.readFileSync(path.join(process.env.CREWGATE_HOME, 'projects', pid, 'tasks', id, 'findings', '1.filtered.json'), 'utf8'));
    assert.deepEqual(dropped.map((x) => x.reason).sort(), ['dismissed', 'inference']);
    assert.deepEqual(d.needs.open, [], 'nothing is waiting for the user');
    assert.ok(d.events.some((e) => e.type === 'git.merge'), 'the git.merge event is shown');
    assert.equal(d.events.filter((e) => e.type === 'task.merged').length, 1);
    const ov = (await bh.request(port, { path: '/api/overview' })).json.projects.find((p) => p.id === pid);
    assert.equal(ov.tasks_open, 0);
    assert.equal(ov.needs, 0);
    assert.equal(ov.tasks.merged, 1);
  } finally {
    await board.close();
  }
});
