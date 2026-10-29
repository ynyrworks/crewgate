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
// the text of the FINAL assistant entry at the end of the subagent's own transcript. An earlier text
// (mid-run narration such as "Now build.") is never taken: when the newest assistant entry holds a tool
// call, or a user entry (a tool result) follows it, the run did not end there -> src 'transcript_partial', no text.
function lastMessage(payload) {
  const direct = textOf(payload.last_assistant_message).trim();
  if (direct) return { text: direct, src: 'payload' };
  const lines = C.readTail(C.str(payload.agent_transcript_path), TAIL).split('\n');
  let userAfter = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || (line.indexOf('"assistant"') < 0 && line.indexOf('"user"') < 0)) continue; // also drops a first line cut in half
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o && (o.message || o);
    const role = m && (m.role || o.type);
    if (role === 'user') { userAfter = true; continue; }
    if (role !== 'assistant') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (userAfter || m.stop_reason === 'tool_use' || blocks.some((b) => b && b.type === 'tool_use')) return { text: '', src: 'transcript_partial' };
    const t = textOf(m.content).trim();
    return t ? { text: t, src: 'transcript' } : { text: '', src: 'transcript_partial' };
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

// True when a subagent.start event names this agent id.
function hasStart(h, agentId) {
  if (!agentId) return false;
  try { return events.read(h.pid, { types: 'subagent.start' }).some((e) => e.agent === agentId); } catch { return true; }
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

  // A stop with no start event and no task is not a worker: the harness's own summary / compaction agent.
  const orphan = !found && !hasStart(h, agentId);
  try {
    events.append(h.pid, {
      type: 'subagent.stop', src: 'hook', session: h.sid, agent: agentId || null, task: found && found.id,
      data: {
        ...typeFields(payload.agent_type), last: C.snippet(last.text, LAST_MAX), last_src: last.src,
        had_transcript_path: !!C.str(payload.agent_transcript_path), had_last_message: !!textOf(payload.last_assistant_message).trim(),
        ...(orphan ? { orphan: true } : {}),
      },
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
