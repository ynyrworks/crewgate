'use strict';

// Approval gates (config `gates`: push, open_pr, merge, remote_hosts, large_task, install_or_download).
// The orchestrator asks through `crew gate ask`, asks the user in chat, then records the reply with
// `crew gate answer`. Both steps are events (gate.asked / gate.answered), so the board can show them and
// the PostToolUse hook can tell when a push or merge happened without an approval (gate.missing).
const crypto = require('crypto');
const events = require('./events');
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

function checkGate(gate) {
  if (!GATES.includes(gate)) throw new UsageError('gate.unknown', { gate: String(gate), choices: GATES.join(', ') });
  return gate;
}

// ask(projectId, cfg, { gate, task, detail }, opts) -> { id, gate, mode, answered? }
//   auto  -> recorded as asked and answered yes at once
//   never -> recorded as asked and answered no, then CrewError gate.never
//   ask   -> recorded as asked; the orchestrator asks the user and calls answer()
function ask(projectId, cfg, input, opts = {}) {
  const gate = checkGate(input.gate);
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

// answer(projectId, gateId, 'yes'|'no', note, opts) -> { id, gate, answer }
function answer(projectId, gateId, reply, note, opts = {}) {
  if (reply !== 'yes' && reply !== 'no') throw new UsageError('args.badChoice', { name: 'answer', choices: 'yes, no' });
  const all = events.read(projectId, { types: ['gate.asked', 'gate.answered'] });
  const asked = all.find((e) => e.type === 'gate.asked' && e.data && e.data.id === gateId);
  if (!asked) throw new CrewError('gate.notFound', { id: String(gateId) });
  const done = all.find((e) => e.type === 'gate.answered' && e.data && e.data.id === gateId);
  if (done) throw new CrewError('gate.alreadyAnswered', { id: gateId, answer: done.data.answer });
  events.append(projectId, {
    type: 'gate.answered', src: opts.src || 'cli', session: opts.session, task: asked.task || undefined, key: `${gateId}:answered`,
    data: { id: gateId, gate: asked.data.gate, answer: reply, auto: false, note: note || '' },
  });
  const prompts = opts.prompts;
  return {
    id: gateId, gate: asked.data.gate, answer: reply,
    user_turn: reply === 'yes' ? userTurnBetween(prompts, Date.parse(asked.ts), Date.now()) : null,
  };
}

// Did the user send a message between two moments? `prompts` are the UserPromptSubmit times (ms) of the
// session, kept by the UserPromptSubmit hook (no text). null = cannot tell (no list).
function userTurnBetween(prompts, fromMs, toMs) {
  if (!Array.isArray(prompts)) return null;
  return prompts.some((t) => t >= fromMs && t <= toMs);
}

// Is there an approval for `gate` that this session can lean on? A gate.answered "yes" of the last 30
// minutes counts when it belongs to this session, or to no session (the CLI cannot tell the session).
// With opts.requireUserTurn (config gates.require_user_turn, default true) a hand-recorded yes also needs a
// user message of the session (opts.prompts, ms) between its "gate ask" and itself; the automatic yes of an
// `auto` gate does not. Without opts the old rule applies.
function hasApproval(projectId, gate, session, now = Date.now(), opts = {}) {
  const since = now - ANSWER_WINDOW_MS;
  const need = opts.requireUserTurn === true;
  const all = events.read(projectId, { types: need ? ['gate.asked', 'gate.answered'] : 'gate.answered', since: need ? since - ANSWER_WINDOW_MS : since });
  const asked = new Map();
  if (need) for (const e of all) if (e.type === 'gate.asked' && e.data) asked.set(e.data.id, Date.parse(e.ts));
  return all.some((e) => {
    if (e.type !== 'gate.answered' || !e.data || e.data.gate !== gate || e.data.answer !== 'yes') return false;
    if (Date.parse(e.ts) < since) return false;
    if (e.session && session && e.session !== session) return false;
    if (!need || e.data.auto) return true;
    const from = asked.get(e.data.id);
    return from !== undefined && userTurnBetween(opts.prompts, from, Date.parse(e.ts)) === true;
  });
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

module.exports = { GATES, ANSWER_WINDOW_MS, modeOf, enforceOf, requiresUserTurn, userTurnBetween, ask, answer, hasApproval, gateOf, history };
