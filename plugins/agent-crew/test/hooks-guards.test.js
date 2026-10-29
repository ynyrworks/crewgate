'use strict';

// Orchestrator edit guard, big-file read reminder, git command detection, glob matcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, hasGit, git } = require('./helpers');
const H = require('./hooks-helpers');
const { matchAny } = require('../lib/hooks/glob');
const { detect } = require('../lib/hooks/gitcmd');
const { exceeds } = require('../lib/hooks/pre-tool-use');

const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const edit = (f, file, extra) => H.base(f, { tool_name: 'Edit', tool_use_id: `e-${Math.random()}`, tool_input: { file_path: file }, ...extra });

test('glob: ** * ? and slash-less patterns', () => {
  const allow = ['**/*.md', 'docs/**', '.claude/**', '.crew/**'];
  for (const p of ['README.md', 'a/b/c.md', 'docs/x/y.txt', '.claude/crew.json', '.crew/REVIEW.md']) assert.ok(matchAny(allow, p), p);
  for (const p of ['src/a.js', 'docsx/a.txt', 'a/docs/b.txt', 'md']) assert.ok(!matchAny(allow, p), p);
  assert.ok(matchAny(['*.js'], 'src/deep/a.js'));
  assert.ok(matchAny(['src/*.js'], 'src/a.js') && !matchAny(['src/*.js'], 'src/x/a.js'));
  assert.ok(matchAny(['a?c.txt'], 'abc.txt') && !matchAny(['a?c.txt'], 'a/c.txt'));
  assert.ok(matchAny(['src/**/test/*.js'], 'src/test/a.js') && matchAny(['src/**/test/*.js'], 'src/a/b/test/a.js'));
  assert.ok(matchAny(['(x).js'], '(x).js'), 'regex characters are literal');
  assert.ok(!matchAny([''], 'a') && !matchAny(null, 'a'));
  assert.ok(matchAny(['DOCS/**'], 'docs/a', true) && !matchAny(['DOCS/**'], 'docs/a', false));
});

test('edit guard: warn mode reminds, records an event and tells the user', () => {
  const f = H.fixture();
  const r = H.runHook('pre-tool-use', edit(f, path.join(f.repo, 'src', 'a.js')), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.ok(ctxOf(r).includes('src/a.js'));
  assert.ok(r.json.systemMessage.includes('src/a.js'));
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
  const ev = H.evs(f, 'orchestrator.warned');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.file, 'src/a.js');
});

test('edit guard: allowed paths, outside-project paths and off mode stay silent', () => {
  const f = H.fixture();
  for (const p of ['README.md', 'docs/guide.txt', '.claude/crew.json', 'notes/x.md']) {
    assert.equal(H.runHook('pre-tool-use', edit(f, path.join(f.repo, p)), { cwd: f.repo }).out, '{}', p);
  }
  assert.equal(H.runHook('pre-tool-use', edit(f, path.join(tmpDir('crew-out-'), 'x.js')), { cwd: f.repo }).out, '{}');
  assert.equal(H.evs(f, 'orchestrator.warned').length, 0);
  const g = H.fixture({ config: { limits: { orchestrator_edit: 'off' } } });
  assert.equal(H.runHook('pre-tool-use', edit(g, path.join(g.repo, 'src', 'a.js')), { cwd: g.repo }).out, '{}');
});

test('edit guard: block mode denies with a JSON decision and exit 0; NotebookEdit and relative paths too', () => {
  const f = H.fixture({ config: { limits: { orchestrator_edit: 'block' } } });
  const r = H.runHook('pre-tool-use', edit(f, path.join(f.repo, 'src', 'a.js')), { cwd: f.repo });
  assert.equal(r.code, 0);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(r.json.hookSpecificOutput.permissionDecisionReason.includes('orchestrator_edit_allow'));
  const nb = H.runHook('pre-tool-use', H.base(f, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }), { cwd: f.repo });
  assert.equal(nb.json.hookSpecificOutput.permissionDecision, 'deny');
  const ok = H.runHook('pre-tool-use', edit(f, path.join(f.repo, 'docs', 'a.md')), { cwd: f.repo });
  assert.equal(ok.out, '{}');
});

test('edit guard never applies inside subagents or linked worktrees', { skip: !hasGit() }, () => {
  const f = H.fixture({ config: { limits: { orchestrator_edit: 'block' } } });
  const sub = H.runHook('pre-tool-use', edit(f, path.join(f.repo, 'src', 'a.js'), { agent_id: 'ag-9', agent_type: 'crew-worker' }), { cwd: f.repo });
  assert.equal(sub.out, '{}');
  const wt = path.join(tmpDir('crew-wt-'), 'wt');
  git(f.repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  const r = H.runHook('pre-tool-use', edit(f, path.join(wt, 'src', 'a.js'), { cwd: wt }), { cwd: wt });
  assert.equal(r.out, '{}');
  // the main checkout is still guarded
  assert.equal(H.runHook('pre-tool-use', edit(f, path.join(f.repo, 'src', 'a.js')), { cwd: f.repo }).json.hookSpecificOutput.permissionDecision, 'deny');
});

test('read reminder: long file without limit', () => {
  const f = H.fixture({ config: { limits: { orchestrator_read_warn_lines: 50 } } });
  H.start(f);
  const big = path.join(f.repo, 'big.txt');
  fs.writeFileSync(big, 'line\n'.repeat(80));
  const r = H.runHook('pre-tool-use', H.base(f, { tool_name: 'Read', tool_input: { file_path: big } }), { cwd: f.repo });
  assert.ok(ctxOf(r).includes('more than 50 lines'));
  assert.ok(!ctxOf(r).includes('line\nline'), 'file content is never injected');
  assert.equal(H.runHook('pre-tool-use', H.base(f, { tool_name: 'Read', tool_input: { file_path: big, limit: 40, offset: 0 } }), { cwd: f.repo }).out, '{}');
  const small = path.join(f.repo, 'small.txt');
  fs.writeFileSync(small, 'line\n'.repeat(10));
  assert.equal(H.runHook('pre-tool-use', H.base(f, { tool_name: 'Read', tool_input: { file_path: small } }), { cwd: f.repo }).out, '{}');
  assert.equal(H.runHook('pre-tool-use', H.base(f, { tool_name: 'Read', tool_input: { file_path: big }, agent_id: 'ag' }), { cwd: f.repo }).out, '{}');
  assert.equal(H.runHook('pre-tool-use', H.base(f, { tool_name: 'Read', tool_input: { file_path: path.join(f.repo, 'missing.txt') } }), { cwd: f.repo }).out, '{}');
});

test('exceeds(): thresholds, no trailing newline, binary and unreadable files', () => {
  const d = tmpDir('crew-lines-');
  const w = (n, s) => { const p = path.join(d, n); fs.writeFileSync(p, s); return p; };
  assert.equal(exceeds(w('a', 'x\n'.repeat(5)), 5), false);
  assert.equal(exceeds(w('b', 'x\n'.repeat(6)), 5), true);
  assert.equal(exceeds(w('c', `${'x\n'.repeat(5)}tail`), 5), true, 'last line without newline counts');
  assert.equal(exceeds(w('d', Buffer.from([0, 1, 2, 10, 10, 10, 10, 10, 10])), 2), null);
  assert.equal(exceeds(path.join(d, 'nope'), 2), null);
  assert.equal(exceeds(w('e', 'x\n'.repeat(200000)), 300), true);
});

test('git command detection', () => {
  const kinds = (c) => detect(c).map((x) => `${x.type}:${x.data.command}`);
  assert.deepEqual(kinds('git push origin feat/x'), ['git.push:git push']);
  assert.deepEqual(detect('git push -u origin feat/x')[0].data, { command: 'git push', remote: 'origin', refs: ['feat/x'], flags: ['set-upstream'] });
  assert.deepEqual(detect('git push --force-with-lease origin HEAD:main')[0].data.flags, ['force']);
  assert.deepEqual(kinds('npm test && git push && echo ok'), ['git.push:git push']);
  assert.deepEqual(kinds('cd x; FOO=1 BAR="a b" git -C /some/dir push origin main'), ['git.push:git push']);
  assert.deepEqual(kinds('git -c user.name=x merge feat/y --no-ff'), ['git.merge:git merge']);
  assert.deepEqual(detect('git merge --no-ff feat/y')[0].data, { command: 'git merge', branches: ['feat/y'], flags: ['no-ff'] });
  assert.deepEqual(kinds('git merge --abort'), []);
  assert.deepEqual(kinds('gh pr create --title "x; git push" --base main'), ['git.push:gh pr create']);
  assert.equal(detect('gh pr create --base main --head feat/z')[0].data.head, 'feat/z');
  assert.deepEqual(kinds('glab mr create --fill'), ['git.push:glab mr create']);
  assert.deepEqual(kinds('gh pr merge 12 --squash'), ['git.merge:gh pr merge']);
  assert.deepEqual(kinds('sudo -n git push'), ['git.push:git push']);
  assert.deepEqual(kinds('git push\ngit merge main'), ['git.push:git push', 'git.merge:git merge']);
  assert.deepEqual(kinds('git push \\\n  origin main'), ['git.push:git push']);
  // not commands
  assert.deepEqual(kinds('git commit -m "git push now"'), []);
  assert.deepEqual(kinds('echo "git push" | cat'), []);
  assert.deepEqual(kinds('git status'), []);
  assert.deepEqual(kinds('git log --grep push'), []);
  assert.deepEqual(kinds('npm run push'), []);
  assert.equal(detect('git push https://user:pw@host.example.test/r.git main')[0].data.remote, '(url)');
  assert.deepEqual(detect('x'.repeat(100000)), []);
});

test('Bash PostToolUse records git.push / git.merge with redacted args only', () => {
  const f = H.fixture();
  H.start(f);
  const post = (command, id) => H.runHook('post-tool-use', H.base(f, { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: { stdout: 'secret output' } }), { cwd: f.repo });
  assert.equal(post('git push origin feat/x', 'b1').out, '{}');
  post('git push origin feat/x', 'b1'); // fired twice
  post('git merge feat/x --no-ff -m "token=abcdef123456"', 'b2');
  post('ls -la && git status', 'b3');
  const push = H.evs(f, 'git.push');
  const merge = H.evs(f, 'git.merge');
  assert.equal(push.length, 1);
  assert.equal(push[0].data.remote, 'origin');
  assert.deepEqual(push[0].data.refs, ['feat/x']);
  assert.equal(merge.length, 1);
  assert.ok(!JSON.stringify(merge[0]).includes('abcdef123456'));
  assert.ok(!JSON.stringify(push[0]).includes('secret output'));
  const s = JSON.parse(fs.readFileSync(path.join(f.home, 'sessions', `${f.sid}.json`), 'utf8'));
  assert.equal(s.tools.Bash, 4);
});

test('Bash PostToolUse in an unregistered repo does nothing', { skip: !hasGit() }, () => {
  const f = H.fixture();
  const other = tmpDir('crew-other-');
  git(other, 'init', '-q');
  const r = H.runHook('post-tool-use', { session_id: 'o1', cwd: other, tool_name: 'Bash', tool_use_id: 'z', tool_input: { command: 'git push origin x' } }, { cwd: other });
  assert.equal(r.out, '{}');
  assert.equal(H.evs(f, 'git.push').length, 0);
});
