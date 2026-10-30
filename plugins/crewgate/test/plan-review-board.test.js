'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const config = require('../lib/core/config');
const pr = require('../lib/core/plan-review');
const PM = require('../board/public/plan-model.js');

const PUB = path.join(__dirname, '..', 'board', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let board;
let port;
let repo;
let proj;
const get = (p) => h.request(port, { path: p });

test.before(async () => {
  repo = h.makeRepo();
  proj = projects.add(repo, { name: 'demo' }).project;
  fs.mkdirSync(path.join(repo, '.crew', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.crew', 'plans', 'demo.md'), '# Demo\nGoal text.\n\n- [ ] One <!-- id:n1 -->\n  - [ ] Two <!-- id:n2 -->\n');
  const cfg = config.load(repo).config;
  pr.start(repo, proj.id, cfg, 'demo');
  pr.submit(proj.id, 'demo', { kind: 'findings', round: 1, list: [
    { node: 'n2', kind: 'risk', claim: 'SECRET-CLAIM', evidence: ['n2'], proposal: { action: 'add', text: 'Check the clock', done_when: 'A test fakes the clock' } },
  ] });
  pr.filter(repo, proj.id, cfg, 'demo', 1);
  pr.submit(proj.id, 'demo', { kind: 'refutations', round: 1, list: [{ id: 'f1', verdict: 'uncertain', evidence: 'SECRET-REASON' }] });
  pr.finalize(repo, proj.id, cfg, 'demo', { round: 1 });
  board = createBoard({ claudeRoot: h.tmpDir('crew-claude-'), codexRoot: h.tmpDir('crew-codex-'), watcher: { ttlMs: 0 } });
  port = await board.listen(0);
});
test.after(() => board.close());

test('plan API: proposals with target, kind, action, done_when and commands; rounds; claim text follows show_text', async () => {
  const r = await get(`/api/project/${proj.id}/plan/demo`);
  assert.equal(r.status, 200);
  assert.equal(r.json.proposals.length, 1);
  const p = r.json.proposals[0];
  assert.equal(p.kind, 'risk');
  assert.equal(p.action, 'add');
  assert.equal(p.done_when, 'A test fakes the clock');
  assert.equal(p.target.id, 'n2');
  assert.equal(p.target.text, 'Two');
  assert.equal(p.uncertain, true);
  assert.equal(p.accept_cmd, `crew plan accept demo ${p.id}`);
  assert.match(p.reject_cmd, /crew plan reject demo .* --note/);
  assert.equal(p.claim, null, 'show_text is off by default');
  assert.deepEqual(p.evidence, []);
  assert.equal(p.refutation, null);
  assert.equal(r.json.show_text, false);
  assert.ok(!JSON.stringify(r.json).includes('SECRET-'));
  assert.equal(r.json.rounds.length, 1);
  assert.equal(r.json.rounds[0].raised, 1);
  assert.equal(r.json.rounds[0].kept, 1);
  const tree = r.json.nodes[0].children[0].children[0];
  assert.equal(tree.state, 'proposed');
  assert.equal(tree.proposal.kind, 'risk');
  assert.equal(tree.proposal.uncertain, true);
  // project page and plans list carry the pending count
  const list = await get(`/api/project/${proj.id}/plans`);
  assert.equal(list.json.plans[0].pending, 1);
  assert.equal((await get(`/api/project/${proj.id}`)).json.plans[0].pending, 1);
});

test('plan API: with board.show_text the claim, evidence and refuter reasoning are included', async () => {
  const { planOf } = require('../board/api');
  const r = planOf(repo, proj.id, 'demo', { showText: true });
  assert.equal(r.proposals[0].claim, 'SECRET-CLAIM');
  assert.deepEqual(r.proposals[0].evidence, ['n2']);
  assert.equal(r.proposals[0].refutation, 'SECRET-REASON');
  assert.equal(r.show_text, true);
});

test('plan model: private mode shows ids, not texts', () => {
  const p = { id: 'n7', text: 'Secret step', target: { id: 'n2', text: 'Secret target' } };
  assert.equal(PM.proposalText(p, true), 'n7');
  assert.equal(PM.proposalText(p, false), 'Secret step');
  assert.equal(PM.targetText(p, true), 'n2');
  assert.equal(PM.targetText(p, false), 'Secret target');
  assert.deepEqual(PM.pending({}), []);
  assert.deepEqual(PM.rounds({ rounds: [{ round: 1 }, { round: 2 }] }).map((x) => x.round), [2, 1]);
  assert.equal(PM.pendingTotal([{ pending: 2 }, {}, { pending: 1 }]), 3);
});

test('UI: the proposal card hides texts, claim and done_when in private mode and offers copyable commands', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function proposalItem'), js.indexOf('function proposalsCard'));
  assert.match(fn, /PM\.proposalText\(p, S\.mask\)/);
  assert.match(fn, /p\.done_when && !S\.mask/);
  assert.match(fn, /!S\.mask && p\.claim/);
  assert.match(fn, /commandBlock\(\[p\.accept_cmd, p\.reject_cmd\]\)/);
  assert.doesNotMatch(js, /method: ?'POST'[^]{0,200}plan/, 'the board stays read-only');
});
