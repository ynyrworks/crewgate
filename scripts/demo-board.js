#!/usr/bin/env node
'use strict';

// Builds a fully fictional demo for the board and serves it on 127.0.0.1.
//
//   node scripts/demo-board.js [--port N] [--lang en|zh-TW] [--dir <empty folder>]
//
// Everything lives in a temp folder (or --dir): a CREWGATE_HOME, a copy of examples/todo-cli as a
// git repo with two linked worktrees, and fake ~/.claude and ~/.codex roots with made-up session
// logs. Nothing of your real data is read or written. Press Ctrl+C to stop; the temp folder is
// removed on exit. The README screenshots (docs/images) were taken from this board.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PLUGIN = path.join(REPO, 'plugins', 'crewgate');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const baseDir = arg('dir') ? path.resolve(arg('dir')) : fs.mkdtempSync(path.join(os.tmpdir(), 'crewgate-demo-'));
fs.mkdirSync(baseDir, { recursive: true });
if (fs.readdirSync(baseDir).length) { console.error(`demo folder is not empty: ${baseDir}`); process.exit(1); }
const real = fs.realpathSync.native(baseDir);
process.env.CREWGATE_HOME = path.join(real, 'crewgate-home');
process.env.GIT_CEILING_DIRECTORIES = real;
const lang = arg('lang', 'en');

const projects = require(path.join(PLUGIN, 'lib', 'core', 'project'));
const tasks = require(path.join(PLUGIN, 'lib', 'core', 'tasks'));
const store = require(path.join(PLUGIN, 'lib', 'core', 'store'));
const events = require(path.join(PLUGIN, 'lib', 'core', 'events'));
const paths = require(path.join(PLUGIN, 'lib', 'core', 'paths'));
const json = require(path.join(PLUGIN, 'lib', 'core', 'json'));
const config = require(path.join(PLUGIN, 'lib', 'core', 'config'));
const { createBoard } = require(path.join(PLUGIN, 'board', 'server'));

const MIN = 60 * 1000;
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * MIN).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// the board also looks at file times: make a log look as old as its newest record
const touch = (file, minAgo) => { const d = new Date(NOW - minAgo * MIN); fs.utimesSync(file, d, d); };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ------------------------------------------------------------------ the project: examples/todo-cli
const work = path.join(real, 'work');
const repo = path.join(work, 'todo-cli');
fs.cpSync(path.join(REPO, 'examples', 'todo-cli'), repo, { recursive: true });
git(work, 'init', '-q', '-b', 'main', repo);
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');
const wtDue = path.join(work, 'todo-cli-due');
const wtPrio = path.join(work, 'todo-cli-priority');
const wtCsv = path.join(work, 'todo-cli-csv');
git(repo, 'worktree', 'add', '-q', '-b', 'feat/due-dates', wtDue);
git(repo, 'worktree', 'add', '-q', '-b', 'feat/priority-flag', wtPrio);
git(repo, 'worktree', 'add', '-q', '-b', 'feat/export-csv', wtCsv);

const { project } = projects.add(repo, { name: 'todo-cli' });
const PID = project.id;

// language and prices (made-up numbers, per million tokens)
config.saveGlobal({
  language: lang,
  board: { show_text: true },
  prices: {
    'claude-opus-4': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
    'claude-sonnet-4': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
    'gpt-5-codex': { input: 1.25, output: 10, cache_read: 0.125 },
  },
}, { src: 'demo' });

// ------------------------------------------------------------------ tasks
function brief(goal, allow) {
  return ['# Goal', goal, '', '# Scope', `Allowed: ${allow}. Forbidden: package.json, todos.json.`, '',
    '# Must not regress', 'Existing tests keep passing; old todos files still load.', '',
    '# Acceptance', 'node --test passes with new tests for the behaviour.', '',
    '# Context', 'See src/todo.js and test/todo.test.js.', ''].join('\n');
}
const REPORT = ['## Branch & commits', 'feat/x 1a2b3c4', '', '## What changed and why', '- src/todo.js: the change', '',
  '## Tests run', 'node --test: 9 pass', '', '## Assumptions & unfinished', 'none', '', '## Needs real-environment check', 'no', ''].join('\n');

const ORCH = '7c1e0b52-5d3a-4e18-9a77-0d4f2b6c8a11';
const SIM = { session: ORCH, src: 'demo' };

function makeTask(title, goal, branch, worktree, createdMinAgo) {
  const t = tasks.createTask(PID, { title, brief: brief(goal, 'src/**, bin/**, test/**'), branch, worktree, acceptance: ['node --test passes'] }, SIM);
  return { id: t.id, createdMinAgo, title };
}
function advance(t, states) { for (const s of states) tasks.transition(PID, t.id, s, SIM); }
// spreads created/updated/history over the last `span` minutes starting `start` minutes ago
function retime(t, start, span) {
  const file = path.join(paths.taskDir(PID, t.id), 'task.json');
  const d = json.readJson(file, {}).data;
  const n = d.history.length;
  d.created = ago(start);
  d.history.forEach((h, i) => { h.ts = ago(start - (span * i) / Math.max(1, n - 1)); });
  d.updated = d.history[n - 1].ts;
  json.save(file, d);
}
function findingsFile(t, name, data) { write(path.join(paths.taskDir(PID, t.id), 'findings', name), JSON.stringify(data, null, 2)); }
const finding = (id, category, severity, file, claim, verdict) => ({ id, category, severity, file, claim, verdict, confidence: 0.85, verified_by: 'quote' });

const tDue = makeTask('Add due dates to todos', 'Optional due date: todo add "x" --due 2026-11-01, shown in the list.', 'feat/due-dates', wtDue);
advance(tDue, ['dispatched', 'returned', 'reviewing', 'dispatched', 'returned', 'accepted', 'merged']);
findingsFile(tDue, '1.raw.json', [finding('F-1', 'correctness', 'major', 'src/todo.js', 'addTodo keeps duplicates'), finding('F-2', 'maintainability', 'minor', 'src/todo.js', 'rename fmt'), finding('F-3', 'test-gap', 'minor', 'test/todo.test.js', 'no test for malformed dates')]);
findingsFile(tDue, '1.filtered.json', [{ finding: finding('F-2', 'maintainability', 'minor', 'src/todo.js', 'rename fmt'), reason: 'dismissed' }]);
findingsFile(tDue, '1.json', [finding('F-1', 'correctness', 'major', 'src/todo.js', 'addTodo keeps duplicates', 'upheld')]);
retime(tDue, 215, 130);

const tSort = makeTask('Sort the list by due date', 'todo list --sort due orders items by due date, undated last.', 'feat/sort-due', wtDue);
advance(tSort, ['dispatched', 'returned', 'reviewing']);
findingsFile(tSort, '1.raw.json', [1, 2, 3, 4, 5].map((n) => finding(`F-${n}`, 'correctness', 'minor', 'src/todo.js', 'raw')));
findingsFile(tSort, '1.filtered.json', [{ finding: finding('F-5', 'nit', 'nit', 'src/todo.js', 'style'), reason: 'style' }]);
findingsFile(tSort, '1.json', [
  finding('F-1', 'correctness', 'major', 'src/todo.js', 'undated items sort first on some inputs', 'upheld'),
  finding('F-2', 'test-gap', 'minor', 'test/todo.test.js', 'no test for ties', 'upheld'),
  finding('F-3', 'regression', 'major', 'bin/todo.js', 'default order changed', 'refuted'),
  finding('F-4', 'maintainability', 'minor', 'src/todo.js', 'comparator is duplicated', 'uncertain'),
]);
retime(tSort, 75, 50);

const tPrio = makeTask('Add a priority flag', 'todo add "x" --prio high|normal|low; list shows a marker.', 'feat/priority-flag', wtPrio);
advance(tPrio, ['dispatched']);
retime(tPrio, 22, 1);

const tCsv = makeTask('Export todos as CSV', 'todo export --csv prints items as CSV with a header row.', 'feat/export-csv', wtCsv);
advance(tCsv, ['dispatched', 'returned']);
retime(tCsv, 48, 15);

const tCrash = makeTask('Fix crash on an empty todos file', 'An empty todos.json must load as an empty list.', 'fix/empty-file', wtDue);
advance(tCrash, ['dispatched', 'returned', 'reviewing', 'accepted']);
findingsFile(tCrash, '1.json', []);
retime(tCrash, 160, 60);

const tArch = makeTask('Archive completed todos', 'todo archive moves done items to todos.archive.json.', 'feat/archive', wtDue);
retime(tArch, 12, 1);

const tColor = makeTask('Colour the list output', 'ANSI colours when stdout is a TTY.', 'feat/colour', wtDue);
advance(tColor, ['cancelled']);
retime(tColor, 300, 20);

// ------------------------------------------------------------------ needs, work, log, MRs, validation, handoff
store.needAdd(PID, 'Decide: should --due accept relative dates such as "tomorrow", or only YYYY-MM-DD?', SIM);
store.needAdd(PID, 'Approve publishing todo-cli 0.2.0 to the package registry (needs your OK).', SIM);
const done = store.needAdd(PID, 'Pick a licence for the example project.', SIM);
store.needDone(PID, done.id, SIM);

store.workSet(PID, { stream: 'Due dates', title: 'Add due dates to todos', state: 'done', note: 'merged after one send-back' }, SIM);
store.workSet(PID, { stream: 'Due dates', title: 'Sort the list by due date', state: 'doing', note: 'in review, round 1' }, SIM);
store.workSet(PID, { stream: 'Due dates', title: 'Relative dates', state: 'waiting', note: 'waiting for your decision' }, SIM);
store.workSet(PID, { stream: 'Quality of life', title: 'Add a priority flag', state: 'doing', note: 'worker running' }, SIM);
store.workSet(PID, { stream: 'Quality of life', title: 'Export todos as CSV', state: 'doing', note: 'report returned' }, SIM);
store.workSet(PID, { stream: 'Quality of life', title: 'Archive completed todos', state: 'todo' }, SIM);
store.workSet(PID, { stream: 'Quality of life', title: 'Colour the list output', state: 'parked', note: 'cancelled for now' }, SIM);

store.logAdd(PID, 'orchestrator', 'Dispatched "Add a priority flag" to a worker (sonnet) on feat/priority-flag.', SIM);
store.logAdd(PID, 'reviewer', 'Round 1 on "Sort the list by due date": 5 raw, 4 kept, 1 refuted.', SIM);
store.logAdd(PID, 'orchestrator', 'Accepted "Fix crash on an empty todos file" after review.', SIM);
store.logAdd(PID, 'orchestrator', 'Merged feat/due-dates into main.', SIM);

store.mrSet(PID, 12, 'Add due dates to todos', { ci: 'passed', merged: true }, SIM);
store.mrSet(PID, 14, 'Fix crash on an empty todos file', { ci: 'passed', merged: false }, SIM);
store.mrSet(PID, 15, 'Export todos as CSV', { ci: 'running', merged: false }, SIM);
store.validateSet(PID, { templateId: 'cli-smoke', date: '2026-10-27', host: 'lab-linux', result: 'passed: add, list, done' }, SIM);
store.validateSet(PID, { templateId: 'cli-smoke', date: '2026-10-28', host: 'lab-windows', result: 'passed: add, list, done' }, SIM);

const hand = { id: 'h-20261029-demo', title: 'Continue the due-date work in a fresh session', task: tSort.id, created: ago(9), note: 'Review round 1 is done; send back F-1 and F-2.' };
json.save(paths.handoffFile(PID, 'open', hand.id), hand);

// two more small projects so the overview has more than one row
function miniProject(name, items, needs) {
  const dir = path.join(work, name);
  write(path.join(dir, 'README.md'), `# ${name}
`);
  git(work, 'init', '-q', '-b', 'main', dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const pid = projects.add(dir, { name }).project.id;
  items.forEach(([title, states, minAgo]) => {
    const t = tasks.createTask(pid, { title, brief: brief(title, 'src/**'), branch: `feat/${title.toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 24)}` }, SIM);
    for (const st of states) tasks.transition(pid, t.id, st, SIM);
    retime2(pid, t.id, minAgo);
  });
  needs.forEach((n) => store.needAdd(pid, n, SIM));
  store.logAdd(pid, 'orchestrator', 'Plan agreed; tasks created.', SIM);
}
function retime2(pid, id, minAgo) {
  const file = path.join(paths.taskDir(pid, id), 'task.json');
  const d = json.readJson(file, {}).data;
  d.created = ago(minAgo + 30);
  d.history.forEach((h, i) => { h.ts = ago(minAgo + 30 - i * 5); });
  d.updated = ago(minAgo);
  json.save(file, d);
}
miniProject('notes-api', [['Add pagination to GET /notes', ['dispatched', 'returned', 'reviewing', 'accepted', 'merged'], 600], ['Rate-limit note creation', ['dispatched', 'returned'], 190], ['Return 404 for deleted notes', ['dispatched'], 55]], ['Which rate limit do you want: 60 or 120 requests per minute?']);
miniProject('docs-site', [['Fix broken anchor links', ['dispatched', 'returned', 'reviewing', 'accepted', 'merged'], 1500], ['Add a dark theme', ['dispatched', 'returned', 'reviewing'], 320]], []);

// ------------------------------------------------------------------ fake sessions
const claudeRoot = path.join(real, 'fake-home', '.claude', 'projects');
const codexRoot = path.join(real, 'fake-home', '.codex', 'sessions');
const CP = path.join(claudeRoot, '-work-todo-cli');
let msgN = 0;
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

function claude(file, base_, recs) {
  write(file, jl(recs.map((r) => {
    const m = { ...base_, timestamp: ago(r.at) };
    if (r.u) return { ...m, type: 'user', message: { role: 'user', content: r.u } };
    msgN++;
    const content = r.tool ? [{ type: 'tool_use', id: `tu${msgN}`, name: r.tool, input: r.input || {} }] : [{ type: 'text', text: r.text || 'ok' }];
    return { ...m, type: 'assistant', uuid: `u${msgN}`, message: { id: `msg_${msgN}`, role: 'assistant', model: r.model || 'claude-opus-4', stop_reason: r.tool ? 'tool_use' : 'end_turn', content, usage: r.usage || usage(1200, 380, 42000, 0) } };
  })));
  touch(file, Math.min(...recs.map((r) => r.at)));
}

const base = (cwd, branch, sid, extra = {}) => ({ cwd, sessionId: sid, gitBranch: branch, entrypoint: 'cli', userType: 'external', ...extra });

// orchestrator: running a command right now, with three subagents under it
claude(path.join(CP, `${ORCH}.jsonl`), base(repo, 'main', ORCH), [
  { at: 95, u: 'Add due dates, sorting and a priority flag to todo-cli. Delegate it.' },
  { at: 90, text: 'Plan: three tasks, one worker each. I write the briefs and review the results.' },
  { at: 40, tool: 'Bash', input: { command: 'node crew.js task create --title "Add a priority flag"' } },
  { at: 2, tool: 'Bash', input: { command: 'node crew.js review filter' } },
]);
const sub = (agent, cwd, branch, recs) => claude(path.join(CP, ORCH, 'subagents', `agent-${agent}.jsonl`), { ...base(cwd, branch, ORCH), isSidechain: true, agentId: agent }, recs);
sub('w1a2b3', wtPrio, 'feat/priority-flag', [
  { at: 20, u: 'crew-task: brief', model: 'claude-sonnet-4' },
  { at: 1, tool: 'Edit', input: { file_path: path.join(wtPrio, 'src', 'todo.js') }, model: 'claude-sonnet-4', usage: usage(900, 650, 51000, 3000) },
]);
sub('r4d5e6', wtDue, 'feat/sort-due', [
  { at: 12, u: 'crew-task: review', model: 'claude-sonnet-4' },
  { at: 1, tool: 'Grep', input: { pattern: 'sortByDue' }, model: 'claude-sonnet-4', usage: usage(700, 220, 38000, 0) },
]);
sub('f7a8b9', wtCsv, 'feat/export-csv', [
  { at: 30, u: 'crew-task: refute', model: 'claude-sonnet-4' },
  { at: 20, text: 'F-3 upheld.', model: 'claude-sonnet-4' },
]);
const ev = (type, agent, task, agentType) => events.append(PID, { type, src: 'demo', session: ORCH, task, agent, data: { agent_type: agentType }, key: `${type}:${agent}` });
events.append(PID, { type: 'task.dispatched', src: 'demo', session: ORCH, task: tPrio.id, data: { agent_type: 'crew-worker', background: true }, key: 'd1' });
ev('subagent.start', 'w1a2b3', tPrio.id, 'crew-worker');
ev('subagent.start', 'r4d5e6', tSort.id, 'crew-reviewer');
ev('subagent.start', 'f7a8b9', tCsv.id, 'crew-refuter');
ev('subagent.stop', 'f7a8b9', tCsv.id, 'crew-refuter');

// a second session that finished its turn: waiting for you
const ASK = '3b9d6a40-8f21-4c7e-b5a2-91e07c4d2f63';
claude(path.join(CP, `${ASK}.jsonl`), base(repo, 'main', ASK, { entrypoint: 'claude-desktop' }), [
  { at: 14, u: 'Should the due date also accept "tomorrow"?' },
  { at: 6, text: 'I can support both. Which do you prefer: only YYYY-MM-DD, or relative dates too?' },
]);
// an older conversation that went quiet: idle
const OLD = '5e2f7c91-0a44-4d6b-8c13-b7a09e5d1c28';
claude(path.join(CP, `${OLD}.jsonl`), base(repo, 'main', OLD), [
  { at: 300, u: 'Summarise the open review findings.' },
  { at: 290, text: 'Two findings are open, one upheld and one uncertain.' },
]);

// Codex: a worker running now, an interactive session waiting, a finished one-shot run
function codex(file, id, meta, recs) {
  write(file, jl([{ type: 'session_meta', timestamp: ago(recs[0].at + 1), payload: { id, cwd: meta.cwd, cli_version: '0.0.0', originator: meta.originator, source: meta.source } },
    { type: 'turn_context', timestamp: ago(recs[0].at + 1), payload: { cwd: meta.cwd, model: 'gpt-5-codex' } },
    ...recs.map((r) => {
      const ts = ago(r.at);
      if (r.start) return { type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } };
      if (r.call) return { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', r.call] }) } };
      if (r.tokens) return { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: r.tokens, cached_input_tokens: Math.round(r.tokens * 0.7), output_tokens: Math.round(r.tokens / 20) } } } };
      return { type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', last_agent_message: 'Done.' } };
    })]));
  touch(file, Math.min(...recs.map((r) => r.at)));
}
const day = new Date(NOW);
const cdir = path.join(codexRoot, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
codex(path.join(cdir, 'rollout-demo-a.jsonl'), '0192b001-1111-4aaa-8bbb-000000000001', { cwd: wtCsv, originator: 'codex_exec', source: 'exec' },
  [{ at: 9, start: true }, { at: 6, tokens: 52000 }, { at: 1, call: 'node --test' }]);
codex(path.join(cdir, 'rollout-demo-b.jsonl'), '0192b001-1111-4aaa-8bbb-000000000002', { cwd: repo, originator: 'Codex Desktop', source: 'vscode' },
  [{ at: 40, start: true }, { at: 36, tokens: 61000 }, { at: 33 }]);
codex(path.join(cdir, 'rollout-demo-c.jsonl'), '0192b001-1111-4aaa-8bbb-000000000003', { cwd: wtDue, originator: 'codex_exec', source: 'exec' },
  [{ at: 70, start: true }, { at: 66, tokens: 38000 }, { at: 62 }]);

// ------------------------------------------------------------------ usage history (older than the session window)
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let d = 1; d <= 12; d++) {
  const hoursAgo = d * 24 + 3;
  const when = NOW - hoursAgo * 60 * MIN;
  const recs = [{ type: 'user', uuid: `hu${d}`, timestamp: new Date(when - MIN).toISOString(), cwd: repo, sessionId: `hist-${d}`, message: { role: 'user', content: `Tidy up todo-cli, round ${d}` } }];
  const n = 3 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const opus = rnd() < 0.35;
    msgN++;
    recs.push({ type: 'assistant', uuid: `h${msgN}`, timestamp: new Date(when + i * MIN).toISOString(), cwd: repo, sessionId: `hist-${d}`,
      message: { id: `msg_h${msgN}`, role: 'assistant', model: opus ? 'claude-opus-4' : 'claude-sonnet-4', stop_reason: 'end_turn', content: i % 2 ? [{ type: 'tool_use', id: `tuh${msgN}`, name: i % 4 === 1 ? 'Bash' : 'Edit', input: {} }] : [{ type: 'text', text: 'ok' }],
        usage: usage(Math.round(2000 + rnd() * 9000), Math.round(500 + rnd() * 6000), Math.round(60000 + rnd() * 900000), Math.round(rnd() * 40000)) } });
  }
  const f = path.join(CP, `hist-${d}.jsonl`);
  write(f, jl(recs));
  fs.utimesSync(f, new Date(when), new Date(when));
  if (d % 2 === 0) {
    const cf = path.join(codexRoot, 'history', `rollout-hist-${d}.jsonl`);
    write(cf, jl([{ type: 'session_meta', timestamp: new Date(when).toISOString(), payload: { id: `0192c000-0000-4000-8000-0000000000${String(d).padStart(2, '0')}`, cwd: repo, originator: 'codex_exec', source: 'exec' } },
      { type: 'turn_context', timestamp: new Date(when).toISOString(), payload: { model: 'gpt-5-codex' } },
      { type: 'event_msg', timestamp: new Date(when).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: Math.round(30000 + rnd() * 90000), cached_input_tokens: Math.round(rnd() * 30000), output_tokens: Math.round(2000 + rnd() * 9000) } } } }]));
    fs.utimesSync(cf, new Date(when), new Date(when));
  }
}

// ------------------------------------------------------------------ serve
const board = createBoard({ port: Number(arg('port', 0)), claudeRoot, codexRoot, watcher: { ttlMs: 1000 } });
board.listen().then(() => {
  console.log(`crewgate demo board (fictional data, project "todo-cli")`);
  console.log(board.url());
  console.log('Ctrl+C to stop; the temp folder is removed on exit.');
});
function bye() { try { fs.rmSync(real, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(0); }
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
