'use strict';

// SubagentStop: record subagent.stop; for a task-linked worker make sure the task is
// `returned` and tell the orchestrator to review it.
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');

const HEAD = 64 * 1024;

// Finds the task of a stopped subagent: dispatch map, then marker in the transcript head,
// then marker in the last message.
function link(h, payload, agentId) {
  const rec = agentId ? sess.byAgent(h.pid, agentId) : null;
  if (rec && rec.task) return { id: rec.task, rec };
  const fromTranscript = tasks.findMarker(C.readHead(C.str(payload.agent_transcript_path), HEAD));
  if (fromTranscript) return { id: fromTranscript, rec: null };
  const fromMessage = tasks.findMarker(C.str(payload.last_assistant_message).slice(0, HEAD));
  return fromMessage ? { id: fromMessage, rec: null } : null;
}

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  const agentId = C.str(payload.agent_id);
  let found = null;
  try { found = link(h, payload, agentId); } catch { /* no link */ }
  let task = null;
  if (found) { try { task = tasks.load(h.pid, found.id); } catch { found = null; } }

  try {
    events.append(h.pid, {
      type: 'subagent.stop', src: 'hook', session: h.sid, agent: agentId || null, task: found && found.id,
      data: { agent_type: C.snippet(payload.agent_type, 80), last: C.snippet(payload.last_assistant_message, 300) },
      key: agentId || `${found ? found.id : 'x'}:${Date.now()}`,
    });
  } catch { /* ignore */ }
  if (!found || !task) return null;

  let noReport = false;
  if (task.state === 'dispatched' && (!found.rec || found.rec.worker)) {
    try {
      task = tasks.transition(h.pid, found.id, 'returned', {
        src: 'hook', session: h.sid, agent: agentId || undefined, note: 'subagent stopped without a CLI report',
      });
      noReport = true;
    } catch { return null; }
  }
  if (found.rec) sess.markStopped(h.pid, found.rec.id);
  sess.touch(h, (s) => sess.addTask(s, found.id));
  if (task.state !== 'returned') return null;
  return C.notice(h.t(noReport ? 'sub.returnedNoReport' : 'sub.returned', { id: found.id, cmd: C.crewCmd() }));
}

module.exports = { run };
