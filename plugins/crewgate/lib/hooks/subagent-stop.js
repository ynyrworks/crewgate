'use strict';

// SubagentStop: record subagent.stop; for a task-linked worker make sure the task is
// `returned` and tell the orchestrator to review it.
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const { typeFields } = require('../core/agents');

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;
const LAST_MAX = 200;

// Text of a message that may be a plain string or Claude content blocks ([{ type: 'text', text }]).
function textOf(m) {
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(textOf).filter(Boolean).join(' ');
  if (m && typeof m === 'object') return textOf(m.text !== undefined ? m.text : m.content);
  return '';
}

// The last assistant text of the stopped subagent -> { text, src }. The payload field first
// (last_assistant_message: a string, or content blocks); when it is empty or in an unexpected shape,
// the newest assistant text block at the end of the subagent's own transcript.
function lastMessage(payload) {
  const direct = textOf(payload.last_assistant_message).trim();
  if (direct) return { text: direct, src: 'payload' };
  const lines = C.readTail(C.str(payload.agent_transcript_path), TAIL).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i] || lines[i].indexOf('"assistant"') < 0) continue; // also drops a first line cut in half
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o && (o.message || o);
    if (!m || (m.role || o.type) !== 'assistant') continue;
    const t = textOf(m.content).trim();
    if (t) return { text: t, src: 'transcript' };
  }
  return { text: '', src: 'none' };
}

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
  const last = lastMessage(payload);
  let task = null;
  if (found) { try { task = tasks.load(h.pid, found.id); } catch { found = null; } }

  try {
    events.append(h.pid, {
      type: 'subagent.stop', src: 'hook', session: h.sid, agent: agentId || null, task: found && found.id,
      data: { ...typeFields(payload.agent_type), last: C.snippet(last.text, LAST_MAX), last_src: last.src },
      key: agentId || `${found ? found.id : 'x'}:${Date.now()}`,
    });
  } catch { /* ignore */ }
  if (!found || !task) return null;

  let noReport = false;
  if (task.state === 'dispatched' && (!found.rec || found.rec.worker)) {
    try {
      task = tasks.transition(h.pid, found.id, 'returned', {
        src: 'hook', session: h.sid, agent: agentId || undefined, note: 'subagent stopped without a CLI report', data: { via: 'subagent-stop' },
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
