'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const tasks = require('../core/tasks');
const json = require('../core/json');
const glob = require('../hooks/glob');
const events = require('../core/events');
const paths = require('../core/paths');
const { clean } = require('../core/redact');
const { LANGUAGE_NAME } = require('../features/init');
const common = require('../features/common');
const review = require('../features/review');
const lessons = require('../features/lessons');
const codexrun = require('../features/codexrun');
const plans = require('../core/plans');
const drift = require('../core/drift');
const gates = require('../core/gates');
const sess = require('../hooks/session');
const release = require('../features/release');

const STATES = tasks.STATES;
const NOTE = { '--note': { dest: 'note' } };
const SPECS = {
  create: {
    positionals: [],
    options: {
      '--title': { dest: 'title' }, '--brief-file': { dest: 'briefFile' }, '--role': { dest: 'role' },
      '--branch': { dest: 'branch' }, '--worktree': { dest: 'worktree' },
      '--allow': { dest: 'allow', multi: true }, '--deny': { dest: 'deny', multi: true },
      '--plan': { dest: 'plan' }, '--outside-plan': { dest: 'outsidePlan' },
    },
  },
  list: { positionals: [], options: { '--state': { dest: 'state', choices: STATES } } },
  show: { positionals: [{ name: 'id' }], options: { '--prompt': { dest: 'prompt', flag: true } } },
  report: {
    positionals: [{ name: 'id' }],
    options: { '--report-file': { dest: 'reportFile' }, '--packet-file': { dest: 'packetFile' } },
  },
  'send-back': { positionals: [{ name: 'id' }], options: NOTE },
  accept: { positionals: [{ name: 'id' }], options: { ...NOTE, '--skip-refuter': { dest: 'skipRefuter' }, '--read-by-orchestrator': { dest: 'readBy' }, '--widen': { dest: 'widen' }, '--gate': { dest: 'gate' }, '--quote': { dest: 'quote' } } },
merge: { positionals: [{ name: 'id' }], options: NOTE },
  cancel: { positionals: [{ name: 'id' }], options: NOTE },
  run: {
    positionals: [{ name: 'id' }],
    options: {
      '--engine': { dest: 'engine', default: 'codex' }, '--timeout': { dest: 'timeout', int: true }, '--model': { dest: 'model' },
    },
  },
};

const need = (v, name) => { if (!v) throw new UsageError('args.missing', { name }); return v; };

const isInvestigation = (task) => task.role === 'investigate';

function dispatchPrompt(task, cfg, briefPath) {
  const lang = LANGUAGE_NAME[cfg.language] || 'English';
  const inv = isInvestigation(task);
  const lines = [
    `crew-task: ${task.id}`,
    `crew-cli: ${common.cliCommand()}`,
    `You are the crew ${inv ? 'investigator' : 'worker'} for task ${task.id}: ${task.title}`,
    `Read your brief first: ${briefPath}`,
  ];
  if (task.worktree || task.branch) lines.push(`${inv ? 'Read only in' : 'Work only in'} worktree ${task.worktree || '(the worktree you were started in)'} on branch ${task.branch || '(current branch)'}.`);
  if (task.scope.allow.length) lines.push(`Allowed paths: ${task.scope.allow.join(', ')}`);
  if (task.scope.deny.length) lines.push(`Forbidden paths: ${task.scope.deny.join(', ')}`);
  lines.push(inv
    ? 'Read-only: change no project file and make no commit; write only your report and packet. No network, no downloads, no remote hosts. Do not use `git stash`; the stash list is shared by every worktree.'
    : 'Commit to your branch; never push. No network, no downloads, no remote hosts. Do not use `git stash`; the stash list is shared by every worktree.');
  lines.push(
    `When done, write the report in ${lang} (max ${cfg.limits.report_max_tokens} tokens) and a packet file with the details, then run:`,
    `  <crew-cli> task report ${task.id} --report-file <report.md> --packet-file <packet.md>`,
  );
  return lines.join('\n');
}

// The prompt of a re-dispatch: the create prompt, then the send-back note with its round number.
function resendPrompt(task, cfg, briefPath, note, max) {
  return `${dispatchPrompt(task, cfg, briefPath)}\n\nSend-back round ${task.returns} of ${max}: ${note}`;
}

// A Machine impact section must say what the run shows on the user's screen; the line `Visible to the user:` is the statement.
const VISIBLE_RE = /visible to the user\s*[:：]|對使用者可見\s*[:：]|使用者看得到\s*[:：]/i;
const lacksVisible = (brief) => !VISIBLE_RE.test((tasks.validateBrief(brief).sections.machine_impact) || '');

// Latest finalized findings of a task -> { round, total, by_severity, items } or null.
function findingsSummary(taskDir) {
  const round = review.latestRound(taskDir, 'json');
  if (!round) return null;
  let list;
  try { list = review.readArray(review.roundFile(taskDir, round, 'json'), 'findings'); } catch { return null; }
  const by = {};
  for (const f of list) by[f.severity] = (by[f.severity] || 0) + 1;
  return {
    round, total: list.length, by_severity: by,
    items: list.map((f) => ({
      id: f.id, severity: f.severity, category: f.category, file: f.file, line: f.line,
      verdict: f.verdict || '', claim: clean(f.claim || '', 160),
    })),
  };
}

// What the review of a task lacks at accept time -> { kind: 'none' } when no round was recorded,
// { kind: 'unfinalized', round, n } when the latest round has findings that never went through
// the refuter and `review finalize`, { kind: 'not_re_reviewed', round } when the task was sent back after
// its last finalized round (same rule as `crew release record`), or null when nothing is missing.
function reviewGap(taskDir, projectId, taskId) {
  const round = review.latestRound(taskDir, 'raw.json');
  if (!round) return { kind: 'none' };
  const finalized = review.latestRound(taskDir, 'json');
  if (finalized >= round) return notReReviewed(taskDir, finalized, projectId, taskId);
  const suffix = fs.existsSync(review.roundFile(taskDir, round, 'kept.json')) ? 'kept.json' : 'raw.json';
  let n = 0;
  try { n = review.readArray(review.roundFile(taskDir, round, suffix), 'findings').length; } catch { /* unreadable: nothing to count */ }
  if (n) return { kind: 'unfinalized', round, n };
  // a round submitted with no findings and never finalized is no review: without any finalized round the task has none
  return finalized ? notReReviewed(taskDir, finalized, projectId, taskId) : { kind: 'none' };
}

function notReReviewed(taskDir, finalized, projectId, taskId) {
  if (!finalized) return null;
  const mine = events.read(projectId).filter((e) => e.task === taskId);
  return release.returnedAfterRound(taskDir, finalized, mine) ? { kind: 'not_re_reviewed', round: finalized } : null;
}

// The review rule at accept time (review.enforce). `gap` is reviewGap's answer. -> null when there is nothing to record,
// else { met, data, unmet }: `data` goes on the accept event, `unmet` names the message parts when the rule is not met.
// A fix after a send-back (not_re_reviewed) is met when the commits since the last finalized round started change at most
// review.small_fix_lines lines and the orchestrator says what it read. With no finalized round at all it is met when every file is
// documentation (review.docs_globs) or the whole task is that small, with the same statement.
function reviewRule(proj, cfg, task, taskDir, gap, readBy) {
  const max = cfg.review.small_fix_lines;
  const note = readBy ? clean(readBy, 300) : '';
  if (!gap || (gap.kind !== 'not_re_reviewed' && gap.kind !== 'none')) {
    // a send-back that a later finalized round covered: record that it was (a)
    const round = review.latestRound(taskDir, 'json');
    const back = round && !gap && task.returns > 0;
    return back ? { met: true, data: { review_rule: { applied: 'later_round', round } } } : null;
  }
  let counted = null;
  let docs = false;
  let tipUnknown = false;
  if (gap.kind === 'not_re_reviewed') {
    const tip = (json.readJson(review.roundFile(taskDir, gap.round, 'tip.json'), {}).data || {}).tip;
    const now = common.branchTip(proj.path, task.branch);
    tipUnknown = !/^[0-9a-f]{7,64}$/.test(tip || '');
    if (!tipUnknown && now) counted = common.changedLines(proj.path, tip, now);
  } else {
    const tips = tasks.list(proj.id, { state: 'accepted' }).concat(tasks.list(proj.id, { state: 'merged' })).filter((t) => t.id !== task.id && t.scope_tip).map((t) => t.scope_tip);
    const r = common.scopeRange(proj.path, task.branch, tips, task.scope_base || '');
    if (!r.failed) counted = common.changedLines(proj.path, r.base, r.branch);
    const ci = process.platform === 'win32' || process.platform === 'darwin';
    docs = !!counted && counted.files.length > 0 && counted.files.every((f) => glob.matchAny(cfg.review.docs_globs, f, ci));
  }
  const lines = counted ? counted.lines : null;
  const small = lines !== null && lines <= max;
  const kind = gap.kind === 'none' ? 'no_review' : 'fix';
  const base = { kind, round: gap.round || null, lines, files: counted ? counted.files.length : null, max };
  if ((small || docs) && note) {
    const applied = kind === 'fix' ? 'read_by_orchestrator' : (docs ? 'docs_only_read' : 'small_read');
    return { met: true, data: { review_rule: { applied, ...base, note } } };
  }
  const size = lines === null ? 'wf.task.rule.sizeUnknown' : docs ? 'wf.task.rule.docsOnly' : 'wf.task.rule.size';
  const tail = small || docs ? 'wf.task.rule.tailRead' : kind === 'fix' && tipUnknown ? 'wf.task.rule.tailFull' : kind === 'fix' ? 'wf.task.rule.tailFix' : 'wf.task.rule.tailNone';
  return { met: false, data: { review_rule: { applied: 'none', ...base } }, unmet: { what: kind === 'fix' ? 'wf.task.rule.whatFix' : 'wf.task.rule.whatNone', size, tail, round: gap.round, lines, files: base.files, max } };
}

function diffStat(root, branch) {
  const r = common.branchRange(root, branch);
  if (!r) return null;
  const out = common.git(['diff', '--stat', r.base, r.branch], root);
  return out === null ? null : out.trim();
}

// The newest task.leftovers event of a task -> { count, programs, shared } or null. Whatever the worker reported.
function lastLeftovers(projectId, taskId) {
  try {
    const all = events.read(projectId, { types: 'task.leftovers' }).filter((e) => e.task === taskId);
    const e = all[all.length - 1];
    if (!e || !e.data) return null;
    if (e.data.skipped) return { skipped: String(e.data.skipped).slice(0, 60), count: 0, programs: {}, shared: false, ts: e.ts };
    return { count: Number(e.data.count) || 0, programs: e.data.programs || {}, shared: e.data.shared === true, ts: e.ts };
  } catch { return null; }
}

function showData(ctx, proj, task) {
  const dir = paths.taskDir(proj.id, task.id);
  const packet = path.join(dir, 'packet.md');
  return {
    task: {
      id: task.id, title: task.title, state: task.state, returns: task.returns, role: task.role,
      branch: task.branch, worktree: task.worktree, updated: task.updated,
      last_note: (task.history[task.history.length - 1] || {}).note || '',
      outside_plan: task.outside_plan || '',
    },
    brief_path: path.join(dir, 'brief.md'),
    report: tasks.readReport(proj.id, task.id),
    diff_stat: diffStat(proj.path, task.branch),
    packet_path: fs.existsSync(packet) ? packet : null,
    findings: findingsSummary(dir),
    leftovers: lastLeftovers(proj.id, task.id),
  };
}

function showLines(ctx, d, max) {
  const t = d.task;
  const L = [
    `${t.id}  ${t.state}  ${ctx.t('wf.task.returnsOf', { n: t.returns, max })}  ${t.title}`,
  ];
  if (t.branch) L.push(ctx.t('wf.task.branch', { branch: t.branch, worktree: t.worktree || '-' }));
  if (t.outside_plan) L.push(ctx.t('wf.task.outsidePlan', { reason: t.outside_plan }));
  if (t.last_note) L.push(ctx.t('wf.task.lastNote', { note: t.last_note }));
  if (d.leftovers && d.leftovers.skipped) L.push(ctx.t('wf.task.leftoversSkipped', { why: d.leftovers.skipped }));
  if (d.leftovers && d.leftovers.count > 0) {
    const programs = Object.entries(d.leftovers.programs).map(([k, v]) => `${k} x${v}`).join(', ');
    L.push(ctx.t('wf.task.leftovers', { count: d.leftovers.count, programs: programs || '-' }) + (d.leftovers.shared ? ctx.t('wf.task.leftoversShared') : ''));
  }
  L.push(ctx.t('wf.task.briefAt', { path: d.brief_path }));
  L.push('', ctx.t('wf.task.reportHead'));
  L.push(d.report ? d.report.trimEnd() : ctx.t('wf.task.noReport'));
  L.push('', ctx.t('wf.task.diffHead'));
  L.push(d.diff_stat === null ? ctx.t('wf.task.noDiff') : (d.diff_stat || ctx.t('wf.task.emptyDiff')));
  L.push('', d.packet_path ? ctx.t('wf.task.packetAt', { path: d.packet_path }) : ctx.t('wf.task.noPacket'));
  if (d.findings) {
    const sev = Object.entries(d.findings.by_severity).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    L.push('', ctx.t('wf.task.findingsHead', { round: d.findings.round, total: d.findings.total, sev }));
    for (const f of d.findings.items.slice(0, 10)) L.push(`  ${f.id} [${f.severity}] ${f.file}:${f.line} ${f.verdict ? `(${f.verdict}) ` : ''}${f.claim}`);
    if (d.findings.items.length > 10) L.push(ctx.t('wf.task.more', { n: d.findings.items.length - 10 }));
  } else {
    L.push('', ctx.t('wf.task.noFindings'));
  }
  return L;
}

// `crew task merge` is the authoritative merge record. When git shows the task branch is part of the
// current HEAD, also record a git.merge event with the real branch name and tip commit, unless a hook
// event already recorded this branch (same commit, or no commit and not older than the task).
// -> { status: 'recorded' | 'already' | 'not-merged' | 'no-branch', commit?, approved_by?, missing? }
// A recorded merge carries approved_by (the plan or gate answer that covers it) the same way the hook records it; with none,
// `missing` is true and the caller prints the hook's reminder.
function recordGitMerge(proj, task, cwd, cfg, workTree) {
  const branch = task.branch;
  if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(branch) || branch.includes('..')) return { status: 'no-branch' };
  const tip = common.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  const sha = tip && tip.trim();
  if (!sha) return { status: 'not-merged' };
  if (common.git(['merge-base', '--is-ancestor', sha, 'HEAD'], cwd) === null) return { status: 'not-merged' };
  const commit = sha.slice(0, 12);
  const seen = events.read(proj.id, { types: 'git.merge' }).some((e) => {
    const d = e.data || {};
    if (!Array.isArray(d.branches) || !d.branches.includes(branch)) return false;
    return d.commit ? String(d.commit).slice(0, 12) === commit : Date.parse(e.ts) >= Date.parse(task.created);
  });
  if (seen) return { status: 'already', commit };
  // where it was merged into: the current branch and work tree, so a hook event for the same branch merged elsewhere is kept
  const into = (common.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '').trim();
  const top = (common.git(['rev-parse', '--show-toplevel'], cwd) || '').trim();
  let covered = null;
  let missing = false;
  if (gates.modeOf(cfg, 'merge') === 'ask') {
    const G = require('../hooks/gatecheck');
    const h = { pid: proj.id, sid: gates.currentSession(), root: proj.path, workTree, cfg: () => cfg };
    const chk = G.check(h, new Map([['merge', { command: 'git merge', text: `git merge ${branch}`, items: [{ command: 'git merge', branches: [branch] }] }]]));
    covered = chk.by.get('merge') || null;
    missing = chk.missing.length > 0;
  }
  events.append(proj.id, {
    type: 'git.merge', src: 'cli', task: task.id,
    data: { command: 'crew task merge', branches: [branch], flags: [], commit, via: 'cli-merge', ...(covered ? { approved_by: covered } : {}), ...(into ? { target: into } : {}), ...(top ? { root: require('../core/project').normalizePath(top) } : {}) }, key: `merge:${branch}:${sha}`,
  });
  return { status: 'recorded', commit, ...(covered ? { approved_by: covered } : {}), ...(missing ? { missing: true } : {}) };
}

// `crew task accept` on a task of a final plan whose text no longer matches what the user approved (plan.enforce): block refuses, remind
// returns a warning line, off does nothing. A failure to read the plan lets the accept through and is recorded.
function planChangedOnAccept(ctx, proj, cfg, id) {
  const mode = cfg.plan.enforce;
  if (mode === 'off') return null;
  let slug;
  try { slug = plans.changedPlanOfTask(ctx.workTree() || proj.path, proj.id, id); } catch (e) {
    try { events.append(proj.id, { type: 'plan.check_failed', src: 'cli', task: id, data: { task: id, reason: clean(e && e.message, 120) }, key: `${id}:plan.check_failed:${Date.now()}` }); } catch { /* ignore */ }
    return null;
  }
  if (!slug) return null;
  const type = mode === 'remind' ? 'plan.drift_unasked' : 'plan.drift_denied';
  events.append(proj.id, { type, src: 'cli', task: id, data: { slug, task: id, kind: 'changed-text' }, key: `${id}:${type}:${Date.now()}` });
  if (mode !== 'remind') throw new CrewError('wf.task.acceptPlanChanged', { id, slug });
  return ctx.t('wf.task.acceptPlanChangedWarn', { id, slug });
}

// The files changed on a task's branch since its scope base (see common.scopeRange: the base stored at dispatch comes first),
// so files of an earlier accepted task on the same branch are not this task's. Both paths of a rename are listed (the old one was
// touched too). -> { files } or { failed: code, branch, repo } when it cannot be said.
function changedFiles(root, branch, proj, id) {
  const tips = proj ? tasks.list(proj.id, { state: 'accepted' }).concat(tasks.list(proj.id, { state: 'merged' })).filter((t) => t.id !== id && t.scope_tip).map((t) => t.scope_tip) : [];
  let stored = '';
  try { stored = (proj && tasks.load(proj.id, id).scope_base) || ''; } catch { /* none */ }
  const r = common.scopeRange(root, branch, tips, stored);
  if (r.failed) return { failed: r.failed, branch, repo: root, stale: r.stale };
  const out = common.git(['diff', '--name-only', '--no-renames', '-z', r.base, r.branch], root);
  if (out === null) return { failed: 'git-diff', branch, repo: root };
  return { files: out.split('\0').filter(Boolean), stale: r.stale };
}

const evAppend = (proj, type, id, data, session) => {
  try { events.append(proj.id, { type, src: 'cli', task: id, session, data: { task: id, ...data }, key: `${id}:${type}:${Date.now()}` }); } catch { /* ignore */ }
};
const listFiles = (files) => files.slice(0, 20).join(', ') + (files.length > 20 ? ` (+${files.length - 20} more)` : '');

// Takes the user's reply to a task_scope gate asked for this task, once. A gate already answered is judged by what is stored.
function takeWiden(proj, id, gateId, quote) {
  const asked = events.read(proj.id, { types: ['gate.asked'] }).find((e) => e.data && e.data.id === gateId);
  if (!asked || asked.data.gate !== 'task_scope' || asked.task !== id) throw new CrewError('wf.task.widenBadGate', { id, gate: gateId });
  if (events.read(proj.id, { types: ['task.scope_widened'] }).some((e) => e.data && e.data.gate === gateId)) throw new CrewError('wf.task.widenUsed', { gate: gateId });
  const session = gates.currentSession();
  const prior = events.read(proj.id, { types: ['gate.answered'] }).find((e) => e.data && e.data.id === gateId);
  const ans = prior ? prior.data : gates.answer(proj.id, gateId, 'yes', '', { ...sess.answerOptions(proj.id, session, quote), requireUserTurn: true });
  if (ans.answer !== 'yes') throw new CrewError('wf.task.widenNo', { id });
  if (ans.user_turn !== true && ans.user_turn !== 'project' && ans.user_turn !== 'instruction') throw new CrewError('gate.needUserReply', { id: gateId });
}

// `crew task accept`: the files really changed against the task's --allow and --deny (plan.enforce). -> { lines, after, asked } where
// `after` runs once the task is accepted and `asked` is a task_scope gate that was just asked (nothing is accepted then).
// A task with no scope, and plan.enforce off, read no diff. A git failure never blocks: it is printed and recorded.
function scopeOnAccept(ctx, proj, cfg, id, a) {
  const none = { lines: [], after: null, asked: null };
  const mode = cfg.plan.enforce;
  if (mode === 'off') return none;
  const task = tasks.load(proj.id, id);
  if (!task.scope.allow.length && !task.scope.deny.length) return none;
  const session = gates.currentSession();
  const got = changedFiles(proj.path, task.branch, proj, id);
  none.lines = got.stale ? [ctx.t('wf.task.scopeStale', { id, branch: task.branch })] : [];
  if (got.failed) {
    evAppend(proj, 'task.scope_check_failed', id, { reason: got.failed, branch: got.branch || '', repo: got.repo }, session);
    return { ...none, lines: [...none.lines, ctx.t('wf.task.scopeCheckFailed', { id, reason: ctx.t(`wf.task.scopeWhy.${got.failed}`, { branch: got.branch || '-', repo: got.repo }) })] };
  }
  const files = drift.outsideFiles(task.scope, got.files, process.platform === 'win32' || process.platform === 'darwin');
  if (!files.length) return none;
  const list = listFiles(files);
  if (mode === 'remind') {
    return { ...none, lines: [...none.lines, ctx.t('wf.task.scopeWarn', { id, files: list })], after: () => evAppend(proj, 'task.scope_warned', id, { files: files.slice(0, 50), count: files.length }, session) };
  }
  const root = ctx.workTree() || proj.path;
  const slug = plans.finalPlanOfTask(root, proj.id, id);
  if (slug) {
    if (drift.covered(root, proj.id, slug, 'out-of-scope', session)) return none;
    evAppend(proj, 'plan.drift_denied', id, { slug, kind: 'out-of-scope' }, session);
    if (got.stale) ctx.err(none.lines[0]);
    throw new CrewError('wf.task.acceptOutOfScopePlan', { id, slug, files: list });
  }
  if (a.widen === undefined) {
    if (got.stale) ctx.err(none.lines[0]);
    throw new CrewError('wf.task.acceptOutOfScope', { id, files: list });
  }
  if (!a.gate) {
    const g = gates.ask(proj.id, { ...cfg, gates: { ...cfg.gates, task_scope: 'ask' } }, { gate: 'task_scope', task: id, detail: `widen the scope of task ${id}: ${clean(a.widen, 200)}; files ${clean(list, 200)}` }, { src: 'cli', session });
    return { ...none, asked: { gate_id: g.id, files } };
  }
  takeWiden(proj, id, a.gate, a.quote);
  return { ...none, after: () => evAppend(proj, 'task.scope_widened', id, { reason: clean(a.widen, 500), files: files.slice(0, 50), gate: a.gate }, session) };
}

// `crew task accept` of an investigation (role investigate): it has no diff, so neither the scope check nor the review rule applies.
// What it must not have is a change to the project: commits on its branch or changes in its worktree refuse the accept.
function acceptInvestigation(ctx, proj, cfg, task, a, opts) {
  const lines = [];
  const files = [];
  if (task.branch) {
    const got = changedFiles(proj.path, task.branch, proj, task.id);
    if (got.files) files.push(...got.files);
    else if (got.failed !== 'no-commits' && got.failed !== 'no-branch') lines.push(ctx.t('wf.task.scopeCheckFailed', { id: task.id, reason: ctx.t(`wf.task.scopeWhy.${got.failed}`, { branch: got.branch || '-', repo: got.repo }) }));
  }
  if (task.worktree && fs.existsSync(task.worktree)) {
    const out = common.git(['status', '--porcelain', '-z'], task.worktree);
    for (const e of (out || '').split('\0').filter(Boolean)) if (!files.includes(e.slice(3))) files.push(e.slice(3));
  }
  if (files.length) throw new CrewError('wf.task.acceptInvestigationChanged', { id: task.id, files: listFiles(files) });
  const done = tasks.transition(proj.id, task.id, 'accepted', { ...opts, note: a.note || '' });
  ctx.emit({ task: done, investigation: true }, [ctx.t('wf.task.accepted', { id: done.id }), ctx.t('wf.task.acceptedInvestigation'), ...lines]);
  return 0;
}

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('wf.task.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const proj = ctx.requireProject();
  const cfg = ctx.config().config;
  const max = cfg.limits.max_returns_before_takeover;
  const opts = { src: 'cli', maxReturns: max };

  if (sub === 'create') {
    need(a.title, '--title');
    need(a.briefFile, '--brief-file');
    const brief = common.readText(a.briefFile, 'brief');
    const role = a.role || 'worker';
    if (a.outsidePlan !== undefined) {
      if (a.plan) throw new UsageError('wf.task.outsideWithPlan');
      if (!a.outsidePlan.trim()) throw new UsageError('wf.task.outsideEmpty');
    }
    // check the plan target before the task exists, so a typo leaves no orphan task
    let planRef = null;
    if (a.plan) {
      const m = /^([a-z0-9-]{1,40}):(\S+)$/.exec(a.plan);
      if (!m) throw new UsageError('plan.badTarget');
      const doc = plans.readCapped(ctx.workTree(), m[1]);
      if (!doc) throw new CrewError('plan.notFound', { slug: m[1] });
      plans.find(doc, m[2]);
      planRef = { slug: m[1], node: m[2] };
    }
    // a task with no plan while a plan is final raises the drift question; --outside-plan is the way out for an unrelated small fix
    const root = ctx.workTree() || proj.path;
    const unlinked = !planRef && a.outsidePlan === undefined ? drift.unlinkedCheck(root, proj.id, cfg, { session: gates.currentSession() }) : null;
    const task = tasks.createTask(proj.id, {
      title: a.title, brief, role, branch: common.checkBranch(a.branch || ''), worktree: a.worktree || '',
      scope: { allow: common.splitList(a.allow), deny: common.splitList(a.deny) },
      outsidePlan: a.outsidePlan === undefined ? '' : a.outsidePlan.trim(),
    }, { src: 'cli' });
    if (a.outsidePlan !== undefined) evAppend(proj, 'task.outside_plan', task.id, { reason: task.outside_plan, plans: plans.finalSlugs(root, proj.id) }, gates.currentSession());
    drift.noteUnlinked(proj.id, unlinked, task.id);
    if (planRef) planRef.node = plans.linkTo(ctx.workTree(), proj.id, planRef.slug, planRef.node, task.id).id;
    const briefPath = path.join(paths.taskDir(proj.id, task.id), 'brief.md');
    const prompt = dispatchPrompt(task, cfg, briefPath);
    const roleCfg = cfg.roles[role] || {};
    const busy = tasks.list(proj.id, { state: 'dispatched' }).length;
    const data = {
      task, marker: `crew-task: ${task.id}`, brief_path: briefPath, cli: common.cliCommand(), prompt,
      subagent_type: roleCfg.agent || (isInvestigation(task) ? 'crew-investigator' : 'crew-worker'), model: roleCfg.model || 'sonnet',
      in_flight: busy, max_parallel_workers: cfg.limits.max_parallel_workers,
      ...(planRef ? { plan: planRef } : {}),
      ...(lacksVisible(brief) ? { warnings: ['machine_impact_visible'] } : {}),
    };
    const L = [
      ctx.t('wf.task.created', { id: task.id }),
      ctx.t('wf.task.marker'), data.marker, '',
      ctx.t('wf.task.agentHint', { agent: data.subagent_type, model: data.model }),
      '--- prompt ---', prompt, '--- end ---',
    ];
    if (planRef) L.splice(1, 0, ctx.t('plan.taskLinked', planRef));
    if (unlinked && unlinked.warn) L.splice(1, 0, ctx.t('plan.driftUnlinkedWarn', { slugs: unlinked.slugs.join(', '), slug: unlinked.slugs[0] }));
    if (data.warnings) L.splice(1, 0, ctx.t('wf.task.visibleWarn'));
    if (busy >= cfg.limits.max_parallel_workers) L.push(ctx.t('wf.task.parallelWarn', { n: busy, max: cfg.limits.max_parallel_workers }));
    ctx.emit(data, L);
  } else if (sub === 'run') {
    const timeoutS = a.timeout === undefined ? codexrun.DEFAULT_TIMEOUT_S : a.timeout;
    if (!(timeoutS >= 1)) throw new UsageError('args.badChoice', { name: '--timeout', choices: '>= 1' });
    if (a.engine === 'claude') throw new UsageError('wf.task.run.claude');
    return codexrun.runCodex(ctx, proj, cfg, tasks.load(proj.id, a.id), { engine: a.engine, model: a.model || '', timeoutS, workTree: ctx.workTree() });
  } else if (sub === 'list') {
    const rows = tasks.list(proj.id, a.state ? { state: a.state } : {});
    ctx.emit(rows, rows.length
      ? rows.map((t) => `${t.id}  ${t.state.padEnd(10)}  ${ctx.t('wf.task.returnsOf', { n: t.returns, max })}  ${t.title}`)
      : [ctx.t('wf.task.empty')]);
  } else if (sub === 'show') {
    const cur = tasks.load(proj.id, a.id);
    if (a.prompt) {
      const briefPath = path.join(paths.taskDir(proj.id, cur.id), 'brief.md');
      const back = cur.returns > 0 ? [...(cur.history || [])].reverse().find((h) => h.state === 'dispatched') : null;
      const prompt = back ? resendPrompt(cur, cfg, briefPath, back.note, max) : dispatchPrompt(cur, cfg, briefPath);
      return ctx.emit({ id: cur.id, prompt, subagent_type: (cfg.roles[cur.role] || {}).agent || (isInvestigation(cur) ? 'crew-investigator' : 'crew-worker') }, prompt);
    }
    const d = showData(ctx, proj, cur);
    ctx.emit(d, showLines(ctx, d, max));
  } else if (sub === 'report') {
    need(a.reportFile, '--report-file');
    const report = common.readText(a.reportFile, 'report');
    const packet = a.packetFile ? common.readText(a.packetFile, 'packet') : '';
    const cur = tasks.load(proj.id, a.id);
    if (!['created', 'dispatched', 'returned'].includes(cur.state)) throw new CrewError('wf.task.reportState', { id: cur.id, state: cur.state });
    // validate first so a bad report never moves the task
    const v = tasks.validateReport(report, { maxTokens: cfg.limits.report_max_tokens, role: cur.role });
    if (!v.ok) {
      const err = new CrewError('task.reportInvalid', {
        problems: v.errors.map((e) => (e.code === 'too_long' ? `too long (${e.tokens} > ${e.max} tokens)` : `${e.code.replace('_', ' ')}: ${e.section}`)).join('; '),
      });
      err.errors = v.errors;
      throw err;
    }
    if (cur.state === 'created') tasks.transition(proj.id, cur.id, 'dispatched', { ...opts, note: 'dispatched implicitly by report', data: { via: 'cli-report' } });
    const { task, tokens } = tasks.recordReport(proj.id, cur.id, { report, packet }, { ...opts, maxTokens: cfg.limits.report_max_tokens, data: { via: 'cli-report' } });
    ctx.emit({ task, tokens, limit: cfg.limits.report_max_tokens }, ctx.t('wf.task.reported', { id: task.id, tokens, max: cfg.limits.report_max_tokens }));
  } else if (sub === 'send-back') {
    const note = need(a.note, '--note');
    let task;
    const cur = tasks.load(proj.id, a.id);
    // the core treats same-state moves as no-ops; a send-back of a task that is not back yet is a mistake
    if (!['returned', 'reviewing'].includes(cur.state)) throw new CrewError('task.badTransition', { id: cur.id, from: cur.state, to: 'dispatched' });
    try {
      task = tasks.sendBack(proj.id, a.id, { ...opts, note });
    } catch (e) {
      if (e && e.key === 'task.takeover') {
        lessons.add(ctx.workTree() || proj.path, proj.id, {
          key: 'takeover-limit', kind: 'takeover',
          text: `Task ${a.id} hit the send-back limit (${max}); the orchestrator had to take it over. Last note: ${note}`,
        });
        ctx.err(ctx.t('wf.task.takeoverLesson'));
      }
      throw e;
    }
    const prompt = resendPrompt(task, cfg, path.join(paths.taskDir(proj.id, task.id), 'brief.md'), note, max);
    ctx.emit({ task, returns: task.returns, max, prompt }, [ctx.t('wf.task.sentBack', { id: task.id, n: task.returns, max }), '--- prompt ---', prompt, '--- end ---']);
  } else if (sub === 'accept') {
    const asked = tasks.load(proj.id, a.id);
    if (isInvestigation(asked)) return acceptInvestigation(ctx, proj, cfg, asked, a, opts);
    const changedWarn = planChangedOnAccept(ctx, proj, cfg, a.id);
    const taskDir = paths.taskDir(proj.id, a.id);
    const gap = reviewGap(taskDir, proj.id, a.id);
    // Findings nobody tried to refute are what the review exists to catch: going past them takes a stated reason.
    if (gap && gap.kind === 'unfinalized' && !a.skipRefuter) throw new CrewError('wf.task.acceptUnfinalized', { id: a.id, round: gap.round, n: gap.n });
    const skipped = gap && gap.kind === 'unfinalized' ? { review_gap: gap, skip_refuter: a.skipRefuter } : null;
    let ruleLine = null;
    let ruleEvent = null;
    let ruleData = null;
    if (cfg.review.enforce !== 'off') {
      const rule = reviewRule(proj, cfg, tasks.load(proj.id, a.id), taskDir, gap, a.readBy);
      if (rule && rule.met) ruleData = rule.data;
      else if (rule) {
        const u = rule.unmet;
        const text = [
          ctx.t(cfg.review.enforce === 'block' ? 'wf.task.rule.refused' : 'wf.task.rule.warned', { id: a.id, mode: cfg.review.enforce, what: ctx.t(u.what, { round: u.round }) }),
          ...(u.tail === 'wf.task.rule.tailFull' ? [] : [ctx.t(u.size, { lines: u.lines, files: u.files, max: u.max })]),
          ctx.t(u.tail, { id: a.id, round: u.round }),
        ].join(' ');
        if (cfg.review.enforce === 'block') throw new CrewError('wf.task.ruleUnmet', { text });
        ruleLine = text;
        ruleData = rule.data;
        ruleEvent = { ...rule.data.review_rule };
      }
    }
    if (a.gate !== undefined && a.widen === undefined) throw new UsageError('args.missing', { name: '--widen' });
    if (a.widen !== undefined && !a.widen.trim()) throw new UsageError('args.missing', { name: '--widen' });
    const scope = scopeOnAccept(ctx, proj, cfg, a.id, a);
    if (scope.asked) {
      return ctx.emit({ gate_id: scope.asked.gate_id, files: scope.asked.files }, [
        ctx.t('wf.task.widenAsked', { id: a.id, gate: scope.asked.gate_id, files: listFiles(scope.asked.files) }),
        ctx.t('wf.task.widenNext', { id: a.id, gate: scope.asked.gate_id, reason: clean(a.widen, 200) }),
      ]);
    }
    const task = tasks.transition(proj.id, a.id, 'accepted', { ...opts, note: a.note || '', data: skipped || ruleData ? { ...skipped, ...ruleData } : undefined });
    if (ruleEvent) evAppend(proj, 'review.rule_unmet', a.id, ruleEvent);
    if (scope.after) scope.after();
    try { const tip = common.branchTip(proj.path, task.branch); if (tip) tasks.recordScopeTip(proj.id, a.id, tip); } catch { /* ignore */ }
    const open = (findingsSummary(taskDir) || { items: [] }).items.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const L = [ctx.t('wf.task.accepted', { id: task.id }), ...(changedWarn ? [changedWarn] : []), ...scope.lines];
    if (ruleLine) L.push(ruleLine);
    if (ruleData && ruleData.review_rule.note) L.push(ctx.t('wf.task.rule.recorded', { lines: ruleData.review_rule.lines === null ? '?' : ruleData.review_rule.lines, note: ruleData.review_rule.note }));
    if (open.length) L.push(ctx.t('wf.task.acceptedWithFindings', { n: open.length, ids: open.map((f) => f.id).join(', ') }));
    if (gap) {
      if (gap.kind === 'none') L.push(ctx.t('wf.task.acceptedNoReview'));
      else if (gap.kind === 'not_re_reviewed') L.push(ctx.t('wf.task.acceptedNotReReviewed', { round: gap.round }));
      else L.push(ctx.t('wf.task.acceptedUnfinalized', { round: gap.round, n: gap.n }));
    }
    ctx.emit({ task, open_findings: open, review_gap: gap, ...(ruleData ? { review_rule: ruleData.review_rule } : {}), ...(skipped ? { skip_refuter: a.skipRefuter } : {}) }, L);
  } else if (sub === 'merge') {
    if (cfg.gates.merge === 'never') throw new CrewError('wf.task.mergeNever');
    const before = tasks.load(proj.id, a.id);
    const task = tasks.transition(proj.id, a.id, 'merged', { ...opts, note: a.note || '', data: { branch: before.branch || null, via: 'cli-merge' } });
    const git = recordGitMerge(proj, task, ctx.workTree() || proj.path, cfg, ctx.workTree() || proj.path);
    const L = [ctx.t('wf.task.merged', { id: task.id })];
    if (git.status === 'recorded') L.push(ctx.t('wf.task.mergeGit', { branch: task.branch, commit: git.commit }));
    if (git.missing) L.push(ctx.t('hooks.gate.missing', { what: 'git merge', gate: 'merge', cmd: common.cliCommand() }));
    ctx.emit({ task, git_merge: git }, L);
  } else {
    const task = tasks.transition(proj.id, a.id, 'cancelled', { ...opts, note: a.note || '' });
    ctx.emit({ task }, ctx.t('wf.task.cancelled', { id: task.id }));
  }
  return 0;
}

module.exports = {
  name: 'task',
  summary: { en: 'Create, track, review-gate and merge delegated tasks', 'zh-TW': '建立、追蹤、驗收與合併分派出去的任務' },
  usage: {
    en: [
      '  crew task create --title T --brief-file F [--role worker|investigate] [--branch B] [--worktree W] [--allow G] [--deny G] [--plan SLUG:NODE | --outside-plan "reason"]',
      '  crew task list [--state S]',
      '  crew task show <id> [--prompt]',
      '  crew task report <id> --report-file F [--packet-file F]   (used by the worker)',
      '  crew task send-back <id> --note "..."',
      '  crew task accept <id> [--note "..."] [--skip-refuter "reason"] [--read-by-orchestrator "what was read"] [--widen "reason" [--gate ID]]   (the reason is needed when a review round was not finalized; --read-by-orchestrator accepts a small fix after a send-back, or a documentation-only or small task with no review, that the orchestrator read (review.enforce); --widen takes files outside the scope after the user agrees)',
      '  crew task merge <id> [--note "..."]    (records the merge; it does not run git)',
      '  crew task cancel <id> [--note "..."]',
      '  crew task run <id> [--engine codex] [--timeout 1800] [--model M]   (run a Codex CLI worker in the task worktree)',
    ].join('\n'),
    'zh-TW': [
      '  crew task create --title T --brief-file F [--role worker|investigate] [--branch B] [--worktree W] [--allow G] [--deny G] [--plan SLUG:NODE | --outside-plan "reason"]',
      '  crew task list [--state S]',
      '  crew task show <id> [--prompt]',
      '  crew task report <id> --report-file F [--packet-file F]   （worker 使用）',
      '  crew task send-back <id> --note "..."',
      '  crew task accept <id> [--note "..."] [--skip-refuter "原因"] [--read-by-orchestrator "讀了什麼"] [--widen "原因" [--gate ID]]   （審查輪次沒有定案時必須說明原因；--read-by-orchestrator 用來接受統籌自己讀過的、被退回後的小修正，或沒有審查的純文件／小任務（review.enforce）；--widen 在使用者同意後接受範圍外的檔案）',
      '  crew task merge <id> [--note "..."]    （只記錄合併，不執行 git）',
      '  crew task cancel <id> [--note "..."]',
      '  crew task run <id> [--engine codex] [--timeout 1800] [--model M]   (run a Codex CLI worker in the task worktree)',
    ].join('\n'),
  },
  run,
  // exported for tests
  dispatchPrompt,
};
