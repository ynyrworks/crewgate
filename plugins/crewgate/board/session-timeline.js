'use strict';

// Activity timeline of one session: the latest actions (prompts, tool calls, subagent start/stop, errors,
// crewgate events) read BACKWARDS from the transcript by byte offsets, so a page costs the bytes it needs
// and "load more" continues where the last page stopped. Text appears only when the caller allows it
// (board.show_text): prompt snippets and tool targets, redacted like the live activity. Names, kinds,
// counts and times are always given.
const fs = require('fs');
const { promptText, toolArg, targetOf, codexArg, snippet } = require('./watcher');

const DEFAULTS = {
  limit: 200,
  maxLimit: 200,
  maxScanBytes: 8 * 1024 * 1024,   // bytes read per page (a page may hold fewer events than asked)
  chunkBytes: 256 * 1024,
  maxLineBytes: 8 * 1024 * 1024,
};
const KINDS = ['prompt', 'tool', 'subagent', 'crew', 'error'];
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const tsOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const MSG_RE = /"type"\s*:\s*"(?:user|assistant)"/;
const CODEX_RE = /"(?:user_message|function_call|custom_tool_call|function_call_output|custom_tool_call_output|error)"/;

// Lines of the file ending at `end`, last line first: onLine(text, offset) returns false to stop.
// Returns { scanned, reachedStart, lastOffset } (lastOffset = start of the last line handed out).
function backLines(file, end, o, onLine) {
  const fd = fs.openSync(file, 'r');
  let scanned = 0;
  let lastOffset = null;
  try {
    let pos = end;
    let tail = Buffer.alloc(0);   // start of a line whose beginning lies before `pos`
    while (pos > 0) {
      if (scanned >= o.maxScanBytes && lastOffset !== null) return { scanned, reachedStart: false, lastOffset };
      const start = Math.max(0, pos - o.chunkBytes);
      const part = Buffer.alloc(pos - start);
      const n = fs.readSync(fd, part, 0, part.length, start);
      scanned += n;
      const buf = tail.length ? Buffer.concat([part.subarray(0, n), tail]) : part.subarray(0, n);
      let hi = buf.length;
      while (hi > 0) {
        const nl = buf.lastIndexOf(10, hi - 1);
        if (nl < 0) break;
        const seg = buf.subarray(nl + 1, hi);
        const off = start + nl + 1;
        hi = nl;
        if (seg.length === 0) continue;
        lastOffset = off;
        if (seg.length <= o.maxLineBytes && onLine(seg.toString('utf8'), off) === false) return { scanned, reachedStart: false, lastOffset: off, stopped: true };
      }
      if (start === 0) {
        if (hi > 0) {
          lastOffset = 0;
          if (hi <= o.maxLineBytes && onLine(buf.subarray(0, hi).toString('utf8'), 0) === false) return { scanned, reachedStart: false, lastOffset: 0, stopped: true };
        }
        return { scanned, reachedStart: true, lastOffset };
      }
      tail = buf.subarray(0, hi);
      if (tail.length > o.maxLineBytes) { tail = Buffer.alloc(0); }   // absurd line: drop it
      pos = start;
    }
    return { scanned, reachedStart: true, lastOffset };
  } finally { fs.closeSync(fd); }
}

function claudeEvents(x, ctx) {
  const out = [];
  const ts = tsOf(x.timestamp);
  const m = x.message || {};
  if (x.type === 'user') {
    const pt = promptText(x);
    if (pt !== null) out.push({ kind: 'prompt', ts, ...(ctx.showText ? { text: snippet(pt) } : {}) });
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_result' || !isStr(b.tool_use_id)) continue;
        const tur = x.toolUseResult && typeof x.toolUseResult === 'object' ? x.toolUseResult : {};
        const agent = isStr(tur.agentId) ? tur.agentId : null;
        const launched = tur.isAsync === true || tur.status === 'async_launched';
        ctx.results.set(b.tool_use_id, { ts, err: b.is_error === true, agent });
        if (b.is_error === true) out.push({ kind: 'error', ts, ref: b.tool_use_id });
        if (agent && !launched) out.push({ kind: 'subagent', phase: 'stop', ts, ref: b.tool_use_id, agent: ctx.link(agent) });
      }
    }
    return out;
  }
  if (x.type !== 'assistant' || !Array.isArray(m.content)) return out;
  for (const b of m.content) {
    if (!b || b.type !== 'tool_use' || !isStr(b.name)) continue;
    const res = ctx.results.get(b.id) || null;
    const ev = { ts, ref: isStr(b.id) ? b.id : null };
    if (res && res.ts !== null && ts !== null && res.ts >= ts) ev.dur_ms = res.ts - ts;
    if (SUBAGENT_TOOLS.has(b.name)) {
      Object.assign(ev, { kind: 'subagent', phase: 'start', agent: res && res.agent ? ctx.link(res.agent) : null });
      const inp = b.input && typeof b.input === 'object' ? b.input : {};
      if (ctx.showText && isStr(inp.subagent_type)) ev.agent_type = inp.subagent_type.slice(0, 60);
      out.push(ev);
      continue;
    }
    Object.assign(ev, { kind: 'tool', tool: b.name.slice(0, 60) });
    if (res && res.err) ev.err = true;
    if (ctx.showText) { const tg = targetOf(toolArg(b.name, b.input), ctx.cwd); if (tg) ev.target = tg; }
    out.push(ev);
    if (isStr(b.id)) ctx.calls.set(b.id, ev.tool);
  }
  return out;
}

function codexEvents(x, ctx) {
  const out = [];
  const ts = tsOf(x.timestamp);
  const p = x.payload || {};
  if (x.type === 'event_msg') {
    if (p.type === 'user_message' && isStr(p.message)) out.push({ kind: 'prompt', ts, ...(ctx.showText ? { text: snippet(p.message) } : {}) });
    else if (p.type === 'error') out.push({ kind: 'error', ts });
    return out;
  }
  if (x.type !== 'response_item') return out;
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    if (isStr(p.call_id)) ctx.results.set(p.call_id, { ts, err: false, agent: null });
    return out;
  }
  if ((p.type === 'function_call' || p.type === 'custom_tool_call') && isStr(p.name)) {
    const res = ctx.results.get(p.call_id) || null;
    const ev = { ts, ref: isStr(p.call_id) ? p.call_id : null };
    if (res && res.ts !== null && ts !== null && res.ts >= ts) ev.dur_ms = res.ts - ts;
    if (/(?:^|[._])spawn_agent$/.test(p.name)) { out.push({ ...ev, kind: 'subagent', phase: 'start', agent: null }); return out; }
    Object.assign(ev, { kind: 'tool', tool: p.name.slice(0, 60) });
    if (ctx.showText) { const tg = targetOf(codexArg(p), ctx.cwd); if (tg) ev.target = tg; }
    out.push(ev);
  }
  return out;
}

// Crewgate events (already filtered to this session by the caller) as timeline events.
function crewEvent(e) {
  const ts = tsOf(e.ts);
  if (ts === null || typeof e.type !== 'string') return null;
  if (e.type === 'subagent.start' || e.type === 'subagent.stop') {
    return { kind: 'subagent', phase: e.type === 'subagent.start' ? 'start' : 'stop', ts, src: 'crew', agent_id: isStr(e.agent) ? e.agent : null, task: isStr(e.task) ? e.task : null };
  }
  return { kind: 'crew', ts, type: e.type.slice(0, 60), task: isStr(e.task) ? e.task : null };
}

// timeline({ file, engine, cwd, showText, before, beforeTs, limit, kinds, crewEvents, link }) ->
//   { events (oldest first), cursor, cursor_ts, scanned, truncated }
// `before` is a byte offset from an earlier answer's cursor; reading goes backwards from there.
// `link(agentId)` -> row id of that subagent's own session, or null.
function timeline(opts) {
  const o = { ...DEFAULTS, ...opts };
  const asked = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : DEFAULTS.limit;
  const limit = Math.min(o.maxLimit, asked);
  const kinds = new Set((Array.isArray(o.kinds) && o.kinds.length ? o.kinds : KINDS).filter((k) => KINDS.includes(k)));
  const size = fs.statSync(o.file).size;
  const end = Number.isInteger(o.before) && o.before >= 0 && o.before <= size ? o.before : size;
  const ctx = { showText: o.showText === true, cwd: o.cwd, results: new Map(), calls: new Map(), link: typeof o.link === 'function' ? o.link : () => null };
  const codex = o.engine === 'codex';
  const events = [];
  let oldestTs = null;
  const r = backLines(o.file, end, o, (text, off) => {
    if (!(codex ? CODEX_RE : MSG_RE).test(text)) return true;
    let x;
    try { x = JSON.parse(text); } catch { return true; }
    if (!x || typeof x !== 'object') return true;
    const ts = tsOf(x.timestamp);
    if (ts !== null && (oldestTs === null || ts < oldestTs)) oldestTs = ts;
    const evs = (codex ? codexEvents : claudeEvents)(x, ctx);
    for (let i = evs.length - 1; i >= 0; i--) {
      evs[i].key = `${off}:${i}`;
      if (kinds.has(evs[i].kind)) events.push(evs[i]);
    }
    return events.length < limit;
  });
  events.reverse();
  for (const ev of events) {
    if (ev.kind === 'error' && ev.ref && ctx.calls.has(ev.ref)) ev.tool = ctx.calls.get(ev.ref);
  }
  const more = !(r.reachedStart || r.lastOffset === 0);
  const cursor = more ? (r.lastOffset === null ? end : r.lastOffset) : null;
  // crewgate events inside the span this page covers
  if (kinds.has('crew') || kinds.has('subagent')) {
    const lo = more && oldestTs !== null ? oldestTs : 0;
    const hi = Number.isFinite(o.beforeTs) && end < size ? o.beforeTs : Infinity;
    const seenAgents = new Set(events.filter((e) => e.kind === 'subagent' && e.agent).map((e) => `${e.phase}:${e.agent}`));
    for (const ce of Array.isArray(o.crewEvents) ? o.crewEvents : []) {
      const ev = crewEvent(ce);
      if (!ev || ev.ts < lo || ev.ts >= hi || !kinds.has(ev.kind)) continue;
      if (ev.kind === 'subagent') {
        ev.agent = ev.agent_id ? ctx.link(ev.agent_id) : null;
        delete ev.agent_id;
        if (ev.agent && seenAgents.has(`${ev.phase}:${ev.agent}`)) continue;
      }
      ev.key = `c:${ev.ts}:${ev.kind}:${ev.type || ev.phase}:${ev.task || ''}:${ev.agent || ''}`;
      events.push(ev);
    }
    events.sort((a, b) => (a.ts === null ? -1 : b.ts === null ? 1 : a.ts - b.ts));
  }
  return { events, cursor, cursor_ts: more ? oldestTs : null, scanned: r.scanned, truncated: more && !r.stopped };
}

module.exports = { timeline, backLines, KINDS, DEFAULTS };
