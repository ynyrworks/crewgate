'use strict';

// One table for hook timing. TIMEOUT_S mirrors hooks/hooks.json (the smallest timeout of any
// entry of that event, in seconds); the in-process guard that answers `{}` is derived from it, so
// the guard always fires before Claude Code kills the hook. A test keeps the table and
// hooks.json in agreement.
const TIMEOUT_S = {
  'session-start': 10,
  'user-prompt-submit': 5,
  'pre-tool-use': 5,      // the Read matcher is 5, the Agent/Edit matchers are 10
  'post-tool-use': 10,
  'subagent-start': 10,
  'subagent-stop': 10,
  stop: 10,
  'pre-compact': 10,
  'session-end': 2,
};

const GUARD_OVERRIDE_MS = { 'session-end': 1200 };   // SessionEnd is cut off early by Claude Code, leave room
const MIN_GUARD_MS = 500;

// guard = timeout - 1 s, at least 0.5 s
function guardMs(event) {
  if (Object.prototype.hasOwnProperty.call(GUARD_OVERRIDE_MS, event)) return GUARD_OVERRIDE_MS[event];
  const t = TIMEOUT_S[event];
  return Math.max(MIN_GUARD_MS, ((Number.isFinite(t) ? t : 10) - 1) * 1000);
}

module.exports = { TIMEOUT_S, GUARD_OVERRIDE_MS, guardMs };
