'use strict';

// Stop: non-blocking reminder about unreviewed returns / running background tasks.
// Never sets decision:"block", and does nothing when stop_hook_active is set.
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');

const QUESTION_END = /[?？][\s"'”’)\]*_`]*$/;

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  const tail = C.str(payload.last_assistant_message).slice(-300);
  let sig = '';
  let line = null;

  if (!payload.stop_hook_active) {
    let returned = [];
    try { returned = tasks.list(h.pid, { state: 'returned' }).map((t) => t.id); } catch { /* none */ }
    const running = [];
    try {
      const uses = sess.readUses(h.pid);
      for (const r of Object.values(uses)) {
        if (!r.bg || r.stopped || !r.task || running.includes(r.task) || Date.now() - (r.ts || 0) > 6 * 3600 * 1000) continue;
        try { if (tasks.load(h.pid, r.task).state === 'dispatched') running.push(r.task); } catch { /* gone */ }
      }
    } catch { /* ignore */ }
    const bt = payload.background_tasks;
    const extra = Array.isArray(bt) ? bt.length : 0;
    const parts = [];
    if (returned.length) parts.push(h.t('stop.returned', { count: returned.length, ids: returned.slice(0, 5).join(', ') }));
    if (running.length || extra) parts.push(h.t('stop.running', { count: Math.max(running.length, extra), ids: running.slice(0, 5).join(', ') || '-' }));
    if (parts.length) { sig = parts.join('|'); line = h.t('stop.line', { parts: parts.join('; ') }); }
  }

  let announce = false;
  sess.touch(h, (s) => {
    s.turn_open = false;
    s.ends_question = QUESTION_END.test(tail.trimEnd());
    if (line && s.stop_sig !== sig) { s.stop_sig = sig; announce = true; } // do not nag with the same reminder
    if (!line && !payload.stop_hook_active) s.stop_sig = '';
  });
  return announce || (line && !h.sid) ? C.withContext('Stop', line) : null;
}

module.exports = { run };
