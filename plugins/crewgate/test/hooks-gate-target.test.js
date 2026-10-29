'use strict';

// PostToolUse(Bash): git events and the gate check follow the repo the command targets (cd / pushd / git -C),
// not the repo of the session cwd.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./hooks-helpers');
const { makeRepo, tmpDir } = require('./helpers');
const project = require('../lib/core/project');
const events = require('../lib/core/events');
const gates = require('../lib/core/gates');
const gitcmd = require('../lib/hooks/gitcmd');

const post = (f, command, id) => H.runHook('post-tool-use', H.base(f, {
  tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: { stdout: '' },
}), { cwd: f.repo });

// The session repo plus a second registered project and an unregistered repo.
function two() {
  const f = H.fixture();
  H.start(f);
  const other = makeRepo();
  const otherPid = project.add(other, { name: 'other' }).project.id;
  const stray = makeRepo();
  return { f, other, otherPid, stray };
}
const pushes = (pid) => events.read(pid, { types: 'git.push' });
const missing = (pid) => events.read(pid, { types: 'gate.missing' });
const fwd = (p) => p.split(path.sep).join('/');

test('detect: cd / pushd / git -C words are returned per command', () => {
  const cds = (c) => gitcmd.detect(c).map((x) => x.cd);
  assert.deepEqual(cds('git push'), [[]]);
  assert.deepEqual(cds('cd /x/y && git push'), [['/x/y']]);
  assert.deepEqual(cds('git -C "/x y" push origin main'), [['/x y']]);
  assert.deepEqual(cds('cd a && cd ../b; git merge z'), [['a', '../b']]);
  assert.deepEqual(cds('pushd /x && git push && popd && git push'), [['/x'], []]);
  assert.deepEqual(cds('cd /a && git push; cd /b && git push'), [['/a'], ['/a', '/b']]);
  assert.deepEqual(cds('cd /a && git -C sub push'), [['/a', 'sub']]);
  assert.deepEqual(cds('cd "$DIR" && git push'), [[]]);
  assert.deepEqual(cds('cd $(pwd)/x && git push'), [[]]);
  assert.deepEqual(cds('git -C "$D" push'), [[]]);
  assert.deepEqual(cds('cd /a && cd "$D" && git push'), [[]]);
  assert.equal(gitcmd.detect('cd /x && git push')[0].data.command, 'git push');
});

test('cd into another registered project: events, gate.missing and approval live in that project', () => {
  const { f, other, otherPid } = two();
  const r = post(f, `cd ${fwd(other)} && git push origin feat/x`, 'c1');
  assert.match(r.json.hookSpecificOutput.additionalContext, /"push" gate is set to ask/);
  assert.equal(pushes(otherPid).length, 1);
  assert.equal(missing(otherPid).length, 1);
  assert.equal(pushes(f.pid).length, 0);
  assert.equal(missing(f.pid).length, 0);

  // a yes in the session project does not count for the other one
  H.approve(f);
  assert.match(post(f, `cd ${fwd(other)} && git push`, 'c2').json.hookSpecificOutput.additionalContext, /"push" gate/);
  // a yes in the target project does
  H.approve(f, { pid: otherPid });
  assert.equal(post(f, `cd ${fwd(other)} && git push`, 'c3').out, '{}');
  assert.equal(pushes(otherPid).length, 3);
});

test('git -C and pushd target the other project; a subdir of the same project stays', () => {
  const { f, other, otherPid } = two();
  post(f, `git -C ${fwd(other)} push`, 'g1');
  post(f, `pushd ${fwd(other)} && git push`, 'g2');
  assert.equal(pushes(otherPid).length, 2);
  assert.equal(pushes(f.pid).length, 0);
  // relative: from the session repo up to the other one
  const rel = fwd(path.relative(f.repo, other));
  post(f, `cd ${rel} && git push`, 'g3');
  assert.equal(pushes(otherPid).length, 3);
  // cd into a subdirectory of the session project
  require('node:fs').mkdirSync(path.join(f.repo, 'sub'));
  post(f, 'cd sub && git push', 'g4');
  assert.equal(pushes(f.pid).length, 1);
});

test('several segments with different cds each go to their own project', () => {
  const { f, other, otherPid } = two();
  const r = post(f, `git push && cd ${fwd(other)} && git push && cd ${fwd(f.repo)} && git push`, 'm1');
  assert.equal(pushes(f.pid).length, 2);
  assert.equal(pushes(otherPid).length, 1);
  assert.equal(missing(f.pid).length, 1, 'one reminder per project and gate');
  assert.equal(missing(otherPid).length, 1);
  assert.ok(r.json.hookSpecificOutput.additionalContext);
});

test('a directory outside every registered project records nothing and is not registered', () => {
  const { f, stray } = two();
  const before = project.list().length;
  assert.equal(post(f, `cd ${fwd(stray)} && git push`, 'u1').out, '{}');
  assert.equal(post(f, `git -C ${fwd(stray)} push`, 'u2').out, '{}');
  assert.equal(pushes(f.pid).length, 0);
  assert.equal(missing(f.pid).length, 0);
  assert.equal(project.list().length, before);
  const nowhere = path.join(tmpDir('crew-none-'), 'does', 'not', 'exist');
  assert.equal(post(f, `cd ${fwd(nowhere)} && git push`, 'u3').out, '{}');
});

test('no cd, and dynamic directories, behave as before (session project)', () => {
  const { f, otherPid } = two();
  assert.match(post(f, 'git push origin feat/x', 'n1').json.hookSpecificOutput.additionalContext, /"push" gate/);
  post(f, 'cd "$DIR" && git push', 'n2');
  post(f, 'git -C "$(pwd)/x" push', 'n3');
  assert.equal(pushes(f.pid).length, 3);
  assert.equal(pushes(otherPid).length, 0);
  assert.equal(missing(f.pid).length, 3);
});

test('Git-Bash style /c/... paths resolve on Windows', { skip: process.platform !== 'win32' }, () => {
  const { f, other, otherPid } = two();
  const m = /^([A-Za-z]):(.*)$/.exec(other);
  assert.ok(m, 'temp repo has a drive letter');
  post(f, `cd /${m[1].toLowerCase()}${fwd(m[2])} && git push`, 'w1');
  assert.equal(pushes(otherPid).length, 1);
  assert.equal(pushes(f.pid).length, 0);
});

test('detect: a cd in a subshell or pipeline does not carry past it; && and ; do', () => {
  const cds = (c) => gitcmd.detect(c).map((x) => x.cd);
  assert.deepEqual(cds('(cd /o && git push); git push'), [['/o'], []]);
  assert.deepEqual(cds('(cd /o; git push) && git push'), [['/o'], []]);
  assert.deepEqual(cds('cd /a && (cd /b && git push) && git push'), [['/a', '/b'], ['/a']]);
  assert.deepEqual(cds('cd /o | cat; git push'), [[]]);
  assert.deepEqual(cds('cd /o & git push'), [[]]);
  assert.deepEqual(cds('echo | cd /o; git push'), [[]]);
  assert.deepEqual(cds('cd /o && git push'), [['/o']]);
  assert.deepEqual(cds('cd /o; git push'), [['/o']]);
  assert.deepEqual(cds('cd /o || git push'), [['/o']]);
  assert.deepEqual(cds(') git push'), [[]]);
});

test('subshell cd: the push after it is recorded in the session project', () => {
  const { f, other, otherPid } = two();
  post(f, `(cd ${fwd(other)} && git status); git push`, 's1');
  assert.equal(pushes(f.pid).length, 1);
  assert.equal(pushes(otherPid).length, 0);
});

test('a registered repo nested inside the session repo is its own project', () => {
  const { f } = two();
  const fs = require('node:fs');
  const nested = path.join(f.repo, 'nested');
  fs.mkdirSync(nested);
  require('./helpers').git(nested, 'init', '-q');
  fs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
  require('./helpers').git(nested, 'add', '.');
  require('./helpers').git(nested, 'commit', '-q', '-m', 'init');
  const nestedPid = project.add(nested, { name: 'nested' }).project.id;
  assert.notEqual(nestedPid, f.pid);
  post(f, 'cd nested && git push', 'x1');
  assert.equal(pushes(nestedPid).length, 1);
  assert.equal(missing(nestedPid).length, 1);
  assert.equal(pushes(f.pid).length, 0);
  post(f, 'git -C nested push', 'x2');
  assert.equal(pushes(nestedPid).length, 2);
  post(f, 'git push', 'x3');
  assert.equal(pushes(f.pid).length, 1);
});
