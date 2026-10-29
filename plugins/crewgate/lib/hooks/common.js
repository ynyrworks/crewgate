'use strict';

// Shared helpers for hook handlers. Handlers must never throw out of run(); crew-hook.js
// also guards, but each handler keeps its own failure modes quiet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const context = require('../core/context');
const config = require('../core/config');
const i18n = require('../core/i18n');
const paths = require('../core/paths');
const project = require('../core/project');
const { clean } = require('../core/redact');
const sess = require('./session');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const MAX_CONTEXT = 9000; // hook limit is 10,000 chars

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

// The tool name Claude Code uses to launch subagents (older builds: Task).
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function sessionKey(sid) {
  if (typeof sid !== 'string' || !sid) return null;
  if (paths.SAFE_ID_RE.test(sid)) return sid;
  return `x${crypto.createHash('sha256').update(sid).digest('hex').slice(0, 24)}`;
}

function within(dir, root) {
  try {
    const d = project.normalizePath(dir);
    const r = project.normalizePath(root);
    return d === r || d.startsWith(`${r}/`);
  } catch { return false; }
}

// Opens the hook handle for a payload, or returns null for an unregistered project.
// Fast path (no git): the session file written at SessionStart names the project, and cwd is
// inside its root. The fast path cannot tell main from linked worktree: pass { full: true }
// when that matters; { fastOnly: true } returns null instead of falling back to git.
function open(payload, opts = {}) {
  const p = obj(payload);
  const sid = sessionKey(p.session_id);
  const cwd = str(p.cwd) || process.cwd();
  let ctx = null;
  if (!opts.full && sid) {
    const s = sess.read(sid);
    if (s && s.project && s.root && within(cwd, s.root)) {
      ctx = {
        cwd, isSubagent: !!p.agent_id, isMainWorktree: null, projectRoot: s.root,
        projectId: s.project, registered: true, project: null, fast: true,
      };
    }
  }
  if (!ctx && opts.fastOnly) return null;
  if (!ctx) {
    ctx = context.resolve(p);
    if (!ctx.registered || !ctx.projectId || !ctx.projectRoot) return null;
  }
  let cfg = null;
  return {
    payload: p, ctx, sid, pid: ctx.projectId, root: ctx.projectRoot,
    cfg() {
      if (!cfg) { try { cfg = config.load(ctx.projectRoot).config; } catch { cfg = config.DEFAULTS; } }
      return cfg;
    },
    lang() { return this.cfg().language; },
    t(key, vars) { return i18n.t(this.lang(), `hooks.${key}`, vars); },
  };
}

function crewCmd() {
  const root = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;
  return `node "${path.join(root, 'bin', 'crew.js')}"`;
}

// One-line, redacted, truncated. Cuts the input first so a huge field stays cheap.
function snippet(text, n) {
  const s = str(text).slice(0, n * 4 + 200).replace(/\s+/g, ' ').trim();
  return clean(s, n);
}

// Context for the model (hookSpecificOutput.additionalContext). Use it only on events where the
// model reads it and nothing else happens: SessionStart, PreToolUse, PostToolUse. On Stop and
// SubagentStop additionalContext KEEPS THE TURN RUNNING (docs/PLUGIN-FACTS.md), so those use notice().
function withContext(event, text, extra) {
  if (!text) return extra || null;
  const out = { hookSpecificOutput: { hookEventName: event, additionalContext: String(text).slice(0, MAX_CONTEXT) } };
  return extra ? Object.assign(out, extra) : out;
}

// A message for the user only (top-level systemMessage); it never reaches the model and never
// continues a turn. Valid on every event.
function notice(text) {
  return text ? { systemMessage: String(text).slice(0, MAX_CONTEXT) } : null;
}

function deny(reason, extra) {
  return Object.assign({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(reason).slice(0, MAX_CONTEXT) },
  }, extra || {});
}

// Reads at most `bytes` from the start of a regular file; '' on any problem.
function readHead(file, bytes) {
  let fd;
  try {
    if (typeof file !== 'string' || !file) return '';
    if (!fs.statSync(file).isFile()) return '';
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

const normType = (t) => String(t || 'general-purpose').split(':').pop().toLowerCase();

module.exports = {
  PLUGIN_ROOT, AGENT_TOOLS, EDIT_TOOLS, obj, str, sessionKey, open, crewCmd, snippet,
  withContext, notice, deny, readHead, normType,
};
