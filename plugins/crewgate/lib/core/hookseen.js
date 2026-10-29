'use strict';

// Which hook events fired for a project, and when (<project runtime>/hook-seen.json). Written by the
// hooks themselves, so `crew doctor` and the board can show that, say, SessionEnd never arrived
// (a session that began before the plugin was installed only gets hooks from then on).
const fs = require('fs');
const path = require('path');
const json = require('./json');
const paths = require('./paths');

const THROTTLE_MS = 60 * 1000;
// hook script argument -> Claude Code event name
const EVENT_NAMES = {
  'session-start': 'SessionStart', 'user-prompt-submit': 'UserPromptSubmit', 'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse', 'subagent-start': 'SubagentStart', 'subagent-stop': 'SubagentStop',
  stop: 'Stop', 'pre-compact': 'PreCompact', 'session-end': 'SessionEnd',
};
// Events whose absence points at a session that began before the plugin (or at broken wiring).
const LIFECYCLE = ['SessionStart', 'Stop', 'SessionEnd'];

const file = (pid) => path.join(paths.runtimeDir(pid), 'hook-seen.json');

function readRaw(pid) {
  try {
    const d = JSON.parse(fs.readFileSync(file(pid), 'utf8'));
    return d && typeof d === 'object' && d.events && typeof d.events === 'object' ? d.events : {};
  } catch { return {}; }
}

// note(pid, 'post-tool-use'): at most one write per event type per minute; never throws.
function note(pid, event, now = Date.now()) {
  try {
    const name = EVENT_NAMES[event];
    if (!name || !pid) return;
    const last = Date.parse(readRaw(pid)[name]);
    if (Number.isFinite(last) && now - last < THROTTLE_MS && now >= last) return;
    fs.mkdirSync(path.dirname(file(pid)), { recursive: true });
    json.update(file(pid), { events: {} }, (d) => {
      if (!d.events || typeof d.events !== 'object') d.events = {};
      d.events[name] = new Date(now).toISOString();
      d.v = 1;
      return d;
    }, () => {});
  } catch { /* observability only */ }
}

// read(pid) -> [{ event, last }] for every known event, last = ISO time or null; plus `missing`
// (lifecycle events never seen).
function read(pid) {
  const seen = readRaw(pid);
  const rows = Object.values(EVENT_NAMES).map((event) => ({ event, last: typeof seen[event] === 'string' ? seen[event] : null }));
  return { rows, missing: LIFECYCLE.filter((e) => !seen[e]) };
}

module.exports = { note, read, EVENT_NAMES, LIFECYCLE, THROTTLE_MS };
