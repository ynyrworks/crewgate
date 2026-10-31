'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('../core/args');
const { UsageError, CrewError } = require('../core/errors');
const json = require('../core/json');
const common = require('../features/common');
const rel = require('../features/release');

const SPECS = {
  record: {
    positionals: [{ name: 'version' }],
    options: {
      '--from': { dest: 'from' }, '--to': { dest: 'to' }, '--plan': { dest: 'plans', multi: true },
      '--conclusion-file': { dest: 'conclusionFile' }, '--dir': { dest: 'dir' }, '--force': { dest: 'force', flag: true },
    },
  },
};
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

function record(argv, ctx) {
  const a = parse(argv, SPECS.record);
  if (!VERSION_RE.test(a.version) || a.version.includes('..')) throw new UsageError('release.badVersion', { version: a.version });
  const proj = ctx.requireProject();
  const root = ctx.workTree();
  const cfg = ctx.config().config;
  const dir = path.resolve(root, a.dir || (cfg.release && cfg.release.record_dir) || '.crew/releases');
  const file = path.join(dir, `${a.version}.md`);
  const data = rel.collect({ root, projectId: proj.id, version: a.version, from: a.from, to: a.to, plans: a.plans });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const kept = existing === null ? null : rel.extractConclusion(existing);
  if (existing !== null && kept === null && !a.force) throw new CrewError('release.noMarkers', { file });
  let conclusion;
  if (a.conclusionFile) conclusion = common.readText(a.conclusionFile, 'conclusion').replace(/\s+$/, '');
  else if (kept !== null) conclusion = kept;
  else conclusion = ctx.t('release.todo');
  const text = rel.sanitize(rel.render(data, ctx.lang, conclusion), root);

  fs.mkdirSync(dir, { recursive: true });
  json.saveRaw(file, text);
  if (/^\s*TODO\b/.test(conclusion)) ctx.err(ctx.t('release.todoWarn', { file: path.relative(root, file) || file }));
  const shown = path.relative(root, file);
  ctx.emit({ version: a.version, file: shown.startsWith('..') ? file : shown, range: data.range, tasks: data.tasks.map((k) => ({ id: k.id, review: k.review.kind })), not_placed: data.not_placed },
    [ctx.t('release.written', { file: shown.startsWith('..') ? file : shown, n: data.tasks.length })]);
  return 0;
}

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('release.usage');
  return record(argv.slice(1), ctx);
}

module.exports = {
  name: 'release',
  summary: {
    en: 'Write the committed record of what went into a version',
    'zh-TW': '寫出某個版本內容與查核結果的紀錄檔（要提交進版本庫）',
  },
  usage: {
    en: '  crew release record <version> [--from REF] [--to REF] [--plan SLUG]... [--conclusion-file F] [--dir D] [--force] [--json]   (--lang en|zh-TW sets the language)',
    'zh-TW': '  crew release record <version> [--from REF] [--to REF] [--plan SLUG]... [--conclusion-file F] [--dir D] [--force] [--json]   （--lang en|zh-TW 設定語言）',
  },
  run,
};
