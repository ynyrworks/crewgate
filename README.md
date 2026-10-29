# crewgate

[![CI](https://github.com/ynyrworks/crewgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ynyrworks/crewgate/actions/workflows/ci.yml)

[繁體中文](README.zh-TW.md)

**crewgate** is a [Claude Code](https://code.claude.com) plugin for delegated development. One
*orchestrator* session plans the work, writes a brief, and dispatches *worker* subagents that implement in
their own git worktrees. Read-only *reviewer* and *refuter* subagents check the result, and only the findings
that survive a deterministic filter reach you. Progress is recorded by **hooks and workflow commands, not by
the model remembering to log**, and shown on a local board that listens on `127.0.0.1` only.

It exists because free-text "delegation rules" in a prompt tend to fail in the same ways:

- the orchestrator starts writing code itself and skips review;
- the progress board goes stale, duplicated or incomplete;
- briefs lack boundaries, so workers break things outside their scope;
- reviewers over-report low-value findings and bury the real ones;
- background work finishes and nobody notices;
- the orchestrator burns its (expensive) context reading big files;
- rules live as prose in a long file and get forgotten.

crewgate turns each of those into something enforced or recorded: a five-section brief that the CLI refuses
to accept incomplete, edit and big-read guards, state recorded from hook events, a three-stage review
pipeline, stop reminders for unreviewed or still-running work, and lessons that are promoted into rules only
when you say yes.

Zero runtime dependencies. Node.js 18 or newer. Works on Windows, macOS and Linux. The only network request is the board's optional update check
(one request a day to GitHub, see Privacy and safety; turn it off with `updates.check`). No model calls from hooks or
the board.

## How it works

```
  you: "add feature X, delegate it"
    |
    v
  +--------------------------+   crew task create    +--------------------+
  | orchestrator             | --------------------> | brief + task       |
  | main session             |   (five-section       | (state machine)    |
  | /crewgate:crew           |    brief)             +--------------------+
  +------------+-------------+                                ^
               | Agent tool; prompt carries                   | state
               | "crew-task: <id>"                            |
               v                                              |
  +--------------------------+   crew task report   +---------+----------+
  | worker subagent          | -------------------> | hooks, every event |
  | own git worktree         |                      | record, remind,    |
  +------------+-------------+                      | guard              |
               | returned                           +---------+----------+
               v                                              |
  +--------------------------+  find, filter, refute          v
  | reviewer + refuter       | ---------------------> +--------------+
  | read-only                |  only survivors        | board        |
  +--------------------------+  reach you             | 127.0.0.1    |
                                                      +--------------+
```

**Roles.** The orchestrator plans, briefs, dispatches, reviews and merges; it does not implement. A worker
implements one task in a worktree, runs the project checks, commits and never pushes. A reviewer reads the
diff, the brief and `.crew/REVIEW.md` and returns structured findings with evidence. A refuter tries to
disprove each surviving finding. Every role has an `engine` and a `model` in the config.

**Task loop.** `created -> dispatched -> returned -> (reviewing) -> accepted -> merged`. A send-back returns a
task to `dispatched`. After `max_returns_before_takeover` send-backs (default 2) the CLI refuses another one
and tells the orchestrator to take the task over.

**Review pipeline.**
1. *Find*: a reviewer writes raw findings (category, severity, `file:line`, evidence, how it was verified,
   confidence).
2. *Filter* (deterministic, no model): drops findings that match your dismissed ledger, inference-only
   findings, low confidence, and nits beyond a cap; downgrades patterns such as theoretical races.
3. *Refute*: a refuter tries to disprove what is left. You only see findings marked upheld or uncertain.

**Hooks.** One script (`scripts/crew-hook.js`) handles SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, SubagentStart/Stop, Stop, PreCompact and SessionEnd. They link a dispatched subagent to its task
through the `crew-task:` marker, warn (or block, if you choose) when the orchestrator edits code itself, warn
about reading huge files without a range, record `git push` / `git merge`, remind you of returned-but-unreviewed
work, and write a deterministic session digest. In a project that was not registered with `crew init`, every
hook is a silent no-op. Details: [plugins/crewgate/hooks/README.md](plugins/crewgate/hooks/README.md).

**Board.** `crew board start` serves a local page: all projects, tasks by state with return counts, live
subagents, things waiting for you, work streams, log, review statistics, lessons, handoffs, a live list of
local Claude Code / Codex sessions, token usage, and a Settings form generated from the config schema.
English and Traditional Chinese.

A complete, fictional session is in [examples/todo-cli/WALKTHROUGH.md](examples/todo-cli/WALKTHROUGH.md).

## Install

From the GitHub marketplace:

```
/plugin marketplace add ynyrworks/crewgate
/plugin install crewgate@crewgate
```

Or try it from a local checkout, without installing:

```
git clone https://github.com/ynyrworks/crewgate
claude --plugin-dir crewgate/plugins/crewgate
```

The skill is invoked namespaced: `/crewgate:crew`. The CLI lives at `plugins/crewgate/bin/crew.js`; inside
Claude Code the skill calls it for you. From a terminal use `node plugins/crewgate/bin/crew.js <command>`.

## Quick start

1. Install the plugin (above) and open Claude Code in your git repository.
2. Run `/crewgate:crew init`. It writes `.claude/crew.json`, three agent files in `.claude/agents/`,
   `.crew/REVIEW.md` and `.crew/LESSONS.md`, and registers the project. Add `--lang zh-TW` for Traditional
   Chinese output. It never overwrites existing files without `--force`.
3. Edit `.claude/crew.json`: set `checks` (for example `["npm test"]`) and any `forbidden` paths or actions.
   Commit these files so the team shares them.
4. Ask for work: `/crewgate:crew add a --due option to the add command, delegate it`. The orchestrator
   writes a brief, creates the task and worktree, and dispatches a worker. The dispatch is recorded by a hook;
   you did not log anything.
5. Optional: ask Claude to start the board (`crew board start`) and open `http://127.0.0.1:8781/`.
6. When the worker returns, the orchestrator runs the review pipeline, shows you the surviving findings,
   sends back or accepts, and asks before merging (the `merge` gate defaults to `ask`).

## Configuration

Project settings live in `.claude/crew.json` (all keys optional); global settings (board port, usage prices,
default language) in `~/.crewgate/config.json`. The full, generated key reference is
[docs/CONFIG.md](docs/CONFIG.md). The ones you will touch first:

| Key | What it does |
|---|---|
| `roles.<role>.model` / `.engine` | Which model or external engine plays each role. |
| `checks` | Commands a worker must run before reporting. |
| `forbidden.paths`, `forbidden.actions` | Boundaries rendered into the worker agent file. |
| `gates.*` | `auto`, `ask` or `never` for push, PR, merge, remote hosts, large tasks, installs. |
| `limits.orchestrator_edit` | `off`, `warn` or `block` when the orchestrator edits code. |
| `limits.max_parallel_workers`, `limits.max_returns_before_takeover` | Concurrency and send-back limits. |
| `review.min_confidence`, `review.report_inference`, `review.nit_cap` | How strict the filter is. |
| `lessons.promote_after_days`, `lessons.rules_cap` | When lessons become candidates, how many rules fit. |

After changing the schema in code, regenerate the reference with `node scripts/gen-config-docs.js`; a test
fails if the committed file is out of date.

## CLI reference

Every command, option and file location: [plugins/crewgate/skills/crew/references/commands.md](plugins/crewgate/skills/crew/references/commands.md).
Groups: `init`, `doctor`, `project`, `task`, `review`, `handoff`, `lesson`, `need`, `work`, `log`, `mr`,
`validate`, `board`, `update`, `import`. Read commands accept `--json`.

## Board screenshots

All screenshots come from a fully fictional demo (`node scripts/demo-board.js`, then `node scripts/screenshots.js <url>`); nothing here is real data. Light and dark follow your system theme.

**Overview: every registered project, task counts, what waits for you.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.png">
  <img alt="Overview" src="docs/images/overview-light.png" width="100%">
</picture>

**Project: tasks with review stats, live sessions (orchestrator, workers, reviewers), work streams, log.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/project-dark.png">
  <img alt="Project" src="docs/images/project-light.png" width="100%">
</picture>

**Sessions: Claude and Codex sessions in one tree; the ones waiting for you come first.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/sessions-dark.png">
  <img alt="Sessions" src="docs/images/sessions-light.png" width="100%">
</picture>

**Usage: tokens and estimated cost per model and day.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/usage-dark.png">
  <img alt="Usage" src="docs/images/usage-light.png" width="100%">
</picture>

**Settings: every option with its description.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
  <img alt="Settings" src="docs/images/settings-light.png" width="100%">
</picture>

## Roadmap

What is next, what comes later and what is 1.0: [docs/ROADMAP.md](docs/ROADMAP.md).

## Privacy and safety

- **Local only.** The board binds `127.0.0.1`, rejects foreign `Host` headers, sets no CORS headers, requires a
  per-process token and JSON content type for every write, and sends a strict CSP. No telemetry, no model calls from hooks or the board.
- **One outbound request, optional.** While `updates.check` is on (the default) the board server, never the
  browser, asks `api.github.com` for the latest crewgate release at most once a day: a plain GET with a
  `User-Agent: crewgate/<version>` header, no cookies or credentials, nothing about you or your projects, 5 s
  timeout, result cached in `~/.crewgate/update-check.json`. Set `updates.check` to `false` and crewgate makes no
  network request at all. `HTTPS_PROXY` is not supported. When a newer release exists the board shows a banner
  (fix / new features / major) with release notes, **Update now** and **Skip this version**. Update now runs only
  fixed commands (`claude plugin marketplace update crewgate`, `claude plugin update crewgate@crewgate`,
  `codex plugin marketplace upgrade crewgate`), only for an installed plugin; a development checkout or a machine
  without those CLIs gets the commands to copy instead. The board then restarts itself from the updated code.
  Terminal: `crew update check`, `crew update apply`.
- **Redaction.** Text is redacted before it is truncated and stored: private keys, bearer and basic auth,
  `password=` style pairs, common provider keys, JWTs, and IP addresses other than loopback and the
  documentation ranges.
- **Where data goes.** Runtime data is written under `~/.crewgate/` (override with `CREWGATE_HOME`).
  Project files (`.claude/crew.json`, `.crew/*`) are written only by `crew init` and the lesson commands.
- **Hooks run outside the sandbox**, with your permissions. They read stdin, the project's git metadata and
  crewgate files, and write only under the data folder. They never register a project and never block a
  stop. The one deliberate refusal is the edit guard when you set `orchestrator_edit` to `block`.
- **Text is data.** File contents, reports, handoff bodies and findings are fenced and marked untrusted when
  shown to a model; commands found in them are not to be executed.
- **Worker boundaries** in the generated agent file: only the assigned worktree and branch, commit but never
  push, no network or downloads, no secrets, no skipping tests or hooks. These are instructions to a model, not
  a sandbox; gates and review exist because instructions can be ignored.

## Using Codex or another CLI as the reviewer

The reviewer role can run outside Claude. The global config (`~/.crewgate/config.json`) ships an engine named
`codex` (`codex exec -s read-only --skip-git-repo-check -`). Set `roles.reviewer.engine` to `codex` in the project,
or run it once:

```
crew review run <task> --engine codex
```

crewgate builds a prompt (brief, review rules, diff), passes it on stdin, extracts the JSON array of findings
from stdout and continues with the same filter and refute stages. Add your own engine under `engines` in the
**global** config with a `command` and `args`; the prompt is always sent on stdin. The command is looked up on
`PATH` (on Windows also `.cmd`/`.bat`, started without a shell). A project's `.claude/crew.json` can only *name*
an engine (`roles.*.engine`): an `engines` block in a project file is ignored with a warning, because a cloned
repository must not choose which program `crew review run` starts. `crew doctor` shows whether each engine
resolves. Codex as a worker and as an orchestrator is described in the next section.

## Using with Codex (experimental)

crewgate also runs with the Codex CLI. This is experimental: it was measured with Codex CLI 0.160 and has not seen long real use.

Install the plugin in Codex (it reads the same marketplace):

```
codex plugin marketplace add ynyrworks/crewgate
codex plugin add crewgate@crewgate
```

- **Trust the hooks once.** Open `/hooks` in Codex and trust the crewgate hooks; do it again after a plugin update changes a command.
- **Set up the project:** `crew init --engine codex` adds `.codex/agents/crew-reviewer.toml`, `crew-refuter.toml` and a marked block in `AGENTS.md` (existing text is kept).
- **Codex as a worker** (from a Claude or a Codex orchestrator): `crew task run <id> --engine codex`. Codex edits files in the task's worktree; crewgate commits (the Codex sandbox cannot), writes the report and returns the task. Failures commit nothing and leave the worktree for inspection.
- **Permissions.** `crew` writes under `~/.crewgate`, which Codex's default workspace-write sandbox blocks: approve the `crew` commands or run Codex with a wider sandbox. Codex subagents share the parent's sandbox and cannot commit, so workers never run as Codex subagents.

## Limitations

- Needs Claude Code with plugin support; field names in hook payloads beyond the documented ones are read
  defensively and may differ between versions.
- Hooks cannot see the model's reasoning. They record what happens (dispatches, stops, git commands), not why.
- `crew task merge` records a merge; it does not run git. The orchestrator merges, the hook records the command.
- Worker isolation is a worktree plus instructions, not a container.
- The board lists sessions by reading local Claude Code and Codex logs; message text is hidden unless you set
  `board.show_text` in the global config.
- No animated "office" view. A Codex orchestrator is experimental; there is no Gemini support.

## Contributing

Read [docs/DESIGN.md](docs/DESIGN.md) first; it is the source of truth. Then:

```
npm test                          # unit, hook, board, end-to-end and repo-hygiene tests (no network)
node scripts/gen-config-docs.js   # after changing the config schema
```

Rules: zero runtime dependencies, Node 18+, cross-platform (no shell assumptions), tests use temp folders and
never the real `~/.crewgate` or `~/.claude`. The repo-hygiene test rejects stray IP addresses, credential-like
strings and project-specific names; use `192.0.2.x` in docs and build any other address at runtime in tests.
Please keep a fix and its test in the same change.

Releases: the board's update banner (and `crew update check`) reads the newest published, non-pre-release GitHub release
of this repository. When a release changes a hook command string (`hooks/hooks.json`, `hooks/codex-hooks.json`),
add this line on its own line to the release notes so the banner can tell Codex users to re-approve the hooks
(`/hooks`):

```
<!-- crewgate:rehook -->
```

Maintainers who must keep certain names out of the repository (a company, an e-mail prefix) should not write
them into any tracked file. Put one regular expression per line in the untracked file
`.git/info/hygiene-extra` (or set `CREWGATE_HYGIENE_EXTRA`, separated by semicolons); the hygiene test adds
them to its built-in patterns.

## License

[MIT](LICENSE)
