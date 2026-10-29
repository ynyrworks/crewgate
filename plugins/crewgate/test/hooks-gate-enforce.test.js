'use strict';

// gates.enforce (remind | confirm | block) at PreToolUse(Bash), the gate.confirmed record after an allowed
// prompt, and the user-turn rule (an approval needs a user message between "gate ask" and "gate answer yes").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { makeRepo, crew } = require('./helpers');
const project = require('../lib/core/project');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const sess = require('../lib/hooks/session');

const fwd = (p) => p.split(path.sep).join('/');
const bash = (f, command, id, extra) => H.base(f, { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra });
const pre = (f, command, id, extra) => H.runHook('pre-tool-use', bash(f, command, id, extra), { cwd: f.repo });
const post = (f, command, id, extra) => H.runHook('post-tool-use', { ...bash(f, command, id, extra), tool_response: { stdout: '' } }, { cwd: f.repo });
const prompt = (f) => H.runHook('user-prompt-submit', H.base(f, { prompt: 'ok go' }), { cwd: f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const reason = (r) => r.json.hookSpecificOutput.permissionDecisionReason;
const missing = (pid) => events.read(pid, { types: 'gate.missing' });

function fixture(enforce, extra = {}) {
  const f = H.fixture({ config: { gates: { enforce, ...extra } } });
  H.start(f);
  return f;
}

// ask -> user message -> answer yes: a valid approval
function approve(f, gate = 'push') {
  const id = gates.ask(f.pid, {}, { gate }).id;
  prompt(f);
  gates.answer(f.pid, id, 'yes', 'ok');
}

test('remind (default or explicit): PreToolUse stays silent, PostToolUse records gate.missing as before', () => {
  for (const cfg of [null, 'remind']) {
    const f = cfg ? fixture(cfg) : (() => { const x = H.fixture(); H.start(x); return x; })();
    assert.equal(pre(f, 'git push origin main', 'r1').out, '{}');
    const r = post(f, 'git push origin main', 'r1');
    assert.match(r.json.hookSpecificOutput.additionalContext, /"push" gate is set to ask/);
    assert.equal(missing(f.pid).length, 1);
    assert.equal(events.read(f.pid, { types: ['gate.prompted', 'gate.blocked', 'gate.confirmed'] }).length, 0);
  }
});

test('confirm: unapproved push gets permissionDecision ask naming the command and the gate', () => {
  const f = fixture('confirm');
  const r = pre(f, 'git push origin feat/x', 'c1', { permission_mode: 'default' });
  assert.equal(decision(r), 'ask');
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(reason(r), /git push origin feat\/x/);
  assert.match(reason(r), /"push" step/);
  const ev = events.read(f.pid, { types: 'gate.prompted' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.gate, 'push');
  assert.equal(ev[0].data.permission_mode, 'default');
});

test('confirm: after the user allowed it, PostToolUse records gate.confirmed and no gate.missing', () => {
  const f = fixture('confirm');
  assert.equal(decision(pre(f, 'git push', 'c2')), 'ask');
  assert.equal(post(f, 'git push', 'c2').out, '{}');
  assert.equal(missing(f.pid).length, 0);
  const c = events.read(f.pid, { types: 'gate.confirmed' });
  assert.equal(c.length, 1);
  assert.equal(c[0].data.via, 'permission-prompt');
  // a push that was never put to the user (no PreToolUse seen) is still reported missing
  post(f, 'git push', 'c3');
  assert.equal(missing(f.pid).length, 1);
});

test('confirm: a PR and a merge are asked too; ordinary commands are not', () => {
  const f = fixture('confirm');
  assert.equal(decision(pre(f, 'gh pr create --fill', 'p1')), 'ask');
  assert.equal(decision(pre(f, 'git merge feat/y', 'p2')), 'ask');
  assert.equal(pre(f, 'git status && echo push', 'p3').out, '{}');
  assert.equal(pre(f, 'ls -la', 'p4').out, '{}');
});

test('confirm: an approval recorded after a user message lets the push through', () => {
  const f = fixture('confirm');
  approve(f);
  assert.equal(pre(f, 'git push', 'a1').out, '{}');
  assert.equal(post(f, 'git push', 'a1').out, '{}');
  assert.equal(missing(f.pid).length, 0);
  assert.equal(events.read(f.pid, { types: 'gate.confirmed' }).length, 0);
});

test('block: unapproved is denied with instructions, approved passes', () => {
  const f = fixture('block');
  const r = pre(f, 'git push origin main', 'b1');
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /gate ask push/);
  assert.match(reason(r), /gate answer/);
  assert.equal(events.read(f.pid, { types: 'gate.blocked' }).length, 1);
  approve(f);
  assert.equal(pre(f, 'git push origin main', 'b2').out, '{}');
});

test('a gate set to auto or never is not enforced; only ask is', () => {
  const f = fixture('block', { push: 'auto', merge: 'never' });
  assert.equal(pre(f, 'git push', 'm1').out, '{}');
  assert.equal(pre(f, 'git merge x', 'm2').out, '{}');
  assert.equal(decision(pre(f, 'gh pr create', 'm3')), 'deny');
});

test('one command with a push and a PR names both gates', () => {
  const f = fixture('confirm');
  const r = pre(f, 'git push && gh pr create --fill', 'x1');
  assert.equal(decision(r), 'ask');
  assert.match(reason(r), /"push"/);
  assert.match(reason(r), /"open_pr"/);
});

test('the target project decides: cd / git -C into a project with its own enforce mode', () => {
  const f = fixture('remind');
  const other = makeRepo();
  H.writeConfig(other, { gates: { enforce: 'block' } });
  const otherPid = project.add(other, { name: 'other' }).project.id;
  assert.equal(decision(pre(f, `cd ${fwd(other)} && git push`, 'o1')), 'deny');
  assert.equal(events.read(otherPid, { types: 'gate.blocked' }).length, 1);
  assert.equal(events.read(f.pid, { types: 'gate.blocked' }).length, 0);
  // an approval in the session project does not count for the target
  approve(f);
  assert.equal(decision(pre(f, `git -C ${fwd(other)} push`, 'o2')), 'deny');
  // the session project itself is remind: not enforced
  assert.equal(pre(f, 'git push', 'o3').out, '{}');
});

test('session project enforces, a cd into a remind project is not enforced', () => {
  const f = fixture('block');
  const other = makeRepo();
  project.add(other, { name: 'plain' });
  assert.equal(decision(pre(f, 'git push', 'q1')), 'deny');
  assert.equal(pre(f, `cd ${fwd(other)} && git push`, 'q2').out, '{}');
});

test('an unregistered target is never enforced', () => {
  const f = fixture('block');
  const stray = makeRepo();
  const before = project.list().length;
  assert.equal(pre(f, `cd ${fwd(stray)} && git push`, 'u1').out, '{}');
  assert.equal(pre(f, `git -C ${fwd(stray)} push`, 'u2').out, '{}');
  assert.equal(project.list().length, before);
});

test('Codex payload (turn_id) falls back to remind', () => {
  const f = fixture('block');
  assert.equal(pre(f, 'git push', 'k1', { turn_id: 'turn-1' }).out, '{}');
  const p = post(f, 'git push', 'k1', { turn_id: 'turn-1' });
  assert.match(p.json.hookSpecificOutput.additionalContext, /"push" gate/);
  assert.equal(missing(f.pid).length, 1);
});

test('hooks.json registers PreToolUse for Bash; the Codex table does not', () => {
  const dir = path.join(__dirname, '..', 'hooks');
  const claude = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')).hooks;
  const codex = JSON.parse(fs.readFileSync(path.join(dir, 'codex-hooks.json'), 'utf8')).hooks;
  assert.ok(claude.PreToolUse.some((g) => g.matcher === 'Bash'));
  assert.ok(!codex.PreToolUse.some((g) => g.matcher === 'Bash'));
});

// ---------------------------------------------------------------- user-turn rule
test('user-turn rule: an answer with no user message since the ask does not count (all modes)', () => {
  for (const mode of ['remind', 'confirm', 'block']) {
    const f = fixture(mode);
    const id = gates.ask(f.pid, {}, { gate: 'push' }).id;
    gates.answer(f.pid, id, 'yes', 'self-approved'); // no prompt in between
    if (mode === 'remind') {
      post(f, 'git push', 'n1');
      assert.equal(missing(f.pid).length, 1, mode);
    } else {
      assert.equal(decision(pre(f, 'git push', 'n1')), mode === 'block' ? 'deny' : 'ask', mode);
    }
  }
});

test('user-turn rule: a prompt before the ask does not help; one between ask and answer does', () => {
  const f = fixture('block');
  prompt(f);
  const a = gates.ask(f.pid, {}, { gate: 'push' }).id;
  gates.answer(f.pid, a, 'yes', '');
  assert.equal(decision(pre(f, 'git push', 'w1')), 'deny');
  const b = gates.ask(f.pid, {}, { gate: 'push' }).id;
  prompt(f);
  gates.answer(f.pid, b, 'yes', '');
  assert.equal(pre(f, 'git push', 'w2').out, '{}');
});

test('user-turn rule: gates.require_user_turn=false restores the old rule', () => {
  const f = fixture('block', { require_user_turn: false });
  gates.answer(f.pid, gates.ask(f.pid, {}, { gate: 'push' }).id, 'yes', '');
  assert.equal(pre(f, 'git push', 'z1').out, '{}');
  const g = fixture('remind', { require_user_turn: false });
  gates.answer(g.pid, gates.ask(g.pid, {}, { gate: 'push' }).id, 'yes', '');
  assert.equal(post(g, 'git push', 'z2').out, '{}');
});

test('user-turn rule: the automatic yes of an auto gate needs no user message', () => {
  const f = fixture('block', { push: 'auto', merge: 'ask' });
  gates.ask(f.pid, { gates: { push: 'auto' } }, { gate: 'push' });
  assert.equal(pre(f, 'git push', 'y1').out, '{}');
});

test('user-turn rule: hasApproval unit behaviour', () => {
  const f = H.fixture();
  const t0 = Date.now();
  const id = gates.ask(f.pid, {}, { gate: 'merge' }).id;
  const between = Date.now();
  gates.answer(f.pid, id, 'yes', '');
  const now = Date.now() + 5;
  assert.equal(gates.hasApproval(f.pid, 'merge', 's', now), true, 'old rule without opts');
  assert.equal(gates.hasApproval(f.pid, 'merge', 's', now, { requireUserTurn: true, prompts: [] }), false);
  assert.equal(gates.hasApproval(f.pid, 'merge', 's', now, { requireUserTurn: true, prompts: [t0 - 60000] }), false);
  assert.equal(gates.hasApproval(f.pid, 'merge', 's', now, { requireUserTurn: true, prompts: [between] }), true);
});

test('prompt times are kept without text', () => {
  const f = fixture('remind');
  for (let i = 0; i < 3; i++) prompt(f);
  const s = sess.read(f.sid);
  assert.equal(s.prompt_ts.length, 3);
  assert.ok(s.prompt_ts.every((t) => Number.isFinite(t)));
});

// ---------------------------------------------------------------- CLI
test('crew gate answer warns when no user message happened since the ask', () => {
  const f = fixture('confirm');
  const env = { CLAUDE_SESSION_ID: f.sid };
  const ask = gates.ask(f.pid, {}, { gate: 'push' });
  const r1 = crew(['gate', 'answer', ask.id, 'yes'], f.repo, env);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /will not count/);
  const ask2 = gates.ask(f.pid, {}, { gate: 'push' });
  prompt(f);
  const r2 = crew(['gate', 'answer', ask2.id, 'yes'], f.repo, env);
  assert.doesNotMatch(r2.out, /will not count/);
});

test('crew gate answer does not warn when require_user_turn is false', () => {
  const f = fixture('confirm', { require_user_turn: false });
  const ask = gates.ask(f.pid, {}, { gate: 'push' });
  const r = crew(['gate', 'answer', ask.id, 'yes'], f.repo, { CLAUDE_SESSION_ID: f.sid });
  assert.doesNotMatch(r.out, /will not count/);
});

test('crew doctor shows the enforce mode and the Codex fallback', () => {
  const f = fixture('confirm');
  const r = crew(['doctor'], f.repo);
  assert.match(r.out, /enforce confirm/);
  assert.match(r.out, /Codex sessions fall back to remind/);
});
