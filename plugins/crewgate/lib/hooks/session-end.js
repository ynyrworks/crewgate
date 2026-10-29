'use strict';

// SessionEnd: deterministic digest from the running session counters (one small file),
// plus a "waiting for you" need per abnormal-end flag. Must stay cheap (~1.5 s budget).
const events = require('../core/events');
const store = require('../core/store');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');

function topTools(tools) {
  const entries = Object.entries(tools && typeof tools === 'object' ? tools : {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return Object.fromEntries(entries);
}

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  const s = (h.sid && sess.read(h.sid)) || {};
  // The session file is removed below, so a second SessionEnd for the same run finds none: nothing
  // left to digest. A resumed session gets a new file (new start time) and so its own digest.
  if (h.sid && !Object.keys(s).length) return null;
  const reason = C.snippet(payload.reason, 40) || 'other';
  const touched = Array.isArray(s.tasks) ? s.tasks.slice(0, 20) : [];

  const inflight = [];
  for (const id of touched) {
    try { if (tasks.load(h.pid, id).state === 'dispatched') inflight.push(id); } catch { /* gone */ }
  }
  const flags = [];
  if (inflight.length) flags.push('tasks_in_flight');
  if (s.ends_question) flags.push('ended_with_question');
  if (s.turn_open && (s.prompts || 0) > 0) flags.push('no_stop_seen');

  const started = Date.parse(s.started);
  const digest = {
    reason,
    duration_s: Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null,
    prompts: s.prompts || 0,
    tool_total: s.tool_total || 0,
    tools: topTools(s.tools),
    first_prompt: s.first_prompt || null,
    last_prompt: s.last_prompt || null,
    last_tool: s.last_tool || null,
    tasks: touched,
    flags,
  };
  try {
    events.append(h.pid, { type: 'session.end', src: 'hook', session: h.sid, data: digest, key: h.sid ? `${h.sid}:${s.started || ''}:${s.prompts || 0}:${s.tool_total || 0}` : `end:${Date.now()}` });
  } catch { /* ignore */ }

  if (flags.length && reason !== 'resume' && s.project) {
    const texts = [];
    if (flags.includes('tasks_in_flight')) texts.push(h.t('need.inflight', { ids: inflight.slice(0, 5).join(', ') }));
    if (flags.includes('ended_with_question')) texts.push(h.t('need.question'));
    if (flags.includes('no_stop_seen')) texts.push(h.t('need.noStop'));
    try {
      const open = new Set(store.needList(h.pid).map((n) => n.text));
      for (const text of texts) {
        const body = `${text}${h.sid ? ` [${String(h.sid).slice(0, 8)}]` : ''}`;
        if (!open.has(body)) store.needAdd(h.pid, body, { src: 'hook', session: h.sid });
      }
    } catch { /* ignore */ }
  }
  if (h.sid) sess.remove(h.sid);
  return null;
}

module.exports = { run };
