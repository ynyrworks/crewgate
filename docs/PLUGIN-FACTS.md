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
