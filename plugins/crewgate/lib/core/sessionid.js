'use strict';

// The session id of the process that runs the CLI. Claude Code exports CLAUDE_CODE_SESSION_ID to the Bash tool
// (same value as the hook payload session_id); CLAUDE_SESSION_ID is kept for compatibility. CLAUDE_CODE_HOST_SESSION_ID
// is a different value and is not used. Codex: no variable is known, so undefined.
// Lives apart from gates.js so events.js can use it without a circular require.
function currentSession(env = process.env) {
  return String((env && (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID)) || '').trim() || undefined;
}

module.exports = { currentSession };
