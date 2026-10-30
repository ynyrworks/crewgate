'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');

h.setupHome();
const plans = require('../lib/core/plans');
const tasks = require('../lib/core/tasks');
const events = require('../lib/core/events');
const projects = require('../lib/core/project');

const SAMPLE = [
  '# 0.14 plan',
  'Optional free text.',
  '',
  '- [ ] Plan tree and completion view <!-- id:n1 added:2026-10-30 origin:plan -->',
  '  - [x] File format and CLI <!-- id:n2 task:t-abc123 added:2026-10-30 origin:plan -->',
  '  - [ ] Board page <!-- id:n3 task:t-def456 -->',
  '- [~] Dropped idea <!-- id:n4 origin:review added:2026-10-31 -->',
  '- [?] Proposed by refuter <!-- id:n5 origin:refute added:2026-10-31 -->',
  '',
].join('\n');

const noTasks = () => null;
const byId = (d, id) => { let hit = null; const walk = (l) => l.forEach((n) => { if (n.id === id) hit = n; walk(n.children); }); walk(d.nodes); return hit; };

test('parser: round trip keeps every byte of an untouched file', () => {
  for (const text of [SAMPLE, SAMPLE.replace(/\n/g, '\r\n'), SAMPLE.trimEnd(), '', '\n', '# only a title\n']) {
    assert.equal(plans.serialize(plans.parse(text)), text);
  }
});

test('parser: title, goal, nodes, boxes, depth and metadata', () => {
  const doc = plans.parse(SAMPLE);
  assert.equal(doc.title, '0.14 plan');
  assert.equal(doc.goal, 'Optional free text.');
  assert.equal(doc.nodes.length, 5);
  const [n1, n2, n3, n4, n5] = doc.nodes;
  assert.deepEqual([n1.depth, n2.depth, n3.depth, n4.depth], [1, 2, 2, 1]);
  assert.equal(n2.parent, n1);
  assert.equal(n1.children.length, 2);
  assert.equal(n2.box, 'x');
  assert.equal(n4.box, '~');
  assert.equal(n5.box, '?');
  assert.equal(n2.meta.task, 't-abc123');
  assert.equal(n1.text, 'Plan tree and completion view');
});

test('parser: unknown keys and junk tokens survive a rewrite, text and order are kept', () => {
  const text = '# t\n- [ ] one <!-- id:n1 flavor:mint stray added:2026-01-02 -->\n\nnotes between\n- [ ] two\n';
  const doc = plans.parse(text);
  assert.equal(doc.nodes[0].meta.flavor, 'mint');
  plans.assignIds(doc);
  const out = plans.serialize(doc);
  assert.equal(out, '# t\n- [ ] one <!-- id:n1 flavor:mint stray added:2026-01-02 -->\n\nnotes between\n- [ ] two <!-- id:n2 -->\n');
  // an untouched line is not reformatted
  assert.ok(out.includes('notes between'));
});

test('parser: tolerant of bad lines, tabs, odd indentation, dup ids and a comment in the middle of the text', () => {
  const text = [
    '# t', 'garbage line', '- not a task', '- [z] bad box', '-[ ] no space', '- [ ] ',
    '- [ ] good <!-- id:a --> trailing? <!-- id:n1 -->',
    '\t- [ ] tab child <!-- id:n1 -->',
    '        - [ ] eight-space grandchild',
    '   - [ ] three-space sibling of the tab child?',
    '  * [X] star bullet done',
  ].join('\n');
  const doc = plans.parse(text);
  assert.equal(doc.nodes.length, 5);
  const good = doc.nodes[0];
  assert.equal(good.meta.id, 'n1');
  assert.ok(good.text.includes('<!-- id:a -->'));
  assert.equal(doc.nodes[1].depth, 2);
  assert.equal(doc.nodes[2].depth, 3);
  assert.equal(doc.nodes[4].box, 'x');
  assert.doesNotThrow(() => plans.derive(doc, noTasks));
  plans.assignIds(doc);
  const ids = doc.nodes.map((n) => n.meta.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids are replaced');
  // a hand-written tree keeps its text
  assert.ok(plans.serialize(doc).includes('garbage line\n- not a task\n- [z] bad box'));
});

test('parser: a heading restarts the nesting and maxNodes truncates', () => {
  const doc = plans.parse('- [ ] a\n  - [ ] b\n## Phase 2\n  - [ ] c\n');
  assert.deepEqual(doc.nodes.map((n) => n.depth), [1, 2, 1]);
  const cut = plans.parse('- [ ] a\n- [ ] b\n- [ ] c\n', { maxNodes: 2 });
  assert.equal(cut.nodes.length, 2);
  assert.equal(cut.truncated, true);
});

test('derived state: box, task states and unknown links', () => {
  const state = (map) => (id) => map[id] || null;
  const doc = plans.parse([
    '- [ ] a <!-- id:a task:t1 -->', '- [ ] b <!-- id:b task:t2 -->', '- [ ] c <!-- id:c task:t3 -->',
    '- [ ] d <!-- id:d task:t4 -->', '- [ ] e <!-- id:e task:t5 -->', '- [ ] f <!-- id:f task:gone -->',
    '- [x] g <!-- id:g task:t3 -->', '- [ ] h <!-- id:h task:t6 -->', '- [ ] i <!-- id:i task:t7 -->', '- [ ] j <!-- id:j -->',
  ].join('\n'));
  const d = plans.derive(doc, state({ t1: 'merged', t2: 'accepted', t3: 'cancelled', t4: 'dispatched', t5: 'returned', t6: 'reviewing', t7: 'created' }));
  const st = Object.fromEntries(d.nodes.map((n) => [n.id, n.state]));
  assert.deepEqual(st, { a: 'done', b: 'done', c: 'blocked', d: 'doing', e: 'review', f: 'todo', g: 'done', h: 'review', i: 'todo', j: 'todo' });
  assert.equal(byId(d, 'f').task.missing, true);
  assert.equal(byId(d, 'c').task.state, 'cancelled');
  assert.equal(d.summary.blocked, 1);
  assert.equal(d.summary.done, 3);
  assert.equal(d.summary.total, 10);
});

test('progress math: parents count leaves, dropped and proposed are excluded, a done box wins', () => {
  const doc = plans.parse([
    '- [ ] root <!-- id:r -->',
    '  - [x] one <!-- id:l1 -->',
    '  - [ ] two <!-- id:l2 task:t1 -->',
    '  - [~] dropped <!-- id:l3 -->',
    '  - [?] proposed <!-- id:l4 -->',
    '  - [ ] sub <!-- id:s -->',
    '    - [x] a <!-- id:s1 -->',
    '    - [x] b <!-- id:s2 -->',
    '- [ ] hand done <!-- id:h -->',
    '  - [ ] x <!-- id:h1 -->',
    '  - [ ] y <!-- id:h2 -->',
  ].join('\n').replace('- [ ] hand done', '- [x] hand done'));
  const d = plans.derive(doc, (id) => (id === 't1' ? 'dispatched' : null));
  const r = byId(d, 'r');
  assert.equal(r.total, 4);                 // one, two, a, b
  assert.equal(r.done, 3);
  assert.equal(r.pct, 75);
  assert.equal(r.state, 'doing');
  assert.equal(byId(d, 's').state, 'done');
  assert.equal(byId(d, 'h').state, 'done');
  assert.equal(byId(d, 'h').pct, 100);
  assert.equal(byId(d, 'l3').state, 'dropped');
  assert.equal(byId(d, 'l4').state, 'proposed');
  assert.equal(d.summary.total, 4 + 2);     // r's 4 plus the two hand-done leaves
  assert.equal(d.summary.done, 3 + 2);
  assert.equal(d.summary.pct, Math.round((100 * 5) / 6));
  assert.equal(d.summary.proposed, 1);
  assert.equal(d.summary.dropped, 1);
  // a parent whose children are all excluded counts as a leaf
  const only = plans.derive(plans.parse('- [ ] p <!-- id:p -->\n  - [~] q <!-- id:q -->\n'), noTasks);
  assert.equal(byId(only, 'p').total, 1);
  assert.equal(byId(only, 'p').state, 'todo');
});

test('add: ids, origin, added date, depth limit, node cap and placement', () => {
  const doc = plans.parse('# t\n\n- [ ] top\n  - [ ] child\n- [ ] second\n\nTrailing note\n');
  plans.assignIds(doc);
  const a = plans.addNode(doc, { text: 'grand', under: 'n2', origin: 'user', date: '2026-10-30' });
  assert.equal(a.depth, 3);
  assert.equal(a.meta.origin, 'user');
  const c = plans.addNode(doc, { text: 'sibling', under: 'n2', date: '2026-10-30' });
  assert.equal(c.depth, 3);
  assert.throws(() => plans.addNode(doc, { text: 'too deep', under: a.meta.id, date: '2026-10-30' }), (e) => e.key === 'plan.tooDeep');
  assert.throws(() => plans.addNode(doc, { text: 'x', under: 'nope', date: '2026-10-30' }), (e) => e.key === 'plan.noNode');
  assert.throws(() => plans.addNode(doc, { text: 'x', origin: 'weird', date: '2026-10-30' }), (e) => e.key === 'plan.badOrigin');
  assert.throws(() => plans.addNode(doc, { text: '  ', date: '2026-10-30' }), (e) => e.key === 'plan.noText');
  const p = plans.addNode(doc, { text: 'later <!-- evil --> idea', proposed: true, date: '2026-10-31' });
  assert.equal(p.box, '?');
  assert.ok(!p.text.includes('<!--'));
  const out = plans.serialize(doc);
  const lines = out.split('\n');
  assert.ok(lines.indexOf('    - [ ] grand <!-- id:n4 added:2026-10-30 origin:user -->') < lines.indexOf('- [ ] second <!-- id:n3 -->'));
  assert.ok(lines.some((l) => l.startsWith('- [?] later') && l.includes('origin:plan')));
  assert.ok(out.endsWith('Trailing note\n'), 'a trailing note stays last');
  const big = plans.parse(Array.from({ length: plans.MAX_NODES }, (_, i) => `- [ ] n${i}`).join('\n'));
  assert.throws(() => plans.addNode(big, { text: 'one more', date: '2026-10-30' }), (e) => e.key === 'plan.tooMany');
});

test('remove: only a leaf', () => {
  const doc = plans.parse('- [ ] a <!-- id:a -->\n  - [ ] b <!-- id:b -->\n');
  assert.throws(() => plans.removeNode(doc, plans.find(doc, 'a')), (e) => e.key === 'plan.hasChildren');
  plans.removeNode(doc, plans.find(doc, 'b'));
  assert.equal(plans.serialize(doc), '- [ ] a <!-- id:a -->\n');
});

test('slugs are checked', () => {
  for (const bad of ['', 'Upper', 'a/b', '..', 'a b', 'x'.repeat(41)]) assert.throws(() => plans.checkSlug(bad), (e) => e.key === 'plan.badSlug');
  assert.equal(plans.checkSlug('0-14-plan'), '0-14-plan');
});

// ---------------------------------------------------------------- CLI
const crewJ = (repo, ...args) => u.crewJson(args, repo);

test('CLI: new, add, link, set, show, list, rm in a scratch repo', () => {
  const repo = u.initRepo();
  const proj = projects.findByCwd(repo);
  assert.ok(proj, 'init registers the project');
  assert.equal(crewJ(repo, 'plan', 'new', 'demo', '--title', 'Demo plan', '--goal', 'Ship it').code, 0);
  const file = path.join(repo, '.crew', 'plans', 'demo.md');
  assert.equal(fs.readFileSync(file, 'utf8'), '# Demo plan\nShip it\n\n');
  assert.equal(crewJ(repo, 'plan', 'new', 'demo', '--title', 'again').code, 1, 'exists');
  assert.equal(crewJ(repo, 'plan', 'new', 'Bad Slug', '--title', 'x').code, 1);
  assert.equal(crewJ(repo, 'plan', 'new', 'x').code, 2, 'title required');

  const a = crewJ(repo, 'plan', 'add', 'demo', 'First step');
  assert.equal(a.data.id, 'n1');
  assert.equal(a.data.origin, 'plan');
  assert.match(a.data.added, /^\d{4}-\d{2}-\d{2}$/);
  const b = crewJ(repo, 'plan', 'add', 'demo', 'Sub step', '--under', 'n1', '--origin', 'user');
  assert.equal(b.data.depth, 2);
  const c = crewJ(repo, 'plan', 'add', 'demo', 'Maybe', '--under', 'n1', '--proposed', '--origin', 'refute');
  assert.equal(c.data.state, 'proposed');
  assert.equal(crewJ(repo, 'plan', 'add', 'demo', 'x', '--under', 'n9').code, 1);
  assert.equal(crewJ(repo, 'plan', 'add', 'demo', 'x', '--origin', 'bogus').code, 2);
  assert.equal(crewJ(repo, 'plan', 'add', 'nosuch', 'x').code, 1);
  const g = crewJ(repo, 'plan', 'add', 'demo', 'Level 3', '--under', 'n2');
  assert.equal(g.data.depth, 3);
  assert.equal(crewJ(repo, 'plan', 'add', 'demo', 'Level 4', '--under', g.data.id).code, 1, 'depth limit');

  const t = tasks.createTask(proj.id, { title: 'Impl', brief: h.GOOD_BRIEF });
  assert.equal(crewJ(repo, 'plan', 'link', 'demo', g.data.id, 't-20200101-zzzz').code, 1, 'unknown task');
  assert.equal(crewJ(repo, 'plan', 'link', 'demo', g.data.id, t.id).code, 0);
  assert.ok(fs.readFileSync(file, 'utf8').includes(`task:${t.id}`));

  let show = crewJ(repo, 'plan', 'show', 'demo');
  assert.equal(show.code, 0, show.err);
  assert.equal(show.data.title, 'Demo plan');
  assert.equal(show.data.summary.proposed, 1);
  assert.equal(byId(show.data, g.data.id).task.state, 'created');
  tasks.transition(proj.id, t.id, 'dispatched');
  assert.equal(byId(crewJ(repo, 'plan', 'show', 'demo').data, g.data.id).state, 'doing');

  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'accept').code, 0);
  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'accept').code, 1, 'not proposed any more');
  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'done').data.state, 'done');
  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'dropped').data.state, 'dropped');
  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'open').data.state, 'open');
  assert.equal(crewJ(repo, 'plan', 'set', 'demo', 'n3', 'bogus').code, 2);

  assert.equal(crewJ(repo, 'plan', 'rm', 'demo', 'n1').code, 1, 'has children');
  assert.equal(crewJ(repo, 'plan', 'rm', 'demo', 'n3').code, 0);

  const text = h.crew(['plan', 'show', 'demo'], repo);
  assert.match(text.out, /demo: Demo plan/);
  assert.match(text.out, /n2 {2}\[ \] Sub step/);
  const list = crewJ(repo, 'plan', 'list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].slug, 'demo');
  assert.equal(h.crew(['plan', 'list'], repo).code, 0);
  assert.equal(h.crew(['plan'], repo).code, 2);
  assert.equal(h.crew(['plan', 'bogus'], repo).code, 2);

  // events: created, node_added with origin, node_changed
  const types = events.read(proj.id, { types: 'plan.*' });
  assert.ok(types.some((e) => e.type === 'plan.created' && e.data.slug === 'demo'));
  const added = types.filter((e) => e.type === 'plan.node_added');
  assert.ok(added.some((e) => e.data.origin === 'user'));
  assert.ok(added.some((e) => e.data.proposed === true && e.data.origin === 'refute'));
  assert.ok(types.filter((e) => e.type === 'plan.node_changed').length >= 4);
  assert.ok(!JSON.stringify(types).includes('Sub step'), 'events carry ids, not node text');
});

test('CLI: a hand-written plan gets ids on the first write and keeps its text; Lnn addresses id-less lines', () => {
  const repo = u.initRepo();
  const file = path.join(repo, '.crew', 'plans', 'hand.md');
  h.crew(['plan', 'new', 'hand', '--title', 'x'], repo);
  fs.writeFileSync(file, '# Hand\nNotes up here.\n\n- [ ] one\n  - [ ] two\n\nA note.\n- [x] three\n');
  const show = crewJ(repo, 'plan', 'show', 'hand');
  assert.deepEqual(show.data.nodes.map((n) => n.id), ['L4', 'L8']);
  assert.equal(crewJ(repo, 'plan', 'set', 'hand', 'L5', 'done').code, 0);
  const out = fs.readFileSync(file, 'utf8');
  assert.equal(out, '# Hand\nNotes up here.\n\n- [ ] one <!-- id:n1 -->\n  - [x] two <!-- id:n2 -->\n\nA note.\n- [x] three <!-- id:n3 -->\n');
});

test('CLI: task create --plan links the new task and refuses a bad target before creating it', () => {
  const repo = u.initRepo();
  const proj = projects.findByCwd(repo);
  h.crew(['plan', 'new', 'demo', '--title', 'T'], repo);
  h.crew(['plan', 'add', 'demo', 'Step'], repo);
  fs.writeFileSync(path.join(repo, 'brief.md'), h.GOOD_BRIEF);
  const before = tasks.list(proj.id).length;
  assert.equal(crewJ(repo, 'task', 'create', '--title', 'X', '--brief-file', 'brief.md', '--plan', 'demo:n9').code, 1);
  assert.equal(crewJ(repo, 'task', 'create', '--title', 'X', '--brief-file', 'brief.md', '--plan', 'nosuch:n1').code, 1);
  assert.equal(crewJ(repo, 'task', 'create', '--title', 'X', '--brief-file', 'brief.md', '--plan', 'bad').code, 2);
  assert.equal(tasks.list(proj.id).length, before, 'no orphan task');
  const ok = crewJ(repo, 'task', 'create', '--title', 'X', '--brief-file', 'brief.md', '--plan', 'demo:n1');
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(ok.data.plan, { slug: 'demo', node: 'n1' });
  assert.equal(byId(crewJ(repo, 'plan', 'show', 'demo').data, 'n1').task.id, ok.data.task.id);
});

test('doctor warns about nodes nested deeper than the limit', () => {
  const repo = u.initRepo();
  h.crew(['plan', 'new', 'deep', '--title', 'x'], repo);
  fs.appendFileSync(path.join(repo, '.crew', 'plans', 'deep.md'), '- [ ] a\n  - [ ] b\n    - [ ] c\n      - [ ] d\n');
  const r = crewJ(repo, 'doctor');
  const c = r.data.checks.find((x) => x.name === 'plans');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /deep:/);
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'deep.md'), '- [ ] a\n');
  assert.equal(crewJ(repo, 'doctor').data.checks.find((x) => x.name === 'plans').status, 'ok');
});
