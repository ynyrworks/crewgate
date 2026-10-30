'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('../core/config');
const project = require('../core/project');
const common = require('../features/common');
const execx = require('../core/exec');
const hookseen = require('../core/hookseen');
const store = require('../core/store');
const hooklog = require('../core/hooklog');
const gates = require('../core/gates');
const plans = require('../core/plans');
const boardCmd = require('./board');

// GET http://127.0.0.1:<port>/api/health -> { state: 'running'|'down'|'other', detail }
function probeBoard(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 4096) body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode === 200 && j && j.ok === true && j.name === 'crewgate') return resolve({ state: 'running', detail: '' });
        } catch { /* fall through */ }
        resolve({ state: 'other', detail: `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'down', detail: 'timeout' }); });
    req.on('error', (e) => resolve({ state: 'down', detail: e.code || e.message }));
  });
}

async function run(argv, ctx) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'fail', major >= 18 ? process.versions.node : ctx.t('wf.doctor.nodeOld', { v: process.versions.node }));

  const root = project.detectRoot(ctx.cwd);
  const proj = ctx.project();
  const wtRoot = proj ? ctx.workTree() : (project.detectWorkTree(ctx.cwd) || root);
  let cfg = config.loadGlobal().config;
  if (!root && !proj) {
    add('config', 'warn', ctx.t('wf.doctor.noProject'));
    add('registration', 'warn', ctx.t('wf.doctor.noProject'));
  } else {
    const dir = wtRoot || (proj ? proj.path : root);
    const projDir = proj ? proj.path : root;
    if (projDir && path.resolve(projDir) !== path.resolve(dir)) add('worktree', 'ok', ctx.t('wf.doctor.worktree', { workTree: dir, root: projDir }));
    const loaded = config.loadFor(dir, projDir);
    if (!loaded.exists) add('config', 'warn', ctx.t('wf.doctor.noConfig', { file: loaded.file }));
    else if (loaded.errors.length) {
      add('config', 'fail', loaded.errors.map((e) => `${path.relative(dir, e.file) || e.file}: ${e.path || '(file)'} - ${e.message}`).join('; '));
    } else if (loaded.warnings.length) {
      add('config', 'warn', loaded.warnings.map((w) => w.message).join('; '));
    } else add('config', 'ok', loaded.file);
    if (loaded.exists && !loaded.errors.length) cfg = { ...cfg, port: loaded.config.board.port, boardEnabled: loaded.config.board.enabled };
    if (loaded.exists && !loaded.errors.length) {
      const empty = !(loaded.config.checks && loaded.config.checks.length);
      add('checks', empty ? 'warn' : 'ok', empty ? ctx.t('wf.doctor.checksEmpty') : loaded.config.checks.join('; '));
    }
    if (loaded.exists && !loaded.errors.length) {
      const enforce = gates.enforceOf(loaded.config);
      add('gates', 'ok', ctx.t(`wf.doctor.gates.${enforce}`, { turn: ctx.t(gates.requiresUserTurn(loaded.config) ? 'wf.doctor.gates.turnOn' : 'wf.doctor.gates.turnOff'), ask: ['push', 'open_pr', 'merge'].filter((k) => gates.modeOf(loaded.config, k) === 'ask').join(', ') || '-' }));
    }
    add('registration', proj ? 'ok' : 'warn', proj ? `${proj.id} (${proj.name})` : ctx.t('wf.doctor.notRegistered'));
    const expected = ['.claude/agents/crew-worker.md', '.claude/agents/crew-reviewer.md', '.claude/agents/crew-refuter.md', '.crew/REVIEW.md', '.crew/LESSONS.md'];
    const missing = expected.filter((f) => !fs.existsSync(path.join(dir, ...f.split('/'))));
    add('files', missing.length ? 'warn' : 'ok', missing.length ? ctx.t('wf.doctor.filesMissing', { files: missing.join(', ') }) : ctx.t('wf.doctor.filesOk'));
    const nPlans = plans.slugs(dir).length;
    if (nPlans) {
      const deep = plans.deepNodes(dir);
      const dups = plans.duplicateNodes(dir);
      const bits = [];
      if (deep.length) bits.push(ctx.t('wf.doctor.plansDeep', { max: plans.MAX_DEPTH, where: deep.slice(0, 5).map((x) => `${x.slug}:${x.line}`).join(', ') }));
      if (dups.length) bits.push(ctx.t('wf.doctor.plansDup', { where: dups.slice(0, 5).map((x) => `${x.slug} (${x.ids.join(', ')})`).join('; ') }));
      add('plans', bits.length ? 'warn' : 'ok', bits.length ? bits.join('; ') : ctx.t('wf.doctor.plansOk', { n: nPlans }));
    }
  }

  let seen = null;
  if (proj) {
    seen = hookseen.read(proj.id);
    const fmt = (r) => `${r.event} ${r.last || ctx.t('wf.doctor.neverSeen')}`;
    const detail = seen.rows.filter((r) => r.last || hookseen.LIFECYCLE.includes(r.event)).map(fmt).join('; ');
    add('hookseen', seen.missing.length ? 'warn' : 'ok', seen.missing.length
      ? `${ctx.t('wf.doctor.hookSeenMissing', { events: seen.missing.join(', ') })} (${detail})` : detail);
    const dups = store.workDuplicates(proj.id);
    if (dups.length) add('work', 'warn', ctx.t('wf.doctor.workDuplicates', { items: dups.map((x) => `${x.stream} / ${x.title} (${x.count})`).join('; ') }));
  }

  const hookErrors = hooklog.counts();
  const fmtBy = (by) => Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  add('hookerrors', hookErrors.h24.total ? 'warn' : 'ok', hookErrors.d7.total
    ? ctx.t('wf.doctor.hookErrors', { h24: hookErrors.h24.total, d7: hookErrors.d7.total, by: fmtBy(hookErrors.d7.by), file: hooklog.file() })
    : ctx.t('wf.doctor.hookErrorsNone'));

  const engines = config.globalEngines();
  for (const [name, eng] of Object.entries(engines)) {
    const command = eng && typeof eng.command === 'string' ? eng.command : '';
    const file = execx.resolveCommand(command, { cwd: ctx.cwd });
    add('engine', file ? 'ok' : 'warn', ctx.t(file ? 'wf.doctor.engineOk' : 'wf.doctor.engineMissing', { name, command, file }));
  }

  const hooksFile = path.join(common.PLUGIN_ROOT, 'hooks', 'hooks.json');
  let hooksOk = false;
  let hooksDetail = ctx.t('wf.doctor.hooksMissing', { file: hooksFile });
  try {
    const h = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    hooksOk = !!(h && h.hooks && Object.keys(h.hooks).length);
    hooksDetail = hooksOk ? hooksFile : ctx.t('wf.doctor.hooksEmpty', { file: hooksFile });
  } catch (e) {
    if (e.code !== 'ENOENT') hooksDetail = ctx.t('wf.doctor.hooksBad', { file: hooksFile });
  }
  add('hooks', hooksOk ? 'ok' : 'fail', hooksDetail);

  if (cfg.boardEnabled === false) {
    add('board', 'ok', ctx.t('wf.doctor.boardDisabled'));
  } else {
    const port = cfg.port;
    const b = await probeBoard(port);
    if (b.state === 'running') add('board', 'ok', ctx.t('wf.doctor.boardRunning', { port }));
    else if (b.state === 'down') add('board', 'ok', ctx.t('wf.doctor.boardDown', { port }));
    else add('board', 'warn', ctx.t('wf.doctor.boardOther', { port, detail: b.detail }));
    if (b.state !== 'running') {
      const stale = boardCmd.staleState();
      if (stale) add('board', 'warn', ctx.t('board.stale', { pid: stale.pid, started: stale.started || '?', log: boardCmd.logFile() }));
    }
  }
  add('autostart', 'ok', ctx.t(config.loadGlobal().config.board.autostart ? 'wf.doctor.autostartOn' : 'wf.doctor.autostartOff'));

  try {
    const u = require('../core/update-check').checkState({ current: require('../../board/server').pluginVersion() });
    const v = { current: u.current, latest: u.latest };
    if (!u.enabled) add('update', 'ok', ctx.t('wf.doctor.updateOff'));
    else if (!u.latest) add('update', 'ok', ctx.t('wf.doctor.updateUnknown', v));
    else add('update', u.kind ? 'warn' : 'ok', ctx.t(u.kind ? 'wf.doctor.updateNewer' : 'wf.doctor.updateCurrent', v));
  } catch { /* the update notice is optional */ }

  const ok = checks.every((c) => c.status !== 'fail');
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  ctx.emit({ ok, checks, hook_errors: hookErrors, ...(seen ? { hook_seen: seen.rows } : {}) }, [
    ...checks.map((c) => `${mark[c.status]}  ${ctx.t(`wf.doctor.name.${c.name}`)}: ${c.detail}`),
    ctx.t(ok ? 'wf.doctor.allOk' : 'wf.doctor.problems'),
  ]);
  return ok ? 0 : 1;
}

module.exports = {
  name: 'doctor',
  summary: { en: 'Check the installation and this project', 'zh-TW': '檢查安裝與此專案的狀態' },
  usage: { en: '  crew doctor', 'zh-TW': '  crew doctor' },
  requiresAction: false,
  run,
  probeBoard,
};
