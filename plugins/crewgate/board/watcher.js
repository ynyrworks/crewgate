'use strict';

// Live session list: scans local Claude Code and Codex session logs, tail-reads only the last
// few KB of each recent file and derives a coarse status. Message text is never returned unless
// the caller asks for it (showText), and even then only a short redacted snippet.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { clean } = require('../lib/core/redact');
const { createGitInfo } = require('./gitinfo');

const MIN = 60 * 1000;
const DEFAULTS = {
  tailBytes: 64 * 1024,      // bytes read from the end of each file
  headBytes: 512 * 1024,     // upper bound when looking for the first line (Codex session_meta)
  windowMs: 24 * 60 * MIN,   // files older than this are not listed
  workMs: 3 * MIN,           // "working" needs activity this recent
  toolMs: 15 * MIN,          // a tool call may run longer than a model turn
  waitMs: 30 * MIN,          // "waiting for user" turns into "idle" after this (board.session_idle_minutes)
  doneMs: 6 * 60 * MIN,      // untouched this long: done (board.session_done_hours)
  closedMs: 3 * MIN,         // a closing record counts only after this much quiet (a prompt may follow it)
  maxFiles: 300,
  ttlMs: 1500,
};

function defaultRoots() {
  return {
    claudeRoot: process.env.CREWGATE_CLAUDE_ROOT || path.join(os.homedir(), '.claude', 'projects'),
    codexRoot: process.env.CREWGATE_CODEX_ROOT || path.join(os.homedir(), '.codex', 'sessions'),
  };
}

function walk(dir, out, depth = 0) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(f);
  }
}

// Reads the last `bytes` of a file as JSON lines. A first partial line is dropped when the read
// does not start at offset 0; lines that are not valid JSON (e.g. a half-written last line) are skipped.
function tailObjects(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return [];
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    text = buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch { /* partial line */ }
  }
  return out;
}

// First complete line (reading at most maxBytes) parsed as JSON, or null.
function firstObject(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    let acc = Buffer.alloc(0);
    let pos = 0;
    while (acc.length < maxBytes) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      acc = Buffer.concat([acc, chunk.subarray(0, n)]);
      const nl = acc.indexOf(10);
      if (nl >= 0) { acc = acc.subarray(0, nl); break; }
    }
    return JSON.parse(acc.toString('utf8'));
  } catch { return null; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const tsOf = (o) => { const t = Date.parse(o && o.timestamp); return Number.isFinite(t) ? t : null; };
const blocks = (msg) => (msg && Array.isArray(msg.content) ? msg.content.filter((b) => b && typeof b === 'object') : []);
const SNIPPET_MAX = 160;
const TARGET_MAX = 60;
const snippet = (text) => clean(String(text).replace(/\s+/g, ' ').trim(), SNIPPET_MAX);
const hashId = (file) => crypto.createHash('sha256').update(file).digest('hex').slice(0, 12);

// ---- what a tool call is working on. toolArg keeps the raw argument (short); targetOf turns it
// into the redacted label shown on the board.
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);   // the model is asking the user
const PATH_ARG = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
function toolArg(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = (k, key) => (isStr(i[key]) ? { k, v: i[key].slice(0, 300) } : null);
  if (PATH_ARG[name]) return pick('path', PATH_ARG[name]);
  if (name === 'Bash' || name === 'PowerShell') return pick('cmd', 'command');
  if (name === 'Agent' || name === 'Task') return pick('type', 'subagent_type');
  if (name === 'Grep' || name === 'Glob') return pick('pat', 'pattern');
  return null;
}
function targetOf(arg, cwd) {
  if (!arg) return null;
  let out;
  if (arg.k === 'path') {
    let p = arg.v.replace(/\\/g, '/');
    const c = isStr(cwd) ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (c && p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) p = p.slice(c.length + 1);
    out = clean(p, 400);
    if (out.length > TARGET_MAX) out = `…${out.slice(-(TARGET_MAX - 1))}`;
  } else if (arg.k === 'cmd') {
    const words = arg.v.split('\n')[0].trim().split(/\s+/).filter(Boolean);
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();   // leading VAR=value
    out = clean(words.slice(0, 2).join(' '), TARGET_MAX);
  } else {
    out = clean(arg.v.replace(/\s+/g, ' ').trim(), TARGET_MAX);
  }
  return out || null;
}

// Text of a user message that is a real prompt (not a tool result, not a system wrapper).
function promptText(o) {
  const m = o.message || {};
  if (o.isMeta === true) return null;
  let t = null;
  if (typeof m.content === 'string') t = m.content;
  else {
    const bs = blocks(m);
    if (bs.some((b) => b.type === 'tool_result')) return null;
    const tb = bs.find((b) => b.type === 'text' && isStr(b.text));
    t = tb ? tb.text : null;
  }
  if (!isStr(t) || t.trimStart().startsWith('<')) return null;
  return t;
}

const ROLE_BY_TYPE = { 'crew-worker': 'worker', worker: 'worker', 'crew-reviewer': 'reviewer', reviewer: 'reviewer', 'crew-refuter': 'refuter', refuter: 'refuter' };
// agent type (with or without the plugin prefix) -> worker | reviewer | refuter | other
function roleOf(type) {
  const t = String(type || '').split(':').pop().toLowerCase();
  return ROLE_BY_TYPE[t] || 'other';
}

// Records Claude Code appends around a session's close. `last-prompt` is the marker; the rest are
// bookkeeping lines that may follow it. Anything else after it (a message) means the session went on.
const META_TYPES = new Set(['last-prompt', 'cost-state', 'ai-title', 'custom-title', 'agent-name', 'mode', 'atis', 'atis-latch', 'permission-mode', 'file-history-snapshot']);
function closedTail(objs) {
  let seen = false;
  for (let i = objs.length - 1; i >= 0; i--) {
    const t = objs[i].type;
    if (t === 'last-prompt') seen = true;
    else if (!META_TYPES.has(t)) return seen;
  }
  return seen;
}

// Claude Code transcript lines -> { state, cwd, model, subagent, lastTs, text }.
// state: 'tool' | 'working' | 'waiting' (before the age rules are applied)
function readClaude(objs) {
  const r = { state: null, cwd: null, model: null, subagent: false, lastTs: null, text: null, closed: closedTail(objs), sessionId: null, act: null, prompt: null, agentId: null, gitBranch: null };
  const titles = {};
  for (const o of objs) {
    if (isStr(o.cwd)) r.cwd = o.cwd;
    if (isStr(o.sessionId)) r.sessionId = o.sessionId;
    if (isStr(o.agentId)) r.agentId = o.agentId;
    if (isStr(o.gitBranch)) r.gitBranch = o.gitBranch;
    if (o.isSidechain === true) r.subagent = true;
    if (o.type === 'last-prompt' && isStr(o.lastPrompt)) r.prompt = o.lastPrompt;
    else if (o.type === 'custom-title' && isStr(o.customTitle)) titles.custom = o.customTitle;
    else if (o.type === 'ai-title' && isStr(o.aiTitle)) titles.ai = o.aiTitle;
    else if (o.type === 'summary' && isStr(o.summary)) titles.summary = o.summary;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const t = tsOf(o);
    if (t !== null) r.lastTs = t;
    const m = o.message || {};
    if (o.type === 'assistant') {
      if (isStr(m.model) && !m.model.startsWith('<')) r.model = m.model;
      const bs = blocks(m);
      const tu = bs.filter((b) => b.type === 'tool_use').pop();
      if (tu) r.state = 'tool';
      else if (['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(m.stop_reason)) r.state = 'waiting';
      else r.state = 'working';
      if (tu) r.act = WAIT_TOOLS.has(tu.name) ? { kind: 'waiting', tool: tu.name } : { kind: 'tool', tool: tu.name || 'tool', arg: toolArg(tu.name, tu.input) };
      else if (r.state === 'waiting') r.act = { kind: 'waiting' };
      else r.act = { kind: bs.length && bs[bs.length - 1].type === 'text' ? 'writing' : 'thinking' };
      const tb = bs.filter((b) => b.type === 'text' && isStr(b.text)).pop();
      if (tb) r.text = tb.text;
    } else {
      // a prompt or a tool result: the model is expected to continue, unless the user interrupted
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      r.state = /\[Request interrupted by user/.test(raw) ? 'waiting' : 'working';
      r.act = { kind: r.state === 'waiting' ? 'waiting' : 'thinking' };
      const pt = promptText(o);
      if (pt) r.prompt = pt;
    }
  }
  r.title = titles.custom || titles.ai || titles.summary || null;
  return r;
}

// The command of a Codex shell-like call (arguments is a JSON string with "command").
function codexArg(p) {
  if (!isStr(p.arguments)) return null;
  let a;
  try { a = JSON.parse(p.arguments); } catch { return null; }
  let c = a && (a.command !== undefined ? a.command : a.cmd);
  if (Array.isArray(c)) c = c.length >= 3 && /^(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i.test(String(c[0])) ? c[c.length - 1] : c.join(' ');
  return isStr(c) ? { k: 'cmd', v: c.slice(0, 300) } : null;
}

// Codex rollout lines. `head` is the first line (session_meta) when available.
function readCodex(objs, head) {
  const r = { state: null, cwd: null, model: null, subagent: false, lastTs: null, text: null, act: null, prompt: null };
  const meta = head && head.type === 'session_meta' ? head.payload || {} : {};
  if (isStr(meta.cwd)) r.cwd = meta.cwd;
  if (meta.source && typeof meta.source === 'object') r.subagent = true;
  for (const o of objs) {
    const p = o.payload || {};
    if (o.type === 'turn_context') {
      if (isStr(p.cwd)) r.cwd = p.cwd;
      if (isStr(p.model)) r.model = p.model;
      continue;
    }
    let st = null;
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') { st = 'working'; r.act = { kind: 'thinking' }; }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        st = 'waiting';
        r.act = { kind: 'waiting' };
        if (isStr(p.last_agent_message)) r.text = p.last_agent_message;
      } else if (p.type === 'user_message' && isStr(p.message)) r.prompt = p.message;
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        st = 'tool';
        r.act = { kind: 'tool', tool: isStr(p.name) ? p.name : 'tool', arg: codexArg(p) };
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') { st = 'working'; r.act = { kind: 'thinking' }; }
      else if (p.type === 'message' && p.role === 'assistant') { st = 'working'; r.act = { kind: 'writing' }; }
      else if (p.type === 'reasoning') r.act = { kind: 'thinking' };
    }
    if (st) {
      r.state = st;
      const t = tsOf(o);
      if (t !== null) r.lastTs = t;
    }
  }
  return r;
}

// Applies the age rules (all times in ms).
function statusOf(state, lastMs, now, o) {
  const age = now - lastMs;
  if (age > o.doneMs) return 'done';
  if (state === 'tool') return age <= o.toolMs ? 'tool' : 'idle';
  if (state === 'waiting') return age <= o.waitMs ? 'waiting' : 'idle';
  return age <= o.workMs ? 'working' : 'idle';   // 'working', or nothing readable: go by the file time
}

function createWatcher(opts = {}) {
  const o = { ...DEFAULTS, ...defaultRoots(), ...opts };
  let cache = null;
  const perFile = new Map();   // file -> { key, info }
  const git = o.gitInfo || createGitInfo();

  function inspectFile(file, engine, st) {
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = perFile.get(file);
    if (hit && hit.key === key) return hit.info;
    let objs = [];
    try { objs = tailObjects(file, st.size, o.tailBytes); } catch { /* unreadable */ }
    let r;
    if (engine === 'codex') {
      r = readCodex(objs, firstObject(file, o.headBytes));
    } else {
      r = readClaude(objs);
      if (!r.cwd) { const first = firstObject(file, o.headBytes); if (first && isStr(first.cwd)) r.cwd = first.cwd; }
      if (!r.subagent && /[\\/]subagents[\\/]/.test(file)) r.subagent = true;
      // <session id>.jsonl, or <session id>/subagents/<agent>.jsonl (the subagent belongs to that session)
      const sub = /([^\\/]+)[\\/]subagents[\\/][^\\/]+$/.exec(file);
      r.sessionId = sub ? sub[1] : path.basename(file, '.jsonl');
      const fileAgent = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/.exec(file);
      if (fileAgent) r.agentId = fileAgent[1];
      // <root>/<project>/<session>/subagents/<agent>.jsonl belongs to <root>/<project>/<session>.jsonl
      if (sub) r.parentFile = path.join(path.dirname(path.dirname(path.dirname(file))), `${sub[1]}.jsonl`);
    }
    const info = {
      engine, state: r.state, cwd: r.cwd, model: r.model, subagent: r.subagent, lastTs: r.lastTs, text: r.text, closed: !!r.closed,
      sessionId: r.sessionId || null, act: r.act || null, prompt: r.prompt || null, title: r.title || null,
      agentId: r.agentId || null, gitBranch: r.gitBranch || null, parentFile: r.parentFile || null,
    };
    perFile.set(file, { key, info });
    return info;
  }

  function scan(now) {
    if (cache && now >= cache.at && now - cache.at <= o.ttlMs) return cache.rows;
    const files = [];
    if (o.claudeRoot) { const l = []; walk(o.claudeRoot, l); for (const f of l) files.push([f, 'claude']); }
    if (o.codexRoot) { const l = []; walk(o.codexRoot, l); for (const f of l) files.push([f, 'codex']); }
    const rows = [];
    for (const [file, engine] of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > o.windowMs) continue;
      rows.push({ file, engine, st });
    }
    rows.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    cache = { at: now, rows: rows.slice(0, o.maxFiles) };
    const live = new Set(cache.rows.map((r) => r.file));
    for (const k of perFile.keys()) if (!live.has(k)) perFile.delete(k);
    return cache.rows;
  }

  // sessions({ showText, resolveProject, now, idleMs, doneMs }) -> rows, newest first. `cwd` is for
  // server-side use only; the API strips it. idleMs / doneMs come from board.session_idle_minutes /
  // board.session_done_hours. A session is done when crewgate recorded its end (newer than its last
  // message), when (detectClosed, off by default) its transcript ends in a closing record, or after doneMs of silence; a subagent
  // follows its parent session.
  // What the session is doing now, from its status and the last record. The tool name is always
  // given; the target (file, command, pattern) only when text is enabled.
  function activityOf(status, info, showText) {
    if (status === 'done' || status === 'idle' || status === 'waiting') return { kind: status };
    const a = info.act;
    if (!a) return { kind: 'thinking' };
    if (a.kind === 'tool') {
      const out = { kind: 'tool', tool: String(a.tool).slice(0, 60) };
      if (showText === true) { const t = targetOf(a.arg, info.cwd); if (t) out.target = t; }
      return out;
    }
    return { kind: a.kind === 'writing' ? 'writing' : 'thinking' };
  }

  // Role and task from the crewgate event index (registered projects only).
  function linkCrew(row, info) {
    const idx = o.sessionEnds;
    if (row.engine !== 'claude' || !idx || typeof idx.agent !== 'function') return;
    if (row.subagent) {
      const rec = info.agentId ? idx.agent(info.agentId) : null;
      row.role = roleOf(rec && rec.type);
      if (rec && rec.type) row.agent_type = String(rec.type).split(':').pop().slice(0, 60);
      if (rec && rec.task) row.task = { id: rec.task, title: null };
    } else if (info.sessionId && idx.dispatched(info.sessionId)) {
      row.role = 'orchestrator';
    }
  }

  function sessions({ showText = false, resolveProject = null, now = Date.now(), idleMs, doneMs, detectClosed = false } = {}) {
    const lim = { ...o };
    if (Number.isFinite(idleMs) && idleMs > 0) lim.waitMs = idleMs;
    if (Number.isFinite(doneMs) && doneMs > 0) lim.doneMs = doneMs;
    if (o.sessionEnds) { try { o.sessionEnds.refresh(); } catch { /* best effort */ } }
    const out = [];
    const doneIds = new Set();   // ids of finished top-level sessions
    for (const { file, engine, st } of scan(now)) {
      const info = inspectFile(file, engine, st);
      const lastMs = Math.max(info.lastTs || 0, st.mtimeMs);
      let status = statusOf(info.state, lastMs, now, lim);
      if (engine === 'claude' && info.sessionId) {
        const endedAt = o.sessionEnds ? o.sessionEnds.get(info.sessionId) : null;
        const ended = endedAt !== null && endedAt >= (info.lastTs || st.mtimeMs);
        const closed = detectClosed === true && info.closed && !info.subagent && now - st.mtimeMs > lim.closedMs;
        if (ended || closed) status = 'done';
        if (status === 'done' && !info.subagent) doneIds.add(info.sessionId);
      }
      // the model asked the user a question / for plan approval: it is waiting even though the last line is a tool call
      if (info.act && info.act.kind === 'waiting' && (status === 'tool' || status === 'working')) status = 'waiting';
      const row = {
        id: hashId(file),
        engine,
        status,
        activity: activityOf(status, info, showText),
        lastActivity: new Date(lastMs).toISOString(),
        model: info.model,
        subagent: info.subagent,
        session: info.sessionId,
        parent: info.parentFile ? hashId(info.parentFile) : null,
        role: null,
        task: null,
        cwd: info.cwd,
        folder: info.cwd ? path.basename(info.cwd.replace(/[\/]+$/, '')) : null,
        project: null,
        branch: null,
        detached: false,
        worktree: null,
      };
      linkCrew(row, info);
      const g = info.cwd ? git.get(info.cwd, now) : null;
      if (g) { row.branch = g.branch; row.detached = g.detached; row.worktree = g.worktree; }
      else if (info.gitBranch) row.branch = info.gitBranch;
      if (resolveProject && info.cwd) {
        try { const p = resolveProject(info.cwd); if (p) row.project = p.id; } catch { /* unresolved */ }
      }
      if (showText === true) {
        if (info.text) row.last_reply = snippet(info.text);
        if (info.prompt) row.last_prompt = snippet(info.prompt);
        if (info.title) row.title = snippet(info.title);
      }
      out.push({ row, info });
    }
    // a subagent takes its parent's state: the parent may have ended after the subagent's last line
    for (const { row, info } of out) {
      if (!row.subagent || row.engine !== 'claude' || !info.sessionId) continue;
      if (doneIds.has(info.sessionId)) { row.status = 'done'; continue; }
      const endedAt = o.sessionEnds ? o.sessionEnds.get(info.sessionId) : null;
      if (endedAt !== null && endedAt >= (info.lastTs || 0)) row.status = 'done';
    }
    return out.map((x) => x.row);
  }

  return { sessions, options: o, claudeRoot: o.claudeRoot, codexRoot: o.codexRoot };
}

module.exports = { createWatcher, readClaude, readCodex, statusOf, targetOf, toolArg, roleOf, tailObjects, DEFAULTS, walk, defaultRoots };
