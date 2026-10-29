'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const execx = require('../core/exec');
const config = require('../core/config');
const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const tasks = require('../core/tasks');
const paths = require('../core/paths');
const events = require('../core/events');
const json = require('../core/json');
const { clean } = require('../core/redact');
const common = require('../features/common');
const rv = require('../features/review');
const lessons = require('../features/lessons');

const ROUND = { '--round': { dest: 'round', int: true } };
const SPECS = {
  run: { positionals: [{ name: 'task' }], options: { '--engine': { dest: 'engine' }, ...ROUND } },
  submit: {
    positionals: [{ name: 'task' }],
    options: { '--kind': { dest: 'kind', choices: ['findings', 'refutations'], default: 'findings' }, '--file': { dest: 'file' }, ...ROUND },
  },
  filter: { positionals: [{ name: 'task' }], options: ROUND },
  finalize: { positionals: [{ name: 'task' }], options: { '--refutations-file': { dest: 'refFile' }, ...ROUND } },
  show: { positionals: [{ name: 'task' }], options: ROUND },
  dismiss: {
    positionals: [{ name: 'task' }, { name: 'finding' }],
    options: {
      '--scope': { dest: 'scope', choices: ['once', 'always'] }, '--reason': { dest: 'reason' },
      '--by': { dest: 'by', default: 'orchestrator' },
    },
  },
};

const need = (v, name) => { if (!v) throw new UsageError('args.missing', { name }); return v; };
const q = (p) => `"${p}"`;

function ctxOf(ctx, taskId) {
  const proj = ctx.requireProject();
  const loaded = ctx.config();
  const cfg = loaded.config;
  const task = tasks.load(proj.id, taskId);
  const dir = paths.taskDir(proj.id, task.id);
  fs.mkdirSync(rv.findingsDir(dir), { recursive: true });
  return { proj, cfg, task, dir, warnings: loaded.warnings || [] };
}

function baseDirs(c) {
  const out = [];
  if (c.task.worktree && fs.existsSync(c.task.worktree)) out.push(c.task.worktree);
  out.push(c.proj.path);
  return out;
}

function diffCommand(c) {
  const r = common.branchRange(c.proj.path, c.task.branch);
  if (r) return `git -C ${q(c.proj.path)} diff ${r.base} ${r.branch}`;
  return `git diff   (run it in ${c.task.worktree || 'the task worktree'}; compare the task branch with its base)`;
}

function nextRound(c, opts) { return opts.round || rv.latestRound(c.dir, 'raw.json') + 1; }

function currentRound(c, opts, suffix) {
  const r = opts.round || rv.latestRound(c.dir, suffix);
  if (!r) throw new CrewError('wf.review.noRound', { what: suffix });
  return r;
}

// ---------------------------------------------------------------- run
function externalPrompt(c, round) {
  const range = common.branchRange(c.proj.path, c.task.branch);
  if (!range) throw new CrewError('wf.review.noDiff', { id: c.task.id });
  let diff = common.git(['diff', range.base, range.branch], c.proj.path, 60000) || '';
  let note = '';
  if (Buffer.byteLength(diff) > rv.MAX_DIFF_BYTES) {
    diff = Buffer.from(diff).subarray(0, rv.MAX_DIFF_BYTES).toString('utf8');
    note = '\n[diff truncated]\n';
  }
  const brief = tasks.readBrief(c.proj.id, c.task.id) || '';
  let rules = '';
  try { rules = fs.readFileSync(path.join(c.proj.path, '.crew', 'REVIEW.md'), 'utf8'); } catch { /* optional */ }
  const f = common.fence(diff + brief + rules);
  return [
    `You are a code reviewer (round ${round}). You cannot edit files. Review the diff against the brief and the review rules.`,
    `Allowed categories: ${c.cfg.review.categories.join(', ')}.`,
    rv.SCHEMA_TEXT,
    'Reply with the JSON array only.',
    '', '## Brief', f, brief.trim(), f,
    '', '## Review rules', f, rules.trim(), f,
    '', '## Diff', f, diff.trimEnd(), f, note,
  ].join('\n');
}

function runEngine(c, name, round) {
  const eng = config.globalEngines()[name];
  if (!eng || !eng.command) throw new CrewError('wf.review.noEngine', { name });
  const input = externalPrompt(c, round);
  const file = execx.resolveCommand(eng.command, { cwd: c.proj.path });
  if (!file) throw new CrewError('wf.review.engineNotFound', { name, command: eng.command });
  const plan = execx.spawnPlan(file, eng.args || []);
  const r = spawnSync(plan.file, plan.args, {
    input, cwd: c.proj.path, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    windowsHide: true, ...plan.options,
  });
  if (r.error || r.status !== 0) {
    throw new CrewError('wf.review.engineFailed', {
      name, detail: clean((r.error && r.error.message) || r.stderr || `exit ${r.status}`, 300),
    });
  }
  const list = rv.extractJsonArray(r.stdout);
  if (!list) {
    json.saveRaw(rv.roundFile(c.dir, round, 'engine.txt'), clean(r.stdout, 20000));
    throw new CrewError('wf.review.noJson', { name, file: rv.roundFile(c.dir, round, 'engine.txt') });
  }
  const safe = rv.sanitizeFindings(list, true);
  json.save(rv.roundFile(c.dir, round, 'raw.json'), safe);
  return safe;
}

function doRun(ctx, a) {
  const c = ctxOf(ctx, a.task);
  for (const w of c.warnings) ctx.err(`warning: ${w.message}`);
  const round = nextRound(c, a);
  const engine = a.engine || (c.cfg.roles.reviewer || {}).engine || 'claude';
  const rawPath = rv.roundFile(c.dir, round, 'raw.json');
  if (engine === 'claude') {
    const role = c.cfg.roles.reviewer || {};
    const prompt = rv.reviewerInstructions({
      task: c.task, briefPath: path.join(c.dir, 'brief.md'), reviewPath: path.join(c.proj.path, '.crew', 'REVIEW.md'),
      diffCmd: diffCommand(c), categories: c.cfg.review.categories, round, rawPath, cli: common.cliCommand(),
    });
    const data = { engine, round, raw_path: rawPath, subagent_type: role.agent || 'crew-reviewer', model: role.model || 'sonnet', prompt };
    ctx.emit(data, [
      ctx.t('wf.review.dispatch', { agent: data.subagent_type, model: data.model, round }),
      ctx.t('wf.review.rawAt', { path: rawPath }),
      '--- prompt ---', prompt, '--- end ---',
      ctx.t('wf.review.thenFilter', { id: c.task.id }),
    ]);
    return;
  }
  const list = runEngine(c, engine, round);
  ctx.emit({ engine, round, raw_path: rawPath, count: list.length }, [
    ctx.t('wf.review.engineDone', { name: engine, n: list.length, path: rawPath }),
    ctx.t('wf.review.thenFilter', { id: c.task.id }),
  ]);
}

// ---------------------------------------------------------------- submit
function doSubmit(ctx, a) {
  const c = ctxOf(ctx, a.task);
  const text = a.file ? common.readText(a.file, 'findings') : common.readStdin();
  if (!text.trim()) throw new CrewError('wf.review.emptyInput');
  const data = common.parseJsonText(text, a.kind);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
  if (!list) throw new CrewError('wf.review.notArray', { what: a.kind });
  const round = a.round || Math.max(1, rv.latestRound(c.dir, 'raw.json'));
  const safe = a.kind === 'findings' ? rv.sanitizeFindings(list, true) : list.map(rv.sanitizeRefutation);
  const file = rv.roundFile(c.dir, round, a.kind === 'findings' ? 'raw.json' : 'refutations.json');
  json.save(file, safe);
  ctx.emit({ round, kind: a.kind, count: list.length, file }, ctx.t('wf.review.submitted', { n: list.length, kind: a.kind, round }));
}

// ---------------------------------------------------------------- filter
const brief = (f) => `${f.id} [${f.severity}] ${f.category} ${f.file}:${f.line}  ${clean(f.claim || '', 140)}`;

function doFilter(ctx, a) {
  const c = ctxOf(ctx, a.task);
  const round = currentRound(c, a, 'raw.json');
  const list = rv.sanitizeFindings(rv.readArray(rv.roundFile(c.dir, round, 'raw.json'), 'raw findings'), false);
  const { kept, dropped } = rv.filterFindings(list, { cfg: c.cfg, ledger: rv.readLedger(c.proj.path), baseDirs: baseDirs(c) });
  json.save(rv.roundFile(c.dir, round, 'filtered.json'), dropped);
  json.save(rv.roundFile(c.dir, round, 'kept.json'), kept);
  const reasons = {};
  for (const d of dropped) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
  const L = [ctx.t('wf.review.filtered', { round, total: list.length, kept: kept.length, dropped: dropped.length })];
  if (dropped.length) L.push(ctx.t('wf.review.droppedBy', { reasons: Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') }));
  for (const d of dropped.filter((x) => x.reason === 'invalid')) L.push(ctx.t('wf.review.invalidEntry', { id: (d.finding && d.finding.id) || '?', detail: d.detail }));
  for (const f of kept) L.push(`  ${brief(f)}`);
  if (kept.length) {
    const role = c.cfg.roles.refuter || {};
    const keptPath = rv.roundFile(c.dir, round, 'kept.json');
    const prompt = rv.refuterInstructions({
      task: c.task, briefPath: path.join(c.dir, 'brief.md'), reviewPath: path.join(c.proj.path, '.crew', 'REVIEW.md'),
      diffCmd: diffCommand(c), keptPath, round, cli: common.cliCommand(),
    });
    L.push(ctx.t('wf.review.refuteNext', { agent: role.agent || 'crew-refuter', model: role.model || 'sonnet' }), '--- prompt ---', prompt, '--- end ---');
    ctx.emit({ round, kept, dropped, refuter: { subagent_type: role.agent || 'crew-refuter', model: role.model || 'sonnet', prompt, kept_path: keptPath } }, L);
  } else {
    L.push(ctx.t('wf.review.nothingToRefute', { id: c.task.id }));
    ctx.emit({ round, kept, dropped }, L);
  }
}

// ---------------------------------------------------------------- finalize
function doFinalize(ctx, a) {
  const c = ctxOf(ctx, a.task);
  const round = currentRound(c, a, 'kept.json');
  const kept = rv.sanitizeFindings(rv.readArray(rv.roundFile(c.dir, round, 'kept.json'), 'kept findings'), false);
  let refs = [];
  if (kept.length) {
    const file = a.refFile || rv.roundFile(c.dir, round, 'refutations.json');
    if (!a.refFile && !fs.existsSync(file)) throw new UsageError('args.missing', { name: '--refutations-file' });
    refs = rv.readArray(file, 'refutations').map(rv.sanitizeRefutation);
  }
  const { findings, dropped, problems } = rv.applyRefutations(kept, refs);
  json.save(rv.roundFile(c.dir, round, 'json'), findings);
  let prior = [];
  try { prior = rv.readArray(rv.roundFile(c.dir, round, 'filtered.json'), 'filtered'); } catch { /* none yet */ }
  json.save(rv.roundFile(c.dir, round, 'filtered.json'), prior.filter((d) => d.reason !== 'refuted').concat(dropped));
  if (c.task.state === 'returned') tasks.transition(c.proj.id, c.task.id, 'reviewing', { src: 'cli', note: `review round ${round}` });
  const by = {};
  for (const f of findings) by[f.severity] = (by[f.severity] || 0) + 1;
  const L = [ctx.t('wf.review.finalized', { round, n: findings.length, refuted: dropped.length })];
  for (const p of problems) L.push(ctx.t('wf.review.problem', { text: p }));
  for (const f of findings) L.push(`  ${brief(f)} (${f.verdict})`);
  ctx.emit({ round, findings, refuted: dropped.length, by_severity: by, problems }, L);
}

// ---------------------------------------------------------------- show
function doShow(ctx, a) {
  const c = ctxOf(ctx, a.task);
  let round = a.round || rv.latestRound(c.dir, 'json');
  let suffix = 'json';
  if (!round || !fs.existsSync(rv.roundFile(c.dir, round, suffix))) {
    round = a.round || rv.latestRound(c.dir, 'kept.json');
    suffix = 'kept.json';
  }
  if (!round || !fs.existsSync(rv.roundFile(c.dir, round, suffix))) throw new CrewError('wf.review.noFindings', { id: c.task.id });
  const list = rv.readArray(rv.roundFile(c.dir, round, suffix), 'findings');
  let filtered = [];
  try { filtered = rv.readArray(rv.roundFile(c.dir, round, 'filtered.json'), 'filtered'); } catch { /* none */ }
  const L = [ctx.t(suffix === 'json' ? 'wf.review.showFinal' : 'wf.review.showKept', { round, n: list.length, filtered: filtered.length })];
  for (const f of list) {
    L.push(`${brief(f)}${f.verdict ? ` (${f.verdict})` : ''}`);
    L.push(`    ${ctx.t('wf.review.evidence')}: ${(f.evidence || []).join(', ')}  [${f.verified_by}, ${f.confidence}]`);
    if (f.suggestion) L.push(`    ${ctx.t('wf.review.suggestion')}: ${clean(f.suggestion, 300)}`);
  }
  ctx.emit({ round, final: suffix === 'json', findings: list, filtered_count: filtered.length }, L);
}

// ---------------------------------------------------------------- dismiss
function findFinding(c, id) {
  const top = Math.max(rv.latestRound(c.dir, 'raw.json'), rv.latestRound(c.dir, 'json'), rv.latestRound(c.dir, 'kept.json'));
  for (let r = top; r >= 1; r--) {
    for (const suffix of ['raw.json', 'kept.json', 'json']) {
      let list = [];
      try { list = rv.readArray(rv.roundFile(c.dir, r, suffix), 'findings'); } catch { continue; }
      const hit = list.find((f) => f && f.id === id);
      if (hit) return hit;
    }
  }
  return null;
}

// The ledger is committed to git: only a hash of the snippet goes in, never the text.
function digestOf(f) {
  if (typeof f.snippet_hash === 'string' && f.snippet_bytes > 0) return { snippet_hash: f.snippet_hash, snippet_bytes: f.snippet_bytes };
  return rv.snippetDigest(f.snippet) || {};
}

function doDismiss(ctx, a) {
  const c = ctxOf(ctx, a.task);
  need(a.scope, '--scope');
  need(a.reason, '--reason');
  const f0 = findFinding(c, a.finding);
  if (!f0) throw new CrewError('wf.review.findingNotFound', { id: a.finding, task: c.task.id });
  // the fingerprint uses the category as the reviewer reported it, not a pipeline downgrade
  const f = f0.downgraded_from ? { ...f0, category: f0.downgraded_from.category } : f0;
  const problems = rv.validateFinding(f, c.cfg.review.categories);
  if (problems.length) throw new CrewError('wf.review.cannotDismiss', { id: a.finding, detail: problems.join('; ') });
  const fp = f0.downgraded_from || typeof f0.fingerprint !== 'string' ? rv.fingerprint(f) : f0.fingerprint;
  const dup = rv.readLedger(c.proj.path).find((e) => e.fingerprint === fp && e.scope === a.scope);
  const entry = {
    fingerprint: fp, category: f.category, file: String(f.file).replace(/\\/g, '/'), symbol: f.symbol || '',
    ...digestOf(f0), reason: clean(a.reason, 500), scope: a.scope,
    decided_by: clean(a.by, 60), date: common.today(),
  };
  if (!dup) rv.appendLedger(c.proj.path, entry);
  events.append(c.proj.id, {
    type: 'review.finding_dismissed', src: 'cli', task: c.task.id,
    data: { finding: a.finding, scope: a.scope, category: f.category, file: entry.file, reason: entry.reason }, key: `${a.finding}:${fp}:${a.scope}`,
  });
  let lesson = null;
  if (a.scope === 'always') {
    lesson = lessons.add(c.proj.path, c.proj.id, {
      key: `review-dismissed-${common.slug(f.category, 40)}`, kind: 'dismissal',
      text: `Dismissed a ${f.category} finding for good (${entry.reason}). Consider a rule in .crew/REVIEW.md.`,
    });
  }
  ctx.emit({ entry, duplicate: !!dup, lesson }, [
    ctx.t(dup ? 'wf.review.alreadyDismissed' : 'wf.review.dismissed', { id: a.finding, scope: a.scope }),
    ...(lesson ? [ctx.t('wf.review.lessonAdded', { key: lesson.key })] : []),
  ]);
}

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('wf.review.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  ({ run: doRun, submit: doSubmit, filter: doFilter, finalize: doFinalize, show: doShow, dismiss: doDismiss })[sub](ctx, a);
  return 0;
}

module.exports = {
  name: 'review',
  summary: { en: 'Review pipeline: find, filter, refute, finalize, dismiss', 'zh-TW': '審查流程：找出、過濾、反駁、定案、駁回' },
  usage: {
    en: [
      '  crew review run <task> [--engine claude|<name>] [--round N]',
      '  crew review submit <task> [--round N] [--kind findings|refutations] [--file F]   (JSON on stdin without --file)',
      '  crew review filter <task> [--round N]',
      '  crew review finalize <task> [--refutations-file F] [--round N]',
      '  crew review show <task> [--round N]',
      '  crew review dismiss <task> <finding-id> --scope once|always --reason "..."',
    ].join('\n'),
    'zh-TW': [
      '  crew review run <task> [--engine claude|<名稱>] [--round N]',
      '  crew review submit <task> [--round N] [--kind findings|refutations] [--file F]   （沒給 --file 就從標準輸入讀 JSON）',
      '  crew review filter <task> [--round N]',
      '  crew review finalize <task> [--refutations-file F] [--round N]',
      '  crew review show <task> [--round N]',
      '  crew review dismiss <task> <finding-id> --scope once|always --reason "..."',
    ].join('\n'),
  },
  run,
};
