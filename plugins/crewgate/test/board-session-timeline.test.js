'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { timeline, backLines } = require('../board/session-timeline');
const { createSessionStats } = require('../board/session-stats');

h.setupHome();
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const dir = h.tmpDir('crew-tl-');
let seq = 0;
const newFile = () => path.join(dir, `s-${++seq}.jsonl`);
const CWD = path.join(dir, 'repo');
const SECRET_IP = [10, 20, 30, 40].join('.');

const user = (sec, content) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content } });
const result = (sec, id, extra = {}, block = {}) => ({ type: 'user', timestamp: iso(sec), ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...block }] } });
const asst = (sec, content) => ({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', model: 'claude-x', content } });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

function bigSession(n) {
  const objs = [];
  for (let i = 0; i < n; i++) {
    objs.push(user(i * 10, `prompt number ${i}`));
    objs.push(asst(i * 10 + 1, [use(`t${i}`, 'Bash', { command: `echo ${i}` })]));
    objs.push(result(i * 10 + 3, `t${i}`));
  }
  return objs;
}
const claudeOpts = (file, extra = {}) => ({ file, engine: 'claude', cwd: CWD, ...extra });

test('backLines hands out lines newest first with their byte offsets, across chunk boundaries', () => {
  const f = newFile();
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(i * 7) }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const seen = [];
  const r = backLines(f, fs.statSync(f).size, { maxScanBytes: 1e9, chunkBytes: 64, maxLineBytes: 1e6 }, (text, off) => { seen.push([JSON.parse(text).i, off]); return true; });
  assert.equal(r.reachedStart, true);
  assert.deepEqual(seen.map((x) => x[0]), Array.from({ length: 50 }, (_, i) => 49 - i));
  const buf = fs.readFileSync(f);
  for (const [i, off] of seen) assert.equal(buf.subarray(off, off + lines[i].length).toString(), lines[i]);
  // a last line without a newline is a line too
  fs.writeFileSync(f, `${lines[0]}\n${lines[1]}`);
  const got = [];
  backLines(f, fs.statSync(f).size, { maxScanBytes: 1e9, chunkBytes: 16, maxLineBytes: 1e6 }, (t) => { got.push(JSON.parse(t).i); return true; });
  assert.deepEqual(got, [1, 0]);
});

test('timeline: kinds, order, durations and the text gate', () => {
  const f = newFile();
  fs.writeFileSync(f, jl([
    user(0, 'please fix the bug'),
    asst(2, [use('a', 'Bash', { command: `curl ${SECRET_IP} -H x` }), use('b', 'Read', { file_path: path.join(CWD, 'src', 'a.js') })]),
    result(5, 'a'),
    result(9, 'b', {}, { is_error: true }),
    asst(10, [use('g', 'Agent', { subagent_type: 'crewgate:crew-worker', prompt: 'long brief' })]),
    result(40, 'g', { toolUseResult: { agentId: 'ag1', status: 'completed' } }),
  ]));
  const off = timeline(claudeOpts(f));
  assert.deepEqual(off.events.map((e) => e.kind), ['prompt', 'tool', 'tool', 'error', 'subagent', 'subagent']);
  assert.deepEqual(off.events.map((e) => e.ts), [0, 2, 2, 9, 10, 40].map((s) => T0 + s * 1000));
  assert.equal(off.cursor, null);
  const [p, bash, read, err, start, stop] = off.events;
  assert.equal(p.text, undefined, 'no prompt text without show_text');
  assert.equal(bash.tool, 'Bash');
  assert.equal(bash.target, undefined, 'no target without show_text');
  assert.equal(bash.dur_ms, 3000);
  assert.equal(read.err, true);
  assert.equal(err.tool, 'Read', 'the error names the tool that failed');
  assert.equal(start.phase, 'start');
  assert.equal(start.agent_type, undefined);
  assert.equal(start.dur_ms, 30000);
  assert.equal(stop.phase, 'stop');
  const text = JSON.stringify(off);
  assert.ok(!text.includes('please fix') && !text.includes('long brief') && !text.includes(SECRET_IP) && !text.includes('a.js'));

  const on = timeline(claudeOpts(f, { showText: true }));
  assert.equal(on.events[0].text, 'please fix the bug');
  assert.equal(on.events[1].target, 'curl [REDACTED-IP]', 'targets are redacted like the live activity');
  assert.equal(on.events[2].target, 'src/a.js', 'paths are shown relative to the working folder');
  assert.equal(on.events[4].agent_type, 'crewgate:crew-worker');
  assert.ok(!JSON.stringify(on).includes(SECRET_IP));
});

test('paging: pages of N events chain by cursor without gaps or overlap', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(bigSession(150)));   // 450 records, 450 events (prompt + tool per turn + ...)
  const all = timeline(claudeOpts(f, { limit: 200 }));
  assert.equal(all.events.length >= 200 && all.events.length <= 201, true, `${all.events.length}`);
  assert.ok(all.cursor > 0);
  const keys = new Set(all.events.map((e) => e.key));
  let page = all;
  let total = page.events.length;
  let guard = 0;
  while (page.cursor !== null && guard++ < 10) {
    page = timeline(claudeOpts(f, { limit: 200, before: page.cursor, beforeTs: page.cursor_ts }));
    for (const e of page.events) { assert.ok(!keys.has(e.key), `duplicate ${e.key}`); keys.add(e.key); }
    total += page.events.length;
    assert.ok(page.events.length <= 201);
  }
  assert.equal(total, 300, 'prompts and tool calls of all 150 turns');
  // the newest page is the tail of the whole timeline
  const full = timeline(claudeOpts(f, { limit: 200, maxLimit: 100000 }));
  assert.deepEqual(all.events.map((e) => e.key), full.events.slice(-all.events.length).map((e) => e.key));
});

test('paging reads only the bytes it needs; a scan cap stops a page early with a usable cursor', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(bigSession(2000)));
  const size = fs.statSync(f).size;
  const small = timeline(claudeOpts(f, { limit: 20 }));
  assert.ok(small.scanned <= 256 * 1024 && small.scanned < size / 3, `scanned ${small.scanned} of ${size}`);
  assert.ok(small.events.length >= 20);
  // only rare events wanted (every 1000th turn is an error): the cap ends the page, the cursor continues
  const f2 = newFile();
  const objs = [];
  for (let i = 0; i < 3000; i++) objs.push(user(i, 'x'.repeat(300)));
  objs.push(asst(5000, [use('e', 'Bash', { command: 'false' })]), result(5001, 'e', {}, { is_error: true }));
  fs.writeFileSync(f2, jl(objs));
  const capped = timeline(claudeOpts(f2, { kinds: ['error'], maxScanBytes: 100 * 1024, chunkBytes: 32 * 1024 }));
  assert.equal(capped.events.length, 1);
  assert.equal(capped.truncated, true);
  assert.ok(capped.cursor > 0 && capped.scanned <= 100 * 1024 + 32 * 1024);
  const next = timeline(claudeOpts(f2, { kinds: ['error'], before: capped.cursor, maxScanBytes: 100 * 1024, chunkBytes: 32 * 1024 }));
  assert.equal(next.events.length, 0);
  assert.ok(next.cursor < capped.cursor, 'always moves backwards');
});

test('kind filter is applied before the limit', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(bigSession(100)));
  const r = timeline(claudeOpts(f, { kinds: ['prompt'], limit: 30 }));
  assert.equal(r.events.length, 30);
  assert.ok(r.events.every((e) => e.kind === 'prompt'));
  assert.ok(r.cursor > 0);
});

test('a half-written last line does not break the page', () => {
  const f = newFile();
  fs.writeFileSync(f, jl([user(0, 'one'), user(1, 'two')]) + '{"type":"user","timest');
  const r = timeline(claudeOpts(f));
  assert.equal(r.events.length, 2);
});

test('crewgate events for the session are merged by time inside the page span; duplicates of transcript steps are dropped', () => {
  const f = newFile();
  fs.writeFileSync(f, jl([
    user(0, 'go'),
    asst(10, [use('g', 'Agent', { subagent_type: 'x' })]),
    result(50, 'g', { toolUseResult: { agentId: 'ag1' } }),
    user(60, 'next'),
  ]));
  const crew = [
    { ts: iso(5), type: 'task.dispatched', task: 'T1' },
    { ts: iso(10), type: 'subagent.start', agent: 'ag1', task: 'T1' },
    { ts: iso(50), type: 'subagent.stop', agent: 'ag1', task: 'T1' },
    { ts: iso(55), type: 'task.returned', task: 'T1' },
  ];
  const link = (a) => (a === 'ag1' ? 'abcdef012345' : null);
  const r = timeline(claudeOpts(f, { crewEvents: crew, link }));
  assert.deepEqual(r.events.map((e) => `${e.kind}:${e.phase || e.type || ''}`), ['prompt:', 'crew:task.dispatched', 'subagent:start', 'subagent:stop', 'crew:task.returned', 'prompt:']);
  assert.equal(r.events[2].agent, 'abcdef012345', 'the start links to the subagent session');
  assert.equal(r.events[3].agent, 'abcdef012345');
  assert.ok(r.events.every((e, i, a) => i === 0 || e.ts >= a[i - 1].ts));
  const only = timeline(claudeOpts(f, { crewEvents: crew, link, kinds: ['crew'] }));
  assert.deepEqual(only.events.map((e) => e.type), ['task.dispatched', 'task.returned']);
  // an older page only gets the crewgate events inside its span
  const objs = [];
  for (let i = 0; i < 40; i++) objs.push(user(i * 10, 'p'));
  const f2 = newFile();
  fs.writeFileSync(f2, jl(objs));
  const crew2 = [{ ts: iso(15), type: 'a.b' }, { ts: iso(385), type: 'c.d' }];
  const p1 = timeline(claudeOpts(f2, { limit: 10, crewEvents: crew2 }));
  assert.deepEqual(p1.events.filter((e) => e.kind === 'crew').map((e) => e.type), ['c.d']);
  const p2 = timeline(claudeOpts(f2, { limit: 100, before: p1.cursor, beforeTs: p1.cursor_ts, crewEvents: crew2 }));
  assert.deepEqual(p2.events.filter((e) => e.kind === 'crew').map((e) => e.type), ['a.b']);
});

test('Codex rollouts: prompts, tool calls with targets only when allowed, spawn_agent, errors, durations', () => {
  const f = newFile();
  const rec = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });
  fs.writeFileSync(f, jl([
    rec(0, 'session_meta', { id: 'cx', cwd: CWD }),
    rec(1, 'event_msg', { type: 'user_message', message: 'codex prompt text' }),
    rec(2, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', `ping ${SECRET_IP}`] }) }),
    rec(4, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'x' }),
    rec(5, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'c2', arguments: '{}' }),
    rec(6, 'event_msg', { type: 'error', message: 'boom' }),
    rec(7, 'event_msg', { type: 'token_count', info: {} }),
  ]));
  const off = timeline({ file: f, engine: 'codex', cwd: CWD });
  assert.deepEqual(off.events.map((e) => e.kind), ['prompt', 'tool', 'subagent', 'error']);
  assert.equal(off.events[1].dur_ms, 2000);
  assert.ok(!JSON.stringify(off).includes('codex prompt text') && !JSON.stringify(off).includes(SECRET_IP));
  const on = timeline({ file: f, engine: 'codex', cwd: CWD, showText: true });
  assert.equal(on.events[0].text, 'codex prompt text');
  assert.equal(on.events[1].target, 'ping [REDACTED-IP]');
});

test('stats and timeline agree on the prompt and tool counts of the same transcript', () => {
  const f = newFile();
  fs.writeFileSync(f, jl(bigSession(30)));
  const st = fs.statSync(f);
  const stats = createSessionStats({ dir: h.tmpDir('crew-tl-cache-') }).collect([{ id: 'x', file: f, engine: 'claude', size: st.size, mtimeMs: st.mtimeMs }]).get('x');
  const tl = timeline(claudeOpts(f, { limit: 200, maxLimit: 10000 }));
  assert.equal(tl.events.filter((e) => e.kind === 'prompt').length, stats.prompts);
  assert.equal(tl.events.filter((e) => e.kind === 'tool').length, stats.tool_calls);
});
