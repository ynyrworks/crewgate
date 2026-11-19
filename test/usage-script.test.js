'use strict';

// scripts/collect-usage-data.js: --stats numbers, the transcript filter, no output inside a git work tree.
// Everything runs on small stand-in folders; the real home folders are never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'collect-usage-data.js');
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const tmp = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };

function run(args, o = {}) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: fs.realpathSync.native(os.tmpdir()), ...o.env };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: o.cwd || os.tmpdir(), env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const ev = (type, data = {}, task) => JSON.stringify({ type, ts: data.ts || '2026-11-01T10:00:00.000Z', ...(task ? { task } : {}), data });
const T = (m) => `2026-11-01T10:${m}:00.000Z`;

// A data folder with one project holding events of every counted type.
function makeData() {
  const home = tmp('ug-home-');
  const pdir = path.join(home, 'projects', 'p1');
  fs.mkdirSync(pdir, { recursive: true });
  const lines = [
    ev('gate.asked', { id: 'g1', gate: 'merge' }), ev('gate.asked', { id: 'g2', gate: 'merge' }), ev('gate.asked', { id: 'g3', gate: 'push' }),
    ev('gate.answered', { id: 'g1', gate: 'merge', answer: 'yes' }), ev('gate.answered', { id: 'g2', gate: 'merge', answer: 'no' }),
    ev('gate.refused', { id: 'g3', gate: 'push', reason: 'no_user_turn' }), ev('gate.refused', { id: 'g3', gate: 'push', reason: 'other' }),
    ev('gate.missing', { gate: 'push' }), ev('gate.missing', { gate: 'push' }), ev('gate.missing', { gate: 'merge' }),
    ev('plan.drift_asked', { kind: 'outside' }), ev('plan.drift_asked', { kind: 'changed' }),
    ev('plan.drift_answered', { kind: 'outside', answer: 'add' }), ev('plan.drift_answered', { kind: 'outside', answer: 'skip' }),
    ev('lesson.added', {}), ev('lesson.added', {}), ev('lesson.promoted', {}),
    ev('plan.created', {}), ev('plan.created', {}), ev('plan.finalized', {}), ev('plan.closed', {}),
    // t1: accepted with no review round at all
    ev('task.accepted', {}, 't1'),
    // t2: reviewed (round 1), sent back, accepted with no later round
    ev('task.reviewed', { note: 'review round 1', ts: T('01') }, 't2'), ev('task.sent_back', { ts: T('02') }, 't2'), ev('task.accepted', { ts: T('03') }, 't2'),
    // t3: sent back, then a later round 2, accepted: counted in neither
    ev('task.sent_back', { ts: T('01') }, 't3'), ev('task.reviewed', { note: 'review round 2', ts: T('02') }, 't3'), ev('task.accepted', { ts: T('03') }, 't3'),
    // t4: not accepted
    ev('task.reviewed', { note: 'review round 1' }, 't4'),
    'not json at all',
  ];
  fs.writeFileSync(path.join(pdir, 'events.jsonl'), `${lines.join('\n')}\n`);
  for (const [t, round] of [['t2', 1], ['t3', 2], ['t4', 1]]) {
    const d = path.join(pdir, 'tasks', t, 'findings');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${round}.json`), '[]');
  }
  fs.writeFileSync(path.join(home, 'accounts.json'), '{"secret":"x"}');
  return home;
}

test('--stats --json counts every type from the data folder alone and copies nothing', () => {
  const home = makeData();
  const cwd = tmp('ug-cwd-');
  const r = run(['--stats', '--json'], { env: { CREWGATE_HOME: home }, cwd });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  const c = j.total;
  assert.equal(c.gate_refused_no_user_turn, 1);
  assert.deepEqual(c.gate_missing, { total: 3, by_gate: { push: 2, merge: 1 } });
  assert.deepEqual(c.gates.merge, { asked: 2, yes: 1, no: 1 });
  assert.deepEqual(c.gates.push, { asked: 1, yes: 0, no: 0 });
  assert.equal(c.drift.asked, 2);
  assert.deepEqual(c.drift.answers_by_kind, { outside: { add: 1, skip: 1 } });
  assert.equal(c.tasks_accepted, 3);
  assert.equal(c.tasks_accepted_no_review_round, 1);
  assert.equal(c.tasks_accepted_after_send_back_no_later_round, 1);
  assert.deepEqual(c.lessons, { added: 2, promoted: 1 });
  assert.deepEqual(c.plans, { created: 2, finalized: 1, closed: 1 });
  assert.deepEqual(Object.values(j.machines), [c]);
  assert.deepEqual(fs.readdirSync(cwd), [], 'nothing is written');
  assert.match(run(['--stats'], { env: { CREWGATE_HOME: home }, cwd }).out, /gate merge: asked \/ yes \/ no\s+2 \/ 1 \/ 1/);
});

test('--stats FOLDER... reads collected folders, one column per machine and a total', () => {
  const home = makeData();
  const cwd = tmp('ug-cwd-');
  const outA = path.join(cwd, 'crewgate-data-aa-1');
  const outB = path.join(cwd, 'crewgate-data-bb-1');
  for (const out of [outA, outB]) {
    const r = run(['--no-transcripts', '--out', out], { env: { CREWGATE_HOME: home, CLAUDE_CONFIG_DIR: tmp('ug-claude-') }, cwd });
    assert.equal(r.code, 0, r.err);
  }
  fs.writeFileSync(path.join(outB, 'summary.json'), '{"machine":"other-box"}');
  assert.ok(!fs.existsSync(path.join(outA, 'crewgate', 'accounts.json')), 'accounts.json is left out');
  const j = JSON.parse(run(['--stats', '--json', outA, outB], { cwd }).out);
  assert.equal(Object.keys(j.machines).length, 2);
  assert.ok(j.machines['other-box']);
  assert.equal(j.total.gate_missing.total, 6);
  assert.equal(j.total.tasks_accepted_no_review_round, 2);
  assert.match(run(['--stats', outA, outB], { cwd }).out.split('\n')[0], /other-box\s+total$/);
});

// A registered project with a Claude projects folder holding two sessions.
function makeTranscripts() {
  const home = tmp('ug-home-');
  const claude = tmp('ug-claude-');
  const proj = tmp('ug-proj-');
  fs.mkdirSync(path.join(home, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { p1: { name: 'demo', path: proj } } }));
  const enc = proj.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(claude, 'projects', enc);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mentions.jsonl'), '{"text":"run crewgate:crew now"}\n');
  fs.writeFileSync(path.join(dir, 'plain.jsonl'), '{"text":"nothing relevant"}\n');
  return { home, claude, enc };
}

test('transcript filter: a session that mentions the plugin is copied, one that does not is not; --no-transcripts copies none', () => {
  const { home, claude, enc } = makeTranscripts();
  const cwd = tmp('ug-cwd-');
  const env = { CREWGATE_HOME: home, CLAUDE_CONFIG_DIR: claude };
  const a = run(['--out', path.join(cwd, 'with')], { env, cwd });
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /full conversation text.*--no-transcripts/);
  assert.match(a.out, /About to copy [\d.]+ MB/);
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'with', 'transcripts', enc)), ['mentions.jsonl']);
  const b = run(['--no-transcripts', '--out', path.join(cwd, 'without')], { env, cwd });
  assert.equal(b.code, 0, b.err);
  assert.ok(!fs.existsSync(path.join(cwd, 'without', 'transcripts')));
});

test('output is never made inside a git work tree unless --out is given', () => {
  const { home, claude } = makeTranscripts();
  const repo = tmp('ug-repo-');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const plain = tmp('ug-plain-');
  const base = { CREWGATE_HOME: home, CLAUDE_CONFIG_DIR: claude };
  const where = (d) => ({ HOME: d, USERPROFILE: d, TMPDIR: d, TEMP: d, TMP: d });
  const inRepo = () => fs.readdirSync(repo).filter((n) => n !== '.git');
  // current folder in a repo, home outside: the default moves to home
  const moved = run(['--no-transcripts'], { env: { ...base, ...where(plain) }, cwd: repo });
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.out, /inside a git work tree/);
  assert.ok(fs.readdirSync(plain).some((n) => n.startsWith('crewgate-data-')));
  assert.deepEqual(inRepo(), []);
  // everything inside a repo: refused, nothing written
  const refused = run(['--no-transcripts'], { env: { ...base, ...where(repo) }, cwd: repo });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Refusing/);
  assert.deepEqual(inRepo(), []);
  // --out given: allowed
  const explicit = run(['--no-transcripts', '--out', path.join(repo, 'here')], { env: { ...base, ...where(repo) }, cwd: repo });
  assert.equal(explicit.code, 0, explicit.err);
  assert.match(explicit.out, /Wrote folder:/);
});

// Rounds with no "review round" event: t5 finalized (file time) before its send-back, t6 after it.
test('--stats on a collected folder uses the recorded round times, not the copy file times; unrecorded counts as unknown', () => {
  const home = tmp('ug-home-');
  const pdir = path.join(home, 'projects', 'p1');
  const lines = [
    ev('task.sent_back', { ts: T('02') }, 't5'), ev('task.accepted', { ts: T('03') }, 't5'),
    ev('task.sent_back', { ts: T('02') }, 't6'), ev('task.accepted', { ts: T('06') }, 't6'),
  ];
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'events.jsonl'), `${lines.join('\n')}\n`);
  for (const [t, m] of [['t5', '01'], ['t6', '05']]) {
    const f = path.join(pdir, 'tasks', t, 'findings', '1.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '[]');
    const d = new Date(T(m));
    fs.utimesSync(f, d, d);
  }
  const live = JSON.parse(run(['--stats', '--json'], { env: { CREWGATE_HOME: home }, cwd: tmp('ug-cwd-') }).out).total;
  assert.equal(live.tasks_accepted_after_send_back_no_later_round, 1);

  const cwd = tmp('ug-cwd-');
  const out = path.join(cwd, 'crewgate-data-cc-1');
  const r = run(['--no-transcripts', '--out', out], { env: { CREWGATE_HOME: home, CLAUDE_CONFIG_DIR: tmp('ug-claude-') }, cwd });
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - fs.statSync(path.join(out, 'crewgate', 'projects', 'p1', 'tasks', 't5', 'findings', '1.json')).mtimeMs > 60 * 60 * 1000, 'copy keeps the file time');
  // make the copy's file times the time of the copy, as after unpacking without them
  for (const t of ['t5', 't6']) fs.utimesSync(path.join(out, 'crewgate', 'projects', 'p1', 'tasks', t, 'findings', '1.json'), new Date(), new Date());
  const c = JSON.parse(run(['--stats', '--json', out], { cwd }).out).total;
  assert.equal(c.tasks_accepted_after_send_back_no_later_round, 1);
  assert.equal(c.tasks_accepted_send_back_unknown, 0);

  const sp = path.join(out, 'summary.json');
  const sum = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete sum.finalized_rounds;
  fs.writeFileSync(sp, JSON.stringify(sum));
  const u = JSON.parse(run(['--stats', '--json', out], { cwd }).out).total;
  assert.equal(u.tasks_accepted_after_send_back_no_later_round, 0);
  assert.equal(u.tasks_accepted_send_back_unknown, 2);
  assert.match(run(['--stats', out], { cwd }).out, /round time unknown[^\n]*\s2\b/);
});

// Rounds finalized by crew review finalize carry a review.finalized event: its place in the log decides, not the file time.
test('--stats: the review.finalized event decides whether a round came after the send-back, whatever the file time says', () => {
  const stats = (lines, mtime) => {
    const home = tmp('ug-home-');
    const pdir = path.join(home, 'projects', 'p1');
    fs.mkdirSync(path.join(pdir, 'tasks', 't7', 'findings'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'events.jsonl'), `${lines.join('\n')}\n`);
    const f = path.join(pdir, 'tasks', 't7', 'findings', '1.json');
    fs.writeFileSync(f, '[]');
    fs.utimesSync(f, new Date(T(mtime)), new Date(T(mtime)));
    return JSON.parse(run(['--stats', '--json'], { env: { CREWGATE_HOME: home }, cwd: tmp('ug-cwd-') }).out).total;
  };
  // finalized after the send-back (same millisecond, later in the log), file time before it: a later round
  const after = stats([ev('task.sent_back', { ts: T('02') }, 't7'), ev('review.finalized', { ts: T('02'), round: 1 }, 't7'), ev('task.accepted', { ts: T('03') }, 't7')], '01');
  assert.equal(after.tasks_accepted_after_send_back_no_later_round, 0);
  assert.equal(after.tasks_accepted_send_back_unknown, 0);
  // finalized before the send-back, file time after it: no later round
  const before = stats([ev('review.finalized', { ts: T('01'), round: 1 }, 't7'), ev('task.sent_back', { ts: T('02') }, 't7'), ev('task.accepted', { ts: T('03') }, 't7')], '05');
  assert.equal(before.tasks_accepted_after_send_back_no_later_round, 1);
});
