'use strict';

// crew plan edit: changes one step's text. Draft and legacy plans at once; a final plan follows plan.enforce with the kind changed-text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const events = require('../lib/core/events');
const plans = require('../lib/core/plans');

function fixture(enforce = 'block') {
  const f = H.fixture({ config: { gates: { enforce: 'confirm' }, plan: { enforce }, limits: { dispatch_max_cpu: 100 } } });
  H.start(f);
  f.env = { CLAUDE_CODE_SESSION_ID: f.sid };
  return f;
}
const run = (f, args) => crew(args, f.repo, f.env);
const planPath = (f, slug = 'p') => path.join(f.repo, '.crew', 'plans', `${slug}.md`);
const text = (f, slug = 'p') => fs.readFileSync(planPath(f, slug), 'utf8');
const unasked = (f) => events.read(f.pid, {}).filter((e) => e.type === 'plan.drift_unasked');
const changed = (f) => plans.changedSinceApproved(f.repo, f.pid, 'p');

function draft(f) {
  assert.equal(run(f, ['plan', 'new', 'p', '--title', 'Plan P', '--goal', 'Ship it', '--not-doing', 'No rewrite', '--done-when', 'Tests pass']).code, 0);
  assert.equal(run(f, ['plan', 'add', 'p', 'Write the code']).code, 0);
  assert.equal(run(f, ['plan', 'add', 'p', 'Proposed one', '--proposed']).code, 0);
}
function finalPlan(f) {
  draft(f);
  assert.equal(run(f, ['plan', 'reject', 'p', 'n2']).code, 0);
  const a = JSON.parse(run(f, ['--json', 'plan', 'finalize', 'p']).out);
  H.prompt(f);
  const r = run(f, ['plan', 'finalize', 'p', '--gate', a.gate_id]);
  assert.equal(r.code, 0, r.err);
}
function answerChanged(f, kind = 'changed-text') {
  const a = JSON.parse(run(f, ['--json', 'plan', 'drift', 'p', '--kind', kind, '--detail', 'x']).out);
  H.prompt(f);
  const r = run(f, ['plan', 'drift', 'p', '--gate', a.gate_id, '--answer', 'defer', '--text', 'noted']);
  assert.equal(r.code, 0, r.err);
}

test('draft: the text changes at once; id, box, origin and date stay', () => {
  const f = fixture('block');
  draft(f);
  const line = (t) => t.split('\n').find((l) => l.includes('id:n1'));
  const meta = (l) => l.slice(l.indexOf('<!--'));
  const before = line(text(f));
  const r = run(f, ['plan', 'edit', 'p', 'n1', 'Write better code']);
  assert.equal(r.code, 0, r.err);
  console.log(r.out.trim());
  const after = line(text(f));
  assert.match(after, /^- \[ \] Write better code <!--/);
  assert.equal(meta(after), meta(before));
  const z = run(f, ['--lang', 'zh-TW', 'plan', 'edit', 'p', 'n1', 'Write best code']);
  assert.equal(z.code, 0, z.err);
  console.log(z.out.trim());
  assert.match(z.out, /已修改/);
});

test('final under block: refused with the exact command, file unchanged; after an answered changed-text it goes in and nothing reports a change', () => {
  const f = fixture('block');
  finalPlan(f);
  const before = text(f);
  let r = run(f, ['plan', 'edit', 'p', 'n1', 'Write other code']);
  assert.equal(r.code, 1, r.out);
  console.log(r.err.trim());
  assert.match(r.err, /crew plan drift p --kind changed-text --detail "\.\.\."/);
  assert.equal(text(f), before);
  const z = run(f, ['--lang', 'zh-TW', 'plan', 'edit', 'p', 'n1', 'x']);
  assert.equal(z.code, 1);
  console.log(z.err.trim());
  assert.match(z.err, /已定案/);
  assert.equal(text(f), before);
  answerChanged(f, 'new-step');
  assert.equal(run(f, ['plan', 'edit', 'p', 'n1', 'Write other code']).code, 1, 'a new-step answer does not cover a changed text');
  answerChanged(f);
  r = run(f, ['plan', 'edit', 'p', 'n1', 'Write other code']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f), /Write other code/);
  assert.equal(changed(f), false);
  assert.equal(JSON.parse(run(f, ['--json', 'plan', 'show', 'p']).out).state, 'final');
  assert.equal(unasked(f).length, 0);
  H.prompt(f);
  assert.equal(run(f, ['plan', 'edit', 'p', 'n1', 'Again']).code, 1, 'a user message ended the cover');
});

test('final: a hand-edited file stays changed after a covered edit (only a clean file is approved along)', () => {
  const f = fixture('block');
  finalPlan(f);
  answerChanged(f);
  fs.writeFileSync(planPath(f), text(f).replace('Ship it', 'Ship it now'));
  assert.equal(changed(f), true);
  assert.equal(run(f, ['plan', 'edit', 'p', 'n1', 'Edited']).code, 0);
  assert.equal(changed(f), true);
});

test('final under remind: edits, warns and records plan.drift_unasked; under off: edits silently', () => {
  const a = fixture('remind');
  finalPlan(a);
  const r = run(a, ['plan', 'edit', 'p', 'n1', 'Changed']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out + r.err, /without asking/);
  assert.match(text(a), /Changed/);
  const ev = unasked(a);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.kind, 'changed-text');
  const b = fixture('off');
  finalPlan(b);
  const r2 = run(b, ['plan', 'edit', 'p', 'n1', 'Changed']);
  assert.equal(r2.code, 0, r2.err);
  assert.doesNotMatch(r2.out + r2.err, /without asking/);
  assert.equal(unasked(b).length, 0);
});

test('legacy plan: edits at once', () => {
  const f = fixture('block');
  fs.mkdirSync(path.dirname(planPath(f, 'l')), { recursive: true });
  fs.writeFileSync(planPath(f, 'l'), '# Legacy\n\n- [ ] step\n');
  const r = run(f, ['plan', 'edit', 'l', 'L3', 'better step']);
  assert.equal(r.code, 0, r.err);
  assert.match(text(f, 'l'), /- \[ \] better step/);
});

test('refused: a proposed [?] node, an unknown node, empty text; text that would break the file is cleaned to one line', () => {
  const f = fixture('block');
  draft(f);
  const before = text(f);
  let r = run(f, ['plan', 'edit', 'p', 'n2', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.err, /accept/);
  r = run(f, ['plan', 'edit', 'p', 'n9', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.err, /n9/);
  r = run(f, ['plan', 'edit', 'p', 'n1', '   ']);
  assert.equal(r.code, 1);
  assert.equal(text(f), before);
  r = run(f, ['plan', 'edit', 'p', 'n1', 'a\n## Heading <!-- id:n7 --> b']);
  assert.equal(r.code, 0, r.err);
  const lines = text(f).split('\n');
  assert.equal(lines.length, before.split('\n').length, 'no extra line');
  assert.equal(plans.readCapped(f.repo, 'p').nodes.filter((n) => n.meta.id === 'n7').length, 0);
  assert.equal(plans.readCapped(f.repo, 'p').nodes.length, 2);
});
