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
