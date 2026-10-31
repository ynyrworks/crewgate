'use strict';

// Approval gates (config `gates`: push, open_pr, merge, remote_hosts, large_task, install_or_download).
// The orchestrator asks through `crew gate ask`, asks the user in chat, then records the reply with
// `crew gate answer`. Both steps are events (gate.asked / gate.answered), so the board can show them and
// the PostToolUse hook can tell when a push or merge happened without an approval (gate.missing).
const crypto = require('crypto');
const events = require('./events');
const { currentSession } = require('./sessionid');
const { CrewError, UsageError } = require('./errors');

const GATES = ['push', 'open_pr', 'merge', 'remote_hosts', 'large_task', 'install_or_download'];
const ANSWER_WINDOW_MS = 30 * 60 * 1000;

const newGateId = () => `g-${crypto.randomBytes(3).toString('hex')}`;

function modeOf(cfg, gate) {
  const v = cfg && cfg.gates && cfg.gates[gate];
  return v === 'auto' || v === 'never' ? v : 'ask';
}

// gates.enforce: remind (default) | confirm | block. Anything else is remind.
function enforceOf(cfg) {
  const v = cfg && cfg.gates && cfg.gates.enforce;
  return v === 'confirm' || v === 'block' ? v : 'remind';
}

// gates.require_user_turn: true unless it is explicitly false.
const requiresUserTurn = (cfg) => !(cfg && cfg.gates && cfg.gates.require_user_turn === false);

// The built-in gates plus the project's own: any other key under `gates` set to auto, ask or never. Only `crew gate ask`
// uses those; the hooks detect push, PR and merge, not what a project's gate is about.
const GATE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
function gateNames(cfg) {
  const own = Object.entries((cfg && cfg.gates) || {})
    .filter(([k, v]) => ['auto', 'ask', 'never'].includes(v) && GATE_NAME_RE.test(k) && !GATES.includes(k))
    .map(([k]) => k);
  return [...GATES, ...own];
}

function checkGate(gate, cfg) {
  const names = gateNames(cfg);
  if (!names.includes(gate)) throw new UsageError('gate.unknown', { gate: String(gate), choices: names.join(', ') });
  return gate;
}

// ask(projectId, cfg, { gate, task, detail }, opts) -> { id, gate, mode, answered? }
//   auto  -> recorded as asked and answered yes at once
//   never -> recorded as asked and answered no, then CrewError gate.never
//   ask   -> recorded as asked; the orchestrator asks the user and calls answer()
function ask(projectId, cfg, input, opts = {}) {
  const gate = checkGate(input.gate, cfg);
  const mode = modeOf(cfg, gate);
  const id = newGateId();
  const base = { src: opts.src || 'cli', session: opts.session, task: input.task || undefined };
  events.append(projectId, { ...base, type: 'gate.asked', data: { id, gate, mode, detail: input.detail || '' }, key: id });
  if (mode === 'ask') return { id, gate, mode };
  const reply = mode === 'auto' ? 'yes' : 'no';
  events.append(projectId, {
    ...base, type: 'gate.answered', key: `${id}:answered`,
    data: { id, gate, answer: reply, auto: true, note: mode === 'auto' ? 'gate is auto' : 'gate is never' },
  });
  if (mode === 'never') throw new CrewError('gate.never', { gate });
  return { id, gate, mode, answered: reply };
}

// Did the user speak between the ask and now? Judged once, when the answer is recorded. Returns true, false or 'project'.
//   both sessions known: they must be equal, and a prompt of that session (opts.prompts, ms) lies between;
//   one known: a prompt of the known session lies between (opts.prompts is the answering session's, opts.promptsOf(id)
//     reads another session's);
//   neither known: a prompt of ANY session of the project (opts.projectPrompts()) lies between -> 'project' (weaker).
function userTurnVerdict(asked, session, opts, nowMs) {
  const from = Date.parse(asked.ts);
  const between = (list) => Array.isArray(list) && list.some((t) => t >= from && t <= nowMs);
  const as = asked.session || '';
  if (as && session) return as === session && between(opts.prompts);
  if (as || session) {
    const known = as || session;
    return between(known === session ? opts.prompts : (typeof opts.promptsOf === 'function' ? opts.promptsOf(known) : null));
  }
  return typeof opts.projectPrompts === 'function' && between(opts.projectPrompts()) ? 'project' : false;
}

// answer(projectId, gateId, 'yes'|'no', note, opts) -> { id, gate, answer, user_turn }
// opts: src, session, prompts, promptsOf(sessionId), projectPrompts(). The ask is found by its id (the whole log, no time cutoff).
// data.user_turn (true | false | 'project') and data.ask_session are stored on the gate.answered event.
function answer(projectId, gateId, reply, note, opts = {}) {
  if (reply !== 'yes' && reply !== 'no') throw new UsageError('args.badChoice', { name: 'answer', choices: 'yes, no' });
  const all = events.read(projectId, { types: ['gate.asked', 'gate.answered'] });
  const asked = all.find((e) => e.type === 'gate.asked' && e.data && e.data.id === gateId);
  if (!asked) throw new CrewError('gate.notFound', { id: String(gateId) });
  const done = all.find((e) => e.type === 'gate.answered' && e.data && e.data.id === gateId);
  if (done) throw new CrewError('gate.alreadyAnswered', { id: gateId, answer: done.data.answer });
  const userTurn = userTurnVerdict(asked, opts.session, opts, Date.now());
  events.append(projectId, {
    type: 'gate.answered', src: opts.src || 'cli', session: opts.session, task: asked.task || undefined, key: `${gateId}:answered`,
    data: { id: gateId, gate: asked.data.gate, answer: reply, auto: false, note: note || '', user_turn: userTurn, ask_session: asked.session || '' },
  });
  return { id: gateId, gate: asked.data.gate, answer: reply, user_turn: userTurn };
}

// Is there an approval for `gate` that this session can lean on? A gate.answered "yes" of the last 30
// minutes counts when it belongs to this session, or to no session (the CLI cannot tell the session).
// With opts.requireUserTurn (config gates.require_user_turn, default true) a hand-recorded yes also needs the
// verdict `data.user_turn === true` that answer() stored when it was recorded; the automatic yes of an `auto`
// gate does not, and an older event without the field counts as unknown, so it is not valid.
function hasApproval(projectId, gate, session, now = Date.now(), opts = {}) {
  const since = now - ANSWER_WINDOW_MS;
  const need = opts.requireUserTurn === true;
  return events.read(projectId, { types: 'gate.answered', since }).some((e) => e.data && e.data.gate === gate && e.data.answer === 'yes'
    && (!e.session || !session || e.session === session)
    && (!need || e.data.auto === true || e.data.user_turn === true || e.data.user_turn === 'project'));
}

// Which gate a detected git/PR command falls under (event types come from hooks/gitcmd.js).
function gateOf(found) {
  const cmd = found && found.data && found.data.command;
  if (found.type === 'git.push') return cmd === 'git push' ? 'push' : 'open_pr';
  if (found.type === 'git.merge') return 'merge';
  return null;
}

// history(projectId, limit) -> one row per gate id (asked + its answer) plus gate.missing rows, newest first.
// Row: { id, gate, mode, task, ts, detail, answer, answered_ts, auto, note, missing? }
function history(projectId, limit = 30) {
  const rows = new Map();
  const missing = [];
  for (const e of events.read(projectId, { types: 'gate.*' })) {
    const d = e.data || {};
    if (e.type === 'gate.asked') {
      rows.set(d.id, { id: d.id, gate: d.gate, mode: d.mode, task: e.task, ts: e.ts, detail: d.detail || '', answer: null, answered_ts: null, auto: false, note: '' });
    } else if (e.type === 'gate.answered') {
      const r = rows.get(d.id);
      if (r) Object.assign(r, { answer: d.answer, answered_ts: e.ts, auto: !!d.auto, note: d.note || '' });
    } else if (e.type === 'gate.missing') {
      missing.push({ id: null, gate: d.gate, mode: d.mode, task: e.task, ts: e.ts, detail: d.command || '', answer: null, answered_ts: null, auto: false, note: '', missing: true });
    }
  }
  return [...rows.values(), ...missing].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit);
}

module.exports = { GATES, gateNames, ANSWER_WINDOW_MS, modeOf, currentSession, enforceOf, requiresUserTurn, userTurnVerdict, ask, answer, hasApproval, gateOf, history };
