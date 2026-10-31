'use strict';

// Fixes from a day of real use: redirect words and heredoc bodies in git detection, the hook error log,
// subagent.stop text and orphans, Codex duplicate session events, CLI + hook merge pairs, board.log stamps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const H = require('./hooks-helpers');
const { tmpDir, git } = require('./helpers');
const project = require('../lib/core/project');
const events = require('../lib/core/events');
const hooklog = require('../lib/core/hooklog');
const gitcmd = require('../lib/hooks/gitcmd');
const board = require('../lib/commands/board');

const post = (f, command, id, response) => H.runHook('post-tool-use', H.base(f, {
  tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: response || { stdout: '' },
}), { cwd: f.repo });

// ---------------------------------------------------------------- 1. redirect words
test('detect: redirects never become refs, branches or words', () => {
  const refs = (c) => gitcmd.detect(c).map((x) => x.data.refs || x.data.branches);
  assert.deepEqual(refs('git push origin main 2>&1 | tail -2'), [['main']]);
  assert.deepEqual(refs('git push origin main 2>&1'), [['main']]);
  assert.deepEqual(refs('git push origin main >out.txt 2>&1'), [['main']]);
  assert.deepEqual(refs('git push origin main > out.txt'), [['main']]);
  assert.deepEqual(refs('git push origin main 2>/dev/null'), [['main']]);
  assert.deepEqual(refs('git push origin main >&2'), [['main']]);
  assert.deepEqual(refs('git push &>log origin main'), [['main']]);
  assert.deepEqual(refs('git push origin main 1>&2 &'), [['main']]);
  assert.deepEqual(refs('git merge feat/x 2>&1 <in.txt'), [['feat/x']]);
  assert.deepEqual(refs('git merge feat/x >> log.txt 2>&1 && git push origin main'), [['feat/x'], ['main']]);
  // quoted ">" and digits inside a word stay words
  assert.deepEqual(refs('git push origin "a>b" a2'), [['a>b', 'a2']]);
  assert.deepEqual(gitcmd.tokenize('git push origin main 2>&1 | tail -2'), ['git', 'push', 'origin', 'main', { op: '|' }, 'tail', '-2']);
});

test('PostToolUse: `git push origin main 2>&1 | tail -2` records the ref main only', () => {
  const f = H.fixture();
  H.start(f);
  post(f, 'git push origin main 2>&1 | tail -2', 'r1');
  const [e] = H.evs(f, 'git.push');
  assert.deepEqual(e.data.refs, ['main']);
  assert.equal(e.data.remote, 'origin');
});

// ---------------------------------------------------------------- 2. heredoc bodies
test('detect: heredoc bodies are literal text, the command after them still counts', () => {
  const heredoc = "cat > notes.md <<'EOF'\ngit merge z,cd\ngit push origin fake\nEOF\n";
  assert.deepEqual(gitcmd.detect(heredoc), []);
  assert.deepEqual(gitcmd.detect(`${heredoc}git push origin real`).map((x) => [x.type, x.data.refs]), [['git.push', ['real']]]);
  assert.deepEqual(gitcmd.detect('cat <<EOF\ngit push\nEOF'), []);
  assert.deepEqual(gitcmd.detect('cat <<"EOF"\ngit push\nEOF\n'), []);
  assert.deepEqual(gitcmd.detect('cat <<-EOF\n\tgit push\n\tEOF\ngit merge a').map((x) => x.type), ['git.merge']);
  assert.deepEqual(gitcmd.detect('cat <<A <<B\ngit push\nA\ngit merge x\nB\ngit push o r').map((x) => x.data.refs), [['r']]);
  assert.deepEqual(gitcmd.detect('cat <<EOF\r\ngit push\r\nEOF\r\ngit merge a').map((x) => x.type), ['git.merge']);
  // safety: with no terminator line nothing is swallowed (a false event is better than a hidden push)
  assert.deepEqual(gitcmd.detect('cat <<EOF\ngit push').map((x) => x.type), ['git.push']);
  // a here-string is not a heredoc
  assert.deepEqual(gitcmd.detect('cat <<<hello; git push o r').map((x) => x.data.refs), [['r']]);
});

test('PostToolUse: a heredoc mentioning git merge / git push records nothing and raises no gate.missing', () => {
  const f = H.fixture({ config: { gates: { push: 'ask', merge: 'ask' } } });
  H.start(f);
  const r = post(f, "cat > doc.md <<'EOF'\nrun git merge z,cd then\ngit push origin main\nEOF", 'h1');
  assert.equal(r.code, 0);
  assert.equal(H.evs(f, 'git.merge').length, 0);
  assert.equal(H.evs(f, 'git.push').length, 0);
  assert.equal(H.evs(f, 'gate.missing').length, 0);
});

test('detect: # starts a comment only at a word start, so a commented <<EOF opens no heredoc', () => {
  assert.deepEqual(gitcmd.detect('echo ok # <<EOF\ngit push origin main').map((x) => x.data.refs), [['main']]);
  assert.deepEqual(gitcmd.detect('git push origin main # <<EOF').map((x) => x.data.refs), [['main']]);
  assert.deepEqual(gitcmd.detect('echo a#b; git push o r').map((x) => x.data.refs), [['r']]);
  assert.deepEqual(gitcmd.detect('git push "#x" o').map((x) => x.data.refs), [['o']]);
  assert.deepEqual(gitcmd.detect('# git push o x\ngit merge a').map((x) => x.type), ['git.merge']);
});

test('detect: a quoted heredoc delimiter is literal, an unquoted one loses its backslashes', () => {
  // bash ends <<'E\OF' at a line E\OF; the real push after it must be seen
  assert.deepEqual(gitcmd.detect("cat <<'E\\OF'\ngit push fake\nE\\OF\ngit push o real").map((x) => x.data.refs), [['real']]);
  assert.deepEqual(gitcmd.detect('cat <<"E\\OF"\ngit push fake\nE\\OF\ngit push o real').map((x) => x.data.refs), [['real']]);
  // unquoted E\OF means EOF
  assert.deepEqual(gitcmd.detect('cat <<E\\OF\ngit push fake\nEOF\ngit push o real').map((x) => x.data.refs), [['real']]);
  // the literal delimiter never appears: nothing is swallowed
  assert.deepEqual(gitcmd.detect("cat <<'E\\OF'\ngit push o real\nEOF").map((x) => x.data.refs), [['real']]);
});

test('PostToolUse: a push after a commented <<EOF is recorded and reminded', () => {
  const f = H.fixture({ config: { gates: { push: 'ask' } } });
  H.start(f);
  post(f, 'echo ok # <<EOF\ngit push origin main', 'cm1');
  assert.equal(H.evs(f, 'git.push').length, 1);
  assert.equal(H.evs(f, 'gate.missing').length, 1);
});

// ---------------------------------------------------------------- 3. hook error log
const hookErrors = (home) => {
  try { return fs.readFileSync(path.join(home, 'hook-errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

test('hook error log: a throwing handler is written as kind error, redacted and capped at 300 chars', () => {
  const f = H.fixture();
  const r = H.runHook('stop', H.base(f, {}), {
    cwd: f.repo, env: { CREWGATE_TEST: '1', CREWGATE_HOOK_TEST_THROW: `boom token=abcdef1234567890abcd ${'x'.repeat(500)}` },
  });
  assert.equal(r.out, '{}');
  const [e] = hookErrors(f.home);
  assert.equal(e.event, 'stop');
  assert.equal(e.kind, 'error');
  assert.ok(e.msg.length <= 300 && e.msg.startsWith('boom'), e.msg);
  assert.ok(!e.msg.includes('abcdef1234567890abcd'));
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT/);
  assert.match(e.version, /^\d+\.\d+\.\d+/);
});

test('hook error log: a guard expiry is written as kind guard', () => {
  const f = H.fixture();
  const r = H.runHook('session-start', H.base(f, { source: 'startup' }), {
    cwd: f.repo, env: { CREWGATE_HOOK_GUARD_MS: '400', CREWGATE_TEST: '1', CREWGATE_HOOK_TEST_SLEEP_MS: '5000' },
  });
  assert.equal(r.out, '{}');
  const l = hookErrors(f.home).filter((e) => e.kind === 'guard');
  assert.equal(l.length, 1);
  assert.equal(l[0].event, 'session-start');
});

test('hook error log: counts by window, size cap, and a broken home never throws', () => {
  const f = H.fixture();
  const now = new Date('2026-10-29T12:00:00Z');
  const at = (ms) => new Date(now.getTime() - ms);
  hooklog.log('stop', 'error', 'a', at(3600 * 1000));
  hooklog.log('stop', 'error', 'b', at(2 * 86400000));
  hooklog.log('session-end', 'guard', 'c', at(2 * 86400000));
  hooklog.log('stop', 'guard', 'old', at(9 * 86400000));
  const c = hooklog.counts(now);
  assert.equal(c.h24.total, 1);
  assert.equal(c.d7.total, 3);
  assert.deepEqual(c.d7.by, { 'stop/error': 2, 'session-end/guard': 1 });
  assert.equal(hooklog.log('stop', 'nonsense', 'x'), false);
  // size cap: the oldest half goes
  const big = 'y'.repeat(250);
  for (let i = 0; i < 6000; i++) hooklog.log('stop', 'error', `${i} ${big}`);
  assert.ok(fs.statSync(hooklog.file()).size <= hooklog.MAX_BYTES + 1000);
  assert.ok(hookErrors(f.home).length > 100);
  // rotation renamed the full file instead of rewriting it; counts read both files
  assert.ok(fs.existsSync(hooklog.oldFile()));
  assert.ok(hooklog.counts().d7.total > hookErrors(f.home).length, 'counts read both files');
  // the home is a file: logging fails quietly
  const prev = process.env.CREWGATE_HOME;
  const blocker = path.join(tmpDir('crew-blk-'), 'file');
  fs.writeFileSync(blocker, 'x');
  process.env.CREWGATE_HOME = path.join(blocker, 'sub');
  try { assert.equal(hooklog.log('stop', 'error', 'x'), false); } finally { process.env.CREWGATE_HOME = prev; }
});

test('crew doctor reports hook failures of the last 24 h and 7 days by event and kind', () => {
  const f = H.fixture();
  hooklog.log('stop', 'error', 'x');
  hooklog.log('stop', 'error', 'y');
  hooklog.log('session-end', 'guard', 'z');
  const { crew } = require('./helpers');
  const r = crew(['--json', 'doctor'], f.repo);
  const j = JSON.parse(r.out);
  assert.equal(j.hook_errors.h24.total, 3);
  assert.deepEqual(j.hook_errors.d7.by, { 'stop/error': 2, 'session-end/guard': 1 });
  const c = j.checks.find((x) => x.name === 'hookerrors');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /3 in the last 24 h/);
  assert.match(c.detail, /stop\/error 2/);
});

// ---------------------------------------------------------------- 4. subagent.stop last text
function stopWith(f, agent, lines, extra) {
  const tp = path.join(tmpDir('crew-tp-'), `agent-${agent}.jsonl`);
  fs.writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  H.runHook('subagent-stop', H.base(f, { agent_id: agent, agent_type: 'crew-worker', agent_transcript_path: tp, last_assistant_message: '', ...extra }), { cwd: f.repo });
  return H.evs(f, 'subagent.stop').find((e) => e.agent === agent).data;
}
const asst = (content, stop_reason) => ({ type: 'assistant', message: { role: 'assistant', content, ...(stop_reason ? { stop_reason } : {}) } });
const text = (t) => [{ type: 'text', text: t }];
const toolUse = [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }];
const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } };

test('subagent.stop: mid-run text is never taken as the final message', () => {
  const f = H.fixture();
  H.start(f);
  // "Now build." then a tool call that ended the transcript (the shape of the wrong real values)
  const a = stopWith(f, 'p1', [{ type: 'user', message: { role: 'user', content: 'go' } }, asst(text('Now build.')), asst(toolUse, 'tool_use')]);
  assert.equal(a.last, '');
  assert.equal(a.last_src, 'transcript_partial');
  // text followed by a tool result (user entry): the run did not end on that text
  const b = stopWith(f, 'p2', [asst(text('Now build.')), toolResult]);
  assert.equal(b.last_src, 'transcript_partial');
  assert.equal(b.last, '');
  // the same message split in one line per block: text then tool_use
  const c = stopWith(f, 'p3', [asst(text('Looking.'), null), asst(toolUse)]);
  assert.equal(c.last_src, 'transcript_partial');
  // a real final message is still accepted
  const d = stopWith(f, 'p4', [asst(text('Now build.')), asst(toolUse, 'tool_use'), toolResult, asst(text('All done, tests green.'), 'end_turn')]);
  assert.equal(d.last, 'All done, tests green.');
  assert.equal(d.last_src, 'transcript');
});

test('subagent.stop records whether the transcript path and the last message were present (booleans)', () => {
  const f = H.fixture();
  H.start(f);
  H.runHook('subagent-stop', H.base(f, { agent_id: 'b1', agent_type: 'x', last_assistant_message: 'hi' }), { cwd: f.repo });
  const d = stopWith(f, 'b2', [asst(text('fin'), 'end_turn')]);
  const b1 = H.evs(f, 'subagent.stop').find((e) => e.agent === 'b1').data;
  assert.equal(b1.had_transcript_path, false);
  assert.equal(b1.had_last_message, true);
  assert.equal(d.had_transcript_path, true);
  assert.equal(d.had_last_message, false);
});

// ---------------------------------------------------------------- 5. Codex duplicate session events
test('a Codex session started twice (counters moved in between) records one session.start and one session.end', () => {
  const f = H.fixture();
  const start = () => H.runHook('session-start', H.base(f, { source: 'startup', model: 'gpt-x', hook_event_name: 'SessionStart' }), { cwd: f.repo });
  start();
  post(f, 'echo hi', 'c1'); // moves tool_total
  start();
  assert.equal(H.evs(f, 'session.start').length, 1);
  // a compaction restart of the same session is its own event
  H.runHook('session-start', H.base(f, { source: 'compact' }), { cwd: f.repo });
  assert.equal(H.evs(f, 'session.start').length, 2);

  H.runHook('user-prompt-submit', H.base(f, { prompt: 'hello' }), { cwd: f.repo });
  const end = () => H.runHook('session-end', H.base(f, { reason: 'other' }), { cwd: f.repo });
  // the session file survives a second SessionEnd only if the first one did not remove it: simulate that
  const file = path.join(f.home, 'sessions', `${f.sid}.json`);
  const keep = fs.readFileSync(file, 'utf8');
  end();
  fs.writeFileSync(file, keep.replace(/"prompts":\s*\d+/, '"prompts": 9'));
  end();
  assert.equal(H.evs(f, 'session.end').length, 1);
});

// ---------------------------------------------------------------- 6. CLI + hook merge pair
const cliMerge = (f, over) => events.append(f.pid, {
  type: 'git.merge', src: 'cli',
  data: {
    command: 'crew task merge', branches: ['feat/x'], flags: [], commit: 'abc123456789', via: 'cli-merge',
    target: git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), root: project.normalizePath(git(f.repo, 'rev-parse', '--show-toplevel')), ...over,
  },
  key: `merge:${JSON.stringify(over || {})}`,
});

test('hook keeps quiet about the merge `crew task merge` recorded: same branches, same target, same work tree', () => {
  const f = H.fixture();
  H.start(f);
  cliMerge(f);
  post(f, 'git merge feat/x', 'm1', { stdout: 'Merge made by the \'ort\' strategy.\n' });
  const all = H.evs(f, 'git.merge');
  assert.equal(all.length, 1);
  assert.equal(all[0].src, 'cli');
  // another branch is still recorded
  const r2 = post(f, 'git merge feat/y', 'm2');
  // On a failure this says what the hook did: its result, every event, and the hook error log (no command lines in them).
  let hookErrors = null;
  try { hookErrors = fs.readFileSync(path.join(f.home, 'hook-errors.jsonl'), 'utf8'); } catch { /* none */ }
  assert.deepEqual(H.evs(f, 'git.merge').map((e) => e.data.branches), [['feat/x'], ['feat/y']],
    `hook result: ${JSON.stringify({ code: r2.code, out: r2.out, err: r2.err, ms: r2.ms })}; hook-errors: ${JSON.stringify(hookErrors)}; `
    + `events: ${JSON.stringify(H.evs(f).map((e) => ({ type: e.type, src: e.src, id: e.id, ts: e.ts, data: e.data })))}`);
});

test('dedupe still holds when a tag has the same name as the branch (git prints heads/<name>)', () => {
  const f = H.fixture();
  H.start(f);
  const branch = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(f.repo, 'tag', branch);
  assert.equal(git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'heads/' + branch); // what crew task merge records
  cliMerge(f);
  post(f, 'git merge feat/x', 't1');
  assert.equal(H.evs(f, 'git.merge').length, 1);
});

test('dedupe asks git when GIT_DIR / GIT_WORK_TREE are set (the .git files may not tell the same root)', () => {
  const f = H.fixture();
  H.start(f);
  const other = tmpDir();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = path.join(f.repo, '.git');
    process.env.GIT_WORK_TREE = other; // git now reports `other` as the work tree, the files say f.repo
    cliMerge(f);
    post(f, 'git merge feat/x', 'g1');
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  assert.equal(H.evs(f, 'git.merge').length, 1);
});

test('hook still records a merge of the same branch into another target or work tree, or of more branches', () => {
  const f = H.fixture();
  H.start(f);
  cliMerge(f, { target: 'release' }); // CLI merged feat/x into release; the hook sees a merge into the current branch
  post(f, 'git merge feat/x', 'n1');
  assert.equal(H.evs(f, 'git.merge').filter((e) => e.src === 'hook').length, 1);
  const g = H.fixture();
  H.start(g);
  cliMerge(g, { root: 'C:/elsewhere/other-worktree' });
  post(g, 'git merge feat/x', 'n2');
  assert.equal(H.evs(g, 'git.merge').filter((e) => e.src === 'hook').length, 1);
  const k = H.fixture();
  H.start(k);
  cliMerge(k);
  post(k, 'git merge feat/x feat/y', 'n3');
  const hook = H.evs(k, 'git.merge').filter((e) => e.src === 'hook');
  assert.equal(hook.length, 1);
  assert.deepEqual(hook[0].data.branches, ['feat/x', 'feat/y']);
  // an old-style CLI record without target / root is not trusted for dedupe
  const m = H.fixture();
  H.start(m);
  events.append(m.pid, { type: 'git.merge', src: 'cli', data: { command: 'crew task merge', branches: ['feat/x'], via: 'cli-merge' }, key: 'old' });
  post(m, 'git merge feat/x', 'n4');
  assert.equal(H.evs(m, 'git.merge').filter((e) => e.src === 'hook').length, 1);
});

test('hook still records the merge when the CLI record is older than a minute or comes from a hook', () => {
  const f = H.fixture();
  H.start(f);
  const file = path.join(f.home, 'projects', f.pid, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, ts: old, id: '0123456789abcdef', type: 'git.merge', src: 'cli', session: null, task: null, agent: null, data: { branches: ['feat/old'] } })}\n`);
  post(f, 'git merge feat/old', 'o1');
  assert.equal(H.evs(f, 'git.merge').filter((e) => e.src === 'hook').length, 1);
});

// ---------------------------------------------------------------- 7. orphan subagent.stop
test('subagent.stop without a start and without a task is marked orphan; a started or linked one is not', () => {
  const f = H.fixture();
  H.start(f);
  const t = H.newTask(f);
  H.runHook('subagent-stop', H.base(f, { agent_id: 'compact-1', agent_type: 'general-purpose', last_assistant_message: 'summary' }), { cwd: f.repo });
  H.runHook('subagent-start', H.base(f, { agent_id: 'real-1', agent_type: 'Explore' }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'real-1', agent_type: 'Explore', last_assistant_message: 'found it' }), { cwd: f.repo });
  H.runHook('subagent-stop', H.base(f, { agent_id: 'linked-1', agent_type: 'crew-worker', last_assistant_message: `crew-task: ${t.id}` }), { cwd: f.repo });
  const by = Object.fromEntries(H.evs(f, 'subagent.stop').map((e) => [e.agent, e.data]));
  assert.equal(by['compact-1'].orphan, true);
  assert.equal(by['real-1'].orphan, undefined);
  assert.equal(by['linked-1'].orphan, undefined);
  assert.equal(by['compact-1'].last, 'summary'); // existing fields stay
});

// ---------------------------------------------------------------- 8. board.log timestamps
test('stampLines prefixes every written line with an ISO timestamp, also across chunks', () => {
  const out = new PassThrough();
  let got = '';
  out.on('data', (d) => { got += d; });
  board.stampLines(out, () => new Date('2026-10-29T08:00:00.000Z'));
  out.write('first line\nsecond ');
  out.write('half\n');
  out.write(Buffer.from('third\nfourth\n'));
  assert.equal(got, [
    '2026-10-29T08:00:00.000Z first line', '2026-10-29T08:00:00.000Z second half',
    '2026-10-29T08:00:00.000Z third', '2026-10-29T08:00:00.000Z fourth', '',
  ].join('\n'));
});

test('spawnServe writes a stamped start line to board.log', () => {
  const home = tmpDir('crew-home-');
  process.env.CREWGATE_HOME = home;
  // a bin that exits at once: only the line spawnServe itself writes matters
  const bin = path.join(tmpDir('crew-bin-'), 'noop.js');
  fs.writeFileSync(bin, 'process.exit(0);\n');
  board.spawnServe(bin, 8999);
  const log = fs.readFileSync(path.join(home, 'board.log'), 'utf8');
  assert.match(log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z starting board serve \(port 8999\)\n/);
});
