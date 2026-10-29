# Changelog

## Unreleased

- Shared core: paths, atomic JSON store with locking, project detection and registry,
  configuration with validation, event log, redaction, task state machine, i18n.
- `crew` CLI dispatcher with `project`, `need`, `work`, `log`, `mr`, `validate` and
  `import` commands.
- Local board (`crew board start|stop|status|serve`): 127.0.0.1-only server with Host allow-list, token-protected
  JSON writes and strict CSP; Overview, Project, Sessions, Usage and Settings pages (en, zh-TW); live session
  list read from local Claude Code / Codex logs without exposing message text; Settings form generated from the
  config schema.
- Hooks: single `crew-hook.js` entry for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  SubagentStart/Stop, Stop, PreCompact and SessionEnd (dispatch tracking, orchestrator edit guard,
  big-read reminder, git push/merge events, session digest). See `plugins/agent-crew/hooks/README.md`.

- Workflow commands: `init` (renders config, agent copies and `.crew/` files), `task`, `review`
  (find, deterministic filter with dismissed ledger, refute, finalize), `handoff`, `lesson`, `doctor`.
- Templates, generic `crew-worker` / `crew-reviewer` / `crew-refuter` agents and the `/agent-crew:crew`
  orchestrator skill with references.
