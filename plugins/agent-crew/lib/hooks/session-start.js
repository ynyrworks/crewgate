'use strict';

// SessionStart: record session.start and inject a small fenced brief (<= 4,000 bytes).
const fs = require('fs');
const events = require('../core/events');
const store = require('../core/store');
const paths = require('../core/paths');
const tasks = require('../core/tasks');
const { clean } = require('../core/redact');
const C = require('./common');
const sess = require('./session');

const MAX_BYTES = 4000;
const OPEN_STATES = ['created', 'dispatched', 'returned', 'reviewing', 'accepted'];
const line = (s, n) => clean(String(s || '').replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(), n);

function openHandoffs(pid) {
  try {
    return fs.readdirSync(paths.handoffDir(pid, 'open'))
      .filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((n) => paths.SAFE_ID_RE.test(n)).sort();
  } catch { return []; }
}

function cutBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '');
}

function build(h, perState) {
  const cfg = h.cfg();
  const name = line(h.ctx.project && h.ctx.project.name, 60) || 'project';
  const byState = {};
  let list = [];
  try { list = tasks.list(h.pid); } catch { /* none */ }
  for (const t of list) if (OPEN_STATES.includes(t.state)) (byState[t.state] = byState[t.state] || []).push(t);
  const parts = [];
  for (const s of OPEN_STATES) {
    const ts = byState[s];
    if (!ts) continue;
    const shown = ts.slice(0, perState).map((t) => (perState > 1 ? `${t.id} "${line(t.title, 50)}"` : t.id));
    parts.push(`${s}=${ts.length}${shown.length ? ` [${shown.join(', ')}${ts.length > shown.length ? ', ...' : ''}]` : ''}`);
  }
  const handoffs = openHandoffs(h.pid);
  let needs = 0;
  try { needs = store.needList(h.pid).length; } catch { /* none */ }

  const inner = [parts.length ? h.t('brief.tasks', { list: parts.join('; ') }) : h.t('brief.noTasks')];
  if (handoffs.length) inner.push(h.t('brief.handoffs', { count: handoffs.length, ids: handoffs.slice(0, 5).join(', ') + (handoffs.length > 5 ? ', ...' : '') }));
  if (needs) inner.push(h.t('brief.needs', { count: needs }));
  inner.push(h.t('brief.rules', { file: line(cfg.lessons && cfg.lessons.rules_file, 80) || 'CLAUDE.md' }));

  return [
    h.t('brief.intro', { name }),
    h.t('brief.cli', { cmd: C.crewCmd() }),
    h.t('brief.dataNote'),
    '<crew-state untrusted="true">',
    ...inner,
    '</crew-state>',
  ].join('\n');
}

function brief(h) {
  for (const n of [6, 3, 1, 0]) {
    const text = build(h, n);
    if (Buffer.byteLength(text) <= MAX_BYTES) return text;
  }
  return cutBytes(build(h, 0), MAX_BYTES);
}

function run(payload) {
  const h = C.open(payload, { full: true });
  if (!h) return null;
  const p = h.payload;
  sess.prune();
  const st = sess.touch(h, (s) => { s.source = C.snippet(p.source, 20); }) || {};
  try {
    events.append(h.pid, {
      type: 'session.start', src: 'hook', session: h.sid,
      data: { source: C.snippet(p.source, 20), model: C.snippet(p.model, 80) },
      key: `${h.sid}:${C.snippet(p.source, 20)}:${st.started || ''}:${st.prompts || 0}:${st.tool_total || 0}`,
    });
  } catch { /* logging must not block the brief */ }
  return C.withContext('SessionStart', brief(h));
}

module.exports = { run, brief };
