'use strict';

// SessionStart: record session.start and inject a small fenced brief (<= 4,000 bytes).
const fs = require('fs');
const path = require('path');
const events = require('../core/events');
const store = require('../core/store');
const paths = require('../core/paths');
const tasks = require('../core/tasks');
const { clean } = require('../core/redact');
const C = require('./common');
const sess = require('./session');
const account = require('../core/account');

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
  if (h.accountWarn) inner.push(h.t(h.accountWarn === 'unknown' ? 'brief.accountUnknown' : 'brief.accountMismatch'));
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

// Codex has no Claude account: its SessionStart carries a turn id or a rollout transcript.
function isCodex(p) {
  return (typeof p.turn_id === 'string' && p.turn_id !== '') || /^rollout-/.test(path.basename(String(p.transcript_path || '')));
}
const currentAccount = (p) => (isCodex(p) ? null : account.current(process.env));

// Mismatch (or unknown account) against account.expected: one event per session, one need per session; never blocks.
// The event and the need carry no account text: the expected value may be an email address.
function warnAccount(h, first, acct) {
  try {
    events.append(h.pid, {
      type: 'account.mismatch', src: 'hook', session: h.sid,
      data: { reason: h.accountWarn, ...(acct ? { account_id: acct.id } : {}) },
      key: h.sid ? `account:${h.sid}` : `account:${Date.now()}`,
    });
  } catch { /* the warning in the brief still stands */ }
  if (!first) return;
  try { store.needAdd(h.pid, h.t(h.accountWarn === 'unknown' ? 'account.needUnknown' : 'account.needMismatch'), { src: 'hook', session: h.sid }); } catch { /* ignore */ }
}

function run(payload) {
  const h = C.open(payload, { full: true });
  if (!h) return null;
  const p = h.payload;
  sess.prune();
  const acct = currentAccount(p);
  if (acct) account.remember(acct);
  const expected = typeof h.cfg().account === 'object' && h.cfg().account ? h.cfg().account.expected : '';
  const verdict = expected ? account.matches(acct, expected) : true;
  let firstWarn = !h.sid;
  const st = sess.touch(h, (s) => {
    s.source = C.snippet(p.source, 20);
    if (verdict !== true && !s.account_warned) { s.account_warned = true; firstWarn = true; }
  }) || {};
  // A new process (startup, resume, fork) has none of the old workers; a compact or clear keeps the same ones.
  if (/^(startup|resume|fork)$/.test(C.str(p.source))) { try { sess.clearStale(h.pid); } catch { /* a stale record only ages out */ } }
  if (verdict !== true) h.accountWarn = verdict === null ? 'unknown' : 'mismatch';
  try {
    events.append(h.pid, {
      type: 'session.start', src: 'hook', session: h.sid,
      data: { source: C.snippet(p.source, 20), model: C.snippet(p.model, 80), ...(acct ? { account_id: acct.id, ...(acct.plan ? { plan: acct.plan } : {}) } : {}) },
      // session id + source + the session file's start time: stable while the session runs (counters are not part of it),
      // so a harness that fires SessionStart twice (Codex) records one event; a resume or compaction has its own source / file.
      key: h.sid ? `${h.sid}:${C.snippet(p.source, 20)}:${st.started || ''}` : `start:${Date.now()}`,
    });
  } catch { /* logging must not block the brief */ }
  if (h.accountWarn) warnAccount(h, firstWarn, acct);
  // Below-normal priority for the Claude Code process (children inherit it). Swallows every error.
  try { require('./priority').lower(h.cfg().limits && h.cfg().limits.process_priority); } catch { /* the session goes on */ }
  try { require('../core/clishim').write(); } catch { /* scripts lose a convenience; the session goes on */ }
  // Optional (global board.autostart): start the board if it is down. Spawns detached, never waits, never throws.
  try {
    const b = h.cfg().board;
    if (!(b && b.enabled === false)) require('../commands/board').ensureStarted();
  } catch { /* the brief must not depend on the board */ }
  return C.withContext('SessionStart', brief(h));
}

module.exports = { run, brief };
