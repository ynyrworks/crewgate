'use strict';

// Crew agent limits at PreToolUse(Bash / PowerShell): a reviewer / refuter never changes a working tree,
// and no crew agent kills processes by image name. Only subagents are limited.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./hooks-helpers');
const limits = require('../lib/hooks/agentlimits');
const { bashNoop } = require('../lib/hooks/prefilter');
const sess = require('../lib/hooks/session');

const sub = (f, command, type, extra) => H.base(f, { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command }, agent_id: 'ag-1', ...(type ? { agent_type: type } : {}), ...extra });
const pre = (f, p) => H.runHook('pre-tool-use', p, { cwd: f.repo });
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;

test('reviewer and refuter: commands that change a tree or history are denied', () => {
  for (const type of ['crew-reviewer', 'crew-refuter']) {
    for (const c of ['git checkout main', 'git checkout -b x', 'git checkout -- src/a.js', 'git switch main', 'git reset --hard HEAD~1',
      'git merge feat/x', 'git rebase main', 'git commit -am x', 'git stash', 'git clean -fd', 'git restore a.js', 'git cherry-pick abc',
      'git push origin main', 'git worktree add ../w', 'git branch -D x', 'git branch newbranch', 'git -C ../other checkout x',
      'cd /r && git checkout x', 'bash -c "git checkout x"', 'powershell -Command "git reset --hard"', 'git --no-pager checkout x',
      'git -c alias.co=checkout co x', 'FOO=1 git commit -m x', 'git status && git switch -c y']) {
      assert.ok(limits.scan(c, type), `${type}: ${c}`);
    }
    for (const c of ['git diff main...feat/x', 'git log --oneline -5', 'git show HEAD:a.js', 'git status', 'git rev-parse HEAD',
      'git merge-tree a b c', 'git merge-base a b', 'git branch', 'git branch -a', 'git branch --list "feat/*"', 'git worktree list',
      'node crew.js task report t-1 --report-file r.md', 'git -C ../w diff', 'echo "git checkout x"', 'git diff | grep commit']) {
      assert.equal(limits.scan(c, type), null, `${type}: ${c}`);
    }
  }
});

test('the worker keeps committing on its branch', () => {
  for (const c of ['git commit -m x', 'git checkout -b feat/y', 'git add -A && git commit -m z', 'git merge-base a b']) {
    assert.equal(limits.scan(c, 'crew-worker'), null, c);
  }
});

test('killing by image name is denied for all three roles, killing by pid passes', () => {
  for (const type of ['crew-worker', 'crew-reviewer', 'crew-refuter']) {
    for (const c of ['taskkill /IM chrome.exe /F', 'taskkill /f /im node.exe', 'Stop-Process -Name chrome', 'stop-process -n chrome -Force', 'pkill node', 'killall chrome',
      'Get-Process chrome | Stop-Process', '$p | Stop-Process', 'Get-Process -Name x | Stop-Process', 'Get-Process -Name chrome | Stop-Process -Force', 'powershell -Command "Get-Process x | Stop-Process"', 'cmd /c taskkill /IM a.exe']) {
      assert.ok(limits.scan(c, type), `${type}: ${c}`);
    }
    for (const c of ['taskkill /PID 123 /F', 'Stop-Process -Id 123', 'Stop-Process -Id 123 -Force', 'Get-Process -Id 123 | Stop-Process', 'Get-Process -id 123 | Stop-Process -Force', 'kill 123', 'kill -9 123', 'echo pkill']) {
      assert.equal(limits.scan(c, type), null, `${type}: ${c}`);
    }
  }
});

test('hook: a reviewer is denied, the event holds type, first word and tool_use_id but no arguments', () => {
  const f = H.fixture();
  H.start(f);
  const r = pre(f, sub(f, 'git checkout -b secret-branch-name', 'crew-reviewer'));
  assert.equal(decision(r), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /git show or git diff/);
  const ev = H.evs(f, 'agent.limit');
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0].data }, { agent_type: 'crew-reviewer', command: 'git', tool_use_id: 'tu-1' });
  assert.ok(!JSON.stringify(ev[0]).includes('secret-branch-name'));
  assert.equal(pre(f, sub(f, 'git diff HEAD~1', 'crew-reviewer')).out, '{}');
});

test('hook: PowerShell tool and the plugin-prefixed type are limited too', () => {
  const f = H.fixture();
  H.start(f);
  const r = pre(f, sub(f, 'Stop-Process -Name chrome', 'crewgate:crew-worker', { tool_name: 'PowerShell' }));
  assert.equal(decision(r), 'deny');
  assert.equal(H.evs(f, 'agent.limit')[0].data.command, 'stop-process');
  assert.equal(pre(f, sub(f, 'git commit -m x', 'crew-worker')).out, '{}');
});

test('hook: the type comes from the SubagentStart map when the payload has none', () => {
  const f = H.fixture();
  H.start(f);
  sess.remember(f.pid, 'tu-d', { task: 't-20260101-aaaa', type: 'crew-reviewer', bg: false, worker: false, ts: Date.now(), agent: 'ag-1', stopped: false });
  assert.equal(decision(pre(f, sub(f, 'git reset --hard', null))), 'deny');
});

test('hook: the main session and other subagents are never limited', () => {
  const f = H.fixture();
  H.start(f);
  const main = H.base(f, { tool_name: 'Bash', tool_input: { command: 'git checkout x && pkill node' } });
  assert.equal(pre(f, main).out, '{}');
  assert.equal(pre(f, sub(f, 'git checkout x', 'general-purpose')).out, '{}');
  assert.equal(pre(f, sub(f, 'pkill node', 'Explore')).out, '{}');
  assert.equal(pre(f, sub(f, 'git checkout x', null)).out, '{}');
  assert.equal(H.evs(f, 'agent.limit').length, 0);
});

test('prefilter: ordinary commands stay on the fast path, a subagent\'s matching ones do not', () => {
  const b = (command, extra) => bashNoop({ tool_name: 'Bash', tool_input: { command }, ...extra });
  assert.equal(b('npm test'), true);
  assert.equal(b('git checkout x'), true); // main session: nothing to say
  assert.equal(b('ls -la', { agent_id: 'a' }), true);
  assert.equal(b('git diff', { agent_id: 'a' }), true);
  assert.equal(b('git checkout x', { agent_id: 'a' }), false);
  assert.equal(b('taskkill /IM x.exe', { agent_id: 'a' }), false);
});

test('hook: a failure of the check lets the command through', () => {
  const f = H.fixture();
  H.start(f);
  const r = pre(f, sub(f, 'git checkout x', 'crew-reviewer', { tool_input: { command: 5 } }));
  assert.equal(r.out, '{}');
});
