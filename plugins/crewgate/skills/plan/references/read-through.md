# Builder read-through

Read with section 3 of the plan skill.

1. Send a fresh read-only subagent the output of `crew plan show <slug>`. Its prompt: "You must build this
   plan. List every point where you would have to guess: a missing decision, an unclear step, an undefined
   term, a 'done when' you could not check. One line each. Do not judge whether the plan is good."
2. Sort each item it lists:
   - Already answered: point to the plan line; nothing else to do.
   - Minor: decide it yourself and record it with
     `crew plan clarify <slug> --question "..." --answer "..." --by decision`.
   - Needs the user: a real decision.
3. Ask only the third kind, in one extra round in the format of section 2. Record each answer with
   `crew plan clarify`.
