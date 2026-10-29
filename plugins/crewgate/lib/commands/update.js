'use strict';

// crew update check [--force] | apply | cleanup [--dry-run] — the terminal twin of the board's update banner.
const path = require('path');
const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const updateCheck = require('../core/update-check');
const updateApply = require('../core/update-apply');
const updateCleanup = require('../core/update-cleanup');

const SPECS = {
  check: { positionals: [], options: { '--force': { dest: 'force', flag: true } } },
  apply: { positionals: [], options: {} },
  cleanup: { positionals: [], options: { '--dry-run': { dest: 'dryRun', flag: true } } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1);
const toolName = (tool) => (tool === 'codex' ? 'Codex' : 'Claude');

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

// One line per tool: updated / skipped (not installed) / manual (CLI not found) / failed.
function resultLines(ctx, s) {
  return (s.results || []).map((r) => {
    const reason = r.reason ? ` (${ctx.t(`update.reason.${r.reason}`, { tool: toolName(r.tool) })})` : '';
    return ctx.t(`update.result.${r.status}`, { tool: toolName(r.tool) }) + reason;
  });
}

function manualLines(ctx, s) {
  return (s.manual || []).flatMap((g) => {
    const why = g.reason ? ` - ${ctx.t(`update.reason.${g.reason}`, { tool: toolName(g.tool) })}` : '';
    return [`  # ${g.tool}${why}`, ...g.commands.map((c) => `  ${c}`)];
  });
}

async function apply(ctx) {
  const runner = updateApply.createRunner({ pluginRoot: path.resolve(__dirname, '..', '..') });
  const r = runner.start();
  if (!r.started) { ctx.err(ctx.t('update.busy')); return 1; }
  await r.done;
  const s = runner.status();
  if (s.state === 'manual') {
    ctx.emit(s, [...resultLines(ctx, s), ctx.t('update.manualIntro'), ...manualLines(ctx, s)]);
    return 0;
  }
  const lines = s.steps.map((x) => (x.ok ? ctx.t('update.stepOk', { cmd: x.cmd }) : `${ctx.t('update.stepFail', { cmd: x.cmd, code: x.code === null ? '-' : x.code })}${x.output ? `\n${x.output}` : ''}`));
  lines.push(...resultLines(ctx, s));
  if (s.manual.length) lines.push(ctx.t('update.manualIntro'), ...manualLines(ctx, s));
  if (s.state === 'failed') {
    ctx.emit(s, [...lines, ctx.t(s.error)]);
    return 1;
  }
  lines.push(ctx.t('update.updated', { version: s.new_version || '?' }));
  if (s.old_versions && s.old_versions.count) lines.push(ctx.t('update.oldVersions', { count: s.old_versions.count, mb: mb(s.old_versions.bytes) }), ctx.t('update.cleanupHow'));
  ctx.emit(s, lines);
  if (!ctx.json) await restartBoard(ctx, runner.newRoot());
  if (!ctx.json) ctx.out(ctx.t('update.newSession'));
  return 0;
}

function cleanup(ctx, a) {
  const o = { dirs: updateApply.configDirs(process.env), pluginRoot: path.resolve(__dirname, '..', '..') };
  if (a.dryRun) {
    const s = updateCleanup.scan(o);
    ctx.emit(s, s.count ? [ctx.t('update.oldVersions', { count: s.count, mb: mb(s.bytes) }), ...s.items.map((i) => `  ${toolName(i.tool)} ${i.version}`)] : [ctx.t('update.noOld')]);
    return 0;
  }
  const r = updateCleanup.cleanup(o);
  const lines = r.removed.map((i) => ctx.t('update.removed', { tool: toolName(i.tool), version: i.version }));
  for (const k of r.kept) lines.push(ctx.t(`update.kept.${k.reason}`, { tool: toolName(k.tool), version: k.version }));
  lines.push(r.removed.length || r.kept.length ? ctx.t('update.freed', { mb: mb(r.freed) }) : ctx.t('update.noOld'));
  ctx.emit(r, lines);
  return r.kept.length ? 1 : 0;
}

async function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('update.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  if (sub === 'cleanup') return cleanup(ctx, a);
  return sub === 'check' ? check(ctx, a) : apply(ctx);
}

module.exports = {
  name: 'update',
  summary: { en: 'Check for a newer crewgate release and update', 'zh-TW': '檢查 crewgate 新版並更新' },
  usage: {
    en: '  crew update check [--force]\n  crew update apply\n  crew update cleanup [--dry-run]',
    'zh-TW': '  crew update check [--force]\n  crew update apply\n  crew update cleanup [--dry-run]',
  },
  run,
};
