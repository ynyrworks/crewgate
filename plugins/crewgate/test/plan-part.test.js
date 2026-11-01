'use strict';

// plan part keeps line breaks, says what it replaced and appends with --add; a value may start with "-"; plan new prints the settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./helpers');

h.setupHome();
const projects = require('../lib/core/project');
const plans = require('../lib/core/plans');
const { parse } = require('../lib/core/args');

const repo = h.makeRepo();
projects.add(repo, { name: 'demo' });
const crew = (...a) => h.crew(['plan', ...a], repo);
const file = (slug) => `${repo}/.crew/plans/${slug}.md`;
const text = (slug) => fs.readFileSync(file(slug), 'utf8');
const mk = (slug) => assert.equal(crew('new', slug, '--title', 'T', '--goal', 'G').code, 0);

test('args: a value may start with "-" unless it exactly names an option; text with whitespace is never an option', () => {
  const spec = { positionals: [{ name: 'p', optional: true }], options: { '--a': { dest: 'a' }, '--n': { dest: 'n', int: true }, '--f': { dest: 'f', flag: true } } };
  assert.equal(parse(['--a', '- item'], spec).a, '- item');
  assert.equal(parse(['--a', '--tag x'], spec).a, '--tag x');
  assert.equal(parse(['--a', '-x'], spec).a, '-x');
  assert.equal(parse(['--a=-x y'], spec).a, '-x y');
  assert.equal(parse(['- item'], spec).p, '- item');
  assert.equal(parse(['--tag x'], spec).p, '--tag x');
  assert.equal(parse(['--n', '-5'], spec).n, -5);
  assert.equal(parse(['--', '-x'], spec).p, '-x');
  assert.throws(() => parse(['--a', '--f'], spec), (e) => e.key === 'args.needsValue');
  assert.throws(() => parse(['--a', '--a', 'x'], spec), (e) => e.key === 'args.needsValue');
  assert.throws(() => parse(['--a', '--'], spec), (e) => e.key === 'args.needsValue');
  assert.throws(() => parse(['--a'], spec), (e) => e.key === 'args.needsValue');
  assert.throws(() => parse(['--bogus', 'x'], spec), (e) => e.key === 'args.unknownOption');
  assert.throws(() => parse(['-x'], spec), (e) => e.key === 'args.unknownOption');
});

test('plan: --title --goal x still reports a missing value, and an unknown option is refused', () => {
  const r = crew('new', 'bad', '--title', '--goal', 'x');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--title/);
  assert.notEqual(crew('new', 'bad2', '--title', 'T', '--nope', 'x').code, 0);
});

test('plan clarify takes values that start with "-", and --by decision', () => {
  mk('c1');
  assert.equal(crew('clarify', 'c1', '--question', 'Which tag?', '--answer', '--tag x').code, 0);
  assert.equal(crew('clarify', 'c1', '--question', 'Q2', '--answer', '- x', '--by', 'decision').code, 0);
  const t = text('c1');
  assert.match(t, /A: --tag x \(user\)/);
  assert.match(t, /A: - x \(decision\)/);
  assert.deepEqual(plans.readyProblems(plans.parse(t)).filter((p) => p === 'assumed'), []);
});

test('plan part: setting again prints what was replaced; the first set prints nothing of the kind', () => {
  mk('p1');
  const first = crew('part', 'p1', 'not-doing', 'old text');
  assert.equal(first.code, 0, first.err);
  assert.doesNotMatch(first.out, /Replaced/);
  const second = crew('part', 'p1', 'not-doing', 'new text');
  assert.equal(second.code, 0);
  assert.match(second.out, /Replaced the earlier text: old text/);
  assert.match(text('p1'), /## Not doing\nnew text\n/);
  assert.doesNotMatch(text('p1'), /old text/);
});

test('plan part --add appends a line, also when the part does not exist yet', () => {
  mk('p2');
  assert.equal(crew('part', 'p2', 'not-doing', '--add', 'one').code, 0);
  assert.equal(crew('part', 'p2', 'not-doing', '--add', '- two').code, 0);
  const r = crew('part', 'p2', 'not-doing', 'three', '--add');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Replaced/);
  assert.match(text('p2'), /## Not doing\none\n- two\nthree\n/);
  assert.equal(plans.parse(text('p2')).notDoing, 'one two three');
});

test('plan part keeps line breaks as lines and takes a value starting with "- "', () => {
  mk('p3');
  assert.equal(crew('part', 'p3', 'done-when', '- a\n- b\r\nc').code, 0);
  assert.match(text('p3'), /## Done when\n- a\n- b\nc\n/);
  assert.equal(plans.parse(text('p3')).doneWhen, 'a b c');
});

test('plan part refuses a line that would start a heading or a step, and writes nothing', () => {
  mk('p4');
  const before = text('p4');
  for (const bad of ['fine\n# Heading', '## Done when', '- [ ] a step', 'x\n* [x] done']) {
    const r = crew('part', 'p4', 'not-doing', bad);
    assert.notEqual(r.code, 0, bad);
    assert.match(r.err, /cannot start with/);
  }
  assert.equal(text('p4'), before);
  assert.equal(crew('part', 'p4', 'not-doing', '- plain item\n#hashtag is fine').code, 0);
});

test('approved hash of a plan whose parts did not change is the same as before', () => {
  mk('p5');
  crew('part', 'p5', 'not-doing', 'No UI');
  crew('part', 'p5', 'done-when', 'Green');
  crew('add', 'p5', 'step');
  const h1 = plans.approvedHash(text('p5'));
  crew('part', 'p5', 'not-doing', 'No UI');
  assert.equal(plans.approvedHash(text('p5')), h1);
  assert.equal(h1, plans.approvedHash('# T\n\nG\n\n## Not doing\nNo UI\n\n## Done when\nGreen\n\n- [ ] step\n'));
});

test('plan new prints the three settings, and tells the model to ask when plan.review is ask', () => {
  const plain = crew('new', 's1', '--title', 'T', '--goal', 'G');
  assert.match(plain.out, /plan\.interview=on, plan\.review=large, plan\.enforce=block/);
  assert.doesNotMatch(plain.out, /ask the user whether/);
  fs.mkdirSync(`${repo}/.claude`, { recursive: true });
  fs.writeFileSync(`${repo}/.claude/crew.json`, JSON.stringify({ plan: { review: 'ask' } }));
  const ask = crew('new', 's2', '--title', 'T', '--goal', 'G');
  assert.match(ask.out, /plan\.review=ask/);
  assert.match(ask.out, /ask the user whether they want a plan review/);
});
