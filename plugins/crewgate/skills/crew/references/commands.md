# crew command reference

Call as `node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" ...`. Global options: `--json`, `--project <id|path|name>`,
`--lang en|zh-TW`. Exit codes: 0 ok, 1 runtime error, 2 usage error.

## Setup
- `crew init [--lang en|zh-TW] [--force] [--reset-review-files] [--engine claude|codex]`: (`--engine codex`, or an existing `.codex/` folder, also writes `.codex/agents/crew-reviewer.toml`, `crew-refuter.toml` and a marked crewgate block in `AGENTS.md`) config (an empty `checks` is filled from the detected stack and printed; existing checks are never overwritten), three agent copies (project copies in `.claude/agents/` take precedence over the plugin agents, so both `crew-worker` and `crewgate:crew-worker` may appear), `.crew/` files, registers the
  project. Never overwrites without `--force` (then `*.bak-<timestamp>` copies; your config values are kept; `.crew/REVIEW.md` and `.crew/LESSONS.md` are never touched by `--force`, only `--reset-review-files` replaces them, with a backup).
- `crew update check [--force]` / `crew update apply`: the update notice (cached once a day, `updates.check` in the global config turns it off) and the one-click update with fixed commands; `apply` prints the commands instead when nothing can run.
- `crew doctor`: Node version, config validity (with field paths), empty `checks`, registration, hooks file, when each hook last fired in this project, duplicate-looking work items, board.
- `crew gate ask <gate> [--task ID] [--detail T]`: records `gate.asked`, prints a gate id (gate: push, open_pr, merge, remote_hosts, large_task, install_or_download, or any other key the project sets to `auto`, `ask` or `never` under `gates`). `auto` answers yes at once; `never` exits 1. `crew gate answer <gate-id> yes|no [--note T]` records the user reply (it warns when no user message happened since the ask: with `gates.require_user_turn` such an answer does not count).
- `crew project add|list|rm`

## Tasks
States: `created -> dispatched -> returned -> reviewing -> accepted -> merged`; any open state -> `cancelled`;
a send-back goes back to `dispatched`.
- `crew task create --title T --brief-file F [--role worker] [--branch B] [--worktree W] [--allow G] [--deny G] [--plan SLUG:NODE]` (`--plan` links the new task to that plan node; a bad plan or node is refused before the task is created)
- `crew task list [--state S]`
- `crew task show <id>`: state, returns, capped report, diff stat, packet path, latest findings summary.
- `crew task report <id> --report-file F [--packet-file F]`: the worker's call; validates sections and the size cap.
- `crew task send-back <id> --note "..."`: refused at `max_returns_before_takeover` (records a takeover lesson).
- `crew task accept <id> [--note] [--skip-refuter "reason"]` (refused while the latest review round has findings that were not finalized, unless a reason is given; the reason goes into the event), `crew task merge <id> [--note]` (records only, runs no git merge; refused if `gates.merge` is
  `never`; also records `git.merge` with the real branch when git shows it merged into HEAD), `crew task cancel <id> [--note]`.
- `crew task run <id> [--engine codex] [--timeout 1800] [--model M]`: runs the Codex CLI as the worker in the task's worktree (created from HEAD when missing), then commits as the repository user (trailer `Co-Authored-By: Codex`), files report and packet and moves the task to `returned`. Failure (bad output, timeout, non-zero exit, no changes): nothing committed, `task.failed` event, a need, task stays `dispatched`. Log: `codex.log` in the task folder.

## Plans
A plan is a tree of steps in `.crew/plans/<slug>.md` (slug `[a-z0-9-]{1,40}`, at most 3 levels, 500 nodes, 256 KiB). Leaves link to tasks; progress is computed from the linked tasks and shown on the board (Plans card, page `#/p/<project>/plan/<slug>`).
- `crew plan new <slug> --title T [--goal T]`, `crew plan list`, `crew plan show <slug>` (tree with state and percentage; `--json` on both reads).
- `crew plan add <slug> "text" [--under <node>] [--task <task-id>] [--origin plan|user|review|refute|implementation|send-back] [--proposed]`: records origin and date on the node; `--proposed` adds a `[?]` node that does not count until accepted. Refuses a fourth level.
- `crew lesson score [--date YYYY-MM-DD]`: for each promoted rule, the lessons under its key before and after it was promoted, per day: `too-early`, `no-repeats`, `fewer` or `not-helping`. It counts recorded lessons only.
- `crew plan clarify <slug> --question T --answer T [--by user|assumed]`: keeps a settled question as a plain line under `## Clarified`, last in the file; `plan show` lists these and a plan review treats them as settled.
- `crew plan link <slug> <node> <task-id>`, `crew plan set <slug> <node> open|done|dropped|accept` (`accept` turns `[?]` into open), `crew plan rm <slug> <node>` (a leaf only).
- `crew plan accept <slug> <node>`, `crew plan reject <slug> <node> [--note T]`: decide a proposed node. Accept of `add`/`split` opens the node; `change` rewords the target step and removes the proposal; `drop` drops the target and removes the proposal. Reject marks it dropped, keeps the note and stops later rounds from raising it again. `plan set ... accept` still works as an alias.
- `crew plan review run <slug> [--node N] [--force]` (starts a round, writes the packet, prints the `crew-reviewer` prompt; `--node` limits it to a subtree; `--force` goes past `plan.max_rounds`), `crew plan review submit <slug> [--round N] [--kind findings|refutations] [--file F]` (JSON on stdin without `--file`), `crew plan review filter <slug> [--round N]` (prints the `crew-refuter` prompt), `crew plan review finalize <slug> [--refutations-file F] [--round N]`, `crew plan review show <slug> [--round N]`. See `review-pipeline.md`, "Plan review".
- Config `plan.max_proposals_per_round` (5), `plan.max_rounds` (3 per plan), `plan.large_growth` (5 accepted proposals since the last `large_task` approval: the CLI prints the gate hint and records a need).
- `<node>` is an id such as `n2`; a hand-written line without an id is `L<line>` (ids are assigned on the first CLI write).
- File: `- [ ] text <!-- id:n1 task:<id> added:YYYY-MM-DD origin:plan -->`; box `[ ]` open, `[x]` done, `[~]` dropped (not counted), `[?]` proposed (not counted). A leaf is done when `[x]` or its task is `merged`/`accepted`; `returned`/`reviewing` show as in review, `dispatched` as in progress, `cancelled` as needs attention. Hand-written lines are valid; unknown comment keys are kept.
- Events: `plan.created`, `plan.node_added` (with origin), `plan.node_changed`, `plan.review_started`, `plan.review_finalized` (counts), `plan.proposal_accepted`, `plan.proposal_rejected` (ids only, never text).

## Review
- `crew review run <task> [--engine claude|<name>] [--round N]`
- `crew review submit <task> [--round N] [--kind findings|refutations] [--file F]` (JSON on stdin without `--file`)
- `crew review filter <task> [--round N]`
- `crew review finalize <task> [--refutations-file F] [--round N]`
- `crew review show <task> [--round N]`
- `crew review dismiss <task> <finding-id> --scope once|always --reason "..."`
- `crew review followup <task> <finding-id> --done-when "..." [--text "..."] [--plan SLUG] [--round N]`: proposes a finding of a finalized round as a `[?]` step next to the task's plan step (or at the top of `--plan SLUG`)

## Release record
- `crew release record <version> [--from REF] [--to REF] [--plan SLUG]... [--conclusion-file F] [--dir D] [--force]`: writes `<release.record_dir>/<version>.md` (default `.crew/releases`): the merged tasks of the range with review rounds, surviving findings, NOT RE-REVIEWED / NO REVIEW flags, linked plans, gates and the conclusion between `<!-- crew:conclusion -->` markers. `--to` defaults to tag `v<version>` else HEAD, `--from` to the nearest earlier tag; an unknown ref writes nothing. Running again keeps the conclusion unless `--conclusion-file` is given; a file without the markers needs `--force`. Reads only, never commits or tags.

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
