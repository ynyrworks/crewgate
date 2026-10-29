'use strict';

// Lessons (.crew/LESSONS.md) and promoted rules (marked block in the rules file), DESIGN section 12.
const fs = require('fs');
const path = require('path');
const json = require('../core/json');
const events = require('../core/events');
const { clean, redact } = require('../core/redact');
const { CrewError } = require('../core/errors');
const common = require('./common');

const START = '<!-- agent-crew:rules:start -->';
const END = '<!-- agent-crew:rules:end -->';
const KINDS = ['correction', 'send-back', 'dismissal', 'takeover'];
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LINE_RE = /^- (\d{4}-\d{2}-\d{2}) \[([a-z-]+)\] ([a-z0-9][a-z0-9-]*): (.*)$/;
const RULE_RE = /^- (.*) \(source: ([a-z0-9][a-z0-9-]*), (\d{4}-\d{2}-\d{2})[–-](\d{4}-\d{2}-\d{2})\)\s*$/;
const DASH = '–';

const lessonsFile = (root) => path.join(root, '.crew', 'LESSONS.md');
const HEADER = '# Lessons\n\nOne line per lesson: `- YYYY-MM-DD [kind] key: text`. Managed by `crew lesson`.\n\n';

function readEntries(root) {
  let raw = '';
  try { raw = fs.readFileSync(lessonsFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m) out.push({ date: m[1], kind: m[2], key: m[3], text: m[4] });
  }
  return out;
}

function appendLine(root, line) {
  const file = lessonsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = HEADER; }
  if (cur && !cur.endsWith('\n')) cur += '\n';
  json.saveRaw(file, `${cur}${line}\n`);
}

// Appends one lesson line (creating the file with a header when absent) -> entry.
function add(root, projectId, { key, text, kind = 'correction', date }, opts = {}) {
  if (!KEY_RE.test(String(key || ''))) throw new CrewError('wf.lesson.badKey', { key: String(key) });
  if (!KINDS.includes(kind)) throw new CrewError('wf.lesson.badKind', { kind: String(kind), kinds: KINDS.join(', ') });
  const body = clean(String(text || '').replace(/\s+/g, ' ').trim(), 500);
  if (!body) throw new CrewError('wf.lesson.noText');
  const entry = { date: date || common.today(), kind, key, text: body };
  appendLine(root, `- ${entry.date} [${kind}] ${key}: ${body}`);
  if (projectId) {
    events.append(projectId, {
      type: 'lesson.added', src: opts.src || 'cli', data: { key, kind, text: body },
      key: `${key}:${entry.date}:${body}:${Date.now()}`,
    });
  }
  return entry;
}

// Per key: { key, kinds, days, count, first, last, retired, last_text }
function summarize(entries) {
  const m = new Map();
  for (const e of entries) {
    let s = m.get(e.key);
    if (!s) {
      s = { key: e.key, kinds: [], dates: new Set(), count: 0, first: e.date, last: e.date, retiredAt: '', lastLesson: '', last_text: '' };
      m.set(e.key, s);
    }
    if (e.kind === 'retired') { if (e.date > s.retiredAt) s.retiredAt = e.date; continue; }
    s.count++;
    s.dates.add(e.date);
    if (!s.kinds.includes(e.kind)) s.kinds.push(e.kind);
    if (s.count === 1 || e.date < s.first) s.first = e.date;
    if (s.count === 1 || e.date >= s.last) { s.last = e.date; s.last_text = e.text; }
    if (e.date > s.lastLesson) s.lastLesson = e.date;
  }
  return [...m.values()].map((s) => ({
    key: s.key, kinds: s.kinds, days: s.dates.size, count: s.count, first: s.first, last: s.last,
    retired: !!s.retiredAt && s.retiredAt >= s.lastLesson, last_text: s.last_text,
  }));
}

// ---------------------------------------------------------------- rules block
function eolOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

// -> { found, before, inner, after }. Throws wf.lesson.badMarkers for a lone, reversed or repeated marker.
function splitBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 && b < 0) return { found: false, before: text, inner: '', after: '' };
  if (a < 0 || b < 0 || b < a || text.indexOf(START, a + 1) >= 0 || text.indexOf(END, b + 1) >= 0) throw new CrewError('wf.lesson.badMarkers');
  return { found: true, before: text.slice(0, a + START.length), inner: text.slice(a + START.length, b), after: text.slice(b) };
}

function parseRules(inner) {
  const rules = [];
  for (const line of inner.split(/\r?\n/)) {
    const m = RULE_RE.exec(line);
    if (m) rules.push({ line: line.trimEnd(), rule: m[1], key: m[2], first: m[3], last: m[4] });
    else if (/^- /.test(line)) rules.push({ line: line.trimEnd(), rule: line.slice(2), key: '', first: '', last: '' });
  }
  return rules;
}

function rulesPath(root, cfg) { return path.resolve(root, cfg.lessons.rules_file || 'CLAUDE.md'); }

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

function readRules(root, cfg) {
  try { return parseRules(splitBlock(readText(rulesPath(root, cfg))).inner); } catch { return []; }
}

// Rewrites only the text between the markers (adds the block at the end when there is none).
function writeBlock(file, text, rules) {
  const eol = eolOf(text);
  const sp = splitBlock(text);
  const inner = `${eol}${rules.map((r) => r.line).join(eol)}${rules.length ? eol : ''}`;
  if (sp.found) return json.saveRaw(file, sp.before + inner + sp.after);
  const lead = text && !text.endsWith('\n') ? eol : '';
  const gap = text ? eol : '';
  return json.saveRaw(file, `${text}${lead}${gap}${START}${inner}${END}${eol}`);
}

// Candidates: keys seen on >= promote_after_days distinct days, not promoted, not retired.
function suggest(root, cfg) {
  const promoted = new Set(readRules(root, cfg).map((r) => r.key));
  return summarize(readEntries(root))
    .filter((s) => s.count > 0 && s.days >= cfg.lessons.promote_after_days && !promoted.has(s.key) && !s.retired);
}

// Oldest rule by last citation; ties go to the least cited.
function oldestRule(rules, stats) {
  const byKey = new Map(stats.map((s) => [s.key, s]));
  const rank = (r) => {
    const s = byKey.get(r.key);
    return { last: s && s.count ? s.last : r.last, count: s ? s.count : 0 };
  };
  return [...rules].sort((x, y) => {
    const a = rank(x);
    const b = rank(y);
    return a.last < b.last ? -1 : a.last > b.last ? 1 : a.count - b.count;
  })[0];
}

function promote(root, projectId, cfg, key, rule, opts = {}) {
  const stats = summarize(readEntries(root));
  const st = stats.find((s) => s.key === key && s.count > 0);
  if (!st) throw new CrewError('wf.lesson.unknownKey', { key });
  const text = String(rule || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new CrewError('wf.lesson.noRule');
  const file = rulesPath(root, cfg);
  const cur = readText(file);
  const rules = parseRules(splitBlock(cur).inner);
  if (rules.some((r) => r.key === key)) throw new CrewError('wf.lesson.alreadyPromoted', { key });
  const cap = cfg.lessons.rules_cap;
  if (rules.length >= cap) {
    const old = oldestRule(rules, stats);
    throw new CrewError('wf.lesson.capReached', { cap, key: old.key || '-', rule: old.rule.slice(0, 80) });
  }
  const safe = redact(text);
  rules.push({ line: `- ${safe} (source: ${key}, ${st.first}${DASH}${st.last})`, rule: safe, key, first: st.first, last: st.last });
  writeBlock(file, cur, rules);
  if (projectId) events.append(projectId, { type: 'lesson.promoted', src: opts.src || 'cli', data: { key, rule: safe }, key: `${key}:${Date.now()}` });
  return { key, rule: safe, file, count: rules.length };
}

function retire(root, projectId, cfg, key, opts = {}) {
  const file = rulesPath(root, cfg);
  const cur = readText(file);
  const rules = parseRules(splitBlock(cur).inner);
  const i = rules.findIndex((r) => r.key === key);
  if (i < 0) throw new CrewError('wf.lesson.notPromoted', { key });
  const [gone] = rules.splice(i, 1);
  writeBlock(file, cur, rules);
  // a retired marker keeps `suggest` from proposing the same key again until it recurs
  appendLine(root, `- ${common.today()} [retired] ${key}: retired from rules`);
  if (projectId) events.append(projectId, { type: 'lesson.retired', src: opts.src || 'cli', data: { key }, key: `${key}:${Date.now()}` });
  return { key, rule: gone.rule, file, count: rules.length };
}

module.exports = {
  START, END, KINDS, KEY_RE, add, readEntries, summarize, suggest, promote, retire, readRules, splitBlock,
  parseRules, lessonsFile,
};
