'use strict';

// No requires on purpose: scripts/crew-hook.js loads this before anything else so an ordinary Bash command
// (not a push / merge / PR) is answered without loading the rest of crewgate.
const GIT_WORDS = /\b(push|merge|create)\b/;
const MAX_SCAN = 20000;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Words in a crew subagent's command that agentlimits.js may deny: a git command that changes a tree, a kill by name.
const LIMIT_WORDS = /\b(checkout|switch|reset|merge|rebase|commit|stash|clean|restore|cherry-pick|push|pull|revert|am|worktree|branch|taskkill|stop-process|spps|pkill|killall)\b/i;
const gitish = (command) => GIT_WORDS.test(String(command || '').slice(0, MAX_SCAN));

// True when this PreToolUse payload is a shell call that PreToolUse has nothing to say about.
function bashNoop(payload) {
  if (!payload || !SHELL_TOOLS.has(payload.tool_name)) return false;
  const ti = payload.tool_input;
  const command = ti && typeof ti === 'object' && typeof ti.command === 'string' ? ti.command : '';
  if (payload.agent_id && LIMIT_WORDS.test(command.slice(0, MAX_SCAN))) return false;
  return !gitish(command);
}

module.exports = { GIT_WORDS, LIMIT_WORDS, SHELL_TOOLS, gitish, bashNoop };
