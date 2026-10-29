'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const { importAgentBoard } = require('../core/importer');

const SPEC = {
  positionals: [{ name: 'source', choices: ['agent-board'] }, { name: 'dir' }],
  options: { '--from-project': { dest: 'from' }, '--force': { dest: 'force', flag: true } },
};

function run(argv, ctx) {
  const a = parse(argv, SPEC);
  if (!a.from) throw new UsageError('import.needFrom');
  const proj = ctx.requireProject();
  const r = importAgentBoard(a.dir, a.from, proj.id, { force: a.force });
  const c = r.counts;
  const lines = [
    ctx.t('import.done', { from: a.from, id: proj.id, files: r.written.map((n) => `${n}.json`).join(', ') }),
    ctx.t('import.counts', { needs: c.needs, items: c.items, log: c.log, mrs: c.mrs, validation: c.validation }),
  ];
  if (r.backups.length) lines.push(ctx.t('import.backups', { files: r.backups.join(', ') }));
  if (r.unmappedStates) lines.push(ctx.t('import.unmapped', { n: r.unmappedStates }));
  ctx.emit({ project: proj.id, ...r }, lines);
  return 0;
}

module.exports = {
  name: 'import',
  summary: { en: 'Import data from an older board folder', 'zh-TW': '從舊看板資料夾匯入資料' },
  usage: {
    en: '  crew import agent-board <data dir> --from-project <id> [--force]',
    'zh-TW': '  crew import agent-board <資料夾> --from-project <id> [--force]',
  },
  run,
};
