# crew command reference

Call as `node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" ...`. Global options: `--json`, `--project <id|path|name>`,
`--lang en|zh-TW`. Exit codes: 0 ok, 1 runtime error, 2 usage error.

## Setup
- `crew init [--lang en|zh-TW] [--force] [--reset-review-files] [--engine claude|codex]`: (`--engine codex`, or an existing `.codex/` folder, also writes `.codex/agents/crew-reviewer.toml`, `crew-refuter.toml` and a marked crewgate block in `AGENTS.md`) config (an empty `checks` is filled from the detected stack and printed; existing checks are never overwritten), three agent copies (project copies in `.claude/agents/` take precedence over the plugin agents, so both `crew-worker` and `crewgate:crew-worker` may appear), `.crew/` files, registers the
  project. Never overwrites without `--force` (then `*.bak-<timestamp>` copies; your config values are kept; `.crew/REVIEW.md` and `.crew/LESSONS.md` are never touched by `--force`, only `--reset-review-files` replaces them, with a backup).
- `crew update check [--force]` / `crew update apply`: the update notice (cached once a day, `updates.check` in the global config turns it off) and the one-click update with fixed commands; `apply` prints the commands instead when nothing can run.
- `crew doctor`: Node version, config validity (with field paths), empty `checks`, registration, hooks file, when each hook last fired in this project, duplicate-looking work items, board.
- `crew gate ask <gate> [--task ID] [--detail T]`: records `gate.asked`, prints a gate id (gate: push, open_pr, merge, remote_hosts, large_task, install_or_download). `auto` answers yes at once; `never` exits 1. `crew gate answer <gate-id> yes|no [--note T]` records the user reply (it warns when no user message happened since the ask: with `gates.require_user_turn` such an answer does not count).
- `crew project add|list|rm`

## Tasks
States: `created -> dispatched -> returned -> reviewing -> accepted -> merged`; any open state -> `cancelled`;
a send-back goes back to `dispatched`.
- `crew task create --title T --brief-file F [--role worker] [--branch B] [--worktree W] [--allow G] [--deny G]`
- `crew task list [--state S]`
- `crew task show <id>`: state, returns, capped report, diff stat, packet path, latest findings summary.
- `crew task report <id> --report-file F [--packet-file F]`: the worker's call; validates sections and the size cap.
- `crew task send-back <id> --note "..."`: refused at `max_returns_before_takeover` (records a takeover lesson).
- `crew task accept <id> [--note]`, `crew task merge <id> [--note]` (records only, runs no git merge; refused if `gates.merge` is
  `never`; also records `git.merge` with the real branch when git shows it merged into HEAD), `crew task cancel <id> [--note]`.
- `crew task run <id> [--engine codex] [--timeout 1800] [--model M]`: runs the Codex CLI as the worker in the task's worktree (created from HEAD when missing), then commits as the repository user (trailer `Co-Authored-By: Codex`), files report and packet and moves the task to `returned`. Failure (bad output, timeout, non-zero exit, no changes): nothing committed, `task.failed` event, a need, task stays `dispatched`. Log: `codex.log` in the task folder.

## Review
- `crew review run <task> [--engine claude|<name>] [--round N]`
- `crew review submit <task> [--round N] [--kind findings|refutations] [--file F]` (JSON on stdin without `--file`)
- `crew review filter <task> [--round N]`
- `crew review finalize <task> [--refutations-file F] [--round N]`
- `crew review show <task> [--round N]`
- `crew review dismiss <task> <finding-id> --scope once|always --reason "..."`

## Handoff and lessons
- `crew handoff create --title T --body-file F [--task <id>]`, `list [--all]`, `show <id>`, `accept <id>`, `cancel <id>`
- `crew lesson add --key slug --text "..." [--kind correction|send-back|dismissal|takeover]`, `list`, `suggest`,
  `promote <key> --rule "..."`, `retire <key>`

## Board data (manual items)
- `crew need add "text"` / `done N` / `list`: things waiting for the user
- `crew work set STREAM "title" todo|doing|done|waiting|parked ["note"] [--id ID | --new]`, `work rm STREAM "title" | --id ID`, `work list [--json]`: `set` updates the item with the same title in the stream (trimmed, spaces collapsed, case-insensitive) instead of adding another; `work list` shows item ids; `--new` forces a new item.
- `crew log add WHO "text"`, `crew mr set N "title" [--ci ..] [--merged yes|no]`, `crew validate set ...`

## Where things live
- Project (in git): `.claude/crew.json`, `.claude/agents/crew-*.md`, `.crew/REVIEW.md`, `.crew/LESSONS.md`,
  `.crew/dismissed.jsonl`, promoted rules in the marked block of the file named by `lessons.rules_file`.
- Runtime (not in git): `~/.crewgate/projects/<id>/tasks/<task>/{brief.md,task.json,report.md,packet.md,findings/}`
  and `handoffs/open|accepted|cancelled/`.
