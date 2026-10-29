# Brief template

`crew task create` refuses a brief that lacks any of these five sections or leaves one empty.
Headings may be in English or Traditional Chinese (`目標`, `範圍`, `不可退化`, `驗收`, `脈絡`).

```markdown
# Goal
One or two sentences: what must be true when this task is done, and why.

# Scope
Allowed: files and folders the worker may change (globs are fine).
Forbidden: files and folders the worker must not touch (generated files, other owners' areas, config).

# Must not regress
Existing behaviour that must keep working (name the tests or commands that prove it).
Out-of-scope fallout: if the change breaks something outside Scope, who fixes it (usually: the worker
reports it and the orchestrator decides; the worker does not widen its own scope).

# Acceptance
How "done" is checked, as commands and observable results:
- `npm test` passes, including the new tests for X
- `node bin/tool.js --flag` prints Y
Failure paths that must be covered: ...

# Context
Pointers, not dumps: `src/parser.js:40-95` (current behaviour), `docs/DESIGN.md` section 3,
related earlier task `t-...`. Decisions already made and why.
```

## Writing a good brief

- State the boundary as a list of paths. Vague scope is the main cause of regressions outside it.
- Put acceptance in commands the worker can run. "Works well" is not acceptance.
- Name the tests that must keep passing under "Must not regress".
- Point to line ranges instead of pasting code; the worker reads the files itself.
- Examples in a brief use documentation addresses only (192.0.2.x) and no real hostnames or secrets.
- One task, one reviewable change. If the brief needs "and also", make two tasks.

## Example

```markdown
# Goal
`todo list --done` shows only completed items, so users can review finished work.

# Scope
Allowed: src/commands/list.js, src/store.js, test/list.test.js
Forbidden: src/commands/add.js, package.json, any file under docs/

# Must not regress
`todo list` without flags prints all items in the same format as today (test/list.test.js "prints all").
If the store format must change, stop and report; do not migrate data.

# Acceptance
- `npm test` passes with new tests for `--done` (some done, none done, empty store)
- `node bin/todo.js list --done` on the sample store prints only the two completed items

# Context
src/commands/list.js:12-40 builds the output. The store returns items with a `done` boolean.
```

## The dispatch prompt

`crew task create` prints a ready prompt. It contains, in this order: the `crew-task: <id>` marker
line (hooks use it to link the subagent to the task), a `crew-cli:` line (how the worker calls
`crew`), the task title, the brief path, the worktree and branch, allowed/forbidden paths, the
no-push/no-network reminder and the report instructions with the language and size cap. Pass it to
the Agent tool unchanged. When re-dispatching after a send-back, append your note:

```
Send-back note (round 2): <what to fix, with file:line>. Fix only this, re-run the checks, report again.
```
