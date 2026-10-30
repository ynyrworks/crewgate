'use strict';

const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const plans = require('../core/plans');
const tasks = require('../core/tasks');

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
};

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
      out.push(`${'  '.repeat(n.depth - 1)}${n.id}  [${n.box}] ${n.text}  (${bits.join(', ')})`);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function run(argv, ctx) {
  const sub = argv[0];
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
      ...(d.truncated ? [ctx.t('plan.truncated')] : []),
    ]);
  } else if (sub === 'add') {
    if (a.task) checkTask(proj.id, a.task);
    const r = plans.addTo(root, proj.id, a.slug, { text: a.text, under: a.under, task: a.task, origin: a.origin, proposed: !!a.proposed });
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.added', { id: r.id, slug: a.slug }));
  } else if (sub === 'link') {
    const r = plans.linkTo(root, proj.id, a.slug, a.node, checkTask(proj.id, a.task));
    ctx.emit({ slug: a.slug, ...r }, ctx.t('plan.linked', { id: r.id, task: r.task }));
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
      '  （計畫放在 .crew/plans/SLUG.md；NODE 是 id（如 n2），沒有 id 的手寫行用 Lnn）',
    ].join('\n'),
  },
  run,
  treeLines,
};
