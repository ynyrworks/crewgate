'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createUsage, costOf, priceFor, family } = require('../board/usage');

h.setupHome();
const DAY = 86400000;
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const msg = (id, model, u, ts = Date.now()) => ({
  type: 'assistant', uuid: `u-${id}-${u.output_tokens}`, timestamp: new Date(ts).toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ignored text' }], usage: u },
});
const use = (i, o, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

function setup() {
  const claudeRoot = h.tmpDir('crew-u-claude-');
  const codexRoot = h.tmpDir('crew-u-codex-');
  fs.mkdirSync(path.join(claudeRoot, 'proj', 'sess', 'subagents'), { recursive: true });
  return { claudeRoot, codexRoot, main: path.join(claudeRoot, 'proj', 's.jsonl'), sub: path.join(claudeRoot, 'proj', 'sess', 'subagents', 'agent-1.jsonl') };
}

test('Claude usage: per model and day, duplicate message ids counted once (also across files)', () => {
  const s = setup();
  fs.writeFileSync(s.main, jl([
    msg('m1', 'claude-sonnet-4', use(100, 10, 5, 50)),
    msg('m1', 'claude-sonnet-4', use(100, 40, 5, 50)),            // same message logged again, final counters win
    msg('m2', 'claude-opus-4', use(10, 20)),
    { type: 'user', message: { role: 'user', content: 'no usage here' } },
    msg('old', 'claude-sonnet-4', use(1000, 1000), Date.now() - 30 * DAY),   // outside the window
  ]));
  fs.writeFileSync(s.sub, jl([msg('m3', 'claude-haiku-4', use(1, 2)), msg('m2', 'claude-opus-4', use(10, 20))]));
  const u = createUsage(s);
  const r = u.report({ days: 7, prices: {} });
  assert.equal(r.days.length, 7);
  const by = Object.fromEntries(r.models.map((m) => [m.model, m]));
  assert.deepEqual([by['claude-sonnet-4'].input, by['claude-sonnet-4'].output, by['claude-sonnet-4'].cache_write, by['claude-sonnet-4'].cache_read, by['claude-sonnet-4'].messages], [100, 40, 5, 50, 1]);
  assert.equal(by['claude-opus-4'].messages, 1);
  assert.equal(by['claude-haiku-4'].total, 3);
  assert.equal(r.totals.total, 100 + 40 + 5 + 50 + 30 + 3);
  assert.equal(r.totals.messages, 3);
  assert.equal(r.cost_total, null);
  const today = r.daily[r.daily.length - 1];
  assert.equal(today.total, r.totals.total);
  assert.deepEqual(Object.keys(today.families).sort(), ['haiku', 'opus', 'sonnet']);
  assert.ok(!JSON.stringify(r).includes('ignored text'));
});

test('prices come from the caller: longest matching key, partial cost flagged', () => {
  const s = setup();
  fs.writeFileSync(s.main, jl([msg('m1', 'claude-sonnet-4-5', use(1000000, 1000000, 0, 1000000))]));
  const u = createUsage(s);
  const full = u.report({ days: 3, prices: { sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 } } });
  assert.equal(full.cost_total, 18.3);
  assert.equal(full.cost_partial, false);
  const partial = u.report({ days: 3, prices: { sonnet: { input: 3, output: 15 } } });
  assert.equal(partial.cost_total, 18);
  assert.equal(partial.cost_partial, true);
  assert.equal(u.report({ days: 3, prices: { opus: { input: 1, output: 1 } } }).cost_total, null);
  assert.equal(priceFor('claude-sonnet-4-5', { sonnet: { a: 1 }, 'sonnet-4': { a: 2 } }).a, 2);
  assert.deepEqual(costOf({ input: 1, output: 1, cache_write: 0, cache_read: 0 }, null), { cost: null, complete: false });
  assert.equal(family('GPT-5-codex'), 'openai');
  assert.equal(family('mystery'), 'other');
});

test('incremental parsing: appended lines are added, a half-written last line waits, a rewritten file is re-read', () => {
  const s = setup();
  fs.writeFileSync(s.main, jl([msg('m1', 'claude-sonnet-4', use(10, 1))]));
  const u = createUsage(s);
  assert.equal(u.report({ days: 2 }).totals.input, 10);
  const second = JSON.stringify(msg('m2', 'claude-sonnet-4', use(20, 2)));
  fs.appendFileSync(s.main, second.slice(0, 40));
  assert.equal(u.report({ days: 2 }).totals.input, 10, 'partial line is not counted');
  fs.appendFileSync(s.main, `${second.slice(40)}\n`);
  assert.equal(u.report({ days: 2 }).totals.input, 30);
  assert.equal(u.report({ days: 2 }).totals.input, 30, 'repeat call is stable');
  fs.writeFileSync(s.main, jl([msg('z', 'claude-sonnet-4', use(5, 1))]));
  assert.equal(u.report({ days: 2 }).totals.input, 5, 'a smaller file starts over');
});

test('Codex usage: token_count events use the model of the latest turn_context; cached input is split out', () => {
  const s = setup();
  const dir = path.join(s.codexRoot, '2026', '10', '29');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const tc = (last) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { input_tokens: 99999 } } } });
  fs.writeFileSync(path.join(dir, 'rollout.jsonl'), jl([
    { type: 'session_meta', timestamp: ts, payload: { cwd: '/tmp/x' } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-5-codex' } },
    tc({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }),
    tc({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 25 }),
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } },
  ]));
  const r = createUsage(s).report({ days: 2, prices: { 'gpt-5': { input: 1, output: 2, cache_read: 0.5 } } });
  assert.equal(r.models.length, 1);
  const m = r.models[0];
  assert.deepEqual([m.model, m.engine, m.input, m.cache_read, m.output, m.messages], ['gpt-5-codex', 'codex', 1100, 400, 75, 2]);
  assert.equal(r.cost_total, 0.00145);
});

test('missing roots and unreadable data give an empty report', () => {
  const u = createUsage({ claudeRoot: path.join(h.tmpDir('crew-u-'), 'none'), codexRoot: null });
  const r = u.report({ days: 5, prices: null });
  assert.equal(r.models.length, 0);
  assert.equal(r.days.length, 5);
  assert.equal(r.totals.total, 0);
});
