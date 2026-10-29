'use strict';

// No requires on purpose: scripts/crew-hook.js loads this before anything else so an ordinary Bash command
// (not a push / merge / PR) is answered without loading the rest of crewgate.
const GIT_WORDS = /\b(push|merge|create)\b/;
const MAX_SCAN = 20000;

const gitish = (command) => GIT_WORDS.test(String(command || '').slice(0, MAX_SCAN));

// True when this PreToolUse payload is a Bash call that PreToolUse has nothing to say about.
function bashNoop(payload) {
  if (!payload || payload.tool_name !== 'Bash') return false;
  const ti = payload.tool_input;
  const command = ti && typeof ti === 'object' && typeof ti.command === 'string' ? ti.command : '';
  return !gitish(command);
}

module.exports = { GIT_WORDS, gitish, bashNoop };
