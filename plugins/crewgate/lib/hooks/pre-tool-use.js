'use strict';

// PreToolUse: Agent/Task dispatch tracking, orchestrator edit guard, big-file read reminder.
const fs = require('fs');
const path = require('path');
const events = require('../core/events');
const paths = require('../core/paths');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const glob = require('./glob');

const MAX_READ_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------- Agent / Task
function onAgent(payload) {
  if (payload.agent_id) return null; // dispatches come from the main session
  const h = C.open(payload);
  if (!h) return null;
  const ti = C.obj(payload.tool_input);
  const tuid = C.str(payload.tool_use_id);
  sess.bumpTool(h, C.str(payload.tool_name) || 'Agent');
  const id = tasks.findMarker(C.str(ti.prompt).slice(0, 1 << 20));
  if (!id) return null;
  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }

  const type = C.normType(ti.subagent_type);
  const bg = ti.run_in_background === true;
  const model = C.snippet(ti.model, 60) || null;
  const key = tuid || `${id}:${Date.now()}`;
  // Only a task that is waiting for (or already in) a worker run is a worker dispatch;
  // a task in review may be linked to a reviewer subagent and must not change state.
  const worker = task.state === 'created' || task.state === 'dispatched';

  try {
    if (task.state === 'created') {
      tasks.transition(h.pid, id, 'dispatched', {
        src: 'hook', session: h.sid,
        data: { agent_type: type, model, background: bg, tool_use_id: C.snippet(tuid, 80) || null },
      });
    } else if (task.state === 'dispatched' && !sess.byToolUse(h.pid, key)) {
      // Already dispatched through the CLI (send-back): record this launch.
      events.append(h.pid, {
        type: 'task.dispatched', src: 'hook', session: h.sid, task: id, tool_use_id: tuid,
        data: { agent_type: type, model, background: bg, tool_use_id: C.snippet(tuid, 80), redispatch: true }, key,
      });
    }
  } catch { /* an illegal transition must not stop the dispatch */ }

  sess.remember(h.pid, key, { task: id, type, bg, worker, ts: Date.now(), agent: null, stopped: false });
  sess.touch(h, (s) => sess.addTask(s, id));

  if (!worker) return null;
  let inflight = 0;
  try { inflight = tasks.list(h.pid, { state: 'dispatched' }).filter((t) => t.id !== id).length + 1; } catch { /* ignore */ }
  const max = h.cfg().limits.max_parallel_workers;
  if (max > 0 && inflight > max) return C.withContext('PreToolUse', h.t('warn.parallel', { id, count: inflight, max }));
  return null;
}

// ---------------------------------------------------------------- Edit / Write
function onEdit(payload) {
  if (payload.agent_id) return null;
  const h = C.open(payload, { full: true });
  if (!h) return null;
  sess.bumpTool(h, C.str(payload.tool_name));
  if (!h.ctx.isMainWorktree) return null;
  const limits = h.cfg().limits;
  if (limits.orchestrator_edit === 'off') return null;
  const ti = C.obj(payload.tool_input);
  const target = C.str(ti.file_path) || C.str(ti.notebook_path) || C.str(ti.path);
  if (!target) return null;
  const rel = path.relative(paths.canonical(h.root), paths.canonical(path.resolve(h.ctx.cwd, target)));
  if (!rel || paths.isOutside(rel)) return null; // outside the project
  const relPosix = rel.split(path.sep).join('/');
  if (glob.matchAny(limits.orchestrator_edit_allow, relPosix, process.platform === 'win32' || process.platform === 'darwin')) return null;

  const mode = limits.orchestrator_edit;
  const file = relPosix.length > 200 ? `...${relPosix.slice(-197)}` : relPosix;
  try {
    events.append(h.pid, {
      type: 'orchestrator.warned', src: 'hook', session: h.sid, tool_use_id: C.str(payload.tool_use_id),
      data: { tool: C.snippet(payload.tool_name, 30), file, mode },
      key: C.str(payload.tool_use_id) || `${file}:${Date.now()}`,
    });
  } catch { /* ignore */ }
  if (mode === 'block') return C.deny(h.t('deny.edit', { file }));
  return C.withContext('PreToolUse', h.t('warn.edit', { file }), { systemMessage: h.t('warn.editUser', { file }) });
}

// ---------------------------------------------------------------- Read
// Counts lines cheaply: stops as soon as the threshold is exceeded. null = binary/unreadable.
function exceeds(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    let newlines = 0;
    let lastByte = 10;
    let first = true;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      if (first && buf.subarray(0, n).includes(0)) return null;
      first = false;
      for (let i = 0; i < n; i++) if (buf[i] === 10 && ++newlines > limit) return true;
      lastByte = buf[n - 1];
    }
    return newlines + (lastByte === 10 ? 0 : 1) > limit;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function onRead(payload) {
  if (payload.agent_id) return null;
  const ti = C.obj(payload.tool_input);
  const target = C.str(ti.file_path);
  if (!target) return null;
  const h = C.open(payload, { fastOnly: true });
  if (!h) return null;
  sess.bumpTool(h, 'Read');
  const limit = h.cfg().limits.orchestrator_read_warn_lines;
  if (!(limit > 0)) return null;
  if (Number(ti.limit) > 0) return null;
  const file = path.resolve(h.ctx.cwd, target);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size <= limit || st.size > MAX_READ_BYTES) return null;
  if (exceeds(file, limit) !== true) return null;
  return C.withContext('PreToolUse', h.t('warn.read', { limit }));
}

function run(payload) {
  const tool = C.str(payload.tool_name);
  if (C.AGENT_TOOLS.has(tool)) return onAgent(payload);
  if (C.EDIT_TOOLS.has(tool)) return onEdit(payload);
  if (tool === 'Read') return onRead(payload);
  return null;
}

module.exports = { run, exceeds };
