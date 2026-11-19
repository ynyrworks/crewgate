# Running in Codex (experimental)

The same plugin works when the orchestrator is a Codex session. What differs:

- **CLI path.** Use the `crew` command shown in the crewgate block of `AGENTS.md` (written by
  `crew init --engine codex`); `${CLAUDE_PLUGIN_ROOT}` is only a hook variable in Codex.
- **Approvals.** `crew` writes under `~/.crewgate`, which the default workspace-write sandbox blocks.
  Ask the user to approve the `crew` commands (or to run Codex with a wider sandbox) before the first call.
- **Workers.** Never spawn a Codex subagent to implement: subagents share your sandbox and cannot
  run `git commit` in a worktree. Create the task and brief as usual, then run
  `crew task run <id> --engine codex [--timeout 1800] [--model M]`. It creates the worktree and
  branch when they are missing, starts the Codex CLI in the worktree, commits the result as the
  repository user with a `Co-Authored-By: Codex` trailer, files the report and moves the task to
  `returned`. The command blocks until Codex is done: run it in the background when you can. On bad
  output, a timeout or a non-zero exit it commits nothing, records `task.failed` and a need and
  leaves the worktree for inspection; read `crew task show` and `codex.log` in the task folder,
  fix the brief and run again, or cancel.
- **Reviewer and refuter.** Spawn the `crew-reviewer` / `crew-refuter` custom agents
  (`.codex/agents/`) and put the printed prompt in the message. Keep the line `crew-task: <id>` in
  the message so the hook links the subagent to the task.
- **Hooks** run only after the user trusted them once in `/hooks`, and again after every plugin
  update that changes a hook command.
- **Gates.** Codex cannot answer a permission prompt, so `gates.enforce` `confirm` denies like `block`.
- Everything else (briefs, gates, lessons, handoff) is identical.
