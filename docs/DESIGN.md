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
- No LLM calls from hooks or the board. No network access of any kind.
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
- `gates` values: `auto` (just do it), `ask` (ask the user in chat first), `never`.
- `orchestrator_edit`: `off` | `warn` | `block` (see §8).
- `checks`: commands a worker must run before reporting (e.g. `["npm test"]`).
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
  `git.push`, `git.merge`, `config.changed`.

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
| PostToolUse (Bash) | Detect `git push`, `git merge`, `gh pr create`, `glab mr create` in the command; record `git.push` / `git.merge`. |
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
`crew handoff list`, `crew handoff show <id>`, `crew handoff accept <id>` (atomic
`rename` from `open/` to `accepted/`; a second accept fails cleanly),
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

- `crew init [--lang en|zh-TW] [--force] [--reset-review-files]` — write `.claude/crew.json`, render
  `.claude/agents/crew-*.md`, create `.crew/REVIEW.md`, `.crew/LESSONS.md`, register
  project. Never overwrites without `--force` (then backs up).
- `crew project add|list|rm`
- `crew task create|list|show|report|send-back|accept|merge|cancel`
- `crew review run|filter|finalize|dismiss|show`
- `crew handoff create|list|show|accept|cancel`
- `crew lesson add|list|suggest|promote|retire`
- `crew need add|done|list`, `crew work set|rm|list`, `crew log add|list`,
  `crew mr set|list`, `crew validate set|list`
- `crew board start|stop|status|serve [--port] [--no-open]`
- `crew import agent-board <data dir> --from-project <id> [--force]`
- `crew doctor` — checks node version, config validity, registration, hook wiring,
  board reachability.

## 14. Board

Pages: Overview (all projects) · Project (tasks by state with returns count, live
subagents, needs waiting for the user, work streams, log, MRs, validation, handoffs,
lessons, review stats) · Sessions (live list of local Claude Code / Codex sessions:
working / running a tool / waiting for user / idle / done, read-only from
`~/.claude/projects` and `~/.codex/sessions`) · Usage (tokens/cost by model and day) ·
Settings (edit `crew.json` of a project through a form with validation; global
`config.json`). UI languages: en, zh-TW (own string tables). Project names can be
masked for screen sharing.

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
