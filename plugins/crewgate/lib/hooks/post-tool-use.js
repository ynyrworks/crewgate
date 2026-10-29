'use strict';

// PostToolUse: foreground subagent completion (Agent/Task) and git/PR commands (Bash).
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const gitcmd = require('./gitcmd');
const gates = require('../core/gates');

// Cheap pre-filter so ordinary Bash calls never pay for project resolution.
const GIT_WORDS = /\b(push|merge|create)\b/;

function onAgent(payload) {
  if (payload.agent_id) return null;
  const h = C.open(payload);
  if (!h) return null;
  const ti = C.obj(payload.tool_input);
  const resp = C.obj(payload.tool_response);
  const tuid = C.str(payload.tool_use_id);
  const rec = tuid ? sess.byToolUse(h.pid, tuid) : null;
  const id = (rec && rec.task) || tasks.findMarker(C.agentPrompt(ti).slice(0, 1 << 20));
  if (!id) return null;
  const bg = ti.run_in_background === true || payload.tool_name === C.CODEX_SPAWN || (rec && rec.bg) || resp.isAsync === true
    || /async|background/i.test(C.str(resp.status));
  if (bg) return null; // wait for SubagentStop

  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }
  let noReport = false;
  if (task.state === 'dispatched' && (!rec || rec.worker)) {
    try {
      task = tasks.transition(h.pid, id, 'returned', {
        src: 'hook', session: h.sid, note: 'foreground worker finished without a CLI report', data: { via: 'post-tool-use' },
      });
      noReport = true;
    } catch { return null; }
  }
  if (rec) sess.markStopped(h.pid, rec.id);
  if (task.state !== 'returned') return null;
  const key = noReport ? 'sub.returnedNoReport' : 'sub.returned';
  return C.withContext('PostToolUse', h.t(key, { id, cmd: C.crewCmd() }));
}

// The text of a Bash tool_response: a string, or { stdout, stderr }.
function responseText(r) {
  if (typeof r === 'string') return r;
  const o = C.obj(r);
  return [C.str(o.stdout), C.str(o.stderr), C.str(o.output)].filter(Boolean).join('\n');
}

// Event data for a detected `git merge`. A command written once can merge many times (a shell loop), so
// when its output shows several merges and the branch names are not known, each one gets its own
// event; otherwise one event that carries the number git reported.
function mergeEvents(f, merges, mergeCommands) {
  const d = f.data;
  if (!merges.length) return [d];
  if (d.dynamic && mergeCommands === 1 && merges.length > 1) return merges.map((m, i) => ({ ...d, ...m, seq: i + 1, of: merges.length }));
  return [{ ...d, merged: merges.length, outcome: merges[0].outcome, ...(merges[0].range ? { range: merges[0].range } : {}) }];
}

// A push, PR or merge whose gate is "ask" needs a recorded yes (crew gate answer) from the last 30 minutes.
// Without one: a gate.missing event and a non-blocking reminder for the model.
function gateReminder(h, payload, found, tuid) {
  const wanted = new Map();
  for (const f of found) {
    const gate = gates.gateOf(f);
    if (gate && !wanted.has(gate)) wanted.set(gate, f.data.command);
  }
  const lines = [];
  for (const [gate, what] of wanted) {
    let cfg;
    try { cfg = h.cfg(); } catch { return null; }
    if (gates.modeOf(cfg, gate) !== 'ask') continue;
    let approved = true;
    try { approved = gates.hasApproval(h.pid, gate, h.sid); } catch { /* cannot tell: stay quiet */ }
    if (approved) continue;
    try {
      events.append(h.pid, {
        type: 'gate.missing', src: 'hook', session: h.sid, tool_use_id: tuid,
        data: { gate, mode: 'ask', command: what }, key: `${tuid || Date.now()}:${gate}`,
      });
    } catch { /* ignore */ }
    lines.push(h.t('gate.missing', { what, gate, cmd: C.crewCmd() }));
  }
  return lines.length ? C.withContext('PostToolUse', lines.join('\n')) : null;
}

function onBash(payload) {
  const command = C.str(C.obj(payload.tool_input).command);
  const gitish = GIT_WORDS.test(command.slice(0, 20000));
  // Ordinary commands only use the session file (no git); git-like ones may resolve the project.
  const h = C.open(payload, { fastOnly: !gitish });
  if (!h) return null;
  sess.bumpTool(h, 'Bash');
  if (!gitish) return null;
  const tuid = C.str(payload.tool_use_id);
  const merges = gitcmd.mergesIn(responseText(payload.tool_response));
  const found = gitcmd.detect(command);
  found.forEach((f, i) => {
    const list = f.type === 'git.merge' ? mergeEvents(f, merges, found.filter((x) => x.type === 'git.merge').length) : [f.data];
    list.forEach((data, k) => {
      try {
        events.append(h.pid, {
          type: f.type, src: 'hook', session: h.sid, tool_use_id: tuid,
          data, key: `${tuid || Date.now()}:${i}${k ? `:${k}` : ''}`,
        });
      } catch { /* ignore */ }
    });
  });
  return gateReminder(h, payload, found, tuid);
}

function run(payload) {
  const tool = C.str(payload.tool_name);
  if (C.AGENT_TOOLS.has(tool)) return onAgent(payload);
  if (tool === 'Bash') return onBash(payload);
  return null;
}

module.exports = { run };
