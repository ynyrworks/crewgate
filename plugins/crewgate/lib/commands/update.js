'use strict';

// crew update check [--force] | apply — the terminal twin of the board's update banner.
const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const updateCheck = require('../core/update-check');
const updateApply = require('../core/update-apply');

const SPECS = {
  check: { positionals: [], options: { '--force': { dest: 'force', flag: true } } },
  apply: { positionals: [], options: {} },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function currentVersion() {
  return require('../../board/server').pluginVersion();
}

function describe(ctx, s) {
  if (!s.enabled) return [ctx.t('update.disabled')];
  if (!s.latest) return [ctx.t('update.unknown', { current: s.current })];
  if (!s.kind) return [ctx.t('update.upToDate', { current: s.current })];
  const lines = [ctx.t('update.available', { latest: s.latest, current: s.current, kind: ctx.t(`update.kind.${s.kind}`) }), ctx.t('update.notes', { url: s.notes_url })];
  if (s.rehook) lines.push(ctx.t('update.rehook'));
  lines.push(ctx.t('update.howTo'));
  return lines;
}

async function check(ctx, a) {
  const s = await updateCheck.check({ current: currentVersion(), force: a.force === true });
  ctx.emit(s, describe(ctx, s));
  return 0;
}

// Stops the running board (if any) and starts the updated code on the same port.
async function restartBoard(ctx, newRoot) {
  const board = require('./board');
  const cur = await board.running();
  if (!cur) return null;
  try { process.kill(cur.pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && board.alive(cur.pid)) await sleep(100);
  const r = await updateApply.launchReplacement(newRoot, cur.port);
  ctx.out(ctx.t(r.ok ? 'update.boardRestarted' : 'update.boardRestartFailed', { cmd: updateApply.RESTART_COMMAND }));
  return r.ok;
}

async function apply(ctx) {
  const runner = updateApply.createRunner({ pluginRoot: require('path').resolve(__dirname, '..', '..') });
  const r = runner.start();
  if (!r.started) { ctx.err(ctx.t('update.busy')); return 1; }
  await r.done;
  const s = runner.status();
  if (s.state === 'manual') {
    ctx.emit(s, [ctx.t('update.manualIntro'), ...s.manual.flatMap((g) => [`  # ${g.tool}`, ...g.commands.map((c) => `  ${c}`)])]);
    return 0;
  }
  const lines = s.steps.map((x) => (x.ok ? ctx.t('update.stepOk', { cmd: x.cmd }) : `${ctx.t('update.stepFail', { cmd: x.cmd, code: x.code === null ? '-' : x.code })}${x.output ? `\n${x.output}` : ''}`));
  if (s.state === 'failed') {
    ctx.emit(s, [...lines, ctx.t(s.error)]);
    return 1;
  }
  lines.push(ctx.t('update.updated', { version: s.new_version || '?' }));
  ctx.emit(s, lines);
  if (!ctx.json) await restartBoard(ctx, runner.newRoot());
  if (!ctx.json) ctx.out(ctx.t('update.newSession'));
  return 0;
}

async function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('update.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  return sub === 'check' ? check(ctx, a) : apply(ctx);
}

module.exports = {
  name: 'update',
  summary: { en: 'Check for a newer crewgate release and update', 'zh-TW': '檢查 crewgate 新版並更新' },
  usage: {
    en: '  crew update check [--force]\n  crew update apply',
    'zh-TW': '  crew update check [--force]\n  crew update apply',
  },
  run,
};
