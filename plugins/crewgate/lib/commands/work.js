'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  set: {
    positionals: [{ name: 'stream' }, { name: 'title' }, { name: 'state', choices: store.WORK_STATES }, { name: 'note', optional: true }],
    options: { '--need': { dest: 'need', int: true } },
  },
  rm: { positionals: [{ name: 'stream' }, { name: 'title' }], options: {} },
  list: { positionals: [], options: {} },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('work.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'set') {
    const item = store.workSet(id, a);
    ctx.emit({ stream: a.stream, ...item }, ctx.t('work.set', { stream: a.stream, title: item.title, state: item.state }));
  } else if (sub === 'rm') {
    store.workRm(id, a.stream, a.title);
    ctx.emit({ removed: true }, ctx.t('work.removed'));
  } else {
    const streams = store.workList(id);
    const lines = [];
    for (const s of streams) {
      lines.push(s.name);
      for (const i of s.items) lines.push(`  [${i.state}] ${i.title}${i.note ? ` - ${i.note}` : ''}`);
    }
    ctx.emit(streams, lines.length ? lines : [ctx.t('work.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'work',
  summary: { en: 'Work streams and their items', 'zh-TW': '工作流與工作項目' },
  usage: {
    en: '  crew work set STREAM "TITLE" todo|doing|done|waiting|parked ["NOTE"] [--need N]\n  crew work rm STREAM "TITLE"\n  crew work list',
    'zh-TW': '  crew work set 工作流 "工作" todo|doing|done|waiting|parked ["備註"] [--need N]\n  crew work rm 工作流 "工作"\n  crew work list',
  },
  run,
};
