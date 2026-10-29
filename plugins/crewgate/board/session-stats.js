'use strict';

// Per-session statistics (duration, prompts, tool calls, subagents, tokens, cost) for Claude Code and
// Codex transcripts. The 64 KB tail the watcher reads is not enough for totals, so each transcript is
// parsed once and then only its new bytes: the aggregates and the byte offset are kept per file in
// <home>/cache/sessions/<hash>.json. Only counters and model names are stored, never message text.
// Work per call is bounded (budgetBytes); a file that is still behind is reported with partial: true and
// continues on the next call.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../lib/core/paths');
const { costOf, priceFor } = require('./usage');
const { promptText } = require('./watcher');

const VERSION = 1;
const DEFAULTS = {
  budgetBytes: 8 * 1024 * 1024,   // bytes parsed per collect() call, across all files
  chunkBytes: 1024 * 1024,
  maxLineBytes: 64 * 1024 * 1024, // a longer line is skipped (never expected in practice)
  maxToolNames: 100,
  pruneAgeMs: 14 * 24 * 3600 * 1000,
};
const HEAD_BYTES = 256;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const isCodexSpawn = (name) => /(?:^|[._])spawn_agent$/.test(String(name));
const MSG_RE = /"type"\s*:\s*"(?:user|assistant)"/;
const TS_RE = /"timestamp":"([^"]{10,40})"/;

function blank(engine, file) {
  return {
    v: VERSION, engine, path: file, offset: 0, headLen: 0, headHash: '',
    firstTs: null, lastTs: null, prompts: 0, errors: 0, subagents: 0,
    tools: {}, models: {}, last: null, codexModel: 'codex', codexTotal: '',
  };
}

function bumpTs(s, t) {
  if (!Number.isFinite(t)) return;
  if (s.firstTs === null || t < s.firstTs) s.firstTs = t;
  if (s.lastTs === null || t > s.lastTs) s.lastTs = t;
}

function countTool(s, name, max) {
  const k = String(name || 'tool').slice(0, 60);
  if (Object.prototype.hasOwnProperty.call(s.tools, k) || Object.keys(s.tools).length < max) s.tools[k] = (s.tools[k] || 0) + 1;
  else s.tools.other = (s.tools.other || 0) + 1;
}

function addModel(s, model, r, sign) {
  const m = s.models[model] || (s.models[model] = { input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0 });
  m.input += sign * r.input;
  m.output += sign * r.output;
  m.cache_write += sign * r.cache_write;
  m.cache_read += sign * r.cache_read;
  m.messages += sign;
}

// ---- Claude: a message is logged once per content block, so repeats of the last message id replace
// the earlier usage (the one with the larger output wins) and do not count their tool calls twice.
function claudeStep(line, s, o) {
  if (!MSG_RE.test(line)) return;
  let x;
  try { x = JSON.parse(line); } catch { return; }
  if (!x || (x.type !== 'user' && x.type !== 'assistant')) return;
  bumpTs(s, Date.parse(x.timestamp));
  const m = x.message || {};
  if (x.type === 'user') {
    if (x.isSidechain !== true && promptText(x) !== null) s.prompts++;
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_result' && b.is_error === true) s.errors++;
    return;
  }
  const key = m.id || x.uuid || null;
  const same = !!(key && s.last && s.last.id === key);
  const seen = same ? new Set(s.last.tools) : new Set();
  const ids = same ? s.last.tools.slice() : [];
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (!b || b.type !== 'tool_use') continue;
    if (b.id && seen.has(b.id)) continue;
    if (b.id) { seen.add(b.id); ids.push(b.id); }
    countTool(s, b.name, o.maxToolNames);
    if (SUBAGENT_TOOLS.has(b.name)) s.subagents++;
  }
  const u = m.usage;
  const model = typeof m.model === 'string' && m.model && !m.model.startsWith('<') ? m.model : null;
  let usage = same ? s.last.u : null;
  if (u && typeof u === 'object' && model) {
    const rec = { model, input: num(u.input_tokens), output: num(u.output_tokens), cache_write: num(u.cache_creation_input_tokens), cache_read: num(u.cache_read_input_tokens) };
    if (!usage) { addModel(s, model, rec, 1); usage = rec; } else if (rec.output >= usage.output) {
      addModel(s, usage.model, usage, -1);
      addModel(s, model, rec, 1);
      usage = rec;
    }
  }
  s.last = key ? { id: key, tools: ids.slice(-50), u: usage } : null;
}

// ---- Codex: timestamps on every line; tokens from token_count events (a repeated total is skipped).
function codexStep(line, s, o) {
  const head = TS_RE.exec(line.length > 200 ? line.slice(0, 200) : line);
  if (head) bumpTs(s, Date.parse(head[1]));
  let kind = 0;
  if (line.includes('"turn_context"')) kind = 1;
  else if (line.includes('"function_call"') || line.includes('"custom_tool_call"')) kind = 2;
  else if (line.includes('"user_message"')) kind = 3;
  else if (line.includes('"token_count"')) kind = 4;
  else if (line.includes('"type":"error"')) kind = 5;
  if (!kind) return;
  let x;
  try { x = JSON.parse(line); } catch { return; }
  const p = (x && x.payload) || {};
  if (kind === 1 && x.type === 'turn_context' && isStr(p.model)) s.codexModel = p.model;
  else if (kind === 2 && x.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
    countTool(s, p.name, o.maxToolNames);
    if (isCodexSpawn(p.name)) s.subagents++;
  } else if (kind === 3 && x.type === 'event_msg' && p.type === 'user_message') s.prompts++;
  else if (kind === 5 && x.type === 'event_msg' && p.type === 'error') s.errors++;
  else if (kind === 4 && x.type === 'event_msg' && p.type === 'token_count') {
    const info = p.info || {};
    const u = info.last_token_usage;
    if (!u || typeof u !== 'object') return;
    const total = JSON.stringify(info.total_token_usage || null);
    if (total !== 'null' && total === s.codexTotal) return;
    s.codexTotal = total === 'null' ? '' : total;
    const cached = num(u.cached_input_tokens);
    addModel(s, s.codexModel, { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cache_write: 0, cache_read: cached }, 1);
  }
}

// Reads complete lines after `from`, stopping once `limit` bytes were read (a line already started is
// finished, so progress is guaranteed). Returns { offset, read }. A last line without a newline counts
// only when it already parses as JSON.
function readLines(file, from, size, limit, o, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let at = from;
    let carry = Buffer.alloc(0);
    let consumed = from;
    let read = 0;
    let progressed = false;
    const chunk = Buffer.alloc(o.chunkBytes);
    while (at < size && (read < limit || !progressed)) {
      const want = Math.min(o.chunkBytes, size - at);
      const n = fs.readSync(fd, chunk, 0, want, at);
      if (n <= 0) break;
      const base = at - carry.length;
      at += n;
      read += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0) break;
        onLine(buf.toString('utf8', start, nl));
        start = nl + 1;
        progressed = true;
      }
      consumed = base + start;
      carry = Buffer.from(buf.subarray(start));
      if (carry.length > o.maxLineBytes) { consumed = at; carry = Buffer.alloc(0); }   // absurd line: skip it
    }
    if (carry.length && at >= size) {
      const text = carry.toString('utf8');
      let ok = false;
      try { JSON.parse(text); ok = true; } catch { /* still being written */ }
      if (ok) { onLine(text); return { offset: at, read }; }
    }
    return { offset: consumed, read };
  } finally { fs.closeSync(fd); }
}

function headOf(file, len) {
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, n)).digest('hex');
  } finally { fs.closeSync(fd); }
}

function createSessionStats(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dir = opts.dir || path.join(paths.home(), 'cache', 'sessions');
  const mem = new Map();   // file -> { s, seen: 'size:mtime' | null }
  let pruned = false;
  let lastRead = 0;   // bytes parsed by the latest collect()

  const cacheFile = (file) => path.join(dir, `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 20)}.json`);

  function save(file, s) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = cacheFile(file);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, f);
    } catch { /* cache is best effort */ }
  }

  function load(file, engine) {
    try {
      const s = JSON.parse(fs.readFileSync(cacheFile(file), 'utf8'));
      if (s && s.v === VERSION && s.path === file && s.engine === engine && Number.isFinite(s.offset) && s.tools && s.models) return s;
    } catch { /* no usable cache */ }
    return null;
  }

  function prune() {
    pruned = true;
    try {
      const cut = Date.now() - o.pruneAgeMs;
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name);
        try { if (fs.statSync(f).mtimeMs < cut) fs.unlinkSync(f); } catch { /* ignore */ }
      }
    } catch { /* no cache dir yet */ }
  }

  // Does the cached state still describe the start of this file?
  function valid(file, s, size) {
    if (s.offset > size) return false;
    try { return headOf(file, s.headLen) === s.headHash; } catch { return false; }
  }

  // Brings one file's aggregates up to date within `budget.left` bytes.
  function advance(file, engine, st, budget) {
    let ent = mem.get(file);
    const seen = `${st.size}:${st.mtimeMs}`;
    if (!ent) { const s = load(file, engine); ent = { s: s || blank(engine, file), seen: null }; mem.set(file, ent); }
    if (ent.seen !== seen) {
      if (!valid(file, ent.s, st.size)) ent.s = blank(engine, file);   // truncated, replaced or rotated
      ent.seen = null;
    }
    const s = ent.s;
    if (s.offset < st.size && budget.left > 0) {
      const step = engine === 'codex' ? codexStep : claudeStep;
      let r;
      try { r = readLines(file, s.offset, st.size, budget.left, o, (line) => step(line, s, o)); } catch { return s; }
      budget.left -= r.read;
      budget.used += r.read;
      if (r.offset > s.offset) {
        s.offset = r.offset;
        s.headLen = Math.min(HEAD_BYTES, s.offset);
        try { s.headHash = headOf(file, s.headLen); } catch { s.headHash = ''; }
        save(file, s);
      }
    }
    if (s.offset >= st.size) ent.seen = seen;
    return s;
  }

  function shape(s, size, prices) {
    const tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    let cost = 0;
    let anyCost = false;
    let complete = true;
    for (const [model, t] of Object.entries(s.models)) {
      for (const k of Object.keys(tokens)) tokens[k] += t[k];
      const c = costOf(t, priceFor(model, prices || {}));
      if (c.cost !== null) { cost += c.cost; anyCost = true; if (!c.complete) complete = false; } else if (t.input + t.output + t.cache_write + t.cache_read > 0) complete = false;
    }
    const toolCalls = Object.values(s.tools).reduce((a, b) => a + b, 0);
    return {
      duration_ms: s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : 0,
      first_ts: s.firstTs, last_ts: s.lastTs,
      prompts: s.prompts, tool_calls: toolCalls, tools: { ...s.tools }, subagents: s.subagents, errors: s.errors,
      tokens, cost: anyCost ? Math.round(cost * 1e6) / 1e6 : null, cost_complete: anyCost && complete,
      partial: s.offset < size,
    };
  }

  // collect(entries, { prices }) -> Map(id -> stats). entries: [{ id, file, engine, size, mtimeMs }] in the
  // order they should be served (newest first): when the budget runs out the rest stay partial.
  function collect(entries, { prices = {} } = {}) {
    if (!pruned) prune();
    const budget = { left: o.budgetBytes, used: 0 };
    const out = new Map();
    for (const e of entries) {
      const s = advance(e.file, e.engine, { size: e.size, mtimeMs: e.mtimeMs }, budget);
      out.set(e.id, shape(s, e.size, prices));
    }
    lastRead = budget.used;
    return out;
  }

  return { collect, options: o, dir, get lastRead() { return lastRead; } };
}

// Sums the stats of several sessions (a parent and its subagents). Duration is the span of the whole group.
function sumStats(list) {
  const t = { duration_ms: 0, first_ts: null, last_ts: null, prompts: 0, tool_calls: 0, tools: {}, subagents: 0, errors: 0,
    tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost: null, cost_complete: true, partial: false };
  for (const s of list) {
    t.prompts += s.prompts; t.tool_calls += s.tool_calls; t.subagents += s.subagents; t.errors += s.errors;
    for (const [k, n] of Object.entries(s.tools)) t.tools[k] = (t.tools[k] || 0) + n;
    for (const k of Object.keys(t.tokens)) t.tokens[k] += s.tokens[k];
    if (s.cost !== null) t.cost = (t.cost || 0) + s.cost;
    if (!s.cost_complete) t.cost_complete = false;
    if (s.partial) t.partial = true;
    if (s.first_ts !== null && (t.first_ts === null || s.first_ts < t.first_ts)) t.first_ts = s.first_ts;
    if (s.last_ts !== null && (t.last_ts === null || s.last_ts > t.last_ts)) t.last_ts = s.last_ts;
  }
  if (t.first_ts !== null) t.duration_ms = t.last_ts - t.first_ts;
  if (t.cost !== null) t.cost = Math.round(t.cost * 1e6) / 1e6;
  return t;
}

// The tool table of a list payload: the busiest names, the rest folded into "other".
function topTools(tools, n = 12) {
  const e = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  if (e.length <= n) return Object.fromEntries(e);
  const out = Object.fromEntries(e.slice(0, n));
  out.other = (out.other || 0) + e.slice(n).reduce((a, b) => a + b[1], 0);
  return out;
}

module.exports = { createSessionStats, sumStats, topTools, DEFAULTS };
