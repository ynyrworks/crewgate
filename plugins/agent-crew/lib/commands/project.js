'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const project = require('../core/project');
const paths = require('../core/paths');

const SPECS = {
  add: { positionals: [{ name: 'path', optional: true }], options: { '--name': { dest: 'name' } } },
  list: { positionals: [], options: {} },
  rm: { positionals: [{ name: 'spec' }], options: {} },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('project.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  if (sub === 'add') {
    const { project: p, created } = project.add(a.path || ctx.cwd, { name: a.name });
    ctx.emit({ project: p, created, dataDir: paths.projectDir(p.id) }, [
      ctx.t(created ? 'project.added' : 'project.updated', { id: p.id, name: p.name }),
      ctx.t('project.root', { path: p.path }),
      ctx.t('project.dataDir', { dir: paths.projectDir(p.id) }),
    ]);
  } else if (sub === 'list') {
    const all = project.list();
    ctx.emit(all, all.length ? all.map((p) => `${p.id}  ${p.name}  ${p.path}`) : [ctx.t('project.empty')]);
  } else {
    const { project: p, dir } = project.remove(a.spec);
    ctx.emit({ project: p, dir }, ctx.t('project.removed', { id: p.id, name: p.name, dir }));
  }
  return 0;
}

module.exports = {
  name: 'project',
  summary: { en: 'Register, list and remove projects', 'zh-TW': '登錄、列出與移除專案' },
  usage: {
    en: '  crew project add [path] [--name NAME]\n  crew project list\n  crew project rm <id|path|name>',
    'zh-TW': '  crew project add [路徑] [--name 名稱]\n  crew project list\n  crew project rm <id|路徑|名稱>',
  },
  run,
};
