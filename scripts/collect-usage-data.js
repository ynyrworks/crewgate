#!/usr/bin/env node
'use strict';

// Copies this machine's Crewgate usage data into one folder (and a .tgz next to it) so it can be read on another machine,
// or prints the numbers a before/after comparison needs (--stats). Reads only; changes nothing under ~/.crewgate, ~/.claude or any project.
// Needs Node only.
//
//   node scripts/collect-usage-data.js [--out DIR] [--since 2026-10-01] [--no-transcripts]
//   node scripts/collect-usage-data.js --stats [--json] [FOLDER...]
//
// What is copied:
//   crewgate/    the data folder (~/.crewgate, or CREWGATE_HOME): projects/ (events, tasks, plan settings, to-do items),
//                projects.json, config.json
//   projects/    per registered project: .crew/plans, .crew/LESSONS.md, .claude/crew.json
//   transcripts/ Claude Code session files of the registered projects, changed since --since, that mention Crewgate
//                (skills, the crew command or its agents). They hold full conversation text; --no-transcripts leaves them out.
//   summary.json machine, versions and counts
// What is left out: accounts.json, sessions/, cache/ and bin/ of the data folder (only the items above are copied, nothing else),
//   and every other file of the projects and of ~/.claude.
//
// The output folder (crewgate-data-<machine>-<date>) is never made inside a git work tree unless --out names it: with no --out the
// default moves from the current folder to the home folder, then the temp folder. Do not commit it (.gitignore has crewgate-data-*).
//
// --stats prints, without copying anything, the numbers the plan compares, per machine and in total, from the data folder alone.
//   With FOLDERs it reads earlier collected folders (crewgate-data-*) instead of the live data folder: two machines' collections
//   can be compared on one machine. --json prints the same as data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = process.env.CREWGATE_HOME || process.env.AGENT_CREW_HOME || path.join(os.homedir(), '.crewgate');
const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const NEEDLES = ['crewgate:crew', 'crewgate:plan', 'crew.js', 'crew-worker', 'crew-reviewer', 'crew-refuter'];
const label = os.hostname().replace(/[^A-Za-z0-9_-]/g, '-');

function parseArgs(argv) {
  const o = { out: '', since: '2026-10-01', transcripts: true, stats: false, json: false, folders: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--since') {
      if (argv[i + 1] === undefined) { console.error(`${a} needs a value`); process.exit(2); }
      o[a === '--out' ? 'out' : 'since'] = argv[++i];
    } else if (a === '--no-transcripts') o.transcripts = false;
    else if (a === '--stats') o.stats = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else o.folders.push(a);
  }
  if (o.folders.length && !o.stats) { console.error(`Unexpected argument: ${o.folders[0]} (folders are read with --stats)`); process.exit(2); }
  return o;
}

// ---- --stats ----

function readEvents(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e.type === 'string') out.push(e); } catch { /* a torn line */ }
  }
  return out;
}

const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
const dataOf = (e) => (e && e.data && typeof e.data === 'object' ? e.data : {});

function emptyCounts() {
  return {
    gate_refused_no_user_turn: 0,
    gate_missing: { total: 0, by_gate: {} },
    gates: {},
    drift: { asked: 0, answers_by_kind: {} },
    tasks_accepted: 0,
    tasks_accepted_no_review_round: 0,
    tasks_accepted_after_send_back_no_later_round: 0,
    tasks_accepted_send_back_unknown: 0,
    lessons: { added: 0, promoted: 0 },
    plans: { created: 0, finalized: 0, closed: 0 },
  };
}

// When a finalized round (N.json) was finalized: the "review round N" event when there is one; else, for a collected folder, the time
// recorded in its summary.json at collection (rec); else, for live data only (rec null), the file's time. A copy's file times say nothing,
// so for a collected folder with neither an event nor a record the time is unknown (null).
function finalizedAt(taskEvs, round, file, rec, key) {
  const hit = taskEvs.filter((e) => e.type === 'task.reviewed' && dataOf(e).note === `review round ${round}`);
  if (hit.length) return Date.parse(hit[hit.length - 1].ts);
  if (rec) { const t = Date.parse(rec[key]); return Number.isNaN(t) ? null : t; }
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function countProject(c, projectDir, rec) {
  const evs = readEvents(path.join(projectDir, 'events.jsonl'));
  const byTask = new Map();
  for (const e of evs) {
    const d = dataOf(e);
    switch (e.type) {
      case 'gate.asked': bump((c.gates[d.gate || '?'] = c.gates[d.gate || '?'] || { asked: 0, yes: 0, no: 0 }), 'asked'); break;
      case 'gate.answered': {
        const g = (c.gates[d.gate || '?'] = c.gates[d.gate || '?'] || { asked: 0, yes: 0, no: 0 });
        if (d.answer === 'yes' || d.answer === 'no') bump(g, d.answer);
        break;
      }
      case 'gate.refused': if (d.reason === 'no_user_turn') c.gate_refused_no_user_turn++; break;
      case 'gate.missing': c.gate_missing.total++; bump(c.gate_missing.by_gate, d.gate || '?'); break;
      case 'plan.drift_asked': c.drift.asked++; break;
      case 'plan.drift_answered': {
        const k = (c.drift.answers_by_kind[d.kind || '?'] = c.drift.answers_by_kind[d.kind || '?'] || {});
        bump(k, d.answer || '?');
        break;
      }
      case 'lesson.added': c.lessons.added++; break;
      case 'lesson.promoted': c.lessons.promoted++; break;
      case 'plan.created': c.plans.created++; break;
      case 'plan.finalized': c.plans.finalized++; break;
      case 'plan.closed': c.plans.closed++; break;
      default: break;
    }
    if (e.task && typeof e.task === 'string' && e.type.startsWith('task.')) {
      if (!byTask.has(e.task)) byTask.set(e.task, []);
      byTask.get(e.task).push(e);
    }
  }
  for (const [id, tevs] of byTask) {
    if (!tevs.some((e) => e.type === 'task.accepted')) continue;
    c.tasks_accepted++;
    const findings = path.join(projectDir, 'tasks', id, 'findings');
    let rounds = [];
    try { rounds = fs.readdirSync(findings).map((n) => /^(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])); } catch { /* none */ }
    if (!rounds.length) { c.tasks_accepted_no_review_round++; }
    const sent = tevs.filter((e) => e.type === 'task.sent_back').map((e) => Date.parse(e.ts)).filter((n) => !Number.isNaN(n));
    if (sent.length) {
      const last = Math.max(...sent);
      const times = rounds.map((r) => finalizedAt(tevs, r, path.join(findings, `${r}.json`), rec, `${path.basename(projectDir)}/${id}/${r}`));
      if (times.some((t) => t !== null && t > last)) continue;
      if (times.some((t) => t === null)) c.tasks_accepted_send_back_unknown++;
      else c.tasks_accepted_after_send_back_no_later_round++;
    }
  }
}

function sumInto(t, c) {
  t.gate_refused_no_user_turn += c.gate_refused_no_user_turn;
  t.gate_missing.total += c.gate_missing.total;
  for (const [g, n] of Object.entries(c.gate_missing.by_gate)) bump(t.gate_missing.by_gate, g, n);
  for (const [g, v] of Object.entries(c.gates)) {
    const x = (t.gates[g] = t.gates[g] || { asked: 0, yes: 0, no: 0 });
    for (const k of ['asked', 'yes', 'no']) x[k] += v[k];
  }
  t.drift.asked += c.drift.asked;
  for (const [k, ans] of Object.entries(c.drift.answers_by_kind)) {
    const x = (t.drift.answers_by_kind[k] = t.drift.answers_by_kind[k] || {});
    for (const [a, n] of Object.entries(ans)) bump(x, a, n);
  }
  for (const k of ['tasks_accepted', 'tasks_accepted_no_review_round', 'tasks_accepted_after_send_back_no_later_round', 'tasks_accepted_send_back_unknown']) t[k] += c[k];
  for (const k of ['added', 'promoted']) t.lessons[k] += c.lessons[k];
  for (const k of ['created', 'finalized', 'closed']) t.plans[k] += c.plans[k];
}

// The folder holding projects/: a collected folder keeps it under crewgate/.
function dataRoot(folder) {
  const inner = path.join(folder, 'crewgate');
  return fs.existsSync(path.join(inner, 'projects')) ? inner : folder;
}

function countFolder(root, rec) {
  const c = emptyCounts();
  let ids = [];
  try { ids = fs.readdirSync(path.join(root, 'projects')); } catch { /* no projects */ }
  for (const id of ids) countProject(c, path.join(root, 'projects', id), rec);
  return c;
}

function machineName(folder, taken) {
  let name = path.basename(folder);
  try { name = JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8')).machine || name; } catch { /* no summary */ }
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${name}#${i}`;
  return n;
}

function rowsOf(c) {
  const rows = [
    ['gate answers refused (no_user_turn)', c.gate_refused_no_user_turn],
    ['gate.missing (push/merge with no recorded approval)', c.gate_missing.total],
  ];
  for (const g of Object.keys(c.gate_missing.by_gate).sort()) rows.push([`  gate.missing: ${g}`, c.gate_missing.by_gate[g]]);
  for (const g of Object.keys(c.gates).sort()) {
    rows.push([`gate ${g}: asked / yes / no`, `${c.gates[g].asked} / ${c.gates[g].yes} / ${c.gates[g].no}`]);
  }
  rows.push(['drift asked', c.drift.asked]);
  for (const k of Object.keys(c.drift.answers_by_kind).sort()) {
    const ans = c.drift.answers_by_kind[k];
    rows.push([`  drift answered: ${k}`, Object.keys(ans).sort().map((a) => `${a} ${ans[a]}`).join(', ')]);
  }
  rows.push(['tasks accepted', c.tasks_accepted]);
  rows.push(['  accepted with no finalized review round', c.tasks_accepted_no_review_round]);
  rows.push(['  accepted after a send-back, no later round', c.tasks_accepted_after_send_back_no_later_round]);
  if (c.tasks_accepted_send_back_unknown) rows.push(['  accepted after a send-back, round time unknown (not counted above)', c.tasks_accepted_send_back_unknown]);
  rows.push(['lessons added / promoted', `${c.lessons.added} / ${c.lessons.promoted}`]);
  rows.push(['plans created / finalized / closed', `${c.plans.created} / ${c.plans.finalized} / ${c.plans.closed}`]);
  return rows;
}

function runStats(o) {
  const sources = o.folders.length ? o.folders.map((f) => path.resolve(f)) : [home];
  const machines = {};
  const taken = new Set();
  for (const folder of sources) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { console.error(`Not a folder: ${folder} (unpack an archive first)`); process.exit(1); }
    const name = o.folders.length ? machineName(folder, taken) : label;
    taken.add(name);
    let rec = null;   // a collected folder has a summary.json; its recorded round times replace the copy's file times
    if (o.folders.length) { try { rec = JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8')).finalized_rounds || {}; } catch { rec = {}; } }
    machines[name] = countFolder(dataRoot(folder), rec);
  }
  const total = emptyCounts();
  for (const c of Object.values(machines)) sumInto(total, c);
  if (o.json) { console.log(JSON.stringify({ machines, total }, null, 2)); return; }
  const names = Object.keys(machines);
  const cols = names.length > 1 ? [...names, 'total'] : names;
  const per = names.map((n) => rowsOf(machines[n]));
  const tot = rowsOf(total);
  // Rows come from the total, so a count that is 0 on one machine still lines up.
  const lookup = (rows) => new Map(rows.map((r) => [r[0], r[1]]));
  const maps = [...per.map(lookup), lookup(tot)].slice(0, cols.length);
  const keys = tot.map((r) => r[0]);
  const w0 = Math.max(...keys.map((k) => k.length));
  const widths = cols.map((c, i) => Math.max(c.length, ...keys.map((k) => String(maps[i].has(k) ? maps[i].get(k) : 0).length)));
  console.log(`${''.padEnd(w0)}  ${cols.map((c, i) => c.padStart(widths[i])).join('  ')}`);
  for (const k of keys) console.log(`${k.padEnd(w0)}  ${cols.map((c, i) => String(maps[i].has(k) ? maps[i].get(k) : 0).padStart(widths[i])).join('  ')}`);
}

// ---- collecting ----

function inWorkTree(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const r = spawnSync('git', ['-C', d, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function chooseOut(o) {
  const name = `crewgate-data-${label}-${new Date().toISOString().slice(0, 10)}`;
  if (o.out) return path.resolve(o.out);
  const starts = [process.cwd(), os.homedir(), os.tmpdir()];
  for (const s of starts) {
    if (inWorkTree(s)) continue;
    if (s !== starts[0]) console.log(`The current folder is inside a git work tree; the output goes to ${s} instead (give --out to choose).`);
    return path.join(s, name);
  }
  console.error('Refusing to write the output inside a git work tree: the current, home and temp folders are all in one. Give --out DIR to choose a place.');
  process.exit(1);
}

function sizeOf(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  try { for (const f of fs.readdirSync(p)) n += sizeOf(path.join(p, f)); } catch { /* unreadable */ }
  return n;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// True when the file holds any needle; read in pieces so a large session file is not loaded whole.
function mentions(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) return false;
      const text = tail + buf.toString('latin1', 0, n);
      if (NEEDLES.some((s) => text.includes(s))) return true;
      tail = text.slice(-32);
    }
  } finally { fs.closeSync(fd); }
}

function collect(o) {
  const since = Date.parse(o.since);
  if (Number.isNaN(since)) { console.error(`Bad --since date: ${o.since}`); process.exit(2); }
  if (!fs.existsSync(home)) { console.error(`No Crewgate data at ${home}`); process.exit(1); }
  const out = chooseOut(o);
  if (fs.existsSync(out)) { console.error(`Output folder already exists: ${out}`); process.exit(1); }

  const summary = { machine: label, platform: process.platform, node: process.version, collected: new Date().toISOString(), home, plugin_versions: [], projects: [], transcripts: [], finalized_rounds: {}, skipped: [] };
  const jobs = [];   // { src, dst, transcript }
  const add = (src, dst, transcript = false) => { if (fs.existsSync(src)) jobs.push({ src, dst, transcript }); };

  add(path.join(home, 'projects'), path.join(out, 'crewgate', 'projects'));
  add(path.join(home, 'projects.json'), path.join(out, 'crewgate', 'projects.json'));
  add(path.join(home, 'config.json'), path.join(out, 'crewgate', 'config.json'));
  try { summary.plugin_versions = fs.readdirSync(path.join(claudeHome, 'plugins', 'cache', 'crewgate', 'crewgate')); } catch { /* not installed as a plugin */ }

  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects || {}; } catch { /* none */ }

  const seenDirs = new Set();
  for (const [id, p] of Object.entries(registry)) {
    const row = { id, name: p.name, path: p.path, plans: 0, events: 0, plan_events: 0, drift_events: 0, transcripts: 0 };
    const dst = path.join(out, 'projects', id);
    add(path.join(p.path, '.crew', 'plans'), path.join(dst, 'plans'));
    try { row.plans = fs.readdirSync(path.join(p.path, '.crew', 'plans')).filter((f) => f.endsWith('.md')).length; } catch { /* none */ }
    add(path.join(p.path, '.crew', 'LESSONS.md'), path.join(dst, 'LESSONS.md'));
    add(path.join(p.path, '.claude', 'crew.json'), path.join(dst, 'crew.json'));
    try {
      const lines = fs.readFileSync(path.join(home, 'projects', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
      row.events = lines.length;
      row.plan_events = lines.filter((l) => l.includes('"type":"plan.')).length;
      row.drift_events = lines.filter((l) => l.includes('"type":"plan.drift') || l.includes('"type":"task.outside_plan"')).length;
    } catch { /* no events */ }

    if (o.transcripts) {
      // A session may have been started in a parent folder of the project, so those folders are looked at too (never a drive root).
      const dirs = [];
      for (let d = path.resolve(String(p.path)); path.dirname(d) !== d; d = path.dirname(d)) dirs.push(d);
      for (const d of dirs) {
        const enc = d.replace(/[^A-Za-z0-9]/g, '-');
        if (seenDirs.has(enc)) continue;
        seenDirs.add(enc);
        const dir = path.join(claudeHome, 'projects', enc);
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { /* no sessions */ }
        for (const f of files) {
          const src = path.join(dir, f);
          try {
            const st = fs.statSync(src);
            if (st.mtimeMs < since || !mentions(src)) continue;
            jobs.push({ src, dst: path.join(out, 'transcripts', enc, f), transcript: true });
            row.transcripts++;
            summary.transcripts.push({ folder: enc, file: f, bytes: st.size, modified: st.mtime.toISOString() });
          } catch (e) { summary.skipped.push(`${src}: ${e.message}`); }
        }
      }
    }
    summary.projects.push(row);
  }

  // When each finalized review round was finalized (the source file's time), for --stats on the copy, whose file times are the copy's.
  try {
    for (const pid of fs.readdirSync(path.join(home, 'projects'))) {
      const tdir = path.join(home, 'projects', pid, 'tasks');
      let tasks = [];
      try { tasks = fs.readdirSync(tdir); } catch { continue; }
      for (const t of tasks) {
        let fl = [];
        try { fl = fs.readdirSync(path.join(tdir, t, 'findings')); } catch { continue; }
        for (const f of fl) {
          const m = /^(\d+)\.json$/.exec(f);
          if (m) { try { summary.finalized_rounds[`${pid}/${t}/${m[1]}`] = fs.statSync(path.join(tdir, t, 'findings', f)).mtime.toISOString(); } catch { /* skip */ } }
        }
      }
    }
  } catch { /* no projects */ }

  const tBytes = jobs.filter((j) => j.transcript).reduce((n, j) => n + sizeOf(j.src), 0);
  const total = jobs.reduce((n, j) => n + sizeOf(j.src), 0);
  if (o.transcripts) {
    console.log(`Session transcripts hold the full conversation text, not only Crewgate data; leave them out with --no-transcripts. About to copy ${mb(total)} in all, of which ${summary.transcripts.length} transcript(s) ${mb(tBytes)}.`);
  } else {
    console.log(`Transcripts are left out (--no-transcripts). About to copy ${mb(total)}.`);
  }

  fs.mkdirSync(out, { recursive: true });
  for (const j of jobs) {
    try {
      fs.mkdirSync(path.dirname(j.dst), { recursive: true });
      fs.cpSync(j.src, j.dst, { recursive: true, preserveTimestamps: true });
    } catch (e) {
      summary.skipped.push(`${j.src}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));

  const archive = `${out}.tgz`;
  // Relative names with cwd: GNU tar reads a "C:\..." argument as a remote host.
  const tar = spawnSync('tar', ['-czf', path.basename(archive), path.basename(out)], { cwd: path.dirname(out), stdio: 'ignore' });
  const packed = tar.status === 0 && fs.existsSync(archive);

  for (const r of summary.projects) {
    console.log(`${r.name}: plans ${r.plans}, events ${r.events} (plan ${r.plan_events}, drift ${r.drift_events}), transcripts ${r.transcripts}`);
  }
  if (summary.skipped.length) console.log(`Skipped ${summary.skipped.length} item(s); see summary.json`);
  console.log(`Wrote folder:  ${out}`);
  console.log(packed ? `Wrote archive: ${archive} (${mb(fs.statSync(archive).size)})` : 'No archive made (tar failed or is missing); copy the folder itself.');
  console.log('Do not commit the folder or the archive.');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.stats) runStats(opts); else collect(opts);
