'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const priority = require('../lib/hooks/priority');
const config = require('../lib/core/config');

const claude = { name: 'claude.exe', args: '' };
const mk = (info, current) => {
  const calls = [];
  return { calls, describe: () => info, getPriority: () => current, setPriority: (pid, p) => calls.push([pid, p]) };
};

test('lowers a normal-priority Claude Code parent to below normal', () => {
  const d = mk(claude, 0);
  assert.strictEqual(priority.lower('below_normal', 4242, d), 'lowered');
  assert.deepStrictEqual(d.calls, [[4242, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
});

test('never raises a process that is already lower, and does nothing for "normal"', () => {
  const low = mk(claude, 19);
  assert.strictEqual(priority.lower('below_normal', 4242, low), 'already');
  assert.strictEqual(low.calls.length, 0);
  const off = mk(claude, 0);
  assert.strictEqual(priority.lower('normal', 4242, off), 'off');
  assert.strictEqual(off.calls.length, 0);
});

test('leaves a parent alone when it is not identified as Claude Code', () => {
  for (const info of [null, { name: 'bash.exe', args: '' }, { name: 'node.exe', args: 'node something.js' }, { name: 'codex', args: 'codex' }]) {
    const d = mk(info, 0);
    assert.strictEqual(priority.lower('below_normal', 4242, d), 'not-claude');
    assert.strictEqual(d.calls.length, 0);
  }
  assert.strictEqual(priority.lower('below_normal', 0, mk(claude, 0)), 'no-parent');
});

test('a node-run Claude Code is recognized by its command line; errors are swallowed', () => {
  assert.ok(priority.isClaude({ name: 'node', args: 'node /x/node_modules/@anthropic-ai/claude-code/cli.js' }));
  const d = mk(claude, 0);
  d.setPriority = () => { throw new Error('denied'); };
  assert.strictEqual(priority.lower('below_normal', 4242, d), 'error');
});

test('limits.process_priority defaults to below_normal and only accepts the two values', () => {
  assert.strictEqual(config.DEFAULTS.limits.process_priority, 'below_normal');
  const text = (r) => JSON.stringify(r);
  assert.ok(!text(config.validate({ limits: { process_priority: 'normal' } })).includes('process_priority'));
  assert.ok(text(config.validate({ limits: { process_priority: 'high' } })).includes('process_priority'));
});
