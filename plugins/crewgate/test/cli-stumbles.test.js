'use strict';

// Small CLI stumbles: `crew <group> help`, a closed pipe on stdout, text values that start with "-", and the three-part drift stop messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const h = require('./helpers');

h.setupHome();
const projects = require('../lib/core/project');
const cli = require('../lib/core/cli');
const { parse } = require('../lib/core/args');
const { t } = require('../lib/core/i18n');

const repo = h.makeRepo();
projects.add(repo, { name: 'demo' });

test('crew <group> help and crew help <group> print what --help prints, for every group', () => {
  const groups = cli.listGroups().map((g) => g.name);
  assert.ok(groups.includes('plan') && groups.length > 5);
  for (const g of groups) {
    const ref = h.crew([g, '--help'], repo);
    assert.equal(ref.code, 0, g);
    assert.ok(ref.out.length > 0, g);
    for (const args of [[g, 'help'], ['help', g]]) {
      const r = h.crew(args, repo);
      assert.equal(r.code, 0, args.join(' '));
      assert.equal(r.out, ref.out, args.join(' '));
    }
  }
  const top = h.crew(['--help'], repo);
  const help = h.crew(['help'], repo);
  assert.equal(help.code, 0);
  assert.equal(help.out, top.out);
  const bad = h.crew(['help', 'nonesuch'], repo);
  assert.notEqual(bad.code, 0);
});

test('a closed pipe on stdout ends crew without a stack trace and with exit 0', async () => {
  assert.equal(h.crew(['plan', 'new', 'big', '--title', 'T', '--goal', 'G'], repo).code, 0);
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push(`- item ${i} ${'x'.repeat(60)}`);
  const file = `${repo}/.crew/plans/big.md`;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Not doing\n', `## Not doing\n${lines.join('\n')}\n`));
  for (let round = 0; round < 3; round++) {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [h.BIN, 'plan', 'show', 'big'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let first = false;
      c.stderr.on('data', (d) => { err += d; });
      c.stdout.on('data', () => { if (!first) { first = true; c.stdout.destroy(); } });
      c.on('close', (code) => resolve({ code, err, first }));
    });
    assert.ok(r.first);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
  }
});

test('a closed pipe never turns a failure into success: unknown option still exits 2, no stack trace', async () => {
  const evidence = `${h.tmpDir()}/stream-errors.log`;
  for (let round = 0; round < 3; round++) {
    const r = await new Promise((resolve) => {
      // CREWGATE_STREAM_ERROR_LOG (honoured only with CREWGATE_TEST=1) leaves the code of each stream error where the closed pipes cannot hide it
      const env = { ...process.env, CREWGATE_TEST: '1', CREWGATE_STREAM_ERROR_LOG: evidence };
      const c = spawn(process.execPath, [h.BIN, 'plan', 'show', 'big', '--bogus'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      // the reader closes both pipes before the command writes its error
      c.stdout.destroy();
      c.stderr.destroy();
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
    const seen = fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8') : '(no stream error recorded)';
    assert.equal(r.code, 2, `round ${round}: exit code ${r.code}, signal ${r.signal}, stderr read: ${JSON.stringify(r.err)}, stream error codes seen by the child:
${seen}`);
    assert.equal(r.out, '');
  }
  // a reader that closes after the first line of a failing command's stderr
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [h.BIN, 'plan', 'show', 'big', '--bogus'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; c.stderr.destroy(); });
    c.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /at .*\.js:\d+|EPIPE/);
});

test('plan part takes a text value that starts with "-" (also a single word), a real unknown option still errors', () => {
  const crew = (...a) => h.crew(['plan', ...a], repo);
  assert.equal(crew('new', 'dash', '--title', 'T', '--goal', 'G').code, 0);
  const text = () => fs.readFileSync(`${repo}/.crew/plans/dash.md`, 'utf8');
  assert.equal(crew('part', 'dash', 'not-doing', '- first item').code, 0);
  assert.match(text(), /## Not doing\n- first item\n/);
  assert.equal(crew('part', 'dash', 'done-when', '- item').code, 0);
  assert.match(text(), /## Done when\n- item\n/);
  assert.equal(crew('part', 'dash', 'done-when', '- a\n- b').code, 0);
  assert.match(text(), /## Done when\n- a\n- b\n/);
  assert.equal(crew('part', 'dash', 'not-doing', '-nothing').code, 0);
  assert.match(text(), /## Not doing\n-nothing\n/);
  assert.equal(crew('part', 'dash', 'not-doing', '--add', '-more').code, 0);
  assert.match(text(), /## Not doing\n-nothing\n-more\n/);
  const bad = crew('part', 'dash', 'not-doing', 'x', '--bogus');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--bogus/);
  assert.equal(crew('part', 'dash', 'not-doing', '--bogus').code, 2);
});

test('args: a text positional takes an undeclared single-dash word; options keep winning', () => {
  const spec = { positionals: [{ name: 'a' }, { name: 'text', text: true, optional: true }], options: { '--f': { dest: 'f', flag: true }, '-q': { dest: 'q', flag: true } } };
  assert.equal(parse(['s', '-x'], spec).text, '-x');
  assert.equal(parse(['s', '-q'], spec).q, true);
  assert.equal(parse(['s', '-q'], spec).text, undefined);
  assert.throws(() => parse(['-x', 'a', 'b'], spec), (e) => e.key === 'args.unknownOption');
  assert.throws(() => parse(['s', '--zz'], spec), (e) => e.key === 'args.unknownOption');
  assert.throws(() => parse(['s', 't', '-x'], spec), (e) => e.key === 'args.unknownOption');
  assert.equal(parse(['s', '--', '--zz'], spec).text, '--zz');
});

test('the out-of-scope, changed-plan and accept-on-changed-plan stop messages have the three labelled parts and the add-or-new sentence', () => {
  const keys = [
    ['plan.driftNewStep', 'plan'], ['wf.task.acceptOutOfScopePlan', 'workflow'], ['hooks.deny.planChanged', 'hooks'], ['wf.task.acceptPlanChanged', 'workflow'],
  ];
  for (const [k] of keys) {
    const en = t('en', k, { id: 't1', slug: 's', slugs: 's', files: 'a.js', cmd: 'crew' });
    assert.match(en, /\n {2}Expected: .+\n {2}Found: .+\n {2}Why it matters: .+\n/, k);
    assert.match(en, /Choose add when .* new when /, k);
    const zh = t('zh-TW', k, { id: 't1', slug: 's', slugs: 's', files: 'a.js', cmd: 'crew' });
    assert.match(zh, /\n {2}預期：.+\n {2}發現：.+\n {2}為什麼重要：.+\n/, k);
    assert.match(zh, /就選 add；.*就選 new/, k);
  }
});

test('plan add, plan edit, log add, need add, work set and mr set take text values that start with "-"; a real unknown option still errors', () => {
  const run = (...a) => h.crew(a, repo);
  const ok = (...a) => { const r = run(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r; };
  ok('plan', 'new', 'dash2', '--title', 'T', '--goal', 'G');
  const plan = () => fs.readFileSync(`${repo}/.crew/plans/dash2.md`, 'utf8');
  ok('plan', 'add', 'dash2', '- first step');
  assert.match(plan(), /- first step/);
  ok('plan', 'add', 'dash2', '-single');
  assert.match(plan(), /-single/);
  const id = (plan().match(/\bn\d+\b/g) || []).pop();
  assert.ok(id, 'a node id exists');
  ok('plan', 'edit', 'dash2', id, '-edited');
  assert.match(plan(), /-edited/);
  ok('log', 'add', 'me', '-logged');
  assert.match(ok('log', 'list').out, /-logged/);
  ok('need', 'add', '-needed');
  assert.match(ok('need', 'list').out, /-needed/);
  ok('work', 'set', 'stream1', '-wtitle', 'doing', '-wnote');
  const items = JSON.stringify(JSON.parse(ok('work', 'list', '--json').out));
  assert.match(items, /-wtitle/);
  assert.match(items, /-wnote/);
  ok('mr', 'set', '7', '-mrtitle');
  assert.match(ok('mr', 'list').out, /-mrtitle/);
  for (const a of [['plan', 'add', 'dash2', 'x', '--bogus'], ['log', 'add', 'me', 'x', '--bogus'], ['need', 'add', 'x', '--bogus'], ['work', 'set', 's', 'x', 'doing', 'n', '--bogus'], ['mr', 'set', '8', 'x', '--bogus']]) {
    const r = run(...a);
    assert.equal(r.code, 2, a.join(' '));
    assert.match(r.err, /--bogus/);
  }
});
