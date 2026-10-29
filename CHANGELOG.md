# Changelog

## Unreleased

- Shared core: paths, atomic JSON store with locking, project detection and registry,
  configuration with validation, event log, redaction, task state machine, i18n.
- `crew` CLI dispatcher with `project`, `need`, `work`, `log`, `mr`, `validate` and
  `import` commands.
- Workflow commands: `init` (renders config, agent copies and `.crew/` files), `task`, `review`
  (find, deterministic filter with dismissed ledger, refute, finalize), `handoff`, `lesson`, `doctor`.
- Templates, generic `crew-worker` / `crew-reviewer` / `crew-refuter` agents and the `/agent-crew:crew`
  orchestrator skill with references.
