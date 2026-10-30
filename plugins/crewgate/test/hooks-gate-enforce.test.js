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

// ask -> user message -> answer yes (same session): a valid approval
const approve = (f, gate = 'push') => H.approve(f, { gate });

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
    H.approve(f, { userMessage: false }); // ask and answer with no user message in between
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
  H.approve(f, { userMessage: false });
  assert.equal(decision(pre(f, 'git push', 'w1')), 'deny');
  H.approve(f);
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

test('user-turn rule: the verdict is stored on gate.answered and hasApproval reads only that', () => {
  const f = H.fixture();
  H.start(f);
  H.approve(f, { gate: 'merge', userMessage: false });
  const bad = events.read(f.pid, { types: 'gate.answered' }).pop();
  assert.equal(bad.data.user_turn, false);
  assert.equal(bad.data.ask_session, f.sid);
  assert.equal(gates.hasApproval(f.pid, 'merge', f.sid, Date.now(), { requireUserTurn: true }), false);
  assert.equal(gates.hasApproval(f.pid, 'merge', f.sid), true, 'old rule without opts');
  H.approve(f, { gate: 'merge' });
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).pop().data.user_turn, true);
  assert.equal(gates.hasApproval(f.pid, 'merge', f.sid, Date.now(), { requireUserTurn: true }), true);
});

test('user-turn rule: an answer from another session than the ask does not count', () => {
  const f = fixture('block');
  const id = gates.ask(f.pid, {}, { gate: 'push' }, { session: 'sess-other' }).id;
  prompt(f);
  gates.answer(f.pid, id, 'yes', '', { session: f.sid, prompts: sess.read(f.sid).prompt_ts });
  assert.equal(events.read(f.pid, { types: 'gate.answered' })[0].data.user_turn, false);
  assert.equal(decision(pre(f, 'git push', 'ss1')), 'deny');
});

test('user-turn rule: one session known, the other not -> a prompt of the known session counts', () => {
  const f = fixture('block');
  const promptsOf = (id) => (sess.read(id) || {}).prompt_ts || [];
  // ask with a session, answer without
  const a1 = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  assert.equal(gates.answer(f.pid, a1, 'yes', '', { promptsOf, prompts: [] }).user_turn, false, 'no prompt yet');
  const a2 = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid }).id;
  prompt(f);
  assert.equal(gates.answer(f.pid, a2, 'yes', '', { promptsOf, prompts: [] }).user_turn, true);
  // ask without a session, answer with one
  const a3 = gates.ask(f.pid, {}, { gate: 'push' }).id;
  assert.equal(gates.answer(f.pid, a3, 'yes', '', { session: f.sid, prompts: promptsOf(f.sid), promptsOf }).user_turn, false);
  const a4 = gates.ask(f.pid, {}, { gate: 'push' }).id;
  prompt(f);
  assert.equal(gates.answer(f.pid, a4, 'yes', '', { session: f.sid, prompts: promptsOf(f.sid), promptsOf }).user_turn, true);
});

test('user-turn rule: neither session known (Codex CLI) -> any prompt of the project counts, recorded as "project"', () => {
  const f = fixture('block');
  const opts = { projectPrompts: () => sess.promptsOfProject(f.pid) };
  const a1 = gates.ask(f.pid, {}, { gate: 'push' }).id;
  assert.equal(gates.answer(f.pid, a1, 'yes', '', opts).user_turn, false);
  assert.equal(decision(pre(f, 'git push', 'cx0')), 'deny');
  const a2 = gates.ask(f.pid, {}, { gate: 'push' }).id;
  prompt(f);
  assert.equal(gates.answer(f.pid, a2, 'yes', '', opts).user_turn, 'project');
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).pop().data.user_turn, 'project');
  assert.equal(pre(f, 'git push', 'cx1').out, '{}');
});

test('session id helper: CLAUDE_CODE_SESSION_ID first, CLAUDE_SESSION_ID as fallback, nothing else', () => {
  assert.equal(gates.currentSession({ CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_SESSION_ID: 'b' }), 'a');
  assert.equal(gates.currentSession({ CLAUDE_SESSION_ID: 'b' }), 'b');
  assert.equal(gates.currentSession({ CLAUDE_CODE_HOST_SESSION_ID: 'h' }), undefined);
  assert.equal(gates.currentSession({}), undefined);
});

test('CLI: gate ask / answer take the session from CLAUDE_CODE_SESSION_ID; without any, the project-wide fallback applies', () => {
  const f = fixture('block');
  const env = { CLAUDE_CODE_SESSION_ID: f.sid };
  const ask = JSON.parse(crew(['--json', 'gate', 'ask', 'push'], f.repo, env).out);
  prompt(f);
  const ans = crew(['--json', 'gate', 'answer', ask.id, 'yes'], f.repo, env);
  assert.equal(ans.code, 0, ans.err);
  const ev = events.read(f.pid, { types: ['gate.asked', 'gate.answered'] });
  assert.equal(ev[0].session, f.sid);
  assert.equal(ev[1].session, f.sid);
  assert.equal(ev[1].data.user_turn, true);
  assert.equal(pre(f, 'git push', 'ce1').out, '{}');
  // no id at all (Codex): project-wide
  const g = fixture('block');
  const ask2 = JSON.parse(crew(['--json', 'gate', 'ask', 'push'], g.repo, { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' }).out);
  prompt(g);
  crew(['gate', 'answer', ask2.id, 'yes'], g.repo, { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' });
  assert.equal(events.read(g.pid, { types: 'gate.answered' }).pop().data.user_turn, 'project');
});

test('user-turn rule: many later prompts do not evict the evidence', () => {
  const f = fixture('block');
  H.approve(f);
  assert.equal(pre(f, 'git push', 'ev0').out, '{}');
  for (let i = 0; i < 25; i++) prompt(f);
  assert.equal(pre(f, 'git push', 'ev1').out, '{}');
});

test('user-turn rule: the ask is found by id however old it is', () => {
  const f = H.fixture();
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const line = { v: 1, ts: old, id: 'abcdef0123456789', type: 'gate.asked', src: 'cli', session: 'sx', task: '', agent: '', data: { id: 'g-old001', gate: 'push', mode: 'ask', detail: '' } };
  const file = require('../lib/core/paths').eventsFile(f.pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  const r = gates.answer(f.pid, 'g-old001', 'yes', '', { session: 'sx', prompts: [Date.now() - 60000] });
  assert.equal(r.user_turn, true);
  assert.equal(gates.userTurnVerdict({ session: 'sx', ts: old }, 'sx', { prompts: [Date.parse(old) - 1] }, Date.now()), false, 'a prompt before the ask');
});

test('user-turn rule: an old gate.answered without the verdict is not valid when required, valid when not', () => {
  const f = fixture('block');
  events.append(f.pid, { type: 'gate.answered', src: 'cli', session: f.sid, data: { id: 'g-legacy', gate: 'push', answer: 'yes', auto: false, note: '' }, key: 'g-legacy:answered' });
  assert.equal(decision(pre(f, 'git push', 'lg1')), 'deny');
  const g = fixture('block', { require_user_turn: false });
  events.append(g.pid, { type: 'gate.answered', src: 'cli', session: g.sid, data: { id: 'g-legacy', gate: 'push', answer: 'yes', auto: false, note: '' }, key: 'g-legacy:answered' });
  assert.equal(pre(g, 'git push', 'lg2').out, '{}');
});

test('PreToolUse resolves the project from the current cwd, not from the session file', () => {
  const f = fixture('remind'); // the session started in repo A (remind)
  const b = makeRepo();
  H.writeConfig(b, { gates: { enforce: 'block' } });
  project.add(b, { name: 'repo-b' });
  const r = H.runHook('pre-tool-use', H.base(f, { cwd: b, tool_name: 'Bash', tool_use_id: 'cw1', tool_input: { command: 'git push' } }), { cwd: b });
  assert.equal(decision(r), 'deny');
});

// ---------------------------------------------------------------- Bash fast path
test('PreToolUse Bash fast path: a non-git command is answered before any lib module is loaded', () => {
  const dir = require('./helpers').tmpDir('crew-preload-');
  const out = path.join(dir, 'seen.json');
  const preload = path.join(dir, 'preload.js');
  // Each loaded module is appended synchronously, at load time, to a per-thread file. Nothing depends on an exit
  // handler: the hook's main thread calls process.exit as soon as the worker answers, which can kill the worker
  // before its own 'exit' event fires. The worker answers only after it has loaded everything, so the list is complete.
  fs.writeFileSync(preload, `const Module = require('module'); const fs = require('fs'); const seen = new Set(); const orig = Module._load;
const file = process.env.SEEN_FILE + require('worker_threads').threadId;
Module._load = function (req, parent) { const r = orig.apply(this, arguments); try { const n = Module._resolveFilename(req, parent); if (!seen.has(n)) { seen.add(n); fs.appendFileSync(file, n + '\\n'); } } catch (e) {} return r; };`);
  const f = H.fixture();
  const env = { NODE_OPTIONS: `--require=${fwd(preload)}`, SEEN_FILE: out };
  const libs = () => fs.readdirSync(dir).filter((n) => n.startsWith('seen.json')).flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean)).map(fwd).filter((x) => /\/plugins\/crewgate\/lib\//.test(x));
  const r = H.runHook('pre-tool-use', bash(f, 'ls -la', 'fp1'), { cwd: f.repo, env });
  assert.equal(r.out, '{}');
  assert.deepEqual(libs().map((x) => path.basename(x)).sort(), ['prefilter.js', 'timeouts.js']);
  // a git-like command does load the handler (the probe works)
  H.runHook('pre-tool-use', bash(f, 'git push', 'fp2'), { cwd: f.repo, env });
  assert.ok(libs().length > 5);
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
  const env = { CLAUDE_CODE_SESSION_ID: f.sid };
  const ask = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid });
  const r1 = crew(['gate', 'answer', ask.id, 'yes'], f.repo, env);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /will not count/);
  const ask2 = gates.ask(f.pid, {}, { gate: 'push' }, { session: f.sid });
  prompt(f);
  const r2 = crew(['gate', 'answer', ask2.id, 'yes'], f.repo, env);
  assert.doesNotMatch(r2.out, /will not count/);
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).pop().data.user_turn, true);
});

test('crew gate answer does not warn when require_user_turn is false', () => {
  const f = fixture('confirm', { require_user_turn: false });
  const ask = gates.ask(f.pid, {}, { gate: 'push' });
  const r = crew(['gate', 'answer', ask.id, 'yes'], f.repo, { CLAUDE_CODE_SESSION_ID: f.sid });
  assert.doesNotMatch(r.out, /will not count/);
});

test('crew doctor shows the enforce mode and the Codex fallback', () => {
  const f = fixture('confirm');
  const r = crew(['doctor'], f.repo);
  assert.match(r.out, /enforce confirm/);
  assert.match(r.out, /Codex sessions fall back to remind/);
});
