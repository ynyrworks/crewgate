'use strict';

// Plan controls: a change of plan.interview / plan.enforce / plan.review is recorded once at SessionStart; the project
// page and the plan page get each plan's state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./hooks-helpers');
const { crew } = require('./helpers');
const paths = require('../lib/core/paths');
const events = require('../lib/core/events');
const { plansOf, planOf, createApi } =require('../board/api');
const ps = require('../lib/hooks/plan-settings');

const storedFile = (f) => path.join(paths.projectDir(f.pid), 'plan-settings.json');
const changes = (f) => events.read(f.pid, { types: 'config.changed' }).filter((e) => e.data && /^plan\./.test(e.data.key || ''));
const setPlan = (f, plan) => H.writeConfig(f.repo, { plan });

test('plan settings: nothing stored records nothing and stores the current values', () => {
  const f = H.fixture();
  assert.equal(fs.existsSync(storedFile(f)), false);
  H.start(f);
  assert.equal(changes(f).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(storedFile(f), 'utf8')), { interview: 'on', enforce: 'block', review: 'large' });
});

test('plan settings: a changed value is recorded once with key, from, to and src; a second start records nothing', () => {
  const f = H.fixture();
  H.start(f);
  setPlan(f, { enforce: 'off', review: 'large' });
  H.start(f);
  const ev = changes(f);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].src, 'session-start');
  assert.deepEqual({ key: ev[0].data.key, from: ev[0].data.from, to: ev[0].data.to }, { key: 'plan.enforce', from: 'block', to: 'off' });
  H.runHook('session-start', H.base(f, { source: 'resume' }), { cwd: f.repo });
  assert.equal(changes(f).length, 1);
  // two keys at once: one event each
  setPlan(f, { enforce: 'remind', interview: 'off' });
  H.start(f);
  assert.equal(changes(f).length, 3);
});

test('plan settings: a broken stored file does not throw and is replaced without a record', () => {
  const f = H.fixture();
  fs.writeFileSync(storedFile(f), '{not json');
  assert.deepEqual(ps.sync(f.pid, { plan: { interview: 'on', enforce: 'block', review: 'large' } }, 'session-start'), []);
  assert.equal(changes(f).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(storedFile(f), 'utf8')).enforce, 'block');
  const r = H.start(f);
  assert.equal(r.code, 0);
  assert.equal(ps.sync(f.pid, null, 'x').length, 0);
  assert.equal(ps.sync(f.pid, { plan: 5 }, 'x').length, 0);
});

test('plan settings: a save from the board is recorded per key by the board and not again at the next start', () => {
  const f = H.fixture();
  H.start(f);
  setPlan(f, { review: 'ask' });
  assert.deepEqual(ps.sync(f.pid, { plan: { interview: 'on', enforce: 'block', review: 'ask' } }, 'board'), ['review']);
  H.start(f);
  const ev = changes(f);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].src, 'board');
});

test('plan settings: a failed append keeps the old stored value, so the change is recorded at the next start', () => {
  const f = H.fixture();
  H.start(f);
  setPlan(f, { enforce: 'off', review: 'large' });
  const real = events.append;
  events.append = () => { throw new Error('disk full'); };
  try {
    assert.deepEqual(ps.sync(f.pid, { plan: { interview: 'on', enforce: 'off', review: 'large' } }, 'session-start'), []);
  } finally { events.append = real; }
  assert.equal(JSON.parse(fs.readFileSync(storedFile(f), 'utf8')).enforce, 'block');
  assert.equal(changes(f).length, 0);
  H.start(f);
  const ev = changes(f);
  assert.equal(ev.length, 1);
  assert.deepEqual({ key: ev[0].data.key, from: ev[0].data.from, to: ev[0].data.to }, { key: 'plan.enforce', from: 'block', to: 'off' });
});

test('plan settings: the project config POST route records the plan change once with src board; the next start adds nothing', () => {
  const f = H.fixture();
  H.start(f);
  const api = createApi({});
  const r = api.handle({ method: 'POST', path: `/api/project/${f.pid}/config`, body: { config: { plan: { interview: 'on', enforce: 'off', review: 'large' } } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  H.start(f);
  const ev = changes(f);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].src, 'board');
  assert.equal(ev[0].data.key, 'plan.enforce');
  const d = api.handle({ method: 'GET', path: `/api/project/${f.pid}` });
  assert.equal(d.status, 200);
  const ch = d.data.plan_settings.changes;
  assert.equal(ch.length, 1);
  assert.deepEqual({ key: ch[0].key, from: ch[0].from, to: ch[0].to, src: ch[0].src }, { key: 'plan.enforce', from: 'block', to: 'off', src: 'board' });
});

test('plan states: the API returns draft, final, done, parked and legacy for each plan and for the plan page', () => {
  const f = H.fixture();
  H.start(f);
  const env = { CLAUDE_CODE_SESSION_ID: f.sid };
  for (const s of ['a', 'b', 'c', 'd']) {
    const r = crew(['plan', 'new', s, '--title', `Plan ${s}`, '--goal', 'g', '--not-doing', 'n', '--done-when', 'd'], f.repo, env);
    assert.equal(r.code, 0, r.err);
  }
  const dir = path.join(f.repo, '.crew', 'plans');
  const rec = (slug, state) => { fs.mkdirSync(path.join(paths.projectDir(f.pid), 'plans'), { recursive: true }); fs.writeFileSync(path.join(paths.projectDir(f.pid), 'plans', `${slug}.json`), JSON.stringify({ state })); };
  fs.writeFileSync(path.join(dir, 'old.md'), '# Old plan\n\n- [ ] one <!-- id:n1 -->\n');
  rec('b', 'final');
  rec('c', 'done');
  rec('d', 'parked');
  const got = () => Object.fromEntries(plansOf(f.repo, f.pid).map((p) => [p.slug, p.state]));
  assert.deepEqual(got(), { a: 'draft', b: 'final', c: 'done', d: 'parked', old: 'legacy' });
  for (const [slug, st] of Object.entries(got())) assert.equal(planOf(f.repo, f.pid, slug).state, st);
});
