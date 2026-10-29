'use strict';

// Path canonicalisation: 8.3 short names (C:\Users\RUNNER~1), symlinks and not-yet-existing tails must
// not make a project root and a hook file_path look like two different places.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');
const H = require('./hooks-helpers');
const paths = require('../lib/core/paths');
const project = require('../lib/core/project');

h.setupHome();

// 8.3 short form of an existing path on Windows, or null (not Windows, or 8.3 names disabled).
function shortForm(p) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('cmd', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true });
  const s = String(r.stdout || '').trim();
  return s && s.toLowerCase() !== p.toLowerCase() && /~\d/.test(s) ? s : null;
}

// A temp dir whose long folder name has an 8.3 alias, as { long, short }; short is null when unavailable.
function longAndShort() {
  const base = h.tmpDir('crew-canonical-');
  const long = path.join(base, 'A Long Folder Name');
  fs.mkdirSync(long, { recursive: true });
  return { long, short: shortForm(long) };
}

test('canonical: existing path, not-yet-existing tail, trailing dots and relative input', () => {
  const d = h.tmpDir('crew-canon-');
  assert.equal(paths.canonical(d), d);
  assert.equal(paths.canonical(path.join(d, 'new', 'deep', 'f.txt')), path.join(d, 'new', 'deep', 'f.txt'));
  assert.equal(paths.canonical(path.join(d, 'x', '..', 'y')), path.join(d, 'y'));
  assert.ok(path.isAbsolute(paths.canonical('relative/thing')));
});

test('canonical: a symlinked folder maps to its target (including a missing tail)', (t) => {
  const d = h.tmpDir('crew-canon-');
  fs.mkdirSync(path.join(d, 'real'));
  try { fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction'); } catch { t.skip('cannot create links here'); return; }
  assert.equal(paths.canonical(path.join(d, 'link')), path.join(d, 'real'));
  assert.equal(paths.canonical(path.join(d, 'link', 'n', 'f.js')), path.join(d, 'real', 'n', 'f.js'));
});

test('canonical: 8.3 short names resolve to the long form, also for missing tails', (t) => {
  const { long, short } = longAndShort();
  if (!short) { t.skip('8.3 short names unavailable'); return; }
  assert.notEqual(short, long);
  assert.equal(paths.canonical(short), long);
  assert.equal(paths.canonical(path.join(short, 'not', 'yet.js')), path.join(long, 'not', 'yet.js'));
  assert.equal(project.normalizePath(short), project.normalizePath(long));
  assert.equal(project.projectId(short), project.projectId(long));
});

test('root detection and registry lookup agree between short and long forms', (t) => {
  const { long, short } = longAndShort();
  if (!short) { t.skip('8.3 short names unavailable'); return; }
  fs.mkdirSync(path.join(long, '.claude'));
  fs.writeFileSync(path.join(long, '.claude', 'crew.json'), '{}');
  fs.mkdirSync(path.join(long, 'sub'));
  const canon = paths.canonical(long);
  assert.equal(project.detectRoot(path.join(short, 'sub')), canon);
  assert.equal(project.detectRoot(path.join(long, 'sub')), canon);
  // registered through the short form, found through the long one and vice versa
  const added = project.add(short, { name: 'short' }).project;
  assert.equal(added.path, canon);
  assert.equal(project.findByCwd(path.join(long, 'sub')).id, added.id);
  assert.equal(project.findByCwd(path.join(short, 'sub')).id, added.id);
});

test('edit guard fires whichever form the cwd and file_path use (short vs long, git repo)', (t) => {
  if (!h.hasGit()) { t.skip('git missing'); return; }
  const f = H.fixture({ config: { limits: { orchestrator_edit: 'block' } } });
  const short = shortForm(f.repo);
  if (!short) { t.skip('8.3 short names unavailable'); return; }
  const forms = [[f.repo, short], [short, f.repo], [short, short]];
  for (const [cwd, root] of forms) {
    const target = path.join(root, 'src', 'brand-new.js');   // does not exist: Write of a new file
    const r = H.runHook('pre-tool-use', H.base(f, { cwd, tool_name: 'Write', tool_use_id: `w-${Math.random()}`, tool_input: { file_path: target } }), { cwd });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', `${cwd} / ${target}`);
  }
  // still outside the project when it really is outside
  const r = H.runHook('pre-tool-use', H.base(f, { tool_name: 'Write', tool_input: { file_path: path.join(h.tmpDir('crew-out-'), 'x.js') } }), { cwd: short });
  assert.equal(r.out, '{}');
});

test('edit guard fires when cwd and file_path go through a junction/symlink to the project (short-name stand-in)', (t) => {
  if (!h.hasGit()) { t.skip('git missing'); return; }
  const f = H.fixture({ config: { limits: { orchestrator_edit: 'block' } } });
  const link = path.join(h.tmpDir('crew-link-'), 'alias');
  try { fs.symlinkSync(f.repo, link, 'junction'); } catch { t.skip('cannot create links here'); return; }
  for (const [cwd, root] of [[link, f.repo], [f.repo, link], [link, link]]) {
    const target = path.join(root, 'src', 'brand-new.js');
    const r = H.runHook('pre-tool-use', H.base(f, { cwd, tool_name: 'Write', tool_use_id: `w-${Math.random()}`, tool_input: { file_path: target } }), { cwd });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', `${cwd} / ${target}`);
  }
  assert.equal(project.detectRoot(link), paths.canonical(f.repo));
  assert.equal(project.findByCwd(path.join(link, 'src')).id, f.pid);
});
