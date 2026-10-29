'use strict';

// SubagentStart: record subagent.start and bind the agent id to the dispatch it belongs to.
const events = require('../core/events');
const C = require('./common');
const sess = require('./session');

function run(payload) {
  const agentId = C.str(payload.agent_id);
  if (!agentId) return null;
  const h = C.open(payload);
  if (!h) return null;
  const type = C.normType(payload.agent_type);
  const rec = sess.bindAgent(h.pid, agentId, type) || sess.byAgent(h.pid, agentId);
  try {
    events.append(h.pid, {
      type: 'subagent.start', src: 'hook', session: h.sid, agent: agentId, task: rec && rec.task,
      data: { agent_type: C.snippet(payload.agent_type, 80), linked: !!rec }, key: agentId,
    });
  } catch { /* ignore */ }
  return null;
}

module.exports = { run };
