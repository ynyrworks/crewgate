'use strict';

// Per-session running counters (<home>/sessions/<session>.json) and the dispatch map
// (<project runtime>/dispatch.json). Both are small; hooks update them so that SessionEnd,
// which gets ~1.5 s, only has to read one file.
const fs = require('fs');
const path = require('path');
const json = require('../core/json');
const paths = require('../core/paths');

const noWarn = () => {};
const MAX_USES = 100;
const SESSION_KEEP_MS = 3 * 24 * 3600 * 1000;

const sessionsDir = () => path.join(paths.home(), 'sessions');
const sessionFile = (sid) => path.join(sessionsDir(), `${sid}.json`);

function read(sid) {
  try {
    const r = json.readJson(sessionFile(sid), {});
    return r.status === 'ok' && r.data && r.data.project ? r.data : null;
  } catch { return null; }
}

function init(s, h) {
  s.v = 1;
  s.project = h.pid;
  s.root = h.root;
  s.started = new Date().toISOString();
  s.prompts = 0;
  s.tools = {};
  s.tool_total = 0;
  s.tasks = [];
  s.turn_open = false;
  s.ends_question = false;
  return s;
}

// touch(h, fn): locked update of this session's file; creates it when missing. Never throws.
function touch(h, fn) {
  if (!h || !h.sid) return null;
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    return json.update(sessionFile(h.sid), {}, (s) => {
      if (!s.project) init(s, h);
      fn(s);
      return s;
    }, noWarn);
  } catch { return null; }
}

function bumpTool(h, name) {
  const key = String(name || 'unknown').slice(0, 64);
  return touch(h, (s) => {
    if (!s.tools || typeof s.tools !== 'object') s.tools = {};
    if (s.tools[key] !== undefined || Object.keys(s.tools).length < 40) s.tools[key] = (s.tools[key] || 0) + 1;
    s.tool_total = (s.tool_total || 0) + 1;
    s.last_tool = key;
  });
}

function addTask(s, id) {
  if (!Array.isArray(s.tasks)) s.tasks = [];
  if (id && !s.tasks.includes(id) && s.tasks.length < 50) s.tasks.push(id);
}

function remove(sid) { try { fs.unlinkSync(sessionFile(sid)); } catch { /* already gone */ } }

// Deletes session files untouched for days (crashed sessions never reach SessionEnd).
function prune() {
  try {
    const dir = sessionsDir();
    const now = Date.now();
    for (const n of fs.readdirSync(dir).slice(0, 300)) {
      if (!n.endsWith('.json')) continue;
      try {
        const f = path.join(dir, n);
        if (now - fs.statSync(f).mtimeMs > SESSION_KEEP_MS) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
  } catch { /* no sessions yet */ }
}

// ---------------------------------------------------------------- dispatch map
// uses[tool_use_id] = { task, type, bg, worker, ts, agent, stopped }
const dispatchFile = (pid) => path.join(paths.projectDir(pid), 'runtime', 'dispatch.json');

function updateUses(pid, fn) {
  try {
    const file = dispatchFile(pid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return json.update(file, { uses: {} }, (d) => {
      if (!d.uses || typeof d.uses !== 'object') d.uses = {};
      const out = fn(d.uses);
      const keys = Object.keys(d.uses);
      if (keys.length > MAX_USES) {
        keys.sort((a, b) => (d.uses[a].ts || 0) - (d.uses[b].ts || 0));
        for (const k of keys.slice(0, keys.length - MAX_USES)) delete d.uses[k];
      }
      return out;
    }, noWarn);
  } catch { return null; }
}

function readUses(pid) {
  try { return json.readJson(dispatchFile(pid), { uses: {} }).data.uses || {}; } catch { return {}; }
}

function remember(pid, toolUseId, rec) { return updateUses(pid, (u) => { u[toolUseId] = rec; }); }

// Binds a started subagent to the oldest unbound dispatch of the same type (FIFO).
function bindAgent(pid, agentId, type) {
  return updateUses(pid, (u) => {
    const now = Date.now();
    const cands = Object.entries(u)
      .filter(([, r]) => !r.agent && r.type === type && now - (r.ts || 0) < 15 * 60 * 1000)
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    if (!cands.length) return null;
    cands[0][1].agent = agentId;
    return { ...cands[0][1], id: cands[0][0] };
  });
}

function byAgent(pid, agentId) {
  const u = readUses(pid);
  for (const [id, r] of Object.entries(u)) if (r.agent === agentId) return { ...r, id };
  return null;
}

function byToolUse(pid, toolUseId) {
  const r = readUses(pid)[toolUseId];
  return r ? { ...r, id: toolUseId } : null;
}

function markStopped(pid, toolUseId) { return updateUses(pid, (u) => { if (u[toolUseId]) u[toolUseId].stopped = true; }); }

module.exports = {
  read, touch, bumpTool, addTask, remove, prune,
  remember, bindAgent, byAgent, byToolUse, readUses, markStopped, sessionFile,
};
