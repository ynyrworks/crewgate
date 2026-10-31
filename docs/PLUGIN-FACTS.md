# Claude Code plugin facts (verified against official docs, 2026-10)

Sources: https://code.claude.com/docs/en/plugins-reference.md ·
https://code.claude.com/docs/en/plugins/create-marketplace.md ·
https://code.claude.com/docs/en/hooks.md · https://code.claude.com/docs/en/sub-agents.md ·
https://code.claude.com/docs/en/skills.md

Items marked (uncertain) were not confirmed in the docs; code must tolerate either answer.

## Layout
- `.claude-plugin/marketplace.json` at repo root: required `name`, `owner`, `plugins[]`;
  each entry requires `name` (must equal plugin.json `name`) and `source`
  (`"./plugins/crewgate"`; must start with `./`, no `..`).
- Plugin root holds `.claude-plugin/plugin.json` (only `name` required; also set
  `version`, `description`, `author{name}`, `license`, `repository`, `keywords`),
  `skills/<name>/SKILL.md`, `agents/*.md`, `hooks/hooks.json`, `bin/`, `scripts/`.
  Never put skills/agents/hooks inside `.claude-plugin/`.
- Validate with `claude plugin validate <dir> [--strict]`.
- Install: `/plugin marketplace add <owner>/<repo>` then `/plugin install <plugin>@<marketplace-name>` (here: `ynyrworks/crewgate`, `crewgate@crewgate`).

## Hooks (`hooks/hooks.json`)
```json
{ "hooks": { "PreToolUse": [ { "matcher": "Edit|Write", "hooks": [
  { "type": "command", "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/crew-hook.js", "pre-tool-use"], "timeout": 10 } ] } ] } }
```
- Use exec form (`command` + `args`) — avoids shell quoting on Windows.
- Matcher: `""`/`"*"`/omitted = all; `A|B` exact list; other characters = unanchored regex.
- Default timeout 600 s; SessionEnd hooks get only ~1.5 s — keep SessionEnd work tiny.
- Env: `CLAUDE_PLUGIN_ROOT` (changes on update — never write there), `CLAUDE_PLUGIN_DATA`,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_<KEY>`.

## Hook stdin
Common: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
Events from inside a subagent also carry `agent_id`, `agent_type` (absence on the main
thread is (uncertain) — treat "no agent_id" as main thread).
- SessionStart: `source` (startup|resume|clear|compact|fork), `model?`
- UserPromptSubmit: `prompt`
- PreToolUse: `tool_name`, `tool_input`, `tool_use_id`
- PostToolUse: + `tool_response`, `duration_ms?`
- SubagentStart: `agent_id`, `agent_type`
- SubagentStop: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`,
  `last_assistant_message`, `background_tasks`
- Stop: `stop_hook_active`, `last_assistant_message`, `background_tasks`
- SessionEnd: `reason` (clear|resume|logout|prompt_input_exit|other)
- PreCompact: `trigger` (manual|auto)
**Measured (claude -p, plugin loaded with `--plugin-dir`, 2026-10-31):** a PreToolUse payload for a Bash call made by a
real `crewgate:crew-reviewer` subagent held the keys `session_id, transcript_path, cwd, scratchpad_dir, prompt_id,
permission_mode, agent_id, agent_type, effort, hook_event_name, tool_name, tool_input, tool_use_id`, with
`agent_type: "crewgate:crew-reviewer"` (plugin prefix kept; a project copy is plain `crew-reviewer`). So the type is in the
payload and crewgate's map from SubagentStart is only a fallback. In that run the reviewer, asked to run
`git checkout -b x`, declined on its own (its instructions forbid it), so the hook's denial was not seen in a real run; the
`git diff` it ran passed the hook. Denial is tested with payloads of this shape.
SendMessage (not measured, no `claude -p` run was made for it): crewgate reads `tool_input.to` from the tool's documented
input, matches it to an `agent_id` in the dispatch map, and lets any other value pass. Unverified.
The tool that launches subagents is named `Agent` (older builds: `Task`); match both.
Its `tool_input` contains `prompt`, `subagent_type`, `description`, optional `model`,
`run_in_background` (field names beyond `prompt`/`subagent_type` are (uncertain) — read defensively).

## Hook output
- Exit 0 + a single JSON object on stdout (nothing else) is parsed.
- Context to the model: `{"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}}`
  (≤ 10,000 chars).
- Message to the user only: top-level `"systemMessage"`.
- PreToolUse decision: `hookSpecificOutput.permissionDecision` = allow|deny|ask|defer +
  `permissionDecisionReason`.
- Exit 2 = blocking error (stderr is the reason; JSON ignored). Other non-zero = non-blocking error notice.
- Stop / SubagentStop: `decision:"block"` + `reason` continues the turn — crewgate never does this.
  `hookSpecificOutput.additionalContext` is also accepted on these two events, but "the conversation
  continues so Claude can act on it" (same loop protections: `stop_hook_active`, 8-continuation cap).
  A mere reminder therefore uses top-level `systemMessage` (shown to the user, never continues a turn).
  Events that take `hookSpecificOutput.additionalContext`: SessionStart, SubagentStart, UserPromptSubmit,
  UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop,
  PostModelSwitch. Our uses: SessionStart, PreToolUse, PostToolUse (context) and Stop, SubagentStop
  (`systemMessage` only).
  Source: https://code.claude.com/docs/en/hooks.md ("Stop decision control", checked 2026-10-29).

## Agents (`agents/*.md`)
Frontmatter: `name`, `description` (required), `tools`, `disallowedTools`, `model`,
`maxTurns`, `skills`, `effort`, `isolation`, `color`, `background`. Ignored for plugin agents:
`hooks`, `mcpServers`, `permissionMode`, `initialPrompt`. Plugin agents are namespaced
`crewgate:crew-worker`; project copies rendered by `crew init` are plain `crew-worker`.

## Skills
Plugin skills are invoked namespaced: `/crewgate:crew`. Frontmatter: `name`,
`description`, `when_to_use`, `argument-hint`, `allowed-tools`, `disable-model-invocation`.
`$ARGUMENTS` holds the arguments. In the body `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_SKILL_DIR}` are substituted, so the skill calls the CLI as
`node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" ...`.

## Process priority and test load (measured on Windows 11, 32 threads, Node 24, 2026-10)
- Hooks run in exec form, so a hook's parent should be Claude Code itself. The chain seen from this session's Bash tool: `powershell.exe` or `node` -> `bash.exe` (three levels) -> `claude.exe` (the Claude Code process, command line `...\claude-code\<version>\<hash>\claude.exe --output-format stream-json ...`) -> the desktop app's `Claude.exe` -> `explorer.exe`. A hook's own `process.ppid` was not recorded by the worker (`claude -p` needs the network); the orchestrator's real session below confirms the parent is found. The code checks the parent's name (`claude` / `claude.exe`, or `node`/`bun` with `@anthropic-ai/claude-code` in the command line on POSIX) and does nothing otherwise. Subagent commands are started by the same `claude.exe`, so they inherit its class; a resumed session is a new process and SessionStart (source `resume`) lowers it again; Codex's parent is not named claude, so nothing is changed there.
- `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` is 10 here. A below-normal process passes it on: `node` -> `bash -c node` and `node` -> `powershell -Command node` both printed 10.
- Looking up the parent's name with `tasklist /FI "PID eq <pid>" /FO CSV /NH` took about 170 ms.
- `node --test` defaults to `availableParallelism() - 1` files at once: 57 node processes and 97% CPU at peak in 58 s. `--test-concurrency=8`: 38% in 84 s. `scripts/run-tests.js` (concurrency 8, below normal): 22 node processes (3 before the run), peak 43% (average 29%), 96 s, 820 tests passing.
- Does priority help? Not while cores are idle. A normal-priority `setTimeout(10)` probe, sampled for the whole of one default `node --test` of this repo's suite (about 7,000 samples per run), was late by: normal p50 0.4 ms, p95 1.2 ms, max 5.9 ms (peak CPU 79%); below normal p50 0.4 ms, p95 1.1 ms, max 3.2 ms (peak CPU 78%). The machine never saturated, so the probe never waited and this run shows nothing either way.
- One core saturated (orchestrator, 2026-10-31, Windows, 32 threads, one run each): 4 self-ending 5 s loops pinned to one logical core, a normal-priority `setTimeout(10)` probe pinned beside them. Probe maximum delay and samples in 4 s: no load 1.4 ms / 387; loops at normal 378.9 ms / 269; loops at below normal 2.5 ms / 387; loops at idle 1.3 ms / 387. So below normal keeps a normal-priority process responsive when its core is contended.
- Real session (orchestrator, 2026-10-31): a real `claude -p` session with this branch's plugin in a throwaway project ran `node -e` from Bash and it reported priority 10: the hook found the Claude process and children inherit it.
- Job Object per session (worker, 2026-10-31, Windows 11, pwsh 7.6, Node 24): a real `claude -p` process (Claude Code 2.1.308), already running inside Claude's own job, was assigned to a new unnamed job by the holder: assign accepted (Windows nesting), the 60% hard cap (`ControlFlags` 5, class 15, `CpuRate` 6000) read back as 60, the holder exited by itself with a `session.cleanup` event after Claude exited, and its pid file was removed.
- Node's non-detached children die with the Node parent (libuv puts them in a kill-on-close job of its own); `detached: true` children survive. So a Node hook cannot keep a plain child, and test stand-ins for a session must not be Node.
- `spawn('pwsh' | 'powershell', ..., { detached: true })` exits with code 0 after about 100 ms and runs nothing (with or without `windowsHide`); `spawn('cmd.exe', ['/c', 'start', '', '/b', 'pwsh', ...], { detached: true, windowsHide: true })` runs it, outside Node's job, with no window. `$Home` is a read-only PowerShell variable (a parameter of that name fails).
- A process in the job that started after the assign joined it: a plain child, a child's detached grandchild, and a detached "board" with its own child were all listed by `JobObjectBasicProcessIdList`; console hosts (`conhost`) of hidden Start-Process children are listed too.
- Holder cost: `Add-Type` about 520 ms, about 1.0 s CPU in total at start, then +15 ms CPU over 6 s of waiting on the process handle.
- Visible-window keep (worker, 2026-10-31, one run): a real holder with a sleeping stand-in session that started `powershell -WindowStyle Minimized` and a `-WindowStyle Hidden` sleeper. The minimized one had a non-zero `MainWindowHandle`; after the session was killed the cleanup event read found 4, stopped 2, kept 2: the minimized one stayed alive and the hidden one was stopped (their console hosts followed each). Not measured: a Windows Terminal tab (the visible window there belongs to another process).
- CPU cap and test time: `npm test` (833 tests, concurrency from `scripts/run-tests.js`) ran in 88.7 s with no cap and 93.4 s as a child of a session capped at 60% (one run each).
- CPU cap enforced (orchestrator, 2026-10-31, one run each, 32 threads): 8 self-ending 5 s loops at below normal used 35.8 CPU seconds in 4.5 s with no job cap, and 14.5 with a 10% cap (10% of 32 threads over 4.5 s is 14.4).
- Leftovers at a real exit (orchestrator, 2026-10-31, `claude -p` 2.1.308, throwaway projects): a sleeper started from the Bash tool as a `detached` Node child, with `&`, with `setsid`, or with `run_in_background` was gone within 9 s of ending the Claude process, whether `session_cleanup` was on or off, and the holder's list was empty (`found` 0). So under `claude -p` something other than this cleanup already ends them (most likely the runtime's own kill-on-close job). The incident's six loops survived a desktop-app quit, and that path was not reproduced here. Cleanup itself is proven only with stand-in sessions; watch the `found` and `stopped` counts of `session.cleanup` in real desktop sessions.
- Not measured: the whole machine at saturation.

# Codex CLI facts (measured with Codex CLI 0.160 on Windows, 2026-10)

Sources: https://developers.openai.com/codex/plugins/build · https://learn.chatgpt.com/docs/hooks ·
https://learn.chatgpt.com/docs/agent-configuration/subagents · https://learn.chatgpt.com/docs/non-interactive-mode

## Non-interactive runs
- `codex exec -C <dir> --sandbox workspace-write --skip-git-repo-check "<prompt>"`. stdin must be closed
  (`stdio[0] = 'ignore'`), otherwise it waits forever on "Reading additional input from stdin".
- `--output-schema <file>` asks for a final message that matches a JSON Schema; `-o <file>` /
  `--output-last-message` writes the final message to a file (it is still printed on stdout).
- In `workspace-write` the files of a linked worktree can be edited, but `git add` / `git commit`
  fail: `Unable to create '<repo>/.git/worktrees/<name>/index.lock': Permission denied`. The sandbox also
  cannot write outside the workspace, so it cannot write `~/.crewgate`. Hence crewgate commits for Codex workers.
- `codex exec` runs hooks: project `.codex/hooks.json` with `--dangerously-bypass-hook-trust`; plugin
  hooks need a one-time trust in `/hooks` and again whenever the command string changes.

## Hooks
- Payload shape matches Claude Code: `session_id, transcript_path, cwd, hook_event_name, model, permission_mode`;
  PreToolUse/PostToolUse add `turn_id, tool_name, tool_input, tool_use_id` (PostToolUse also `tool_response`);
  inside a subagent also `agent_id, agent_type`.
- Spawning a subagent is the tool `collaborationspawn_agent` with `tool_input.task_name` and `.message`;
  waiting is `collaborationwait_agent` (`timeout_ms`). SubagentStart: `agent_id, agent_type` (observed
  `default`); SubagentStop adds `agent_transcript_path, last_assistant_message, stop_hook_active`.
  Stop: `stop_hook_active, last_assistant_message`. SessionEnd: `reason` (always `other`), about 1 s budget
  (default 1, at most 3). The shell tool is `Bash` with `tool_input.command`.
- Handler fields: `command` (one string; no `args` array is documented), `commandWindows`, `timeout` (seconds),
  `statusMessage`, `async`. Matchers are regular expressions on the tool name (or agent type, reason, source).
- **The spawn `message` in PreToolUse/PostToolUse is opaque** (an encrypted-looking base64 string, about 200 characters), so a `crew-task:` marker cannot be read there. `task_name` is chosen by the model (observed `crew_task`), `tool_response` is `{"task_name":"/root/<task_name>"}`. SubagentStart has only `agent_id` and `agent_type` (`default`), but the subagent's own rollout file `<dir of transcript_path>/rollout-<timestamp>-<agent_id>.jsonl` already exists and holds the message (and possibly forked parent history); SubagentStop adds `agent_transcript_path` pointing at it.
- Project-level `.codex/hooks.json` loads only when the project is trusted (`[projects."<path>"] trust_level = "trusted"`; for a one-off `codex exec` use `-c "projects={ '<path>' = { trust_level = 'trusted' } }"`) in addition to hook trust (`--dangerously-bypass-hook-trust`).
- **PreToolUse decisions (codex-cli 0.164.0, Windows, project hook in `codex exec`, 2026-10-31):** `permissionDecision: "deny"`
  blocks the command ("Command blocked by PreToolUse hook: ..."; it does not run). `permissionDecision: "ask"` makes the hook
  show as "Failed" and THE COMMAND RUNS (fails open), so `ask` must never be sent to Codex. `{}` runs normally. The payload
  keys are `session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, tool_name, tool_input,
  tool_use_id`; `tool_name` is `Bash` even when the command runs in PowerShell.
- Plugin hooks get `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` (and the `_DATA` twins) in their environment.

## Plugins, skills, agents
- Codex reads `.codex-plugin/plugin.json` (a compatibility overlay; a root `plugin.json` is preferred) and
  `hooks/hooks.json` unless the manifest names hooks (path, list of paths or inline object; paths start with
  `./`). Marketplaces: `codex plugin marketplace add owner/repo` (also reads `.claude-plugin/marketplace.json`),
  install with `codex plugin add crewgate@crewgate`.
- Skills: `skills/<name>/SKILL.md` with `name` and `description`; there is no `$ARGUMENTS`.
- Plugins cannot ship agents. Custom agents are TOML files in `.codex/agents/` (`name`, `description`,
  `developer_instructions`, optional `model`). Subagents inherit the parent's sandbox.
