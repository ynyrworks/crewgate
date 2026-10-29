'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const HOME = h.setupHome();
const project = require('../lib/core/project');
const paths = require('../lib/core/paths');
const context = require('../lib/core/context');

const gitOk = h.hasGit();

function reset() {
  fs.rmSync(path.join(HOME, 'projects'), { recursive: true, force: true });
  fs.rmSync(paths.projectsFile(), { force: true });
}

test('normalizePath: Windows drive letter case, backslashes and trailing separators', () => {
  const a = project.normalizePath('C:\\Work\\Repo', 'win32');
  assert.equal(a, 'c:/work/repo');
  assert.equal(project.normalizePath('c:/work/repo/', 'win32'), a);
  assert.equal(project.normalizePath('C:\\WORK\\repo\\', 'win32'), a);
  assert.equal(project.normalizePath('C:\\', 'win32'), 'c:/');
  assert.equal(project.projectId('C:\\Work\\Repo', 'win32'), project.projectId('c:/work/repo', 'win32'));
  assert.notEqual(project.projectId('C:\\Work\\Repo', 'win32'), project.projectId('C:\\Work\\Repo2', 'win32'));
});

test('normalizePath on posix keeps case', () => {
  assert.equal(project.normalizePath('/a/B/', 'linux'), '/a/B');
  assert.notEqual(project.projectId('/a/B', 'linux'), project.projectId('/a/b', 'linux'));
  assert.equal(project.normalizePath('/', 'linux'), '/');
});

test('project id: "p" + 10 hex, deterministic, no folder name inside', () => {
  const dir = h.tmpDir('My Proj_1-');
  const id = project.projectId(dir);
  assert.match(id, /^p[0-9a-f]{10}$/);
  assert.equal(project.projectId(dir), id);
  assert.ok(!id.toLowerCase().includes('proj'));
  if (process.platform === 'win32') assert.equal(project.projectId(dir.toUpperCase()), id);
});

test('root detection without git falls back to the nearest .claude/crew.json', () => {
  const root = h.tmpDir('crew-nogit-');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'crew.json'), '{}');
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const info = project.inspect(deep);
  // a temp dir may itself sit inside a git repo on exotic setups; only assert when it does not
  if (!info.git) {
    assert.equal(info.root, root);
    assert.equal(info.linked, false);
  }
  assert.equal(project.nearestCrewJsonRoot(deep), root);
});

test('registry: add / list / find by id, path, name / remove keeps the data folder', () => {
  reset();
  const a = h.tmpDir('crew-a-');
  const r1 = project.add(a, { name: 'alpha' });
  assert.equal(r1.created, true);
  assert.equal(r1.project.name, 'alpha');
  assert.match(r1.project.id, /^p[0-9a-f]{10}$/);
  assert.ok(fs.existsSync(paths.projectDir(r1.project.id)));
  const r2 = project.add(a);
  assert.equal(r2.created, false);
  assert.equal(r2.project.name, 'alpha');
  assert.equal(r2.project.added, r1.project.added);
  assert.equal(project.list().length, 1);
  assert.equal(project.find(r1.project.id).path, r1.project.path);
  assert.equal(project.find('alpha').id, r1.project.id);
  assert.equal(project.find(a).id, r1.project.id);
  assert.equal(project.find('nope'), null);
  assert.equal(project.find(''), null);
  assert.throws(() => project.resolve('nope'), (e) => e.key === 'project.notFound');
  assert.throws(() => project.add(path.join(a, 'missing')), (e) => e.key === 'project.noFolder');
  fs.writeFileSync(path.join(a, 'f.txt'), 'x');
  assert.throws(() => project.add(path.join(a, 'f.txt')), (e) => e.key === 'project.notFolder');
  const { dir } = project.remove('alpha');
  assert.equal(project.list().length, 0);
  assert.ok(fs.existsSync(dir));
  assert.throws(() => project.remove('alpha'), (e) => e.key === 'project.notFound');
});

test('same folder name in different places: different ids, ambiguous name lookup', () => {
  reset();
  const base = h.tmpDir('crew-same-');
  const x = path.join(base, 'x', 'same');
  const y = path.join(base, 'y', 'same');
  fs.mkdirSync(x, { recursive: true });
  fs.mkdirSync(y, { recursive: true });
  const a = project.add(x).project;
  const b = project.add(y).project;
  assert.notEqual(a.id, b.id);
  assert.throws(() => project.find('same'), (e) => e.key === 'project.ambiguous');
  assert.equal(project.find(a.id).id, a.id);
});

test('findByCwd picks the deepest registered ancestor (non-git folders)', () => {
  reset();
  const base = h.tmpDir('crew-anc-');
  const outer = path.join(base, 'outer');
  const inner = path.join(outer, 'inner');
  const deep = path.join(inner, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  const o = project.add(outer).project;
  const i = project.add(inner).project;
  if (project.inspect(base).git) return; // exotic: temp dir inside a repo
  assert.equal(project.findByCwd(deep).id, i.id);
  assert.equal(project.findByCwd(outer).id, o.id);
  assert.equal(project.findByCwd(base), null);
});

test('a corrupt registry is moved aside and treated as empty', () => {
  reset();
  fs.writeFileSync(paths.projectsFile(), '{oops');
  assert.deepEqual(project.list(), []);
  assert.ok(fs.readdirSync(HOME).some((n) => n.startsWith('projects.json.corrupt-')));
});

test('git: main worktree is the root from any sub folder', { skip: !gitOk && 'git not available' }, () => {
  reset();
  const repo = h.makeRepo();
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const info = project.inspect(sub);
  assert.equal(info.root, repo);
  assert.equal(info.linked, false);
  assert.equal(project.detectRoot(sub), repo);
  assert.equal(project.isLinkedWorktree(sub), false);
  const added = project.add(sub).project; // registering a sub folder registers the repo root
  assert.equal(added.path, repo);
  assert.equal(project.findByCwd(sub).id, added.id);
});

test('git: a linked worktree maps to the same project as the main checkout', { skip: !gitOk && 'git not available' }, () => {
  reset();
  const repo = h.makeRepo();
  const wtParent = h.tmpDir('crew-wt-');
  const wt = path.join(wtParent, 'feature');
  h.git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const real = fs.realpathSync.native(wt);
  const info = project.inspect(real);
  assert.equal(info.linked, true);
  assert.equal(info.root, repo);
  assert.equal(project.projectId(info.root), project.projectId(repo));
  assert.equal(project.isLinkedWorktree(real), true);
  assert.equal(project.isLinkedWorktree(repo), false);

  const reg = project.add(repo).project;
  const c1 = context.resolve({ cwd: real, hook_event_name: 'PreToolUse' });
  assert.equal(c1.projectId, reg.id);
  assert.equal(c1.registered, true);
  assert.equal(c1.isMainWorktree, false);
  assert.equal(c1.isSubagent, false);
  assert.equal(c1.projectRoot, repo);
  const c2 = context.resolve({ cwd: repo, agent_id: 'a1', agent_type: 'crew-worker' });
  assert.equal(c2.isMainWorktree, true);
  assert.equal(c2.isSubagent, true);
  assert.equal(project.findByCwd(real).id, reg.id);
});

test('context: unregistered project, no payload, missing folder', () => {
  reset();
  const dir = h.tmpDir('crew-ctx-');
  const c = context.resolve(undefined, dir);
  assert.equal(c.registered, false);
  assert.equal(c.isSubagent, false);
  assert.equal(c.cwd, dir);
  const c2 = context.resolve({ cwd: path.join(dir, 'does', 'not', 'exist') });
  assert.equal(c2.registered, false);
  assert.equal(c2.isMainWorktree, true);
  assert.doesNotThrow(() => context.resolve('garbage'));
  assert.equal(context.resolve({ agent_id: '' }, dir).isSubagent, false);
});
