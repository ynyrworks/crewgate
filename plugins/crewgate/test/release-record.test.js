'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const project = require('../lib/core/project');
const paths = require('../lib/core/paths');

const TID = { a: 't-20260102-aaaa', b: 't-20260102-bbbb', c: 't-20260102-cccc', d: 't-20260102-dddd', e: 't-20260102-eeee', g: 't-20260102-gggg', x: 't-20260102-xxxx' };

function gitAt(repo, iso, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function mergeBranch(repo, name, file, day) {
  gitAt(repo, `2026-01-${day}T08:00:00Z`, 'checkout', '-q', '-b', name, 'main');
  fs.writeFileSync(path.join(repo, file), `${name}\n`);
  gitAt(repo, `2026-01-${day}T08:00:00Z`, 'add', '.');
  gitAt(repo, `2026-01-${day}T08:00:00Z`, 'commit', '-q', '-m', `work ${name}`);
  gitAt(repo, `2026-01-${day}T09:00:00Z`, 'checkout', '-q', 'main');
  gitAt(repo, `2026-01-${day}T09:00:00Z`, 'merge', '--no-ff', '-q', '-m', `Merge ${name}`, name);
  return gitAt(repo, `2026-01-${day}T09:00:00Z`, 'rev-parse', 'HEAD');
}

function writeTask(pid, id, over) {
  const dir = paths.taskDir(pid, id);
  fs.mkdirSync(dir, { recursive: true });
  const t = { id, title: `Title of ${id}`, role: 'worker', branch: '', state: 'merged', returns: 0, created: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z', history: [], ...over };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(t, null, 2));
  return dir;
}

function writeRound(dir, round, files) {
  const f = path.join(dir, 'findings');
  fs.mkdirSync(f, { recursive: true });
  for (const [suffix, data] of Object.entries(files)) fs.writeFileSync(path.join(f, `${round}.${suffix}`), JSON.stringify(data));
}

const finding = (id, over = {}) => ({ ...u.finding(id), ...over });

// A repo with tag v1.0.0, three merged branches and tag v1.1.0, plus fake tasks, plan and gates. -> context
function fixture() {
  const repo = h.makeRepo();
  gitAt(repo, '2026-01-01T00:00:00Z', 'commit', '-q', '--allow-empty', '-m', 'base');
  gitAt(repo, '2026-01-01T00:00:00Z', 'branch', '-M', 'main');
  const base = gitAt(repo, '2026-01-01T00:00:00Z', 'rev-parse', 'HEAD');
  gitAt(repo, '2026-01-01T00:00:00Z', 'tag', 'v1.0.0');
  const mergeA = mergeBranch(repo, 'feat/a', 'a1.txt', '03');
  mergeBranch(repo, 'feat/d', 'd1.txt', '04');
  const mergeG = mergeBranch(repo, 'feat/g', 'g1.txt', '05');
  gitAt(repo, '2026-01-06T00:00:00Z', 'tag', 'v1.1.0');
  const r = h.crew(['init'], repo);
  assert.equal(r.code, 0, r.err);
  const pid = project.projectId(repo);

  const dirA = writeTask(pid, TID.a, { title: 'Alpha thing', branch: 'feat/a', returns: 1 });
  writeRound(dirA, 1, {
    'raw.json': [finding('f1'), finding('f2'), finding('f3')],
    'kept.json': [finding('f1'), finding('f2')],
    'refutations.json': [{ id: 'f1', verdict: 'upheld', evidence: 'x' }, { id: 'f2', verdict: 'uncertain', evidence: 'y' }],
    json: [
      finding('f1', { claim: `see ${repo}/src/q.js and ${os.homedir()}/secret-thing`, verdict: 'upheld', line: 7 }),
      finding('f2', { severity: 'minor', category: 'test-gap', claim: 'second claim', verdict: 'uncertain' }),
    ],
    'filtered.json': [{ finding: finding('f3'), reason: 'dismissed', detail: 'once: x' }],
  });
  writeTask(pid, TID.b, { branch: '', title: 'Before the range' });
  writeTask(pid, TID.c, { branch: 'gone/branch', title: 'Cannot be placed' });
  const dirD = writeTask(pid, TID.d, { branch: 'feat/d', title: 'Zero findings' });
  writeRound(dirD, 1, { 'raw.json': [], 'kept.json': [], json: [], 'filtered.json': [] });
  writeTask(pid, TID.e, { title: 'Merged long after', branch: '' });
  writeTask(pid, TID.g, { branch: 'feat/g', title: 'Never reviewed' });
  writeTask(pid, TID.x, { state: 'accepted', branch: 'feat/a', title: 'Not merged' });

  const ev = (ts, type, task, data) => JSON.stringify({ v: 1, ts, id: `${type}${ts}${task}`, type, src: 'cli', session: 'SESSION-ID-SHOULD-NOT-APPEAR', task, agent: null, data });
  const lines = [
    ev('2026-01-02T09:00:00Z', 'task.returned', TID.a, { returns: 0 }),
    ev('2026-01-02T10:00:00Z', 'task.reviewed', TID.a, { note: 'review round 1' }),
    ev('2026-01-02T10:30:00Z', 'review.finding_dismissed', TID.a, { finding: 'f3', scope: 'once', category: 'nit', file: 'src/x.js', reason: 'style only' }),
    ev('2026-01-02T11:00:00Z', 'task.returned', TID.a, { returns: 1 }),
    ev('2026-01-02T11:30:00Z', 'task.accepted', TID.a, { skip_refuter: 'refuter timed out', review_gap: { kind: 'unfinalized', round: 2, n: 1 } }),
    ev('2026-01-03T09:00:01Z', 'task.merged', TID.a, { branch: 'feat/a', note: mergeA.slice(0, 10) }),
    ev('2025-12-31T09:00:00Z', 'task.merged', TID.b, { note: base.slice(0, 10) }),
    ev('2026-01-04T12:00:00Z', 'task.merged', TID.c, { note: 'deadbee' }),
    ev('2026-01-02T20:00:00Z', 'task.returned', TID.d, {}),
    ev('2026-01-02T21:00:00Z', 'task.reviewed', TID.d, { note: 'review round 1' }),
    ev('2026-01-04T09:00:01Z', 'task.merged', TID.d, { note: '' }),
    ev('2026-01-05T09:00:01Z', 'task.merged', TID.g, { note: mergeG }),
    ev('2026-03-01T00:00:00Z', 'task.merged', TID.e, { note: '' }),
    ev('2026-01-03T08:00:00Z', 'gate.asked', TID.a, { id: 'g-1', gate: 'merge', detail: 'merge feat/a' }),
    ev('2026-01-03T08:05:00Z', 'gate.answered', TID.a, { id: 'g-1', gate: 'merge', answer: 'yes', user_turn: true }),
    ev('2026-01-04T08:00:00Z', 'gate.asked', null, { id: 'g-2', gate: 'push', detail: 'push it' }),
    ev('2026-01-04T08:05:00Z', 'gate.answered', null, { id: 'g-2', gate: 'push', answer: 'yes', user_turn: false }),
    ev('2026-01-04T09:00:00Z', 'gate.asked', null, { id: 'g-3', gate: 'open_pr', detail: 'open a pr' }),
    ev('2026-01-04T10:00:00Z', 'gate.missing', null, { gate: 'merge', command: 'git merge' }),
    ev('2026-03-02T08:00:00Z', 'gate.asked', null, { id: 'g-4', gate: 'push', detail: 'OUTSIDE-WINDOW' }),
    ev('2026-01-02T08:00:00Z', 'gate.asked', TID.b, { id: 'g-5', gate: 'merge', detail: 'OTHER-TASK-GATE' }),
  ];
  fs.mkdirSync(path.dirname(paths.eventsFile(pid)), { recursive: true });
  fs.writeFileSync(paths.eventsFile(pid), `${lines.join('\n')}\n`);

  u.writeFile(repo, '.crew/plans/demo.md', [
    '# Demo plan', 'Ship the demo.', '',
    `- [x] first step <!-- id:n1 task:${TID.a} added:2026-01-01 origin:plan -->`,
    `- [?] fix the thing later <!-- id:n2 from_task:${TID.a} finding:f1 review_round:1 action:add origin:review -->`, '',
    '## Clarified',
    '- Q: Which port? A: 8080 (user)',
    '- Q: Which db? A: sqlite (assumed)', '',
  ].join('\n'));
  u.writeFile(repo, '.crew/plans/other.md', '# Other plan\nNot linked.\n\n- [ ] nothing\n');
  return { repo, pid, mergeA, mergeG };
}

const record = (repo, ...args) => h.crew(['--lang', 'en', 'release', 'record', ...args], repo);
const read = (repo, ver = '1.1.0') => fs.readFileSync(path.join(repo, '.crew', 'releases', `${ver}.md`), 'utf8');

test('default range: tag vVERSION and the nearest earlier tag; tasks placed by merge note or branch tip', () => {
  const { repo } = fixture();
  const r = record(repo, '1.1.0');
  assert.equal(r.code, 0, r.err);
  const md = read(repo);
  assert.match(md, /Range: v1\.0\.0 \(\w{7}\) \.\. v1\.1\.0 \(\w{7}\)/);
  for (const k of ['a', 'd', 'g']) assert.ok(md.includes(`### ${TID[k]} - `), `task ${k} included`);
  for (const k of ['b', 'e', 'x']) assert.ok(!md.includes(TID[k]), `task ${k} left out`);
  assert.match(md, /Not placed \(.*\): t-20260102-cccc\n/);
  assert.ok(md.includes('- Branch: `feat/a`'));
  assert.ok(md.includes('- Returns: 1'));
});

test('an unknown ref writes nothing; an explicit narrower range drops later merges', () => {
  const { repo } = fixture();
  const bad = record(repo, '1.1.0', '--from', 'nope-ref');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /nope-ref/);
  assert.ok(!fs.existsSync(path.join(repo, '.crew', 'releases')));
  const bad2 = record(repo, '1.1.0', '--to', 'nope-ref');
  assert.equal(bad2.code, 1);
  assert.ok(!fs.existsSync(path.join(repo, '.crew', 'releases')));
  const mid = gitAt(repo, '2026-01-06T00:00:00Z', 'rev-list', '-n1', '--before=2026-01-03T12:00:00Z', 'main');
  const ok = record(repo, '1.1.0', '--from', 'v1.0.0', '--to', mid);
  assert.equal(ok.code, 0, ok.err);
  const md = read(repo);
  assert.ok(md.includes(TID.a));
  assert.ok(!md.includes(`### ${TID.g}`));
});

test('without the tag the range ends at HEAD', () => {
  const { repo } = fixture();
  const r = record(repo, '9.9.9', '--from', 'v1.0.0');
  assert.equal(r.code, 0, r.err);
  assert.match(read(repo, '9.9.9'), /Range: v1\.0\.0 \(\w{7}\) \.\. HEAD \(\w{7}\)/);
  assert.equal(record(repo, '9.9.8').code, 0);
  assert.match(read(repo, '9.9.8'), /Range: v1\.1\.0 \(\w{7}\) \.\. HEAD \(\w{7}\)/);
});

test('review rounds: counts, surviving findings, dismissals and skip-refuter reasons', () => {
  const { repo } = fixture();
  record(repo, '1.1.0');
  const md = read(repo);
  assert.match(md, /Round 1: 2 finding\(s\) survived\. \(raw 3, kept 2, upheld 1, refuted 0, uncertain 1, dismissed 1\)/);
  assert.match(md, /- major correctness `src\/x\.js:7` .*\(upheld\)/);
  assert.match(md, /- minor test-gap `src\/x\.js:3` second claim \(uncertain\)/);
  assert.match(md, /Dismissed f3 \(once\): nit `src\/x\.js`: style only/);
  assert.match(md, /\*\*Accepted with --skip-refuter, reason\*\*: refuter timed out/);
});

test('flags: returned after the last finalized round, no review, and zero findings stated plainly', () => {
  const { repo } = fixture();
  record(repo, '1.1.0');
  const md = read(repo);
  const part = (id) => md.split(`### ${id}`)[1].split('\n### ')[0].split('\n## ')[0];
  assert.match(part(TID.a), /\*\*NOT RE-REVIEWED: .*last changes were not re-reviewed\.\*\*/);
  assert.match(part(TID.g), /\*\*NO REVIEW: this task has no finalized review round\.\*\*/);
  const d = part(TID.d);
  assert.ok(!/NOT RE-REVIEWED|NO REVIEW/.test(d));
  assert.match(d, /Round 1: 0 findings survived\. \(raw 0, kept 0/);
  assert.ok(!/no issues|clean|passed/i.test(d));
});

test('plans: linked plans only, with completion, clarified answers and (assumed) called out', () => {
  const { repo } = fixture();
  record(repo, '1.1.0');
  let md = read(repo);
  assert.match(md, /### demo - Demo plan/);
  assert.match(md, /- Goal: Ship the demo\./);
  assert.match(md, /- Completion: 1\/1 \(100%\)/);
  assert.match(md, /Q: Which port\? A: 8080\n/);
  assert.match(md, /Q: Which db\? A: sqlite \*\*\(assumed\)\*\* - not confirmed by the user/);
  assert.ok(!md.includes('Other plan'));
  assert.match(md, /Follow-up in plan demo, node n2 \[proposed\]: fix the thing later/);
  record(repo, '1.1.0', '--plan', 'other');
  md = read(repo);
  assert.ok(md.includes('### other - Other plan'));
  const bad = record(repo, '1.1.0', '--plan', 'missing-plan');
  assert.equal(bad.code, 1);
});

test('gates: tasks and untasked gates in the window; no-user-turn, unanswered and gate.missing stand out', () => {
  const { repo } = fixture();
  record(repo, '1.1.0');
  const md = read(repo);
  const gates = md.split('## Gates')[1];
  assert.match(gates, /- `merge` \(t-20260102-aaaa\) - merge feat\/a - answer: yes; user turn: yes/);
  assert.match(gates, /- `push` - push it - answer: yes; \*\*NO USER TURN: the answer does not count as approval\*\*/);
  assert.match(gates, /- `open_pr` - open a pr - \*\*NO ANSWER RECORDED\*\*/);
  assert.match(gates, /\*\*gate\.missing \(merge\)/);
  assert.ok(!gates.includes('OUTSIDE-WINDOW'));
  assert.ok(!gates.includes('OTHER-TASK-GATE'));
});

test('conclusion: TODO with a warning, kept on rerun, replaced by a new file, refused without markers', () => {
  const { repo } = fixture();
  const first = record(repo, '1.1.0');
  assert.equal(first.code, 0);
  assert.match(first.err, /TODO/);
  assert.match(read(repo), /<!-- crew:conclusion -->\nTODO: .*\n<!-- \/crew:conclusion -->/);
  const f = u.writeFile(h.tmpDir('crew-concl-'), 'c.md', 'Verified: unit tests.\nNot verified: Windows.\n');
  const second = record(repo, '1.1.0', '--conclusion-file', f);
  assert.equal(second.err, '');
  assert.match(read(repo), /<!-- crew:conclusion -->\nVerified: unit tests\.\nNot verified: Windows\.\n<!-- \/crew:conclusion -->/);
  const third = record(repo, '1.1.0');
  assert.equal(third.err, '');
  assert.match(read(repo), /Verified: unit tests\./);
  const file = path.join(repo, '.crew', 'releases', '1.1.0.md');
  fs.writeFileSync(file, 'hand written\n');
  const refused = record(repo, '1.1.0');
  assert.equal(refused.code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hand written\n');
  assert.equal(record(repo, '1.1.0', '--force').code, 0);
  assert.match(read(repo), /crew:conclusion/);
});

test('same inputs give the same bytes; home and repo paths are shortened; session ids and reports stay out', () => {
  const { repo, pid } = fixture();
  fs.writeFileSync(path.join(paths.taskDir(pid, TID.a), 'report.md'), 'WORKER-REPORT-TEXT');
  fs.writeFileSync(path.join(paths.taskDir(pid, TID.a), 'packet.md'), 'PACKET-TEXT');
  record(repo, '1.1.0');
  const one = read(repo);
  record(repo, '1.1.0');
  assert.equal(read(repo), one);
  assert.ok(!one.includes(os.homedir()));
  assert.ok(!one.includes(repo));
  assert.ok(one.includes('`src/x.js:7` see src/q.js and ~/secret-thing'));
  for (const bad of ['SESSION-ID-SHOULD-NOT-APPEAR', 'WORKER-REPORT-TEXT', 'PACKET-TEXT']) assert.ok(!one.includes(bad));
});

test('--dir and release.record_dir choose the folder; --json lists the tasks', () => {
  const { repo } = fixture();
  const out = h.tmpDir('crew-out-');
  const r = h.crew(['--json', 'release', 'record', '1.1.0', '--dir', out], repo);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(out, '1.1.0.md')));
  const data = JSON.parse(r.out);
  assert.deepEqual(data.tasks.map((k) => k.id).sort(), [TID.a, TID.d, TID.g].sort());
  assert.deepEqual(data.not_placed, [TID.c]);
  u.patchCfg(repo, (c) => { c.release = { record_dir: 'docs/rel' }; });
  assert.equal(record(repo, '1.1.0').code, 0);
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'rel', '1.1.0.md')));
  assert.ok(!fs.existsSync(path.join(repo, '.crew', 'releases')));
});

test('zh-TW output and a bad version', () => {
  const { repo } = fixture();
  assert.equal(h.crew(['--lang', 'zh-TW', 'release', 'record', '1.1.0'], repo).code, 0);
  assert.match(read(repo), /^# 版本 1\.1\.0/);
  assert.equal(h.crew(['release', 'record', '../x'], repo).code, 2);
});
