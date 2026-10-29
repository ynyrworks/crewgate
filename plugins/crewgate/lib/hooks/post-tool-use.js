'use strict';

// PostToolUse: foreground subagent completion (Agent/Task) and git/PR commands (Bash).
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const gitcmd = require('./gitcmd');

// Cheap pre-filter so ordinary Bash calls never pay for project resolution.
const GIT_WORDS = /\b(push|merge|create)\b/;

function onAgent(payload) {
  if (payload.agent_id) return null;
  const h = C.open(payload);
  if (!h) return null;
  const ti = C.obj(payload.tool_input);
  const resp = C.obj(payload.tool_response);
  const tuid = C.str(payload.tool_use_id);
  const rec = tuid ? sess.byToolUse(h.pid, tuid) : null;
  const id = (rec && rec.task) || tasks.findMarker(C.str(ti.prompt).slice(0, 1 << 20));
  if (!id) return null;
  const bg = ti.run_in_background === true || (rec && rec.bg) || resp.isAsync === true
    || /async|background/i.test(C.str(resp.status));
  if (bg) return null; // wait for SubagentStop

  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }
  let noReport = false;
  if (task.state === 'dispatched' && (!rec || rec.worker)) {
    try {
      task = tasks.transition(h.pid, id, 'returned', {
        src: 'hook', session: h.sid, note: 'foreground worker finished without a CLI report',
      });
      noReport = true;
    } catch { return null; }
  }
  if (rec) sess.markStopped(h.pid, rec.id);
  if (task.state !== 'returned') return null;
  const key = noReport ? 'sub.returnedNoReport' : 'sub.returned';
  return C.withContext('PostToolUse', h.t(key, { id, cmd: C.crewCmd() }));
}

function onBash(payload) {
  const command = C.str(C.obj(payload.tool_input).command);
  const gitish = GIT_WORDS.test(command.slice(0, 20000));
  // Ordinary commands only use the session file (no git); git-like ones may resolve the project.
  const h = C.open(payload, { fastOnly: !gitish });
  if (!h) return null;
  sess.bumpTool(h, 'Bash');
  if (!gitish) return null;
  const tuid = C.str(payload.tool_use_id);
  gitcmd.detect(command).forEach((f, i) => {
    try {
      events.append(h.pid, {
        type: f.type, src: 'hook', session: h.sid, tool_use_id: tuid,
        data: f.data, key: `${tuid || Date.now()}:${i}`,
      });
    } catch { /* ignore */ }
  });
  return null;
}

function run(payload) {
  const tool = C.str(payload.tool_name);
  if (C.AGENT_TOOLS.has(tool)) return onAgent(payload);
  if (tool === 'Bash') return onBash(payload);
  return null;
}

module.exports = { run };
