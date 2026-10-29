# Goal

Let a todo have an optional due date. `todo add "write docs" --due 2026-11-01` stores it, and `todo list`
shows it after the title as `(due 2026-11-01)`. Items without a due date print exactly as before.

# Scope

Allowed: `src/todo.js`, `bin/todo.js`, `test/todo.test.js`.
Forbidden: `package.json`, anything under `.claude/` or `.crew/`, the `todos.json` file itself.

# Must not regress

- A todos file written by the current version (items with only `id`, `title`, `done`) must still load and print unchanged.
- `todo done <id>` and `todo list` behave exactly as before for items without a due date.
- The existing four tests keep passing; if one has to change, say why in the report.

# Acceptance

- `node --test` passes, including new tests for: adding with a due date, rejecting a malformed date (`--due tomorrow`),
  listing an item with and without a due date, loading an old-format file.
- Dates are `YYYY-MM-DD` and are validated as real calendar dates (`2026-02-30` is rejected with a clear message).
- No new dependency.

# Context

- `src/todo.js` `add` and `format` are the two functions to extend.
- `bin/todo.js` parses `process.argv` by hand; add `--due <date>` there and pass it to `add`.
- Test style: see the existing cases in `test/todo.test.js`.
