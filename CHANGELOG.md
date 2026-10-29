# Changelog

## Unreleased

- History view. The Sessions page lists only transcripts touched in the last 24 hours; the new **History** page (`#/history`) looks back up to 90 days with the same statistics (duration, prompts, tool calls, subagents, tokens, estimated cost; subagents are folded into their parent). Pick a range (1 / 7 / 30 / 90 days) and a project, see sessions grouped by day with day totals, and press Load more; every row opens the usual session page with its timeline (`#/s/<id>` now also works for sessions older than 24 hours, `GET /api/session/<id>` adds `history: true` for them). New `GET /api/history?days=N&before=<ms>&project=<id|->&limit=N&tz=<minutes>`: `days` 1-90 (default 7), a page is 50 sessions (`limit` up to 100), newest first, with `sessions`, `day_totals`, `next` (a modification-time cursor to pass as `before`, or null) and `truncated`. Work per request is bounded: at most 20,000 transcript files are listed (directory walk and one `stat` each, nothing read), the head and tail of at most 300 candidates are read, and statistics use the existing incremental cache with its byte budget, so rows whose transcript is not fully counted are `partial` and fill in on the next request. Text snippets follow `board.show_text`, the full path never leaves the server, and private mode hides the folder and branch as elsewhere.
- Git events and gates follow the repo a command targets. PostToolUse(Bash) used the project of the session cwd for `git.push` / `git.merge` events and the push / open_pr / merge gate check, so `cd <other repo> && git push` or `git -C <other repo> push` was recorded (and reminded) against the wrong project. The `cd` / `pushd` words before the command and `git -C` are now resolved from the session cwd (Git-Bash `/c/work/x` paths on Windows included) and the owning registered project is used for the events, `gate.missing` and the approval lookup; one command line can touch several projects. A directory outside every registered project records nothing (it is never registered), and a dynamic directory (`cd "$DIR"`, `$(...)`, `cd -`, `cd ~`) falls back to the session project as before.
- Search box on the timeline page: filters the loaded steps (tool name, target, prompt snippet, crewgate event type, task id) as you type, case-insensitive, all words must match, with a match count. In private mode only names and kinds are searched. It searches loaded steps only; load older steps to search further back.
- Tool durations across the page edge: a call opened on an older page now gets its duration, failure flag and subagent link from a forward look-ahead past the page edge (at most 512 KiB, stops when every open call is answered). The answer gains an additive field `ahead` (bytes read forward).
- crewgate events older than the board's recent event tail now show: the API reads the project's `events.jsonl` backwards for the time window of the page (at most 4 MiB), filtered by session.

## 0.12.1 — 2026-10-29

Fixes from the first real one-click update (0.11.0 to 0.12.0 on Windows), where the Claude Code plugin updated but Codex was silently skipped.

- Codex is found on Windows even when it is not on PATH. Resolution order: `engines.codex.command` of the global config (an explicit path), `codex` on PATH / PATHEXT, then on Windows `powershell.exe -NoProfile -NonInteractive -Command "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation"` (fixed command, 10 s limit, stdin closed) and `<InstallLocation>\app\resources\codex.exe`, and only last the `WindowsApps` listing, which a normal user cannot enumerate (now wrapped so a denied listing is harmless).
- Nothing is skipped silently any more. When the Codex plugin is installed (`[plugins."crewgate@crewgate"]` in `config.toml`) or the Claude plugin is installed but its CLI cannot be found, the result has a `manual` entry with the exact command (for example `codex plugin marketplace upgrade crewgate`) and the reason "Codex CLI not found on PATH"; the banner shows it with a Copy button, also after the board restarted. The final status per tool is `updated`, `skipped` (not installed), `manual` (CLI not found) or `failed` (`results` in `GET /api/update/status`, one line per tool in `crew update apply`).
- Old plugin versions. An update leaves the previous version folders in `~/.claude/plugins/cache/crewgate/crewgate/` (and the Codex twin), because open sessions may still use their hooks. The banner now says how many there are and how much space they use, and offers **Remove old versions** (`POST /api/update/cleanup`, token protected, no parameters; `GET` lists them). `crew update cleanup [--dry-run]` does the same in a terminal. Only folders named like a version and strictly older than the newest one are removed; the newest, the folder the running code lives in, links and anything outside the two cache folders are never touched, and a folder in use (EBUSY / EPERM on Windows) is reported and kept. Nothing is removed automatically.
- Hook commands are unchanged since 0.12.0 (`hooks.json` and the Codex hook file are byte for byte the same), so Codex does not need `/hooks` re-approval for this release.

## 0.12.0 — 2026-10-29

Highlights: the experimental office view, session statistics and the activity timeline, and fixes from an analysis of real use (gate commands and reminders, hooks-last-seen, merge records, `via`, agent name normalisation, work item updates, default checks detection, flaky test fixes).

Upgrade notes: hook command strings did not change since 0.11.0 (only `hooks/README.md` differs), so Codex does not need `/hooks` re-approval.

Fixes from an analysis of real use (7 tasks, 10 dispatches, 115 events).

- Gates are recorded. New `crew gate ask <gate> --task <id> [--detail T]` (prints a gate id; `auto` answers yes at once, `never` exits 1) and `crew gate answer <gate-id> yes|no [--note T]` write `gate.asked` / `gate.answered`. The PostToolUse(Bash) hook reminds the model (non-blocking) and records `gate.missing` when a `git push`, `gh pr create` / `glab mr create` or merge runs under an `ask` gate with no yes of the last 30 minutes. The skill and `references/lessons-and-gates.md` tell the orchestrator to ask through the CLI first. The project page shows the gate history (asked / answered / no approval).
- Hooks last seen. Hooks note the event they handled in `runtime/hook-seen.json` (one write per event per 60 s). `crew doctor` and the project page list when each hook last fired and warn when SessionStart / Stop / SessionEnd never did (a session that began before the plugin was installed only gets hooks after a restart).
- `git.merge` no longer records an unexpanded shell word such as `$b` as a branch (`branches: []`, `dynamic: true`), and a loop merging three branches now yields three events, counted from git's own output ("Merge made by", "Fast-forward", "Updating a..b"). `crew task merge` is the authoritative merge record: `task.merged` carries the branch and, when git shows it merged into HEAD, a `git.merge` with the real branch and commit is added (no duplicate when a hook event already names the branch).
- `subagent.stop` `last` was empty for task workers: the hook only read `last_assistant_message` as a string. It now accepts content blocks too and falls back to the last assistant text at the end of the subagent transcript; the snippet is redacted and cut to 200 characters, with `last_src` saying where it came from. The board shows it only with `board.show_text`. (The exact payload shape of the failing real runs could not be inspected; the fallback covers an empty or non-string field.)
- `via` on `task.dispatched` (`pre-tool-use`, `subagent-start`, `codex-run`, `cli-report`) and `task.returned` (`cli-report`, `subagent-stop`, `post-tool-use`, `codex-run`); the project page shows it, the merged branches and the agent type next to each event.
- Agent names: events store the bare `agent_type` (`crew-reviewer`) and keep the original in `agent_type_raw`; one shared helper (`lib/core/agents.js`) is used by the hooks and the board. `crew init` explains that project copies in `.claude/agents/` take precedence over the plugin agents.
- `crew work set STREAM "title" state` updates the item with the same title in the stream (trimmed, spaces collapsed, case-insensitive) instead of adding a duplicate. Items have ids (`work list --json`), `--id` targets one (and may rename it), `--new` forces a new item, `work rm` accepts `--id`. Nothing is migrated; `crew doctor` reports duplicate-looking items.
- `crew init` detects the stack and fills an empty `checks` (`npm test`, `go test ./...` + `go vet ./...`, `pytest`, `cargo test`, `dotnet test`, `make test`), prints its choice and never overwrites existing checks; `crew doctor` warns when `checks` is empty.

- Session statistics. Every session card in the Sessions list and in a project shows duration · prompts · tool calls · tokens · estimated cost; a parent shows the totals of itself plus its subagents. Per session (Claude and Codex): duration (first to last record), prompts, tool calls by name, subagents started, tool errors, tokens in / out / cache write / cache read per model, and cost from the global `prices` (model per message). The numbers need more than the 64 KB tail, so each transcript is parsed once and then only its new bytes: aggregates and the byte offset are cached per file in `<home>/cache/sessions/<hash>.json` (counters only, no text; rebuilt after truncation or rotation, a half-written last line waits). Work per request is bounded (8 MB parsed per call across files, newest first); a file still behind is marked `partial` and continues on the next refresh. Statistics are numbers, so `board.show_text` does not gate them.
- Activity timeline. A session card links to `#/s/<id>`: the stats table (own and with subagents), the subagents, and a vertical timeline of the latest 200 steps (prompts, tool calls, subagent start / stop linked to their own page, crewgate events of that session, errors) with times, the gap since the previous step and tool durations. Filter by kind; **Load older steps** pages backwards by byte offsets (never a full-file read). Prompt text, tool targets and subagent types appear only when `board.show_text` is on (same redaction as the live activity) and are removed in private mode. Keyboard accessible, works at 375 px and in both themes, English and Traditional Chinese. New endpoint `GET /api/session/<id>?before=&before_ts=&limit=&kinds=`; session rows gain `stats` and `totals`.
- Tests: the update CLI tests derive the "newer" release from the running version instead of hard-coding `v0.12.0`, so they no longer break when the manifest passes it.
- Office view (experimental): new board page `#/office` draws live sessions as a small pixel-art office on a canvas, at a fine 2x scale with 24x32 chibi characters (big eyes, blush, several hair styles and skin tones picked from the session id), a warm wood-floor room with windows and soft shadows, and idle breathing, blinking, head tilt while thinking and a happy hop when done. One room per project, the orchestrator at the middle desk of its pod with subagents around it, hat = role, shirt colour = engine (no logos). Thinking, tool use (with a file / terminal / search / agent icon), writing, waiting for you, idle and done each have their own animation; about 10 fps, paused in hidden tabs, static with `prefers-reduced-motion`. Hover or tap for a tooltip card, click to open the session (the session page when this build has one, else the sessions list filtered to the project). Seats are stable across refreshes. Honours Private mode and `board.show_text` like the sessions list; a focusable list under the canvas mirrors every character for keyboard and screen-reader use. All sprites are drawn by code (no third-party art, no new dependencies). `scripts/screenshots.js` gained `--only <page>`.

## 0.11.0 — 2026-10-29

- Update notice and one-click update. The board server asks GitHub once a day (global config `updates.check`, default on; off means no request at all) whether a newer release exists and shows a banner on every page: fix / new features / major, release notes, **Update now**, **Skip this version**. **Update now** runs fixed commands only (`claude plugin marketplace update crewgate`, `claude plugin update crewgate@crewgate`, `codex plugin marketplace upgrade crewgate`) for an installed plugin, then restarts the board from the updated code; a development checkout or a machine without the CLIs gets copyable commands. New `crew update check|apply`; `crew doctor` shows the cached latest release. New endpoints `GET /api/update`, `POST /api/update/check`, `POST /api/update/apply`, `GET /api/update/status`.
- The update check is the only outbound request crewgate makes (at most once a day, `updates.check`, on by default). If **Update now** cannot run the commands it falls back to copyable commands, and the board restarts itself from the updated code afterwards. A release whose notes contain `<!-- crewgate:rehook -->` tells the banner that hook commands changed and need re-trusting.
- Upgrading Codex needs only `codex plugin marketplace upgrade crewgate` (verified: it refreshes the installed plugin; no `codex plugin add` needed). README text corrected in both languages.

## 0.10.1 — 2026-10-29

- Board: a finished one-shot run is `done`, not `waiting for you`: `codex exec` rollouts (`session_meta.payload.originator` `codex_exec` / `source` `exec`) and headless Claude runs (`entrypoint` `sdk-*`, e.g. `claude -p`). Interactive sessions whose turn ended still wait. `session.end` events from Codex hooks now end Codex sessions too (the rollout's `session_meta.payload.id` is the hook's `session_id`).
- Screenshots in both READMEs, taken from a fictional demo: `scripts/demo-board.js` serves it, `scripts/screenshots.js` captures it.

Known limitations:

- Headless `claude -p` runs launched from the Claude desktop app report entrypoint `claude-desktop`, so they are only recognised as finished after the idle threshold.

## 0.10.0 — 2026-10-29

Codex support (experimental).

- `crew task run <id> --engine codex [--timeout S] [--model M]`: runs the Codex CLI (global engine `codex`) as a worker in the task's worktree with stdin closed, `--sandbox workspace-write`, `--output-schema` and `-o`. crewgate then commits as the repository user with a `Co-Authored-By: Codex` trailer, files report and packet and returns the task. Bad output, timeout, a non-zero exit or no changes commit nothing, record `task.failed` and a need and keep the task dispatched.
- Codex as orchestrator: `.codex-plugin/plugin.json`, `hooks/codex-hooks.json` (one-string commands, `commandWindows`); hooks understand `collaborationspawn_agent`; `crew init --engine codex` writes `.codex/agents/crew-reviewer.toml`, `crew-refuter.toml` and a marked block in `AGENTS.md`; the skill has a "Running in Codex" section.
- Codex hides the spawn message from hooks, so the dispatch is recorded at SubagentStart from the subagent's rollout file.
- Repo files (config, agents, `.crew/*`, the rules block, `AGENTS.md`) are read and written in the linked work tree you are in; runtime data stays per project id. Review dismiss and lessons follow the work tree.
- Docs: Codex section in both READMEs, DESIGN section 16, measured Codex facts in PLUGIN-FACTS.

Sessions view: who is doing what right now.

- Each session shows its current activity (thinking, running a tool with a short redacted target, writing, waiting for you, idle, done), derived from the tail of the transcript. The tool name is always shown; the target (relative file path, first command words, subagent type, pattern; at most 60 characters) only when `board.show_text` is on.
- Role (orchestrator, worker, reviewer, refuter, other) and crewgate task (id and title) from the project's `events.jsonl`; the API rows gain `activity`, `role`, `task`, `parent`, `branch`, `detached` and `worktree`.
- Subagents are nested under their parent session (collapsible, with a running count). Waiting-for-you sessions sort first and are highlighted; status chips carry a symbol as well as a colour.
- Last prompt, last reply and session title as redacted snippets of at most 160 characters, only with `board.show_text`. The API field `text` is now `last_reply`.
- Git branch and linked-worktree name read from `.git/HEAD` (cached by mtime, no git process).
- Filters by project, state and engine, remembered in the browser. The top-bar switch is now "Private mode": it hides snippets, tool targets, folders, branches, task titles and project names in this browser; it can only hide more than the server sends.
- Codex rollouts show status, last tool, model and (when present) prompt and reply.
- `docs/ROADMAP.md`.

## 0.9.0 — 2026-10-29

First public release. The project was developed as agent-crew and is renamed to crewgate.

Renamed from agent-crew to crewgate (repository `ynyrworks/crewgate`). The skill is now `/crewgate:crew`, plugin agents are `crewgate:crew-worker` etc., the data folder is `~/.crewgate` and the environment variables are `CREWGATE_*`. The CLI command `crew`, `.claude/crew.json`, `.crew/` and the `crew-task:` marker are unchanged.
Compatibility: if `~/.crewgate` is missing but `~/.agent-crew` exists, the old folder is used (the CLI prints a one-time notice); `AGENT_CREW_HOME` is still honoured as a fallback; old `agent-crew:rules` markers are read and rewritten to `crewgate:rules` on the next promote or retire.

Security and correctness fixes from the first review round.

- The dismissed ledger stores a hash of the snippet, never its text; findings files are redacted before they are written.
- Engine definitions are read only from the global config; a project `engines` block is ignored with a warning. `lessons.rules_file` must be inside the project.
- Engines resolve through PATH/PATHEXT without a shell (`.cmd`/`.bat` via cmd.exe with quoted arguments); `crew doctor` reports each engine.
- Stop and SubagentStop show a user notice (`systemMessage`) instead of `additionalContext`, which would keep the turn running.
- Redaction covers suffixed keys, `Authorization: token`, npm, Stripe and Google keys.
- `crew init --force` no longer resets REVIEW.md and LESSONS.md (`--reset-review-files` does, with a backup).
- Smaller fixes: `..name` files inside the project, SessionEnd digest after resume, reserved store keys, Windows browser open, per-event hook guards, lesson rule validation, hygiene test without embedded names.

Portability fixes found by the first CI run (Linux, macOS, Windows on Node 18, 20 and 22).

- Paths are canonicalised (`paths.canonical`: symlinks, junctions and Windows 8.3 short names such as `RUNNER~1`, with a not-yet-existing tail kept) before project roots, project ids, registry lookups and the orchestrator edit guard compare them. Before, a short-name or junction path made the edit guard silently not apply. Project ids of already registered projects do not change.
- Test helpers use canonical temp paths; the subagent/parent watcher test no longer sits on the 3-minute closing boundary, which made it timing-dependent.

- Orchestrator skill `/crewgate:crew` (init, status, wrap-up, handoff) and generic `crew-worker`,
  `crew-reviewer` and `crew-refuter` agents; `crew init` renders project copies of the agents, the config and the
  `.crew/` files.
- Task state machine with five-section briefs (the CLI refuses incomplete ones), capped worker reports,
  send-back limit with orchestrator takeover, and cross-session handoffs.
- Review pipeline: find, deterministic filter (dismissed ledger, inference, confidence, nit cap, downgrades),
  refute, finalize. Codex CLI (or any command that reads a prompt on stdin) can act as the reviewer engine.
- Lessons that become promotion candidates after several days and are written into a marked rules block only on
  an explicit yes.
- Hooks (single `crew-hook.js` entry): dispatch tracking through the `crew-task:` marker, subagent start/stop,
  orchestrator edit guard (`off|warn|block`), big-read reminder, `git push` / `git merge` / PR events, stop
  reminders, session digest with "waiting for you" flags. Silent no-op in unregistered projects.
- Local board (`crew board start|stop|status|serve`): 127.0.0.1 only, Host allow-list, token-protected writes,
  strict CSP; Overview, Project, Sessions, Usage and Settings pages in English and Traditional Chinese. Settings
  forms are generated from the config schema; saves record `config.changed` with source `board`.
- Shared core: atomic JSON store with locking, project detection (a linked worktree maps to its main checkout),
  validated configuration, event log, redaction, i18n.
- Global config keys `board.show_text` and `prices.*.cache_write` / `prices.*.cache_read`; `docs/CONFIG.md` is
  generated from the schema (`node scripts/gen-config-docs.js`).
- Fictional example project `examples/todo-cli` with a full walkthrough, English and Traditional Chinese READMEs.
- Tests: unit, hook, board, scripted end-to-end flow and a repository hygiene scan (names, IP addresses, keys).
- Fixed: board review statistics counted intermediate `kept` and `refutations` files as final findings.
