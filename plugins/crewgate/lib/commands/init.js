'use strict';

const { parse } = require('../core/args');
const project = require('../core/project');
const { init } = require('../features/init');
const config = require('../core/config');
const codexinit = require('../features/codexinit');

const SPEC = {
  positionals: [],
  options: { '--lang': { dest: 'lang', choices: ['en', 'zh-TW'] }, '--force': { dest: 'force', flag: true },
    '--reset-review-files': { dest: 'resetReviewFiles', flag: true },
    '--engine': { dest: 'engine', choices: ['claude', 'codex'] },
  },
};

function run(argv, ctx) {
  // --lang is also a global option, so the dispatcher hands it over as ctx.langOption
  const a = parse(argv, SPEC);
  // repo files go to the work tree the user is in (a linked worktree gets its own copy); the
  // project identity still maps to the main checkout (project.add inside init() does that)
  const root = project.detectWorkTree(ctx.cwd) || ctx.cwd;
  const res = init(root, { lang: a.lang || ctx.langOption, force: a.force, resetReviewFiles: a.resetReviewFiles, fallbackLang: ctx.lang });
  // Codex (experimental): asked for with --engine codex, or detected from an existing .codex folder
  if (a.engine === 'codex' || (a.engine !== 'claude' && codexinit.detectCodex(root))) {
    res.files.push(...codexinit.codexInit(root, config.load(root).config, { force: a.force }));
  }
  try { require('../core/clishim').write(); } catch { /* scripts lose a convenience; init goes on */ }
  const L = [ctx.t(res.created ? 'wf.init.registered' : 'wf.init.alreadyRegistered', { id: res.project.id, name: res.project.name })];
  for (const f of res.files) {
    L.push(`  ${ctx.t(`wf.init.${f.action}`)}  ${f.file}${f.backup ? `  (${ctx.t('wf.init.backup', { file: f.backup })})` : ''}`);
  }
  if (res.files.some((f) => f.action === 'kept')) L.push(ctx.t('wf.init.keptHint'));
  if (res.checks.written) L.push(ctx.t('wf.init.checksChosen', { checks: res.checks.detected.join(', ') }));
  else if (!res.checks.kept) L.push(ctx.t('wf.init.checksNone'));
  L.push(ctx.t('wf.init.agentsPrecedence'));
  L.push(ctx.t('wf.init.next'));
  ctx.emit(res, L);
  return 0;
}

module.exports = {
  name: 'init',
  summary: { en: 'Set up crewgate in this project', 'zh-TW': '在此專案設定 crewgate' },
  usage: {
    en: '  crew init [--lang en|zh-TW] [--force] [--reset-review-files] [--engine claude|codex]',
    'zh-TW': '  crew init [--lang en|zh-TW] [--force] [--reset-review-files] [--engine claude|codex]',
  },
  requiresAction: false,
  run,
};
