'use strict';

// Board store: needs, work streams, log, merge requests and validation records of one project.
// Every function takes the project id first, returns plain data (no printing) and every
// mutation appends an event. opts.src ('cli' by default) names the writer.
const paths = require('./paths');
const json = require('./json');
const events = require('./events');
const { clean } = require('./redact');
const { CrewError, UsageError } = require('./errors');

const WORK_STATES = ['todo', 'doing', 'done', 'waiting', 'parked'];   // waiting = waiting for the user
const CI_STATES = ['passed', 'failed', 'running'];
const LOG_KEEP = 500;
const TEXT_MAX = 2000;

const now = () => new Date().toISOString();
const has = (v) => v !== undefined && v !== null;
const file = (id, name) => paths.dataFile(id, name);

function text(v, what, max = TEXT_MAX) {
  if (typeof v !== 'string' || v.trim() === '') throw new CrewError('store.textRequired', { what });
  return clean(v, max);
}

// Names that would hit the prototype when used as a key of a plain object (the validation map).
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function safeKey(v, what) {
  if (RESERVED_KEYS.has(v)) throw new UsageError('store.badKey', { what, key: v });
  return v;
}

function oneOf(value, allowed, what) {
  if (!allowed.includes(value)) throw new CrewError('store.badChoice', { what, choices: allowed.join(', ') });
  return value;
}

function emit(id, opts, type, data, key) {
  events.append(id, { type, src: (opts && opts.src) || 'cli', session: opts && opts.session, data, key });
}

// ------------------------------------------------------------------ needs (waiting for the user)
const NEEDS = () => ({ needs: [] });

// needAdd(id, text, opts) -> need { id, text, done, created }
function needAdd(id, body, opts) {
  const t = text(body, 'text');
  const need = json.update(file(id, 'needs'), NEEDS(), (d) => {
    if (!Array.isArray(d.needs)) d.needs = [];
    const n = Math.max(0, ...d.needs.map((x) => x.id || 0)) + 1;
    const row = { id: n, text: t, done: false, created: now() };
    d.needs.push(row);
    return row;
  });
  emit(id, opts, 'need.added', { id: need.id, text: need.text }, `need:${need.id}:added`);
  return need;
}

// needDone(id, n, opts) -> need
function needDone(id, n, opts) {
  const num = Number(n);
  if (!Number.isInteger(num)) throw new CrewError('store.needNumber');
  const need = json.update(file(id, 'needs'), NEEDS(), (d) => {
    const x = (Array.isArray(d.needs) ? d.needs : []).find((y) => y.id === num);
    if (!x) throw new CrewError('store.needNotFound', { id: num });
    x.done = true;
    x.done_at = now();
    return x;
  });
  emit(id, opts, 'need.done', { id: need.id }, `need:${need.id}:done`);
  return need;
}

// needList(id, { all }) -> needs; open ones only unless all=true
function needList(id, opts = {}) {
  const d = json.readJson(file(id, 'needs'), NEEDS()).data;
  const needs = Array.isArray(d.needs) ? d.needs : [];
  return opts.all ? needs : needs.filter((x) => !x.done);
}

// ------------------------------------------------------------------ work streams
const WORK = () => ({ streams: [] });

// workSet(id, { stream, title, state, note, need }, opts) -> item { title, state, note, updated }
function workSet(id, o, opts) {
  const state = oneOf(o.state, WORK_STATES, 'state');
  const streamName = text(o.stream, 'stream', 200);
  const title = text(o.title, 'title', 300);
  const item = json.update(file(id, 'work'), WORK(), (d) => {
    if (!Array.isArray(d.streams)) d.streams = [];
    let s = d.streams.find((x) => x.name === streamName);
    if (!s) { s = { name: streamName, items: [] }; d.streams.push(s); }
    let it = s.items.find((x) => x.title === title);
    if (!it) { it = { title, note: '' }; s.items.push(it); }
    it.state = state;
    if (has(o.note)) it.note = clean(String(o.note), TEXT_MAX);
    if (has(o.need)) it.need = o.need;
    it.updated = now();
    return { ...it };
  });
  emit(id, opts, 'work.set', { stream: streamName, title, state }, `work:${streamName}:${title}:${state}:${item.updated}`);
  return item;
}

function workRm(id, stream, title, opts) {
  json.update(file(id, 'work'), WORK(), (d) => {
    const s = (Array.isArray(d.streams) ? d.streams : []).find((x) => x.name === stream);
    if (!s || !s.items.some((i) => i.title === title)) throw new CrewError('store.workNotFound');
    s.items = s.items.filter((i) => i.title !== title);
    if (!s.items.length) d.streams.splice(d.streams.indexOf(s), 1);
  });
  emit(id, opts, 'work.removed', { stream, title }, `work:${stream}:${title}:rm:${now()}`);
}

// workList(id) -> streams [{ name, items: [...] }]
function workList(id) {
  const d = json.readJson(file(id, 'work'), WORK()).data;
  return Array.isArray(d.streams) ? d.streams : [];
}

// ------------------------------------------------------------------ log
// logAdd(id, who, text, opts) -> entry { time, who, text }; the file keeps the newest 500.
function logAdd(id, who, body, opts) {
  const entry = { time: now(), who: text(who, 'who', 100), text: text(body, 'text') };
  const count = json.update(file(id, 'log'), [], (rows) => {
    rows.push(entry);
    if (rows.length > LOG_KEEP) rows.splice(0, rows.length - LOG_KEEP);
    return rows.length;
  });
  emit(id, opts, 'log.added', { who: entry.who, text: entry.text }, `log:${entry.time}:${count}:${entry.who}:${entry.text}`);
  return entry;
}

// logList(id, n = 20) -> newest first; n = 0 gives everything
function logList(id, n = 20) {
  const rows = json.readJson(file(id, 'log'), []).data;
  const part = n > 0 ? rows.slice(-n) : rows.slice();
  return part.reverse();
}

// ------------------------------------------------------------------ merge requests
const MRS = () => ({ mrs: [] });

// mrSet(id, iid, title, { ci, merged: 'yes'|'no'|boolean }, opts) -> row { iid, title, ci, merged, updated }
function mrSet(id, iid, title, o = {}, opts) {
  const n = Number(iid);
  if (!Number.isInteger(n) || n < 0) throw new CrewError('store.badIid');
  const t = text(title, 'title', 300);
  const row = json.update(file(id, 'mrs'), MRS(), (d) => {
    if (!Array.isArray(d.mrs)) d.mrs = [];
    let r = d.mrs.find((x) => x.iid === n);
    if (!r) { r = { iid: n, title: '', ci: '', merged: false }; d.mrs.push(r); }
    r.title = t;
    if (has(o.ci)) r.ci = oneOf(o.ci, CI_STATES, 'ci');
    if (has(o.merged)) r.merged = o.merged === true || o.merged === 'yes';
    r.updated = now();
    return { ...r };
  });
  emit(id, opts, 'mr.set', { iid: n, ci: row.ci, merged: row.merged }, `mr:${n}:${row.ci}:${row.merged}:${row.updated}`);
  return row;
}

function mrList(id) {
  const d = json.readJson(file(id, 'mrs'), MRS()).data;
  return Array.isArray(d.mrs) ? d.mrs : [];
}

// ------------------------------------------------------------------ validation records
// validateSet(id, { templateId, date: 'YYYY-MM-DD', host, result }, opts) -> record { date, host, result }
function validateSet(id, o, opts) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date || '')) throw new CrewError('store.badDate');
  const tid = safeKey(text(o.templateId, 'templateId', 200), 'templateId');
  const host = text(o.host, 'host', 200);
  const result = text(o.result, 'result');
  const rec = { date: o.date, host, result };
  json.update(file(id, 'validation'), {}, (d) => {
    if (!Array.isArray(d[tid])) d[tid] = [];
    const recs = d[tid];
    const i = recs.findIndex((r) => r.date === o.date && r.host === host);
    if (i >= 0) recs[i] = rec; else recs.push(rec);
    recs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  });
  emit(id, opts, 'validation.set', { templateId: tid, date: o.date, host }, `validation:${tid}:${o.date}:${host}:${now()}`);
  return rec;
}

// validateList(id) -> { <templateId>: [records] }
function validateList(id) {
  return json.readJson(file(id, 'validation'), {}).data;
}

module.exports = {
  WORK_STATES, CI_STATES, LOG_KEEP,
  needAdd, needDone, needList, workSet, workRm, workList, logAdd, logList, mrSet, mrList, validateSet, validateList,
};
