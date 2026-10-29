# Walkthrough: adding due dates to todo-cli

A whole crewgate session on a tiny, fictional project. Everything here is made up: the app, the task
ids, the findings. Command output is abbreviated and ids will differ on your machine.

`crew` below stands for `node "<plugin folder>/bin/crew.js"`. You rarely type it yourself: the
orchestrator (your main Claude session, using the `/crewgate:crew` skill) runs it, and the hooks run
on their own.

## 0. Setup (once)

```
cp -r examples/todo-cli ~/demo/todo-cli && cd ~/demo/todo-cli && git init && git add -A && git commit -m init
claude --plugin-dir /path/to/crewgate/plugins/crewgate
```

The example already contains what `crew init` creates, so there is nothing to generate:

| File | What it is |
|---|---|
| `.claude/crew.json` | language `en`, check `node --test`, two `forbidden` entries, `orchestrator_edit: "warn"` |
| `.claude/agents/crew-*.md` | the three agents, rendered from your config; `crew-worker.md` has a hand-added "Project rules" section |
| `.crew/REVIEW.md` | review rules with two project-specific rules |
| `.crew/LESSONS.md` | five sample lessons; `old-format-files` was seen on three days, so it is a promotion candidate |
| `.crew/dismissed.jsonl` | one finding the team dismissed for good |

Register the project once (this is the only registration; hooks never do it behind your back):

```
> /crewgate:crew init
Registered project p55cbaf9c89 (todo-cli)
  kept         .claude/crew.json
  ...
OK    Project config / Registration / Plugin hooks    All checks passed.
```

Optional, in a normal terminal: `crew board start` and open `http://127.0.0.1:8781/`. The board is empty
except for the project card.

## 1. You ask for the work

You type:

> Add an optional due date to todos: `todo add "x" --due 2026-11-01`, shown in the list. Delegate it.

The orchestrator does not touch `src/`. It:

1. Writes `briefs/add-due-dates.md` (see that file: Goal, Scope, Must not regress, Acceptance, Context).
2. Creates the worktree: `git worktree add ../todo-cli-due -b feat/due-dates`.
3. Creates the task:

```
crew task create --title "Add due dates" --brief-file briefs/add-due-dates.md \
  --branch feat/due-dates --worktree ../todo-cli-due --allow "src/**" --allow "bin/**" --allow "test/**"
Task t-20261029-qe0v created.
Put this exact line into the Agent prompt so the task is linked to its worker:
crew-task: t-20261029-qe0v
```

A brief missing one of the five sections would have been refused here.

4. Calls the Agent tool with `subagent_type: crew-worker`, the printed prompt and `run_in_background: true`.

**What the hooks did:** `PreToolUse(Agent)` saw the `crew-task:` marker and moved the task
`created -> dispatched`, recording the agent type, model and background flag. `SubagentStart` bound the
running subagent to the task. Nobody ran a "log" command.

**Board:** Project page, task `Add due dates` in column *dispatched*, one live subagent.

## 2. The worker returns

The worker implements in `../todo-cli-due`, runs `node --test` (the configured check), commits and files
its report:

```
crew task report t-20261029-qe0v --report-file report.md --packet-file packet.md
```

The command rejects a report with a missing section or more than `report_max_tokens`. When the subagent
stops, `SubagentStop` adds a line for the orchestrator: *task t-20261029-qe0v returned, review it with
`crew task show`*. If the worker had stopped without reporting, the hook would still have moved the task
to `returned` and said so.

**Board:** the task moves to *returned*.

## 3. Review (find, filter, refute)

The orchestrator reads only the short summary:

```
crew task show t-20261029-qe0v        # state, returns 0/2, report, diff stat, packet path
crew review run t-20261029-qe0v       # prints the reviewer prompt
```

It dispatches `crew-reviewer` (read-only) with that prompt. The reviewer submits three raw findings:

| Id | Claim | Verified by |
|---|---|---|
| F-1 | `add` accepts `--due 2026-02-30` | `repro` |
| F-2 | `format` may be slow on huge lists | `inference` |
| F-3 | `add` derives the next id from the max id | `code-trace` |

```
crew review filter t-20261029-qe0v
Round 1: 3 raw, 1 kept, 2 dropped.
Dropped by reason: dismissed 1, inference 1
  F-1 [major] correctness src/todo.js:24  add accepts an impossible calendar date
```

F-2 is dropped because inference-only findings are off by default. F-3 matches the entry in
`.crew/dismissed.jsonl`, so it does not come back. The orchestrator dispatches `crew-refuter` on F-1 only; it
tries to disprove it and fails (`upheld`). Then:

```
crew review finalize t-20261029-qe0v     # task: returned -> reviewing
```

**Board:** the task shows *reviewing* and review stats: 3 raw, 2 filtered, 1 final, 1 upheld.

## 4. Send-back and second round

```
crew task send-back t-20261029-qe0v --note "Validate real calendar dates (F-1, src/todo.js:24)"
Task t-20261029-qe0v sent back (return 1 of 2). Dispatch the worker again with your note.
```

The orchestrator dispatches the worker again with the note. `PreToolUse(Agent)` records the second
launch (`redispatch`), the worker fixes it, commits, reports; `SubagentStop` fires again. The task is
`returned` for the second time. The orchestrator runs the tests named in the report itself, looks at the one
changed hunk, and decides it is clean.

If it had needed a third pass, `crew task send-back` would have refused (`max_returns_before_takeover: 2`),
recorded a lesson, and told the orchestrator to fix the rest itself. That is the only time it edits code.

Lesson for next time (the orchestrator adds it because the cause is repeatable):

```
crew lesson add --key old-format-files --kind send-back --text "Optional fields forgotten again."
```

## 5. Accept and merge (a gate)

```
crew task accept t-20261029-qe0v --note "dedupe and date validation verified"
```

`gates.merge` is `ask`, so the orchestrator stops and asks you:

> Merge `feat/due-dates` into `main` (4 files, +61/-6)? Reply yes to merge.

You answer **yes**. It runs `git merge --no-ff feat/due-dates`; `PostToolUse(Bash)` sees the command and
records a `git.merge` event. Then `crew task merge t-20261029-qe0v` records the final state and the
worktree is removed.

## 6. Wrap-up

```
> /crewgate:crew wrap-up
```

The orchestrator lists open tasks (none), things waiting for you (none) and:

```
crew lesson suggest
1 lesson(s) seen on at least 3 different days:
  old-format-files  3 day(s), 3 time(s)
```

> `old-format-files` came up on three different days. Proposed rule: "A change to the todo item shape must
> keep older files loading; add a test with an old-format file." Promote it?

You say yes, and it runs `crew lesson promote old-format-files --rule "..."`. The rule lands in the marked
block of `CLAUDE.md`, so every future session sees it. Without your yes nothing is promoted.

When you close the session, `SessionEnd` writes a digest (prompts, tools used, duration, tasks touched) and
adds a "waiting for you" item only if something looks unfinished (a task still in flight, or the last
message ended with a question). Here nothing is left.

## 7. What the board showed at the end

| Where | What you see |
|---|---|
| Overview | project `todo-cli`: 0 open tasks, 0 needs |
| Project, task history | created, dispatched, returned, reviewing, dispatched, returned, accepted, merged (returns 1) |
| Project, review stats | 3 raw, 2 filtered (1 dismissed, 1 inference), 1 final, 1 upheld |
| Project, events | `git.merge`, two `task.dispatched`, `task.sent_back`, `session.end` |
| Sessions | the live Claude Code sessions on this machine |

Everything above was recorded by hooks and by the commands the orchestrator needed anyway. No one wrote a
status update by hand.
