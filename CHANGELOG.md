# Changelog

## Unreleased

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
