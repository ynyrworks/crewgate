'use strict';

// Changing a final plan raises the drift question: a new step (plan add, plan accept) and changed text (Agent dispatch,
// SendMessage wake, crew task run, crew task accept), each under plan.enforce block / remind / off. Normal progress never raises it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const h = require('./helpers');
const { crew } = h;
const events = require('../lib/core/events');
const tasks = require('../lib/core/tasks');
const plans = require('../lib/core/plans');
const paths = require('../lib/core/paths');
const sess = require('../lib/hooks/session');

const MODES = ['block', 'remind', 'off'];
function fixture(enforce = 'block') {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const planPath = (f, slug = 'p') => path.join(f.repo, '.crew', 'plans', `${slug}.md`);
const text = (f, slug = 'p') => fs.readFileSync(planPath(f, slug), 'utf8');
const rec = (f, slug = 'p') => plans.readRecord(f.pid, slug);
const evs = (f, ...t) => events.read(f.pid, { types: t });
const edit = (f, from, to) => fs.writeFileSync(planPath(f), text(f).replace(from, to));
const changed = (f) => plans.changedSinceApproved(f.repo, f.pid, 'p');

function finalPlan(f, slug = 'p') {
  let r = run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(f, ['plan', 'add', slug, 'Write the code']).code, 0);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', slug]).out);
  H.prompt(f);
  r = run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
  return slug;
}
// A final plan whose first step is linked to a fresh task.
function linked(enforce) {
  const f = fixture(enforce);
  finalPlan(f);
  const task = H.newTask(f);
  assert.equal(run(f, ['plan', 'link', 'p', 'n1', task.id]).code, 0);
  return { f, task };
}
function answerKind(f, kind, answer = 'defer', t = 'noted') {
  const a = JSON.parse(run(f, ['--json', 'plan', 'drift', 'p', '--kind', kind, '--detail', 'x']).out);
  H.prompt(f);
  const r = run(f, ['plan', 'drift', 'p', '--gate', a.gate_id, '--answer', answer, '--text', t]);
  assert.equal(r.code, 0, r.err);
}
const pre = (f, p) => H.runHook('pre-tool-use', p, { cwd: f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const reason = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason) || '';
const context = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';

// ---------------------------------------------------------------- the hash
test('approvedHash: the box, the comment, the state line, ## Drift and ## Clarified do not change it; text, nesting and the parts do', () => {
  const base = ['# T', '<!-- crew-plan state:final -->', 'Goal', '', '## Not doing', '- nope', '', '## Done when', '- done', '', '- [ ] one <!-- id:n1 -->', '  - [ ] two <!-- id:n2 -->', ''].join('\n');
  const h0 = plans.approvedHash(base);
  const same = [
    base.replace('[ ] one', '[x] one'), base.replace('[ ] two', '[~] two'), base.replace(' <!-- id:n1 -->', ''),
    base.replace('state:final', 'state:done'), `${base}\n## Drift\n- 2026-01-01 new-step add: x\n`, `${base}\n## Clarified\n- q: a\n`,
    `${base}- [?] proposed <!-- id:n3 round:1 -->\n`,
  ];
  same.forEach((t, i) => assert.equal(plans.approvedHash(t), h0, `variant ${i}`));
  const diff = [
    base.replace('# T', '# T2'), base.replace('Goal', 'Goal2'), base.replace('- nope', '- nope2'), base.replace('- done', '- done2'),
    base.replace('one', 'uno'), base.replace('  - [ ] two', '- [ ] two'), `${base}- [ ] three\n`,
  ];
  diff.forEach((t, i) => assert.notEqual(plans.approvedHash(t), h0, `diff ${i}`));
});

test('finalize stores approved; a drift answer stores the new one', () => {
  const f = fixture();
  finalPlan(f);
  assert.equal(rec(f).approved, plans.approvedHash(text(f)));
  edit(f, 'Write the code', 'Write more code');
  assert.equal(changed(f), true);
  answerKind(f, 'changed-text', 'defer');
  assert.equal(rec(f).approved, plans.approvedHash(text(f)));
  assert.equal(changed(f), false);
});

// ---------------------------------------------------------------- never raises
test('progress on a final plan never raises: set done/open/dropped, link, ids, clarify, a ## Drift line, the state line, a proposed step', () => {
  const f = fixture('block');
  finalPlan(f);
  const t1 = H.newTask(f);
  const steps = [
    ['plan', 'set', 'p', 'n1', 'done'], ['plan', 'set', 'p', 'n1', 'open'], ['plan', 'set', 'p', 'n1', 'dropped'], ['plan', 'set', 'p', 'n1', 'open'],
    ['plan', 'link', 'p', 'n1', t1.id], ['plan', 'clarify', 'p', '--question', 'why', '--answer', 'because'],
    ['plan', 'add', 'p', 'Maybe this', '--proposed'],
  ];
  for (const s of steps) {
    const r = run(f, s);
    assert.equal(r.code, 0, `${s.join(' ')}: ${r.err}`);
    assert.equal(changed(f), false, s.join(' '));
  }
  fs.writeFileSync(planPath(f), `${text(f)}\n## Drift\n- 2026-01-01 new-step add: something\n`);
  assert.equal(changed(f), false, 'a ## Drift line');
  fs.writeFileSync(planPath(f), text(f).replace('<!-- crew-plan state:final -->', '<!-- crew-plan state:final  -->'));
  assert.equal(changed(f), false, 'the state line');
  fs.writeFileSync(planPath(f), text(f).replace(/ <!-- id:n1[^>]*-->/, ''));
  assert.equal(changed(f), false, 'a step without its id comment (an id is assigned later)');
  const r = pre(f, H.agentPayload(f, t1));
  assert.notEqual(decision(r), 'deny', r.out);
  assert.equal(evs(f, 'plan.drift_denied', 'plan.drift_unasked', 'plan.check_failed').length, 0);
});

// ---------------------------------------------------------------- new step
test('plan add on a final plan: block refuses with the exact command, nothing changes', () => {
  const f = fixture('block');
  finalPlan(f);
  const before = text(f);
  const r = run(f, ['plan', 'add', 'p', 'A new step']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /Plan p/);
  assert.match(r.err, /crew plan drift p --kind new-step --detail "\.\.\."/);
  assert.equal(text(f), before);
  assert.equal(evs(f, 'plan.node_added').length, 1, 'only the first step of finalPlan');
});

test('plan add on a final plan: remind goes through with a warning and plan.drift_unasked; off goes through silently', () => {
  const a = fixture('remind');
  finalPlan(a);
  const r = run(a, ['plan', 'add', 'p', 'A new step']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out + r.err, /without asking/);
  assert.match(text(a), /A new step/);
  const ev = evs(a, 'plan.drift_unasked');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.kind, 'new-step');
  const b = fixture('off');
  finalPlan(b);
  const r2 = run(b, ['plan', 'add', 'p', 'A new step']);
  assert.equal(r2.code, 0, r2.err);
  assert.doesNotMatch(r2.out + r2.err, /without asking/);
  assert.equal(evs(b, 'plan.drift_unasked').length, 0);
});

test('plan add when new-step was answered since the last user message: goes through and approves the new step; a user message ends the cover', () => {
  const f = fixture('block');
  finalPlan(f);
  answerKind(f, 'new-step', 'defer', 'later');
  const r = run(f, ['plan', 'add', 'p', 'A new step']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f), /A new step/);
  assert.equal(changed(f), false, 'does not raise changed-text later');
  const t = H.newTask(f);
  assert.equal(run(f, ['plan', 'link', 'p', 'n1', t.id]).code, 0);
  assert.notEqual(decision(pre(f, H.agentPayload(f, t))), 'deny');
  H.prompt(f);
  const r2 = run(f, ['plan', 'add', 'p', 'Another']);
  assert.equal(r2.code, 1, 'a user message came: asked again');
});

test('plan add: a different kind answered does not cover a new step', () => {
  const f = fixture('block');
  finalPlan(f);
  answerKind(f, 'changed-text', 'defer', 'later');
  assert.equal(run(f, ['plan', 'add', 'p', 'A new step']).code, 1);
});

test('plan add --proposed, and draft and legacy plans: never asked; the proposal does not raise until accepted', () => {
  const f = fixture('block');
  finalPlan(f);
  assert.equal(run(f, ['plan', 'add', 'p', 'Proposed one', '--proposed']).code, 0);
  assert.equal(changed(f), false);
  const g = fixture('block');
  assert.equal(run(g, ['plan', 'new', 'd', '--title', 'D']).code, 0);
  assert.equal(run(g, ['plan', 'add', 'd', 'step']).code, 0, 'draft');
  fs.writeFileSync(planPath(g, 'l'), '# Legacy\n\n- [ ] step\n');
  assert.equal(run(g, ['plan', 'add', 'l', 'more']).code, 0, 'legacy');
});

test('plan accept of a proposed step on a final plan: block refuses (nothing changes), remind warns, off is silent; covered goes through', () => {
  for (const mode of MODES) {
    const f = fixture(mode);
    finalPlan(f);
    assert.equal(run(f, ['plan', 'add', 'p', 'Proposed one', '--proposed']).code, 0);
    const before = text(f);
    const r = run(f, ['plan', 'accept', 'p', 'n2']);
    if (mode === 'block') {
      assert.equal(r.code, 1, r.out);
      assert.match(r.err, /crew plan drift p --kind new-step/);
      assert.equal(text(f), before);
      answerKind(f, 'new-step', 'defer', 'ok');
      const r2 = run(f, ['plan', 'accept', 'p', 'n2']);
      assert.equal(r2.code, 0, r2.err);
      assert.equal(changed(f), false);
    } else {
      assert.equal(r.code, 0, r.err);
      assert.match(text(f), /\[ \] Proposed one/);
      assert.equal(/without asking/.test(r.out + r.err), mode === 'remind');
      assert.equal(evs(f, 'plan.drift_unasked').length, mode === 'remind' ? 1 : 0);
    }
  }
});

test('plan set accept of a plain [?] step on a final plan: block refuses (nothing changes), remind warns, off is silent; covered goes through and approves', () => {
  for (const mode of MODES) {
    const f = fixture(mode);
    finalPlan(f);
    assert.equal(run(f, ['plan', 'add', 'p', 'Proposed one', '--proposed']).code, 0);
    const before = text(f);
    const r = run(f, ['plan', 'set', 'p', 'n2', 'accept']);
    if (mode === 'block') {
      assert.equal(r.code, 1, r.out);
      assert.match(r.err, /crew plan drift p --kind new-step/);
      assert.equal(text(f), before);
      answerKind(f, 'new-step', 'defer', 'ok');
      const r2 = run(f, ['plan', 'set', 'p', 'n2', 'accept']);
      assert.equal(r2.code, 0, r2.err);
      assert.match(text(f), /\[ \] Proposed one/);
      assert.equal(changed(f), false);
    } else {
      assert.equal(r.code, 0, r.err);
      assert.match(text(f), /\[ \] Proposed one/);
      assert.equal(/without asking/.test(r.out + r.err), mode === 'remind');
      assert.equal(evs(f, 'plan.drift_unasked').length, mode === 'remind' ? 1 : 0);
    }
  }
});

test('plan add with a bad --under on a final plan under remind: the add fails and no plan.drift_unasked is recorded', () => {
  const f = fixture('remind');
  finalPlan(f);
  const r = run(f, ['plan', 'add', 'p', 'A new step', '--under', 'n99']);
  assert.notEqual(r.code, 0);
  assert.equal(evs(f, 'plan.drift_unasked').length, 0);
  const ok = run(f, ['plan', 'add', 'p', 'A new step']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(evs(f, 'plan.drift_unasked').length, 1);
});

// ---------------------------------------------------------------- changed text: Agent and SendMessage
test('Agent dispatch on a final plan whose text changed: block denies and the task stays created; remind warns; off passes; matching plan passes', () => {
  for (const mode of MODES) {
    const { f, task } = linked(mode);
    const ok = pre(f, H.agentPayload(f, task));
    assert.notEqual(decision(ok), 'deny', 'unchanged plan');
    assert.equal(tasks.load(f.pid, task.id).state, 'dispatched');
    const t2 = H.newTask(f, 'Second');
    assert.equal(run(f, ['plan', 'link', 'p', 'n1', t2.id]).code, 0);
    edit(f, 'Write the code', 'Write different code');
    const r = pre(f, H.agentPayload(f, t2));
    if (mode === 'block') {
      assert.equal(decision(r), 'deny', r.out);
      assert.match(reason(r), /plan p/);
      assert.match(reason(r), /plan drift p --kind changed-text/);
      assert.equal(tasks.load(f.pid, t2.id).state, 'created');
      assert.equal(evs(f, 'plan.drift_denied').length, 1);
    } else {
      assert.notEqual(decision(r), 'deny', r.out);
      assert.equal(tasks.load(f.pid, t2.id).state, 'dispatched');
      assert.equal(evs(f, 'plan.drift_unasked').length, mode === 'remind' ? 1 : 0);
      assert.equal(/plan drift p --kind changed-text/.test(context(r)), mode === 'remind');
    }
  }
});

test('a changed goal or part also raises changed-text; answering clears it', () => {
  for (const [from, to] of [['Ship it', 'Ship it now'], ['No rewrite', 'Rewrite all'], ['Tests pass', 'Tests are fine']]) {
    const { f, task } = linked('block');
    edit(f, from, to);
    assert.equal(decision(pre(f, H.agentPayload(f, task))), 'deny', from);
    answerKind(f, 'changed-text', 'defer', 'ok');
    assert.notEqual(decision(pre(f, H.agentPayload(f, task))), 'deny', `after the answer: ${from}`);
  }
});

function stoppedWorker(f, task) {
  tasks.transition(f.pid, task.id, 'dispatched');
  sess.remember(f.pid, `tu-${task.id}`, { task: task.id, type: 'crew-worker', bg: true, worker: true, ts: Date.now(), agent: 'ag-1', stopped: true, session: f.sid });
}
const send = (f) => H.base(f, { tool_name: 'SendMessage', tool_use_id: 'tu-s', tool_input: { to: 'ag-1', message: 'go' } });

test('SendMessage waking a worker on a changed final plan: block denies, remind warns, off passes; unchanged passes untouched', () => {
  for (const mode of MODES) {
    const { f, task } = linked(mode);
    stoppedWorker(f, task);
    edit(f, 'Write the code', 'Write different code');
    const r = pre(f, send(f));
    if (mode === 'block') {
      assert.equal(decision(r), 'deny', r.out);
      assert.equal(sess.byAgent(f.pid, 'ag-1').stopped, true);
    } else {
      assert.notEqual(decision(r), 'deny');
      assert.equal(/changed-text/.test(context(r)), mode === 'remind');
    }
  }
  const { f, task } = linked('block');
  stoppedWorker(f, task);
  assert.equal(pre(f, send(f)).out, '{}');
});

test('a plan finalized before approved was kept: the first check stores the current hash and raises nothing; a later change raises', () => {
  const { f, task } = linked('block');
  plans.writeRecord(f.pid, 'p', { approved: undefined });
  assert.equal(rec(f).approved, undefined);
  const r = pre(f, H.agentPayload(f, task));
  assert.notEqual(decision(r), 'deny', r.out);
  assert.equal(rec(f).approved, plans.approvedHash(text(f)));
  const t2 = H.newTask(f, 'Second');
  assert.equal(run(f, ['plan', 'link', 'p', 'n1', t2.id]).code, 0);
  edit(f, 'Write the code', 'Write different code');
  assert.equal(decision(pre(f, H.agentPayload(f, t2))), 'deny');
});

test('a failure of the check lets the dispatch through and records plan.check_failed', () => {
  const { f, task } = linked('block');
  edit(f, 'Write the code', 'Write different code');
  const orig = plans.changedPlanOfTask;
  plans.changedPlanOfTask = () => { throw new Error('disk gone'); };
  let out;
  try { out = require('../lib/hooks/pre-tool-use').run(H.agentPayload(f, task)); } finally { plans.changedPlanOfTask = orig; }
  assert.ok(!out || out.hookSpecificOutput.permissionDecision !== 'deny');
  assert.equal(tasks.load(f.pid, task.id).state, 'dispatched');
  assert.equal(H.evs(f, ['plan.check_failed']).length, 1);
});

// ---------------------------------------------------------------- task accept
function reviewing(f, task) {
  for (const s of ['dispatched', 'returned', 'reviewing']) tasks.transition(f.pid, task.id, s);
}
test('crew task accept on a changed final plan: block refuses and the task stays reviewing; remind warns and accepts; off accepts; unchanged accepts', () => {
  for (const mode of MODES) {
    const { f, task } = linked(mode);
    reviewing(f, task);
    edit(f, 'Write the code', 'Write different code');
    const r = run(f, ['task', 'accept', task.id]);
    if (mode === 'block') {
      assert.equal(r.code, 1, r.out);
      assert.match(r.err, /plan p/);
      assert.match(r.err, /plan drift p --kind changed-text/);
      assert.equal(tasks.load(f.pid, task.id).state, 'reviewing');
      answerKind(f, 'changed-text', 'defer', 'ok');
      assert.equal(run(f, ['task', 'accept', task.id]).code, 0);
    } else {
      assert.equal(r.code, 0, r.err);
      assert.equal(tasks.load(f.pid, task.id).state, 'accepted');
      assert.equal(/changed-text/.test(r.out + r.err), mode === 'remind');
    }
  }
  const { f, task } = linked('block');
  reviewing(f, task);
  assert.equal(run(f, ['task', 'accept', task.id]).code, 0, 'unchanged plan');
});

// ---------------------------------------------------------------- task run
const FAKE = [
  "const fs = require('fs');",
  'const a = process.argv.slice(2);',
  'const val = (x) => a[a.indexOf(x) + 1];',
  "fs.writeFileSync(process.env.FAKE_LOG, 'ran');",
  "fs.writeFileSync(require('path').join(val('-C'), 'made.txt'), 'x');",
  "const good = JSON.stringify({ changes: '- made.txt', tests: 'ok', assumptions: 'none', realenv: 'no' });",
  "fs.writeFileSync(val('-o'), good); console.log(good);",
].join('\n');
function fakeCodex() {
  const bin = h.tmpDir('crew-fakebin-');
  const script = path.join(bin, 'fake.js');
  fs.writeFileSync(script, FAKE);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n${FAKE}\n`, { mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.configFile()), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, engines: { codex: { command: 'codex', args: [] } } }));
  return { bin, log: path.join(bin, 'log.txt') };
}
const runEnv = (f, fc) => ({ ...f.env, PATH: `${fc.bin}${path.delimiter}${process.env.PATH || process.env.Path}`, FAKE_LOG: fc.log });
test('crew task run on a changed final plan: block refuses and starts nothing; remind warns and runs; off runs; unchanged runs', () => {
  for (const mode of MODES) {
    const { f, task } = linked(mode);
    const fc = fakeCodex();
    edit(f, 'Write the code', 'Write different code');
    const r = crew(['task', 'run', task.id], f.repo, runEnv(f, fc));
    if (mode === 'block') {
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /plan drift p --kind changed-text/);
      assert.equal(fs.existsSync(fc.log), false, 'no worker started');
      assert.equal(tasks.load(f.pid, task.id).state, 'created');
      assert.equal(evs(f, 'plan.drift_denied').length, 1);
    } else {
      assert.equal(r.code, 0, `${r.err} | ${r.out}`);
      assert.equal(fs.existsSync(fc.log), true);
      assert.equal(/changed-text/.test(r.err), mode === 'remind');
      assert.equal(evs(f, 'plan.drift_unasked').length, mode === 'remind' ? 1 : 0);
    }
  }
  const { f, task } = linked('block');
  const fc = fakeCodex();
  const r = crew(['task', 'run', task.id], f.repo, runEnv(f, fc));
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(fc.log), true, 'unchanged plan runs');
});
