'use strict';

// PreCompact: record session.compact with a small digest checkpoint.
const events = require('../core/events');
const C = require('./common');
const sess = require('./session');

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  const s = (h.sid && sess.read(h.sid)) || {};
  const trigger = C.snippet(payload.trigger, 20);
  try {
    events.append(h.pid, {
      type: 'session.compact', src: 'hook', session: h.sid,
      data: {
        trigger, prompts: s.prompts || 0, tool_total: s.tool_total || 0, last_tool: s.last_tool || null,
        tasks: Array.isArray(s.tasks) ? s.tasks.slice(0, 10) : [],
      },
      key: `${h.sid}:${trigger}:${s.prompts || 0}:${s.tool_total || 0}`,
    });
  } catch { /* ignore */ }
  return null;
}

module.exports = { run };
