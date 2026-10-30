'use strict';

// PostToolUse: foreground subagent completion (Agent/Task) and git/PR commands (Bash).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const project = require('../core/project');
const events = require('../core/events');
const tasks = require('../core/tasks');
const C = require('./common');
const sess = require('./session');
const gitcmd = require('./gitcmd');
const gates = require('../core/gates');
const G = require('./gatecheck');

function onAgent(payload) {
  if (payload.agent_id) return null;
  const h = C.open(payload);
  if (!h) return null;
  const ti = C.obj(payload.tool_input);
  const resp = C.obj(payload.tool_response);
  const tuid = C.str(payload.tool_use_id);
  const rec = tuid ? sess.byToolUse(h.pid, tuid) : null;
  const id = (rec && rec.task) || tasks.findMarker(C.agentPrompt(ti).slice(0, 1 << 20));
  if (!id) return null;
  const bg = ti.run_in_background === true || payload.tool_name === C.CODEX_SPAWN || (rec && rec.bg) || resp.isAsync === true
    || /async|background/i.test(C.str(resp.status));
  if (bg) return null; // wait for SubagentStop

  let task;
  try { task = tasks.load(h.pid, id); } catch { return null; }
  let noReport = false;
  if (task.state === 'dispatched' && (!rec || rec.worker)) {
    try {
      task = tasks.transition(h.pid, id, 'returned', {
        src: 'hook', session: h.sid, note: 'foreground worker finished without a CLI report', data: { via: 'post-tool-use' },
      });
      noReport = true;
    } catch { return null; }
  }
  if (rec) sess.markStopped(h.pid, rec.id);
  if (task.state !== 'returned') return null;
  const key = noReport ? 'sub.returnedNoReport' : 'sub.returned';
  return C.withContext('PostToolUse', h.t(key, { id, cmd: C.crewCmd() }));
}

// The text of a Bash tool_response: a string, or { stdout, stderr }.
function responseText(r) {
  if (typeof r === 'string') return r;
  const o = C.obj(r);
  return [C.str(o.stdout), C.str(o.stderr), C.str(o.output)].filter(Boolean).join('\n');
}

// Event data for a detected `git merge`. A command written once can merge many times (a shell loop), so
// when its output shows several merges and the branch names are not known, each one gets its own
// event; otherwise one event that carries the number git reported.
function mergeEvents(f, merges, mergeCommands) {
  const d = f.data;
  if (!merges.length) return [d];
  if (d.dynamic && mergeCommands === 1 && merges.length > 1) return merges.map((m, i) => ({ ...d, ...m, seq: i + 1, of: merges.length }));
  return [{ ...d, merged: merges.length, outcome: merges[0].outcome, ...(merges[0].range ? { range: merges[0].range } : {}) }];
}

// True when `crew task merge` (src cli) recorded this very merge in the last minute: the same set of branches
// into the same branch of the same work tree. The hook then keeps quiet so the merge is not counted twice.
// Anything else (another target, another work tree, a longer branch list, a CLI record without a target) is kept.
// Reading the log and asking git only happens for named merges.
const CLI_MERGE_WINDOW_MS = 60 * 1000;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// Work tree root and current branch of dir, read from the files git keeps (.git folder or "gitdir:" file, HEAD):
// no process to spawn, so nothing to time out on a loaded machine (a miss here means a merge counted twice).
// null when it cannot tell (no .git on the way up, an odd layout): the caller then asks git.
// Out of scope: symbolic-ref chains (HEAD -> alias -> main).
function headAndTopFromFiles(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const dot = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dot); } catch { /* none here */ }
    if (st) {
      let gitDir = dot;
      if (st.isFile()) {
        const m = fs.readFileSync(dot, 'utf8').split(/\r?\n/)[0];
        if (!m.startsWith('gitdir:')) return null;
        gitDir = path.resolve(d, m.slice(7).trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').split(/\r?\n/)[0].trim();
      const ref = 'ref: refs/heads/';
      return { top: d, target: head.startsWith(ref) ? head.slice(ref.length) : 'HEAD' };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// One git call for both values; the fallback when the files do not say. Returns { top, target } or null.
function gitHeadAndTop(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const [top, target] = String(r.stdout).split(/\r?\n/).map((x) => x.trim());
  return top && target ? { top, target } : null;
}

function cliMergeRecorded(pid, data, dir) {
  if (!Array.isArray(data.branches) || !data.branches.length) return false;
  try {
    const cand = events.read(pid, { types: 'git.merge', since: Date.now() - CLI_MERGE_WINDOW_MS }).filter((e) => e.src === 'cli'
      && e.data && e.data.target && e.data.root && Array.isArray(e.data.branches) && sameSet(e.data.branches, data.branches));
    if (!cand.length) return false;
    let here = null;
    // git overrides in the environment can point git at another root or branch than the .git files say: ask git
    const overridden = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some((k) => process.env[k]);
    if (!overridden) { try { here = headAndTopFromFiles(dir); } catch { /* fall back to git */ } }
    if (!here) here = gitHeadAndTop(dir);
    if (!here) return false;
    const target = here.target;
    const root = project.normalizePath(here.top);
    // git prints `heads/main` when a tag is also called main; the files say `main`: compare without the prefix
    const bare = (t) => String(t).replace(/^heads[/]/, '');
    return cand.some((e) => bare(e.data.target) === bare(target) && e.data.root === root);
  } catch { return false; }
}

// A push, PR or merge whose gate is "ask" needs a recorded yes (crew gate answer) from the last 30 minutes.
// Without one: a gate.missing event and reminder lines for the model. With gates.enforce=confirm the
// PreToolUse hook already put the command to the user (gate.prompted for this tool call): the command ran, so the
// user allowed it; that is recorded as gate.confirmed and nothing is reminded.
function gateLines(h, found, tuid) {
  const lines = [];
  let prompted = null;
  for (const m of G.unapproved(h, G.wantedGates(found))) {
    if (tuid && gates.enforceOf(h.cfg()) === 'confirm') {
      if (!prompted) {
        try { prompted = events.read(h.pid, { types: 'gate.prompted', since: Date.now() - 30 * 60 * 1000 }).filter((e) => e.data && e.data.tool_use_id === tuid); } catch { prompted = []; }
      }
      const p = prompted.find((e) => e.data && e.data.gate === m.gate);
      if (p) {
        try {
          events.append(h.pid, {
            type: 'gate.confirmed', src: 'hook', session: h.sid, tool_use_id: tuid,
            data: { gate: m.gate, command: m.command, via: 'permission-prompt', permission_mode: p.data.permission_mode || null }, key: `${tuid}:${m.gate}:confirmed`,
          });
        } catch { /* ignore */ }
        continue;
      }
    }
    try {
      events.append(h.pid, {
        type: 'gate.missing', src: 'hook', session: h.sid, tool_use_id: tuid,
        data: { gate: m.gate, mode: 'ask', command: m.command }, key: `${tuid || Date.now()}:${m.gate}`,
      });
    } catch { /* ignore */ }
    lines.push(h.t('gate.missing', { what: m.command, gate: m.gate, cmd: C.crewCmd() }));
  }
  return lines;
}

function onBash(payload) {
  const command = C.str(C.obj(payload.tool_input).command);
  const gitish = G.GIT_WORDS.test(command.slice(0, 20000));
  // Ordinary commands only use the session file (no git); git-like ones may resolve the project.
  const h = C.open(payload, { fastOnly: !gitish });
  if (h) sess.bumpTool(h, 'Bash');
  if (!gitish) return null;
  const tuid = C.str(payload.tool_use_id);
  const merges = gitcmd.mergesIn(responseText(payload.tool_response));
  const found = gitcmd.detect(command);
  if (!h && !found.some((f) => f.cd.length)) return null;
  const sessionCwd = C.str(payload.cwd) || process.cwd();
  // A command that cd's or uses git -C acts on that directory's project, not on the session's.
  // A directory outside every registered project records nothing (and is never registered here).
  const handleFor = G.makeHandleFor(payload, h);
  const byProject = new Map(); // pid -> { h, found }
  found.forEach((f, i) => {
    const fh = handleFor(f);
    if (!fh) return;
    if (!byProject.has(fh.pid)) byProject.set(fh.pid, { h: fh, found: [] });
    byProject.get(fh.pid).found.push(f);
    if (f.type === 'git.merge' && cliMergeRecorded(fh.pid, f.data, G.targetDir(sessionCwd, f.cd) || sessionCwd)) return; // `crew task merge` already recorded it
    const list = f.type === 'git.merge' ? mergeEvents(f, merges, found.filter((x) => x.type === 'git.merge').length) : [f.data];
    list.forEach((data, k) => {
      try {
        events.append(fh.pid, {
          type: f.type, src: 'hook', session: fh.sid, tool_use_id: tuid,
          data, key: `${tuid || Date.now()}:${i}${k ? `:${k}` : ''}`,
        });
      } catch { /* ignore */ }
    });
  });
  const lines = [];
  for (const g of byProject.values()) lines.push(...gateLines(g.h, g.found, tuid));
  return lines.length ? C.withContext('PostToolUse', lines.join('\n')) : null;
}

function run(payload) {
  const tool = C.str(payload.tool_name);
  if (C.AGENT_TOOLS.has(tool)) return onAgent(payload);
  if (tool === 'Bash') return onBash(payload);
  return null;
}

module.exports = { run };
