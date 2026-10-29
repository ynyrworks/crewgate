# lib/core — shared core

CommonJS, zero dependencies, Node >= 18. Everything here is synchronous. Other modules
(hooks, board, commands) build on these interfaces; keep them stable.

Conventions
- `projectId` is `p` + 10 hex (see `project.projectId`). Task ids are `t-YYYYMMDD-xxxx`.
- Failures that a user can cause throw `CrewError(key, vars)` (`err.key`, `err.vars`,
  `err.message` in English). The CLI prints `t(lang, err.key, err.vars)`. `UsageError`
  is a `CrewError` (exit code 2).
- Hooks must never throw: wrap calls in `try/catch` and fall back to `{}`.
- Tests: always set `CREWGATE_HOME` to a temp dir (see `test/helpers.js`).

## errors.js
- `CrewError(key, vars)` — message from i18n key (en). `UsageError(key, vars)` extends it.

## i18n.js
- `t(lang, key, vars)` — `{name}` placeholders; fallback en, then the key itself.
- `normalizeLang(x)` -> `'en' | 'zh-TW'`. `reload()` clears the cache. `LANGS`.
- Tables: every `lib/i18n/<module>.en.json` / `<module>.zh-TW.json` is merged. Add your own
  pair (e.g. `task.en.json`); key prefixes avoid collisions (`core.*` files use `cli.`,
  `args.`, `paths.`, `json.`, `project.`, `config.`, `task.`, `store.`, `need.`, `work.`,
  `log.`, `mr.`, `validate.`, `import.`).

## paths.js
- `home()` (`CREWGATE_HOME` or `~/.crewgate`), `configFile()`, `projectsFile()`.
- `projectDir(id)`, `dataFile(id, name)` (`work|needs|log|mrs|validation`), `eventsFile(id)`,
  `tasksDir(id)`, `taskDir(id, taskId)`, `handoffDir(id, 'open'|'accepted'|'cancelled')`,
  `handoffFile(id, state, handoffId)`, `runtimeDir(id)` (hook dispatch map), `sessionsDir()` (hook session counters), `projectConfigFile(root)` (`<root>/.claude/crew.json`).
- All ids are validated (`ID_RE`, `TASK_ID_RE`, `SAFE_ID_RE`); bad ones throw.

## json.js
- `readJson(file, fallback)` -> `{ status: 'ok'|'missing'|'corrupt', data }` — pure, never modifies files.
  `fallback` fixes the expected top-level type (object vs array); `data` is a private copy.
- `read(file, fallback)` -> `{ data, status, warning }` — a corrupt file is moved to
  `<name>.corrupt-<ts>` and `warning` (English) says so.
- `save(file, obj)`, `saveRaw(file, text|buffer)` — atomic (temp file + rename in the same dir).
- `withLock(file, fn)` — cross-process lock `<file>.lock`; waits `CREWGATE_LOCK_WAIT_MS`
  (default 10 s), stale locks (owner dead, > 30 s) are taken over.
- `update(file, fallback, fn, warn?)` — locked read-modify-write; `fn(data)` mutates and
  returns the result; nothing is written if it throws; corrupt files are moved aside first.
- `stamp()`, `backupCorrupt(file)`.

## project.js
- `normalizePath(p, platform?)` — Windows: lower-case, `/` separators; realpath for the running platform.
- `projectId(rootPath, platform?)`.
- `inspect(cwd)` -> `{ root, linked, git }` — ONE `git` spawn (~100 ms on Windows). `root` is the main
  worktree (`dirname(git-common-dir)`), else the nearest ancestor with `.claude/crew.json`, else `null`.
  `linked` is true inside a linked worktree.
- `detectRoot(cwd)`, `isLinkedWorktree(cwd)`, `nearestCrewJsonRoot(dir)`.
- Registry (`projects.json`): `list()` -> `[{ id, path, name, added }]`; `find(spec)` (id | path | name,
  `null` if none, throws `project.ambiguous`); `resolve(spec)` (throws `project.notFound`);
  `findByCwd(cwd)`; `add(dir, { name })` -> `{ project, created }` (registers the detected root,
  creates the data folder); `remove(spec)` -> `{ project, dir }` (data stays).

## context.js
- `resolve(payload?, cwd?)` -> `{ cwd, isSubagent, isMainWorktree, projectRoot, projectId, registered, project }`.
  `payload.cwd` wins; `isSubagent` means `payload.agent_id` is set. Never throws. One git spawn.
  Hooks: `if (!ctx.registered) -> print {} and exit 0`.

## config.js
- `DEFAULTS`, `GLOBAL_DEFAULTS` (frozen reference objects; `load` returns copies).
- `load(root)` -> `{ config, errors, file, exists }` — never throws. Unknown keys are kept; invalid fields
  fall back to their default and are listed in `errors` (`{ file, path, message, key, vars }`).
- `validate(obj)` -> `[{ path, message, key, vars }]`.
- `save(root, obj, { src })` — validates (throws `config.invalid`, `err.errors`), merges over the existing file
  (unknown keys preserved; keys cannot be deleted), writes atomically, records `config.changed`
  (`src` defaults to `cli`; the board passes `board`) when the project is registered.
- `loadGlobal()`, `validateGlobal(obj)`, `saveGlobal(obj, { src })` — same for `~/.crewgate/config.json`;
  the change is recorded as `config.changed` (`scope: "global"`) in every registered project's log.
- `SCHEMA`, `GLOBAL_SCHEMA` — `[{ path, type, enum?, min?, max?, itemType?, default, description: { en, 'zh-TW' } }]`;
  `*` in a path matches any key of a map (e.g. `roles.*.engine`). The board renders its Settings form from these.

## events.js
- `append(projectId, { type, src, session, task, agent, data, key, tool_use_id })` -> `{ written, id, event }`.
  `src` is `hook|cli|board`. Strings in `data` are redacted then truncated to 2,000 chars; the line stays
  under 4 KiB; an event whose id is among the last 500 lines is skipped (`written: false`).
  The id hashes `type|session|tool_use_id-or-agent|task|key`; `key` defaults to the stable JSON of `data`,
  so pass a unique `key` for events that may legitimately repeat with identical data.
- `read(projectId, { since, types, limit })` — `types`: string or array, exact or `prefix.*`;
  `limit` keeps the newest N. Malformed lines are skipped.
- Types used by the core in addition to DESIGN section 6: `work.set`, `work.removed`, `log.added`,
  `mr.set`, `validation.set`.

## redact.js
- `redact(text)`, `truncate(text, n)`, `clean(text, n)` (= redact then truncate). Also `MASK`, `MASK_IP`.

## tasks.js
- `STATES`, `TRANSITIONS`, `BRIEF_SECTIONS`, `REPORT_SECTIONS`.
- `createTask(projectId, { title, brief, role?, branch?, worktree?, scope?: { allow, deny }, acceptance?, repro? }, { src?, session? })`
  -> task. The brief must have the five sections (en or zh-TW headings, non-empty) or
  `CrewError task.briefInvalid` (`err.missing`, `err.empty`). A `crew-task: <id>` first line is written to `brief.md`.
- `load(projectId, taskId)`, `list(projectId, { state? })`, `readBrief`, `readReport`, `findMarker(text)` (task id or null).
- `transition(projectId, taskId, to, { note, src, session, agent, maxReturns, fields: { branch, worktree }, data })` -> task.
  `data` is merged into the event data (it cannot override `from|to|returns|note`).
  Allowed: created->dispatched; dispatched->returned; returned->reviewing|accepted|dispatched;
  reviewing->accepted|dispatched|returned; accepted->merged; any non-final->cancelled.
  Same-state is a silent no-op. `returned|reviewing -> dispatched` is a send-back (`returns++`, event
  `task.sent_back`); when `returns >= maxReturns` (default 2) it throws `task.takeover`.
  Events: `task.dispatched|returned|reviewed|sent_back|accepted|merged|cancelled`.
- `sendBack(projectId, taskId, opts)` — alias for `transition(..., 'dispatched')`.
- `validateBrief(text)`, `validateReport(text, { maxTokens })` -> `{ ok, tokens, errors: [{ code, section }] }`,
  `estimateTokens(text)` (chars / 4).
- `recordReport(projectId, taskId, { report, packet }, { maxTokens, ...transition opts })` -> `{ task, tokens }` —
  validates, stores redacted `report.md`/`packet.md`, moves dispatched -> returned.

## store.js (board data)
All take the project id first, return plain data and append an event. Last argument `opts` = `{ src?, session? }`.
- `needAdd(id, text)`, `needDone(id, n)`, `needList(id, { all? })`
- `workSet(id, { stream, title, state, note?, need? })`, `workRm(id, stream, title)`, `workList(id)`;
  states `todo|doing|done|waiting|parked` (`waiting` = waiting for the user)
- `logAdd(id, who, text)`, `logList(id, n = 20)` (newest first, file keeps 500)
- `mrSet(id, iid, title, { ci?: 'passed'|'failed'|'running', merged?: 'yes'|'no'|boolean })`, `mrList(id)`
- `validateSet(id, { templateId, date: 'YYYY-MM-DD', host, result })`, `validateList(id)`
Free text is redacted (not rejected).

## importer.js
- `importAgentBoard(dataDir, fromProjectId, targetProjectId, { force })` — reads
  `<dataDir>/projects/<id>/{work,log,mrs,validation}.json`, converts states/timestamps, writes
  `needs/work/log/mrs/validation.json` of the target; existing files need `force` and are renamed
  `<name>.before-import-<ts>`. The source is never modified.

## args.js
- `parse(argv, spec)` — see the header comment; throws `UsageError`.

## cli.js
- `main(argv, io?)` -> exit code; `extractGlobals`, `listGroups()`, `loadGroup(name)`, `createContext(globals, io)`.
