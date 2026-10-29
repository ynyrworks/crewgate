'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  set: { positionals: [{ name: 'templateId' }, { name: 'date' }, { name: 'host' }, { name: 'result' }], options: {} },
  list: { positionals: [], options: {} },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('validate.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'set') {
    const r = store.validateSet(id, a);
    ctx.emit({ templateId: a.templateId, ...r }, ctx.t('validate.set', { id: a.templateId, date: r.date, host: r.host }));
  } else {
    const all = store.validateList(id);
    const lines = [];
    for (const [tid, recs] of Object.entries(all)) for (const r of recs) lines.push(`${tid}  ${r.date}  ${r.host}  ${r.result}`);
    ctx.emit(all, lines.length ? lines : [ctx.t('validate.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'validate',
  summary: { en: 'Real-environment validation records', 'zh-TW': '實機驗證紀錄' },
  usage: {
    en: '  crew validate set ID YYYY-MM-DD "HOST TYPE" "RESULT"\n  crew validate list',
    'zh-TW': '  crew validate set ID YYYY-MM-DD "主機類型" "結果"\n  crew validate list',
  },
  run,
};
