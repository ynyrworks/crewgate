'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const tasks = require('../core/tasks');
const paths = require('../core/paths');
const { clean } = require('../core/redact');
const { LANGUAGE_NAME } = require('../features/init');
const common = require('../features/common');
const review = require('../features/review');
const lessons = require('../features/lessons');

const STATES = tasks.STATES;
const NOTE = { '--note': { dest: 'note' } };
const SPECS = {
  create: {
    positionals: [],
    options: {
      '--title': { dest: 'title' }, '--brief-file': { dest: 'briefFile' }, '--role': { dest: 'role' },
      '--branch': { dest: 'branch' }, '--worktree': { dest: 'worktree' },
      '--allow': { dest: 'allow', multi: true }, '--deny': { dest: 'deny', multi: true },
    },
  },
  list: { positionals: [], options: { '--state': { dest: 'state', choices: STATES } } },
  show: { positionals: [{ name: 'id' }], options: {} },
  report: {
    positionals: [{ name: 'id' }],
    options: { '--report-file': { dest: 'reportFile' }, '--packet-file': { dest: 'packetFile' } },
  },
  'send-back': { positionals: [{ name: 'id' }], options: NOTE },
  accept: { positionals: [{ name: 'id' }], options: NOTE },
  merge: { positionals: [{ name: 'id' }], options: NOTE },
  cancel: { positionals: [{ name: 'id' }], options: NOTE },
};

const need = (v, name) => { if (!v) throw new UsageError('args.missing', { name }); return v; };

function dispatchPrompt(task, cfg, briefPath) {
  const lang = LANGUAGE_NAME[cfg.language] || 'English';
  const lines = [
    `crew-task: ${task.id}`,
    `crew-cli: ${common.cliCommand()}`,
    `You are the crew worker for task ${task.id}: ${task.title}`,
    `Read your brief first: ${briefPath}`,
  ];
  if (task.worktree || task.branch) lines.push(`Work only in worktree ${task.worktree || '(the worktree you were started in)'} on branch ${task.branch || '(current branch)'}.`);
  if (task.scope.allow.length) lines.push(`Allowed paths: ${task.scope.allow.join(', ')}`);
  if (task.scope.deny.length) lines.push(`Forbidden paths: ${task.scope.deny.join(', ')}`);
  lines.push(
    'Commit to your branch; never push. No network, no downloads, no remote hosts.',
    `When done, write the report in ${lang} (max ${cfg.limits.report_max_tokens} tokens) and a packet file with the details, then run:`,
    `  <crew-cli> task report ${task.id} --report-file <report.md> --packet-file <packet.md>`,
  );
  return lines.join('\n');
}

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

function diffStat(root, branch) {
  const r = common.branchRange(root, branch);
  if (!r) return null;
  const out = common.git(['diff', '--stat', r.base, r.branch], root);
  return out === null ? null : out.trim();
}

function showData(ctx, proj, task) {
  const dir = paths.taskDir(proj.id, task.id);
  const packet = path.join(dir, 'packet.md');
  return {
    task: {
      id: task.id, title: task.title, state: task.state, returns: task.returns, role: task.role,
      branch: task.branch, worktree: task.worktree, updated: task.updated,
      last_note: (task.history[task.history.length - 1] || {}).note || '',
    },
    brief_path: path.join(dir, 'brief.md'),
    report: tasks.readReport(proj.id, task.id),
    diff_stat: diffStat(proj.path, task.branch),
    packet_path: fs.existsSync(packet) ? packet : null,
    findings: findingsSummary(dir),
  };
}

function showLines(ctx, d, max) {
  const t = d.task;
  const L = [
    `${t.id}  ${t.state}  ${ctx.t('wf.task.returnsOf', { n: t.returns, max })}  ${t.title}`,
  ];
  if (t.branch) L.push(ctx.t('wf.task.branch', { branch: t.branch, worktree: t.worktree || '-' }));
  if (t.last_note) L.push(ctx.t('wf.task.lastNote', { note: t.last_note }));
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
    const task = tasks.createTask(proj.id, {
      title: a.title, brief, role, branch: common.checkBranch(a.branch || ''), worktree: a.worktree || '',
      scope: { allow: common.splitList(a.allow), deny: common.splitList(a.deny) },
    }, { src: 'cli' });
    const briefPath = path.join(paths.taskDir(proj.id, task.id), 'brief.md');
    const prompt = dispatchPrompt(task, cfg, briefPath);
    const roleCfg = cfg.roles[role] || {};
    const busy = tasks.list(proj.id, { state: 'dispatched' }).length;
    const data = {
      task, marker: `crew-task: ${task.id}`, brief_path: briefPath, cli: common.cliCommand(), prompt,
      subagent_type: roleCfg.agent || 'crew-worker', model: roleCfg.model || 'sonnet',
      in_flight: busy, max_parallel_workers: cfg.limits.max_parallel_workers,
    };
    const L = [
      ctx.t('wf.task.created', { id: task.id }),
      ctx.t('wf.task.marker'), data.marker, '',
      ctx.t('wf.task.agentHint', { agent: data.subagent_type, model: data.model }),
      '--- prompt ---', prompt, '--- end ---',
    ];
    if (busy >= cfg.limits.max_parallel_workers) L.push(ctx.t('wf.task.parallelWarn', { n: busy, max: cfg.limits.max_parallel_workers }));
    ctx.emit(data, L);
  } else if (sub === 'list') {
    const rows = tasks.list(proj.id, a.state ? { state: a.state } : {});
    ctx.emit(rows, rows.length
      ? rows.map((t) => `${t.id}  ${t.state.padEnd(10)}  ${ctx.t('wf.task.returnsOf', { n: t.returns, max })}  ${t.title}`)
      : [ctx.t('wf.task.empty')]);
  } else if (sub === 'show') {
    const d = showData(ctx, proj, tasks.load(proj.id, a.id));
    ctx.emit(d, showLines(ctx, d, max));
  } else if (sub === 'report') {
    need(a.reportFile, '--report-file');
    const report = common.readText(a.reportFile, 'report');
    const packet = a.packetFile ? common.readText(a.packetFile, 'packet') : '';
    const cur = tasks.load(proj.id, a.id);
    if (!['created', 'dispatched', 'returned'].includes(cur.state)) throw new CrewError('wf.task.reportState', { id: cur.id, state: cur.state });
    // validate first so a bad report never moves the task
    const v = tasks.validateReport(report, { maxTokens: cfg.limits.report_max_tokens });
    if (!v.ok) {
      const err = new CrewError('task.reportInvalid', {
        problems: v.errors.map((e) => (e.code === 'too_long' ? `too long (${e.tokens} > ${e.max} tokens)` : `${e.code.replace('_', ' ')}: ${e.section}`)).join('; '),
      });
      err.errors = v.errors;
      throw err;
    }
    if (cur.state === 'created') tasks.transition(proj.id, cur.id, 'dispatched', { ...opts, note: 'dispatched implicitly by report' });
    const { task, tokens } = tasks.recordReport(proj.id, cur.id, { report, packet }, { ...opts, maxTokens: cfg.limits.report_max_tokens });
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
        lessons.add(proj.path, proj.id, {
          key: 'takeover-limit', kind: 'takeover',
          text: `Task ${a.id} hit the send-back limit (${max}); the orchestrator had to take it over. Last note: ${note}`,
        });
        ctx.err(ctx.t('wf.task.takeoverLesson'));
      }
      throw e;
    }
    ctx.emit({ task, returns: task.returns, max }, ctx.t('wf.task.sentBack', { id: task.id, n: task.returns, max }));
  } else if (sub === 'accept') {
    const task = tasks.transition(proj.id, a.id, 'accepted', { ...opts, note: a.note || '' });
    const open = (findingsSummary(paths.taskDir(proj.id, task.id)) || { items: [] }).items.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const L = [ctx.t('wf.task.accepted', { id: task.id })];
    if (open.length) L.push(ctx.t('wf.task.acceptedWithFindings', { n: open.length, ids: open.map((f) => f.id).join(', ') }));
    ctx.emit({ task, open_findings: open }, L);
  } else if (sub === 'merge') {
    if (cfg.gates.merge === 'never') throw new CrewError('wf.task.mergeNever');
    const task = tasks.transition(proj.id, a.id, 'merged', { ...opts, note: a.note || '' });
    ctx.emit({ task }, ctx.t('wf.task.merged', { id: task.id }));
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
      '  crew task create --title T --brief-file F [--role worker] [--branch B] [--worktree W] [--allow G] [--deny G]',
      '  crew task list [--state S]',
      '  crew task show <id>',
      '  crew task report <id> --report-file F [--packet-file F]   (used by the worker)',
      '  crew task send-back <id> --note "..."',
      '  crew task accept <id> [--note "..."]',
      '  crew task merge <id> [--note "..."]    (records the merge; it does not run git)',
      '  crew task cancel <id> [--note "..."]',
    ].join('\n'),
    'zh-TW': [
      '  crew task create --title T --brief-file F [--role worker] [--branch B] [--worktree W] [--allow G] [--deny G]',
      '  crew task list [--state S]',
      '  crew task show <id>',
      '  crew task report <id> --report-file F [--packet-file F]   （worker 使用）',
      '  crew task send-back <id> --note "..."',
      '  crew task accept <id> [--note "..."]',
      '  crew task merge <id> [--note "..."]    （只記錄合併，不執行 git）',
      '  crew task cancel <id> [--note "..."]',
    ].join('\n'),
  },
  run,
  // exported for tests
  dispatchPrompt,
};
