'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const lessons = require('../features/lessons');
const common = require('../features/common');

const SPECS = {
  add: {
    positionals: [],
    options: {
      '--key': { dest: 'key' }, '--text': { dest: 'text' },
      '--kind': { dest: 'kind', choices: lessons.KINDS, default: 'correction' },
      '--date': { dest: 'date' },
    },
  },
  list: { positionals: [], options: {} },
  suggest: { positionals: [], options: {} },
  promote: { positionals: [{ name: 'key' }], options: { '--rule': { dest: 'rule' } } },
  retire: { positionals: [{ name: 'key' }], options: {} },
};

const need = (v, name) => { if (!v) throw new UsageError('args.missing', { name }); return v; };

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('wf.lesson.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const proj = ctx.requireProject();
  const cfg = ctx.config().config;
  const root = proj.path;
  if (sub === 'add') {
    need(a.key, '--key');
    need(a.text, '--text');
    const e = lessons.add(root, proj.id, { key: a.key, text: a.text, kind: a.kind, date: a.date ? common.checkDate(a.date) : undefined });
    ctx.emit(e, ctx.t('wf.lesson.added', { key: e.key, date: e.date }));
  } else if (sub === 'list') {
    const promoted = new Set(lessons.readRules(root, cfg).map((r) => r.key));
    const rows = lessons.summarize(lessons.readEntries(root)).filter((s) => s.count > 0)
      .map((s) => ({ ...s, promoted: promoted.has(s.key) }));
    ctx.emit(rows, rows.length
      ? rows.map((s) => `${s.key}  ${ctx.t('wf.lesson.days', { days: s.days, count: s.count })}  ${s.first}..${s.last}  [${s.kinds.join(',')}]${s.promoted ? ` ${ctx.t('wf.lesson.promotedTag')}` : ''}${s.retired ? ` ${ctx.t('wf.lesson.retiredTag')}` : ''}  ${s.last_text}`)
      : [ctx.t('wf.lesson.empty')]);
  } else if (sub === 'suggest') {
    const rows = lessons.suggest(root, cfg);
    ctx.emit(rows, rows.length
      ? [ctx.t('wf.lesson.suggestHead', { n: rows.length, days: cfg.lessons.promote_after_days }),
        ...rows.map((s) => `  ${s.key}  ${ctx.t('wf.lesson.days', { days: s.days, count: s.count })}  ${s.last_text}`),
        ctx.t('wf.lesson.suggestAsk')]
      : [ctx.t('wf.lesson.noCandidates')]);
  } else if (sub === 'promote') {
    need(a.rule, '--rule');
    const r = lessons.promote(root, proj.id, cfg, a.key, a.rule);
    ctx.emit(r, ctx.t('wf.lesson.promoted', { key: r.key, file: cfg.lessons.rules_file, n: r.count, cap: cfg.lessons.rules_cap }));
  } else {
    const r = lessons.retire(root, proj.id, cfg, a.key);
    ctx.emit(r, ctx.t('wf.lesson.retired', { key: r.key, n: r.count }));
  }
  return 0;
}

module.exports = {
  name: 'lesson',
  summary: { en: 'Record lessons and promote repeated ones to rules', 'zh-TW': '記錄經驗，並把重複出現的升格成規則' },
  usage: {
    en: [
      '  crew lesson add --key slug --text "..." [--kind correction|send-back|dismissal|takeover]',
      '  crew lesson list',
      '  crew lesson suggest',
      '  crew lesson promote <key> --rule "..."   (only after the user said yes)',
      '  crew lesson retire <key>',
    ].join('\n'),
    'zh-TW': [
      '  crew lesson add --key slug --text "..." [--kind correction|send-back|dismissal|takeover]',
      '  crew lesson list',
      '  crew lesson suggest',
      '  crew lesson promote <key> --rule "..."   （必須先得到使用者同意）',
      '  crew lesson retire <key>',
    ].join('\n'),
  },
  run,
};
