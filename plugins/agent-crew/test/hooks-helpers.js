'use strict';

// Helpers for the hook tests: run crew-hook.js as a child process against a temp repo/home.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupHome, makeRepo, GOOD_BRIEF } = require('./helpers');
const project = require('../lib/core/project');
const events = require('../lib/core/events');
const tasks = require('../lib/core/tasks');

const HOOK = path.join(__dirname, '..', 'scripts', 'crew-hook.js');

// runHook('stop', payload, { cwd, env, raw }) -> { code, out, json, ms, err }
function runHook(event, payload, opts = {}) {
  const input = opts.raw !== undefined ? opts.raw : JSON.stringify(payload);
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK, event], {
    input, cwd: opts.cwd || process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AGENT_CREW_HOOK_GUARD_MS: '30000', ...(opts.env || {}) },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = (r.stdout || '').trim();
  let json = null;
  try { json = JSON.parse(out); } catch { /* leave null */ }
  return { code: r.status, out, json, ms, err: (r.stderr || '').trim() };
}

// A registered project in a temp home. -> { home, repo, pid, sid }
function fixture(opts = {}) {
  const home = setupHome();
  const repo = makeRepo();
  if (opts.config) writeConfig(repo, opts.config);
  const pid = project.add(repo, { name: 'demo' }).project.id;
  return { home, repo, pid, sid: opts.sid || 'sess-1' };
}

function writeConfig(repo, cfg) {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'crew.json'), JSON.stringify(cfg));
}

const base = (f, extra) => ({ session_id: f.sid, cwd: f.repo, ...extra });

// Starts the session (creates the session file that the fast paths rely on).
function start(f) { return runHook('session-start', base(f, { source: 'startup' }), { cwd: f.repo }); }

function evs(f, types) { return events.read(f.pid, { types }); }

function newTask(f, title = 'Add the thing') { return tasks.createTask(f.pid, { title, brief: GOOD_BRIEF }); }

const agentPayload = (f, task, extra) => base(f, {
  tool_name: 'Agent', tool_use_id: `tu-${task.id}`,
  tool_input: { prompt: `crew-task: ${task.id}\n\ndo it`, subagent_type: 'crew-worker', description: 'x' }, ...extra,
});

module.exports = { HOOK, runHook, fixture, writeConfig, base, start, evs, newTask, agentPayload };
