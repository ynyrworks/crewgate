'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  add: { positionals: [{ name: 'who' }, { name: 'text' }], options: {} },
  list: { positionals: [], options: { '--n': { dest: 'n', int: true, default: 20 } } },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('log.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'add') {
    const e = store.logAdd(id, a.who, a.text);
    ctx.emit(e, ctx.t('log.added'));
  } else {
    const rows = store.logList(id, a.n);
    ctx.emit(rows, rows.length ? rows.map((r) => `${r.time}  [${r.who}]  ${r.text}`) : [ctx.t('log.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'log',
  summary: { en: 'Short activity log', 'zh-TW': '簡短的活動日誌' },
  usage: {
    en: '  crew log add WHO "TEXT"\n  crew log list [--n 20]',
    'zh-TW': '  crew log add 誰 "文字"\n  crew log list [--n 20]',
  },
  run,
};
