'use strict';

// A task linked to a draft plan does not start: Agent dispatch, SendMessage wake-up and `crew task run` (plan.enforce).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./hooks-helpers');
const h = require('./helpers');
const u = require('./workflow-util');
const tasks = require('../lib/core/tasks');
const plans = require('../lib/core/plans');
const sess = require('../lib/hooks/session');
const paths = require('../lib/core/paths');
const project = require('../lib/core/project');
const events = require('../lib/core/events');

const pre = (f, p) => H.runHook('pre-tool-use', p, { cwd: f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const reason = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason) || '';
const context = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';

// A plan file whose one step is linked to the task. state null = a legacy file (no state line).
function writePlan(repo, slug, state, taskId) {
  const dir = path.join(repo, '.crew', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['# Plan', ...(state ? [`<!-- crew-plan state:${state} -->`] : []), 'Goal', '', `- [ ] step <!-- id:n1 task:${taskId} -->`, ''];
  fs.writeFileSync(path.join(dir, `${slug}.md`), lines.join('\n'));
}
function setup(enforce, state) {
  const f = H.fixture(enforce ? { config: { plan: { enforce } } } : {});
  H.start(f);
  const task = H.newTask(f);
  if (state !== undefined) writePlan(f.repo, 'p', state, task.id);
  return { f, task };
}
const types = (f, t) => H.evs(f, [t]).map((e) => e.type);

test('planOfTask finds the plan by the task: key, and null with none', () => {
  const { f, task } = setup('block', 'draft');
  assert.equal(plans.planOfTask(f.repo, task.id), 'p');
  assert.equal(plans.planOfTask(f.repo, 't-other'), null);
  assert.equal(plans.planOfTask(path.join(f.repo, 'nowhere'), task.id), null);
});

test('Agent dispatch on a draft plan: denied under block (the default), the task stays created', () => {
  for (const enforce of ['block', null]) {
    const { f, task } = setup(enforce, 'draft');
    const r = pre(f, H.agentPayload(f, task));
    assert.equal(decision(r), 'deny', r.out);
    assert.match(reason(r), /plan p/);
    assert.match(reason(r), /user/);
    assert.match(reason(r), /plan finalize p/);
    assert.equal(tasks.load(f.pid, task.id).state, 'created');
    const ev = H.evs(f, ['plan.dispatch_denied']);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.slug, 'p');
    assert.equal(ev[0].data.task, task.id);
  }
});

test('Agent dispatch on a draft plan: remind goes through with a line and an event; off goes through silently', () => {
  const a = setup('remind', 'draft');
  const r = pre(a.f, H.agentPayload(a.f, a.task));
  assert.notEqual(decision(r), 'deny');
  assert.match(context(r), /plan p/);
  assert.equal(tasks.load(a.f.pid, a.task.id).state, 'dispatched');
  assert.equal(types(a.f, 'plan.dispatch_unfinalized').length, 1);
  const b = setup('off', 'draft');
  const r2 = pre(b.f, H.agentPayload(b.f, b.task));
  assert.equal(r2.out, '{}');
  assert.equal(tasks.load(b.f.pid, b.task.id).state, 'dispatched');
  assert.equal(types(b.f, 'plan.dispatch_denied').length + types(b.f, 'plan.dispatch_unfinalized').length, 0);
});

test('Agent dispatch: legacy, final, done, parked and no plan change nothing', () => {
  for (const state of [null, 'final', 'done', 'parked', undefined]) {
    const { f, task } = setup('block', state);
    const r = pre(f, H.agentPayload(f, task));
    assert.equal(r.out, '{}', `state ${state}`);
    assert.equal(tasks.load(f.pid, task.id).state, 'dispatched');
    assert.equal(H.evs(f, ['plan.dispatch_denied', 'plan.dispatch_unfinalized', 'plan.check_failed']).length, 0);
  }
});

test('a reviewer linked to a task on a draft plan is not denied', () => {
  const { f, task } = setup('block', 'draft');
  tasks.transition(f.pid, task.id, 'dispatched');
  tasks.transition(f.pid, task.id, 'returned');
  tasks.transition(f.pid, task.id, 'reviewing');
  const r = pre(f, H.agentPayload(f, task, { tool_input: { prompt: `crew-task: ${task.id}\n\nreview`, subagent_type: 'crew-reviewer', description: 'r' } }));
  assert.equal(r.out, '{}');
  assert.equal(H.evs(f, ['plan.dispatch_denied']).length, 0);
});

function stoppedWorker(f, task) {
  tasks.transition(f.pid, task.id, 'dispatched');
  sess.remember(f.pid, `tu-${task.id}`, { task: task.id, type: 'crew-worker', bg: true, worker: true, ts: Date.now(), agent: 'ag-1', stopped: true, session: f.sid });
}
const send = (f) => H.base(f, { tool_name: 'SendMessage', tool_use_id: 'tu-s', tool_input: { to: 'ag-1', message: 'go' } });

test('SendMessage waking a stopped worker on a draft plan: block denies, remind warns, off passes', () => {
  for (const enforce of ['block', 'remind', 'off']) {
    const { f, task } = setup(enforce, 'draft');
    stoppedWorker(f, task);
    const r = pre(f, send(f));
    if (enforce === 'block') {
      assert.equal(decision(r), 'deny', r.out);
      assert.equal(types(f, 'plan.dispatch_denied').length, 1);
      assert.equal(sess.byAgent(f.pid, 'ag-1').stopped, true, 'not marked as running again');
    } else if (enforce === 'remind') {
      assert.match(context(r), /plan p/);
      assert.equal(types(f, 'plan.dispatch_unfinalized').length, 1);
    } else {
      assert.equal(r.out, '{}');
      assert.equal(types(f, 'plan.dispatch_unfinalized').length, 0);
    }
  }
});

test('SendMessage on a final plan passes untouched', () => {
  const { f, task } = setup('block', 'final');
  stoppedWorker(f, task);
  assert.equal(pre(f, send(f)).out, '{}');
});

test('a failure reading the plan lets the dispatch through and records plan.check_failed', () => {
  const { f, task } = setup('block', 'draft');
  const orig = plans.planOfTask;
  plans.planOfTask = () => { throw new Error('disk gone'); };
  let out;
  try { out = require('../lib/hooks/pre-tool-use').run(H.agentPayload(f, task)); } finally { plans.planOfTask = orig; }
  assert.ok(!out || out.hookSpecificOutput.permissionDecision !== 'deny');
  assert.equal(tasks.load(f.pid, task.id).state, 'dispatched');
  assert.equal(H.evs(f, ['plan.check_failed']).length, 1);
});

// ---------------------------------------------------------------- crew task run (fake codex)
const FAKE = [
  "const fs = require('fs');",
  'const a = process.argv.slice(2);',
  'const val = (f) => a[a.indexOf(f) + 1];',
  "fs.writeFileSync(process.env.FAKE_LOG, 'ran');",
  "fs.writeFileSync(require('path').join(val('-C'), 'made.txt'), 'x\\n');",
  "const good = JSON.stringify({ changes: '- made.txt', tests: 'ok', assumptions: 'none', realenv: 'no' });",
  "fs.writeFileSync(val('-o'), good); console.log(good);",
].join('\n');

function runSetup(enforce, state) {
  const repo = u.initRepo();
  for (const [k, v] of [['user.name', 'R'], ['user.email', 'r@example.test'], ['commit.gpgsign', 'false']]) spawnSync('git', ['config', k, v], { cwd: repo });
  if (enforce) u.patchCfg(repo, (c) => { c.plan = { ...(c.plan || {}), enforce }; });
  const bin = h.tmpDir('crew-fakebin-');
  const script = u.writeFile(bin, 'fake.js', FAKE);
  const log = path.join(bin, 'log.txt');
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n${FAKE}\n`, { mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines: { codex: { command: 'codex', args: [] } } }));
  const task = u.createTask(repo, { worktree: path.join(h.tmpDir('crew-wt-'), 'wt') });
  if (state !== undefined) writePlan(repo, 'p', state, task.id);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH || process.env.Path}`, FAKE_LOG: log };
  const pid = project.findByCwd(repo).id;
  return { repo, task, log, pid, run: () => h.crew(['task', 'run', task.id], repo, env) };
}
const taskState = (s) => tasks.load(s.pid, s.task.id).state;

test('crew task run on a draft plan: block refuses and starts nothing; the task stays created', () => {
  h.setupHome();
  const s = runSetup('block', 'draft');
  const r = s.run();
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /plan p/);
  assert.match(r.err, /plan finalize p/);
  assert.equal(fs.existsSync(s.log), false, 'no worker started');
  assert.equal(taskState(s), 'created');
  const ev = events.read(s.pid, { types: ['plan.dispatch_denied'] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.slug, 'p');
});

test('crew task run on a draft plan: remind warns and runs; off runs silently', () => {
  h.setupHome();
  const a = runSetup('remind', 'draft');
  const r = a.run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /draft/);
  assert.equal(fs.existsSync(a.log), true);
  assert.equal(events.read(a.pid, { types: ['plan.dispatch_unfinalized'] }).length, 1);
  const b = runSetup('off', 'draft');
  const r2 = b.run();
  assert.equal(r2.code, 0, r2.err);
  assert.doesNotMatch(r2.err, /draft/);
  assert.equal(events.read(b.pid, { types: ['plan.dispatch_unfinalized', 'plan.dispatch_denied'] }).length, 0);
});

test('crew task run: legacy, final, done, parked and no plan run as before', () => {
  h.setupHome();
  for (const state of [null, 'final', 'done', 'parked', undefined]) {
    const s = runSetup('block', state);
    const r = s.run();
    assert.equal(r.code, 0, `state ${state}: ${r.err}`);
    assert.equal(fs.existsSync(s.log), true);
    assert.equal(events.read(s.pid, { types: ['plan.dispatch_denied', 'plan.dispatch_unfinalized'] }).length, 0);
  }
});
