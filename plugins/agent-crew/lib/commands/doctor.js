'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('../core/config');
const project = require('../core/project');
const common = require('../features/common');

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
          if (res.statusCode === 200 && j && j.ok === true && j.name === 'agent-crew') return resolve({ state: 'running', detail: '' });
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
  let cfg = config.loadGlobal().config;
  if (!root && !proj) {
    add('config', 'warn', ctx.t('wf.doctor.noProject'));
    add('registration', 'warn', ctx.t('wf.doctor.noProject'));
  } else {
    const dir = proj ? proj.path : root;
    const loaded = config.load(dir);
    if (!loaded.exists) add('config', 'warn', ctx.t('wf.doctor.noConfig', { file: loaded.file }));
    else if (loaded.errors.length) {
      add('config', 'fail', loaded.errors.map((e) => `${path.relative(dir, e.file) || e.file}: ${e.path || '(file)'} - ${e.message}`).join('; '));
    } else add('config', 'ok', loaded.file);
    if (loaded.exists && !loaded.errors.length) cfg = { ...cfg, port: loaded.config.board.port, boardEnabled: loaded.config.board.enabled };
    add('registration', proj ? 'ok' : 'warn', proj ? `${proj.id} (${proj.name})` : ctx.t('wf.doctor.notRegistered'));
    const expected = ['.claude/agents/crew-worker.md', '.claude/agents/crew-reviewer.md', '.claude/agents/crew-refuter.md', '.crew/REVIEW.md', '.crew/LESSONS.md'];
    const missing = expected.filter((f) => !fs.existsSync(path.join(dir, ...f.split('/'))));
    add('files', missing.length ? 'warn' : 'ok', missing.length ? ctx.t('wf.doctor.filesMissing', { files: missing.join(', ') }) : ctx.t('wf.doctor.filesOk'));
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
  }

  const ok = checks.every((c) => c.status !== 'fail');
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  ctx.emit({ ok, checks }, [
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
