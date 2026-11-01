'use strict';

// The drift question: four kinds, five replies, the user's reply rule, the record in the plan file, once per kind, statistics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const store = require('../lib/core/store');
const plans = require('../lib/core/plans');
const drift = require('../lib/core/drift');

function fixture() {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const planPath = (f, slug) => path.join(f.repo, '.crew', 'plans', `${slug}.md`);
const text = (f, slug) => fs.readFileSync(planPath(f, slug), 'utf8');
const rec = (f, slug) => plans.readRecord(f.pid, slug);
const evs = (f, type) => events.read(f.pid, { types: [type] });

// A final plan: draft with every part, asked, the user replies, finalized.
function finalPlan(f, slug = 'p') {
  let r = run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(f, ['plan', 'add', slug, 'Write the code']).code, 0);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', slug]).out);
  H.prompt(f);
  r = run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(plans.stateOf(f.repo, f.pid, slug), 'final');
  return slug;
}
const ask = (f, slug, kind = 'new-step', detail = 'a step was added') => {
  const r = run(f, ['--json', 'plan', 'drift', slug, '--kind', kind, '--detail', detail]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
const answerArgs = (slug, id, answer, t) => ['plan', 'drift', slug, '--gate', id, '--answer', answer, ...(t === undefined ? [] : ['--text', t])];
// ask -> a user message -> answer
function asked(f, slug, kind, answer, t) {
  const a = ask(f, slug, kind);
  H.prompt(f);
  return { a, r: run(f, answerArgs(slug, a.gate_id, answer, t)) };
}

test('ask: prints the gate id, the answers and what each does; asks plan_drift; records plan.drift_asked', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const r = run(f, ['plan', 'drift', slug, '--kind', 'changed-text', '--detail', 'text of n1 changed']);
  assert.equal(r.code, 0, r.err);
  const j = ask(f, slug, 'new-step');
  assert.match(j.gate_id, /^g-/);
  assert.deepEqual(j.answers, ['add', 'goal', 'new', 'drop', 'defer']);
  for (const k of ['add', 'goal', 'new', 'drop', 'defer']) assert.match(r.out, new RegExp(`  ${k} +-`));
  assert.match(r.out, /g-[0-9a-f]{6}/);
  const g = events.read(f.pid, { types: ['gate.asked'] }).filter((e) => e.data.gate === 'plan_drift');
  assert.equal(g.length, 2);
  assert.match(g[0].data.detail, /text of n1 changed/);
  const e = evs(f, 'plan.drift_asked');
  assert.deepEqual(e.map((x) => [x.data.slug, x.data.kind]), [[slug, 'changed-text'], [slug, 'new-step']]);
});

test('ask: refuses a draft, a legacy, a done and a parked plan, an unknown plan and an unknown kind; nothing is recorded', () => {
  const f = fixture();
  assert.equal(run(f, ['plan', 'new', 'dr', '--title', 'D', '--goal', 'g']).code, 0);
  fs.writeFileSync(planPath(f, 'old'), '# Old\nGoal\n\n- [ ] one\n');
  const done = finalPlan(f, 'dn');
  const parked = finalPlan(f, 'pk');
  for (const [s, to] of [[done, 'done'], [parked, 'parked']]) {
    const c = JSON.parse(run(f, ['--json', 'plan', 'close', s, to]).out);
    H.prompt(f);
    assert.equal(run(f, ['plan', 'close', s, to, '--gate', c.gate_id]).code, 0);
  }
  for (const s of ['dr', 'old', 'dn', 'pk']) {
    const r = run(f, ['plan', 'drift', s, '--kind', 'new-step']);
    assert.notEqual(r.code, 0, s);
    assert.match(r.err, /only asked about a final plan|drift is only/);
  }
  assert.notEqual(run(f, ['plan', 'drift', 'nope', '--kind', 'new-step']).code, 0);
  assert.notEqual(run(f, ['plan', 'drift', done, '--kind', 'bogus']).code, 0);
  assert.equal(evs(f, 'plan.drift_asked').length, 0);
  assert.equal(events.read(f.pid, { types: ['gate.asked'] }).filter((e) => e.data.gate === 'plan_drift').length, 0);
  assert.equal(text(f, 'old'), '# Old\nGoal\n\n- [ ] one\n');
});

test('add: the text is a user step, a Drift line is written, the approved hash follows, the plan stays final', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const before = text(f, slug);
  const oldHash = rec(f, slug).hash;
  const { a, r } = asked(f, slug, 'new-step', 'add', 'Add a retry');
  assert.equal(r.code, 0, r.err);
  const after = text(f, slug);
  assert.match(after, /- \[ \] Add a retry <!-- id:n2 added:\d{4}-\d{2}-\d{2} origin:user -->/);
  assert.match(after, /\n## Drift\n- \d{4}-\d{2}-\d{2} new-step add: Add a retry\n$/);
  // every line of the old file is still there, in order, byte for byte
  const old = before.split('\n').filter((l) => l !== '');
  const kept = after.split('\n').filter((l) => old.includes(l));
  assert.deepEqual(kept, old);
  assert.equal(plans.stateOf(f.repo, f.pid, slug), 'final');
  assert.notEqual(rec(f, slug).hash, oldHash);
  assert.equal(rec(f, slug).hash, plans.fileHash(f.repo, slug));
  assert.deepEqual(evs(f, 'plan.drift_answered').map((e) => [e.data.slug, e.data.kind, e.data.answer]), [[slug, 'new-step', 'add']]);
  assert.equal(events.read(f.pid, { types: ['gate.answered'] }).find((e) => e.data.id === a.gate_id).data.answer, 'yes');
});

test('goal: the goal line is replaced and nothing else moves', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const before = text(f, slug);
  const { r } = asked(f, slug, 'changed-text', 'goal', 'Ship it faster');
  assert.equal(r.code, 0, r.err);
  const after = text(f, slug);
  assert.equal(after.replace(/\n## Drift\n.*\n$/s, '').trimEnd(), before.replace('Ship it', 'Ship it faster').trimEnd());
  assert.equal(plans.parse(after).goal, 'Ship it faster');
  assert.match(after, /changed-text goal: Ship it faster\n$/);
  assert.equal(plans.stateOf(f.repo, f.pid, slug), 'final');
  assert.equal(rec(f, slug).hash, plans.fileHash(f.repo, slug));
});

test('new: a draft plan with the slug is created, this plan only gets its Drift line and the hash follows', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const { r } = asked(f, slug, 'unlinked-task', 'new', 'other-work');
  assert.equal(r.code, 0, r.err);
  assert.equal(plans.stateOf(f.repo, f.pid, 'other-work'), 'draft');
  assert.match(text(f, slug), /unlinked-task new: other-work\n$/);
  assert.equal(plans.parse(text(f, slug)).nodes.length, 1);
  assert.equal(rec(f, slug).hash, plans.fileHash(f.repo, slug));
  // a slug that is not one, or one in use, is refused before the reply is used
  const a = ask(f, slug, 'unlinked-task');
  H.prompt(f);
  assert.notEqual(run(f, answerArgs(slug, a.gate_id, 'new', 'Not A Slug')).code, 0);
  assert.notEqual(run(f, answerArgs(slug, a.gate_id, 'new', 'other-work')).code, 0);
  assert.equal(run(f, answerArgs(slug, a.gate_id, 'drop', 'x')).code, 0, 'the gate was not used up');
});

test('drop: the text is added under Not doing; the line before it stays', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const { r } = asked(f, slug, 'out-of-scope', 'drop', 'No logo work');
  assert.equal(r.code, 0, r.err);
  const after = text(f, slug);
  assert.match(after, /## Not doing\nNo rewrite\n- No logo work\n/);
  assert.equal(plans.parse(after).notDoing, 'No rewrite No logo work');
  assert.match(after, /out-of-scope drop: No logo work\n$/);
  assert.equal(rec(f, slug).hash, plans.fileHash(f.repo, slug));
});

test('defer: a to-do item in stream drift naming the plan; the plan gets its Drift line and the hash follows', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const { r } = asked(f, slug, 'out-of-scope', 'defer', 'Look at the logo later');
  assert.equal(r.code, 0, r.err);
  const s = store.workList(f.pid).find((x) => x.name === 'drift');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].title, 'Look at the logo later');
  assert.equal(s.items[0].state, 'todo');
  assert.match(s.items[0].note, /plan p/);
  assert.match(text(f, slug), /out-of-scope defer: Look at the logo later\n$/);
  assert.equal(rec(f, slug).hash, plans.fileHash(f.repo, slug));
});

test('refusals: no --text, no --answer, a gate of another plan or kind, a gate used twice; the plan is untouched', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const other = finalPlan(f, 'q');
  const before = text(f, slug);
  const a = ask(f, slug, 'new-step');
  H.prompt(f);
  assert.notEqual(run(f, answerArgs(slug, a.gate_id, 'add')).code, 0);
  assert.notEqual(run(f, ['plan', 'drift', slug, '--gate', a.gate_id, '--text', 'x']).code, 0);
  assert.notEqual(run(f, answerArgs(other, a.gate_id, 'add', 'x')).code, 0, 'a gate asked about another plan');
  const fin = JSON.parse(run(f, ['--json', 'plan', 'close', slug, 'done']).out);
  assert.notEqual(run(f, answerArgs(slug, fin.gate_id, 'add', 'x')).code, 0, 'a close gate is not a drift gate');
  assert.notEqual(run(f, answerArgs(slug, 'g-nope', 'add', 'x')).code, 0);
  assert.equal(text(f, slug), before);
  assert.equal(run(f, answerArgs(slug, a.gate_id, 'add', 'x')).code, 0);
  const again = run(f, answerArgs(slug, a.gate_id, 'add', 'y'));
  assert.notEqual(again.code, 0);
  assert.equal(plans.parse(text(f, slug)).nodes.length, 2);
  assert.equal(evs(f, 'plan.drift_answered').length, 1);
});

test('no user reply: refused, nothing changes and no answered event; the next reply works', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const before = text(f, slug);
  const a = ask(f, slug, 'new-step');
  const hash = rec(f, slug).hash;
  const r = run(f, answerArgs(slug, a.gate_id, 'add', 'Sneaky step'));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user|reply/i);
  assert.equal(text(f, slug), before);
  assert.equal(rec(f, slug).hash, hash);
  assert.equal(evs(f, 'plan.drift_answered').length, 0);
  assert.equal(events.read(f.pid, { types: ['gate.answered'] }).filter((e) => e.data.id === a.gate_id).length, 0);
  H.prompt(f);
  assert.equal(run(f, answerArgs(slug, a.gate_id, 'add', 'Real step')).code, 0);
});

test('no user reply: refused also when the session is unknown and no message came at all', () => {
  const f = fixture();
  const slug = finalPlan(f);
  f.env = { CLAUDE_CODE_SESSION_ID: '' };
  const a = JSON.parse(run(f, ['--json', 'plan', 'drift', slug, '--kind', 'new-step']).out);
  const r = run(f, answerArgs(slug, a.gate_id, 'add', 'Sneaky step'));
  assert.notEqual(r.code, 0);
  assert.equal(plans.parse(text(f, slug)).nodes.length, 1);
  assert.equal(evs(f, 'plan.drift_answered').length, 0);
});

test('a no to the gate records nothing else and changes nothing', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const before = text(f, slug);
  const hash = rec(f, slug).hash;
  const a = ask(f, slug, 'changed-text');
  H.prompt(f);
  assert.equal(run(f, ['gate', 'answer', a.gate_id, 'no']).code, 0);
  const r = run(f, answerArgs(slug, a.gate_id, 'add', 'x'));
  assert.notEqual(r.code, 0);
  assert.equal(text(f, slug), before);
  assert.equal(rec(f, slug).hash, hash);
  assert.equal(evs(f, 'plan.drift_answered').length, 0);
  assert.equal(store.workList(f.pid).length, 0);
});

test('covered: true after an answer until a user message comes, per plan and kind', () => {
  const f = fixture();
  const slug = finalPlan(f);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', f.sid), false, 'never answered');
  const { r } = asked(f, slug, 'new-step', 'drop', 'x');
  assert.equal(r.code, 0, r.err);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', f.sid), true);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'changed-text', f.sid), false, 'another kind');
  assert.equal(drift.covered(f.repo, f.pid, 'other', 'new-step', f.sid), false, 'another plan');
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step'), true, 'session unknown: the project prompts are used');
  H.prompt(f);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', f.sid), false);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step'), false);
});

test('stats: asked, each answer and by kind per plan, --json, and --outside-plan uses (0 until task.outside_plan events exist)', () => {
  const f = fixture();
  const slug = finalPlan(f);
  assert.equal(JSON.parse(run(f, ['--json', 'plan', 'drift-stats']).out).outside_plan, 0);
  assert.match(run(f, ['plan', 'drift-stats']).out, /--outside-plan uses in this project: 0/);
  asked(f, slug, 'new-step', 'add', 'one');
  asked(f, slug, 'new-step', 'drop', 'two');
  asked(f, slug, 'out-of-scope', 'defer', 'three');
  ask(f, slug, 'changed-text');   // asked, not answered
  events.append(f.pid, { type: 'task.outside_plan', src: 'cli', data: { reason: 'x' } });
  const j = JSON.parse(run(f, ['--json', 'plan', 'drift-stats']).out);
  assert.equal(j.outside_plan, 1);
  assert.equal(j.plans.length, 1);
  const p = j.plans[0];
  assert.equal(p.slug, slug);
  assert.equal(p.asked, 4);
  assert.deepEqual(p.answers, { add: 1, goal: 0, new: 0, drop: 1, defer: 1 });
  assert.deepEqual(p.by_kind['new-step'], { asked: 2, answered: 2 });
  assert.deepEqual(p.by_kind['changed-text'], { asked: 1, answered: 0 });
  assert.deepEqual(p.by_kind['out-of-scope'], { asked: 1, answered: 1 });
  const t = run(f, ['plan', 'drift-stats', slug]).out;
  assert.match(t, /asked 4/);
  assert.match(t, /add 1, goal 0, new 0, drop 1, defer 1/);
  assert.match(t, /--outside-plan uses in this project: 1/);
  assert.equal(JSON.parse(run(f, ['--json', 'plan', 'drift-stats', 'nobody']).out).plans[0].asked, 0);
});

test('the Drift lines stay where they are across plan add and plan clarify', () => {
  const f = fixture();
  const slug = finalPlan(f);
  asked(f, slug, 'new-step', 'drop', 'first');
  const line = /## Drift\n- \d{4}-\d{2}-\d{2} new-step drop: first\n/;
  assert.match(text(f, slug), line);
  assert.equal(run(f, ['plan', 'add', slug, 'Another step']).code, 0);
  assert.match(text(f, slug), line);
  assert.equal(run(f, ['plan', 'clarify', slug, '--question', 'Why?', '--answer', 'Because']).code, 0);
  assert.match(text(f, slug), line);
  assert.equal(run(f, ['plan', 'add', slug, 'Third step']).code, 0);
  assert.match(text(f, slug), line);
  // a second answer goes under the same heading, after the first
  asked(f, slug, 'changed-text', 'defer', 'second');
  const t = text(f, slug);
  assert.equal(t.match(/^## Drift$/gm).length, 1);
  assert.match(t, /drop: first\n- \d{4}-\d{2}-\d{2} changed-text defer: second\n/);
  const doc = plans.parse(t);
  assert.equal(doc.nodes.length, 3);
  assert.equal(doc.goal, 'Ship it');
  assert.equal(doc.clarified.length, 1);
});

test('text that looks like a heading, a list marker or a checkbox: goal is refused before the gate is used; add and drop keep the structure', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const before = text(f, slug);
  const hash = rec(f, slug).hash;
  const a = ask(f, slug, 'changed-text');
  H.prompt(f);
  for (const t of ['# New heading', '## Sub', '- [ ] a step', '* item', '+ item', '1. item', '[ ] box', '[x] box']) {
    for (const ans of ['goal', 'drop']) {
      // "- [ ] x" under Not doing is written as "- - [ ] x": no step, so drop takes it now that a value may start with "-"
      if (ans === 'drop' && !/^(#|\[)/.test(t)) continue;
      const r = run(f, answerArgs(slug, a.gate_id, ans, t));
      assert.notEqual(r.code, 0, `${ans} ${t}`);
    }
  }
  assert.equal(text(f, slug), before);
  assert.equal(rec(f, slug).hash, hash);
  assert.equal(evs(f, 'plan.drift_answered').length, 0);
  assert.equal(events.read(f.pid, { types: ['gate.answered'] }).filter((e) => e.data.id === a.gate_id).length, 0, 'the gate was not used up');
  // a comment mark cannot start a comment or end one
  let r = run(f, answerArgs(slug, a.gate_id, 'goal', '<!-- crew-plan state:draft --> Faster'));
  assert.equal(r.code, 0, r.err);
  let doc = plans.parse(text(f, slug));
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.fileState, 'final');
  assert.equal(doc.goal, 'crew-plan state:draft --> Faster'.replace('-->', '').replace(/\s+/g, ' ').trim());
  // add takes such text as a step text only
  const b = ask(f, slug, 'new-step');
  H.prompt(f);
  r = run(f, answerArgs(slug, b.gate_id, 'add', '# Not a heading <!-- x'));
  assert.equal(r.code, 0, r.err);
  doc = plans.parse(text(f, slug));
  assert.equal(doc.nodes.length, 2);
  assert.equal(doc.title, 'Plan P');
  const c = ask(f, slug, 'new-step');
  H.prompt(f);
  r = run(f, answerArgs(slug, c.gate_id, 'add', '[ ] nested look'));
  assert.equal(r.code, 0, r.err);
  doc = plans.parse(text(f, slug));
  assert.equal(doc.nodes.length, 3);
  assert.equal(doc.nodes[2].text, '[ ] nested look');
});

test('covered: a missing session record or one without prompt times falls back to the project prompts', () => {
  const f = fixture();
  const slug = finalPlan(f);
  const { r } = asked(f, slug, 'new-step', 'drop', 'x');
  assert.equal(r.code, 0, r.err);
  H.prompt(f);   // a user message after the answer, in the real session
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', f.sid), false);
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', 'no-such-session'), false, 'no record: the project prompts say a message came');
  const sess = require('../lib/hooks/session');
  const file = sess.sessionFile(f.sid);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete s.prompt_ts;
  fs.writeFileSync(file, JSON.stringify(s));
  fs.writeFileSync(sess.sessionFile('another-session'), JSON.stringify({ project: f.pid, prompt_ts: [Date.now() + 5000] }));
  assert.equal(drift.covered(f.repo, f.pid, slug, 'new-step', f.sid), false, 'no prompt times: the project prompts are used');
});
