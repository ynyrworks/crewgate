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
- No 3D or game-like board. The live-session list is the default and the only view that must work everywhere; the pixel-art Office page (section 14) is an experimental, separately installed add-on.
- Gemini. Codex as orchestrator, worker and reviewer is supported experimentally (section 16).

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
  hook-errors.jsonl                    one line per hook failure (§8); rotated at 1 MiB to hook-errors.1.jsonl
  board.log                            output of the board server, each line with an ISO timestamp
  board.json                           running board: { pid, port, started, alive }; `alive` is re-stamped every minute, so a board
                                       killed without a stop line is reported (log, `board status`, `doctor`) with its last-alive time
  cache/sessions/                      per-transcript session statistics (counters only, §14)
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
    // plus a project's own, such as "release": "ask": any lowercase key set to auto, ask or never works with crew gate ask
  },
  "limits": {
    "max_parallel_workers": 3,
    "parallel_enforce": "block",
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
  `crew gate answer <gate-id> yes|no [--note]` (`gate.answered`). A PostToolUse(Bash) hook checks the same gates (§8); `gates.enforce` (`remind` | `confirm` | `block`) moves the check before the command and `gates.require_user_turn` (default true) makes an approval count only after a user message (§8.1).
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
  `git.push`, `git.merge`, `gate.missing`, `gate.prompted`, `gate.blocked`, `gate.confirmed`, `config.changed`.
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
  `last_src` is `payload` | `transcript` | `transcript_partial` | `none`. The transcript fallback accepts only the final assistant
  entry (no tool call in it, no tool result after it); anything else is `transcript_partial` with an empty `last`, so mid-run text
  is never taken as the final message. The event also records `had_transcript_path` and `had_last_message`, and `orphan: true`
  when no `subagent.start` and no task link exists (the compaction / summary agent), so counts of real subagents can skip it.
  The board shows `last` only when `board.show_text` is on.
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
finish in < 200 ms typical; unregistered project → `{}`. A failure that answers `{}` is not silent: a handler error, a worker
crash and a guard expiry append one line `{ts, event, kind: error|guard|worker_exit, msg, version}` to
`<home>/hook-errors.jsonl` (`lib/core/hooklog.js`: message redacted and cut to 300 characters, a file over 1 MiB renamed to
`hook-errors.1.jsonl`, logging itself never throws). `crew doctor` shows the counts of the last 24 hours and 7 days.

| Event | Behaviour |
|---|---|
| SessionStart | Inject a fenced brief ≤ 4,000 bytes: role contract one-liner, open tasks by state, count + ids of open handoffs (never their bodies), count of needs waiting for the user, path to promoted rules. Content from files is fenced and marked untrusted. Record `session.start`. |
| PreToolUse (Agent/Task tool, main session) | If prompt contains `crew-task: <id>`, record `task.dispatched` (with tool_use_id, subagent type, model, background flag). Deny (`limits.parallel_enforce` `block`, default; `warn` only reminds) when the workers really running would pass `max_parallel_workers`: see 8.2. |
| PostToolUse (Agent/Task tool) | Foreground: record `task.returned` if the worker did not already report. Background launch: nothing (wait for SubagentStop). |
| SubagentStart / SubagentStop | Record `subagent.start/stop`; on stop of a task-linked worker, show the user a `systemMessage` (not `additionalContext`, which would keep the subagent running): "task <id> returned — review it: `crew task show <id>`". |
| PreToolUse (Edit/Write/MultiEdit/NotebookEdit, main session, main worktree) | If the target is not matched by `orchestrator_edit_allow`: `warn` → non-blocking reminder to delegate + `orchestrator.warned`; `block` → deny with reason. Never applies inside subagents or linked worktrees. |
| PreToolUse (Read, main session) | If the file has more lines than `orchestrator_read_warn_lines` and no `limit` was given, add a reminder to read the report/diff stat first and use line ranges. Never blocks. |
| PreToolUse (Bash) | Only when `gates.enforce` is `confirm` or `block` (§8.1): a push / PR / merge under an `ask` gate with no approval gets `permissionDecision` `ask` or `deny`. Skipped for Codex payloads. |
| PostToolUse (Bash) | Detect `git push`, `git merge`, `gh pr create`, `glab mr create` in the command (redirections, comments and heredoc bodies are not commands; the repository a `cd` / `git -C` points to decides which project the events and the gate check belong to, §8.1); record `git.push` / `git.merge` (merge parsing: §6). Then the gate check: push → `push`, `gh pr create` / `glab mr create` → `open_pr`, merge → `merge`; if that gate is `ask` and no `gate.answered yes` of the last 30 minutes exists, record `gate.missing` and add a non-blocking reminder (`additionalContext`) to run `crew gate ask` / `answer` first (with `gates.enforce: confirm`, a command that was put to the user and ran records `gate.confirmed` instead). |
| every event | Whenever a hook resolves a registered project it notes the event in `runtime/hook-seen.json` (`{ events: { SessionStart: iso, ... } }`, at most one write per event type per 60 s). `crew doctor` and the board show it; SessionStart/Stop/SessionEnd never seen means the session began before the plugin was installed (or the wiring is broken). |
| Stop | If tasks are `returned` but not reviewed, or dispatched background tasks are still running, add a one-line reminder. Respect `stop_hook_active` (never loop). |
| PreCompact | Record `session.compact` with a digest checkpoint. |
| SessionEnd | Deterministic digest (no LLM): prompt count, tool counts, duration, end reason, first/last prompt (truncated), last tool, tasks touched. Abnormal-end flags: dispatched-but-not-returned tasks; last assistant turn ended with a question; no Stop seen. Each flag adds a need ("waiting for you"). |

### 8.1 Gate enforcement (`gates.enforce`, `gates.require_user_turn`)

A push (`git push`), a PR (`gh pr create`, `glab mr create`) or a merge (`git merge`, `gh pr merge`, `glab mr merge`) under an
`ask` gate needs an **approval**: a `gate.answered yes` of the last 30 minutes, recorded by the orchestrator with
`crew gate answer` after the user answered in chat. `gates.enforce` decides *when* that is checked:

| `gates.enforce` | Hook | What happens, step by step |
|---|---|---|
| `remind` (default) | PostToolUse(Bash) | 1. The command runs. 2. The hook finds the push / PR / merge and records `git.push` / `git.merge`. 3. The gate is `ask` and there is no approval: `gate.missing` is recorded and a non-blocking reminder goes to the model. Nothing is stopped. |
| `confirm` | PreToolUse(Bash), then PostToolUse(Bash) | 1. Before the command, the hook finds the push / PR / merge, resolves the target project (below) and checks the approval. 2. No approval: it records `gate.prompted` and answers `permissionDecision: "ask"` with a reason (which command, which project, which gate). Claude Code then shows its own permission prompt. 3. You allow: the command runs; PostToolUse sees the `gate.prompted` of the same `tool_use_id`, records `gate.confirmed` (`via: "permission-prompt"`, plus the `permission_mode` seen) and writes no `gate.missing`. You deny: nothing runs. 4. An approval exists: the hook is silent and the command goes on as it would without crewgate. |
| `block` | PreToolUse(Bash) | 1. Same detection and approval check. 2. No approval: `gate.blocked` is recorded and the hook answers `permissionDecision: "deny"` with instructions. The command does not run. 3. The model runs `crew gate ask <gate>`, asks you in chat, waits for your reply, runs `crew gate answer <id> yes` and retries; now the check passes. |

The table is about gates set to `ask`. `auto` is not touched by the hook. A push, PR or merge under `never` is denied before
it runs in all three modes (`gate.blocked`, `mode: "never"`) and no approval lifts it; `crew gate ask` refuses `never` too.
Codex has no such check, so one that ran there is recorded afterwards (`gate.missing`, `mode: "never"`) and reported to the
model. One command line may touch several gates (`git push && gh pr create`): one reason lists all of them.

**Best effort.** Every mode is interception, not a hard stop. The hooks see the Bash and PowerShell tools only and read
the command text, unwrapping `bash -c`, `eval`, `powershell -c`, `cmd /c`, `iex`, `npx` and an inline `git -c alias.x=y`. A
script, a configured alias or another tool is not seen, and a hook that crashes or times out lets the command through. With
`block`, events that cannot be read count as no approval; an unreadable config leaves the modes unknown and nothing is denied.

**Target project.** Detection is the one used for events: `cd` / `pushd` words and `git -C` are resolved from the session
working directory, a subshell's `cd` does not leak out of it, and redirections, comments and heredoc bodies are not
commands. The *target* project's `.claude/crew.json` decides `gates.enforce`, the gate modes and `require_user_turn`,
and the approval is looked up in the target project's events. A directory outside every registered project is never
enforced (and never registered). A dynamic directory (`cd "$DIR"`) falls back to the session project.

**Pros and cons**

| | `remind` | `confirm` | `block` |
|---|---|---|---|
| Stops an unapproved push | no | yes, until you click allow | yes |
| Who decides | nobody (the model is only told) | you, in the client's own prompt | the model, by recording an approval after your reply |
| A false detection costs | nothing | one click | a stopped command; the model must ask and retry |
| Unattended (CI, `claude -p`) | fine, never blocks | no human to click; depends on the permission mode | fine; use it with `auto` gates for what the run may do |
| Depends on | PostToolUse only | client support for PreToolUse `ask`, and the permission mode | PreToolUse `deny` |
| A security boundary | no | partly: the click is yours, but see the limits below | no: the model can still call `crew gate answer` itself |

**Permission modes (`confirm`).** Claude Code documents PreToolUse `ask` as "prompt the user for this tool call". In
real `claude -p` runs (2.1.308, 2026-10-31) a gated `git push` did not run in `default`, `dontAsk` or `bypassPermissions`
mode: `gate.prompted` was recorded, no `gate.confirmed`, and the remote stayed unchanged. So an unattended run is stopped,
not waved through. An interactive session in `bypassPermissions` also asked (2.1.308, 2026-10-31): the push waited at the permission prompt until a person allowed it. The hook records the `permission_mode` it saw in `gate.prompted` / `gate.confirmed`, so a
run can be audited afterwards. crewgate cannot tell from a hook whether a prompt was really shown, so `gate.confirmed`
means "the command ran after an ask was returned", not "a human clicked".

**Codex.** The Codex hook table registers the Bash PreToolUse entry. Measured (docs/PLUGIN-FACTS.md): Codex honours
`deny` (the command does not run) but `ask` fails open (the hook shows as failed and the command runs), so a payload
with a `turn_id` is never sent `ask`. A `never` gate is denied; an `ask` gate without a valid approval is denied under
`block` and, because Codex cannot ask, also under `confirm`, with text on how to record an approval. Under `remind`
Codex stays on after-the-fact reporting. An older Codex that ignores `deny` still gets the PostToolUse `gate.missing`.
`crew doctor` says so.

**User-turn rule (`gates.require_user_turn`, default `true`).** An approval made by hand counts only if a *user message*
arrived between its `gate.asked` and its `gate.answered yes`. The rule is judged **once, when the answer is recorded**
(`crew gate answer`), and the verdict is stored on the `gate.answered` event as `data.user_turn` (`true`, `false` or
`"project"`) with `data.ask_session`; later checks (`hasApproval`, the hooks) read only that verdict, the 30-minute answer
window and the session match. The ask is found by its gate id (the whole log, no time cutoff). The CLI takes the session
id from `CLAUDE_CODE_SESSION_ID` (exported by Claude Code to the Bash tool, equal to the hook payload `session_id`), then
`CLAUDE_SESSION_ID` for compatibility; `CLAUDE_CODE_HOST_SESSION_ID` is a different value and is not used. (Before this
version the CLI read only `CLAUDE_SESSION_ID`, which Claude Code does not set, so every earlier `gate.asked` /
`gate.answered` has no session.) The verdict depends on what is known:

| Ask session | Answer session | Rule | `user_turn` |
|---|---|---|---|
| known | known, same | a prompt of that session lies between ask and answer | `true` / `false` |
| known | known, different | never valid | `false` |
| known | unknown (or the reverse) | a prompt of the known session lies between | `true` / `false` |
| unknown | unknown (Codex CLI: no session variable is known) | a prompt of **any** session of the project lies between | `"project"` / `false` |

`"project"` is weaker: with several sessions open on one project, a message in another session satisfies it. A parent /
subagent link is not followed. `prompt_ts` is the list the `UserPromptSubmit` hook keeps in the session file (time in ms,
never the text, newest 20); it is read while fresh, right after your reply. The automatic yes of an `auto` gate needs
no verdict. `crew gate answer ... yes` prints a warning when the verdict is `false`. A `gate.answered` written before
this field existed has no verdict (unknown) and is **not valid** while `require_user_turn` is `true`. With `false` the old
rule applies (any yes of the last 30 minutes). The rule applies in all three modes.

What it prevents: the model asking and answering "yes" itself inside one turn (`gate ask` and `gate answer yes` in a row)
without you having replied, and another session validating an ask. What it does not prevent: the model answering "yes"
after you replied about something else (any message counts, the text is not read); a false `--note`; the model editing
`~/.crewgate`. It is a speed bump against careless self-approval, not authentication.

**Cost.** PreToolUse(Bash) runs for every Bash call. `scripts/crew-hook.js` therefore reads stdin and tests the command
with `lib/hooks/prefilter.js` (no `require`s) before it starts the worker thread or loads any other module; a command
without push / merge / create answers `{}` at about the cost of a bare `node` start. Only git-like commands load the
handler and resolve the project (full resolution of the current directory and of `cd` / `git -C` targets, like
PostToolUse).

**Detection limits** (all modes): only the command text of the Bash tool is read. A script that pushes (`./deploy.sh`,
`make release`), a shell alias or function, a command assembled from variables (`$GIT push`), `eval`, and a push by
another tool (an IDE, a Git GUI, an MCP server, `curl` against a hosting API) are not seen. Treat the gate as protection
against the model's ordinary habits, not against a determined bypass; use the client's own permission rules (deny
`Bash(git push:*)`) for that.

**Recommended settings**

| Situation | Setting |
|---|---|
| Interactive session, you are at the keyboard | `gates.enforce: "confirm"` (keep `require_user_turn: true`) |
| CI / headless / scheduled runs with nobody to click | `gates.enforce: "block"`, and set the gates the run may use to `auto` (`push: "auto"` ...) so they pass; leave the others `ask` / `never` so they stop |
| Solo experiments, throw-away repos | `remind` (the default) |

Events: `gate.prompted` `{ gate, command, mode, tool_use_id, permission_mode }`, `gate.blocked` (same fields),
`gate.confirmed` `{ gate, command, via, permission_mode }`. They are information for the board's timeline; none of them
counts as an approval.

Main session vs subagent and main worktree vs linked worktree are detected from the
hook payload and `git rev-parse`; see `lib/core/context.js`.

### 8.2 Crew agent limits

PreToolUse(Bash / PowerShell) denies, for a subagent of type `crew-worker`, `crew-reviewer` or `crew-refuter`
(`crewgate:` prefix ignored), what its role forbids (`lib/hooks/agentlimits.js`):

- reviewer and refuter: a git command that changes a working tree, the index, history or the branch list
  (`checkout`, `switch`, `reset`, `merge`, `rebase`, `commit`, `stash`, `clean`, `restore`, `cherry-pick`, `push`,
  `pull`, `revert`, `am`, `worktree` other than `list`, `branch` that creates, deletes, renames or copies).
  `diff`, `log`, `show`, `status`, `rev-parse`, `merge-tree`, `merge-base` pass.
- all three: killing by image name (`taskkill /IM`, `Stop-Process -Name`, a piped `Stop-Process`, `pkill`, `killall`).
  Killing by pid passes.
- all three: an inline loop with no end: `node -e` / `python -c` / `powershell -Command` with `for(;;)`, `while(true)`,
  `while(1)` or `while($true)`, a bash `while true; do` / `while :; do`, `yes` with its output discarded, `stress` and
  `stress-ng` without `-t` / `--timeout`. A `timeout N` prefix passes only a shell loop or `node -e` run directly under it.
  A `for` loop that starts more background jobs (`&`) than half the CPU cores (`os.cpus().length`) is denied; a count
  it cannot read passes. The reason tells the agent to give a count and a time limit from the brief.

The command line is tokenised with `gitcmd.js`, so `git -C`, `cd x && ...`, `bash -c`, `powershell -Command` and git
aliases are seen. The main session and other subagent types are never limited. The agent type is the payload's
`agent_type`; when absent, the type SubagentStart recorded for the `agent_id`. A denial records `agent.limit`
`{ agent_type, command (first word), tool_use_id }`, never the arguments. This is best effort: a command the parser
cannot recognise (a script file, a variable, an unusual wrapper) passes, and so does any failure of the check; the
agent templates state the same rules in words. Scripts and files are never read (`node run.js` with a loop inside
passes), so the busy-loop rule is best effort, and nothing here limits a process once it runs.

**Parallel workers.** A dispatch through Agent / Task, or a SendMessage to a stopped worker (`tool_input.to`, read from
the tool's documented input, not measured), that would pass `limits.max_parallel_workers` is denied when
`limits.parallel_enforce` is `block`; the reason names the running tasks, and nothing is recorded, so the task stays as it was.
The count is the dispatch map (`dispatch.json`), not tasks in state `dispatched`: a worker record, not `stopped`, younger
than 6 hours, whose task is still `dispatched` and whose session file still exists (SessionEnd removes it). The task
being dispatched is left out, so a re-dispatch is not counted twice. SessionStart with source `startup`, `resume` or
`fork` marks every open record stopped (a new process has none of the old workers; `compact` and `clear` keep them), so
tasks an app quit left `dispatched` never block and can be dispatched again at once. Two sessions open on one project at the
same time share the map, so the second one starting clears the first one's records: the count then errs low (it undercounts,
it never blocks by mistake). A worker woken by SendMessage counts whatever its task state until it stops again. `crew task send-back` and
reviewers are not counted.

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
- Hook failures go to `<home>/hook-errors.jsonl` (§8): local, redacted before truncation, messages cut to 300 characters, one
  file of at most about 1 MiB plus the previous one. Nothing in it leaves the machine.
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
- `crew plan new|list|show|add|link|set|rm` — §17.
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
`~/.claude/projects` and `~/.codex/sessions`) · History (`#/history`, sessions up to 90 days back, below) · Office (`#/office`, experimental, below) ·
Usage (tokens/cost by model and day) · Settings (edit `crew.json` of a project through a form with validation; global
`config.json`). UI languages: en, zh-TW (own string tables). Project names can be
masked for screen sharing. On every page a banner appears when `GET /api/update` reports a newer release:
version, kind (fix / new features / major), release notes link, **Update now**, **Skip this version**
(remembered in the browser per version) and, when the release carries the rehook marker, a re-approval hint
for Codex. The banner shows progress, the copyable commands when nothing can be run, and the restart.

Empty cards. A project that follows the normal flow never fills work, log, MRs or validation by hand, so the Project page derives what it can from events (`activity` in the project API, read backwards with a bound on bytes, independent of the 40-event tail): with no MRs the card becomes "Recent merges" (merged tasks and pushes, up to 10); with no log lines it lists task steps and gate answers (up to 15), read-only, and the add form stays. Work and validation with no data fold into one `details` line; validation is never derived, only recorded runs count. Cards with data are unchanged. Private mode shows ids only.

Layout. Below 720 px the page scrolls and nothing is capped. From there up, lists and tables inside cards (needs, tasks,
sessions, work, log, MRs, validation, handoffs, lessons, gates, hooks, events, subagents, the History day groups, the Usage
model table, the Overview project list) have a capped height and scroll inside the card: a shadow shows where more content is
hidden, the title carries the count, and the scroll area is focusable and named for the keyboard. Short cards keep their
natural height; the session timeline takes the height of the window; scroll positions survive a refresh. `main` is fluid up to
2400 px with side padding that grows with the screen, grids gain columns (4 at 1920 px, 5 at 2560 px and up), the session and
history lists become a multi-column card grid from 1600 px, and table headers stay visible while scrolling.

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
live activity. Crewgate events of the session are merged by time into the span the page covers: the project's events file is read backwards
from its end (at most 4 MiB) for that time window, so events older than the board's recent event tail show too. A call opened on
an older page gets its duration, failure flag and subagent link from a forward look-ahead past the page edge (at most 512 KiB;
the answer's `ahead` is the byte count). The timeline page has a search box over the loaded steps (tool name, target, prompt
snippet, event type, task id; all words must match; in private mode only names and kinds).

History. `GET /api/history` (`board/history.js`) serves sessions older than the watcher's 24-hour window (and the newer ones, too: it lists everything
inside `days`, 1-90, default 7). Discovery walks the known layouts of the Claude and Codex roots (Codex date folders out of range are not opened), entry by
entry, charging every directory open and entry to a budget (40,000, then `truncated: true`), and takes one `stat` per transcript; a subagent file (`<session>/subagents/agent-*.jsonl`) belongs to its parent session file, and a group is as new
as its newest member. Groups are sorted by (whole-millisecond mtime, id) descending, newest first, and a page is 50 sessions (`limit` up to 100). The cursor
`next` is `<ms>-<id>` of the last session looked at and `before` means strictly after it in that order, so ties are never skipped or
repeated even when the examination cap or the page size ends inside one; at most 300
candidates have their head and tail read per request (the cwd, model and branch come from `watcher.readInfo`, remembered per file
and size), so a project filter that skips many sessions continues through the cursor instead of reading without end. The project is
resolved from the cwd like on the Sessions page; `project=-` means none. Statistics come from `session-stats` with its per-call byte
budget in newest-first order (parent, then its subagents), so what does not fit is `partial` and continues on the next request. Rows
have the Sessions row shape with `status: done`; `started` is the first record time, `day` the calendar day of the last activity for the
viewer's `tz` (minutes east of UTC), `day_totals` sum the rows of the page. Row ids are `hashId(file)` as everywhere; the module
remembers a bounded id to file map, and `GET /api/session/<id>` falls back to it (or, after a restart, to hashing the paths under the
roots), so ids never name a path the caller chose. The page keeps pages in memory, fetches again a page whose rows are `partial`, and
reloads the first page when you come back to it.

Office add-on. The Office page is a separate optional plugin, `plugins/crewgate-office`, so the main plugin ships nothing of it.
The board looks for it in three fixed places (`board/office-addon.js`): the folder next to the plugin, and the Claude and Codex
plugin caches when that tool's own list (`installed_plugins.json`, `config.toml`) still names it, because an uninstall leaves the
cache folder behind. A plugin installed by a tool counts the neighbouring folder only when that list names the add-on too, since a
marketplace clone always holds it. There is no configured path and no download. `GET /api/addons` tells the page `missing`, `outdated` or `ok`,
never the folder. `office.json` in the add-on declares `office_api` and its files; a value other than `OFFICE_API` is not loaded,
and the page shows the update commands instead. The board serves only the listed files from the add-on's `public`
folder at `/addon/office/<file>`: the `scripts` and `styles`, and the listed `assets` (`.png`, `.json`, `.js`, such as the art and three.js,
which the HD view loads only when shown). The page loads the scripts in order under the same CSP. `office_api` is the contract (now 2): raise it when
what `app.js` passes to `Office.page` changes; since 2 that includes `store` and `refresh`, the page's remembered choice and its redraw. Its strings stay in the board's i18n tables. One-click update runs
`claude plugin update crewgate-office@crewgate` when it is installed (a failure there does not fail the plugin update), and old
versions are cleaned up like the plugin's.

HD view (`office-hd.js`, pure logic in `office-hd-model.js`). Pixel-art cards in a lit 3D room, three.js r170. Cards face the fixed camera
because the art is drawn from that angle; their normals lean upward so they take light like the floor. Floor and walls write no depth,
so cards that lean back toward them are not cut. A seated character moves back along the view line: same place on screen, but behind
the desk's card. The set of lights is fixed, so nothing recompiles when sessions come and go. Bloom, tilt shift and tone mapping are
written in this file: three's add-ons need an import map, which the CSP does not allow, and the view must load one file only. The board
builds the page on every refresh and attaches it only when the data changed, so a page takes the single canvas only if it is
on screen. The first time, the frame rate is measured for 3 s after 1 s of settling (not while hidden); under 20 fps the view stays off
until the user asks. It is opt-in: the pixel view is the default, and only a stored `crew.office.view` of `hd` shows the HD view; the button is labelled as a test version. The art is produced by `scripts/office-art.py`; see the add-on's `ART.md`.

Office. `#/office` (`plugins/crewgate-office/public/office.js`, `office-model.js`, `office-sprites.js`; experimental) draws the Sessions rows as
a pixel-art office on a canvas, from scratch with no assets: one room per project, an orchestrator at the middle desk of a pod
with its subagents around it. `office-model.js` is pure logic (no DOM, no canvas) and decides, from a row's status and
activity, which animation a session gets (thinking, tool, writing, waiting, idle, done; the tool decides the prop: document,
magnifier, terminal with a progress bar, globe), where each session sits and what its tooltip may say. Lifecycle: a finished
session walks out of the door; one idle for 90 s rests in the lounge (sofa, coffee machine, plant) and walks back when active.
Errands (skipped under reduced motion): a finished subagent walks to its parent with a paper, a reviewer goes to the reviewed
worker's screen, a refuter stands by the reviewer, an orchestrator hands a paper to a new subagent. The role shows in the look
(headset and lanyard, glasses, crossed arms), the engine in the shirt colour, and each session gets a seeded hair, skin and
accessory. The result of a command is not in the data the office receives, so there is no reaction to pass or fail. Private mode
aliases the project name on the cork board; the list under the canvas stays keyboard-operable.

Account label. `core/account.js` finds the Claude account a session runs under: `CLAUDE_CODE_ACCOUNT_UUID` and
`CLAUDE_CODE_ORGANIZATION_UUID` from the hook's environment, then `oauthAccount` in `<CLAUDE_CONFIG_DIR or home>/.claude.json`
for the label and plan. When an id from the environment differs from the file's, only the id is used (the file describes another
account). API-key sessions, Codex sessions and a missing or malformed file give no account. `session.start` records
`account_id` (first 8 characters of the UUID) and `plan` (`billingType` or `seatTier`), never the email or name; the label
(`email`, `organization`) is kept in `<home>/accounts.json` by short id, stays on the machine and is read only by the board and
`crew doctor`. The board shows it on Sessions rows and the session page; private mode hides it. Project config `account.expected`
(email, organization name or UUID, case-insensitive): on a mismatch, or when the account cannot be determined, SessionStart adds one
warning line to the brief, appends `account.mismatch` (reason and short id only) and adds one need per session. It never blocks.

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

### Machine load from a crew session

What causes it: `node --test` runs `availableParallelism() - 1` test files at once (32 threads: 57 node processes, 97% CPU at peak, measured), several workers can each do that, and everything an agent starts has the same priority as the user's own apps.

Layers, from the source of the load outward:
1. Test concurrency: `scripts/run-tests.js` passes `--test-concurrency=max(2, floor(cores / 4))` (override: `CREW_TEST_CONCURRENCY`) when the Node version knows the flag (20.10+), and lowers its own priority first.
2. Priority: SessionStart lowers the Claude Code process to below normal (`limits.process_priority`, `lib/hooks/priority.js`). Children inherit it. Only a parent identified as Claude Code is touched, only lowered, only in a registered crew project; every error is swallowed.
3. Worker rules: related test files only while working, one run at a time, the full suite once at the end in the foreground; the orchestrator runs the full suite at merge, one at a time.
4. Session job (Windows only): SessionStart starts one holder (`scripts/session-job.ps1`, started by `lib/hooks/sessionjob.js`) for the Claude Code process, identified as in `priority.js`. The holder, which is not in the job itself, creates an unnamed Job Object, sets a CPU hard cap (`limits.session_cpu_percent`, default 60, a percentage of the whole machine, 100 = no cap; read back with `QueryInformationJobObject` and recorded in the `session.job` event) and assigns the Claude Code process, so every process it starts later joins the job with nothing rewritten. When Claude Code exits, by any cause, the holder lists the job's processes, leaves out the running board (the pid in `board.json`), every process with a visible main window (a browser or any program the user can see) and all their descendants, stops the rest by pid (only a process still in the job), repeats list and stop for up to five rounds (what a leftover starts meanwhile is caught; what is kept is recomputed each round), records `session.cleanup` with counts and no command lines, and exits (`limits.session_cleanup`: `off` lists and records without stopping). It waits on the process handle, so it uses no CPU while waiting. It fails closed: if `board.json` exists but cannot be read or has no valid pid, nothing is stopped and `session.cleanup` carries `error=board-json-unreadable`; job members whose command line is this plugin's `board serve` (and their descendants) are kept in every case, whether `board.json` is absent, names a dead pid or names a live one, because the board removes the file of a live board after a missed health check and a second board may then have been started (command lines are never logged). What was kept in one round stays kept in the later rounds. A child whose parent has exited is not kept for that reason: orphans are exactly the leftovers cleanup is for, unless they descend from a kept process. A program opened from a session (the board's browser, for one) is therefore not closed at cleanup (the window test looks at the job member's own main window: a console process whose visible window belongs to another process, such as a Windows Terminal tab opened from a session, can count as background and be stopped; `limits.session_cleanup: off` is the way out), and keeps the below-normal priority and the CPU cap until it is closed. Only one holder per Claude Code pid (Node claims `runtime/session-job-<pid>.pid` exclusively before starting it, the holder overwrites it with its pid and removes it when it exits; a claim older than 30 s with no live pid is stale). The holder refuses a process that started after the hook took its pid (a reused pid) and records `session.job.error` for a failed `Add-Type`; compact, clear and resume in the same process start no second one. Safe by construction: no kill-on-close (the holder dying never kills Claude Code, the session and its children just carry on), no `TerminateJobObject`, SessionStart never waits for the holder, and a missing PowerShell or a refused assign is a `session.job.error` event and nothing else. The holder is started by a detached `wscript.exe //B //Nologo scripts/hidden-run.vbs <shell> <args...>` (the static script rebuilds the quoted command line and runs it with window style 0, without waiting): a `detached` PowerShell exits at once, a plain Node child dies with the hook, `cmd /c start /b` opens a Windows Terminal window and `conhost --headless` did not run the script (see PLUGIN-FACTS). If `wscript.exe` is missing or blocked, no holder starts (`session.job.error` with `reason=no-wscript`) and there is no other way tried, since each could show a window; arguments containing a quote or a percent sign are refused (`reason=bad-path`; `Run` expands `%VAR%`).
5. Hook denials: `limits.max_parallel_workers` and the unbounded-loop checks, a last layer that reads command text.

Priority helps once a core is saturated and does nothing while cores are idle. Measured (see PLUGIN-FACTS): a full default test run on 32 threads never saturated the machine (peak CPU about 79%), so a normal-priority timer probe saw no difference there; with four loops pinned to one core, the probe's worst delay was 378.9 ms against 2.5 ms when the loops ran at below normal. A real `claude -p` session confirmed the hook finds the Claude process and a Bash child inherits priority 10. The whole machine at saturation was not measured. Layer 1 is what lowers the load itself.

Another session's holder in the job is kept like the board: it exits by itself with its session. The cap is proven to be enforced; cleanup is proven with stand-in sessions only, since under `claude -p` leftovers were already gone by other means and the desktop-app quit of the incident was not reproduced (see PLUGIN-FACTS).

What escapes the job: any process that started before the assign (the hook's own children and anything Claude Code started in the first second or so are not in it, and joining later is not possible), anything created through `Win32_Process.Create` (WMI, `Invoke-CimMethod`; Microsoft documents that these are created outside the caller's job), and every other platform (macOS and Linux do nothing: no cgroup is used). The cap and the cleanup cover only what runs inside the job. If the holder never starts, the session is exactly as without it. If the holder is killed after the assign, the cap stays on (nothing clears it while Claude Code is in the job), there is no cleanup, and the next SessionStart in that process finds no live holder and starts a new one, which nests another job.

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

## 17. Plans

A plan is a tree of steps above tasks and work items, kept as Markdown in the repo so it is reviewed and versioned
like code: `<work tree>/.crew/plans/<slug>.md` (slug `[a-z0-9-]{1,40}`). The CLI resolves the work tree the same way as
for `LESSONS.md`; the board reads the project root, so a plan edited in a linked worktree shows after it is merged.

```
# 0.14 plan
Optional free text (goal).

- [ ] Plan tree and completion view <!-- id:n1 added:2026-10-30 origin:plan -->
  - [x] File format and CLI <!-- id:n2 task:t-20261030-abcd added:2026-10-30 origin:plan -->
- [?] Proposed by refuter <!-- id:n5 origin:refute added:2026-10-31 -->
```

- Boxes: `[ ]` open, `[x]` done by hand, `[~]` dropped (excluded from progress), `[?]` proposed (shown, excluded until
  accepted). The comment holds `id`, `task` (one task id), `added` (YYYY-MM-DD) and `origin` (`plan | user | review |
  refute | implementation | send-back`, default `plan`); unknown keys are kept. Depth is at most 3 (the CLI refuses a
  deeper add; a hand-edited deeper line is shown and `crew doctor` warns). The board reads at most 256 KiB and 500 nodes.
- Lines under a `## Clarified` heading are settled questions (`crew plan clarify`), not steps: `plan show`, the plan page and the plan review packet carry them. New steps go above that heading. The goal is the text between the title and the first list item or heading.
- Parsing is tolerant and never throws: non-list lines are kept as they are, lines without a comment are valid, tabs and
  2-4 space indents are accepted, a heading restarts the nesting. A rewrite re-renders only the lines it changed (new
  ids, state, link) and leaves every other byte alone; writes are atomic and held under a lock.
- Derived state (`lib/core/plans.js`): a leaf is `dropped`/`proposed` from its box; else `done` if `[x]` or the task is
  `merged`/`accepted`; `review` if the task is `returned`/`reviewing`; `doing` if `dispatched`; `blocked` (needs attention)
  if `cancelled`; otherwise `todo`. An unknown task id is shown as such and the state comes from the box. A parent counts
  the leaves below it that are not dropped or proposed: progress = done / counted, done when all are done or its own box is
  `[x]`; a parent whose children are all dropped or proposed counts as an open leaf (one step, to do until its own box or task says otherwise).
- Ids: a new node gets `n<k>` above the largest safe numeric part of the existing ids and never one already in use (a huge hand-written id
  cannot collide). When two nodes share an id the first wins for commands, `plan show` and `crew doctor` warn, and the next write renames the later ones.
- Growth: each node carries `origin` and `added`; the plan page groups additions by day and origin. Plan review (§17.1:
  reviewer/refuter propose `[?]` nodes the orchestrator accepts) and follow-ups from code review use the same fields, as does
  `crew plan add --origin ... --proposed`.
- Follow-ups: `crew review followup` turns a finding of a finalized code review round into a `[?]` node (`origin:review action:add
  from_task finding review_round done_when for`). It never adds one by itself, and it is never accepted by itself: a plan exists to keep the
  work on its goal, so growth stays a visible decision and an accepted one counts towards `plan.large_growth`. The node goes next to the task's step, under the
  same parent: a child would replace the step in the percentage and hide the task's finished work. It has no `round` because that
  field names a plan review round. The node stays in the file when rejected (`[~]`), and that is what stops the same finding from coming
  back. The CLI cannot judge whether work serves the goal, so it prints the goal and `--plan SLUG` is the way out.
- Events: `plan.created`, `plan.node_added` (origin, proposed, task), `plan.node_changed` (`linked`, `open`, `done`,
  `dropped`, `accept`, `removed`); ids only, never node text.
- Board: `GET /api/project/<id>/plans` and `GET /api/project/<id>/plan/<slug>`, the Plans card and the plan page (§14).

### 17.1 Plan review

Before dispatch a reviewer criticises the plan and a refuter tries to disprove each criticism (the three stages of §9, same
helpers: `applyRefutations`, prompts built the same way). Survivors become proposed nodes (`[?]`) under the step they are
about; only accepted nodes count. Code: `lib/core/plan-review.js`, CLI in `lib/commands/plan.js`.

- Files: `<data>/projects/<id>/runtime/plan-review/<slug>/` holds `state.json` (rounds with counters, rejected keys, accepted log,
  notes) and per round `N.packet.md`, `N.raw.json`, `N.filtered.json` (dropped, with reason), `N.kept.json`, `N.refutations.json`,
  `N.json` (survivors with claim, evidence, verdict, node id). Long reasoning stays there, not in the Markdown.
- Finding: `{ node|null, kind, claim, evidence[], proposal: { action, text, done_when } }`. Kinds: off-goal (a step that does not serve the goal), missing-step, wrong-order, too-big,
  risk, vague-done, redundant (also the order proposals are kept in under the cap). Actions: add, split (one finding per piece; the big
  step stays until dropped), change, drop. A missing `done_when` is rejected at filter time (`no-done-when`).
- Filter reasons: `invalid`, `no-done-when`, `unknown-node` (also dropped and proposed steps), `out-of-scope` (`--node`),
  `repeat-rejected` (normalised text + same step, from rejected `[~]` nodes and the ledger, which keeps the reviewer's wording and the
  refuter's), `duplicate`. Finalize applies `plan.max_proposals_per_round` (reason `cap`) and `plan.max_rounds` is checked by `run`.
- Node metadata (comment keys): `round`, `kind`, `action`, `done_when` (space and % escaped as %20, %25), `for` (the step it is about),
  `uncertain:1`; a rejected node gets `rejected:<date>`. A proposal is a child of its step, or its sibling when the step is already at
  depth 3; a finding with `node: null` is a top-level node.
- Decide: `accept` (add/split: open; change: reword the target and remove the proposal; drop: drop the target and remove the proposal;
  the target must still exist) and `reject` (dropped, note stored in `state.json`). Growth: accepted proposals since the last
  `large_task` `gate.answered yes` above `plan.large_growth` print the gate hint and add one need per crossing; nothing blocks.
- Events: `plan.review_started`, `plan.review_finalized` (counts), `plan.proposal_accepted`, `plan.proposal_rejected`; ids only.
- Board: `GET /api/project/<id>/plan/<slug>` adds `proposals`, `rounds`, `show_text`; claim, evidence and refuter text follow
  `board.show_text`. The page lists pending proposals first with copyable commands (read-only), shows the round history under Show growth.

## 18. Release record

`crew release record <version>` writes one Markdown file per version (`<release.record_dir>/<version>.md`, default `.crew/releases`, or `--dir`)
that is meant to be committed with the release. Code: `lib/commands/release.js`, `lib/features/release.js`.
- Reads only: project data under `~/.crewgate/projects/<id>` (tasks, findings, events), `.crew/plans` and read-only git. It writes the one
  record file and never commits, tags or pushes.
- Range: `--to` defaults to tag `v<version>`, else `HEAD`; `--from` to the nearest earlier tag (`git describe`, the version's own tag excluded).
  An unknown ref is an error and nothing is written. A `merged` task is included when its `task.merged` note names a commit in
  `from..to` or its branch tip is in it. A merged task that fits no range but whose merge event falls between the two commit dates is
  listed as "not placed", never guessed in.
- Per task: returns, every review round with its counts (raw, kept, upheld, refuted, uncertain, dismissed), each surviving finding on one
  line, dismissals, follow-ups (plan nodes with `from_task`) and `--skip-refuter` reasons. A task with a `task.returned` event later than its
  last finalized round (the `task.reviewed` event of that round, else the file time) is marked NOT RE-REVIEWED; one without a finalized
  round is marked NO REVIEW.
- Plans linked to included tasks (or named by `--plan`): title, goal, completion, clarified answers (`(assumed)` flagged). Gates: those of
  included tasks (any time), plus gates with no task inside the window between the two commit dates; answers without a user turn,
  unanswered gates and `gate.missing` are marked.
- The conclusion sits between `<!-- crew:conclusion -->` and `<!-- /crew:conclusion -->`: from `--conclusion-file`, else kept from the
  existing file, else a TODO plus a stderr warning. A file without the markers is refused without `--force`.
- The whole text is redacted (`core/redact.js`), the home directory is written `~` and paths inside the repo are relative. Session ids,
  worker reports, packets and briefs are never read. No timestamp is written: the same inputs give the same bytes.
