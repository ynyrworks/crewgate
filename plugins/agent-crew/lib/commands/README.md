# lib/commands — one file per CLI command group

`bin/crew.js` calls `require('../lib/core/cli').main(argv)`. For `crew <group> ...` it loads
`lib/commands/<group>.js` on demand, so adding a group never touches the dispatcher. Files
starting with `_` and non-`.js` files are ignored. A module that throws on load only hides itself.

## Module contract

```js
module.exports = {
  name: 'task',                                           // group name (= file name)
  summary: { en: '...', 'zh-TW': '...' },                 // one line, shown in `crew --help`
  usage:   { en: '...', 'zh-TW': '...' },                 // optional, shown by `crew <group> --help`
  requiresAction: true,                                   // optional; false lets `crew <group>` run with no action
  async run(argv, ctx) { return 0; },                     // may be sync; return exit code (default 0)
};
```

`argv` is what follows the group name with the global options (`--project`, `--json`, `--lang`,
`--help`/`-h`) already removed. Parse it with `lib/core/args.js` (`parse(argv, spec)`).
Throw instead of printing errors: `UsageError(key, vars)` -> exit 2, `CrewError(key, vars)` -> exit 1;
the dispatcher prints them localized. Put your strings in `lib/i18n/<group>.en.json` and
`<group>.zh-TW.json` (key prefix = group name) and keep both files in sync.

## ctx

| Member | Meaning |
|---|---|
| `ctx.cwd` | process cwd |
| `ctx.json` | `--json` given |
| `ctx.lang` / `ctx.langOption` | active language (`--lang`, else project config, else global config, else `en`) / raw `--lang` value (for `crew init --lang`) |
| `ctx.t(key, vars)` | translate in the active language |
| `ctx.out(line)`, `ctx.err(line)` | write a line to stdout / stderr |
| `ctx.emit(data, lines)` | `--json`: print `data` as JSON; otherwise print `lines` (array or string) |
| `ctx.project()` | registered project `{ id, path, name, added }` for `--project` or the cwd, else `null` (throws `project.notFound` for a bad `--project`) |
| `ctx.requireProject()` | same, but throws `CrewError project.none` |
| `ctx.config()` | `config.load(project.path)` result (defaults when there is no project) |

Rules
- Every read command supports `--json` through `ctx.emit`; JSON output is the same data the core returns.
- Never write outside `~/.agent-crew/` except where the command's purpose says so (`init`, `lesson promote`, ...).
- Exit codes: 0 ok, 1 runtime error, 2 usage error.

## Existing groups (core step)

| Group | Actions |
|---|---|
| `project` | `add [path] [--name]`, `list`, `rm <id\|path\|name>` |
| `need` | `add "text"`, `done N`, `list [--all]` |
| `work` | `set STREAM "title" todo\|doing\|done\|waiting\|parked ["note"] [--need N]`, `rm STREAM "title"`, `list` |
| `log` | `add WHO "text"`, `list [--n 20]` |
| `mr` | `set N "title" [--ci passed\|failed\|running] [--merged yes\|no]`, `list` |
| `validate` | `set ID YYYY-MM-DD "host" "result"`, `list` |
| `import` | `agent-board <data dir> --from-project <id> [--force]` |

## board

`crew board start [--port N] [--no-open]` launches `crew board serve` detached and waits until
`/api/health` answers; `stop`, `status` (exit 1 when not running) and `serve` (foreground) complete the
group. State lives in `<home>/board.json` (`{ pid, port, started }`), the server log in `<home>/board.log`.
Default port: global config `port` (or `board.port`), else 8781; when it is busy the next 20 ports are
tried. An explicit `--port` never searches. `stop` only signals a process whose `/api/health` answers as
agent-crew, so a recycled pid is never killed. Test hooks: `AGENT_CREW_CLAUDE_ROOT` and
`AGENT_CREW_CODEX_ROOT` move the session-log roots the board reads.

The server (`board/server.js`) listens on 127.0.0.1 only and enforces the rules of DESIGN section 10.
Endpoints (all JSON; reads are GET, every write is POST with `Content-Type: application/json` and the
`X-Crew-Token` header taken from the page's `<meta name="crew-token">`):

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | `{ ok: true, name: "agent-crew", version }` (used by `crew doctor`) |
| `GET /api/meta`, `/api/schema` | defaults, and `config.SCHEMA` / `GLOBAL_SCHEMA` for the Settings form |
| `GET /api/overview` | every registered project: tasks by state, open needs, live subagents, last activity |
| `GET /api/project/<id>` | tasks (history, returns, review stats), sessions, store data, handoffs, lessons, events |
| `GET /api/sessions`, `/api/usage[?days=N]` | live session list (no message text unless `show_text` is true); token/cost report |
| `GET\|POST /api/config`, `/api/project/<id>/config` | read / save settings; body `{ config: { ...changed fields } }`; invalid input is a 400 with `errors: [{ path, message }]` |
| `POST /api/project/<id>/need`, `need/done`, `work`, `work/rm`, `log` | board store writes (events carry `src: "board"`) |

Global config key `board.show_text` (boolean, default false; shows a short redacted snippet of the last
assistant message in the Sessions list). Settings saves record `config.changed` with `src: "board"`.

## Workflow groups (workflow step)

Logic lives in `lib/features/` (`common`, `init`, `review`, `handoff`, `lessons`); the command
files only parse arguments and print. Strings: `lib/i18n/workflow.*.json` (prefix `wf.`).

| Group | Actions |
|---|---|
| `init` | `[--lang en\|zh-TW] [--force]` — config, agent copies, `.crew/` files, registration; `--force` backs up (`*.bak-<ts>`) and keeps config values; the dismissed ledger is never replaced |
| `task` | `create --title --brief-file [--role --branch --worktree --allow --deny]`, `list [--state]`, `show <id>`, `report <id> --report-file [--packet-file]`, `send-back <id> --note`, `accept`, `merge`, `cancel` |
| `review` | `run <task> [--engine] [--round]`, `submit <task> [--kind findings\|refutations] [--file]` (stdin by default), `filter`, `finalize [--refutations-file]`, `show`, `dismiss <task> <finding> --scope once\|always --reason` |
| `handoff` | `create --title --body-file [--task]`, `list [--all]`, `show <id>`, `accept <id>` (atomic claim, body fenced as untrusted), `cancel <id>` |
| `lesson` | `add --key --text [--kind --date]`, `list`, `suggest`, `promote <key> --rule`, `retire <key>` |
| `doctor` | node, config (field paths), registration, project files, hooks file, board `GET /api/health` (connection refused = not running, not an error) |

Review files per round under `tasks/<id>/findings/`: `N.raw.json` (reviewer), `N.filtered.json`
(dropped + reason), `N.kept.json` (filter survivors), `N.refutations.json` (refuter), `N.json` (final).
