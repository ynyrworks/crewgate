'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');
const { createWatcher, readClaude, readCodex } = require('../board/watcher');

h.setupHome();
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function fixtureRoots() {
  return { claudeRoot: h.tmpDir('crew-w-claude-'), codexRoot: h.tmpDir('crew-w-codex-') };
}
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
function claudeFile(root, name, objs, extra = '') {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, jl(objs) + extra);
  return f;
}
const user = (cwd, content = 'hi', ts = Date.now()) => ({ type: 'user', cwd, timestamp: iso(ts), message: { role: 'user', content } });
const asst = (cwd, content, stop, ts = Date.now(), model = 'claude-opus-x') => ({ type: 'assistant', cwd, timestamp: iso(ts), message: { role: 'assistant', model, stop_reason: stop, content } });
const text = (s) => ({ type: 'text', text: s });
const tool = () => ({ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} });

function one(roots, opts = {}, call = {}) {
  const w = createWatcher({ ...roots, ttlMs: 0, ...opts });
  const rows = w.sessions(call);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  return rows[0];
}

test('Claude status: tool, waiting, working from the last line', () => {
  const cwd = path.join(h.tmpDir('crew-w-cwd-'), 'my-repo');
  const cases = [
    [[user(cwd), asst(cwd, [text('thinking'), tool()], 'tool_use')], 'tool'],
    [[user(cwd), asst(cwd, [text('done')], 'end_turn')], 'waiting'],
    [[asst(cwd, [text('x')], 'end_turn'), user(cwd, 'next prompt')], 'working'],
    [[asst(cwd, [tool()], 'tool_use'), user(cwd, [{ type: 'tool_result', content: 'ok' }])], 'working'],
    [[asst(cwd, [text('partial')], null)], 'working'],
    [[user(cwd, '[Request interrupted by user]')], 'waiting'],
  ];
  for (const [lines, want] of cases) {
    const roots = fixtureRoots();
    claudeFile(roots.claudeRoot, 's.jsonl', lines);
    const row = one(roots);
    assert.equal(row.status, want, JSON.stringify(lines.map((l) => l.type)));
    assert.equal(row.engine, 'claude');
    assert.equal(row.folder, 'my-repo');
    assert.equal(row.subagent, false);
  }
});

test('status ages: working goes idle, tool outlasts working, waiting turns idle, old files are done', () => {
  const cwd = '/tmp/x';
  const roots = fixtureRoots();
  const f = claudeFile(roots.claudeRoot, 's.jsonl', [user(cwd), asst(cwd, [tool()], 'tool_use')]);
  const t0 = fs.statSync(f).mtimeMs;
  const at = (min) => one(roots, { windowMs: 48 * 60 * MIN }, { now: t0 + min * MIN }).status;
  assert.equal(at(1), 'tool');
  assert.equal(at(10), 'tool');
  assert.equal(at(20), 'idle');
  assert.equal(at(7 * 60), 'done');
  const roots2 = fixtureRoots();
  const f2 = claudeFile(roots2.claudeRoot, 's.jsonl', [user(cwd), asst(cwd, [text('x')], 'end_turn')]);
  const m = fs.statSync(f2).mtimeMs;
  const w = (min) => one(roots2, { windowMs: 48 * 60 * MIN }, { now: m + min * MIN }).status;
  assert.equal(w(30), 'waiting');
  assert.equal(w(90), 'idle');
  const roots3 = fixtureRoots();
  const f3 = claudeFile(roots3.claudeRoot, 's.jsonl', [user(cwd)]);
  const m3 = fs.statSync(f3).mtimeMs;
  const x = (min) => one(roots3, { windowMs: 48 * 60 * MIN }, { now: m3 + min * MIN }).status;
  assert.equal(x(1), 'working');
  assert.equal(x(5), 'idle');
});

test('files outside the time window are not listed', () => {
  const roots = fixtureRoots();
  claudeFile(roots.claudeRoot, 's.jsonl', [user('/tmp/x')]);
  const w = createWatcher({ ...roots, ttlMs: 0 });
  assert.equal(w.sessions({ now: Date.now() + 25 * 60 * MIN }).length, 0);
});

test('subagents: sidechain lines and the subagents folder', () => {
  const roots = fixtureRoots();
  claudeFile(roots.claudeRoot, 'a.jsonl', [{ ...user('/tmp/x'), isSidechain: true }, asst('/tmp/x', [text('x')], 'end_turn')]);
  assert.equal(one(roots).subagent, true);
  const roots2 = fixtureRoots();
  const dir = path.join(roots2.claudeRoot, 'proj', 'sess1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-1.jsonl'), jl([user('/tmp/x'), asst('/tmp/x', [text('x')], 'end_turn')]));
  assert.equal(one(roots2).subagent, true);
});

test('a truncated last line is ignored and the previous state is used', () => {
  const roots = fixtureRoots();
  claudeFile(roots.claudeRoot, 's.jsonl', [user('/tmp/x'), asst('/tmp/x', [text('done')], 'end_turn')], '{"type":"user","cwd":"/tmp/x","message":{"role":"us');
  assert.equal(one(roots).status, 'waiting');
});

test('only the tail of a huge file is read', () => {
  const roots = fixtureRoots();
  const f = path.join(roots.claudeRoot, 'proj', 'big.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const filler = JSON.stringify({ type: 'attachment', cwd: '/tmp/x', pad: 'z'.repeat(1000) }) + '\n';
  const fd = fs.openSync(f, 'w');
  for (let i = 0; i < 8000; i++) fs.writeSync(fd, filler);   // about 8 MB
  fs.writeSync(fd, jl([user('/tmp/x'), asst('/tmp/x', [text('done')], 'end_turn')]));
  fs.closeSync(fd);
  assert.ok(fs.statSync(f).size > 7 * 1024 * 1024);
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...a) => { const n = realRead(...a); bytes += n; return n; };
  try {
    assert.equal(one(roots).status, 'waiting');
  } finally { fs.readSync = realRead; }
  assert.ok(bytes < 200 * 1024, `read ${bytes} bytes`);
});

test('a single line larger than the tail window does not break the scan', () => {
  const roots = fixtureRoots();
  const f = path.join(roots.claudeRoot, 'proj', 'one.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ type: 'user', cwd: '/tmp/big', message: { role: 'user', content: 'q'.repeat(300 * 1024) } }) + '\n');
  const row = one(roots);
  assert.equal(row.folder, 'big', 'cwd comes from the first line');
  assert.ok(['working', 'idle'].includes(row.status));
});

test('Codex status, model, cwd and subagent flag', () => {
  const meta = (source) => ({ type: 'session_meta', timestamp: iso(Date.now()), payload: { cwd: '/tmp/cx-repo', source, base_instructions: { text: 'long '.repeat(2000) } } });
  const ctx = { type: 'turn_context', timestamp: iso(Date.now()), payload: { cwd: '/tmp/cx-repo', model: 'gpt-x' } };
  const ev = (type, p = {}) => ({ type: 'event_msg', timestamp: iso(Date.now()), payload: { type, ...p } });
  const call = { type: 'response_item', timestamp: iso(Date.now()), payload: { type: 'function_call', name: 'shell' } };
  const out = { type: 'response_item', timestamp: iso(Date.now()), payload: { type: 'function_call_output' } };
  const cases = [
    [[meta('cli'), ctx, ev('task_started'), call], 'tool', false],
    [[meta('cli'), ctx, ev('task_started'), call, out], 'working', false],
    [[meta('cli'), ctx, ev('task_started'), ev('task_complete', { last_agent_message: 'bye' })], 'waiting', false],
    [[meta({ subagent: { parent: 'x' } }), ctx, ev('task_started')], 'working', true],
    [[meta('cli'), ctx, ev('task_complete'), ev('token_count', { info: {} })], 'waiting', false],
  ];
  for (const [lines, want, sub] of cases) {
    const roots = fixtureRoots();
    const dir = path.join(roots.codexRoot, '2026', '10', '29');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-1.jsonl'), jl(lines));
    const row = one(roots);
    assert.equal(row.engine, 'codex');
    assert.equal(row.status, want);
    assert.equal(row.subagent, sub);
    assert.equal(row.model, 'gpt-x');
    assert.equal(row.folder, 'cx-repo');
  }
  assert.equal(readCodex([], null).state, null);
  assert.equal(readClaude([]).state, null);
});

test('message text is withheld unless showText is set, and then redacted and shortened', () => {
  const roots = fixtureRoots();
  const reply = `All done. token=abcdef0123456789 ${'x'.repeat(500)}`;
  claudeFile(roots.claudeRoot, 's.jsonl', [user('/tmp/x', 'SECRET PROMPT'), asst('/tmp/x', [text(reply)], 'end_turn')]);
  const w = createWatcher({ ...roots, ttlMs: 0 });
  const plain = w.sessions();
  assert.equal(plain[0].text, undefined);
  assert.ok(!JSON.stringify(plain).includes('SECRET PROMPT'));
  const shown = w.sessions({ showText: true });
  assert.match(shown[0].text, /^All done\./);
  assert.ok(shown[0].text.length <= 200);
  assert.doesNotMatch(shown[0].text, /abcdef0123456789/);
  assert.ok(!JSON.stringify(shown).includes('SECRET PROMPT'));
});

test('sessions link to projects through the resolver and survive resolver errors', () => {
  const roots = fixtureRoots();
  claudeFile(roots.claudeRoot, 's.jsonl', [user('/tmp/x'), asst('/tmp/x', [text('x')], 'end_turn')]);
  assert.equal(one(roots, {}, { resolveProject: () => ({ id: 'p0123456789' }) }).project, 'p0123456789');
  assert.equal(one(roots, {}, { resolveProject: () => { throw new Error('boom'); } }).project, null);
});

test('missing roots give an empty list', () => {
  const w = createWatcher({ claudeRoot: path.join(h.tmpDir('crew-w-'), 'nope'), codexRoot: null, ttlMs: 0 });
  assert.deepEqual(w.sessions(), []);
});
