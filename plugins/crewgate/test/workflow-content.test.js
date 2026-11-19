'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'has frontmatter');
  return Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
}

test('plugin agents: frontmatter per the plugin facts; reviewer and refuter are read-only', () => {
  for (const n of ['crew-worker', 'crew-reviewer', 'crew-refuter']) {
    const fm = frontmatter(read('agents', `${n}.md`));
    assert.equal(fm.name, n);
    assert.ok(fm.description.length > 20);
    assert.equal(fm.model, 'sonnet');
    assert.ok(!('hooks' in fm) && !('permissionMode' in fm), 'ignored fields are not used');
    if (n !== 'crew-worker') {
      const tools = fm.tools.split(',').map((x) => x.trim());
      assert.ok(!tools.includes('Edit') && !tools.includes('Write'), `${n} must not edit`);
      assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'Bash']);
      assert.match(read('agents', `${n}.md`), /Bash is allowed only for/);
    }
  }
});

test('agent templates carry the default worker boundaries (DESIGN section 10)', () => {
  const w = read('templates', 'agents', 'crew-worker.md');
  for (const needle of ['never push', 'No network', 'secrets', 'data files', 'skip tests', 'Must not regress', 'task report', '{{checks_block}}', '{{report_max_tokens}}']) {
    assert.ok(w.includes(needle), `worker template mentions ${needle}`);
  }
  const r = read('templates', 'agents', 'crew-reviewer.md');
  assert.ok(r.includes('not get the worker') && r.includes('verified_by') && r.includes('file:line'));
  assert.ok(read('templates', 'agents', 'crew-refuter.md').includes('upheld|refuted|uncertain'));
});

test('REVIEW.md template: calibration, nit handling, evidence, CI overlap', () => {
  const t = read('templates', 'REVIEW.md');
  for (const needle of ['Severity calibration', 'nit', 'TOCTOU', 'theoretical-race', 'file:line', 'CI']) assert.ok(t.includes(needle), needle);
  assert.match(read('templates', 'LESSONS.md'), /^# Lessons/);
});

test('crew skill: frontmatter, size, sub-commands and every reference exists', () => {
  const text = read('skills', 'crew', 'SKILL.md');
  const fm = frontmatter(text);
  assert.equal(fm.name, 'crew');
  assert.ok(fm.description.includes('分工'));
  assert.ok(text.split('\n').length < 250);
  for (const sub of ['init', 'status', 'wrap-up', 'handoff']) assert.ok(new RegExp(`\\*\\*${sub}\\*\\*`).test(text), sub);
  assert.ok(text.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js"'));
  for (const m of text.matchAll(/`references\/([\w.-]+\.md)`/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'crew', 'references', m[1])), m[1]);
  }
  for (const needle of ['max_parallel_workers', 'run_in_background', 'crew task create', 'crew review finalize', 'Promote nothing without a clear yes', 'untrusted']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('crew skill: language, closing status line, keep going, approvals, review after a send-back, commands read', () => {
  const s = read('skills', 'crew', 'SKILL.md').replace(/\s+/g, ' ');
  for (const needle of [
    'Write every message to the user in the project language', 'turns started by a task notification', 'reload this skill',
    'exactly one status line, last in the message', 'Waiting for you:', 'Nothing needed from you:', 'never bundle it with a second question',
    '**Keep going.**', 'without waiting to be told', 'an empty frontier',
    'yes --quote "<their words>"` in the same turn', 'plain chat text', 'question widget', '`gates.plan_covers_merge`',
    'Push, PR, remote hosts, installs and downloads ask every time', 'One yes covers one action', '30 minutes', '12 hours',
    'The hook denies a push, PR or merge chained in the same command', '`head`/`tail`',
    'A fix made after a send-back gets another review round', '20 changed lines or fewer', 'documentation only',
    '`crew <group> --help`', 'Never guess options', '--scope once|always --reason', 'todo|doing|done|waiting|parked',
    'never write the prompt by hand', 'Count running workers before every dispatch or re-dispatch',
  ]) assert.ok(s.includes(needle), needle);
  const gates = read('skills', 'crew', 'references', 'lessons-and-gates.md').replace(/\s+/g, ' ');
  for (const needle of ['The user-turn rule', '--quote', 'user_turn: "instruction"', 'Waiting for you: merge', 'gates.enforce']) assert.ok(gates.includes(needle), needle);
  assert.ok(read('skills', 'crew', 'references', 'review-pipeline.md').includes('The round after a send-back'));
  const cmds = read('skills', 'crew', 'references', 'commands.md');
  for (const needle of ['--quote', 'gates.plan_covers_merge', '--under', 'is a split', 'needs no gate']) assert.ok(cmds.includes(needle), needle);
});

test('every CLI sub-command named in the skill references exists in the command modules', () => {
  const { loadGroup } = require('../lib/core/cli');
  const files = ['SKILL.md', path.join('references', 'commands.md'), path.join('references', 'review-pipeline.md')];
  for (const f of files) {
    const text = read('skills', 'crew', f);
    for (const m of text.matchAll(/`crew (task|review|handoff|lesson|init|doctor)\b/g)) {
      assert.ok(loadGroup(m[1]), `${f}: group ${m[1]}`);
    }
  }
});

test('plan skill: exists, under its limit, trigger phrases and commands', () => {
  const text = read('skills', 'plan', 'SKILL.md');
  const fm = frontmatter(text);
  assert.equal(fm.name, 'plan');
  assert.ok(text.split('\n').length < 133);
  const trig = `${fm.description} ${fm.when_to_use}`;
  for (const p of ['write a plan', 'plan this feature', 'help me think through', '寫一個 X 的計劃', '規劃這個功能', '幫我想清楚']) {
    assert.ok(trig.includes(p), p);
  }
  assert.ok(text.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js"'));
  for (const c of ['plan new', 'plan part', 'plan add', 'plan clarify', 'plan finalize', '--gate', 'plan adopt', '--by assumed', 'plan.interview', 'plan.review', 'plan.enforce', 'Not doing'.toLowerCase()]) {
    assert.ok(text.toLowerCase().includes(c.toLowerCase()), c);
  }
  for (const c of ['(assumed)', '(user)', 'No second reply, no hand edit', 'lists each `(assumed)` line', '`ask`', '`off`', 'ask the user']) {
    assert.ok(text.replace(/\s+/g, ' ').toLowerCase().includes(c.toLowerCase()), c);
  }
  // fixes from the plan skill test report
  for (const c of ['--add', '--by decision', 'That one yes approves the plan and confirms the assumptions', 'In every case', 'Only when the user or the task says', 'if unsure, ask', 'One decision per question', 'If they asked only for a plan', 'start it', 'Without Crewgate, just do it', 'ask the user about a plan review']) {
    assert.ok(text.replace(/\s+/g, ' ').includes(c), c);
  }
  // the interview as a decision tree, plain chat text, the builder read-through and the new CLI behaviour
  for (const c of ['the frontier', 'Stop only when the frontier is empty', 'There is no cap', 'Do not use a question widget or picker', 'Builder read-through', 'Facts are your job', 'end the interview at any time', '--quote "<their words>"', 'do not ask "shall I start"', '`gates.plan_covers_merge`', 'closes it with no gate']) {
    assert.ok(text.replace(/\s+/g, ' ').includes(c), c);
  }
  for (const m of text.matchAll(/`references\/([\w.-]+\.md)`/g)) {
    if (m[1] === 'review-pipeline.md') continue; // the crew skill's file
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'plan', 'references', m[1])), m[1]);
  }
  assert.ok(read('skills', 'plan', 'references', 'questions.md').includes('Recommended:'));
  assert.ok(read('skills', 'plan', 'references', 'read-through.md').includes('--by decision'));
  for (const c of ['5 questions', 'Do not ask for comfort']) assert.ok(!text.replace(/\s+/g, ' ').includes(c), `gone: ${c}`);
  assert.ok(read('skills', 'crew', 'references', 'commands.md').includes('[--add]'));
});

test('skills: small fix via crew, one decision per question, plan.review ask is followed', () => {
  const flat = (...p) => read(...p).replace(/\s+/g, ' ');
  const plan = flat('skills', 'plan', 'SKILL.md');
  const crew = flat('skills', 'crew', 'SKILL.md');
  for (const [name, s] of [['plan', plan], ['crew', crew]]) {
    assert.ok(s.includes('`crew task create`') && s.includes('--outside-plan'), `${name}: small fix goes through crew`);
  }
  assert.ok(!plan.includes('outside one, just do it'));
  const sec4 = plan.slice(plan.indexOf('## 4. Finalizing'), plan.indexOf('## 5. Settings'));
  assert.ok(sec4.includes('if `plan.review` is `ask` and the size is medium or large, ask the user about a plan review'));
  assert.ok(sec4.includes('one question as in section 2'), 'section 4');
  const drift = plan.slice(plan.indexOf('## When work drifts'), plan.indexOf('## 6.'));
  assert.ok(drift.includes('one question as in section 2'), 'drift');
  assert.ok(!crew.includes('(about 3 steps or more) run a **plan review**'));
  assert.ok(crew.includes('Follow `plan.review`'));
  assert.ok(crew.includes('a small fix the user asks for is still a crew task, even in those files'));
  assert.ok(crew.includes('your own records (plans, briefs, notes, docs you write as orchestrator)'));
  assert.ok(sec4.includes('In an unattended run (section 6) skip the question and say in the final message that the review was not asked'));
});

test('crew skill points at the plan skill and commands.md lists the plan state commands', () => {
  assert.ok(read('skills', 'crew', 'SKILL.md').includes('/crewgate:plan'));
  const cmds = read('skills', 'crew', 'references', 'commands.md');
  for (const c of ['plan finalize', 'plan part', 'plan close', 'plan reopen', 'plan adopt']) assert.ok(cmds.includes(`crew ${c}`), c);
});
