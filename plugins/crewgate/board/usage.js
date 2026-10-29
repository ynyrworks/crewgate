'use strict';

// Token usage from local Claude Code / Codex logs. Only model names, counters and timestamps
// are kept; message text is parsed in memory and dropped at once. Logs are append-only, so each
// file is parsed incrementally: the cache keeps the parser state and the byte offset per file.
const fs = require('fs');
const path = require('path');
const { walk, defaultRoots } = require('./watcher');

const DAY_MS = 86400000;
const CHUNK = 4 * 1024 * 1024;
const p2 = (n) => String(n).padStart(2, '0');
const dayText = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) && v > 0 ? v : 0);

function localDay(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts).slice(0, 10) : dayText(d);
}

function windowDays(n, now = new Date()) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return days;
}

function family(model) {
  const m = model.toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku']) if (m.includes(f)) return f;
  if (m.includes('gpt') || m.includes('codex') || /^o\d/.test(m)) return 'openai';
  return 'other';
}

// Exact name first, then the longest price key that is contained in the model name.
function priceFor(model, prices) {
  if (Object.prototype.hasOwnProperty.call(prices, model)) return prices[model];
  let best = null;
  for (const k of Object.keys(prices)) {
    if (model.toLowerCase().includes(k.toLowerCase()) && (best === null || k.length > best.length)) best = k;
  }
  return best === null ? null : prices[best];
}

// -> { cost, complete }; cost is null when no usable price exists. Prices are per million tokens.
function costOf(t, price) {
  if (!price || typeof price !== 'object') return { cost: null, complete: false };
  const parts = [['input', t.input], ['output', t.output], ['cache_write', t.cache_write], ['cache_read', t.cache_read]];
  let cost = 0;
  let any = false;
  let complete = true;
  for (const [k, n] of parts) {
    if (isNum(price[k])) { cost += n * price[k] / 1e6; any = true; } else if (n > 0) complete = false;
  }
  return any ? { cost, complete } : { cost: null, complete: false };
}

// Calls onLine for every complete line after `from`; returns the new offset (just after the last
// newline). A trailing line without newline is consumed only if it already parses as JSON.
function readLines(file, from, size, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let at = from;
    let carry = Buffer.alloc(0);
    let consumed = from;
    const chunk = Buffer.alloc(CHUNK);
    while (at < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(CHUNK, size - at), at);
      if (n <= 0) break;
      const base = at - carry.length;
      at += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0) break;
        onLine(buf.toString('utf8', start, nl));
        start = nl + 1;
      }
      consumed = base + start;
      carry = Buffer.from(buf.subarray(start));
    }
    if (carry.length) {
      const text = carry.toString('utf8');
      let ok = false;
      try { JSON.parse(text); ok = true; } catch { /* still being written */ }
      if (ok) { onLine(text); return at; }
    }
    return consumed;
  } finally { fs.closeSync(fd); }
}

function createUsage(opts = {}) {
  const roots = { ...defaultRoots(), ...opts };
  const parsed = new Map();   // file -> { size, mtime, offset, state }

  function parseFile(file, st, makeState, step) {
    const hit = parsed.get(file);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.state;
    let state;
    let from;
    if (hit && st.size >= hit.offset) { state = hit.state; from = hit.offset; } else { state = makeState(file); from = 0; }
    const offset = readLines(file, from, st.size, (line) => step(line, state));
    parsed.set(file, { size: st.size, mtime: st.mtimeMs, offset, state });
    return state;
  }

  // ---- Claude: one record per assistant message id (the same message is logged once per block)
  const claudeInit = (file) => ({ msgs: new Map(), name: path.basename(file) });
  function claudeStep(line, state) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let x;
    try { x = JSON.parse(line); } catch { return; }
    if (!x || x.type !== 'assistant') return;
    const m = x.message || {};
    const u = m.usage;
    if (!u || typeof u !== 'object' || typeof m.model !== 'string' || !m.model || m.model.startsWith('<')) return;
    const key = m.id || x.uuid || `${state.name}:${state.msgs.size}`;
    const rec = { day: localDay(x.timestamp || ''), model: m.model, engine: 'claude', input: num(u.input_tokens), output: num(u.output_tokens),
      cache_write: num(u.cache_creation_input_tokens), cache_read: num(u.cache_read_input_tokens) };
    const have = state.msgs.get(key);
    if (!have || rec.output >= have.output) state.msgs.set(key, rec);
  }

  // ---- Codex: token_count events, the model comes from the latest turn_context
  const codexInit = () => ({ model: 'codex', recs: [] });
  function codexStep(line, state) {
    if (line.includes('"turn_context"')) {
      try { const x = JSON.parse(line); if (x.type === 'turn_context' && x.payload && typeof x.payload.model === 'string') state.model = x.payload.model; } catch { /* skip */ }
      return;
    }
    if (!line.includes('"token_count"')) return;
    let x;
    try { x = JSON.parse(line); } catch { return; }
    const p = (x && x.payload) || {};
    if (p.type !== 'token_count') return;
    const u = (p.info || {}).last_token_usage;
    if (!u || typeof u !== 'object' || !x.timestamp) return;
    const cached = num(u.cached_input_tokens);
    state.recs.push({ day: localDay(x.timestamp), model: state.model, engine: 'codex', input: Math.max(0, num(u.input_tokens) - cached),
      output: num(u.output_tokens), cache_write: 0, cache_read: cached });
  }

  function recent(root, cutMs) {
    const files = [];
    if (root) walk(root, files);
    const out = [];
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs >= cutMs) out.push({ file: f, st });
    }
    return out;
  }

  // report({ days, prices, now }) -> { days, models, daily, totals, cost_total, cost_partial, files }
  function report({ days = 14, prices = {}, now = new Date() } = {}) {
    const n = Math.max(1, Math.min(365, Math.floor(days) || 14));
    const dayList = windowDays(n, now);
    const inWindow = new Set(dayList);
    const cut = now.getTime() - (n + 1) * DAY_MS;
    const recs = [];
    let files = 0;
    const seen = new Map();   // Claude message key -> rec, so a copy in another file does not count twice
    for (const { file, st } of recent(roots.claudeRoot, cut)) {
      files++;
      for (const [k, v] of parseFile(file, st, claudeInit, claudeStep).msgs) {
        const have = seen.get(k);
        if (!have || v.output > have.output) seen.set(k, v);
      }
    }
    recs.push(...seen.values());
    for (const { file, st } of recent(roots.codexRoot, cut)) {
      files++;
      recs.push(...parseFile(file, st, codexInit, codexStep).recs);
    }
    const blank = () => ({ input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0 });
    const add = (t, r) => { t.input += r.input; t.output += r.output; t.cache_write += r.cache_write; t.cache_read += r.cache_read; t.messages++; };
    const perModel = new Map();
    const perDay = new Map(dayList.map((d) => [d, {}]));
    for (const r of recs) {
      if (!inWindow.has(r.day)) continue;
      if (!perModel.has(r.model)) perModel.set(r.model, { ...blank(), engine: r.engine });
      add(perModel.get(r.model), r);
      const fam = family(r.model);
      const row = perDay.get(r.day);
      add(row[fam] || (row[fam] = blank()), r);
    }
    const total = (t) => t.input + t.output + t.cache_write + t.cache_read;
    let sum = 0;
    let anyCost = false;
    const models = [...perModel.entries()].map(([model, t]) => {
      const c = costOf(t, priceFor(model, prices || {}));
      if (c.cost !== null) { sum += c.cost; anyCost = true; }
      return { model, engine: t.engine, family: family(model), ...t, total: total(t), cost: c.cost, cost_complete: c.complete };
    }).sort((a, b) => b.total - a.total);
    const daily = dayList.map((day) => {
      const families = {};
      for (const [f, t] of Object.entries(perDay.get(day))) families[f] = { ...t, total: total(t) };
      return { day, total: Object.values(families).reduce((s, x) => s + x.total, 0), families };
    });
    const totals = models.reduce((s, m) => { add(s, m); s.messages += m.messages - 1; return s; }, blank());
    return {
      days: dayList, models, daily, files,
      totals: { ...totals, total: total(totals) },
      cost_total: anyCost ? Math.round(sum * 1e6) / 1e6 : null,
      cost_partial: models.some((m) => m.cost !== null && !m.cost_complete),
    };
  }

  return { report };
}

module.exports = { createUsage, costOf, priceFor, family, localDay, windowDays };
