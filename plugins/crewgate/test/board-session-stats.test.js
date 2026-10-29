'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createSessionStats, sumStats, topTools } = require('../board/session-stats');

h.setupHome();
const root = h.tmpDir('crew-ss-');
let seq = 0;
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const fresh = () => createSessionStats({ dir: h.tmpDir('crew-ss-cache-') });
const entry = (file, engine = 'claude') => { const st = fs.statSync(file); return { id: path.basename(file), file, engine, size: st.size, mtimeMs: st.mtimeMs }; };
const run = (stats, file, engine, prices) => stats.collect([entry(file, engine)], { prices }).get(path.basename(file));
const newFile = (name = 'f') => path.join(root, `${name}-${++seq}.jsonl`);

const user = (sec, content = 'do it', extra = {}) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content }, ...extra });
const result = (sec, id, extra = {}, blockExtra = {}) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...blockExtra }] }, ...extra });
const asst = (sec, id, content, usage, model = 'claude-sonnet-x') => ({ type: 'assistant', timestamp: iso(sec), uuid: `u${sec}`, message: { id, role: 'assistant', model, content, ...(usage ? { usage } : {}) } });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const U = (i, o, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

const claudeLines = () => [
  user(0, 'first prompt'),
  asst(5, 'm1', [use('t1', 'Bash', { command: 'ls' })], U(100, 10, 1000, 0)),
  asst(5, 'm1', [use('t2', 'Read', { file_path: 'a.js' })], U(100, 40, 1000, 0)),   // same message, another block: usage replaced, not added
  result(6, 't1'),
  result(7, 't2', {}, { is_error: true }),
  user(10, [{ type: 'tool_result', tool_use_id: 'x', content: 'skip' }]),
  user(20, 'second prompt'),
  asst(30, 'm2', [use('t3', 'Bash', { command: 'pwd' }), use('t4', 'Agent', { subagent_type: 'crewgate:crew-worker' })], U(50, 20, 0, 2000), 'claude-opus-x'),
  user(40, 'side', { isSidechain: true }),
  { type: 'last-prompt', lastPrompt: 'x' },
];

test('Claude aggregates: duration, prompts, tool counts, subagents, errors and tokens per model', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(claudeLines()));
  const s = run(fresh(), f, 'claude');
  assert.equal(s.duration_ms, 40000);
  assert.equal(s.prompts, 2, 'a tool result, a sidechain line and bookkeeping lines are not prompts');
  assert.deepEqual(s.tools, { Bash: 2, Read: 1, Agent: 1 });
  assert.equal(s.tool_calls, 4);
  assert.equal(s.subagents, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.tokens, { input: 150, output: 60, cache_write: 1000, cache_read: 2000 });
  assert.equal(s.cost, null, 'no prices configured');
  assert.equal(s.partial, false);
});

test('cost: per model from the configured prices; incomplete when a price part is missing', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(claudeLines()));
  const prices = {
    'claude-sonnet': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
    'claude-opus-x': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  };
  const s = run(fresh(), f, 'claude', prices);
  // sonnet: 100*3 + 40*15 + 1000*3.75 = 300 + 600 + 3750 = 4650 ; opus: 50*15 + 20*75 + 2000*1.5 = 750 + 1500 + 3000 = 5250  (per 1e6)
  assert.equal(s.cost, (4650 + 5250) / 1e6);
  assert.equal(s.cost_complete, true);
  const partial = run(fresh(), f, 'claude', { 'claude-sonnet': { input: 3, output: 15 } });
  assert.equal(partial.cost, (300 + 600) / 1e6);
  assert.equal(partial.cost_complete, false, 'cache tokens without a price');
});

test('Codex aggregates: prompts, tool calls, spawn_agent as subagent, tokens by turn model, duplicate token events skipped', () => {
  const f = newFile('codex');
  const rec = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });
  const tc = (sec, last, total) => rec(sec, 'event_msg', { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } });
  fs.writeFileSync(f, jl([
    rec(0, 'session_meta', { id: 'cx1', cwd: '/x' }),
    rec(1, 'turn_context', { model: 'gpt-5-codex', cwd: '/x' }),
    rec(2, 'event_msg', { type: 'user_message', message: 'hello' }),
    rec(3, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["bash","-lc","ls"]}' }),
    rec(4, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'x' }),
    tc(5, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { total_tokens: 1050 }),
    tc(5, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, { total_tokens: 1050 }),   // repeated event
    rec(6, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'c2', arguments: '{}' }),
    rec(7, 'event_msg', { type: 'error', message: 'boom' }),
    tc(9, { input_tokens: 200, cached_input_tokens: 0, output_tokens: 30 }, { total_tokens: 1280 }),
    rec(60, 'event_msg', { type: 'task_complete' }),
  ]));
  const s = run(fresh(), f, 'codex', { 'gpt-5': { input: 10, output: 20, cache_read: 1 } });
  assert.equal(s.duration_ms, 60000);
  assert.equal(s.prompts, 1);
  assert.deepEqual(s.tools, { shell: 1, spawn_agent: 1 });
  assert.equal(s.subagents, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.tokens, { input: 800, output: 80, cache_write: 0, cache_read: 400 });
  assert.equal(s.cost, (800 * 10 + 80 * 20 + 400) / 1e6);
});

test('incremental cache: an append parses only the new bytes and equals a fresh parse', () => {
  const f = newFile();
  const lines = claudeLines();
  fs.writeFileSync(f, jl(lines.slice(0, 5)));
  const stats = fresh();
  run(stats, f, 'claude');
  const firstRead = stats.lastRead;
  assert.equal(firstRead, fs.statSync(f).size);
  const before = fs.statSync(f).size;
  fs.appendFileSync(f, jl(lines.slice(5)));
  const inc = run(stats, f, 'claude');
  assert.equal(stats.lastRead, fs.statSync(f).size - before, 'only the appended bytes were read');
  assert.deepEqual(inc, run(fresh(), f, 'claude'));
  run(stats, f, 'claude');
  assert.equal(stats.lastRead, 0, 'unchanged file: nothing read');
});

test('the cache survives a restart (new instance, same folder) and holds counters only', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(claudeLines().map((o) => (o.type === 'user' && typeof o.message.content === 'string' ? { ...o, message: { ...o.message, content: 'SECRET PROMPT TEXT' } } : o))));
  const dir = h.tmpDir('crew-ss-cache-');
  const a = createSessionStats({ dir });
  const first = run(a, f, 'claude');
  const b = createSessionStats({ dir });
  assert.deepEqual(run(b, f, 'claude'), first);
  assert.equal(b.lastRead, 0, 'a second process reads nothing');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('SECRET PROMPT TEXT'));
});

test('truncation: a file that shrank is rebuilt from the start', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(claudeLines()));
  const stats = fresh();
  run(stats, f, 'claude');
  fs.writeFileSync(f, jl([user(0, 'only'), asst(2, 'z', [use('q', 'Grep')], U(1, 2))]));
  const s = run(stats, f, 'claude');
  assert.deepEqual(s, run(fresh(), f, 'claude'));
  assert.equal(s.prompts, 1);
  assert.deepEqual(s.tools, { Grep: 1 });
});

test('rotation: a different file at the same path (even a bigger one) is not mixed with the old totals', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(claudeLines().slice(0, 3)));
  const stats = fresh();
  run(stats, f, 'claude');
  const other = [user(100, 'brand new session'), user(101, 'another')].concat(claudeLines().map((o) => ({ ...o, timestamp: o.timestamp ? iso(200) : undefined })));
  fs.writeFileSync(f, jl(other));
  assert.ok(fs.statSync(f).size > 500);
  const s = run(stats, f, 'claude');
  assert.deepEqual(s, run(fresh(), f, 'claude'));
  assert.ok(s.prompts >= 3);
});

test('a half-written last line is not counted until it is complete', () => {
  const f = newFile();
  const lines = claudeLines();
  const text = jl(lines.slice(0, 2));
  const cut = JSON.stringify(user(50, 'late prompt'));
  fs.writeFileSync(f, text + cut.slice(0, 20));
  const stats = fresh();
  const a = run(stats, f, 'claude');
  assert.equal(a.prompts, 1);
  fs.appendFileSync(f, cut.slice(20));   // JSON complete, newline still missing: counted now
  assert.equal(run(stats, f, 'claude').prompts, 2);
  fs.appendFileSync(f, '\n');
  const c = run(stats, f, 'claude');
  assert.equal(c.prompts, 2, 'the newline does not double count');
  assert.deepEqual(c, run(fresh(), f, 'claude'));
});

test('malformed and unrelated lines are ignored', () => {
  const f = newFile();
  fs.writeFileSync(f, `not json\n{"type":"user"\n${JSON.stringify({ type: 'queue-operation' })}\n${jl([user(0, 'ok')])}`);
  const s = run(fresh(), f, 'claude');
  assert.equal(s.prompts, 1);
});

test('bounded work: a small budget parses a file over several calls and ends equal to a full parse', () => {
  const f = newFile('big');
  const objs = [];
  for (let i = 0; i < 400; i++) objs.push(user(i * 2, `prompt ${i}`), asst(i * 2 + 1, `m${i}`, [use(`t${i}`, 'Bash', { command: 'x'.repeat(200) })], U(10, 5)));
  fs.writeFileSync(f, jl(objs));
  const size = fs.statSync(f).size;
  const stats = createSessionStats({ dir: h.tmpDir('crew-ss-cache-'), budgetBytes: 20 * 1024, chunkBytes: 4096 });
  let s = run(stats, f, 'claude');
  assert.equal(s.partial, true);
  assert.ok(stats.lastRead < size / 2 && stats.lastRead >= 20 * 1024, `read ${stats.lastRead} of ${size}`);
  let calls = 1;
  while (s.partial && calls < 100) { s = run(stats, f, 'claude'); calls++; }
  assert.ok(calls > 3);
  const full = run(fresh(), f, 'claude');
  assert.deepEqual(s, full);
  assert.equal(full.prompts, 400);
});

test('the budget is shared by all files of one call; newest-first entries are served first', () => {
  const a = newFile('a');
  const b = newFile('b');
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(user(i, `p${i}`.repeat(40)));
  fs.writeFileSync(a, jl(lines));
  fs.writeFileSync(b, jl(lines));
  const stats = createSessionStats({ dir: h.tmpDir('crew-ss-cache-'), budgetBytes: 1, chunkBytes: 1024 });
  const out = stats.collect([entry(a), entry(b)]);
  assert.equal(out.get(path.basename(a)).partial, true, 'progress is guaranteed even with a tiny budget');
  assert.equal(out.get(path.basename(b)).partial, true);
  assert.equal(out.get(path.basename(b)).prompts, 0, 'the second file got no budget in this call');
});

test('a single huge line does not stall progress', () => {
  const f = newFile();
  fs.writeFileSync(f, jl([user(0, 'x'.repeat(200000)), user(1, 'y')]));
  const stats = createSessionStats({ dir: h.tmpDir('crew-ss-cache-'), budgetBytes: 1000, chunkBytes: 4096 });
  let s = run(stats, f, 'claude');
  for (let i = 0; i < 10 && s.partial; i++) s = run(stats, f, 'claude');
  assert.equal(s.prompts, 2);
});

test('performance: big synthetic transcripts are parsed within a bounded budget per call', () => {
  const f = newFile('perf');
  const parts = [];
  const filler = 'z'.repeat(3000);
  const N = 30000;
  for (let i = 0; i < N; i++) {
    parts.push(JSON.stringify(i % 3 === 0 ? user(i, filler) : asst(i, `m${i}`, [use(`t${i}`, i % 2 ? 'Bash' : 'Read', { command: filler.slice(0, 200) })], U(5, 5))));
    if (i % 50 === 0) parts.push(JSON.stringify({ type: 'api-request-blob', blob: filler }));
  }
  fs.writeFileSync(f, parts.join('\n') + '\n');
  const size = fs.statSync(f).size;
  assert.ok(size > 40 * 1024 * 1024, `fixture is ${size} bytes`);
  const stats = createSessionStats({ dir: h.tmpDir('crew-ss-cache-') });
  const t0 = process.hrtime.bigint();
  let s = run(stats, f, 'claude');
  const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(s.partial, true, 'a 40+ MB file does not fit one 8 MB budget');
  assert.ok(stats.lastRead <= 8 * 1024 * 1024 + 2 * 1024 * 1024, `read ${stats.lastRead}`);
  assert.ok(firstMs < 3000, `first bounded call took ${firstMs} ms`);
  let calls = 1;
  while (s.partial && calls < 20) { s = run(stats, f, 'claude'); calls++; }
  const t1 = process.hrtime.bigint();
  run(stats, f, 'claude');
  const idleMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(s.prompts, N / 3);
  assert.ok(idleMs < 50, `unchanged call took ${idleMs} ms`);
  // append a little: only that is parsed
  fs.appendFileSync(f, jl([user(N + 1, 'late')]));
  const t2 = process.hrtime.bigint();
  s = run(stats, f, 'claude');
  const appendMs = Number(process.hrtime.bigint() - t2) / 1e6;
  assert.equal(s.prompts, N / 3 + 1);
  assert.ok(stats.lastRead < 1000 && appendMs < 100, `append read ${stats.lastRead} bytes in ${appendMs} ms`);
  console.log(`# perf: ${(size / 1048576).toFixed(0)} MB file, first call ${firstMs.toFixed(0)} ms (${(stats.options.budgetBytes / 1048576)} MB budget), ${calls} calls to finish, idle ${idleMs.toFixed(1)} ms, append ${appendMs.toFixed(1)} ms`);
});

test('sumStats adds a parent and its subagents; topTools folds the tail into other', () => {
  const f1 = newFile();
  const f2 = newFile();
  fs.writeFileSync(f1, jl(claudeLines()));
  fs.writeFileSync(f2, jl([user(100, 'sub'), asst(130, 'q', [use('s1', 'Edit')], U(1, 1))]));
  const stats = fresh();
  const out = stats.collect([entry(f1), entry(f2)]);
  const total = sumStats([...out.values()]);
  assert.equal(total.tool_calls, 5);
  assert.equal(total.tools.Edit, 1);
  assert.equal(total.tokens.input, 151);
  assert.equal(total.duration_ms, 130000, 'span of the whole group');
  assert.deepEqual(topTools({ a: 5, b: 4, c: 3, d: 2 }, 2), { a: 5, b: 4, other: 5 });
});
