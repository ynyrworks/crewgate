'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrewError } = require('./errors');

const ID_RE = /^p[0-9a-f]{10}$/;
const TASK_ID_RE = /^t-\d{8}-[0-9a-z]{4}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STORE_NAMES = ['work', 'needs', 'log', 'mrs', 'validation'];
const HANDOFF_STATES = ['open', 'accepted', 'cancelled'];

// Runtime data root: CREWGATE_HOME (or the pre-rename AGENT_CREW_HOME), else ~/.crewgate.
// Backward compatibility: when ~/.crewgate does not exist but ~/.agent-crew does, the old folder is used.
function envHome() { return process.env.CREWGATE_HOME || process.env.AGENT_CREW_HOME || ''; }
function newDefaultHome() { return path.join(os.homedir(), '.crewgate'); }
function oldDefaultHome() { return path.join(os.homedir(), '.agent-crew'); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// -> the old folder when it is the one in use (no env override, new folder missing), else ''.
function legacyHome() {
  if (envHome()) return '';
  return !isDir(newDefaultHome()) && isDir(oldDefaultHome()) ? oldDefaultHome() : '';
}

function home() {
  const env = envHome();
  if (env) return path.resolve(env);
  return legacyHome() || newDefaultHome();
}

function configFile() { return path.join(home(), 'config.json'); }
function projectsFile() { return path.join(home(), 'projects.json'); }

function projectDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new CrewError('paths.badProjectId', { id: String(id) });
  return path.join(home(), 'projects', id);
}

function dataFile(id, name) {
  if (!STORE_NAMES.includes(name)) throw new CrewError('paths.badDataName', { name: String(name) });
  return path.join(projectDir(id), `${name}.json`);
}

function eventsFile(id) { return path.join(projectDir(id), 'events.jsonl'); }
function tasksDir(id) { return path.join(projectDir(id), 'tasks'); }

function taskDir(id, taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) throw new CrewError('paths.badTaskId', { id: String(taskId) });
  return path.join(tasksDir(id), taskId);
}

// Hook runtime state: per-project (dispatch map) and global (per-session counters).
function runtimeDir(id) { return path.join(projectDir(id), 'runtime'); }
function sessionsDir() { return path.join(home(), 'sessions'); }

function handoffDir(id, state) {
  if (!HANDOFF_STATES.includes(state)) throw new CrewError('paths.badHandoffState', { state: String(state) });
  return path.join(projectDir(id), 'handoffs', state);
}

function handoffFile(id, state, handoffId) {
  if (typeof handoffId !== 'string' || !SAFE_ID_RE.test(handoffId)) throw new CrewError('paths.badHandoffId', { id: String(handoffId) });
  return path.join(handoffDir(id, state), `${handoffId}.json`);
}

// Project-side (inside the repo) files.
function projectConfigFile(root) { return path.join(root, '.claude', 'crew.json'); }

// Is a path.relative() result outside its base directory? A file named "..x" inside it is not.
function isOutside(rel) { return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel); }

// Canonical absolute form of a path: symlinks, junctions and Windows 8.3 short names (RUNNER~1) are
// resolved with realpath.native. A path that does not exist yet (a file about to be written) keeps its
// non-existing tail appended to the canonical form of its nearest existing ancestor. Case is preserved;
// comparisons that must ignore case on win32 go through project.normalizePath.
function canonical(p) {
  const abs = path.resolve(String(p));
  let head = abs;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail.reverse()); } catch { /* not there (yet) */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    tail.push(path.basename(head));
    head = up;
  }
}

module.exports = {
  isOutside, canonical,
  ID_RE, TASK_ID_RE, SAFE_ID_RE, STORE_NAMES, HANDOFF_STATES,
  home, legacyHome, configFile, projectsFile, projectDir, dataFile, eventsFile, tasksDir, taskDir,
  handoffDir, handoffFile, projectConfigFile, runtimeDir, sessionsDir,
};
