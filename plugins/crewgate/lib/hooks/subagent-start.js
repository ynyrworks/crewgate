'use strict';

// SubagentStart: record subagent.start and bind the agent id to the dispatch it belongs to.
// Codex fallback: its PreToolUse payload carries an opaque spawn message, so no dispatch was seen
// there. The marker is then read from the new subagent's own rollout file (C.codexSpawnMarker) and the
// dispatch is recorded here (created -> dispatched, event task.dispatched with engine codex).
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const { typeFields } = require('../core/agents');

function codexDispatch(h, payload, agentId, type) {
  const id = C.codexSpawnMarker(payload);
  if (!id) return null;
  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }
  const worker = task.state === 'created' || task.state === 'dispatched';
  const data = { ...typeFields(payload.agent_type), model: C.snippet(payload.model, 60) || null, background: true, engine: 'codex', via: 'subagent-start' };
  try {
    if (task.state === 'created') tasks.transition(h.pid, id, 'dispatched', { src: 'hook', session: h.sid, agent: agentId, data });
    else if (task.state === 'dispatched') {
      events.append(h.pid, { type: 'task.dispatched', src: 'hook', session: h.sid, task: id, agent: agentId, data: { ...data, redispatch: true }, key: `${id}:${agentId}` });
    }
  } catch { /* an illegal transition must not stop the start */ }
  const rec = { task: id, type, bg: true, worker, ts: Date.now(), agent: agentId, stopped: false, codex: true };
  sess.remember(h.pid, `agent:${agentId}`, rec);
  sess.touch(h, (s) => sess.addTask(s, id));
  return { ...rec, id: `agent:${agentId}` };
}

function run(payload) {
  const agentId = C.str(payload.agent_id);
  if (!agentId) return null;
  const h = C.open(payload);
  if (!h) return null;
  const type = C.normType(payload.agent_type);
  let rec = sess.bindAgent(h.pid, agentId, type) || sess.byAgent(h.pid, agentId);
  if (!rec) {
    try { rec = codexDispatch(h, payload, agentId, type); } catch { rec = null; }
  }
  try {
    events.append(h.pid, {
      type: 'subagent.start', src: 'hook', session: h.sid, agent: agentId, task: rec && rec.task,
      data: { ...typeFields(payload.agent_type), linked: !!rec }, key: agentId,
    });
  } catch { /* ignore */ }
  return null;
}

module.exports = { run };
