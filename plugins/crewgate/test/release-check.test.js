'use strict';

// crew release check: CI of a commit through an injected gh. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setupHome();
const rel = require('../lib/features/release');
const cmd = require('../lib/commands/release');
const { t } = require('../lib/core/i18n');

const repo = h.makeRepo();
const head = h.git(repo, 'rev-parse', 'HEAD').trim();

// runs: [{ id, name, status, conclusion, jobs:[[name, status, conclusion]] }]
function fakeGh(runs, calls = []) {
  return (args) => {
    calls.push(args);
    assert.equal(args[0], 'run');
    if (args[1] === 'list') {
      assert.equal(args[args.indexOf('--commit') + 1], head);
      return { status: 0, stdout: JSON.stringify(runs.map((r) => ({ databaseId: r.id, workflowName: r.name, status: r.status, conclusion: r.conclusion }))), stderr: '', error: null };
    }
    const r = runs.find((x) => String(x.id) === args[2]);
    return { status: 0, stdout: JSON.stringify({ jobs: r.jobs.map(([name, status, conclusion]) => ({ name, status, conclusion })) }), stderr: '', error: null };
  };
}
const ok = (id = 1) => ({ id, name: 'CI', status: 'completed', conclusion: 'success', jobs: [['a', 'completed', 'success'], ['b', 'completed', 'success']] });

function runCmd(gh, argv = ['check']) {
  const out = []; let json = null;
  const ctx = { workTree: () => repo, gh, t: (k, v) => t('en', k, v), emit: (d, lines) => { json = d; out.push(...lines); } };
  const code = cmd.run(argv, ctx);
  return { code, out: out.join('\n'), json };
}

test('green: every job succeeded -> exit 0, jobs listed', () => {
  const calls = [];
  const r = runCmd(fakeGh([ok()], calls));
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'green');
  assert.match(r.out, /job a: completed \(success\)/);
  assert.ok(calls.every((c) => c[0] === 'run'), 'only reads');
});

test('--commit takes a given commit', () => {
  const r = rel.checkCi({ root: repo, commit: head.slice(0, 10), gh: fakeGh([ok()]) });
  assert.equal(r.commit, head);
  assert.equal(r.state, 'green');
});

test('failed: one failed job -> non-zero and says failed', () => {
  const bad = { ...ok(), conclusion: 'failure', jobs: [['a', 'completed', 'success'], ['b', 'completed', 'failure']] };
  const r = runCmd(fakeGh([bad]));
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'failed');
  assert.match(r.out, /job b: completed \(failure\)/);
  assert.match(r.out, /do not merge or tag/);
});

test('failed wins over pending', () => {
  const bad = { ...ok(1), conclusion: 'failure', jobs: [['a', 'completed', 'failure']] };
  const pend = { id: 2, name: 'Other', status: 'in_progress', conclusion: '', jobs: [['x', 'in_progress', '']] };
  assert.equal(runCmd(fakeGh([bad, pend])).json.state, 'failed');
});

test('pending: a job still running -> non-zero and says pending', () => {
  const pend = { id: 3, name: 'CI', status: 'in_progress', conclusion: '', jobs: [['a', 'completed', 'success'], ['b', 'in_progress', '']] };
  const r = runCmd(fakeGh([pend]));
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'pending');
  assert.match(r.out, /Still pending/);
});

test('pending: a queued run with no jobs yet', () => {
  assert.equal(runCmd(fakeGh([{ id: 4, name: 'CI', status: 'queued', conclusion: '', jobs: [] }])).json.state, 'pending');
});

test('none: no run for the commit -> non-zero and says so', () => {
  const r = runCmd(fakeGh([]));
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'none');
  assert.match(r.out, /No workflow run exists/);
});

test('a skipped job is not a success', () => {
  const sk = { ...ok(), jobs: [['a', 'completed', 'success'], ['b', 'completed', 'skipped']] };
  assert.equal(runCmd(fakeGh([sk])).json.state, 'failed');
});

test('gh missing: a clear message, no result', () => {
  const gh = () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn gh ENOENT' } });
  assert.throws(() => runCmd(gh), (e) => e.key === 'release.ghMissing' && /GitHub CLI \(gh\) was not found/.test(e.message));
});

test('gh failing (not signed in) is an error with its first line', () => {
  const gh = () => ({ status: 1, stdout: '', stderr: 'gh: not logged in\nmore', error: null });
  assert.throws(() => runCmd(gh), (e) => e.key === 'release.ghFailed' && /not logged in/.test(e.message) && !/more/.test(e.message));
});

test('an unknown commit is an error before gh is asked', () => {
  const gh = () => { throw new Error('gh must not be called'); };
  assert.throws(() => rel.checkCi({ root: repo, commit: 'nope-nope', gh }), (e) => e.key === 'release.badRef');
});
