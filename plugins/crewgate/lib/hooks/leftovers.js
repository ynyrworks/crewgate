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
function list(deps = {}, timeoutMs = 3000) {
  try {
    if (deps.list) return deps.list();
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_CMD], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 });
      const rows = parseWin(out);
      return rows.length ? rows : null;
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 });
    const rows = parsePosix(out);
    return rows.length ? rows : null;
  } catch { return null; }
}

// Time budget: the listing is given at most LIST_DISPATCH_MS at dispatch (PreToolUse is guarded at 4 s) and
// LIST_STOP_MS at stop (guard 9 s). `budgetMs` is what is left of the hook's guard; when it is under MIN_LEFT_MS
// nothing is listed (no snapshot at dispatch means the stop reports nothing, it never guesses).
const LIST_DISPATCH_MS = 1500;
const LIST_STOP_MS = 3000;
const MIN_LEFT_MS = 2500;
// CREWGATE_LEFTOVERS_LIST_MS replaces both limits (a test that needs a real listing must not depend on machine load);
// when the budget is known it is still cut to budgetMs - 1000 like the normal limit.
function timeoutFor(max, budgetMs) {
  const env = Number(process.env.CREWGATE_LEFTOVERS_LIST_MS);
  const limit = env > 0 ? env : max;
  if (!Number.isFinite(budgetMs)) return limit;
  return budgetMs < MIN_LEFT_MS ? 0 : Math.min(limit, budgetMs - 1000);
}

// At dispatch -> { pids, ts }, { skipped: 'too-many-processes', ts } when the list is over the cap (a cut list would
// make the cut pids look new), or null (listing failed or no time).
function snapshot(deps = {}, budgetMs) {
  const t = timeoutFor(LIST_DISPATCH_MS, budgetMs);
  if (!t) return null;
  const rows = list(deps, t);
  if (!rows) return null;
  if (rows.length > MAX_PIDS) return { skipped: 'too-many-processes', ts: Date.now() };
  return { pids: rows.map((r) => r.pid), ts: Date.now() };
}

// Programs the operating system (or an updater) starts on its own, with no link to a worker: never counted, whatever
// their parent. Decided by name only, from what Windows starts on demand under services, WMI and COM (conhost holds a
// console, WmiPrvSE / wmiapsrv answer WMI queries such as our own listing, svchost / dllhost / RuntimeBroker /
// taskhostw / sihost / backgroundTaskHost host services and COM servers, SearchProtocolHost / SearchFilterHost index
// files, TiWorker / TrustedInstaller / MoUsoCoreWorker / usoclient are Windows Update, MpCmdRun / MsMpEng are
// Defender, WerFault reports crashes, MicrosoftEdgeUpdate / GoogleUpdate / OneDriveStandaloneUpdater are updaters)
// plus the listing tools themselves (powershell is only skipped through the hook's own subtree; `ps` here).
// A `node` with a dead parent is NOT on this list: that is the case the check exists for.
const SYSTEM = new Set([
  'conhost', 'wmiprvse', 'wmiapsrv', 'svchost', 'dllhost', 'runtimebroker', 'taskhostw', 'sihost', 'backgroundtaskhost',
  'searchprotocolhost', 'searchfilterhost', 'tiworker', 'trustedinstaller', 'mousocoreworker', 'usoclient', 'mpcmdrun',
  'msmpeng', 'werfault', 'microsoftedgeupdate', 'googleupdate', 'onedrivestandaloneupdater', 'audiodg', 'ctfmon',
  'smartscreen', 'consent', 'ps',
]);
// Shells: a new shell under Claude Code is usually the shell of a command that is still ending at the stop.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const norm = (name) => String(name).toLowerCase().replace(/.exe$/, '');

// Pure. -> { pids, programs } of the processes that are new since `before`, are in Claude Code's tree or have a dead
// parent, and are none of: Claude Code itself, this hook (and what it started), the board, a holder (and their
// descendants), or a pid in another running worker's dispatch-time set (`otherSets`).
// Each result is `clear` (it or a new ancestor lost its parent: it outlived what started it) or not (a live descendant
// of Claude Code that is not a shell). `clearOnly` keeps just the clear ones.
function find(rows, { before = [], claudePid, selfPid = process.pid, excludeRoots = [], otherSets = [], clearOnly = false }) {
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
  let unclear = 0;
  for (const r of rows) {
    if (old.has(r.pid) || r.pid === claudePid || r.pid <= 4 || SYSTEM.has(norm(r.name))) continue;
    const c = chain(r);
    if (c.excluded) continue;
    if (!c.underClaude && !c.orphan) continue;
    if (!c.orphan && (clearOnly || SHELLS.has(norm(r.name)))) { unclear++; continue; }
    pids.push(r.pid);
    const n = String(r.name).slice(0, 40);
    programs[n] = (programs[n] || 0) + 1;
  }
  const top = Object.entries(programs).sort((a, b) => b[1] - a[1]).slice(0, MAX_PROGRAMS);
  return { pids, programs: Object.fromEntries(top), unclear };
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
    if (!rec || !rec.snap) return null;
    if (rec.snap.skipped) return { skipped: rec.snap.skipped, ms: 0 };
    if (!Array.isArray(rec.snap.pids)) return null;
    const t0 = Date.now();
    const t = timeoutFor(LIST_STOP_MS, deps.budgetMs);
    if (!t) return null;
    const rows = list(deps, t);
    if (!rows) return null;
    if (rows.length > MAX_PIDS) return { skipped: 'too-many-processes', ms: Date.now() - t0 };
    const claudePid = deps.claudePid || process.ppid;
    const running = others.filter((o) => !o.stopped && o.snap);
    const since = Number(rec.snap.ts) || Number(rec.ts) || 0;
    // hint: the caller saw other activity (a running subagent, a background run in which the orchestrator keeps working)
    const shared = deps.sharedHint === true || others.some((o) => !o.stopped || (Number(o.ts) || 0) >= since || (Number(o.stopped_at) || 0) >= since);
    const r = find(rows, {
      before: rec.snap.pids, claudePid, selfPid: deps.selfPid || process.pid, clearOnly: shared,
      excludeRoots: knownRoots(projectId, claudePid, deps), otherSets: running.filter((o) => Array.isArray(o.snap.pids)).map((o) => o.snap.pids),
    });
    return { count: r.pids.length, programs: r.programs, shared, ...(shared && r.unclear ? { unclear: r.unclear } : {}), ms: Date.now() - t0, ...(deps.withPids ? { pids: r.pids } : {}) };
  } catch { return null; }
}

// What is left of the hook's guard for `event`, in ms (the guard is the env override or the table in timeouts.js).
function budgetLeft(event) {
  const guard = Number(process.env.CREWGATE_HOOK_GUARD_MS) || require('./timeouts').guardMs(event);
  return guard - process.uptime() * 1000;
}

module.exports = { budgetLeft, timeoutFor, list, snapshot, find, check, parseWin, parsePosix, knownRoots };
