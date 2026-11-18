'use strict';

// UserPromptSubmit: only keeps the session digest counters (prompt count, first/last prompt).
// Also keeps the times of the last prompts (for the gate user-turn rule). It never adds context, so it costs the model nothing.
const C = require('./common');
const sess = require('./session');

const { clean } = require('../core/redact');

const PROMPT_KEEP = 20;
const TURN_PROMPT_MAX = 4000;

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  // A background-task notification is not something the user typed: the model is working, nothing more.
  if (typeof h.payload.prompt === 'string' && h.payload.prompt.trimStart().startsWith('<task-notification>')) {
    sess.touch(h, (s) => { s.turn_open = true; s.ends_question = false; delete s.turn_prompt; });
    return null;
  }
  const snip = C.snippet(h.payload.prompt, 200);
  // The text of the prompt that starts this turn, for `--quote` (an instruction that names the action). Session file only.
  const now = Date.now();
  const text = typeof h.payload.prompt === 'string' ? clean(h.payload.prompt.slice(0, TURN_PROMPT_MAX * 2), TURN_PROMPT_MAX) : '';
  sess.touch(h, (s) => {
    s.turn_prompt = { ts: now, text };
    s.prompts = (s.prompts || 0) + 1;
    if (!s.first_prompt) s.first_prompt = snip;
    s.last_prompt = snip;
    // Times only (no text): the gate rule "a user message between ask and answer" reads them.
    s.prompt_ts = [...(Array.isArray(s.prompt_ts) ? s.prompt_ts : []), now].slice(-PROMPT_KEEP);
    s.turn_open = true;
    s.ends_question = false;
  });
  return null;
}

module.exports = { run };
