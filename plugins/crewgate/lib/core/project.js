'use strict';

// Project identity (DESIGN section 4) and the project registry (~/.crewgate/projects.json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const json = require('./json');
const { CrewError } = require('./errors');

// ---------------------------------------------------------------- identity
// Comparison form of a path. On Windows: one separator, lower case (drive letter included).
// `platform` exists for tests; realpath is only applied for the running platform.
function normalizePath(p, platform = process.platform) {
  const pp = platform === 'win32' ? path.win32 : path.posix;
  let r = pp.resolve(String(p));
  if (platform === process.platform) {
    try { r = fs.realpathSync.native(r); } catch { /* path may not exist */ }
  }
  if (platform === 'win32') r = r.replace(/\\/g, '/').toLowerCase();
  if (r.length > 1 && r.endsWith('/') && !/^[a-z]:\/$/.test(r)) r = r.slice(0, -1);
  return r;
}

// "p" + first 10 hex of sha256(normalized root path): no folder name inside the id.
function projectId(root, platform = process.platform) {
  return `p${crypto.createHash('sha256').update(normalizePath(root, platform)).digest('hex').slice(0, 10)}`;
}

function physical(p) {
  const r = path.resolve(String(p));
  try { return fs.realpathSync.native(r); } catch { return r; }
}

// ---------------------------------------------------------------- git
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// One git call: { commonDir, gitDir } as absolute paths, or null outside a repository / without git.
function gitDirs(cwd) {
  let out = git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], cwd);
  if (out === null) out = git(['rev-parse', '--git-common-dir', '--git-dir'], cwd); // git < 2.31
  if (out === null) return null;
  const lines = out.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  return { commonDir: path.resolve(cwd, lines[0]), gitDir: path.resolve(cwd, lines[1]) };
}

function nearestCrewJsonRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(paths.projectConfigFile(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// -> { root, linked, git }. root = main worktree (dirname of the git common dir), else the
// nearest ancestor holding .claude/crew.json, else null. linked = cwd is in a linked worktree.
function inspect(cwd = process.cwd()) {
  const dirs = gitDirs(cwd);
  if (dirs) {
    const linked = normalizePath(dirs.gitDir) !== normalizePath(dirs.commonDir);
    let root = null;
    if (path.basename(dirs.commonDir) === '.git') {
      root = path.dirname(dirs.commonDir);
    } else if (!linked) {
      // submodule (git dir lives under .git/modules) or a non-standard layout
      const top = git(['rev-parse', '--show-toplevel'], cwd);
      if (top) root = path.resolve(top);
    }
    if (root) return { root: physical(root), linked, git: true };
  }
  const cr = nearestCrewJsonRoot(cwd);
  return { root: cr ? physical(cr) : null, linked: false, git: !!dirs };
}

function detectRoot(cwd = process.cwd()) { return inspect(cwd).root; }
function isLinkedWorktree(cwd = process.cwd()) { return inspect(cwd).linked; }

// ---------------------------------------------------------------- registry
const REGISTRY_DEFAULT = () => ({ version: 1, projects: {} });

function readRegistry() {
  const d = json.read(paths.projectsFile(), REGISTRY_DEFAULT()).data;
  if (!d.projects || typeof d.projects !== 'object' || Array.isArray(d.projects)) d.projects = {};
  return d;
}

// All registered projects: [{ id, path, name, added }] sorted by added.
function list() {
  const d = readRegistry();
  return Object.entries(d.projects)
    .filter(([id, p]) => paths.ID_RE.test(id) && p && typeof p.path === 'string')
    .map(([id, p]) => ({ id, path: p.path, name: p.name || path.basename(p.path), added: p.added || '' }))
    .sort((a, b) => (a.added < b.added ? -1 : a.added > b.added ? 1 : a.id < b.id ? -1 : 1));
}

function isPathSpec(spec) {
  return /[\\/]/.test(spec) || spec.startsWith('.') || spec.startsWith('~') || /^[A-Za-z]:/.test(spec);
}

// Deepest registered project whose path is `dir` or one of its ancestors.
function deepestAncestor(dir, all) {
  const here = normalizePath(dir);
  let best = null;
  let bestLen = -1;
  for (const p of all) {
    const base = normalizePath(p.path);
    const ok = here === base || here.startsWith(base.endsWith('/') ? base : `${base}/`);
    if (ok && base.length > bestLen) { best = p; bestLen = base.length; }
  }
  return best;
}

// Registered project for a cwd (linked worktrees map to their main checkout), or null.
function findByCwd(cwd = process.cwd()) {
  const all = list();
  if (!all.length) return null;
  const root = detectRoot(cwd);
  if (root) {
    const id = projectId(root);
    const hit = all.find((p) => p.id === id);
    if (hit) return hit;
  }
  return deepestAncestor(cwd, all);
}

// Finds a registered project by id, path (any folder inside it) or name. null when missing;
// throws CrewError project.ambiguous when a name matches several projects.
function find(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null;
  const all = list();
  if (isPathSpec(spec)) {
    let p = spec;
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
    return findByCwd(p);
  }
  const byId = all.find((x) => x.id === spec);
  const byName = all.filter((x) => x.name === spec);
  const ids = new Set(byName.map((x) => x.id));
  if (byId) ids.add(byId.id);
  if (ids.size > 1) throw new CrewError('project.ambiguous', { spec, ids: [...ids].join(', ') });
  return ids.size === 1 ? (byId || byName[0]) : null;
}

// Same as find() but throws CrewError project.notFound.
function resolve(spec) {
  const p = find(spec);
  if (!p) throw new CrewError('project.notFound', { spec });
  return p;
}

// Registers the project that contains `dir` (root detection applies, so a linked worktree or a
// sub-folder registers its main checkout). -> { project, created }
function add(dir, opts = {}) {
  const resolved = path.resolve(String(dir));
  let st;
  try { st = fs.statSync(resolved); } catch { throw new CrewError('project.noFolder', { path: resolved }); }
  if (!st.isDirectory()) throw new CrewError('project.notFolder', { path: resolved });
  const root = detectRoot(resolved) || physical(resolved);
  const id = projectId(root);
  return json.update(paths.projectsFile(), REGISTRY_DEFAULT(), (d) => {
    if (!d.projects || typeof d.projects !== 'object' || Array.isArray(d.projects)) d.projects = {};
    const created = !d.projects[id];
    const prev = d.projects[id] || {};
    d.projects[id] = {
      path: root,
      name: opts.name ? String(opts.name) : (prev.name || path.basename(root) || 'project'),
      added: prev.added || new Date().toISOString(),
    };
    fs.mkdirSync(paths.projectDir(id), { recursive: true });
    return { project: { id, ...d.projects[id] }, created };
  });
}

// Unregisters; the data folder stays. -> { project, dir }
function remove(spec) {
  const p = resolve(spec);
  json.update(paths.projectsFile(), REGISTRY_DEFAULT(), (d) => {
    if (d.projects) delete d.projects[p.id];
  });
  return { project: p, dir: paths.projectDir(p.id) };
}

module.exports = {
  normalizePath, projectId, inspect, detectRoot, isLinkedWorktree, nearestCrewJsonRoot,
  list, find, findByCwd, resolve, add, remove,
};
