# Changelog

## Unreleased

- Shared core: paths, atomic JSON store with locking, project detection and registry,
  configuration with validation, event log, redaction, task state machine, i18n.
- `crew` CLI dispatcher with `project`, `need`, `work`, `log`, `mr`, `validate` and
  `import` commands.
- Hooks: single `crew-hook.js` entry for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  SubagentStart/Stop, Stop, PreCompact and SessionEnd (dispatch tracking, orchestrator edit guard,
  big-read reminder, git push/merge events, session digest). See `plugins/agent-crew/hooks/README.md`.
