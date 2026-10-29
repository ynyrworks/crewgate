'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const gates = require('../core/gates');
const tasks = require('../core/tasks');

const SPECS = {
  ask: {
    positionals: [{ name: 'gate' }],
    options: { '--task': { dest: 'task' }, '--detail': { dest: 'detail' } },
  },
  answer: {
    positionals: [{ name: 'id' }, { name: 'answer', choices: ['yes', 'no'] }],
    options: { '--note': { dest: 'note' } },
  },
};

function run(argv, ctx) {
  const sub = argv[0];
  if (!Object.prototype.hasOwnProperty.call(SPECS, sub)) throw new UsageError('gate.usage');
  const a = parse(argv.slice(1), SPECS[sub]);
  const proj = ctx.requireProject();
  const opts = { src: 'cli', session: process.env.CLAUDE_SESSION_ID || undefined };
  if (sub === 'ask') {
    if (a.task) tasks.load(proj.id, a.task);
    const r = gates.ask(proj.id, ctx.config().config, a, opts);
    ctx.emit(r, [ctx.t(r.mode === 'auto' ? 'gate.askedAuto' : 'gate.asked', { id: r.id, gate: r.gate })]);
  } else {
    const r = gates.answer(proj.id, a.id, a.answer, a.note, opts);
    ctx.emit(r, ctx.t('gate.answered', { id: r.id, gate: r.gate, answer: r.answer }));
  }
  return 0;
}

module.exports = {
  name: 'gate',
  summary: { en: 'Record approval gates (ask the user before push, PR, merge ...)', 'zh-TW': '記錄核准關卡（推送、PR、合併前先問使用者）' },
  usage: {
    en: '  crew gate ask <gate> [--task ID] [--detail "..."]   (prints a gate id; gate: push|open_pr|merge|remote_hosts|large_task|install_or_download)\n  crew gate answer <gate-id> yes|no [--note "..."]',
    'zh-TW': '  crew gate ask <gate> [--task ID] [--detail "..."]   （印出 gate id；gate：push|open_pr|merge|remote_hosts|large_task|install_or_download）\n  crew gate answer <gate-id> yes|no [--note "..."]',
  },
  run,
};
