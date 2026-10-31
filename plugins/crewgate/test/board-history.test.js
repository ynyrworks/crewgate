'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const { createSessionStats } = require('../board/session-stats');
const { createHistory, dayTotals } = require('../board/history');
const { hashId } = require('../board/watcher');
const projects = require('../lib/core/project');
const SM = require('../board/public/sessions-model');

const claudeRoot = h.tmpDir('crew-hist-claude-');
const codexRoot = h.tmpDir('crew-hist-codex-');
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const U = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const ago = (days, hours = 0) => NOW - days * DAY - hours * 3600 * 1000;   // fixed once: mtimes never drift
const iso = (ms) => new Date(ms).toISOString();

// one Claude transcript: a prompt, one Bash call (tokens in/out), at the given time
function claudeFile(file, { cwd, sid, at, prompt = 'PRIVATE PROMPT', tokens = [100, 10], agent = null }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = (ms) => ({ cwd, sessionId: sid, timestamp: iso(ms), ...(agent ? { isSidechain: true, agentId: agent } : {}) });
  fs.writeFileSync(file, jl([
    { ...base(at), type: 'user', message: { role: 'user', content: prompt } },
    { ...base(at + 5000), type: 'assistant', message: { id: `m-${sid}`, role: 'assistant', model: 'claude-opus-x', usage: U(...tokens), content: [{ type: 'tool_use', id: `t-${sid}`, name: 'Bash', input: { command: 'git status' } }] } },
  ]));
  const t = new Date(at + 60000);
  fs.utimesSync(file, t, t);
}

let repo;
let proj;
let board;
let port;
let token;
const get = (p) => h.request(port, { path: p });
const ids = {};

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  const elsewhere = h.tmpDir('crew-hist-else-');
  // inside the project: 2 days ago (with a subagent), 10 days ago; outside any project: 40 days ago and 4 days ago
  const a = path.join(claudeRoot, 'pa', 'sessA.jsonl');
  claudeFile(a, { cwd: repo, sid: 'sessA', at: ago(2, 3) });
  claudeFile(path.join(claudeRoot, 'pa', 'sessA', 'subagents', 'agent-w1.jsonl'), { cwd: repo, sid: 'sessA', at: ago(2, 3) + 1000, agent: 'w1', tokens: [2000, 300], prompt: 'PRIVATE WORKER' });
  claudeFile(path.join(claudeRoot, 'pa', 'sessB.jsonl'), { cwd: repo, sid: 'sessB', at: ago(10, 2) });
  claudeFile(path.join(claudeRoot, 'pb', 'sessC.jsonl'), { cwd: elsewhere, sid: 'sessC', at: ago(40, 5) });
  fs.writeFileSync(path.join(codexRoot, 'rollout.jsonl'), jl([
    { timestamp: iso(ago(4, 1)), type: 'session_meta', payload: { id: 'cx1', cwd: elsewhere } },
    { timestamp: iso(ago(4, 1) + 1000), type: 'event_msg', payload: { type: 'user_message', message: 'codex prompt' } },
    { timestamp: iso(ago(4, 1) + 2000), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } },
  ]));
  const cx = new Date(ago(4, 1) + 60000);
  fs.utimesSync(path.join(codexRoot, 'rollout.jsonl'), cx, cx);
  ids.A = hashId(a);
  ids.W = hashId(path.join(claudeRoot, 'pa', 'sessA', 'subagents', 'agent-w1.jsonl'));
  ids.C = hashId(path.join(claudeRoot, 'pb', 'sessC.jsonl'));
  board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  port = await board.listen(0);
  token = await h.tokenOf(port);
});
test.after(() => board.close());

const setText = (on) => h.post(port, token, '/api/config', { config: { board: { show_text: on } } });

test('range: days limits the list by modification time; the answer states the clamped range', async () => {
  const r7 = (await get('/api/history?days=7')).json;
  assert.equal(r7.sessions.length, 2);   // sessA (its subagent folded in) and the Codex run
  assert.equal(r7.days, 7);
  const r30 = (await get('/api/history?days=30')).json;
  assert.equal(r30.sessions.length, 3);
  const r90 = (await get('/api/history?days=90')).json;
  assert.equal(r90.sessions.length, 4);
  assert.equal((await get('/api/history?days=100000')).json.days, 90, 'days is clamped to 90');
  assert.equal((await get('/api/history')).json.days, 7, 'default is 7 days');
  assert.equal(r90.next, null);
  // newest first
  const times = r90.sessions.map((s) => Date.parse(s.lastActivity));
  assert.deepEqual(times, times.slice().sort((x, y) => y - x));
});

test('subagents are folded into their parent: not listed, counted in totals', async () => {
  const r = (await get('/api/history?days=7')).json;
  assert.ok(!r.sessions.some((s) => s.subagent), 'no subagent rows');
  const a = r.sessions.find((s) => s.id === ids.A);
  assert.equal(a.stats.tool_calls, 1);
  assert.equal(a.totals.sessions, 2);
  assert.equal(a.totals.tool_calls, 2);
  assert.deepEqual(a.totals.tokens, { input: 2100, output: 310, cache_write: 0, cache_read: 0 });
  assert.equal(a.stats.prompts, 1);
  assert.equal(a.project, proj.id);
  assert.equal(a.project_name, 'demo');
  assert.ok(a.started && Date.parse(a.started) < Date.parse(a.lastActivity));
  assert.equal(a.status, 'done');
});

test('paging: limit and the mtime cursor walk the whole range without gaps or repeats', async () => {
  const seen = [];
  let before = '';
  for (let i = 0; i < 10; i++) {
    const r = (await get(`/api/history?days=90&limit=2${before}`)).json;
    assert.ok(r.sessions.length <= 2);
    seen.push(...r.sessions.map((s) => s.id));
    if (r.next === null) break;
    assert.match(r.next, /^\d+-[0-9a-f]{12}$/);
    before = `&before=${encodeURIComponent(r.next)}`;
  }
  const all = (await get('/api/history?days=90')).json.sessions.map((s) => s.id);
  assert.deepEqual(seen, all);
  assert.equal(new Set(seen).size, 4);
});

test('project filter: a project id, or - for sessions outside every project', async () => {
  const mine = (await get(`/api/history?days=90&project=${proj.id}`)).json;
  assert.deepEqual(mine.sessions.map((s) => s.project), [proj.id, proj.id]);
  const none = (await get('/api/history?days=90&project=-')).json;
  assert.equal(none.sessions.length, 2);
  assert.ok(none.sessions.every((s) => s.project === null));
  const bad = (await get('/api/history?days=90&project=../../x')).json;
  assert.equal(bad.sessions.length, 4, 'an invalid id is ignored');
});

test('day totals add up the rows of each day (viewer time zone aware)', async () => {
  const r = (await get('/api/history?days=90&tz=0')).json;
  assert.equal(r.day_totals.reduce((n, d) => n + d.sessions, 0), 4);
  for (const s of r.sessions) assert.match(s.day, /^\d{4}-\d{2}-\d{2}$/);
  const dayA = r.day_totals.find((d) => d.day === r.sessions.find((s) => s.id === ids.A).day);
  assert.equal(dayA.tool_calls, 2);
  assert.equal(dayA.tokens, 2100 + 310);
  // pure: the same instants land on different days for far-apart zones
  const rows = [{ lastActivity: '2026-03-10T23:30:00.000Z', stats: { duration_ms: 1, prompts: 1, tool_calls: 1, tokens: { input: 1, output: 1, cache_write: 0, cache_read: 0 }, cost: null, cost_complete: false, partial: false } }];
  assert.equal(dayTotals(rows, 0)[0].day, '2026-03-10');
  assert.equal(dayTotals(rows, 120)[0].day, '2026-03-11');
});

test('privacy: no path or raw session id; snippets only with board.show_text', async () => {
  let r = await get('/api/history?days=90');
  assert.doesNotMatch(r.text, /PRIVATE|git status|sessA|sessC/);
  assert.ok(!r.text.includes(repo));
  assert.ok(r.json.sessions.every((s) => !('cwd' in s) && !('session' in s) && !('last_prompt' in s) && !('title' in s)));
  assert.equal(r.json.show_text, false);
  assert.ok(r.json.sessions.some((s) => s.folder), 'the folder name is as visible as on the Sessions page (the UI hides it in private mode)');
  await setText(true);
  try {
    r = await get('/api/history?days=90');
    assert.equal(r.json.show_text, true);
    assert.ok(r.json.sessions.some((s) => /PRIVATE PROMPT/.test(s.last_prompt || '')));
    assert.ok(!r.text.includes(repo), 'still no full path');
  } finally { await setText(false); }
  // the UI model only ever removes text
  const row = { folder: 'x', branch: 'b', last_prompt: 'p', title: 't' };
  assert.equal(SM.visible(row, true).prompt, null);
  assert.equal(SM.visible(row, true).folder, null);
  assert.equal(SM.visible(row, false).prompt, 'p');
});

test('#/s/<id> works for a session older than 24 hours (no history request needed first), with its subagent', async () => {
  const r = await get(`/api/session/${ids.C}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.history, true);
  assert.equal(r.json.session.id, ids.C);
  assert.equal(r.json.session.stats.tool_calls, 1);
  assert.ok(r.json.events.some((e) => e.kind === 'tool' && e.tool === 'Bash'), 'the timeline is read from the file');
  assert.ok(!r.text.includes(repo) && !('cwd' in r.json.session));
  const a = await get(`/api/session/${ids.A}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.session.project, proj.id);
  assert.deepEqual(a.json.children.map((c) => c.id), [ids.W]);
  assert.equal(a.json.session.totals.sessions, 2);
  const w = await get(`/api/session/${ids.W}`);
  assert.equal(w.status, 200);
  assert.equal(w.json.session.subagent, true);
  assert.equal(w.json.session.parent, ids.A);
  assert.equal((await get('/api/session/0123456789ab')).status, 404);
});

test('a session of the last 24 hours keeps coming from the live list, not the history', async () => {
  const fresh = path.join(claudeRoot, 'pa', 'fresh.jsonl');
  claudeFile(fresh, { cwd: repo, sid: 'fresh', at: Date.now() - 60000 });
  fs.utimesSync(fresh, new Date(), new Date());
  const r = await get(`/api/session/${hashId(fresh)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.history, undefined);
  fs.rmSync(fresh);
});

test('partial statistics under a tiny byte budget: marked partial, filled in by the next request, never unbounded', async () => {
  const stats = createSessionStats({ budgetBytes: 1, dir: h.tmpDir('crew-hist-cache-') });
  const b2 = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 }, stats });
  const p2 = await b2.listen(0);
  try {
    const partialOf = async () => (await h.request(p2, { path: '/api/history?days=90' })).json.sessions.filter((s) => (s.totals || s.stats).partial).length;
    const first = await partialOf();
    assert.ok(first > 0, `some rows are still counting (${first})`);
    assert.ok(stats.lastRead < 64 * 1024, 'one request parses at most about one file');
    let left = first;
    for (let i = 0; i < 8 && left > 0; i++) left = await partialOf();
    assert.equal(left, 0, 'repeated requests complete the numbers');
    // the number-only rows never carry text
    const r = await h.request(p2, { path: '/api/history?days=90' });
    assert.doesNotMatch(r.text, /PRIVATE/);
  } finally { await b2.close(); }
});

test('bounds: files looked at per request are capped and said so', () => {
  const hist = createHistory({ claudeRoot, codexRoot, maxScan: 2 });
  const pg = hist.page({ days: 90 });
  assert.equal(pg.truncated, true);
  assert.ok(pg.groups.length <= 2);
  const small = createHistory({ claudeRoot, codexRoot, maxExamined: 1 });
  const p1 = small.page({ days: 90 });
  assert.equal(p1.groups.length, 1);
  assert.equal(typeof p1.next, 'string', 'the rest is reachable through the cursor');
  assert.deepEqual(createHistory({}).page({ days: 90 }).groups, [], 'no roots, nothing listed');
  assert.equal(createHistory({ claudeRoot, codexRoot }).session('not-an-id'), null);
});

test('UI model: pages group by day, totals merge across pages, a refetched page does not duplicate rows', () => {
  const row = (id, day) => ({ id, day, stats: { partial: false } });
  const tot = (day, n) => ({ day, sessions: n, duration_ms: 1000 * n, prompts: n, tool_calls: n, tokens: 10 * n, cost: 0.5 * n, cost_complete: true, partial: false });
  const p1 = { rows: [row('a', '2026-03-10'), row('b', '2026-03-09')], totals: [tot('2026-03-10', 1), tot('2026-03-09', 1)] };
  const p2 = { rows: [row('c', '2026-03-09'), row('b', '2026-03-09'), row('d', '2026-03-08')], totals: [tot('2026-03-09', 2), tot('2026-03-08', 1)] };
  const groups = SM.historyGroups([p1, p2]);
  assert.deepEqual(groups.map((g) => [g.day, g.rows.map((r) => r.id)]), [['2026-03-10', ['a']], ['2026-03-09', ['b', 'c']], ['2026-03-08', ['d']]]);
  assert.equal(groups[1].totals.sessions, 3);
  assert.equal(groups[1].totals.cost, 1.5);
  assert.equal(SM.pagePartial({ rows: [{ stats: { partial: true } }] }), true);
  assert.equal(SM.pagePartial({ rows: [{ stats: { partial: false }, totals: { partial: true } }] }), true);
  assert.equal(SM.pagePartial(p1), false);
});

// ---- review fixes

// one-line transcripts with exact (possibly fractional) mtimes in seconds
function tinyRoot(prefix, names, mtimeOf) {
  const root = h.tmpDir(prefix);
  names.forEach((n, i) => {
    const f = path.join(root, 'proj', `${n}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, jl([{ cwd: root, sessionId: n, timestamp: iso(NOW), type: 'user', message: { role: 'user', content: 'x' } }]));
    const s = mtimeOf(i);
    fs.utimesSync(f, s, s);
  });
  return root;
}
function walkAll(hist, query = {}, guard = 50) {
  const seen = [];
  let before;
  for (let i = 0; i < guard; i++) {
    const pg = hist.page({ days: 90, before, ...query });
    seen.push(...pg.groups.map((g) => g.row.id));
    if (pg.next === null) return seen;
    before = pg.next;
  }
  throw new Error('cursor does not advance');
}

test('cursor: fractional mtimes round trip through the HTTP API without repeating page 1', async () => {
  const base = Math.floor(ago(2) / 1000);
  const root = tinyRoot('crew-hist-frac-', ['a', 'b', 'c', 'd', 'e'], (i) => base + i * 100 + 0.123456);
  const b = createBoard({ claudeRoot: root, codexRoot: h.tmpDir('crew-hist-frac-cx-'), watcher: { ttlMs: 0 } });
  const p = await b.listen(0);
  try {
    const seen = [];
    let before = '';
    for (let i = 0; i < 10; i++) {
      const r = (await h.request(p, { path: `/api/history?days=7&limit=2${before}` })).json;
      seen.push(...r.sessions.map((s) => s.id));
      if (r.next === null) break;
      before = `&before=${encodeURIComponent(r.next)}`;
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, 'no repeats');
    // the cursor from older clients (a bare millisecond number) still works
    const r1 = (await h.request(p, { path: '/api/history?days=7&limit=2' })).json;
    const ms = Math.floor(Date.parse(r1.sessions[1].lastActivity));
    const r2 = (await h.request(p, { path: `/api/history?days=7&before=${ms}` })).json;
    assert.ok(r2.sessions.every((s) => Date.parse(s.lastActivity) < ms + 1));
  } finally { await b.close(); }
});

test('cursor: a tie of any size across the examination cap is neither skipped nor repeated', () => {
  const same = Math.floor(ago(2) / 1000);
  const names = Array.from({ length: 13 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const root = tinyRoot('crew-hist-tie-', names, () => same);
  for (const [maxExamined, size] of [[3, 100], [100, 4], [1, 1], [5, 5]]) {
    const seen = walkAll(createHistory({ claudeRoot: root, maxExamined }), { size });
    assert.equal(seen.length, 13, `${maxExamined}/${size}: all sessions`);
    assert.equal(new Set(seen).size, 13, `${maxExamined}/${size}: none twice`);
  }
});

test('listing budget: empty directories and entries are charged, date folders out of range are not opened', () => {
  const root = h.tmpDir('crew-hist-budget-');
  for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(root, `p${i}`, `s${i}`, 'subagents'), { recursive: true });
  const cx = h.tmpDir('crew-hist-budget-cx-');
  const today = new Date();
  const dir = (d) => path.join(cx, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(path.join(cx, '2020', '01', '01'), { recursive: true });
  fs.writeFileSync(path.join(cx, '2020', '01', '01', 'rollout-old.jsonl'), '{}\n');
  fs.mkdirSync(dir(today), { recursive: true });
  fs.writeFileSync(path.join(dir(today), 'rollout-new.jsonl'), '{}\n');
  fs.mkdirSync(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });   // outside the known layout
  const opened = [];
  const real = fs.opendirSync;
  fs.opendirSync = (p, ...rest) => { opened.push(String(p)); return real.call(fs, p, ...rest); };
  try {
    const hist = createHistory({ claudeRoot: root, codexRoot: cx, maxScan: 20 });
    const pg = hist.page({ days: 7 });
    assert.equal(pg.truncated, true);
    assert.ok(opened.filter((p) => p.startsWith(root)).length <= 20, `opened ${opened.length} directories`);
    opened.length = 0;
    const wide = createHistory({ claudeRoot: h.tmpDir('crew-hist-none-'), codexRoot: cx });
    const pg2 = wide.page({ days: 7 });
    assert.equal(pg2.truncated, false);
    assert.ok(pg2.groups.length >= 0);
    assert.ok(!opened.some((p) => p.includes(`${path.sep}2020`)), 'the 2020 date folder is skipped for a 7-day range');
    assert.ok(opened.some((p) => p.endsWith(String(today.getUTCDate()).padStart(2, '0'))), 'today\'s folder is read');
    assert.ok(!opened.some((p) => p.includes('a' + path.sep + 'b' + path.sep + 'c')), 'nothing outside the layout');
  } finally { fs.opendirSync = real; }
});

test('activity time of a session is the newest of the parent and its subagents (list, day and detail agree)', async () => {
  const root = h.tmpDir('crew-hist-eff-');
  const par = path.join(root, 'pe', 'old.jsonl');
  claudeFile(par, { cwd: root, sid: 'old', at: ago(60) });
  const kid = path.join(root, 'pe', 'old', 'subagents', 'agent-k1.jsonl');
  claudeFile(kid, { cwd: root, sid: 'old', at: ago(2), agent: 'k1' });
  const hist = createHistory({ claudeRoot: root });
  const pg = hist.page({ days: 7 });
  assert.equal(pg.groups.length, 1, 'listed in 7 days because of the subagent');
  const want = fs.statSync(kid).mtimeMs;
  assert.ok(Math.abs(Date.parse(pg.groups[0].row.lastActivity) - want) < 1000);
  assert.equal(dayTotals([pg.groups[0].row], 0)[0].day, new Date(want).toISOString().slice(0, 10));
  const det = hist.session(hashId(par));
  assert.ok(Math.abs(Date.parse(det.row.lastActivity) - want) < 1000, 'the detail page agrees');
});

test('show_text switched off elsewhere: cached history pages are detected and dropped', async () => {
  const pages = [{ showText: true, rows: [{ last_prompt: 'x' }] }, { showText: true, rows: [] }];
  assert.equal(SM.textChanged(pages, true), false);
  assert.equal(SM.textChanged(pages, false), true, 'turned off: text must not stay on screen');
  assert.equal(SM.textChanged([{ showText: false }], true), true, 'turned on: refetch to get text');
  assert.equal(SM.textChanged([], false), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'board', 'public', 'app.js'), 'utf8');
  const tick = src.slice(src.indexOf('function histTick'), src.indexOf('function dayLabel'));
  assert.match(tick, /\/api\/meta/, 'every refresh tick asks the board for the current setting');
  assert.match(tick, /textChanged/);
  // server side: the flag follows the setting on each answer
  await setText(true);
  assert.equal((await get('/api/history?days=7')).json.show_text, true);
  await setText(false);
  const off = await get('/api/history?days=7');
  assert.equal(off.json.show_text, false);
  assert.ok(off.json.sessions.every((s) => !('last_prompt' in s)));
});
