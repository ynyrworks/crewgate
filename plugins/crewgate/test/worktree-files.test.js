'use strict';

// Repo files (config, agents, .crew/*, rules block) belong to the work tree the user is in; identity and
// runtime data stay with the main checkout (DESIGN section 4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const u = require('./workflow-util');
const H = require('./hooks-helpers');

h.setupHome();
const project = require('../lib/core/project');
const context = require('../lib/core/context');
const paths = require('../lib/core/paths');

const canon = (p) => paths.canonical(p);
const exists = (...p) => fs.existsSync(path.join(...p));
const sibling = () => `${h.tmpDir('crew-wt-')}${path.sep}wt`;
const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';

// main checkout + a linked worktree next to it (or inside it with `nested`)
function pair(nested = false) {
  const main = h.makeRepo();
  const wt = nested ? path.join(main, '.claude', 'worktrees', 'feat') : sibling();
  h.git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  return { main, wt };
}

// an initialised, committed main checkout and a linked worktree that carries the same tracked files
function initialised(branch) {
  const main = u.initRepo();
  h.git(main, 'add', '-A');
  h.git(main, 'commit', '-q', '-m', 'crew files');
  const wt = sibling();
  h.git(main, 'worktree', 'add', '-q', wt, '-b', branch);
  return { main, wt };
}

test('project.inspect: work tree root equals the project root in a normal repo, also from a sub-folder', () => {
  const repo = h.makeRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  for (const d of [repo, path.join(repo, 'sub')]) {
    const i = project.inspect(d);
    assert.equal(i.root, canon(repo));
    assert.equal(i.workTree, canon(repo));
    assert.equal(i.linked, false);
  }
  assert.equal(project.detectWorkTree(repo), canon(repo));
});

test('project.inspect: a linked worktree has its own work tree root but the main checkout as project root', () => {
  const { main, wt } = pair();
  fs.mkdirSync(path.join(wt, 'deep'));
  for (const d of [wt, path.join(wt, 'deep')]) {
    const i = project.inspect(d);
    assert.equal(i.root, canon(main));
    assert.equal(i.workTree, canon(wt));
    assert.equal(i.linked, true);
  }
  assert.equal(project.projectId(project.inspect(wt).root), project.projectId(project.inspect(main).root));
});

test('project.inspect: inside a .git directory and outside git still work', () => {
  const repo = h.makeRepo();
  const i = project.inspect(path.join(repo, '.git'));
  assert.equal(i.root, canon(repo));
  assert.equal(i.workTree, canon(repo));
  const plain = h.tmpDir('crew-plain-');
  assert.deepEqual([project.inspect(plain).root, project.inspect(plain).workTree], [null, null]);
});

test('project.workTreeWithin: finds a nested worktree without git, else the root', () => {
  const { main, wt } = pair(true);
  fs.mkdirSync(path.join(wt, 'deep'));
  assert.equal(project.workTreeWithin(path.join(wt, 'deep'), canon(main)), canon(wt));
  assert.equal(project.workTreeWithin(main, canon(main)), canon(main));
  fs.mkdirSync(path.join(main, 'src'));
  assert.equal(project.workTreeWithin(path.join(main, 'src'), canon(main)), canon(main));
});

test('context.resolve exposes projectRoot and workTreeRoot', () => {
  const { main, wt } = pair();
  const a = context.resolve({}, wt);
  assert.equal(a.projectRoot, canon(main));
  assert.equal(a.workTreeRoot, canon(wt));
  assert.equal(a.isMainWorktree, false);
  const b = context.resolve({}, main);
  assert.equal(b.projectRoot, b.workTreeRoot);
  const plain = context.resolve({}, h.tmpDir('crew-plain-'));
  assert.equal(plain.projectRoot, null);
  assert.equal(plain.workTreeRoot, null);
});

test('init inside a linked worktree writes only there; registration maps to the main checkout', () => {
  const { main, wt } = pair();
  const r = u.crewJson(['init'], wt);
  assert.equal(r.code, 0, r.err);
  for (const f of ['.claude/crew.json', '.claude/agents/crew-worker.md', '.crew/REVIEW.md', '.crew/LESSONS.md', '.crew/dismissed.jsonl']) {
    assert.ok(exists(wt, ...f.split('/')), `worktree has ${f}`);
    assert.ok(!exists(main, ...f.split('/')), `main checkout has no ${f}`);
  }
  assert.equal(r.data.project.path, canon(main));
  assert.equal(r.data.project.id, project.projectId(canon(main)));
  assert.equal(project.findByCwd(wt).id, project.findByCwd(main).id);
});

test('init in a normal repo still writes into the repo root, also when run from a sub-folder', () => {
  const repo = h.makeRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  const r = u.crewJson(['init'], path.join(repo, 'sub'));
  assert.equal(r.code, 0, r.err);
  assert.ok(exists(repo, '.claude', 'crew.json'));
  assert.ok(!exists(repo, 'sub', '.claude'));
});

test('init outside git still works and registers the folder', () => {
  const dir = h.tmpDir('crew-plain-');
  const r = u.crewJson(['init'], dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(exists(dir, '.claude', 'crew.json'));
});

test('lesson add / promote / retire edit the worktree files, not the main checkout', () => {
  const { main, wt } = initialised('feat/l');
  const mainLessons = fs.readFileSync(path.join(main, '.crew', 'LESSONS.md'), 'utf8');
  assert.equal(h.crew(['lesson', 'add', '--key', 'k-one', '--text', 'first'], wt).code, 0);
  assert.equal(h.crew(['lesson', 'add', '--key', 'k-one', '--text', 'again', '--date', '2020-01-02'], wt).code, 0);
  assert.match(fs.readFileSync(path.join(wt, '.crew', 'LESSONS.md'), 'utf8'), /k-one/);
  assert.equal(fs.readFileSync(path.join(main, '.crew', 'LESSONS.md'), 'utf8'), mainLessons);
  const p = h.crew(['lesson', 'promote', 'k-one', '--rule', 'Do the thing'], wt);
  assert.equal(p.code, 0, p.err);
  assert.match(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), /Do the thing/);
  assert.ok(!exists(main, 'CLAUDE.md'), 'main checkout untouched');
  assert.equal(u.crewJson(['lesson', 'list'], wt).data[0].promoted, true);
  assert.equal(h.crew(['lesson', 'retire', 'k-one'], wt).code, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), /Do the thing/);
  assert.equal(fs.readFileSync(path.join(main, '.crew', 'LESSONS.md'), 'utf8'), mainLessons);
});

test('lesson in a normal repo still edits the repo files', () => {
  const repo = u.initRepo();
  assert.equal(h.crew(['lesson', 'add', '--key', 'n', '--text', 't'], repo).code, 0);
  assert.equal(h.crew(['lesson', 'promote', 'n', '--rule', 'Rule N'], repo).code, 0);
  assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), /Rule N/);
});

test('CLI config: the worktree file wins when it exists; the main checkout keeps its own; fallback otherwise', () => {
  const { main, wt } = initialised('feat/c');
  u.patchCfg(wt, (c) => { c.lessons = { ...(c.lessons || {}), rules_file: 'RULES.md' }; });
  assert.equal(h.crew(['lesson', 'add', '--key', 'k', '--text', 't'], wt).code, 0);
  assert.equal(h.crew(['lesson', 'promote', 'k', '--rule', 'R'], wt).code, 0);
  assert.ok(exists(wt, 'RULES.md'), 'worktree config picked up');
  assert.ok(!exists(main, 'RULES.md'));
  // the main checkout still uses its own config
  assert.equal(h.crew(['lesson', 'add', '--key', 'm', '--text', 't'], main).code, 0);
  assert.equal(h.crew(['lesson', 'promote', 'm', '--rule', 'M'], main).code, 0);
  assert.ok(exists(main, 'CLAUDE.md') && !exists(main, 'RULES.md'));
  // a worktree without its own file falls back to the project root's
  const wt2 = sibling();
  h.git(main, 'worktree', 'add', '-q', wt2, '-b', 'feat/d');
  fs.rmSync(path.join(wt2, '.claude'), { recursive: true, force: true });
  u.patchCfg(main, (c) => { c.lessons = { ...(c.lessons || {}), rules_file: 'MAIN.md' }; });
  assert.equal(h.crew(['lesson', 'add', '--key', 'f', '--text', 't'], wt2).code, 0);
  assert.equal(h.crew(['lesson', 'promote', 'f', '--rule', 'F'], wt2).code, 0);
  assert.ok(exists(wt2, 'MAIN.md'), 'fell back to the main checkout config');
});

test('doctor reports both roots in a linked worktree and only one in a normal repo', () => {
  const { main, wt } = initialised('feat/doc');
  const a = u.crewJson(['doctor'], wt);
  const w = a.data.checks.find((c) => c.name === 'worktree');
  assert.ok(w, 'worktree line');
  assert.ok(w.detail.includes(canon(wt)) && w.detail.includes(canon(main)));
  assert.equal(a.data.checks.find((c) => c.name === 'config').detail, path.join(canon(wt), '.claude', 'crew.json'));
  assert.equal(u.crewJson(['doctor'], main).data.checks.some((c) => c.name === 'worktree'), false);
});

test('hooks: a config that exists only in the worktree is honoured there; the main checkout keeps its own', () => {
  const f = H.fixture({ config: { lessons: { rules_file: 'MAIN-RULES.md' } } });
  const wt = sibling();
  h.git(f.repo, 'worktree', 'add', '-q', wt, '-b', 'feat/h');
  H.writeConfig(wt, { lessons: { rules_file: 'WT-RULES.md' } });
  const inWt = H.runHook('session-start', { session_id: 's-wt', cwd: wt, source: 'startup' }, { cwd: wt });
  assert.ok(ctxOf(inWt).includes('WT-RULES.md'), inWt.out);
  const inMain = H.runHook('session-start', { session_id: 's-main', cwd: f.repo, source: 'startup' }, { cwd: f.repo });
  assert.ok(ctxOf(inMain).includes('MAIN-RULES.md'), inMain.out);
  // a worktree without its own file: the project root's config applies
  const wt2 = sibling();
  h.git(f.repo, 'worktree', 'add', '-q', wt2, '-b', 'feat/h2');
  const fb = H.runHook('session-start', { session_id: 's-wt2', cwd: wt2, source: 'startup' }, { cwd: wt2 });
  assert.ok(ctxOf(fb).includes('MAIN-RULES.md'), fb.out);
});

test('hooks fast path: a worktree nested in the main checkout uses its own config', () => {
  const f = H.fixture({ config: { limits: { orchestrator_read_warn_lines: 500 } } });
  const wt = path.join(f.repo, '.claude', 'worktrees', 'feat');
  h.git(f.repo, 'worktree', 'add', '-q', wt, '-b', 'feat/n');
  H.writeConfig(wt, { limits: { orchestrator_read_warn_lines: 50 } });
  H.start(f);
  const big = path.join(wt, 'big.txt');
  fs.writeFileSync(big, 'line\n'.repeat(80));
  const pl = (cwd) => ({ session_id: f.sid, cwd, tool_name: 'Read', tool_input: { file_path: big } });
  const r = H.runHook('pre-tool-use', pl(wt), { cwd: wt });
  assert.ok(r.out.includes('more than 50 lines'), r.out);
  assert.equal(H.runHook('pre-tool-use', pl(f.repo), { cwd: f.repo }).out, '{}');
});
