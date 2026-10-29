'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  add: { positionals: [{ name: 'text' }], options: {} },
  done: { positionals: [{ name: 'id', int: true }], options: {} },
  list: { positionals: [], options: { '--all': { dest: 'all', flag: true } } },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('need.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'add') {
    const n = store.needAdd(id, a.text);
    ctx.emit(n, ctx.t('need.added', { id: n.id }));
  } else if (sub === 'done') {
    const n = store.needDone(id, a.id);
    ctx.emit(n, ctx.t('need.doneMsg', { id: n.id }));
  } else {
    const rows = store.needList(id, { all: a.all });
    ctx.emit(rows, rows.length
      ? rows.map((n) => `#${n.id} [${ctx.t(n.done ? 'need.stateDone' : 'need.stateOpen')}] ${n.text}`)
      : [ctx.t('need.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'need',
  summary: { en: 'Things waiting for the user', 'zh-TW': '等使用者決定的事項' },
  usage: {
    en: '  crew need add "TEXT"\n  crew need done N\n  crew need list [--all]',
    'zh-TW': '  crew need add "文字"\n  crew need done N\n  crew need list [--all]',
  },
  run,
};
