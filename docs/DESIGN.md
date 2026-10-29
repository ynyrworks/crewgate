# crewgate — design

crewgate is a Claude Code plugin for **delegated development**: one orchestrator
session plans, dispatches, reviews and merges; worker subagents implement in git
worktrees; reviewer subagents review read-only. Progress is recorded **by hooks and
workflow commands, not by the model remembering to log**, and shown on a local
board (127.0.0.1 only, no network, zero runtime dependencies).

This document is the source of truth for the first release. Every contributor
(human or agent) reads it before changing code.

## 1. Goals and non-goals

Goals
- A reusable, public template: nothing project- or company-specific ships in the repo.
  Everything a project needs to change lives in its own config and markdown files.
- Fix the recurring failures of free-text delegation rules:
  1. the orchestrator writes code itself and skips review;
  2. the board goes stale, duplicated or incomplete;
  3. briefs lack boundaries and cause regressions outside scope;
  4. reviewers over-report low-value findings;
  5. background work finishes without anyone noticing;
  6. the orchestrator spends its (expensive) context reading big files;
  7. rules live as prose that gets forgotten.
- Engine-agnostic roles. Default: Claude for every role. Codex CLI is an optional
  reviewer engine.

Non-goals (first release)
- No LLM calls from hooks or the board. No network access, with one exception: the board's update check
  (section 10), which is on by default and can be turned off.
- No animated "office" view. A plain live-session list is enough.
- Codex/Gemini as orchestrator (no Codex plugin rendering yet).

## 2. Clean-room rule

This project must not contain code derived from third-party projects other than
declared dependencies. Contributors porting code from the author's earlier private
tool may read **only** the files listed in the porting brief they were given. Do not
open, copy or paraphrase any other file from that tool. Do not reuse third-party
names, artwork or vendor logos.

## 3. Repository layout

```
.claude-plugin/marketplace.json        marketplace with one plugin
plugins/crewgate/
  .claude-plugin/plugin.json
  skills/crew/SKILL.md                 the /crew skill (orchestrator playbook)
  skills/crew/references/*.md          longer reference loaded on demand
  agents/crew-worker.md                generic worker (implements, commits, never pushes)
  agents/crew-reviewer.md              generic reviewer (read-only, structured findings)
  agents/crew-refuter.md               generic refuter (tries to disprove findings)
  hooks/hooks.json
  scripts/crew-hook.js                 single hook entry point: node crew-hook.js <event>
  bin/crew.js                          CLI entry point
  lib/core/                            shared core (owned by the core step)
  lib/commands/<name>.js               one file per CLI command group
  lib/hooks/<event>.js                 one file per hook event
  board/                               local board server + static UI
  templates/                           files `crew init` renders into a project
  test/                                node:test suites (*.test.js)
examples/todo-cli/                     fully fictional demo project
docs/DESIGN.md, docs/*.md
README.md (English), README.zh-TW.md
LICENSE (MIT), CHANGELOG.md, package.json (root; dev scripts only)
```

Node >= 18. Runtime dependencies: none. Dev dependencies: none unless a step's brief
allows one. Tests use `node --test`. Hooks and CLI must run unchanged on Windows,
macOS and Linux (no bash/PowerShell assumptions; use `path`, `os.homedir()`).

## 4. Data locations

| What | Where | In git? |
|---|---|---|
| Project config | `<repo>/.claude/crew.json` | yes |
| Project agent copies | `<repo>/.claude/agents/crew-*.md` (rendered by `crew init`, editable) | yes |
| Review rules | `<repo>/.crew/REVIEW.md` | yes |
| Lessons | `<repo>/.crew/LESSONS.md` | yes |
| Dismissed findings | `<repo>/.crew/dismissed.jsonl` | yes |
| Promoted rules | marked block in `<repo>/CLAUDE.md` | yes |
| Runtime data | `~/.crewgate/` (override: `CREWGATE_HOME`; the pre-rename `~/.agent-crew/` and `AGENT_CREW_HOME` still work as a fallback) | no |

Runtime data layout:

```
~/.crewgate/
  config.json                          global: port, usage prices, language default
  projects.json                        registry: id -> { path, name, added }
  projects/<id>/
    events.jsonl                       append-only event log (hooks + CLI)
    work.json needs.json log.json mrs.json validation.json   board store
    tasks/<task-id>/brief.md           written by orchestrator via CLI
    tasks/<task-id>/task.json          state machine (see §7)
    tasks/<task-id>/report.md          worker's short report (capped)
    tasks/<task-id>/packet.md          worker's full packet (diff, notes)
    tasks/<task-id>/findings/*.json    review rounds
    handoffs/open|accepted|cancelled/<id>.json
```

**Project identity.** The project root is the *main* worktree:
`dirname(git rev-parse --path-format=absolute --git-common-dir)`. A linked worktree
therefore maps to the same project as its main checkout. Project id = `p` + first 10
hex chars of sha256(normalised absolute root path; lower-cased on Windows). Outside a
git repo, the nearest ancestor containing `.claude/crew.json` is the root. Projects are
registered by `crew init` or `crew project add`; hooks never auto-register — in an
unregistered project every hook is a silent no-op.

**Project root vs work tree root.** Two different roots exist. The *project root* (main
checkout) carries identity: the id, the registry entry and the runtime data under
`~/.crewgate/projects/<id>/`. The *work tree root* is `git rev-parse --show-toplevel` of the
current directory (canonicalised); it equals the project root everywhere except inside a
linked worktree. Everything tracked in the repo — `.claude/crew.json`, `.claude/agents/*`,
`.crew/REVIEW.md`, `.crew/LESSONS.md`, `.crew/dismissed.jsonl`, the rules file and the
CLAUDE.md block — is read and written at the **work tree root**, so `crew init` or
`crew lesson …` inside a linked worktree changes that worktree's branch, not the main
checkout. The project config is loaded from the work tree's `.claude/crew.json` when it has
one, else from the project root's. `crew doctor` prints both roots when they differ.

## 5. Configuration (`.claude/crew.json`)

All fields are optional; defaults below. The board's Settings page edits this file
(validated against the schema in `lib/core/config.js`); hand edits are equally valid.

```json
{
  "version": 1,
  "language": "en",
  "roles": {
    "orchestrator": { "engine": "claude", "model": "inherit" },
    "worker":   { "engine": "claude", "model": "sonnet", "agent": "crew-worker" },
    "reviewer": { "engine": "claude", "model": "sonnet", "agent": "crew-reviewer" },
    "refuter":  { "engine": "claude", "model": "sonnet", "agent": "crew-refuter" }
  },
  "gates": {
    "push": "ask", "open_pr": "ask", "merge": "ask",
    "remote_hosts": "ask", "large_task": "ask", "install_or_download": "ask"
  },
  "limits": {
    "max_parallel_workers": 3,
    "max_returns_before_takeover": 2,
    "report_max_tokens": 1500,
    "orchestrator_read_warn_lines": 300,
    "orchestrator_edit": "warn",
    "orchestrator_edit_allow": ["**/*.md", "docs/**", ".claude/**", ".crew/**"]
  },
  "review": {
    "min_confidence": 0.6,
    "report_inference": false,
    "nit_cap": 5,
    "categories": ["correctness", "security-exploitable", "data-loss", "regression",
                   "spec-mismatch", "test-gap", "maintainability", "nit"],
    "downgrade_to_nit": ["theoretical-race", "style"]
  },
  "checks": [],
  "forbidden": { "paths": [], "actions": [] },
  "board": { "enabled": true, "port": 8781 },
  "lessons": { "promote_after_days": 3, "rules_cap": 15, "rules_file": "CLAUDE.md" }
}
```

- `roles` is an open map: projects may add roles (e.g. `docs-writer`). `engine` is
  `claude` or the name of an engine defined in the **global** config (`engines` is read from
  `~/.crewgate/config.json` only; a project-level `engines` block is ignored with a warning). `model` is `inherit`, `opus`, `sonnet`, `haiku` or a
  full model id.
- `gates` values: `auto` (just do it), `ask` (ask the user in chat first), `never`. Gates are recorded, not only
  advised: `crew gate ask <gate> --task <id> [--detail "..."]` writes `gate.asked` and prints a gate id (`auto`: answered
  yes at once with `auto: true`; `never`: answered no, exit 1); after asking the user in chat the orchestrator runs
  `crew gate answer <gate-id> yes|no [--note]` (`gate.answered`). A PostToolUse(Bash) hook checks the same gates (§8).
- `orchestrator_edit`: `off` | `warn` | `block` (see §8).
- `checks`: commands a worker must run before reporting (e.g. `["npm test"]`). `crew init` fills an **empty** list from
  the project files (§13); a non-empty list is never touched.
- `forbidden`: plain strings rendered into the worker agent file.
- Unknown keys are preserved on write. Invalid files: CLI and board report the exact
  path and field; hooks fall back to defaults and never fail.

## 6. Events

`events.jsonl`: one JSON object per line, appended with a single `fs.appendFileSync`
of a line < 4 KiB (atomic for append on all supported platforms in practice; readers
must skip a malformed trailing line).

```json
{ "v": 1, "ts": "2026-01-01T00:00:00.000Z", "id": "<sha256-16>", "type": "task.dispatched",
  "src": "hook|cli|board", "session": "<session_id or null>", "task": "<task-id or null>",
  "agent": "<agent id or null>", "data": { } }
```

- `id` = sha256 over `type|session|tool_use_id or agent id|task|stable data key`,
  truncated to 16 hex. Writers skip an event whose `id` is already among the last 500
  lines (dedup for hooks that fire twice).
- All free text is **redacted first, then truncated** (§10), max 2,000 chars per field.
- Event types (first release): `session.start`, `session.end` (with digest),
  `session.compact`, `task.created`, `task.dispatched`, `task.returned`,
  `task.reviewed`, `task.sent_back`, `task.accepted`, `task.merged`, `task.cancelled`,
  `review.finding_dismissed`, `gate.asked`, `gate.answered`, `handoff.created`,
  `handoff.accepted`, `handoff.cancelled`, `lesson.added`, `lesson.promoted`,
  `need.added`, `need.done`, `orchestrator.warned`, `subagent.start`, `subagent.stop`,
  `git.push`, `git.merge`, `gate.missing`, `config.changed`.
- `gate.asked` `{ id, gate, mode, detail }`, `gate.answered` `{ id, gate, answer: yes|no, auto, note }`; `gate.missing`
  `{ gate, mode, command }` is written by the hook when a push/PR/merge happened under an `ask` gate with no yes of the
  last 30 minutes (same session, or an answer recorded by the CLI, which cannot tell the session).
- `via` says which path wrote a task transition: `task.dispatched` `pre-tool-use` | `subagent-start` | `codex-run` |
  `cli-report` (implicit dispatch by a report); `task.returned` `cli-report` | `subagent-stop` | `post-tool-use` |
  `codex-run`; `task.merged` `cli-merge`.
- `agent_type` in `subagent.start/stop` and `task.dispatched` is the bare agent name (`crew-reviewer`), the original
  spelling (`crewgate:crew-reviewer`) stays in `agent_type_raw`. A project copy in `.claude/agents/` takes precedence
  over the plugin copy, so both spellings occur; `lib/core/agents.js` is the one place that normalises them.
- `subagent.stop` `last` is a redacted snippet (up to 200 chars) of the subagent final message: the payload
  `last_assistant_message` (string or content blocks), else the last assistant text at the end of `agent_transcript_path`;
  `last_src` is `payload` | `transcript` | `none`. The board shows it only when `board.show_text` is on.
- `git.merge` `branches` never holds an unexpanded shell word (`$b`, backticks, `%VAR%`): such a command records
  `branches: []` + `dynamic: true`. The hook counts merges from the command output ("Merge made by", "Fast-forward",
  "Squash commit", "Updating a..b"): a loop with unknown branches yields one event per merge (`seq`/`of`), otherwise
  one event with `merged`, `outcome`, `range`. `crew task merge` is the authoritative record: `task.merged` carries the
  branch, and when git shows the branch is part of HEAD it adds `git.merge` with the real branch and tip `commit` unless a
  hook event already names that branch.

The board derives agent and task state from events plus task.json; the store files
(work/needs/log/mrs/validation) hold manually curated items and are also writable
through the CLI and the board.

## 7. Tasks

A task is the unit of delegation. State machine:

```
created -> dispatched -> returned -> (reviewing) -> accepted -> merged
                 ^            |
                 +-- sent_back+          any -> cancelled
```

`task.json`: `{ id, title, role, branch, worktree, scope: { allow: [globs], deny:
[globs] }, acceptance: [..], repro: "..", state, returns: n, created, updated, history:
[{state, ts, note}] }`. Task id: `t-YYYYMMDD-<4 base36>`.

Brief (`brief.md`) required sections — `crew task create` refuses a brief missing any:
1. Goal
2. Scope — files/areas allowed, files/areas forbidden
3. Must not regress — existing behaviour that must keep working, and who fixes
   out-of-scope fallout
4. Acceptance — how done is checked (tests, commands, observable behaviour)
5. Context — pointers (paths, line ranges), never pasted file dumps

The brief embeds a marker line `crew-task: <task-id>` so hooks can link a subagent to
its task.

Worker report (`report.md`, ≤ `report_max_tokens`, estimated as chars/4) fixed sections:
Branch & commits · What changed and why (per file, one line each) · Tests run (command
+ key output lines) · Assumptions & unfinished · Needs real-environment check. Full
diff and detail go to `packet.md`. `crew task report` validates both and records
`task.returned`.

When `returns` reaches `max_returns_before_takeover`, `crew task send-back` refuses and
tells the orchestrator to take the task over itself (and records a lesson candidate).

## 8. Hooks

Single entry `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-hook.js" <event>`. Contract:
read all stdin, never throw, never exit non-zero except a deliberate PreToolUse block
(exit 2) when `orchestrator_edit` is `block`; print `{}` or a valid hook JSON object;
finish in < 200 ms typical; unregistered project → `{}`.

| Event | Behaviour |
|---|---|
| SessionStart | Inject a fenced brief ≤ 4,000 bytes: role contract one-liner, open tasks by state, count + ids of open handoffs (never their bodies), count of needs waiting for the user, path to promoted rules. Content from files is fenced and marked untrusted. Record `session.start`. |
| PreToolUse (Agent/Task tool, main session) | If prompt contains `crew-task: <id>`, record `task.dispatched` (with tool_use_id, subagent type, model, background flag). Warn when the number of in-flight tasks would exceed `max_parallel_workers`. |
| PostToolUse (Agent/Task tool) | Foreground: record `task.returned` if the worker did not already report. Background launch: nothing (wait for SubagentStop). |
| SubagentStart / SubagentStop | Record `subagent.start/stop`; on stop of a task-linked worker, show the user a `systemMessage` (not `additionalContext`, which would keep the subagent running): "task <id> returned — review it: `crew task show <id>`". |
| PreToolUse (Edit/Write/MultiEdit/NotebookEdit, main session, main worktree) | If the target is not matched by `orchestrator_edit_allow`: `warn` → non-blocking reminder to delegate + `orchestrator.warned`; `block` → deny with reason. Never applies inside subagents or linked worktrees. |
| PreToolUse (Read, main session) | If the file has more lines than `orchestrator_read_warn_lines` and no `limit` was given, add a reminder to read the report/diff stat first and use line ranges. Never blocks. |
| PostToolUse (Bash) | Detect `git push`, `git merge`, `gh pr create`, `glab mr create` in the command; record `git.push` / `git.merge` (merge parsing: §6). Then the gate check: push → `push`, `gh pr create` / `glab mr create` → `open_pr`, merge → `merge`; if that gate is `ask` and no `gate.answered yes` of the last 30 minutes exists, record `gate.missing` and add a non-blocking reminder (`additionalContext`) to run `crew gate ask` / `answer` first. |
| every event | Whenever a hook resolves a registered project it notes the event in `runtime/hook-seen.json` (`{ events: { SessionStart: iso, ... } }`, at most one write per event type per 60 s). `crew doctor` and the board show it; SessionStart/Stop/SessionEnd never seen means the session began before the plugin was installed (or the wiring is broken). |
| Stop | If tasks are `returned` but not reviewed, or dispatched background tasks are still running, add a one-line reminder. Respect `stop_hook_active` (never loop). |
| PreCompact | Record `session.compact` with a digest checkpoint. |
| SessionEnd | Deterministic digest (no LLM): prompt count, tool counts, duration, end reason, first/last prompt (truncated), last tool, tasks touched. Abnormal-end flags: dispatched-but-not-returned tasks; last assistant turn ended with a question; no Stop seen. Each flag adds a need ("waiting for you"). |

Main session vs subagent and main worktree vs linked worktree are detected from the
hook payload and `git rev-parse`; see `lib/core/context.js`.

## 9. Review pipeline

Three stages; the orchestrator only sees survivors.

1. **Find** — reviewer (Claude subagent `crew-reviewer`, or `crew review run --engine
   codex`) writes `findings/<round>.raw.json`:
   `[{ id, category, severity, file, line, symbol, snippet, claim, evidence: [file:line..],
   verified_by: "repro|test|code-trace|inference", confidence: 0..1, suggestion }]`.
   `category` must come from `review.categories`.
2. **Filter** (deterministic, `crew review filter <task>`): drop findings matching the
   dismissed ledger; drop `verified_by: inference` unless `report_inference`; drop
   `confidence < min_confidence`; downgrade `downgrade_to_nit` patterns; cap nits at
   `nit_cap`. Everything dropped goes to `findings/<round>.filtered.json` with the reason.
3. **Refute** — `crew-refuter` subagent tries to disprove each remaining finding using
   only the diff, the brief and REVIEW.md; it marks each `upheld|refuted|uncertain` with
   evidence. `crew review finalize` writes `findings/<round>.json` (upheld + uncertain).

`crew review dismiss <task> <finding-id> --scope once|always --reason ".."` appends to
`.crew/dismissed.jsonl`: `{ fingerprint, category, file, symbol, reason, scope,
decided_by, date }`. Fingerprint = sha256(category | file | symbol | whitespace-normalised
snippet). `once` stops matching when the snippet no longer exists in the file;
`always` also creates a lesson candidate pointing at REVIEW.md.

## 10. Safety

- Board binds 127.0.0.1 only. Rejects requests whose Host is not `127.0.0.1:<port>`,
  `localhost:<port>` or `[::1]:<port>`. No CORS headers. State-changing requests require
  POST, `Content-Type: application/json`, no foreign `Origin`, and a per-process token
  embedded in the served page. Strict CSP, no inline script.
- Update check (`lib/core/update-check.js`, config `updates.check`, default on): the only outbound request crewgate
  makes. The board SERVER (never the browser; the CSP stays `connect-src 'self'`) sends one GET to
  `https://api.github.com/repos/ynyrworks/crewgate/releases/latest` with `User-Agent: crewgate/<version>` and
  `Accept: application/vnd.github+json`: no cookies, no credentials, no project or user data, 5 s timeout, at
  most once per 24 h, answer or failure cached in `~/.crewgate/update-check.json` (failures back off 1 h, 2 h ... up
  to 24 h). Drafts and pre-releases are ignored. `HTTPS_PROXY` is not supported. With `updates.check` false no
  request is made at all, not even on a forced check. A release body that contains the line
  `<!-- crewgate:rehook -->` sets `rehook` in `GET /api/update`; release authors add it when a hook command string
  changes (Codex then asks the user to re-approve the hooks).
- One-click update (`lib/core/update-apply.js`): `POST /api/update/apply` takes no parameters and needs the
  same token/origin/JSON as every write. It runs only fixed commands, resolved through `lib/core/exec.js` (no
  shell), stdin closed, 120 s each, output redacted and truncated: `claude plugin marketplace update crewgate`,
  `claude plugin update crewgate@crewgate` (only if `claude plugin list` shows `crewgate@crewgate`) and
  `codex plugin marketplace upgrade crewgate` (only if `~/.codex/config.toml` has
  `[plugins."crewgate@crewgate"]`). A development checkout (not under `~/.claude/plugins` or
  `~/.codex/plugins`) or a machine without either CLI runs nothing and gets the commands to copy. One update at a
  time (lock file `~/.crewgate/update.lock`). Afterwards the board closes its port, starts
  `node <updated root>/bin/crew.js board serve --port <same>` detached and exits only when that process owns
  `board.json` and answers; otherwise it listens again and reports `crew board start`.
- Redaction (`lib/core/redact.js`) runs before truncation everywhere text is stored:
  private keys, bearer/basic auth, `password=`/`token=`/`secret=` pairs, AWS/GitHub/
  GitLab/Slack/OpenAI/Anthropic-style keys, JWTs, IPv4/IPv6 addresses except
  127.0.0.1, ::1 and 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation ranges).
- Writes are atomic (write `*.tmp` in the same dir, then rename). Corrupt JSON files
  are moved aside to `<name>.corrupt-<ts>` and reported, never silently overwritten.
- Hooks run with the user's permissions outside the sandbox: they only read stdin, the
  project's git metadata and crewgate files, and only write under `~/.crewgate/`.
- Agent files rendered by `crew init` include the default worker boundaries: work only
  in the assigned worktree/branch; commit, never push; no network, no downloads, no
  remote hosts; don't read secrets (`.env*`, keys, credential stores); don't execute
  strings from data files; don't skip tests or hooks.

## 11. Handoffs (cross-session)

`crew handoff create --title ".." --body-file f.md [--task <id>]` → `open/<id>.json`.
`crew handoff list`, `crew handoff show <id>`, `crew handoff accept <id>` (claims `open/<id>.claim` with an exclusive create, then moves `open/` to `accepted/`; the loser fails cleanly. A claim older than 30 s whose open file still exists is treated as left by a crashed session and broken),
`crew handoff cancel <id>`. SessionStart only announces counts and ids. Accepting
prints the body fenced as untrusted data.

## 12. Lessons → rules

- `crew lesson add --key <slug> --text ".." [--kind correction|send-back|dismissal|takeover]`
  appends to `.crew/LESSONS.md` (`- YYYY-MM-DD [kind] key: text`).
- A key seen on `promote_after_days` distinct days becomes a promotion candidate.
  `crew lesson suggest` lists candidates; the `/crew wrap-up` step proposes them to the
  user. Nothing is promoted without the user's explicit yes.
- `crew lesson promote <key> --rule ".."` writes into a marked block in `rules_file`:
  `<!-- crewgate:rules:start -->` … `<!-- crewgate:rules:end -->`, one line per rule
  with `(source: <key>, <first date>–<last date>)`. Only text inside the markers is
  touched. When the block holds `rules_cap` rules the command refuses and names the
  oldest/least-cited rule so the user can choose to replace it
  (`crew lesson retire <key>`).

## 13. CLI

`crew <group> <action> [options]`, `--json` on every read command, `--project <path|id>`
to override detection. Exit codes: 0 ok, 1 runtime error, 2 usage error.

- `crew init [--lang en|zh-TW] [--force] [--reset-review-files] [--engine claude|codex]` — write `.claude/crew.json`, render
  `.claude/agents/crew-*.md`, create `.crew/REVIEW.md`, `.crew/LESSONS.md`, register
  project. Never overwrites without `--force` (then backs up). Detects the stack and fills an empty `checks`
  (`package.json` `scripts.test` → `npm test`; `go.mod` → `go test ./...` + `go vet ./...`; pytest in `pyproject.toml`,
  `pytest.ini` or `conftest.py` → `pytest`; `Cargo.toml` → `cargo test`; `*.csproj`/`*.sln` → `dotnet test`; a `test:`
  Makefile target → `make test`), prints what it chose and never overwrites existing checks. It also explains that
  agent copies in `.claude/agents/` take precedence over the plugin copies.
- `crew project add|list|rm`
- `crew task create|list|show|report|send-back|accept|merge|cancel|run`
- `crew review run|filter|finalize|dismiss|show`
- `crew handoff create|list|show|accept|cancel`
- `crew lesson add|list|suggest|promote|retire`
- `crew gate ask <gate> [--task ID] [--detail T]` / `crew gate answer <gate-id> yes|no [--note T]` — §5, §6, §8.
- `crew need add|done|list`, `crew work set|rm|list` (`work set STREAM "title" state` updates the item with the same
  normalised title in that stream — trimmed, spaces collapsed, case-insensitive; `--id ID` targets an item by the id
  `work list` shows, `--new` forces a new item), `crew log add|list`,
  `crew mr set|list`, `crew validate set|list`
- `crew board start|stop|status|serve [--port] [--no-open]`
- `crew import agent-board <data dir> --from-project <id> [--force]`
- `crew update check [--force]|apply` — the update notice and one-click update of section 10, for the terminal.
- `crew doctor` — checks node version, config validity, empty `checks` (warn), registration, hook wiring,
  per-event "hooks last seen" (warn when SessionStart/Stop/SessionEnd never fired), duplicate-looking work items,
  board reachability, and the cached latest release (no request).

## 14. Board

Pages: Overview (all projects) · Project (tasks by state with returns count, live
subagents, needs waiting for the user, work streams, log, MRs, validation, handoffs,
lessons, review stats, approval-gate history asked/answered/missing, hooks last seen, per-event `via`/branches) · Sessions (live list of local Claude Code / Codex sessions:
working / running a tool / waiting for user / idle / done, read-only from
`~/.claude/projects` and `~/.codex/sessions`) · Usage (tokens/cost by model and day) ·
Settings (edit `crew.json` of a project through a form with validation; global
`config.json`). UI languages: en, zh-TW (own string tables). Project names can be
masked for screen sharing. On every page a banner appears when `GET /api/update` reports a newer release:
version, kind (fix / new features / major), release notes link, **Update now**, **Skip this version**
(remembered in the browser per version) and, when the release carries the rehook marker, a re-approval hint
for Codex. The banner shows progress, the copyable commands when nothing can be run, and the restart.

Session statistics and timeline. `GET /api/sessions` and the project page add `stats` to each row and `totals` to a
parent (itself plus its subagents): duration, prompts, tool calls by name, subagents, errors, tokens per model and the cost
from `prices`. Totals need more than the watcher's tail read, so `board/session-stats.js` parses each transcript
incrementally: per file it keeps the byte offset, a hash of the first 256 bytes (a changed head or a smaller file means
rotation or truncation and a rebuild), counters per tool and per model, and the last message id (a message logged once
per content block counts once). The cache is `<home>/cache/sessions/<hash>.json`; it holds counters only. A call parses
at most 8 MB across all files, newest first; a file still behind reports `partial` and continues on the next call. A
last line without a newline counts only once it parses as JSON. `GET /api/session/<id>` returns the row, its subagents
and one page of the timeline (`board/session-timeline.js`): the transcript is read backwards from `before` (a byte
offset taken from the previous answer's `cursor`), at most 8 MB per page, until `limit` (200) steps of the wanted
`kinds` are found. Steps carry kind, time, tool name, duration (call to result when both are in the page) and links to
the subagent session; prompt text and tool targets are included only when `board.show_text` is on, redacted like the
live activity. Crewgate events of the session (from the project's event tail) are merged by time into the span the page
covers.

History. `GET /api/history` (`board/history.js`) serves sessions older than the watcher's 24-hour window (and the newer ones, too: it lists everything
inside `days`, 1-90, default 7). Discovery is a directory walk of the Claude and Codex roots with one `stat` per transcript (at most 20,000
files, then `truncated: true`); a subagent file (`<session>/subagents/agent-*.jsonl`) belongs to its parent session file, and a group is as new
as its newest member. Groups are sorted by mtime, newest first, and a page is 50 sessions (`limit` up to 100; sessions that share the last
mtime stay on the same page). The cursor `next` is the mtime of the last session looked at; `before` is a strict "older than", and at most 300
candidates have their head and tail read per request (the cwd, model and branch come from `watcher.readInfo`, remembered per file
and size), so a project filter that skips many sessions continues through the cursor instead of reading without end. The project is
resolved from the cwd like on the Sessions page; `project=-` means none. Statistics come from `session-stats` with its per-call byte
budget in newest-first order (parent, then its subagents), so what does not fit is `partial` and continues on the next request. Rows
have the Sessions row shape with `status: done`; `started` is the first record time, `day` the calendar day of the last activity for the
viewer's `tz` (minutes east of UTC), `day_totals` sum the rows of the page. Row ids are `hashId(file)` as everywhere; the module
remembers a bounded id to file map, and `GET /api/session/<id>` falls back to it (or, after a restart, to hashing the paths under the
roots), so ids never name a path the caller chose. The page keeps pages in memory, fetches again a page whose rows are `partial`, and
reloads the first page when you come back to it.

## 15. Testing and acceptance

- Unit tests per module; hook tests feed fixture payloads on stdin and assert stdout,
  exit code and events; adversarial cases: empty stdin, malformed JSON, huge fields,
  unregistered project, missing git.
- Repo hygiene test: no third-party project names, no vendor logos, no non-documentation
  IP addresses, no credentials (pattern scan).
- End-to-end test (scripted, no model): simulate dispatch → return → review → send-back →
  return → accept → merge via hook fixtures and CLI calls; assert the board API shows the
  exact final state with no duplicates and no missing steps.
- Release acceptance: the flow above in the example project with a real Claude session
  without any manual board command; Windows run; macOS/Linux unit tests in CI; README
  install-to-first-dispatch within 10 minutes.

## 16. Codex (experimental)

Facts: [PLUGIN-FACTS.md](PLUGIN-FACTS.md), Codex section. Two independent uses.

**Codex as a worker (`crew task run <id> --engine codex`).** A Codex sandbox cannot commit in a linked
worktree or write `~/.crewgate`, so crewgate does everything that needs more than file edits, outside
the sandbox:
1. Make sure the task has a branch and worktree (created from HEAD when missing, never inside the repo).
2. Dispatch: `created -> dispatched` (event `task.dispatched`, data `engine: codex`); a repeat run on a
   dispatched task records a re-dispatch.
3. Write `worker-prompt.md` (brief, scope, the rendered worker rules, and overrides: edit files only, no git writes,
   no `crew` calls, final message = one JSON object with `changes, tests, assumptions, realenv`) and
   `codex-schema.json` into the task folder. The prompt travels as a file because a long multi-line argument does
   not survive a Windows `.cmd` shim.
4. Run `<engine.command> exec -C <worktree> --sandbox workspace-write --skip-git-repo-check --output-schema <schema> -o <last-message> <short prompt>`
   through `core/exec.js` (no shell), stdin closed, a timeout (default 1800 s) after which the process tree is killed.
   The engine's own `args` (built for the reviewer) are not used.
5. Success needs a valid JSON message and at least one changed file. crewgate runs `git add -A` and `git commit`
   (author = the repository's git user, trailer `Co-Authored-By: Codex <noreply@openai.com>`), builds `report.md`
   (branch and commit filled by crewgate) and `packet.md` (raw model output and full diff), both redacted, and moves the
   task to `returned` (`task.returned`). It prints one summary line.
6. Any failure (bad or missing output, timeout, non-zero exit, no changes, git error) commits nothing, appends `task.failed`
   (kind: output, timeout, exit, no-changes, commit, ...), adds a need and leaves the worktree as is. The state machine has no
   `failed` state: the task stays `dispatched` so it can be run again or cancelled.

**Codex as the orchestrator.** The plugin folder serves both CLIs. `.codex-plugin/plugin.json` names the skills folder
and `hooks/codex-hooks.json` (Codex has no `args` array, so commands are single strings with `commandWindows`; the
Claude file keeps the exec form). Hook code treats `collaborationspawn_agent` like `Agent`: marker in `tool_input.message`,
type from `task_name`, always a background launch. Real Codex sends an opaque spawn message, so the dispatch is normally recorded at SubagentStart instead: the marker is read from the new subagent's rollout file (the last `crew-task:` marker in its last 512 KB, because forked parent history may contain older ones), the task goes `created -> dispatched` (`task.dispatched`, `engine: codex`, `via: subagent-start`) and the agent id is bound for SubagentStop. `crew init --engine codex` (or an existing `.codex/`) renders
`.codex/agents/crew-reviewer.toml` and `crew-refuter.toml` from the same templates and adds a marked block to
`AGENTS.md` (never touches text outside the markers). There is no Codex worker agent: subagents share the parent's
sandbox, so workers always go through `crew task run`. Requirements: the user trusts the hooks once in `/hooks` (again
after a command changes) and approves the `crew` commands because they write `~/.crewgate`.

**Board.** Events carry the engine; Codex sessions are listed from their rollout files and linked to roles and tasks through
`subagent.start` events like Claude sessions.
