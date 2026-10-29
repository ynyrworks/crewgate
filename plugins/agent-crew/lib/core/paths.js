'use strict';

const os = require('os');
const path = require('path');
const { CrewError } = require('./errors');

const ID_RE = /^p[0-9a-f]{10}$/;
const TASK_ID_RE = /^t-\d{8}-[0-9a-z]{4}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STORE_NAMES = ['work', 'needs', 'log', 'mrs', 'validation'];
const HANDOFF_STATES = ['open', 'accepted', 'cancelled'];

// Runtime data root: AGENT_CREW_HOME, else ~/.agent-crew
function home() {
  const env = process.env.AGENT_CREW_HOME;
  return env ? path.resolve(env) : path.join(os.homedir(), '.agent-crew');
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

module.exports = {
  ID_RE, TASK_ID_RE, SAFE_ID_RE, STORE_NAMES, HANDOFF_STATES,
  home, configFile, projectsFile, projectDir, dataFile, eventsFile, tasksDir, taskDir,
  handoffDir, handoffFile, projectConfigFile, runtimeDir, sessionsDir,
};
