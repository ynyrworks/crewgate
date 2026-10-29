'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  set: {
    positionals: [{ name: 'iid', int: true }, { name: 'title' }],
    options: { '--ci': { dest: 'ci', choices: store.CI_STATES }, '--merged': { dest: 'merged', choices: ['yes', 'no'] } },
  },
  list: { positionals: [], options: {} },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('mr.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'set') {
    const r = store.mrSet(id, a.iid, a.title, a);
    ctx.emit(r, ctx.t('mr.set', { iid: r.iid, ci: r.ci || '-', merged: ctx.t(r.merged ? 'mr.merged' : 'mr.open') }));
  } else {
    const rows = store.mrList(id);
    ctx.emit(rows, rows.length
      ? rows.map((r) => `!${r.iid}  ci=${r.ci || '-'}  ${ctx.t(r.merged ? 'mr.merged' : 'mr.open')}  ${r.title}`)
      : [ctx.t('mr.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'mr',
  summary: { en: 'Merge requests and their CI state', 'zh-TW': '合併請求與 CI 狀態' },
  usage: {
    en: '  crew mr set N "TITLE" [--ci passed|failed|running] [--merged yes|no]\n  crew mr list',
    'zh-TW': '  crew mr set N "標題" [--ci passed|failed|running] [--merged yes|no]\n  crew mr list',
  },
  run,
};
