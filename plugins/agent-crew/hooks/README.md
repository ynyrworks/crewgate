# Hooks

`hooks.json` registers one entry point, `scripts/crew-hook.js <event>`, in exec form (no shell).
The script reads stdin, runs `lib/hooks/<event>.js` in a worker thread and prints exactly one JSON
object (`{}` when there is nothing to say). A timer in the main thread answers `{}` if the handler
hangs (8 s; SessionEnd 1.2 s). Any internal error also gives `{}` and exit code 0.

Rules every hook follows
- Unregistered project: `{}`, nothing is written. Hooks never register a project.
- Reads only stdin, git metadata of the working directory and agent-crew files; writes only under
  `AGENT_CREW_HOME` (default `~/.agent-crew`). No network, no model calls.
- Stored text is redacted first, then truncated. Handoff bodies and file contents are never injected,
  only counts and ids. The SessionStart brief wraps file-derived data in `<crew-state untrusted="true">`.
- The only deliberate refusal is PreToolUse `permissionDecision: "deny"` (JSON, exit 0) when
  `limits.orchestrator_edit` is `block`. Stop never uses `decision: "block"`.
- Language of injected text comes from `language` in `.claude/crew.json` (`lib/i18n/hooks.*.json`).

| Event (arg) | Matcher | What it does |
|---|---|---|
| `session-start` | all | Records `session.start`, creates the session counter file, injects the brief (<= 4,000 bytes). |
| `user-prompt-submit` | all | Counts prompts, keeps a 200-char redacted first/last prompt. Adds no context. |
| `pre-tool-use` | `Agent\|Task` | Marker `crew-task: <id>` in the prompt: `created` -> `dispatched` (`task.dispatched`), remembers tool_use_id -> task, warns above `max_parallel_workers`. |
| `pre-tool-use` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Main session + main worktree + path inside the project and outside `orchestrator_edit_allow`: `warn` (context + user message + `orchestrator.warned`), `block` (deny), `off`. |
| `pre-tool-use` | `Read` | Main session, no `limit`, file longer than `orchestrator_read_warn_lines`: one reminder. Lines are counted with an early stop; binaries and files over 20 MB are skipped. |
| `post-tool-use` | `Agent\|Task` | Foreground worker finished: `dispatched` -> `returned` if it did not report through the CLI, and a review reminder. Background launch: nothing. |
| `post-tool-use` | `Bash` | `git push`, `git merge`, `gh pr create|merge`, `glab mr create|merge` -> `git.push` / `git.merge` with command name, remote and branch words only. |
| `subagent-start` | all | `subagent.start`; binds the agent id to the oldest unbound dispatch of the same type. |
| `subagent-stop` | all | `subagent.stop`; links the task (dispatch map, else marker in the first 64 KB of the transcript, else in the last message); a still-`dispatched` worker task becomes `returned`; review reminder. |
| `stop` | all | One reminder when tasks are `returned` but unreviewed or background tasks still run (same reminder is not repeated); nothing when `stop_hook_active`. |
| `pre-compact` | all | `session.compact` with a small counter checkpoint. |
| `session-end` | all | `session.end` digest from the counter file; flags `tasks_in_flight`, `ended_with_question`, `no_stop_seen` each add a need; removes the counter file. |

Files written
- `<home>/sessions/<session>.json` — running counters (pruned after 3 days).
- `<home>/projects/<id>/runtime/dispatch.json` — tool_use_id -> task / agent map (newest 100).
- Events and needs through the core (`events.append`, `store.needAdd`).

Notes
- Tool counts in the digest cover the tools that have a hook entry (Agent/Task, Edit family, Read, Bash).
- Hooks after SessionStart use the session file to find the project without spawning git; the Edit
  guard always asks git, because it has to tell the main checkout from a linked worktree.
- Env knobs: `AGENT_CREW_HOOK_GUARD_MS`, `AGENT_CREW_LOCK_WAIT_MS`. `AGENT_CREW_HOOK_TEST_SLEEP_MS` (simulates a stuck handler)
  is honoured only when `AGENT_CREW_TEST=1`.
