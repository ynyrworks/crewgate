# Changelog

## 0.1.0 - 2026-10-29

First release.

- Orchestrator skill `/agent-crew:crew` (init, status, wrap-up, handoff) and generic `crew-worker`,
  `crew-reviewer` and `crew-refuter` agents; `crew init` renders project copies of the agents, the config and the
  `.crew/` files.
- Task state machine with five-section briefs (the CLI refuses incomplete ones), capped worker reports,
  send-back limit with orchestrator takeover, and cross-session handoffs.
- Review pipeline: find, deterministic filter (dismissed ledger, inference, confidence, nit cap, downgrades),
  refute, finalize. Codex CLI (or any command that reads a prompt on stdin) can act as the reviewer engine.
- Lessons that become promotion candidates after several days and are written into a marked rules block only on
  an explicit yes.
- Hooks (single `crew-hook.js` entry): dispatch tracking through the `crew-task:` marker, subagent start/stop,
  orchestrator edit guard (`off|warn|block`), big-read reminder, `git push` / `git merge` / PR events, stop
  reminders, session digest with "waiting for you" flags. Silent no-op in unregistered projects.
- Local board (`crew board start|stop|status|serve`): 127.0.0.1 only, Host allow-list, token-protected writes,
  strict CSP; Overview, Project, Sessions, Usage and Settings pages in English and Traditional Chinese. Settings
  forms are generated from the config schema; saves record `config.changed` with source `board`.
- Shared core: atomic JSON store with locking, project detection (a linked worktree maps to its main checkout),
  validated configuration, event log, redaction, i18n.
- Global config keys `board.show_text` and `prices.*.cache_write` / `prices.*.cache_read`; `docs/CONFIG.md` is
  generated from the schema (`node scripts/gen-config-docs.js`).
- Fictional example project `examples/todo-cli` with a full walkthrough, English and Traditional Chinese READMEs.
- Tests: unit, hook, board, scripted end-to-end flow and a repository hygiene scan (names, IP addresses, keys).
- Fixed: board review statistics counted intermediate `kept` and `refutations` files as final findings.
