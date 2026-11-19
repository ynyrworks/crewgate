'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const lessons = require('../features/lessons');
const common = require('../features/common');
const lookup = require('../core/lesson-find');

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
  find: {
    positionals: [], rest: 'words',
    options: { '--paths': { dest: 'paths', multi: true }, '--limit': { dest: 'limit', int: true, default: 5 } },
  },
  score: { positionals: [], options: { '--date': { dest: 'date' } } },
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
  const root = ctx.workTree(); // LESSONS.md and the rules file are tracked files: use the work tree
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
    const rows = lessons.suggest(root, cfg).map((s) => (lookup.isMechanical(s.last_text) ? { ...s, check_hint: true } : s));
    ctx.emit(rows, rows.length
      ? [ctx.t('wf.lesson.suggestHead', { n: rows.length, days: cfg.lessons.promote_after_days }),
        ...rows.map((s) => `  ${s.key}  ${ctx.t('wf.lesson.days', { days: s.days, count: s.count })}  ${s.last_text}${s.check_hint ? `
    ${ctx.t('wf.lesson.checkHint')}` : ''}`),
        ctx.t('wf.lesson.suggestAsk')]
      : [ctx.t('wf.lesson.noCandidates')]);
  } else if (sub === 'find') {
    const words = a.words.filter(Boolean);
    const globs = a.paths || [];
    if (!words.length && !globs.length) throw new UsageError('wf.lesson.findNeeds');
    if (a.limit < 1) throw new UsageError('wf.lesson.findLimit');
    const entries = lessons.readEntries(root);
    const retired = new Set(lessons.summarize(entries).filter((s) => s.retired).map((s) => s.key));
    const rows = lookup.find(entries, retired, { words, globs, limit: a.limit });
    ctx.emit(rows, rows.map((r) => `${r.key}  [${r.kind}]  ${r.date}  ${r.text}`));
  } else if (sub === 'score') {
    const rows = lessons.score(root, cfg, a.date ? common.checkDate(a.date) : new Date().toISOString().slice(0, 10));
    ctx.emit(rows, rows.length
      ? rows.map((s) => `${s.key}  ${ctx.t(`wf.lesson.score.${s.verdict}`)}  ${ctx.t('wf.lesson.scoreCounts', s)}  ${s.rule}`)
      : [ctx.t('wf.lesson.noRules')]);
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
      '  crew lesson find <words...> [--paths <glob>...] [--limit N]   (recorded lessons that match the work at hand)',
      '  crew lesson score [--date YYYY-MM-DD]   (did the lessons of each promoted rule stop coming back?)',
      '  crew lesson promote <key> --rule "..."   (only after the user said yes)',
      '  crew lesson retire <key>',
    ].join('\n'),
    'zh-TW': [
      '  crew lesson add --key slug --text "..." [--kind correction|send-back|dismissal|takeover]',
      '  crew lesson list',
      '  crew lesson suggest',
      '  crew lesson find <words...> [--paths <glob>...] [--limit N]   （找出和手上工作相關的已記錄經驗）',
      '  crew lesson score [--date YYYY-MM-DD]   （每條升級的規則，相關經驗是否不再出現？）',
      '  crew lesson promote <key> --rule "..."   （必須先得到使用者同意）',
      '  crew lesson retire <key>',
    ].join('\n'),
  },
  run,
};
