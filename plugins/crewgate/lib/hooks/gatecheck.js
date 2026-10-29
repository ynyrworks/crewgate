'use strict';

// What PreToolUse(Bash) and PostToolUse(Bash) share for approval gates: which project a command acts on
// (cd / pushd / git -C), which gates it falls under, and whether this session holds an approval.
const path = require('path');
const C = require('./common');
const sess = require('./session');
const gates = require('../core/gates');

// Cheap pre-filter so ordinary Bash calls never pay for project resolution.
const GIT_WORDS = /\b(push|merge|create)\b/;

// Git-Bash style /c/work/x (and /cygdrive/c/...) -> C:/work/x; only on Windows, other words pass through.
function nativeDir(w) {
  if (process.platform !== 'win32') return w;
  const m = /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/.exec(w);
  return m ? `${m[1].toUpperCase()}:/${m[2] || ''}` : w;
}

// The directory a command's cd / git -C words lead to, starting at the session cwd; null for no words.
function targetDir(cwd, steps) {
  if (!steps || !steps.length) return null;
  let dir = cwd;
  for (const w of steps) dir = path.resolve(dir, nativeDir(w));
  return dir;
}

// handleFor(f) -> the hook handle of the project a detected command acts on: the session's own for a command
// without cd words, otherwise the project of the directory they lead to (null = outside every registered
// project, never registered here). Full resolution (no session-file shortcut): a registered repo nested
// inside the session repo is its own project.
function makeHandleFor(payload, h) {
  const sessionCwd = C.str(payload.cwd) || process.cwd();
  const handles = new Map();
  return (f) => {
    const dir = targetDir(sessionCwd, f.cd);
    if (!dir) return h;
    if (!handles.has(dir)) {
      let t = null;
      try { t = C.open({ ...payload, cwd: dir }, { full: true }); } catch { /* unusable directory */ }
      handles.set(dir, t);
    }
    return handles.get(dir);
  };
}

// Codex payloads carry turn_id; its PreToolUse is not known to honour "ask", so Codex stays on remind.
const isCodex = (payload) => typeof payload.turn_id === 'string' && payload.turn_id !== '';

// The gates a set of detected commands falls under -> Map gate -> display text of the first command.
function wantedGates(found) {
  const wanted = new Map();
  for (const f of found) {
    const gate = gates.gateOf(f);
    if (!gate || wanted.has(gate)) continue;
    const d = f.data || {};
    const words = [d.remote, ...(Array.isArray(d.refs) ? d.refs : []), ...(Array.isArray(d.branches) ? d.branches : []), d.head && `--head ${d.head}`]
      .filter((x) => typeof x === 'string' && x).join(' ');
    wanted.set(gate, { command: d.command, text: C.snippet(words ? `${d.command} ${words}` : d.command, 120) });
  }
  return wanted;
}

// Gates of `wanted` that are set to ask and have no usable approval from this session:
// [{ gate, command, text }]. Cannot tell (config or events unreadable) = nothing missing.
function unapproved(h, wanted) {
  const out = [];
  let cfg;
  try { cfg = h.cfg(); } catch { return out; }
  const opts = { requireUserTurn: gates.requiresUserTurn(cfg) };
  if (opts.requireUserTurn) {
    const s = h.sid ? sess.read(h.sid) : null;
    opts.prompts = s && Array.isArray(s.prompt_ts) ? s.prompt_ts : [];
  }
  for (const [gate, w] of wanted) {
    if (gates.modeOf(cfg, gate) !== 'ask') continue;
    let approved = true;
    try { approved = gates.hasApproval(h.pid, gate, h.sid, Date.now(), opts); } catch { /* cannot tell: stay quiet */ }
    if (!approved) out.push({ gate, ...w });
  }
  return out;
}

module.exports = { GIT_WORDS, targetDir, makeHandleFor, isCodex, wantedGates, unapproved };
