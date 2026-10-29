'use strict';

// Live session list: scans local Claude Code and Codex session logs, tail-reads only the last
// few KB of each recent file and derives a coarse status. Message text is never returned unless
// the caller asks for it (showText), and even then only a short redacted snippet.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { clean } = require('../lib/core/redact');

const MIN = 60 * 1000;
const DEFAULTS = {
  tailBytes: 64 * 1024,      // bytes read from the end of each file
  headBytes: 512 * 1024,     // upper bound when looking for the first line (Codex session_meta)
  windowMs: 24 * 60 * MIN,   // files older than this are not listed
  workMs: 3 * MIN,           // "working" needs activity this recent
  toolMs: 15 * MIN,          // a tool call may run longer than a model turn
  waitMs: 60 * MIN,          // "waiting for user" turns into "idle" after this
  doneMs: 6 * 60 * MIN,      // untouched this long: done
  maxFiles: 300,
  ttlMs: 1500,
};

function defaultRoots() {
  return {
    claudeRoot: process.env.AGENT_CREW_CLAUDE_ROOT || path.join(os.homedir(), '.claude', 'projects'),
    codexRoot: process.env.AGENT_CREW_CODEX_ROOT || path.join(os.homedir(), '.codex', 'sessions'),
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
const snippet = (text) => clean(String(text).replace(/\s+/g, ' ').trim(), 200);

// Claude Code transcript lines -> { state, cwd, model, subagent, lastTs, text }.
// state: 'tool' | 'working' | 'waiting' (before the age rules are applied)
function readClaude(objs) {
  const r = { state: null, cwd: null, model: null, subagent: false, lastTs: null, text: null };
  for (const o of objs) {
    if (isStr(o.cwd)) r.cwd = o.cwd;
    if (o.isSidechain === true) r.subagent = true;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const t = tsOf(o);
    if (t !== null) r.lastTs = t;
    const m = o.message || {};
    if (o.type === 'assistant') {
      if (isStr(m.model) && !m.model.startsWith('<')) r.model = m.model;
      const bs = blocks(m);
      if (bs.some((b) => b.type === 'tool_use')) r.state = 'tool';
      else if (['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(m.stop_reason)) r.state = 'waiting';
      else r.state = 'working';
      const tb = bs.filter((b) => b.type === 'text' && isStr(b.text)).pop();
      if (tb) r.text = tb.text;
    } else {
      // a prompt or a tool result: the model is expected to continue, unless the user interrupted
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      r.state = /\[Request interrupted by user/.test(raw) ? 'waiting' : 'working';
    }
  }
  return r;
}

// Codex rollout lines. `head` is the first line (session_meta) when available.
function readCodex(objs, head) {
  const r = { state: null, cwd: null, model: null, subagent: false, lastTs: null, text: null };
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
      if (p.type === 'task_started') st = 'working';
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        st = 'waiting';
        if (isStr(p.last_agent_message)) r.text = p.last_agent_message;
      }
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') st = 'tool';
      else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') st = 'working';
      else if (p.type === 'message' && p.role === 'assistant') st = 'working';
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
    }
    const info = { engine, state: r.state, cwd: r.cwd, model: r.model, subagent: r.subagent, lastTs: r.lastTs, text: r.text };
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

  // sessions({ showText, resolveProject, now }) -> rows, newest first. `cwd` is for server-side
  // use only; the API strips it.
  function sessions({ showText = false, resolveProject = null, now = Date.now() } = {}) {
    const out = [];
    for (const { file, engine, st } of scan(now)) {
      const info = inspectFile(file, engine, st);
      const lastMs = Math.max(info.lastTs || 0, st.mtimeMs);
      const row = {
        id: crypto.createHash('sha256').update(file).digest('hex').slice(0, 12),
        engine,
        status: statusOf(info.state, lastMs, now, o),
        lastActivity: new Date(lastMs).toISOString(),
        model: info.model,
        subagent: info.subagent,
        cwd: info.cwd,
        folder: info.cwd ? path.basename(info.cwd.replace(/[\\/]+$/, '')) : null,
        project: null,
      };
      if (resolveProject && info.cwd) {
        try { const p = resolveProject(info.cwd); if (p) row.project = p.id; } catch { /* unresolved */ }
      }
      if (showText === true && info.text) row.text = snippet(info.text);
      out.push(row);
    }
    return out;
  }

  return { sessions, options: o, claudeRoot: o.claudeRoot, codexRoot: o.codexRoot };
}

module.exports = { createWatcher, readClaude, readCodex, statusOf, tailObjects, DEFAULTS, walk, defaultRoots };
