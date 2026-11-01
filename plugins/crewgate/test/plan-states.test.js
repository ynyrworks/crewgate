'use strict';

// Plan states: a new plan is a draft with four parts, only a user reply makes it final, a legacy plan is left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');
const config = require('../lib/core/config');
const plans = require('../lib/core/plans');

function fixture(gatesCfg = {}) {
  const f = H.fixture({ config: { gates: { enforce: 'confirm', ...gatesCfg } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args, env) => crew(args, f.repo, env === undefined ? f.env : env);
const planPath = (f, slug) => path.join(f.repo, '.crew', 'plans', `${slug}.md`);
const recordPath = (f, slug) => path.join(paths.projectDir(f.pid), 'plans', `${slug}.json`);
const record = (f, slug) => JSON.parse(fs.readFileSync(recordPath(f, slug), 'utf8'));
const stateOf = (f, slug) => plans.stateOf(f.repo, f.pid, slug);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A draft that passes every finalize check.
function ready(f, slug = 'p') {
  const r = run(f, ['plan', 'new', slug, '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(f, ['plan', 'add', slug, 'Write the code']).code, 0);
  return slug;
}
const ask = (f, slug) => {
  const r = run(f, ['--json', 'plan', 'finalize', slug]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
// ask -> a user message -> answer, inside one session
function finalizeWithReply(f, slug) {
  const a = ask(f, slug);
  H.prompt(f);
  return { a, r: run(f, ['plan', 'finalize', slug, '--gate', a.gate_id]) };
}

test('legacy: a plan with no state line parses, shows and updates as before, and its untouched lines stay byte for byte', () => {
  const f = fixture();
  const text = '# Old plan\nSome goal\n\n- [ ] first <!-- id:n1 -->\n- [ ] hand written\n\n## Clarified\n- Q: a A: b (user)\n';
  fs.mkdirSync(path.dirname(planPath(f, 'old')), { recursive: true });
  fs.writeFileSync(planPath(f, 'old'), text);
  const doc = plans.parse(text);
  assert.equal(doc.goal, 'Some goal');
  assert.equal(plans.serialize(doc), text);
  assert.equal(stateOf(f, 'old'), 'legacy');
  const show = JSON.parse(run(f, ['--json', 'plan', 'show', 'old']).out);
  assert.equal(show.state, 'legacy');
  assert.equal(show.goal, 'Some goal');
  assert.match(run(f, ['plan', 'list']).out, /old .*legacy/);
  assert.equal(run(f, ['plan', 'set', 'old', 'n1', 'done']).code, 0);
  const after = fs.readFileSync(planPath(f, 'old'), 'utf8');
  assert.equal(after, text.replace('- [ ] first <!-- id:n1 -->', '- [x] first <!-- id:n1 -->').replace('- [ ] hand written', '- [ ] hand written <!-- id:n2 -->'));
  assert.equal(fs.existsSync(recordPath(f, 'old')), false, 'no record is made for a legacy plan');
  assert.equal(stateOf(f, 'old'), 'legacy');
});

test('a new plan is a draft: state line right after the title, a record outside the repo, the goal is not the state line', () => {
  const f = fixture();
  const r = run(f, ['plan', 'new', 'a', '--title', 'A', '--goal', 'Ship it']);
  assert.equal(r.code, 0, r.err);
  const lines = fs.readFileSync(planPath(f, 'a'), 'utf8').split('\n');
  assert.equal(lines[0], '# A');
  assert.equal(lines[1], '<!-- crew-plan state:draft -->');
  assert.equal(lines[2], 'Ship it');
  assert.equal(record(f, 'a').state, 'draft');
  assert.equal(stateOf(f, 'a'), 'draft');
  const show = JSON.parse(run(f, ['--json', 'plan', 'show', 'a']).out);
  assert.equal(show.state, 'draft');
  assert.equal(show.goal, 'Ship it');
  assert.match(run(f, ['plan', 'show', 'a']).out, /draft/);
  assert.match(run(f, ['plan', 'list']).out, /draft/);
});

test('four parts: --not-doing and --done-when, plan part, both languages read, placed before the steps', () => {
  const f = fixture();
  assert.equal(run(f, ['plan', 'new', 'a', '--title', 'A', '--goal', 'G', '--not-doing', 'No UI', '--done-when', 'Green']).code, 0);
  run(f, ['plan', 'add', 'a', 'Step one']);
  let doc = plans.readCapped(f.repo, 'a');
  assert.equal(doc.notDoing, 'No UI');
  assert.equal(doc.doneWhen, 'Green');
  const text = fs.readFileSync(planPath(f, 'a'), 'utf8');
  assert.ok(text.indexOf('## Not doing') < text.indexOf('- [ ] Step one'));
  assert.ok(text.indexOf('## Done when') < text.indexOf('- [ ] Step one'));
  assert.equal(run(f, ['plan', 'part', 'a', 'not-doing', 'No UI, no CLI']).code, 0);
  assert.equal(run(f, ['plan', 'part', 'a', 'done-when', 'Green and documented']).code, 0);
  doc = plans.readCapped(f.repo, 'a');
  assert.equal(doc.notDoing, 'No UI, no CLI');
  assert.equal(doc.doneWhen, 'Green and documented');
  assert.equal(doc.nodes.length, 1);
  assert.equal((fs.readFileSync(planPath(f, 'a'), 'utf8').match(/## Not doing/g) || []).length, 1);
  const zh = plans.parse('# T\ngoal\n\n## 不做什麼\n不改畫面\n\n## 完成條件\n測試全過\n\n- [ ] s\n');
  assert.equal(zh.notDoing, '不改畫面');
  assert.equal(zh.doneWhen, '測試全過');
  assert.equal(zh.goal, 'goal');
  // a legacy plan gets the section before its steps
  fs.writeFileSync(planPath(f, 'old'), '# Old\ng\n\n- [ ] s <!-- id:n1 -->\n');
  assert.equal(run(f, ['plan', 'part', 'old', 'done-when', 'Soon']).code, 0);
  const old = fs.readFileSync(planPath(f, 'old'), 'utf8');
  assert.ok(old.indexOf('## Done when') < old.indexOf('- [ ] s'));
  assert.equal(stateOf(f, 'old'), 'legacy');
  assert.notEqual(run(f, ['plan', 'part', 'old', 'bogus', 'x']).code, 0);
});

test('finalize refuses and names each problem; it asks nothing then', () => {
  const f = fixture();
  assert.equal(run(f, ['plan', 'new', 'e', '--title', 'E']).code, 0);
  const r = run(f, ['plan', 'finalize', 'e']);
  assert.notEqual(r.code, 0);
  for (const word of [/goal/i, /not doing/i, /done when/i, /no steps/i]) assert.match(r.err, word);
  assert.equal(events.read(f.pid, { types: 'gate.asked' }).length, 0);
  // one problem at a time
  for (const [slug, args, expect] of [
    ['g', ['--not-doing', 'n', '--done-when', 'd'], /goal/i],
    ['n', ['--goal', 'g', '--done-when', 'd'], /not doing/i],
    ['d', ['--goal', 'g', '--not-doing', 'n'], /done when/i],
  ]) {
    assert.equal(run(f, ['plan', 'new', slug, '--title', 'T', ...args]).code, 0);
    run(f, ['plan', 'add', slug, 'step']);
    const x = run(f, ['plan', 'finalize', slug]);
    assert.notEqual(x.code, 0, slug);
    assert.match(x.err, expect);
    assert.equal(x.err.split('\n').filter((l) => /goal|not doing|done when|no steps|assumed/i.test(l)).length, 1, x.err);
  }
  ready(f, 's');
  run(f, ['plan', 'rm', 's', 'n1']);
  const none = run(f, ['plan', 'finalize', 's']);
  assert.notEqual(none.code, 0);
  assert.match(none.err, /no steps/i);
  ready(f, 'q');
  run(f, ['plan', 'clarify', 'q', '--question', 'Which?', '--answer', 'This one', '--by', 'assumed']);
  const as = run(f, ['plan', 'finalize', 'q']);
  assert.notEqual(as.code, 0);
  assert.match(as.err, /assumed/i);
  assert.equal(events.read(f.pid, { types: 'gate.asked' }).length, 0);
  assert.equal(stateOf(f, 'q'), 'draft');
});

test('finalize asks gate plan_final with the slug under the default mode, then a user reply makes the plan final', () => {
  const f = fixture();
  ready(f, 'p');
  const { a, r } = finalizeWithReply(f, 'p');
  const asked = events.read(f.pid, { types: 'gate.asked' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].data.gate, 'plan_final');
  assert.equal(asked[0].data.mode, 'ask');
  assert.match(asked[0].data.detail, /\bp\b/);
  assert.match(JSON.stringify(a), /user/i);
  assert.equal(r.code, 0, r.err);
  assert.equal(stateOf(f, 'p'), 'final');
  const rec = record(f, 'p');
  assert.equal(rec.state, 'final');
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(planPath(f, 'p'), 'utf8').split('\n')[1], /state:final/);
  assert.equal(events.read(f.pid, { types: 'plan.finalized' }).length, 1);
  assert.equal(events.read(f.pid, { types: 'gate.answered' })[0].data.user_turn, true);
  // a clarified line that is not assumed is fine, and a plan with none was fine above
  assert.match(run(f, ['plan', 'show', 'p']).out, /final/);
});

test('no user reply: the answer is refused, with the check on and when the verdict alone is left', () => {
  // a session is known: gates.answer itself refuses, even with gates.require_user_turn false
  const f = fixture({ require_user_turn: false });
  ready(f, 'p');
  const a = ask(f, 'p');
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user must reply in chat first/);
  assert.equal(stateOf(f, 'p'), 'draft');
  assert.equal(events.read(f.pid, { types: 'gate.answered' }).length, 0);
  assert.equal(events.read(f.pid, { types: 'plan.finalized' }).length, 0);
  assert.equal(record(f, 'p').state, 'draft');
});

test('no user reply and no session known: the stored verdict is false, the plan stays a draft', () => {
  const f = fixture({ require_user_turn: false });
  ready(f, 'p');
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', 'p'], {}).out);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id], {});
  assert.notEqual(r.code, 0);
  assert.match(r.err, /user/i);
  assert.equal(stateOf(f, 'p'), 'draft');
  assert.equal(events.read(f.pid, { types: 'plan.finalized' }).length, 0);
});

test('a plan edited after the ask is refused: the user approved that text', () => {
  const f = fixture();
  ready(f, 'p');
  const a = ask(f, 'p');
  assert.equal(run(f, ['plan', 'add', 'p', 'A sneaky extra step']).code, 0);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /changed/i);
  assert.equal(stateOf(f, 'p'), 'draft');
  // asking again for the new text works
  const b = finalizeWithReply(f, 'p');
  assert.equal(b.r.code, 0, b.r.err);
  assert.equal(stateOf(f, 'p'), 'final');
});

test('a gate id that was not asked for this plan is refused', () => {
  const f = fixture();
  ready(f, 'p');
  ready(f, 'q');
  const a = ask(f, 'p');
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'q', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.equal(stateOf(f, 'q'), 'draft');
  assert.notEqual(run(f, ['plan', 'finalize', 'p', '--gate', 'g-nothing']).code, 0);
});

test('a no leaves the plan a draft', () => {
  const f = fixture();
  ready(f, 'p');
  const a = ask(f, 'p');
  assert.equal(run(f, ['gate', 'answer', a.gate_id, 'no']).code, 0);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.notEqual(r.code, 0);
  assert.equal(stateOf(f, 'p'), 'draft');
  const b = finalizeWithReply(f, 'p');
  assert.equal(b.r.code, 0, b.r.err);
});

test('the record beats a hand-edited file; with no record the file decides', () => {
  const f = fixture();
  ready(f, 'p');
  fs.writeFileSync(planPath(f, 'p'), fs.readFileSync(planPath(f, 'p'), 'utf8').replace('state:draft', 'state:final'));
  assert.equal(stateOf(f, 'p'), 'draft');
  const show = run(f, ['plan', 'show', 'p']);
  assert.match(show.out, /draft/);
  assert.match(show.out, /final/);
  assert.match(show.out + show.err, /disagree|differ|does not match/i);
  assert.equal(JSON.parse(run(f, ['--json', 'plan', 'show', 'p']).out).state, 'draft');
  // no record (another machine): the file decides
  fs.rmSync(recordPath(f, 'p'));
  assert.equal(stateOf(f, 'p'), 'final');
  assert.doesNotMatch(run(f, ['plan', 'show', 'p']).out, /disagree|differ|does not match/i);
  assert.equal(stateOf(f, 'nothing-here'), null);
});

test('close: done or parked, after the same user-reply rule; only a final plan can be closed', () => {
  const f = fixture();
  ready(f, 'p');
  assert.notEqual(run(f, ['plan', 'close', 'p', 'done']).code, 0);
  assert.equal(stateOf(f, 'p'), 'draft');
  assert.equal(finalizeWithReply(f, 'p').r.code, 0);
  assert.notEqual(run(f, ['plan', 'close', 'p', 'later']).code, 0);
  // no reply: refused
  const a = JSON.parse(run(f, ['--json', 'plan', 'close', 'p', 'done']).out);
  const bad = run(f, ['plan', 'close', 'p', 'done', '--gate', a.gate_id]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /user must reply in chat first/);
  assert.equal(stateOf(f, 'p'), 'final');
  H.prompt(f);
  const ok = run(f, ['plan', 'close', 'p', 'done', '--gate', a.gate_id]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(stateOf(f, 'p'), 'done');
  assert.match(fs.readFileSync(planPath(f, 'p'), 'utf8').split('\n')[1], /state:done/);
  // parked, from a reopened and finalized plan
  assert.equal(run(f, ['plan', 'reopen', 'p']).code, 0);
  assert.equal(finalizeWithReply(f, 'p').r.code, 0);
  const b = JSON.parse(run(f, ['--json', 'plan', 'close', 'p', 'parked']).out);
  H.prompt(f);
  assert.equal(run(f, ['plan', 'close', 'p', 'parked', '--gate', b.gate_id]).code, 0);
  assert.equal(stateOf(f, 'p'), 'parked');
});

test('reopen puts a plan back to draft and finalizing asks again; adopt turns a legacy plan into a draft', () => {
  const f = fixture();
  ready(f, 'p');
  assert.notEqual(run(f, ['plan', 'reopen', 'p']).code, 0, 'a draft is not reopened');
  const first = finalizeWithReply(f, 'p');
  assert.equal(first.r.code, 0, first.r.err);
  assert.equal(run(f, ['plan', 'reopen', 'p']).code, 0);
  assert.equal(stateOf(f, 'p'), 'draft');
  assert.equal(record(f, 'p').state, 'draft');
  assert.match(fs.readFileSync(planPath(f, 'p'), 'utf8').split('\n')[1], /state:draft/);
  const again = ask(f, 'p');
  assert.notEqual(again.gate_id, first.a.gate_id);
  // the first answer cannot be used again
  const stale = run(f, ['plan', 'finalize', 'p', '--gate', first.a.gate_id]);
  assert.notEqual(stale.code, 0);
  assert.equal(stateOf(f, 'p'), 'draft');

  fs.writeFileSync(planPath(f, 'old'), '# Old\nGoal\n\n- [ ] step <!-- id:n1 -->\n');
  assert.notEqual(run(f, ['plan', 'adopt', 'p']).code, 0, 'only a legacy plan is adopted');
  assert.equal(run(f, ['plan', 'adopt', 'old']).code, 0);
  assert.equal(stateOf(f, 'old'), 'draft');
  assert.equal(record(f, 'old').state, 'draft');
  const lines = fs.readFileSync(planPath(f, 'old'), 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 3), ['# Old', '<!-- crew-plan state:draft -->', 'Goal']);
  assert.equal(plans.readCapped(f.repo, 'old').goal, 'Goal');
});

test('no other command changes the state', () => {
  const f = fixture();
  ready(f, 'p');
  assert.equal(finalizeWithReply(f, 'p').r.code, 0);
  for (const args of [['add', 'p', 'more'], ['clarify', 'p', '--question', 'q', '--answer', 'a'], ['set', 'p', 'n1', 'done'], ['part', 'p', 'done-when', 'new text']]) {
    assert.equal(run(f, ['plan', ...args]).code, 0, args.join(' '));
  }
  assert.equal(stateOf(f, 'p'), 'final');
  assert.match(fs.readFileSync(planPath(f, 'p'), 'utf8').split('\n')[1], /state:final/);
});

test('hash is of the plan text without the state line', () => {
  const f = fixture();
  ready(f, 'p');
  const text = fs.readFileSync(planPath(f, 'p'), 'utf8');
  assert.equal(plans.contentHash(text), plans.contentHash(text.replace('state:draft', 'state:final')));
  assert.equal(plans.contentHash(text), sha(text.replace(/<!-- crew-plan state:draft -->\n/, '')));
  assert.equal(finalizeWithReply(f, 'p').r.code, 0);
  assert.equal(record(f, 'p').hash, plans.contentHash(fs.readFileSync(planPath(f, 'p'), 'utf8')));
});

test('settings plan.interview, plan.enforce and plan.review: enum, off accepted, defaults, both languages, template equal', () => {
  const want = { 'plan.interview': ['on', 'off'], 'plan.enforce': ['block', 'remind', 'off'], 'plan.review': ['large', 'ask', 'off'] };
  const defaults = { 'plan.interview': 'on', 'plan.enforce': 'block', 'plan.review': 'large' };
  for (const [p, values] of Object.entries(want)) {
    const e = config.SCHEMA.find((x) => x.path === p);
    assert.ok(e, p);
    assert.deepEqual(e.enum, values);
    assert.equal(e.default, defaults[p]);
    assert.ok(e.description.en && e.description['zh-TW'], p);
    assert.ok(values.includes('off'));
  }
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'crew.json'), 'utf8'));
  assert.equal(tpl.plan.interview, 'on');
  assert.equal(tpl.plan.enforce, 'block');
  assert.equal(tpl.plan.review, 'large');
  assert.deepEqual(tpl, JSON.parse(JSON.stringify(config.DEFAULTS)));
  // off is accepted by the loader; a value outside the enum is not
  const f = fixture();
  H.writeConfig(f.repo, { plan: { interview: 'off', enforce: 'off', review: 'off' } });
  const ok = config.load(f.repo);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.plan.enforce, 'off');
  H.writeConfig(f.repo, { plan: { enforce: 'maybe' } });
  assert.ok(config.load(f.repo).errors.length > 0);
});
