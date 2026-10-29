'use strict';

// One-time import of one project's store files from an older board data folder.
// The source folder is only read, never changed. Values are converted to the agent-crew
// formats (English states, ISO timestamps) and free text is redacted.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const json = require('./json');
const { clean } = require('./redact');
const { CrewError } = require('./errors');

const SRC_ID_RE = /^[pc][0-9a-f]{10}$/;
const WORK_MAP = { '待辦': 'todo', '進行中': 'doing', '完成': 'done', '等你確認': 'waiting', '擱置': 'parked' };
const CI_MAP = { '通過': 'passed', '失敗': 'failed', '執行中': 'running' };
const SOURCES = { work: 'object', log: 'array', mrs: 'object', validation: 'object' };

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM:SS" (local time, no zone) -> ISO string; others unchanged.
function toIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ''));
  if (!m) return s;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

const txt = (v, max = 2000) => (typeof v === 'string' ? clean(v, max) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

function convert(srcWork, srcLog, srcMrs, srcValidation) {
  const out = {};
  const stats = { unmappedStates: 0 };
  if (srcWork) {
    out.needs = { needs: arr(srcWork.needs).map((n) => ({
      id: n.id, text: txt(n.text), done: !!n.done, created: toIso(n.created),
      ...(n.done_at ? { done_at: toIso(n.done_at) } : {}),
    })) };
    out.work = { streams: arr(srcWork.streams).map((s) => ({
      name: txt(s.name, 200),
      items: arr(s.items).map((i) => {
        let state = WORK_MAP[i.state];
        if (!state) { state = 'todo'; stats.unmappedStates++; }
        return { title: txt(i.title, 300), note: txt(i.note), state, ...(i.need !== undefined ? { need: i.need } : {}), updated: toIso(i.updated) };
      }),
    })) };
  }
  if (srcLog) out.log = arr(srcLog).map((r) => ({ time: toIso(r.time), who: txt(r.who, 100), text: txt(r.text) }));
  if (srcMrs) out.mrs = { mrs: arr(srcMrs.mrs).map((m) => ({ iid: m.iid, title: txt(m.title, 300), ci: CI_MAP[m.ci] || '', merged: !!m.merged, updated: toIso(m.updated) })) };
  if (srcValidation) {
    const v = {};
    for (const [tid, recs] of Object.entries(srcValidation)) {
      if (Array.isArray(recs)) v[tid] = arr(recs).map((r) => ({ date: r.date, host: txt(r.host, 200), result: txt(r.result) }));
    }
    out.validation = v;
  }
  return { out, stats };
}

// importAgentBoard(dataDir, fromProject, targetProjectId, { force })
// -> { counts: { needs, items, log, mrs, validation }, written: [names], backups: [names], unmappedStates }
// Throws CrewError import.* before writing anything when the source is unusable or a target file
// exists and force is not set (with force the old file is renamed to <name>.before-import-<ts>).
function importAgentBoard(dataDir, fromProject, targetProjectId, opts = {}) {
  if (!SRC_ID_RE.test(String(fromProject))) throw new CrewError('import.badSourceId', { id: String(fromProject) });
  const srcDir = path.join(path.resolve(String(dataDir)), 'projects', fromProject);
  if (!isDir(srcDir)) throw new CrewError('import.noSource', { dir: srcDir });

  const parsed = {};
  for (const [name, type] of Object.entries(SOURCES)) {
    let raw;
    try { raw = fs.readFileSync(path.join(srcDir, `${name}.json`), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new CrewError('import.readFailed', { name, code: e.code || e.name });
    }
    let data;
    try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new CrewError('import.badJson', { name }); }
    const ok = data && typeof data === 'object' && (type === 'array' ? Array.isArray(data) : !Array.isArray(data));
    if (!ok) throw new CrewError('import.badJson', { name });
    parsed[name] = data;
  }
  if (!Object.keys(parsed).length) throw new CrewError('import.empty', { dir: srcDir });

  const { out, stats } = convert(parsed.work, parsed.log, parsed.mrs, parsed.validation);
  const names = Object.keys(out);
  const existing = names.filter((n) => fs.existsSync(paths.dataFile(targetProjectId, n)));
  if (existing.length && !opts.force) throw new CrewError('import.exists', { files: existing.map((n) => `${n}.json`).join(', ') });

  const backups = [];
  const stamp = json.stamp();
  for (const n of names) {
    const target = paths.dataFile(targetProjectId, n);
    json.withLock(target, () => {
      if (fs.existsSync(target)) {
        const moved = `${target}.before-import-${stamp}`;
        fs.renameSync(target, moved);
        backups.push(path.basename(moved));
      }
      json.save(target, out[n]);
    });
  }
  const items = out.work ? out.work.streams.reduce((c, s) => c + s.items.length, 0) : 0;
  return {
    counts: {
      needs: out.needs ? out.needs.needs.length : 0,
      items,
      log: out.log ? out.log.length : 0,
      mrs: out.mrs ? out.mrs.mrs.length : 0,
      validation: out.validation ? Object.keys(out.validation).length : 0,
    },
    written: names,
    backups,
    unmappedStates: stats.unmappedStates,
  };
}

module.exports = { importAgentBoard, toIso, WORK_MAP, CI_MAP };
