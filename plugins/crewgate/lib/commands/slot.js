'use strict';

const { parse } = require('../core/args');
const { UsageError } = require('../core/errors');
const slots = require('../core/slots');

const SPEC = {
  positionals: [],
  rest: 'command',
  options: {
    '--slots': { dest: 'slots', int: true, default: 1 },
    '--max-wait': { dest: 'maxWait', int: true, default: slots.DEFAULT_MAX_WAIT_S },
  },
};

// The slot.timeout event goes to the project of the cwd, when there is one. Best effort.
function timeoutEvent(ctx) {
  return ({ waitedSeconds }) => {
    const p = ctx.project();
    if (p) require('../core/events').append(p.id, { type: 'slot.timeout', data: { waited_seconds: waitedSeconds } });
  };
}

async function run(argv, ctx) {
  if (argv[0] !== 'run') throw new UsageError('slot.usage');
  const a = parse(argv.slice(1), SPEC);
  if (!a.command.length) throw new UsageError('slot.noCommand');
  if (a.slots < 1) throw new UsageError('slot.badNumber', { name: '--slots', min: 1 });
  if (a.maxWait < 0) throw new UsageError('slot.badNumber', { name: '--max-wait', min: 0 });
  return slots.run(a.command, {
    slots: a.slots,
    maxWaitSeconds: a.maxWait,
    say: (key, vars) => ctx.err(ctx.t(key, vars)),
    onTimeout: timeoutEvent(ctx),
    noteMs: Number(process.env.CREWGATE_SLOT_NOTE_MS) || undefined,
    pollMs: Number(process.env.CREWGATE_SLOT_POLL_MS) || undefined,
  });
}

module.exports = {
  name: 'slot',
  summary: { en: 'Take a machine-wide slot for a heavy command', 'zh-TW': '為重型指令取得全機器共用的名額' },
  usage: {
    en: '  crew slot run [--slots N] [--max-wait SECONDS] -- <command...>',
    'zh-TW': '  crew slot run [--slots N] [--max-wait 秒數] -- <指令...>',
  },
  run,
};
