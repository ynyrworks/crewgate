'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const store = require('../core/store');

const SPECS = {
  set: {
    positionals: [{ name: 'stream' }, { name: 'title' }, { name: 'state', choices: store.WORK_STATES }, { name: 'note', optional: true }],
    options: { '--need': { dest: 'need', int: true }, '--id': { dest: 'itemId' }, '--new': { dest: 'forceNew', flag: true } },
  },
  rm: { positionals: [{ name: 'stream' }, { name: 'title', optional: true }], options: { '--id': { dest: 'itemId' } } },
  list: { positionals: [], options: {} },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('work.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const id = ctx.requireProject().id;
  if (sub === 'set') {
    if (a.itemId && a.forceNew) throw new UsageError('work.idAndNew');
    const item = store.workSet(id, a);
    ctx.emit({ stream: a.stream, ...item }, ctx.t('work.set', { stream: a.stream, title: item.title, state: item.state }));
  } else if (sub === 'rm') {
    if (!a.title && !a.itemId) throw new UsageError('args.missing', { name: 'title' });
    store.workRm(id, a.stream, a.title || '', undefined, a.itemId);
    ctx.emit({ removed: true }, ctx.t('work.removed'));
  } else {
    const streams = store.workList(id);
    const lines = [];
    for (const s of streams) {
      lines.push(s.name);
      for (const i of s.items) lines.push(`  ${i.id}  [${i.state}] ${i.title}${i.note ? ` - ${i.note}` : ''}`);
    }
    ctx.emit(streams, lines.length ? lines : [ctx.t('work.empty')]);
  }
  return 0;
}

module.exports = {
  name: 'work',
  summary: { en: 'Work streams and their items', 'zh-TW': '工作流與工作項目' },
  usage: {
    en: '  crew work set STREAM "TITLE" todo|doing|done|waiting|parked ["NOTE"] [--need N] [--id ID | --new]\n  crew work rm STREAM "TITLE" | --id ID\n  crew work list [--json]   (shows item ids; set updates the item with the same title in the stream)',
    'zh-TW': '  crew work set 工作流 "工作" todo|doing|done|waiting|parked ["備註"] [--need N] [--id ID | --new]\n  crew work rm 工作流 "工作" | --id ID\n  crew work list [--json]   （顯示項目 id；set 會更新同工作流內同標題的項目）',
  },
  run,
};
