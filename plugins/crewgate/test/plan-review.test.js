'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const projects = require('../lib/core/project');
const events = require('../lib/core/events');
const store = require('../lib/core/store');
const plans = require('../lib/core/plans');
const pr = require('../lib/core/plan-review');

const PLAN = [
  '# Demo plan',
  'Ship a todo CLI with due dates.',
  '',
  '- [ ] Due dates <!-- id:n1 added:2026-10-01 origin:plan -->',
  '  - [ ] Add due dates <!-- id:n2 added:2026-10-01 origin:plan -->',
  '  - [ ] Sort by due date <!-- id:n3 added:2026-10-01 origin:plan -->',
  '    - [ ] Stable sort <!-- id:n4 added:2026-10-01 origin:plan -->',
  '- [ ] Release <!-- id:n5 added:2026-10-01 origin:plan -->',
  '',
].join('\n');

function setup(extraCfg) {
  const repo = h.makeRepo();
  const proj = projects.add(repo, { name: 'demo' }).project;
  fs.mkdirSync(path.join(repo, '.crew', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), PLAN);
  if (extraCfg) u.writeFile(repo, '.claude/crew.json', JSON.stringify({ version: 1, ...extraCfg }));
  return { repo, proj };
}

// CLI with --json; `input` (an object) goes to stdin.
function cli(repo, args, input) {
  const r = input === undefined ? h.crew(['--json', ...args], repo) : u.crewIn(['--json', ...args], repo, JSON.stringify(input));
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* leave null */ }
  return { ...r, data };
}

const F = (node, kind, action, text, over = {}) => ({
  node, kind, claim: `claim about ${text}`, evidence: [`plan ${node || 'goal'}`], ...over,
  proposal: { action, text, done_when: `${text} works, checked by a test`, ...(over.proposal || {}) },
});
const planText = (repo) => fs.readFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), 'utf8');
const node = (repo, proj, id) => {
  const d = cli(repo, ['plan', 'show', 'demo']).data;
  let hit = null;
  (function walk(l) { l.forEach((n) => { if (n.id === id) hit = n; walk(n.children); }); }(d.nodes));
  return hit;
};
const verdicts = (...v) => v.map(([id, verdict, extra]) => ({ id, verdict, evidence: 'plan n1, checked', ...(extra || {}) }));

// run + submit + filter; returns the filter result
function raise(repo, findings) {
  const run = cli(repo, ['plan', 'review', 'run', 'demo']);
  assert.equal(run.code, 0, run.err);
  const sub = cli(repo, ['plan', 'review', 'submit', 'demo', '--round', String(run.data.round)], findings);
  assert.equal(sub.code, 0, sub.err);
  const flt = cli(repo, ['plan', 'review', 'filter', 'demo', '--round', String(run.data.round)]);
  assert.equal(flt.code, 0, flt.err);
  return { round: run.data.round, run: run.data, filter: flt.data };
}
function close(repo, round, refs) {
  const sub = cli(repo, ['plan', 'review', 'submit', 'demo', '--round', String(round), '--kind', 'refutations'], refs);
  assert.equal(sub.code, 0, sub.err);
  const fin = cli(repo, ['plan', 'review', 'finalize', 'demo', '--round', String(round)]);
  assert.equal(fin.code, 0, fin.err);
  return fin.data;
}

test('full round: run, submit, filter, finalize turns survivors into proposed nodes under their step', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [
    F('n2', 'missing-step', 'add', 'Reject due dates in the past'),
    F('n3', 'too-big', 'split', 'Sort by due date, then by priority'),
    F('n5', 'risk', 'change', 'Release with a signed tag'),
    F(null, 'missing-step', 'add', 'Write the user guide'),
    F('n1', 'redundant', 'drop', 'Duplicates the release step'),
  ]);
  assert.equal(r.round, 1);
  assert.equal(r.filter.kept.length, 5);
  assert.equal(r.filter.refuter.subagent_type, 'crew-refuter');
  const ids = r.filter.kept.map((f) => f.id);
  assert.deepEqual(ids, ['f1', 'f2', 'f3', 'f4', 'f5']);
  const fin = close(repo, 1, verdicts(['f1', 'upheld'], ['f2', 'upheld'], ['f3', 'upheld', { better: 'Release with a signed, pushed tag' }], ['f4', 'uncertain'], ['f5', 'refuted']));
  assert.equal(fin.refuted, 1);
  assert.equal(fin.created.length, 4);
  // placement: under the step it is about, the whole-plan finding at the root
  const byFinding = Object.fromEntries(fin.created.map((c) => [c.id, c]));
  assert.equal(byFinding.f1.under, 'n2');
  assert.equal(byFinding.f2.under, 'n3');
  assert.equal(byFinding.f3.under, 'n5');
  assert.equal(byFinding.f4.under, null);
  // origins: upheld -> review; better wording -> refute; uncertain is marked
  assert.equal(byFinding.f1.origin, 'review');
  assert.equal(byFinding.f3.origin, 'refute');
  assert.equal(byFinding.f3.text, 'Release with a signed, pushed tag');
  assert.equal(byFinding.f4.uncertain, true);
  const text = planText(repo);
  assert.ok(/- \[\?\] Reject due dates in the past <!-- id:n\d+ added:\d{4}-\d{2}-\d{2} origin:review round:1 finding:\S+ kind:missing-step action:add done_when:\S+ for:n2 -->/.test(text), text);
  assert.ok(/uncertain:1/.test(text));
  assert.ok(!text.includes('claim about'), 'long reasoning stays out of the Markdown');
  // metadata on the derived node and in the round files
  const n = node(repo, proj, byFinding.f1.node_id);
  assert.equal(n.state, 'proposed');
  assert.deepEqual(n.proposal, { round: 1, kind: 'missing-step', action: 'add', done_when: 'Reject due dates in the past works, checked by a test', for: 'n2', uncertain: false });
  const final = JSON.parse(fs.readFileSync(pr.roundFile(pr.dirOf(proj.id, 'demo'), 1, 'json'), 'utf8'));
  assert.equal(final.find((x) => x.id === 'f1').claim, 'claim about Reject due dates in the past');
  const filtered = JSON.parse(fs.readFileSync(pr.roundFile(pr.dirOf(proj.id, 'demo'), 1, 'filtered.json'), 'utf8'));
  assert.ok(filtered.some((d) => d.reason === 'refuted' && d.finding.id === 'f5'), 'a refuted finding is recorded, never in the tree');
  assert.ok(!text.includes('Duplicates the release step'));
  // events carry ids and counts only
  const ev = events.read(proj.id, { types: 'plan.*' });
  const started = ev.find((e) => e.type === 'plan.review_started');
  const done = ev.find((e) => e.type === 'plan.review_finalized');
  assert.deepEqual(started.data, { slug: 'demo', round: 1 });
  assert.deepEqual(done.data, { slug: 'demo', round: 1, raised: 5, kept: 4, refuted: 1, cut: 0 });
  assert.ok(!JSON.stringify(ev).includes('signed'));
  // round history
  const rounds = pr.roundsOf(proj.id, 'demo');
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].raised, 5);
  assert.equal(rounds[0].kept, 4);
  assert.equal(rounds[0].refuted, 1);
  // an unfinished plan with proposals still shows the same percentage: proposals do not count
  assert.equal(cli(repo, ['plan', 'show', 'demo']).data.summary.total, 3);
});

test('prompts mark the plan and the packet as untrusted data; reviewer and refuter are read-only', () => {
  const { repo } = setup();
  const run = cli(repo, ['plan', 'review', 'run', 'demo']).data;
  assert.match(run.prompt, /DATA/);
  assert.match(run.prompt, /never instructions/);
  assert.match(run.prompt, /read-only/);
  assert.equal(run.subagent_type, 'crew-reviewer');
  const packet = fs.readFileSync(run.packet_path, 'utf8');
  assert.match(packet, /untrusted data/);
  assert.ok(packet.includes('Ship a todo CLI with due dates.'));
  assert.ok(packet.includes('- [ ] Add due dates'));
  assert.ok(packet.includes('n3  depth 2  todo  Sort by due date'));
  cli(repo, ['plan', 'review', 'submit', 'demo', '--round', '1'], [F('n2', 'risk', 'add', 'Check the clock source')]);
  const flt = cli(repo, ['plan', 'review', 'filter', 'demo']).data;
  assert.match(flt.refuter.prompt, /DATA/);
  assert.match(flt.refuter.prompt, /DISPROVE/);
  assert.match(flt.refuter.prompt, /read-only/);
  assert.match(flt.refuter.prompt, /--kind refutations/);
});

test('a plan with hostile text cannot close the packet fence', () => {
  const { repo } = setup();
  fs.appendFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), '- [ ] ```` break out ```` <!-- id:n9 -->\n');
  const run = cli(repo, ['plan', 'review', 'run', 'demo']).data;
  const packet = fs.readFileSync(run.packet_path, 'utf8');
  assert.ok(packet.includes('`````'), 'the fence is longer than any backtick run in the plan');
});

test('filter drops malformed, unknown-node, out-of-scope and duplicate findings; done_when is required', () => {
  const { repo } = setup();
  const noDone = F('n2', 'risk', 'add', 'Handle time zones');
  delete noDone.proposal.done_when;
  const blankDone = F('n2', 'risk', 'add', 'Handle leap days', { proposal: { done_when: '   ' } });
  const r = raise(repo, [
    F('n2', 'missing-step', 'add', 'Reject due dates in the past'),
    'not an object',
    { node: 'n2', kind: 'nonsense', claim: 'x', evidence: ['e'], proposal: { action: 'add', text: 't', done_when: 'd' } },
    { node: 'n2', kind: 'risk', claim: '', evidence: ['e'], proposal: { action: 'add', text: 't', done_when: 'd' } },
    { node: 'n2', kind: 'risk', claim: 'c', evidence: [], proposal: { action: 'add', text: 't', done_when: 'd' } },
    { node: 'n2', kind: 'risk', claim: 'c', evidence: ['e'], proposal: { action: 'explode', text: 't', done_when: 'd' } },
    { node: 'n2', kind: 'risk', claim: 'c', evidence: ['e'] },
    noDone,
    blankDone,
    F('n99', 'risk', 'add', 'About a step that does not exist'),
    F(null, 'risk', 'change', 'Change needs a target'),
    F('n2', 'missing-step', 'add', '  reject DUE dates, in the past!  '),
  ]);
  const why = Object.fromEntries(r.filter.dropped.map((d) => [d.finding && d.finding.id ? d.finding.id : '?', d.reason]));
  assert.equal(r.filter.kept.length, 1);
  assert.equal(r.filter.kept[0].id, 'f1');
  assert.equal(why.f8, 'no-done-when');
  assert.equal(why.f9, 'no-done-when');
  assert.equal(why.f10, 'unknown-node');
  assert.equal(why.f12, 'duplicate', 'same node and normalised text twice in one round');
  assert.equal(r.filter.dropped.filter((d) => d.reason === 'invalid').length, 7);
  assert.equal(r.filter.dropped.filter((d) => d.reason === 'no-done-when').length, 2);
});

test('--node limits the review to one subtree and drops findings outside it', () => {
  const { repo, proj } = setup();
  const run = cli(repo, ['plan', 'review', 'run', 'demo', '--node', 'n3']).data;
  assert.equal(run.scope, 'n3');
  assert.match(run.prompt, /Review only step n3/);
  assert.ok(fs.readFileSync(run.packet_path, 'utf8').includes('Scope: step n3'));
  cli(repo, ['plan', 'review', 'submit', 'demo', '--round', '1'], [
    F('n4', 'risk', 'add', 'Inside the subtree'), F('n2', 'risk', 'add', 'Outside the subtree'), F(null, 'risk', 'add', 'Whole plan is outside too'),
  ]);
  const flt = cli(repo, ['plan', 'review', 'filter', 'demo']).data;
  assert.deepEqual(flt.kept.map((f) => f.id), ['f1']);
  assert.deepEqual(flt.dropped.map((d) => d.reason), ['out-of-scope', 'out-of-scope']);
  assert.equal(pr.roundsOf(proj.id, 'demo')[0].scope, 'n3');
  assert.equal(cli(repo, ['plan', 'review', 'run', 'demo', '--node', 'nope']).code === 0, false);
});

test('a rejected proposal is not raised again, in a later round, whatever the spacing or case', () => {
  const { repo } = setup();
  let r = raise(repo, [F('n2', 'missing-step', 'add', 'Reject due dates in the past')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld']));
  const rej = cli(repo, ['plan', 'reject', 'demo', fin.created[0].node_id, '--note', 'out of scope for 0.2']);
  assert.equal(rej.code, 0, rej.err);
  assert.equal(rej.data.note, 'out of scope for 0.2');
  r = raise(repo, [F('n2', 'missing-step', 'add', 'reject  due DATES in the past.'), F('n3', 'missing-step', 'add', 'Reject due dates in the past')]);
  assert.deepEqual(r.filter.dropped.map((d) => d.reason), ['repeat-rejected']);
  assert.deepEqual(r.filter.kept.map((f) => f.id), ['f2'], 'the same text about another step is a different proposal');
});

test('a rejected refuter rewording also blocks the reviewer original', () => {
  const { repo } = setup();
  let r = raise(repo, [F('n5', 'risk', 'change', 'Release with a tag')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld', { better: 'Release with a signed tag' }]));
  cli(repo, ['plan', 'reject', 'demo', fin.created[0].node_id]);
  r = raise(repo, [F('n5', 'risk', 'change', 'Release with a tag'), F('n5', 'risk', 'change', 'Release with a signed tag')]);
  assert.equal(r.filter.kept.length, 0);
  assert.equal(r.filter.dropped.length, 2);
});

test('accept: add and split open the node; change rewords the target; drop drops it; both remove the proposal', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [
    F('n2', 'missing-step', 'add', 'Reject due dates in the past'),
    F('n3', 'too-big', 'split', 'Sort by due date'),
    F('n5', 'risk', 'change', 'Release with a signed tag'),
    F('n1', 'redundant', 'drop', 'Covered by the release step'),
  ]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld'], ['f2', 'upheld'], ['f3', 'upheld'], ['f4', 'upheld']));
  const id = (f) => fin.created.find((c) => c.id === f).node_id;
  const a = cli(repo, ['plan', 'accept', 'demo', id('f1')]);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.data.state, 'open');
  assert.equal(node(repo, proj, id('f1')).state, 'todo');
  assert.equal(cli(repo, ['plan', 'accept', 'demo', id('f2')]).data.action, 'split');
  assert.equal(node(repo, proj, id('f2')).state, 'todo');
  const c = cli(repo, ['plan', 'accept', 'demo', id('f3')]);
  assert.equal(c.data.target, 'n5');
  assert.equal(c.data.removed, true);
  assert.equal(node(repo, proj, 'n5').text, 'Release with a signed tag');
  assert.equal(node(repo, proj, id('f3')), null, 'the proposal node is gone');
  const d = cli(repo, ['plan', 'accept', 'demo', id('f4')]);
  assert.equal(d.data.target, 'n1');
  assert.equal(node(repo, proj, 'n1').state, 'dropped');
  assert.equal(node(repo, proj, id('f4')), null);
  // accepted nodes count towards progress now; a second accept is refused
  assert.equal(cli(repo, ['plan', 'accept', 'demo', id('f1')]).code === 0, false);
  assert.equal(pr.roundsOf(proj.id, 'demo')[0].accepted, 4);
  const ev = events.read(proj.id, { types: 'plan.proposal_accepted' });
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[2].data.action, 'change');
  assert.ok(!JSON.stringify(ev).includes('signed'));
});

test('accept of change/drop refuses when the target is gone; `plan set accept` is an alias and still works on plain [?] nodes', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [F('n5', 'risk', 'change', 'Release with a signed tag'), F('n2', 'missing-step', 'add', 'Reject past dates')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld'], ['f2', 'upheld']));
  const change = fin.created.find((c) => c.id === 'f1').node_id;
  const add = fin.created.find((c) => c.id === 'f2').node_id;
  cli(repo, ['plan', 'set', 'demo', 'n5', 'dropped']);
  const gone = cli(repo, ['plan', 'accept', 'demo', change]);
  assert.notEqual(gone.code, 0);
  assert.match(gone.err, /gone or dropped/);
  const alias = cli(repo, ['plan', 'set', 'demo', add, 'accept']);
  assert.equal(alias.code, 0, alias.err);
  assert.equal(alias.data.action, 'add');
  assert.equal(node(repo, proj, add).state, 'todo');
  // a plain proposed node keeps the step 1 behaviour (plan.node_changed, no review accounting)
  const added = cli(repo, ['plan', 'add', 'demo', 'Maybe later', '--proposed']).data;
  const plain = cli(repo, ['plan', 'set', 'demo', added.id, 'accept']);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.data.state, 'open');
  assert.ok(events.read(proj.id, { types: 'plan.node_changed' }).some((e) => e.data.change === 'accept'));
});

test('reject marks the node dropped, stores the note and records an event without text', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [F('n2', 'risk', 'add', 'Support every calendar on earth')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld']));
  const id = fin.created[0].node_id;
  const rej = cli(repo, ['plan', 'reject', 'demo', id, '--note', 'too large, token=abc123def456']);
  assert.equal(rej.code, 0, rej.err);
  assert.equal(node(repo, proj, id).state, 'dropped');
  assert.ok(/- \[~\] Support every calendar on earth <!-- id:n\d+ [^>]*rejected:\d{4}-\d{2}-\d{2}/.test(planText(repo)));
  const st = pr.readState(pr.dirOf(proj.id, 'demo'));
  assert.equal(st.notes[id].decision, 'rejected');
  assert.ok(!st.notes[id].note.includes('abc123def456'), 'the note is redacted');
  assert.equal(pr.roundsOf(proj.id, 'demo')[0].rejected, 1);
  const ev = events.read(proj.id, { types: 'plan.proposal_rejected' });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].data, { slug: 'demo', node: id, action: 'add', round: 1 });
  assert.notEqual(cli(repo, ['plan', 'reject', 'demo', id]).code, 0, 'already decided');
});

test('cap: max_proposals_per_round keeps the most severe kinds first and reports the cut', () => {
  const { repo, proj } = setup({ plan: { max_proposals_per_round: 2 } });
  const r = raise(repo, [
    F('n2', 'redundant', 'drop', 'Drop it'), F('n2', 'risk', 'add', 'Mind the clock'), F('n3', 'too-big', 'split', 'Split sort'),
    F('n5', 'missing-step', 'add', 'Add a smoke test'), F('n5', 'vague-done', 'change', 'Be specific'),
  ]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld'], ['f2', 'upheld'], ['f3', 'upheld'], ['f4', 'upheld'], ['f5', 'upheld']));
  assert.equal(fin.cut, 3);
  assert.deepEqual(fin.created.map((c) => c.id).sort(), ['f3', 'f4'], 'missing-step and too-big outrank the rest');
  const filtered = JSON.parse(fs.readFileSync(pr.roundFile(pr.dirOf(proj.id, 'demo'), 1, 'filtered.json'), 'utf8'));
  assert.equal(filtered.filter((d) => d.reason === 'cap').length, 3);
  assert.equal(pr.roundsOf(proj.id, 'demo')[0].cut, 3);
});

test('cap: max_rounds per plan, --force overrides', () => {
  const { repo } = setup({ plan: { max_rounds: 2 } });
  assert.equal(cli(repo, ['plan', 'review', 'run', 'demo']).code, 0);
  assert.equal(cli(repo, ['plan', 'review', 'run', 'demo']).data.round, 2);
  const third = cli(repo, ['plan', 'review', 'run', 'demo']);
  assert.notEqual(third.code, 0);
  assert.match(third.err, /plan\.max_rounds/);
  const forced = cli(repo, ['plan', 'review', 'run', 'demo', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(forced.data.round, 3);
});

test('depth: a proposal about a third-level step is attached at the deepest allowed level and says so', () => {
  const { repo } = setup();
  const r = raise(repo, [F('n4', 'risk', 'add', 'Stable means equal keys keep their order')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld']));
  const c = fin.created[0];
  assert.equal(c.deep, true);
  assert.equal(c.under, 'n3', 'beside n4, under its parent');
  assert.equal(c.for, 'n4');
  const n = node(repo, null, c.node_id);
  assert.equal(n.depth, 3);
  const out = h.crew(['plan', 'review', 'finalize', 'demo'], repo);
  assert.notEqual(out.code, 0, 'finalizing twice is refused');
  // the CLI line for a deep attach
  const r2 = raise(repo, [F('n4', 'risk', 'add', 'Another one about the third level')]);
  const text = h.crew(['plan', 'review', 'submit', 'demo', '--round', String(r2.round), '--kind', 'refutations', '--file', u.writeFile(h.tmpDir('crew-ref-'), 'r.json', JSON.stringify(verdicts(['f1', 'upheld']))), ], repo);
  assert.equal(text.code, 0, text.err);
  const fin2 = h.crew(['plan', 'review', 'finalize', 'demo', '--round', String(r2.round)], repo);
  assert.match(fin2.out, /deepest allowed level/);
});

test('growth: more accepted proposals than plan.large_growth prints the gate hint and records one need, no block', () => {
  const { repo, proj } = setup({ plan: { large_growth: 2 } });
  const r = raise(repo, [F('n2', 'risk', 'add', 'One'), F('n2', 'risk', 'add', 'Two'), F('n3', 'risk', 'add', 'Three'), F('n5', 'risk', 'add', 'Four')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld'], ['f2', 'upheld'], ['f3', 'upheld'], ['f4', 'upheld']));
  const ids = fin.created.map((c) => c.node_id);
  assert.equal(cli(repo, ['plan', 'accept', 'demo', ids[0]]).data.growth, null);
  assert.equal(cli(repo, ['plan', 'accept', 'demo', ids[1]]).data.growth, null);
  const third = cli(repo, ['plan', 'accept', 'demo', ids[2]]);
  assert.equal(third.code, 0);
  assert.equal(third.data.growth.count, 3);
  assert.equal(third.data.growth.limit, 2);
  assert.ok(third.data.growth.need > 0);
  const human = h.crew(['plan', 'accept', 'demo', ids[3]], repo);
  assert.match(human.out, /large_task gate applies/);
  const needs = store.needList(proj.id).filter((n) => /grew by/.test(n.text));
  assert.equal(needs.length, 1, 'one need per crossing, not one per accept');
  // a large_task approval resets the count
  events.append(proj.id, { type: 'gate.answered', src: 'cli', data: { id: 'g-x', gate: 'large_task', answer: 'yes' }, key: 'g-x:answered' });
  const r2 = raise(repo, [F('n2', 'risk', 'add', 'Five')]);
  const fin2 = close(repo, r2.round, verdicts(['f1', 'upheld']));
  assert.equal(cli(repo, ['plan', 'accept', 'demo', fin2.created[0].node_id]).data.growth, null);
});

test('plain plan commands and a plan without review keep working; no new required fields', () => {
  const { repo, proj } = setup();
  const show = cli(repo, ['plan', 'show', 'demo']).data;
  assert.equal(show.summary.total, 3);
  assert.ok(show.nodes.every((n) => !('proposal' in n)));
  assert.equal(pr.roundsOf(proj.id, 'demo').length, 0);
  assert.equal(pr.proposalsOf(proj.id, 'demo', plans.readCapped(repo, 'demo')).length, 0);
  assert.equal(planText(repo), PLAN, 'reading and listing never rewrite the file');
  const help = h.crew(['plan', '--help'], repo);
  assert.match(help.out, /plan review run/);
});

test('proposalsOf joins a pending node with its round file', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [F('n2', 'risk', 'add', 'Mind the clock', { claim: 'The clock may differ', evidence: ['n2', 'src/clock.js:3'] })]);
  close(repo, r.round, verdicts(['f1', 'uncertain']));
  const list = pr.proposalsOf(proj.id, 'demo', plans.readCapped(repo, 'demo'));
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.kind, 'risk');
  assert.equal(p.action, 'add');
  assert.equal(p.uncertain, true);
  assert.equal(p.verdict, 'uncertain');
  assert.equal(p.claim, 'The clock may differ');
  assert.deepEqual(p.evidence, ['n2', 'src/clock.js:3']);
  assert.equal(p.target.id, 'n2');
  assert.equal(p.target.text, 'Add due dates');
  assert.equal(p.accept_cmd, `crew plan accept demo ${p.id}`);
  assert.match(p.reject_cmd, /crew plan reject demo .* --note/);
});

// ---------------------------------------------------------------- hardening
test('metadata round-trips: a done_when with "-->", newlines, % and unicode keeps the proposal readable after a reload', () => {
  const { repo, proj } = setup();
  const nasty = 'ends --> here <!-- and\nnew line, 100% sure,\ttab   end';
  const r = raise(repo, [F('n5', 'risk', 'change', 'Release with a signed tag', { proposal: { done_when: nasty } })]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld']));
  const id = fin.created[0].node_id;
  const text = planText(repo);
  assert.equal((text.match(/-->/g) || []).length, text.split('\n').filter((l) => l.includes('<!--')).length, 'one comment end per line');
  const n = node(repo, proj, id);
  assert.equal(n.proposal.action, 'change');
  assert.equal(n.proposal.for, 'n5');
  assert.equal(n.proposal.done_when, nasty);
  assert.equal(pr.proposalsOf(proj.id, 'demo', plans.readCapped(repo, 'demo'))[0].done_when, nasty);
  const acc = cli(repo, ['plan', 'accept', 'demo', id]);
  assert.equal(acc.code, 0, acc.err);
  assert.equal(acc.data.removed, true);
  assert.equal(node(repo, proj, 'n5').text, 'Release with a signed tag', 'the target was reworded, no new step opened');
  assert.equal(cli(repo, ['plan', 'show', 'demo']).data.summary.total, 3);
  assert.equal(plans.decodeToken(plans.encodeToken(nasty)), nasty);
});

test('rounds must be registered by review run: submit, filter and finalize refuse an unknown round', () => {
  const { repo, proj } = setup();
  const sub = cli(repo, ['plan', 'review', 'submit', 'demo'], [F('n2', 'risk', 'add', 'x y z')]);
  assert.notEqual(sub.code, 0);
  assert.match(sub.err, /review run/);
  cli(repo, ['plan', 'review', 'run', 'demo']);
  assert.notEqual(cli(repo, ['plan', 'review', 'submit', 'demo', '--round', '7'], [F('n2', 'risk', 'add', 'x y z')]).code, 0);
  // files planted by hand for a round that was never started
  const dir = pr.dirOf(proj.id, 'demo');
  fs.writeFileSync(pr.roundFile(dir, 9, 'raw.json'), JSON.stringify([F('n2', 'risk', 'add', 'Planted')]));
  fs.writeFileSync(pr.roundFile(dir, 9, 'kept.json'), JSON.stringify([F('n2', 'risk', 'add', 'Planted')]));
  assert.match(cli(repo, ['plan', 'review', 'filter', 'demo', '--round', '9']).err, /review run/);
  const fin = cli(repo, ['plan', 'review', 'finalize', 'demo', '--round', '9']);
  assert.notEqual(fin.code, 0);
  assert.match(fin.err, /review run/);
  assert.ok(!planText(repo).includes('Planted'));
  assert.equal(pr.roundsOf(proj.id, 'demo').length, 1);
});

test('finalize twice fails clearly and adds nothing; several at once create the proposals exactly once', async () => {
  const { repo } = setup();
  const r = raise(repo, [F('n2', 'risk', 'add', 'One'), F('n3', 'risk', 'add', 'Two')]);
  cli(repo, ['plan', 'review', 'submit', 'demo', '--round', String(r.round), '--kind', 'refutations'], verdicts(['f1', 'upheld'], ['f2', 'upheld']));
  const runs = await Promise.all([1, 2, 3].map(() => u.crewAsync(['--json', 'plan', 'review', 'finalize', 'demo', '--round', String(r.round)], repo)));
  assert.equal(runs.filter((x) => x.code === 0).length, 1, runs.map((x) => x.err).join(' | '));
  assert.equal((planText(repo).match(/\[\?\]/g) || []).length, 2);
  const again = cli(repo, ['plan', 'review', 'finalize', 'demo', '--round', String(r.round)]);
  assert.notEqual(again.code, 0);
  assert.match(again.err, /already finalized/);
  assert.equal((planText(repo).match(/\[\?\]/g) || []).length, 2);
});

test('node creation is idempotent per round and finding id (a finalize that stopped before the mark can be repeated)', () => {
  const { repo, proj } = setup();
  const r = raise(repo, [F('n2', 'risk', 'add', 'One')]);
  const fin = close(repo, r.round, verdicts(['f1', 'upheld']));
  const dir = pr.dirOf(proj.id, 'demo');
  const st = pr.readState(dir);
  st.rounds[0].status = 'started';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  const again = cli(repo, ['plan', 'review', 'finalize', 'demo', '--round', '1']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.data.created[0].node_id, fin.created[0].node_id);
  assert.equal((planText(repo).match(/\[\?\]/g) || []).length, 1);
});

test('stable ids: review run gives every step an id and a line reference is not accepted as a node', () => {
  const { repo } = setup();
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), '# Hand\n\n- [ ] First\n- [ ] Second\n');
  const run = cli(repo, ['plan', 'review', 'run', 'demo']).data;
  assert.ok(/id:n1/.test(planText(repo)) && /id:n2/.test(planText(repo)), 'ids written at run time');
  assert.ok(!/\bL\d+\b/.test(fs.readFileSync(run.packet_path, 'utf8')), 'the packet only names ids');
  cli(repo, ['plan', 'review', 'submit', 'demo', '--round', '1'], [F('L3', 'risk', 'change', 'Reworded first')]);
  const flt = cli(repo, ['plan', 'review', 'filter', 'demo']).data;
  assert.equal(flt.kept.length, 0);
  assert.equal(flt.dropped[0].reason, 'unknown-node');
});

test('a step that changed after filtering is never attached to or overwritten', () => {
  const { repo, proj } = setup();
  let r = raise(repo, [F('n5', 'risk', 'change', 'Release with a signed tag'), F('n2', 'risk', 'add', 'Reject past dates')]);
  cli(repo, ['plan', 'review', 'submit', 'demo', '--round', String(r.round), '--kind', 'refutations'], verdicts(['f1', 'upheld'], ['f2', 'upheld']));
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), planText(repo).replace('Release <!--', 'Ship it <!--'));
  const fin = cli(repo, ['plan', 'review', 'finalize', 'demo', '--round', String(r.round)]);
  assert.equal(fin.code, 0, fin.err);
  assert.equal(fin.data.created.length, 1, 'only the proposal whose target is unchanged');
  assert.ok(fin.data.problems.some((p) => /changed since it was reviewed/.test(p)));
  assert.equal(node(repo, proj, 'n5').text, 'Ship it');
  // accept refuses when the target changed after finalize
  r = raise(repo, [F('n3', 'risk', 'change', 'Sort by due date, newest first')]);
  const f2 = close(repo, r.round, verdicts(['f1', 'upheld']));
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), planText(repo).replace('Sort by due date <!--', 'Order by due date <!--'));
  const acc = cli(repo, ['plan', 'accept', 'demo', f2.created[0].node_id]);
  assert.notEqual(acc.code, 0);
  assert.match(acc.err, /changed since/);
  assert.equal(node(repo, proj, 'n3').text, 'Order by due date', 'never overwritten on a mismatch');
  assert.equal(node(repo, proj, f2.created[0].node_id).state, 'proposed');
});
