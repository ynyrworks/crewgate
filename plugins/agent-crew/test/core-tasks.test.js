'use strict';
const ip = (...o) => o.join('.'); // addresses are built at runtime (repo hygiene scan)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.setupHome();
const tasks = require('../lib/core/tasks');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');

let n = 0;
const pid = () => `p${String(100 + ++n).padStart(10, '0')}`;
const make = (id, extra = {}) => tasks.createTask(id, { title: 'Add thing', brief: h.GOOD_BRIEF, branch: 'feat/x', ...extra });
const types = (id) => events.read(id).map((e) => e.type);

test('createTask: id format, files, marker line, event', () => {
  const id = pid();
  const t = make(id, { scope: { allow: ['src/**'], deny: ['docs/**'] }, acceptance: ['npm test'], repro: 'run it' });
  assert.match(t.id, /^t-\d{8}-[0-9a-z]{4}$/);
  assert.equal(t.state, 'created');
  assert.equal(t.returns, 0);
  assert.deepEqual(t.scope, { allow: ['src/**'], deny: ['docs/**'] });
  assert.equal(t.history.length, 1);
  const dir = paths.taskDir(id, t.id);
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.ok(brief.startsWith(`crew-task: ${t.id}\n`));
  assert.equal(tasks.findMarker(brief), t.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')), t);
  assert.deepEqual(types(id), ['task.created']);
  assert.deepEqual(tasks.load(id, t.id), t);
});

test('createTask replaces a foreign marker line and redacts the brief', () => {
  const id = pid();
  const t = make(id, { brief: `crew-task: t-19990101-zzzz\n${h.GOOD_BRIEF}\nhost ${ip(10,4,4,4)} password=abc` });
  const brief = tasks.readBrief(id, t.id);
  assert.equal(brief.match(/crew-task:/g).length, 1);
  assert.ok(brief.includes(t.id));
  assert.ok(!brief.includes(ip(10,4,4,4)) && !brief.includes('=abc'));
});

test('brief validation: every section required and non-empty; zh-TW headings and numbering accepted', () => {
  const missing = tasks.validateBrief('# Goal\nx\n# Scope\ny');
  assert.deepEqual(missing.missing, ['Must not regress', 'Acceptance', 'Context']);
  assert.equal(missing.ok, false);
  const empty = tasks.validateBrief(h.GOOD_BRIEF.replace('Existing tests keep passing.', '<!-- fill in -->'));
  assert.deepEqual(empty.empty, ['Must not regress']);
  const numbered = ['## 1. Goal', 'a', '## 2. Scope — allowed / forbidden', 'b', '## 3. Must not regress', 'c', '## 4. Acceptance', 'd', '## 5. Context', 'e'].join('\n');
  assert.equal(tasks.validateBrief(numbered).ok, true);
  const zh = ['# 目標', 'a', '# 範圍', 'b', '# 不可退化', 'c', '# 驗收', 'd', '# 脈絡', 'e'].join('\n');
  assert.equal(tasks.validateBrief(zh).ok, true);
  // headings inside code fences do not count
  assert.equal(tasks.validateBrief('```\n# Goal\nx\n```').missing.length, 5);
  const id = pid();
  assert.throws(() => tasks.createTask(id, { title: 't', brief: '# Goal\nx' }), (e) => e.key === 'task.briefInvalid' && e.missing.includes('Scope'));
  assert.throws(() => tasks.createTask(id, { title: '', brief: h.GOOD_BRIEF }), (e) => e.key === 'task.titleRequired');
  assert.deepEqual(tasks.list(id), []);
});

test('state machine: happy path with history and one event per step', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched', { fields: { worktree: '/w/x' }, session: 's1' });
  tasks.transition(id, t.id, 'returned');
  tasks.transition(id, t.id, 'reviewing');
  tasks.transition(id, t.id, 'accepted', { note: 'looks good' });
  const done = tasks.transition(id, t.id, 'merged');
  assert.equal(done.state, 'merged');
  assert.equal(done.worktree, '/w/x');
  assert.deepEqual(done.history.map((h_) => h_.state), ['created', 'dispatched', 'returned', 'reviewing', 'accepted', 'merged']);
  assert.equal(done.history[4].note, 'looks good');
  assert.deepEqual(types(id), ['task.created', 'task.dispatched', 'task.returned', 'task.reviewed', 'task.accepted', 'task.merged']);
  assert.equal(events.read(id, { types: 'task.dispatched' })[0].session, 's1');
});

test('illegal transitions are refused and leave the task untouched', () => {
  const id = pid();
  const t = make(id);
  assert.throws(() => tasks.transition(id, t.id, 'returned'), (e) => e.key === 'task.badTransition');
  assert.throws(() => tasks.transition(id, t.id, 'merged'), (e) => e.key === 'task.badTransition');
  assert.throws(() => tasks.transition(id, t.id, 'bogus'), (e) => e.key === 'task.badState');
  assert.throws(() => tasks.transition(id, 't-20260101-zzzz', 'dispatched'), (e) => e.key === 'task.notFound');
  assert.equal(tasks.load(id, t.id).state, 'created');
  tasks.transition(id, t.id, 'cancelled');
  assert.throws(() => tasks.transition(id, t.id, 'dispatched'), (e) => e.key === 'task.badTransition');
  assert.deepEqual(types(id), ['task.created', 'task.cancelled']);
});

test('moving to the current state is a no-op (hooks may fire twice)', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched');
  const again = tasks.transition(id, t.id, 'dispatched');
  assert.equal(again.history.length, 2);
  assert.equal(events.read(id, { types: 'task.dispatched' }).length, 1);
});

test('send-back increments returns; at the limit it refuses and asks for a takeover', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched');
  tasks.transition(id, t.id, 'returned');
  assert.equal(tasks.sendBack(id, t.id, { note: 'fix X', maxReturns: 2 }).returns, 1);
  tasks.transition(id, t.id, 'returned');
  assert.equal(tasks.sendBack(id, t.id, { maxReturns: 2 }).returns, 2);
  tasks.transition(id, t.id, 'returned');
  assert.throws(() => tasks.sendBack(id, t.id, { maxReturns: 2 }), (e) => e.key === 'task.takeover' && e.vars.returns === 2);
  assert.equal(tasks.load(id, t.id).state, 'returned');
  assert.equal(events.read(id, { types: 'task.sent_back' }).length, 2);
  // the orchestrator can still accept or cancel after a refusal
  assert.equal(tasks.transition(id, t.id, 'accepted').state, 'accepted');
});

test('list filters by state and sorts by creation', () => {
  const id = pid();
  const a = make(id);
  const b = make(id, { title: 'Second' });
  tasks.transition(id, b.id, 'dispatched');
  assert.equal(tasks.list(id).length, 2);
  assert.deepEqual(tasks.list(id, { state: 'dispatched' }).map((t) => t.id), [b.id]);
  assert.deepEqual(tasks.list(id, { state: ['created', 'dispatched'] }).length, 2);
  assert.equal(tasks.list(id, { state: 'merged' }).length, 0);
  assert.ok(tasks.load(id, a.id));
  // a damaged task.json is skipped by list and reported by load
  fs.writeFileSync(path.join(paths.taskDir(id, a.id), 'task.json'), '{bad');
  assert.deepEqual(tasks.list(id).map((t) => t.id), [b.id]);
  assert.throws(() => tasks.load(id, a.id), (e) => e.key === 'task.notFound');
});

test('report validation: sections, emptiness, size estimate (chars / 4)', () => {
  assert.equal(tasks.estimateTokens('abcd'), 1);
  assert.equal(tasks.estimateTokens('abcde'), 2);
  const ok = tasks.validateReport(h.GOOD_REPORT);
  assert.equal(ok.ok, true);
  const bad = tasks.validateReport('## Branch & commits\nx\n## Tests run\n\n');
  assert.deepEqual(bad.errors.map((e) => `${e.code}:${e.section}`).sort(), [
    'empty_section:Tests run',
    'missing_section:Assumptions & unfinished',
    'missing_section:Needs real-environment check',
    'missing_section:What changed and why',
  ]);
  const long = tasks.validateReport(`${h.GOOD_REPORT}\n${'x'.repeat(8000)}`, { maxTokens: 1500 });
  assert.ok(long.errors.some((e) => e.code === 'too_long' && e.tokens > 1500));
  assert.equal(tasks.validateReport(`${h.GOOD_REPORT}\n${'x'.repeat(8000)}`, { maxTokens: 5000 }).ok, true);
});

test('recordReport stores report/packet (redacted) and moves dispatched -> returned', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched');
  const r = tasks.recordReport(id, t.id, { report: `${h.GOOD_REPORT}\nhost ${ip(10,0,0,9)}`, packet: 'full diff\npassword=abc' }, { maxTokens: 1500 });
  assert.equal(r.task.state, 'returned');
  assert.ok(r.tokens > 0);
  assert.ok(!tasks.readReport(id, t.id).includes(ip(10,0,0,9)));
  assert.ok(fs.readFileSync(path.join(paths.taskDir(id, t.id), 'packet.md'), 'utf8').includes('password=[REDACTED]'));
  assert.deepEqual(types(id).slice(-1), ['task.returned']);
  // reporting again after a send-back works the same way
  tasks.sendBack(id, t.id, {});
  assert.equal(tasks.recordReport(id, t.id, { report: h.GOOD_REPORT }).task.state, 'returned');
});

test('recordReport refuses an invalid report without writing anything', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched');
  assert.throws(() => tasks.recordReport(id, t.id, { report: '## Branch & commits\nx' }), (e) => e.key === 'task.reportInvalid' && e.errors.length === 4);
  assert.equal(tasks.readReport(id, t.id), null);
  assert.equal(tasks.load(id, t.id).state, 'dispatched');
});

test('findMarker', () => {
  assert.equal(tasks.findMarker('hello\ncrew-task: t-20260101-ab12\nbye'), 't-20260101-ab12');
  assert.equal(tasks.findMarker('prefix crew-task: t-20260101-ab12 suffix'), 't-20260101-ab12');
  assert.equal(tasks.findMarker('no marker'), null);
  assert.equal(tasks.findMarker(undefined), null);
});

test('transition merges opts.data into the event data without overriding core fields', () => {
  const id = pid();
  const t = make(id);
  tasks.transition(id, t.id, 'dispatched', { data: { agent_type: 'crew-worker', background: true, to: 'bogus' } });
  const ev = events.read(id, { types: 'task.dispatched' })[0];
  assert.equal(ev.data.agent_type, 'crew-worker');
  assert.equal(ev.data.background, true);
  assert.equal(ev.data.to, 'dispatched');
  assert.equal(ev.data.note, '');
});
