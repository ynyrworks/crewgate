'use strict';

// Approval gates that ask only when they add something: an approved plan covers the local merges of its accepted steps, a crew
// call that records an approval cannot share a command line with the action, and the "no approval recorded" reminder stops
// firing on approvals that are valid (late yes, scratch worktree, a yes used up by the action it approved).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { crew, git, tmpDir, GOOD_BRIEF } = require('./helpers');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const plans = require('../lib/core/plans');
const tasks = require('../lib/core/tasks');

const bash = (f, command, id, extra) => H.base(f, { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra });
const pre = (f, command, id, extra) => H.runHook('pre-tool-use', bash(f, command, id, extra), { cwd: extra && extra.cwd || f.repo });
const post = (f, command, id, extra) => H.runHook('post-tool-use', { ...bash(f, command, id, extra), tool_response: { stdout: '' } }, { cwd: extra && extra.cwd || f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const missing = (f) => events.read(f.pid, { types: 'gate.missing' });
const merges = (f) => events.read(f.pid, { types: 'git.merge' });
const run = (f, args) => crew(args, f.repo, { CLAUDE_CODE_SESSION_ID: f.sid });

function fixture(gatesCfg = {}) {
  const f = H.fixture({ config: { gates: gatesCfg } });
  H.start(f);
  return f;
}

// A task with a branch, walked to `state`.
function taskAt(f, branch, state = 'accepted', extra = {}) {
  const t = tasks.createTask(f.pid, { title: `Step ${branch}`, brief: GOOD_BRIEF, branch, ...extra });
  const walk = { dispatched: ['dispatched'], returned: ['dispatched', 'returned'], accepted: ['dispatched', 'returned', 'accepted'], merged: ['dispatched', 'returned', 'accepted', 'merged'] }[state] || [];
  for (const s of walk) tasks.transition(f.pid, t.id, s, {});
  return t;
}

// A final plan (the user approved it through the gate) whose one step links the task.
function finalPlanOf(f, taskId, slug = 'p') {
  assert.equal(run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']).code, 0);
  const add = JSON.parse(run(f, ['--json', 'plan', 'add', slug, 'Write the code']).out);
  assert.equal(run(f, ['plan', 'link', slug, add.id || add.node || (add.data && add.data.id), taskId]).code, 0);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', slug]).out);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(plans.stateOf(f.repo, f.pid, slug), 'final');
  return slug;
}

// ---------------------------------------------------------------- 1. plan-scoped merge approval
test('plan cover: a local merge of an accepted task of a final plan is approved, recorded with the plan, under every enforce mode', () => {
  for (const enforce of ['remind', 'confirm', 'block']) {
    const f = fixture({ enforce });
    const t = taskAt(f, 'feat/s1');
    const slug = finalPlanOf(f, t.id);
    assert.equal(pre(f, 'git merge feat/s1', 'm1').out, '{}', enforce);
    const r = post(f, 'git merge feat/s1', 'm1');
    assert.equal(r.out, '{}', enforce);
    assert.equal(missing(f).length, 0);
    const e = merges(f);
    assert.equal(e.length, 1);
    assert.equal(e[0].data.approved_by, `plan:${slug}`);
    // the cover is not used up: the same merge into another branch is covered again
    assert.equal(post(f, 'git merge feat/s1', 'm2').out, '{}');
    assert.equal(missing(f).length, 0);
  }
});

test('plan cover: not for a push, a PR, an unaccepted task, a branch of no task, a closed plan, a mixed merge or when switched off', () => {
  const f = fixture({ enforce: 'block' });
  const t = taskAt(f, 'feat/s1');
  const open = taskAt(f, 'feat/s2', 'returned');
  const slug = finalPlanOf(f, t.id);
  assert.equal(pre(f, 'git merge feat/s1', 'a0').out, '{}', 'control: covered');
  assert.equal(decision(pre(f, 'git push origin feat/s1', 'a1')), 'deny', 'push');
  assert.equal(decision(pre(f, 'gh pr create --head feat/s1', 'a2')), 'deny', 'PR');
  assert.equal(decision(pre(f, 'gh pr merge 12', 'a3')), 'deny', 'remote merge');
  assert.equal(decision(pre(f, 'git merge feat/other', 'a4')), 'deny', 'no task');
  assert.equal(decision(pre(f, 'git merge feat/s1 feat/other', 'a5')), 'deny', 'one branch not covered');
  assert.equal(decision(pre(f, 'git merge $B', 'a6')), 'deny', 'unknown branch');
  // an unaccepted task of a final plan: link it to a second plan
  const slug2 = finalPlanOf(f, open.id, 'q');
  assert.ok(slug2);
  assert.equal(decision(pre(f, 'git merge feat/s2', 'a7')), 'deny', 'task not accepted');
  tasks.transition(f.pid, open.id, 'accepted', {});
  assert.equal(pre(f, 'git merge feat/s2', 'a8').out, '{}', 'accepted now');
  // closed plan
  plans.writeRecord(f.pid, slug, { state: 'done' });
  assert.equal(decision(pre(f, 'git merge feat/s1', 'a9')), 'deny', 'plan closed');
  // remind: the reminder comes back
  const r = fixture({ enforce: 'remind', plan_covers_merge: false });
  const t2 = taskAt(r, 'feat/s1');
  finalPlanOf(r, t2.id);
  assert.match(post(r, 'git merge feat/s1', 'b1').json.hookSpecificOutput.additionalContext, /"merge" gate/);
  assert.equal(merges(r)[0].data.approved_by, undefined);
});

test('plan cover: a plan that is still a draft covers nothing', () => {
  const f = fixture({ enforce: 'block' });
  const t = taskAt(f, 'feat/s1');
  assert.equal(run(f, ['plan', 'new', 'd', '--title', 'D', '--goal', 'g']).code, 0);
  const add = JSON.parse(run(f, ['--json', 'plan', 'add', 'd', 'step']).out);
  assert.equal(run(f, ['plan', 'link', 'd', add.id || add.node || (add.data && add.data.id), t.id]).code, 0);
  assert.equal(decision(pre(f, 'git merge feat/s1', 'd1')), 'deny');
});

// ---------------------------------------------------------------- 2. no chaining with an approval call
test('chained: a merge or push in the same command as a crew call that records an approval is denied before it runs, in every mode', () => {
  const cmds = [
    'node "/x/bin/crew.js" gate answer g-1 yes && git merge feat/x',
    'crew gate answer g-1 yes; git push origin main',
    'crew task accept t-1\ngit merge feat/x',
    'crew gate answer g-1 yes | cat && git merge feat/x',
    'crew plan finalize p --gate g-1 || git push',
    'crew plan drift p --gate g-1 && git merge feat/x',
    'git merge feat/x && crew gate answer g-1 yes',
    'bash -c "crew gate answer g-1 yes && git merge feat/x"',
  ];
  for (const enforce of ['remind', 'confirm', 'block']) {
    const f = fixture({ enforce });
    cmds.forEach((c, i) => {
      const r = pre(f, c, `c${i}`);
      assert.equal(decision(r), 'deny', `${enforce}: ${c}`);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /alone, read its result/);
    });
    // each of the two on its own is untouched by this rule
    assert.equal(pre(f, 'crew gate answer g-1 yes', 'x1').out, '{}');
    assert.equal(pre(f, 'crew task accept t-1 && crew task merge t-1', 'x2').out, '{}');
    assert.equal(pre(f, 'crew gate ask merge --task t-1 && echo git merge', 'x3').out, '{}');
    if (enforce === 'remind') assert.equal(pre(f, 'git merge feat/x', 'x4').out, '{}');
  }
});

test('chained: a gate that is auto is not held back, a plan-covered merge chained with an approval call still is', () => {
  const f = fixture({ merge: 'auto' });
  assert.equal(pre(f, 'crew gate answer g-1 yes && git merge feat/x', 'y1').out, '{}');
  const g = fixture({ enforce: 'remind' });
  const t = taskAt(g, 'feat/s1');
  finalPlanOf(g, t.id);
  assert.equal(decision(pre(g, 'crew task accept t-9 && git merge feat/s1', 'y2')), 'deny');
});

// ---------------------------------------------------------------- 3a. a late yes still counts, within a bound
test('late yes: an approval used after the 30 minutes counts while it is the latest and unused, up to the age bound', () => {
  const f = fixture();
  const id = H.approve(f, { gate: 'push' });
  const w = gates.ANSWER_WINDOW_MS;
  const ok = (ms) => gates.hasApproval(f.pid, 'push', f.sid, Date.now() + ms, { requireUserTurn: true });
  assert.equal(ok(0), true);
  assert.equal(ok(w + 60000), true, 'used 31 minutes after the answer');
  assert.equal(ok(gates.APPROVAL_MAX_AGE_MS - 60000), true);
  assert.equal(ok(gates.APPROVAL_MAX_AGE_MS + 60000), false, 'days-old yes never counts');
  // a later "no" for the same gate and task takes it back, a newer yes of another task does not
  const n = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid });
  gates.answer(f.pid, n.id, 'no', '', { session: f.sid });
  assert.equal(ok(0), false, 'a later no');
  assert.ok(id);
});

test('late yes: past the 30 minutes only the latest answer of the gate and task counts', () => {
  const f = fixture();
  H.approve(f, { gate: 'push' });
  H.approve(f, { gate: 'push' });
  const ok = (ms) => gates.hasApproval(f.pid, 'push', f.sid, Date.now() + ms, { requireUserTurn: true });
  assert.equal(ok(0), true);
  assert.equal(ok(gates.ANSWER_WINDOW_MS + 60000), true, 'the newer one is still the latest');
});

test('late yes: the reminder hook accepts a yes that was used 40 minutes after it was given (hook sees the same rule)', () => {
  const f = fixture();
  const id = H.approve(f, { gate: 'merge' });
  // age the answer by rewriting its time in the log
  const file = require('../lib/core/paths').eventsFile(f.pid);
  const old = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').map((l) => {
    if (!l) return l;
    const e = JSON.parse(l);
    if (e.type === 'gate.answered' && e.data.id === id) e.ts = old;
    return JSON.stringify(e);
  }).join('\n'));
  assert.equal(post(f, 'git merge feat/x', 'l1').out, '{}');
  assert.equal(missing(f).length, 0);
});

// ---------------------------------------------------------------- 3b. a merge outside the project's own work trees
test('scratch worktree: a git merge in a linked worktree that is no task worktree records and reminds nothing; a task worktree does', () => {
  const f = fixture({ enforce: 'block' });
  const scratch = path.join(tmpDir('crew-scratch-'), 'wt');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'scratch', scratch);
  assert.equal(pre(f, 'git merge feat/x', 's1', { cwd: scratch }).out, '{}');
  assert.equal(post(f, 'git merge feat/x', 's1', { cwd: scratch }).out, '{}');
  assert.equal(merges(f).length, 0);
  assert.equal(missing(f).length, 0);
  assert.equal(pre(f, `cd "${scratch.replace(/\\/g, '/')}" && git merge feat/x`, 's2').out, '{}', 'cd into it');
  // the main checkout is still gated, and so is a task worktree
  assert.equal(decision(pre(f, 'git merge feat/x', 's3')), 'deny');
  const own = path.join(tmpDir('crew-taskwt-'), 'wt');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'feat/own', own);
  taskAt(f, 'feat/own', 'dispatched', { worktree: own });
  assert.equal(decision(pre(f, 'git merge feat/x', 's4', { cwd: own })), 'deny');
});

test('not a project: a merge in a directory that belongs to no registered project records and reminds nothing', () => {
  const f = fixture({ enforce: 'block' });
  const other = tmpDir('crew-other-');
  git(other, 'init', '-q');
  const o = other.replace(/\\/g, '/');
  assert.equal(pre(f, `cd "${o}" && git merge feat/x`, 'o1').out, '{}');
  assert.equal(post(f, `cd "${o}" && git merge feat/x`, 'o1').out, '{}');
  assert.equal(merges(f).length, 0);
  assert.equal(missing(f).length, 0);
});

// ---------------------------------------------------------------- 3c. a yes is used up
test('used up: one yes covers one push; the second push reminds again, and a new yes covers the next one', () => {
  const f = fixture();
  const id = H.approve(f, { gate: 'push' });
  assert.equal(post(f, 'git push origin main', 'u1').out, '{}');
  const e = events.read(f.pid, { types: 'git.push' });
  assert.equal(e[0].data.approved_by, `gate:${id}`);
  assert.match(post(f, 'git push origin main', 'u2').json.hookSpecificOutput.additionalContext, /"push" gate/);
  assert.equal(missing(f).length, 1);
  H.approve(f, { gate: 'push' });
  assert.equal(post(f, 'git push origin main', 'u3').out, '{}');
  assert.equal(missing(f).length, 1);
});

test('used up: the confirm and block checks before the command see a used yes as gone', () => {
  const f = fixture({ enforce: 'block' });
  H.approve(f, { gate: 'merge' });
  assert.equal(pre(f, 'git merge feat/x', 'v1').out, '{}');
  assert.equal(post(f, 'git merge feat/x', 'v1').out, '{}');
  assert.equal(decision(pre(f, 'git merge feat/x', 'v2')), 'deny');
});

test('used up: a yes of one gate does not cover another, and a chained pair of pushes uses one yes', () => {
  const f = fixture();
  H.approve(f, { gate: 'push' });
  assert.match(post(f, 'git merge feat/x', 'w1').json.hookSpecificOutput.additionalContext, /"merge" gate/);
  // one yes covers one of the two pushes; the other one is reminded
  assert.match(post(f, 'git push a && git push b', 'w2').json.hookSpecificOutput.additionalContext, /"push" gate/);
  assert.equal(events.read(f.pid, { types: 'git.push' }).filter((e) => e.data.approved_by).length, 1);
});

// ---------------------------------------------------------------- 4. crew task merge gives the same reminder
function mergedTaskRepo(f, branch = 'feat/s1') {
  git(f.repo, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-q', '-m', 'step');
  git(f.repo, 'checkout', '-q', '-');
  git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge step', branch);
}

test('crew task merge: prints the hook reminder when the merge it records had no approval and no plan cover', () => {
  const f = fixture();
  const t = taskAt(f, 'feat/s1');
  mergedTaskRepo(f);
  const r = run(f, ['task', 'merge', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /"merge" gate is set to ask and no unused approved answer was recorded/);
  assert.equal(merges(f)[0].data.approved_by, undefined);
});

test('crew task merge: quiet with a plan cover or an unused yes, and the yes is used up', () => {
  const f = fixture();
  const t = taskAt(f, 'feat/s1');
  finalPlanOf(f, t.id);
  mergedTaskRepo(f);
  const r = run(f, ['task', 'merge', t.id]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /gate is set to ask/);
  assert.equal(merges(f)[0].data.approved_by, 'plan:p');

  const g = fixture();
  const t2 = taskAt(g, 'feat/s1');
  mergedTaskRepo(g);
  const id = approveFor(g, 'merge', t2.id); // a yes is tied to its task
  const r2 = run(g, ['task', 'merge', t2.id]);
  assert.doesNotMatch(r2.out, /gate is set to ask/);
  assert.equal(merges(g)[0].data.approved_by, `gate:${id}`);
});

// ---------------------------------------------------------------- round 2
// A yes asked for `task` (or for none), answered by the user in this session.
function approveFor(f, gate, task) {
  const id = gates.ask(f.pid, {}, { gate, task }, { session: f.sid }).id;
  H.prompt(f);
  const sess = require('../lib/hooks/session');
  const s = sess.read(f.sid);
  gates.answer(f.pid, id, 'yes', 'ok', { session: f.sid, prompts: s && Array.isArray(s.prompt_ts) ? s.prompt_ts : [] });
  return id;
}

test('session worktree: a merge in the own linked worktree of the session is gated; a detached HEAD or a throwaway branch is not', () => {
  const f = fixture({ enforce: 'block' });
  const wt = path.join(tmpDir('crew-sesswt-'), 'wt');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'harness/work', wt);
  // throwaway: no commit of its own
  assert.equal(pre(f, 'git merge feat/x', 'k1', { cwd: wt }).out, '{}');
  // real work on the branch: the merge moves a branch that matters
  fs.writeFileSync(path.join(wt, 'own.txt'), 'x');
  git(wt, 'add', 'own.txt');
  git(wt, 'commit', '-q', '-m', 'own work');
  assert.equal(decision(pre(f, 'git merge feat/x', 'k2', { cwd: wt })), 'deny');
  const r = post(f, 'git merge feat/x', 'k2', { cwd: wt });
  assert.match(r.json.hookSpecificOutput.additionalContext, /"merge" gate/);
  assert.equal(merges(f).length, 1);
  // detached HEAD is ignored
  const det = path.join(tmpDir('crew-detwt-'), 'wt');
  git(f.repo, 'worktree', 'add', '-q', '--detach', det);
  assert.equal(pre(f, 'git merge feat/x', 'k3', { cwd: det }).out, '{}');
  assert.equal(post(f, 'git merge feat/x', 'k3', { cwd: det }).out, '{}');
  assert.equal(merges(f).length, 1);
});

test('one yes per action: two pushes in one command with one yes leave the second missing, in both hooks', () => {
  const f = fixture({ enforce: 'block' });
  H.approve(f, { gate: 'push' });
  assert.equal(decision(pre(f, 'git push a && git push b', 'x1')), 'deny');
  assert.equal(pre(f, 'git push a', 'x2').out, '{}');
  const g = fixture();
  H.approve(g, { gate: 'push' });
  assert.match(post(g, 'git push a && git push b', 'x3').json.hookSpecificOutput.additionalContext, /"push" gate/);
  H.approve(g, { gate: 'push' });
  H.approve(g, { gate: 'push' });
  assert.equal(post(g, 'git push a && git push b', 'x4').out, '{}');
  assert.equal(events.read(g.pid, { types: 'git.push' }).filter((e) => e.data.approved_by).length, 3);
});

test('a yes belongs to its task: a yes for another task does not cover a merge or push of a task branch; its own task and a task-less yes do', () => {
  const f = fixture({ enforce: 'block' });
  const t1 = taskAt(f, 'feat/t1', 'accepted');
  const t2 = taskAt(f, 'feat/t2', 'accepted');
  approveFor(f, 'merge', t2.id);
  assert.equal(decision(pre(f, 'git merge feat/t1', 'y1')), 'deny');
  assert.match(post(f, 'git merge feat/t1', 'y1').json.hookSpecificOutput.additionalContext, /"merge" gate/);
  assert.equal(pre(f, 'git merge feat/t2', 'y2').out, '{}');
  assert.equal(post(f, 'git merge feat/t2', 'y2').out, '{}');
  assert.equal(merges(f).filter((e) => e.data.approved_by).length, 1);
  // a yes with no task covers an action with no task
  const g = fixture({ enforce: 'block' });
  approveFor(g, 'merge');
  assert.equal(pre(g, 'git merge feat/other', 'y3').out, '{}');
  // a task-less yes covers a task-branch merge, once
  const h = fixture({ enforce: 'block' });
  taskAt(h, 'feat/t1', 'accepted');
  approveFor(h, 'merge');
  assert.equal(pre(h, 'git merge feat/t1', 'y4').out, '{}');
  assert.equal(post(h, 'git merge feat/t1', 'y4').out, '{}');
  assert.equal(decision(pre(h, 'git merge feat/t1', 'y5')), 'deny');
  // ... and a task-branch push; a yes for another task does not
  const p = fixture({ enforce: 'block' });
  taskAt(p, 'feat/t1', 'accepted');
  const o = taskAt(p, 'feat/t2', 'accepted');
  approveFor(p, 'push', o.id);
  assert.equal(decision(pre(p, 'git push origin feat/t1', 'y6')), 'deny');
  approveFor(p, 'push');
  assert.equal(pre(p, 'git push origin feat/t1', 'y7').out, '{}');
});
