'use strict';

// No requires on purpose: scripts/crew-hook.js loads this before anything else so an ordinary Bash command
// (not a push / merge / PR) is answered without loading the rest of crewgate.
const GIT_WORDS = /\b(push|merge|create)\b/;
const MAX_SCAN = 20000;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const gitish = (command) => GIT_WORDS.test(String(command || '').slice(0, MAX_SCAN));

// True when this PreToolUse payload is a shell call that PreToolUse has nothing to say about.
function bashNoop(payload) {
  if (!payload || !SHELL_TOOLS.has(payload.tool_name)) return false;
  const ti = payload.tool_input;
  const command = ti && typeof ti === 'object' && typeof ti.command === 'string' ? ti.command : '';
  return !gitish(command);
}

module.exports = { GIT_WORDS, SHELL_TOOLS, gitish, bashNoop };
