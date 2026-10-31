'use strict';

// UserPromptSubmit: only keeps the session digest counters (prompt count, first/last prompt).
// Also keeps the times of the last prompts (for the gate user-turn rule). It never adds context, so it costs the model nothing.
const C = require('./common');
const sess = require('./session');

const PROMPT_KEEP = 20;

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  // A background-task notification is not something the user typed: the model is working, nothing more.
  if (typeof h.payload.prompt === 'string' && h.payload.prompt.trimStart().startsWith('<task-notification>')) {
    sess.touch(h, (s) => { s.turn_open = true; s.ends_question = false; });
    return null;
  }
  const snip = C.snippet(h.payload.prompt, 200);
  sess.touch(h, (s) => {
    s.prompts = (s.prompts || 0) + 1;
    if (!s.first_prompt) s.first_prompt = snip;
    s.last_prompt = snip;
    // Times only (no text): the gate rule "a user message between ask and answer" reads them.
    s.prompt_ts = [...(Array.isArray(s.prompt_ts) ? s.prompt_ts : []), Date.now()].slice(-PROMPT_KEEP);
    s.turn_open = true;
    s.ends_question = false;
  });
  return null;
}

module.exports = { run };
