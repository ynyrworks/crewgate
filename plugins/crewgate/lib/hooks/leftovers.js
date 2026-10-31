'use strict';

// Leftovers: what a worker left running. At dispatch the live pids are recorded; at the worker's stop the process
// list is read again and the new processes that belong to Claude Code's tree (or lost their parent) are counted.
// It only reports: nothing here stops or changes a process, and every failure gives null. Only program names and
// counts are kept, never a command line. One listing costs about 0.9 s on Windows (PowerShell, Get-CimInstance
// with three properties; wmic is absent on current Windows and tasklist has no parent pid) and a few ms with ps.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_PROGRAMS = 10;
const MAX_PIDS = 3000;

const PS_CMD = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | % { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }';

// "pid,ppid,name" lines (Windows)
function parseWin(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(.+)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() });
  }
  return rows;
}

// `ps -A -o pid=,ppid=,comm=` lines (POSIX); the name is the program's base name
function parsePosix(out) {
  const rows = [];
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3].trim()) });
  }
  return rows;
}

// -> [{ pid, ppid, name }] or null (a failed listing is "unknown", never "nothing")
function list(deps = {}) {
  try {
    if (deps.list) return deps.list();
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_CMD], { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16 << 20 });
      const rows = parseWin(out);
      return rows.length ? rows : null;
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16 << 20 });
    const rows = parsePosix(out);
    return rows.length ? rows : null;
  } catch { return null; }
}

// At dispatch -> { pids, ts } or null
function snapshot(deps = {}) {
  const rows = list(deps);
  return rows ? { pids: rows.map((r) => r.pid).slice(0, MAX_PIDS), ts: Date.now() } : null;
}

// Pure. -> { pids, programs } of the processes that are new since `before`, are in Claude Code's tree or have a dead
// parent, and are none of: Claude Code itself, this hook (and what it started), the board, a holder (and their
// descendants), or a pid in another running worker's dispatch-time set (`otherSets`).
function find(rows, { before = [], claudePid, selfPid = process.pid, excludeRoots = [], otherSets = [] }) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const old = new Set(before);
  for (const s of otherSets) for (const p of s || []) old.add(p);
  const roots = new Set([selfPid, ...excludeRoots].filter((n) => Number.isInteger(n) && n > 0));
  // walks up the parent chain: under the claude pid? under an excluded root?
  const chain = (r) => {
    const seen = new Set();
    let underClaude = false;
    let excluded = false;
    let orphan = false;   // this one, or an ancestor that is also new, lost its parent
    let cur = r;
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      if (roots.has(cur.pid)) excluded = true;
      const next = byPid.get(cur.ppid);
      if (!next && cur.ppid > 0 && !old.has(cur.pid)) orphan = true;
      if (cur.ppid === claudePid) underClaude = true;
      cur = next;
    }
    return { underClaude, excluded, orphan };
  };
  const pids = [];
  const programs = {};
  for (const r of rows) {
    if (old.has(r.pid) || r.pid === claudePid || r.pid <= 4) continue;
    const c = chain(r);
    if (c.excluded) continue;
    if (!c.underClaude && !c.orphan) continue;
    pids.push(r.pid);
    const n = String(r.name).slice(0, 40);
    programs[n] = (programs[n] || 0) + 1;
  }
  const top = Object.entries(programs).sort((a, b) => b[1] - a[1]).slice(0, MAX_PROGRAMS);
  return { pids, programs: Object.fromEntries(top) };
}

function readPid(file) {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}

// Pids of the board and of the holder for this Claude Code process (roots that are never leftovers).
function knownRoots(projectId, claudePid, deps = {}) {
  if (deps.roots) return deps.roots;
  const out = [];
  try {
    const paths = require('../core/paths');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(paths.home(), 'board.json'), 'utf8'));
      if (Number.isInteger(j.pid)) out.push(j.pid);
    } catch { /* no board */ }
    out.push(readPid(path.join(paths.runtimeDir(projectId), `session-job-${claudePid}.pid`)));
  } catch { /* none */ }
  return out.filter((n) => n > 0);
}

// At a worker's stop -> { count, programs, shared, ms } or null (no snapshot, listing failed, anything unexpected).
// rec: the worker's dispatch record (snap = { pids, ts }). others: the other worker records (see sharedWith).
function check(projectId, rec, others, deps = {}) {
  try {
    if (!rec || !rec.snap || !Array.isArray(rec.snap.pids)) return null;
    const t0 = Date.now();
    const rows = list(deps);
    if (!rows) return null;
    const claudePid = deps.claudePid || process.ppid;
    const running = others.filter((o) => !o.stopped && o.snap);
    const r = find(rows, {
      before: rec.snap.pids, claudePid, selfPid: deps.selfPid || process.pid,
      excludeRoots: knownRoots(projectId, claudePid, deps), otherSets: running.map((o) => o.snap.pids),
    });
    const since = Number(rec.snap.ts) || Number(rec.ts) || 0;
    const shared = others.some((o) => !o.stopped || (Number(o.ts) || 0) >= since || (Number(o.stopped_at) || 0) >= since);
    return { count: r.pids.length, programs: r.programs, shared, ms: Date.now() - t0, ...(deps.withPids ? { pids: r.pids } : {}) };
  } catch { return null; }
}

module.exports = { list, snapshot, find, check, parseWin, parsePosix, knownRoots };
