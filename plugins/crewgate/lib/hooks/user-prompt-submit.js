'use strict';

// UserPromptSubmit: only keeps the session digest counters (prompt count, first/last prompt).
// It never adds context, so it costs the model nothing.
const C = require('./common');
const sess = require('./session');

function run(payload) {
  const h = C.open(payload);
  if (!h) return null;
  const snip = C.snippet(h.payload.prompt, 200);
  sess.touch(h, (s) => {
    s.prompts = (s.prompts || 0) + 1;
    if (!s.first_prompt) s.first_prompt = snip;
    s.last_prompt = snip;
    s.turn_open = true;
    s.ends_question = false;
  });
  return null;
}

module.exports = { run };
