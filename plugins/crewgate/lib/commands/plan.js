'use strict';

const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const { clean } = require('../core/redact');
const plans = require('../core/plans');
const pr = require('../core/plan-review');
const tasks = require('../core/tasks');
const common = require('../features/common');

const SPECS = {
  new: { positionals: [{ name: 'slug' }], options: { '--title': { dest: 'title' }, '--goal': { dest: 'goal' } } },
  list: { positionals: [], options: {} },
  show: { positionals: [{ name: 'slug' }], options: {} },
  add: {
    positionals: [{ name: 'slug' }, { name: 'text' }],
    options: {
      '--under': { dest: 'under' }, '--task': { dest: 'task' },
      '--origin': { dest: 'origin', choices: plans.ORIGINS, default: 'plan' }, '--proposed': { dest: 'proposed', flag: true },
    },
  },
  link: { positionals: [{ name: 'slug' }, { name: 'node' }, { name: 'task' }], options: {} },
  set: { positionals: [{ name: 'slug' }, { name: 'node' }, { name: 'action', choices: ['open', 'done', 'dropped', 'accept'] }], options: {} },
  rm: { positionals: [{ name: 'slug' }, { name: 'node' }], options: {} },
  accept: { positionals: [{ name: 'slug' }, { name: 'node' }], options: {} },
  reject: { positionals: [{ name: 'slug' }, { name: 'node' }], options: { '--note': { dest: 'note' } } },
};
const ROUND = { '--round': { dest: 'round', int: true } };
const REVIEW_SPECS = {
  run: { positionals: [{ name: 'slug' }], options: { '--node': { dest: 'node' }, '--force': { dest: 'force', flag: true } } },
  submit: {
    positionals: [{ name: 'slug' }],
    options: { '--kind': { dest: 'kind', choices: ['findings', 'refutations'], default: 'findings' }, '--file': { dest: 'file' }, ...ROUND },
  },
  filter: { positionals: [{ name: 'slug' }], options: ROUND },
  finalize: { positionals: [{ name: 'slug' }], options: { '--refutations-file': { dest: 'refFile' }, ...ROUND } },
  show: { positionals: [{ name: 'slug' }], options: ROUND },
};

// `plan set ... accept` on a node a plan review proposed does the full accept; a plain [?] node keeps the old behaviour.
function isReviewProposal(root, slug, ref) {
  const doc = plans.readCapped(root, slug);
  if (!doc) return false;
  try { return !!plans.proposalMeta(plans.find(doc, ref)); } catch { return false; }
}

// A task id must exist before a node links to it.
function checkTask(projectId, id) {
  tasks.load(projectId, id);
  return id;
}

// Tree as text lines: "  n2  [x] text  (done, t-...)", with "(2/3 67%)" on parents.
function treeLines(ctx, nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      const bits = [ctx.t(`plan.state.${n.state}`)];
      if (n.children.length && n.state !== 'dropped' && n.state !== 'proposed') bits.push(`${n.done}/${n.total} ${n.pct}%`);
      if (n.task) bits.push(`${n.task.id}${n.task.missing ? ` ${ctx.t('plan.unknownTask')}` : ` ${n.task.state}`}`);
      if (n.origin !== 'plan') bits.push(ctx.t('plan.originBit', { origin: n.origin }));
      if (n.proposal) bits.push([n.proposal.action, n.proposal.kind].filter(Boolean).join(' '));
      if (n.proposal && n.proposal.uncertain) bits.push(ctx.t('plan.review.uncertain'));
      out.push(`${'  '.repeat(n.depth - 1)}${n.id}  [${n.box}] ${n.text}  (${bits.join(', ')})`);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------- plan review
const brief = (f) => `${f.id} [${f.kind}] ${f.node || '-'} ${f.proposal && f.proposal.action}  ${clean((f.proposal && f.proposal.text) || '', 140)}`;

function reviewRun(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(REVIEW_SPECS, sub)) throw new UsageError('plan.review.usage');
  const a = parse(argv.slice(1), REVIEW_SPECS[sub]);
  const proj = ctx.requireProject();
  const root = ctx.workTree();
  plans.checkSlug(a.slug);
  const cfg = ctx.config().config;
  if (sub === 'run') {
    const r = pr.start(root, proj.id, cfg, a.slug, { node: a.node, force: !!a.force });
    ctx.emit(r, [
      ctx.t('plan.review.dispatch', { agent: r.subagent_type, model: r.model, round: r.round, slug: a.slug }),
      ctx.t('plan.review.rawAt', { path: r.raw_path }),
      '--- prompt ---', r.prompt, '--- end ---',
      ctx.t('plan.review.thenFilter', { slug: a.slug }),
    ]);
  } else if (sub === 'submit') {
    const text = a.file ? common.readText(a.file, 'findings') : common.readStdin();
    if (!text.trim()) throw new CrewError('wf.review.emptyInput');
    const data = common.parseJsonText(text, a.kind);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
    if (!list) throw new CrewError('wf.review.notArray', { what: a.kind });
    const r = pr.submit(proj.id, a.slug, { kind: a.kind, round: a.round, list });
    ctx.emit(r, ctx.t('wf.review.submitted', { n: r.count, kind: a.kind, round: r.round }));
  } else if (sub === 'filter') {
    const r = pr.filter(root, proj.id, cfg, a.slug, a.round);
    const L = [ctx.t('plan.review.filtered', { round: r.round, total: r.total, kept: r.kept.length, dropped: r.dropped.length })];
    if (r.dropped.length) L.push(ctx.t('wf.review.droppedBy', { reasons: Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ') }));
    for (const d of r.dropped.filter((x) => x.reason !== 'duplicate')) L.push(ctx.t('plan.review.droppedEntry', { id: (d.finding && d.finding.id) || '?', reason: d.reason, detail: d.detail }));
    for (const f of r.kept) L.push(`  ${brief(f)}`);
    if (r.refuter) L.push(ctx.t('wf.review.refuteNext', { agent: r.refuter.subagent_type, model: r.refuter.model }), '--- prompt ---', r.refuter.prompt, '--- end ---');
    else L.push(ctx.t('plan.review.nothingToRefute', { slug: a.slug }));
    ctx.emit({ round: r.round, total: r.total, kept: r.kept, dropped: r.dropped, refuter: r.refuter }, L);
  } else if (sub === 'finalize') {
    let refutations;
    if (a.refFile) {
      const data = common.parseJsonText(common.readText(a.refFile, 'refutations'), 'refutations');
      refutations = Array.isArray(data) ? data : data && data.findings;
      if (!Array.isArray(refutations)) throw new CrewError('wf.review.notArray', { what: 'refutations' });
    }
    const r = pr.finalize(root, proj.id, cfg, a.slug, { round: a.round, refutations });
    const L = [ctx.t('plan.review.finalized', { round: r.round, n: r.created.length, refuted: r.refuted, cut: r.cut })];
    for (const p of r.problems) L.push(ctx.t('wf.review.problem', { text: p }));
    for (const c of r.created) {
      const f = r.findings.find((x) => x.id === c.id);
      L.push(`  ${c.node_id} [${f.kind}] ${c.action}${c.for ? ` on ${c.for}` : ''}  ${clean(c.text, 140)} (${c.uncertain ? ctx.t('plan.review.uncertain') : f.verdict}, ${c.origin})`);
      if (c.deep) L.push(ctx.t('plan.review.deepNote', { id: c.node_id, under: c.under || '-', max: plans.MAX_DEPTH }));
    }
    if (r.created.length) L.push(ctx.t('plan.review.decide', { slug: a.slug }));
    ctx.emit({ round: r.round, findings: r.findings, refuted: r.refuted, cut: r.cut, problems: r.problems, created: r.created }, L);
  } else {
    const rd = a.round || pr.latestRound(pr.dirOf(proj.id, a.slug), 'raw.json');
    const row = pr.roundsOf(proj.id, a.slug).find((x) => x.round === rd);
    if (!row) throw new CrewError('wf.review.noRound', { what: 'raw.json' });
    ctx.emit(row, ctx.t('plan.review.roundRow', { ...row }));
  }
  return 0;
}

function run(argv, ctx) {
  const sub = argv[0];
  if (sub === 'review') return reviewRun(argv.slice(1), ctx);
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('plan.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const proj = ctx.requireProject();
  const root = ctx.workTree(); // plans are tracked files: use the work tree like LESSONS.md
  if (a.slug !== undefined) plans.checkSlug(a.slug);
  if (sub === 'new') {
    if (!a.title) throw new UsageError('args.missing', { name: '--title' });
    const r = plans.create(root, proj.id, a.slug, { title: a.title, goal: a.goal });
    ctx.emit(r, ctx.t('plan.created', { slug: r.slug, file: r.file }));
  } else if (sub === 'list') {
    const rows = [];
    const states = plans.taskStates(proj.id);
    for (const slug of plans.slugs(root)) {
      const doc = plans.readCapped(root, slug);
      if (!doc) continue;
      const d = plans.derive(doc, states);
      rows.push({ slug, title: d.title, ...d.summary });
    }
    ctx.emit(rows, rows.length
      ? rows.map((r) => `${r.slug}  ${r.pct}% (${r.done}/${r.total})  ${r.title}`)
      : [ctx.t('plan.empty')]);
  } else if (sub === 'show') {
    const doc = plans.readCapped(root, a.slug);
    if (!doc) throw new CrewError('plan.notFound', { slug: a.slug });
    const d = plans.derive(doc, plans.taskStates(proj.id));
    ctx.emit({ slug: a.slug, ...d }, [
      ctx.t('plan.head', { slug: a.slug, title: d.title, pct: d.summary.pct, done: d.summary.done, total: d.summary.total }),
      ...(d.goal ? [d.goal] : []),
      ...treeLines(ctx, d.nodes),
      ...(d.duplicates.length ? [ctx.t('plan.dupIds', { ids: d.duplicates.join(', ') })] : []),
      ...(d.truncated ? [ctx.t('plan.truncated')] : []),
    ]);
  } else if (sub === 'add') {
    if (a.task) checkTask(proj.id, a.task);
    const r = plans.addTo(root, proj.id, a.slug, { text: a.text, under: a.under, task: a.task, origin: a.origin, proposed: !!a.proposed });
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.added', { id: r.id, slug: a.slug }));
  } else if (sub === 'link') {
    const r = plans.linkTo(root, proj.id, a.slug, a.node, checkTask(proj.id, a.task));
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.linked', { id: r.id, task: r.task }));
  } else if (sub === 'accept' || (sub === 'set' && a.action === 'accept' && isReviewProposal(root, a.slug, a.node))) {
    const r = pr.accept(root, proj.id, ctx.config().config, a.slug, a.node);
    const L = [ctx.t(r.removed ? `plan.review.accepted.${r.action}` : 'plan.review.accepted.add', { id: r.id, target: r.target })];
    if (r.growth) {
      L.push(ctx.t('plan.review.growth', { slug: a.slug, count: r.growth.count, limit: r.growth.limit }));
      if (r.growth.need) L.push(ctx.t('plan.review.growthNeed', { need: r.growth.need }));
    }
    ctx.emit({ slug: a.slug, ...r }, L);
  } else if (sub === 'reject') {
    const r = pr.reject(root, proj.id, a.slug, a.node, a.note);
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.review.rejected', { id: r.id }));
  } else if (sub === 'set') {
    const r = plans.setState(root, proj.id, a.slug, a.node, a.action);
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.changed', { id: r.id, state: ctx.t(`plan.state.${r.state}`) }));
  } else {
    const r = plans.removeFrom(root, proj.id, a.slug, a.node);
    ctx.emit({ slug: a.slug, ...r, removed: true }, ctx.t('plan.removed', { id: r.id }));
  }
  return 0;
}

module.exports = {
  name: 'plan',
  summary: { en: 'Plan trees with progress from linked tasks', 'zh-TW': '計畫樹，進度由連結的任務算出' },
  usage: {
    en: [
      '  crew plan new SLUG --title "..." [--goal "..."]',
      '  crew plan list [--json]',
      '  crew plan show SLUG [--json]',
      '  crew plan add SLUG "text" [--under NODE] [--task TASK] [--origin plan|user|review|refute|implementation|send-back] [--proposed]',
      '  crew plan link SLUG NODE TASK',
      '  crew plan set SLUG NODE open|done|dropped|accept',
      '  crew plan rm SLUG NODE   (a leaf only)',
      '  crew plan review run SLUG [--node NODE] [--force]   (a reviewer criticises the plan; prints the reviewer prompt)',
      '  crew plan review submit SLUG [--kind findings|refutations] [--round N] [--file F]   (JSON on stdin without --file)',
      '  crew plan review filter SLUG [--round N]   (drops bad, unknown and repeated findings; prints the refuter prompt)',
      '  crew plan review finalize SLUG [--refutations-file F] [--round N]   (survivors become proposed [?] nodes)',
      '  crew plan review show SLUG [--round N]',
      '  crew plan accept SLUG NODE   |   crew plan reject SLUG NODE [--note "why"]   (decide a proposed node)',
      '  (plans live in .crew/plans/SLUG.md; NODE is an id such as n2, or Lnn for a hand-written line without an id)',
    ].join('\n'),
    'zh-TW': [
      '  crew plan new SLUG --title "..." [--goal "..."]',
      '  crew plan list [--json]',
      '  crew plan show SLUG [--json]',
      '  crew plan add SLUG "文字" [--under NODE] [--task TASK] [--origin plan|user|review|refute|implementation|send-back] [--proposed]',
      '  crew plan link SLUG NODE TASK',
      '  crew plan set SLUG NODE open|done|dropped|accept',
      '  crew plan rm SLUG NODE   （只能刪葉節點）',
      '  crew plan review run SLUG [--node NODE] [--force]   （審查者批評計畫；印出審查者提示）',
      '  crew plan review submit SLUG [--kind findings|refutations] [--round N] [--file F]   （沒給 --file 就從標準輸入讀 JSON）',
      '  crew plan review filter SLUG [--round N]   （濾掉格式不對、找不到節點、重複的發現；印出反駁者提示）',
      '  crew plan review finalize SLUG [--refutations-file F] [--round N]   （留下的發現變成提議中 [?] 節點）',
      '  crew plan review show SLUG [--round N]',
      '  crew plan accept SLUG NODE   |   crew plan reject SLUG NODE [--note "原因"]   （決定提議節點）',
      '  （計畫放在 .crew/plans/SLUG.md；NODE 是 id（如 n2），沒有 id 的手寫行用 Lnn）',
    ].join('\n'),
  },
  run,
  treeLines,
};
