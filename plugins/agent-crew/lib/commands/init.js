'use strict';

const { parse } = require('../core/args');
const project = require('../core/project');
const { init } = require('../features/init');

const SPEC = {
  positionals: [],
  options: { '--lang': { dest: 'lang', choices: ['en', 'zh-TW'] }, '--force': { dest: 'force', flag: true } },
};

function run(argv, ctx) {
  // --lang is also a global option, so the dispatcher hands it over as ctx.langOption
  const a = parse(argv, SPEC);
  const root = project.detectRoot(ctx.cwd) || ctx.cwd;
  const res = init(root, { lang: a.lang || ctx.langOption, force: a.force, fallbackLang: ctx.lang });
  const L = [ctx.t(res.created ? 'wf.init.registered' : 'wf.init.alreadyRegistered', { id: res.project.id, name: res.project.name })];
  for (const f of res.files) {
    L.push(`  ${ctx.t(`wf.init.${f.action}`)}  ${f.file}${f.backup ? `  (${ctx.t('wf.init.backup', { file: f.backup })})` : ''}`);
  }
  if (res.files.some((f) => f.action === 'kept')) L.push(ctx.t('wf.init.keptHint'));
  L.push(ctx.t('wf.init.next'));
  ctx.emit(res, L);
  return 0;
}

module.exports = {
  name: 'init',
  summary: { en: 'Set up agent-crew in this project', 'zh-TW': '在此專案設定 agent-crew' },
  usage: {
    en: '  crew init [--lang en|zh-TW] [--force]',
    'zh-TW': '  crew init [--lang en|zh-TW] [--force]',
  },
  requiresAction: false,
  run,
};
