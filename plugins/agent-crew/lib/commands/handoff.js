'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const handoff = require('../features/handoff');
const common = require('../features/common');

const SPECS = {
  create: {
    positionals: [],
    options: { '--title': { dest: 'title' }, '--body-file': { dest: 'bodyFile' }, '--task': { dest: 'task' } },
  },
  list: { positionals: [], options: { '--all': { dest: 'all', flag: true } } },
  show: { positionals: [{ name: 'id' }], options: {} },
  accept: { positionals: [{ name: 'id' }], options: {} },
  cancel: { positionals: [{ name: 'id' }], options: {} },
};

const need = (v, name) => { if (!v) throw new UsageError('args.missing', { name }); return v; };

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('wf.handoff.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const pid = ctx.requireProject().id;
  if (sub === 'create') {
    need(a.title, '--title');
    need(a.bodyFile, '--body-file');
    const h = handoff.create(pid, { title: a.title, body: common.readText(a.bodyFile, 'handoff body'), task: a.task });
    ctx.emit(h, ctx.t('wf.handoff.created', { id: h.id }));
  } else if (sub === 'list') {
    const rows = handoff.list(pid, { all: a.all });
    ctx.emit(rows.map(({ body, ...rest }) => rest), rows.length
      ? rows.map((h) => `${h.id}  ${h.state.padEnd(9)}  ${h.created.slice(0, 16).replace('T', ' ')}  ${h.title}`)
      : [ctx.t('wf.handoff.empty')]);
  } else if (sub === 'show') {
    const h = handoff.find(pid, a.id);
    const { body, ...meta } = h;
    ctx.emit({ ...meta, body_chars: body.length }, [
      `${h.id}  ${h.state}  ${h.created}`, `${ctx.t('wf.handoff.title')}: ${h.title}`,
      ...(h.task ? [`${ctx.t('wf.handoff.task')}: ${h.task}`] : []),
      ctx.t('wf.handoff.bodyChars', { n: h.body.length }),
    ]);
  } else if (sub === 'accept') {
    const h = handoff.accept(pid, a.id);
    const f = common.fence(h.body);
    ctx.emit(h, [
      ctx.t('wf.handoff.accepted', { id: h.id, title: h.title }),
      ctx.t('wf.handoff.untrusted'),
      `${f}text`, h.body.trimEnd(), f,
      ctx.t('wf.handoff.untrustedEnd'),
    ]);
  } else {
    const h = handoff.cancel(pid, a.id);
    ctx.emit(h, ctx.t('wf.handoff.cancelled', { id: h.id }));
  }
  return 0;
}

module.exports = {
  name: 'handoff',
  summary: { en: 'Hand work over to another session', 'zh-TW': '把工作交接給另一個工作階段' },
  usage: {
    en: [
      '  crew handoff create --title T --body-file F [--task <id>]',
      '  crew handoff list [--all]',
      '  crew handoff show <id>',
      '  crew handoff accept <id>   (prints the body as untrusted data; a second accept fails)',
      '  crew handoff cancel <id>',
    ].join('\n'),
    'zh-TW': [
      '  crew handoff create --title T --body-file F [--task <id>]',
      '  crew handoff list [--all]',
      '  crew handoff show <id>',
      '  crew handoff accept <id>   （內容以「不可信資料」格式印出；重複接手會失敗）',
      '  crew handoff cancel <id>',
    ].join('\n'),
  },
  run,
};
