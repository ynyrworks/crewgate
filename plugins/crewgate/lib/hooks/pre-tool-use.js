'use strict';

// PreToolUse: Agent/Task dispatch tracking, orchestrator edit guard, big-file read reminder, gate enforcement for Bash.
const fs = require('fs');
const path = require('path');
const events = require('../core/events');
const i18n = require('../core/i18n');
const paths = require('../core/paths');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const { typeFields } = require('../core/agents');
const glob = require('./glob');
const gitcmd = require('./gitcmd');
const gates = require('../core/gates');
const G = require('./gatecheck');
const { SHELL_TOOLS, LIMIT_WORDS } = require('./prefilter');
const limits = require('./agentlimits');

const MAX_READ_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------- Agent / Task
function onAgent(payload) {
  if (payload.agent_id) return null; // dispatches come from the main session
  const h = C.open(payload);
  if (!h) return null;
  const ti = C.obj(payload.tool_input);
  const tuid = C.str(payload.tool_use_id);
  sess.bumpTool(h, C.str(payload.tool_name) || 'Agent');
  const id = tasks.findMarker(C.agentPrompt(ti).slice(0, 1 << 20));
  if (!id) return null;
  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }

  const type = C.normType(C.agentTypeOf(ti));
  const bg = ti.run_in_background === true || payload.tool_name === C.CODEX_SPAWN;
  const model = C.snippet(ti.model, 60) || null;
  const eng = payload.tool_name === C.CODEX_SPAWN ? { engine: 'codex' } : {};
  const key = tuid || `${id}:${Date.now()}`;
  // Only a task that is waiting for (or already in) a worker run is a worker dispatch;
  // a task in review may be linked to a reviewer subagent and must not change state.
  const worker = task.state === 'created' || task.state === 'dispatched';

  // Over the limit: deny before anything is recorded, so the task stays as it was and can be dispatched later.
  // Counted: workers that are really running (sess.running), this task excluded so a re-dispatch is not counted twice.
  let over = null;
  if (worker) {
    const lim = h.cfg().limits;
    const others = sess.running(h.pid, id);
    if (lim.max_parallel_workers > 0 && others.length + 1 > lim.max_parallel_workers) {
      over = { id, count: others.length + 1, max: lim.max_parallel_workers, ids: others.join(', ') };
      if (lim.parallel_enforce !== 'warn') return C.deny(h.t('deny.parallel', over));
    }
  }

  try {
    if (task.state === 'created') {
      tasks.transition(h.pid, id, 'dispatched', {
        src: 'hook', session: h.sid,
        data: { ...typeFields(C.agentTypeOf(ti)), model, background: bg, tool_use_id: C.snippet(tuid, 80) || null, via: 'pre-tool-use', ...eng },
      });
    } else if (task.state === 'dispatched' && !sess.byToolUse(h.pid, key)) {
      // Already dispatched through the CLI (send-back): record this launch.
      events.append(h.pid, {
        type: 'task.dispatched', src: 'hook', session: h.sid, task: id, tool_use_id: tuid,
        data: { ...typeFields(C.agentTypeOf(ti)), model, background: bg, tool_use_id: C.snippet(tuid, 80), redispatch: true, via: 'pre-tool-use', ...eng }, key,
      });
    }
  } catch { /* an illegal transition must not stop the dispatch */ }

  sess.remember(h.pid, key, { task: id, type, bg, worker, ts: Date.now(), agent: null, stopped: false, session: h.sid || null, ...(eng.engine ? { codex: true } : {}) });
  sess.touch(h, (s) => sess.addTask(s, id));

  if (over) return C.withContext('PreToolUse', h.t('warn.parallel', over));
  return null;
}

// ---------------------------------------------------------------- SendMessage
// Waking a stopped crew worker is a new run: it counts like a dispatch. A message to anything that is not a known
// worker (another name, a running worker, a reviewer) passes untouched. The payload field (tool_input.to) is read from
// the tool's documented input and is not measured: see docs/PLUGIN-FACTS.md.
function onSend(payload) {
  if (payload.agent_id) return null;
  const to = C.str(C.obj(payload.tool_input).to);
  if (!to) return null;
  const h = C.open(payload);
  if (!h) return null;
  const rec = sess.byAgent(h.pid, to);
  if (!rec || !rec.worker || !rec.stopped || !rec.task) return null;
  const lim = h.cfg().limits;
  const others = sess.running(h.pid, rec.task);
  const vars = { id: rec.task, count: others.length + 1, max: lim.max_parallel_workers, ids: others.join(', ') };
  if (lim.max_parallel_workers > 0 && vars.count > vars.max) {
    if (lim.parallel_enforce !== 'warn') return C.deny(h.t('deny.parallel', vars));
    return C.withContext('PreToolUse', h.t('warn.parallel', vars));
  }
  sess.remember(h.pid, rec.id, { ...rec, id: undefined, stopped: false, resumed: true, ts: Date.now(), session: h.sid || null });
  return null;
}

// ---------------------------------------------------------------- Edit / Write
function onEdit(payload) {
  if (payload.agent_id) return null;
  const h = C.open(payload, { full: true });
  if (!h) return null;
  sess.bumpTool(h, C.str(payload.tool_name));
  if (!h.ctx.isMainWorktree) return null;
  const limits = h.cfg().limits;
  if (limits.orchestrator_edit === 'off') return null;
  const ti = C.obj(payload.tool_input);
  const target = C.str(ti.file_path) || C.str(ti.notebook_path) || C.str(ti.path);
  if (!target) return null;
  const rel = path.relative(paths.canonical(h.root), paths.canonical(path.resolve(h.ctx.cwd, target)));
  if (!rel || paths.isOutside(rel)) return null; // outside the project
  const relPosix = rel.split(path.sep).join('/');
  if (glob.matchAny(limits.orchestrator_edit_allow, relPosix, process.platform === 'win32' || process.platform === 'darwin')) return null;

  const mode = limits.orchestrator_edit;
  const file = relPosix.length > 200 ? `...${relPosix.slice(-197)}` : relPosix;
  try {
    events.append(h.pid, {
      type: 'orchestrator.warned', src: 'hook', session: h.sid, tool_use_id: C.str(payload.tool_use_id),
      data: { tool: C.snippet(payload.tool_name, 30), file, mode },
      key: C.str(payload.tool_use_id) || `${file}:${Date.now()}`,
    });
  } catch { /* ignore */ }
  if (mode === 'block') return C.deny(h.t('deny.edit', { file }));
  return C.withContext('PreToolUse', h.t('warn.edit', { file }), { systemMessage: h.t('warn.editUser', { file }) });
}

// ---------------------------------------------------------------- Read
// Counts lines cheaply: stops as soon as the threshold is exceeded. null = binary/unreadable.
function exceeds(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    let newlines = 0;
    let lastByte = 10;
    let first = true;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      if (first && buf.subarray(0, n).includes(0)) return null;
      first = false;
      for (let i = 0; i < n; i++) if (buf[i] === 10 && ++newlines > limit) return true;
      lastByte = buf[n - 1];
    }
    return newlines + (lastByte === 10 ? 0 : 1) > limit;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function onRead(payload) {
  if (payload.agent_id) return null;
  const ti = C.obj(payload.tool_input);
  const target = C.str(ti.file_path);
  if (!target) return null;
  const h = C.open(payload, { fastOnly: true });
  if (!h) return null;
  sess.bumpTool(h, 'Read');
  const limit = h.cfg().limits.orchestrator_read_warn_lines;
  if (!(limit > 0)) return null;
  if (Number(ti.limit) > 0) return null;
  const file = path.resolve(h.ctx.cwd, target);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size <= limit || st.size > MAX_READ_BYTES) return null;
  if (exceeds(file, limit) !== true) return null;
  return C.withContext('PreToolUse', h.t('warn.read', { limit }));
}

// ---------------------------------------------------------------- Bash (gates.enforce)
// A push, PR or merge under a "never" gate is denied in every gates.enforce mode. Under an "ask" gate without a
// usable approval, in a project whose gates.enforce is confirm (Claude Code asks the user) or block (denied).
// remind (the default) is handled after the command by PostToolUse. Codex (measured: deny blocks, ask fails open)
// gets deny in place of every ask. Only registered projects are looked at;
// a cd / git -C target outside them is never enforced.
// A crew worker / reviewer / refuter that runs something its role forbids (agentlimits.js) is denied. Best effort:
// any failure here lets the command through.
function onAgentLimit(payload, command) {
  try {
    let type = payload.agent_type ? C.normType(payload.agent_type) : '';
    let h = null;
    if (!type) {
      h = C.open(payload);
      const rec = h && sess.byAgent(h.pid, C.str(payload.agent_id));
      type = rec ? C.normType(rec.type) : '';
    }
    if (!limits.limited(type)) return null;
    const hit = limits.scan(command, type);
    if (!hit) return null;
    if (!h) h = C.open(payload);
    const tuid = C.str(payload.tool_use_id);
    if (h) {
      try {
        events.append(h.pid, {
          type: 'agent.limit', src: 'hook', session: h.sid, agent: C.str(payload.agent_id) || undefined, tool_use_id: tuid,
          data: { agent_type: type, command: C.snippet(hit.word, 40), tool_use_id: C.snippet(tuid, 80) || null },
          key: `${tuid || Date.now()}:limit`,
        });
      } catch { /* ignore */ }
    }
    const lang = h ? h.lang() : 'en';
    const key = hit.loop ? 'limit.loop' : hit.word === 'git' ? 'limit.git' : 'limit.kill';
    return C.deny(i18n.t(lang, `hooks.${key}`, { type, word: hit.word }));
  } catch { return null; }
}

function onBash(payload) {
  const codex = G.isCodex(payload); // Codex honours deny but not ask: it only ever gets deny or nothing
  const command = C.str(C.obj(payload.tool_input).command);
  if (payload.agent_id && LIMIT_WORDS.test(command.slice(0, 20000))) {
    const denied = onAgentLimit(payload, command);
    if (denied) return denied;
  }
  if (!G.GIT_WORDS.test(command.slice(0, 20000))) return null;
  const found = gitcmd.detect(command).filter((f) => gates.gateOf(f));
  if (!found.length) return null;
  // Same resolution as PostToolUse: the session file only short-cuts when cwd is inside its project, so a shell
  // that moved to another registered repository is resolved from its own cwd.
  const h = C.open(payload);
  if (!h && !found.some((f) => f.cd.length)) return null;
  const handleFor = G.makeHandleFor(payload, h);
  const byProject = new Map();
  for (const f of found) {
    const fh = handleFor(f);
    if (!fh) continue;
    if (!byProject.has(fh.pid)) byProject.set(fh.pid, { h: fh, found: [] });
    byProject.get(fh.pid).found.push(f);
  }
  const tuid = C.str(payload.tool_use_id);
  const reasons = [];
  let verdict = null; // 'ask' unless some project says block
  for (const g of byProject.values()) {
    const wanted = G.wantedGates(g.found);
    for (const m of G.forbidden(g.h, wanted)) {
      reasons.push(g.h.t('gate.neverBlock', { what: m.text, gate: m.gate, project: path.basename(g.h.root) }));
      verdict = 'block';
      try {
        events.append(g.h.pid, {
          type: 'gate.blocked', src: 'hook', session: g.h.sid, tool_use_id: tuid,
          data: { gate: m.gate, command: m.command, mode: 'never', tool_use_id: C.snippet(tuid, 80) || null, permission_mode: C.snippet(payload.permission_mode, 40) || null },
          key: `${tuid || Date.now()}:${m.gate}:never`,
        });
      } catch { /* ignore */ }
    }
    let enforce;
    try { enforce = gates.enforceOf(g.h.cfg()); } catch { continue; }
    if (enforce === 'remind') continue;
    for (const m of G.unapproved(g.h, wanted, { failClosed: enforce === 'block' })) {
      const vars = { what: m.text, gate: m.gate, project: path.basename(g.h.root), cmd: C.crewCmd() };
      // Codex cannot ask (an "ask" decision fails open there), so confirm is a deny with the way to approve.
      const denied = enforce === 'block' || codex;
      reasons.push(g.h.t(enforce === 'block' ? 'gate.block' : codex ? 'gate.codexConfirm' : 'gate.confirm', vars));
      verdict = denied || verdict === 'block' ? 'block' : 'ask';
      try {
        events.append(g.h.pid, {
          type: denied ? 'gate.blocked' : 'gate.prompted', src: 'hook', session: g.h.sid, tool_use_id: tuid,
          data: { gate: m.gate, command: m.command, mode: enforce, tool_use_id: C.snippet(tuid, 80) || null, permission_mode: C.snippet(payload.permission_mode, 40) || null },
          key: `${tuid || Date.now()}:${m.gate}:${enforce}`,
        });
      } catch { /* ignore */ }
    }
  }
  if (!reasons.length) return null;
  const text = reasons.join(' ');
  return verdict === 'block' || codex ? C.deny(text) : C.ask(text);
}

function run(payload) {
  const tool = C.str(payload.tool_name);
  if (C.AGENT_TOOLS.has(tool)) return onAgent(payload);
  if (tool === 'SendMessage') return onSend(payload);
  if (C.EDIT_TOOLS.has(tool)) return onEdit(payload);
  if (tool === 'Read') return onRead(payload);
  if (SHELL_TOOLS.has(tool)) return onBash(payload);
  return null;
}

module.exports = { run, exceeds };
