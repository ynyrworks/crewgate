# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md); what changed in each version is in
the [CHANGELOG](../CHANGELOG.md).

## Released

One line per minor version; the full notes are in the [CHANGELOG](../CHANGELOG.md).

- **0.15** — The pixel-art Office becomes an optional plugin, `crewgate-office`; plans guard their goal (a warning without one, an `off-goal` review finding, clarifying before a non-trivial plan); a gate set to `never` is denied before the command runs, and detection covers the PowerShell tool and wrapped commands.
- **0.12** — Session statistics (duration, prompts, tool counts, tokens, estimated cost), a per-session activity timeline (`#/s/<id>`), the experimental Office view, and fixes from real use (recorded gates, hooks-last-seen, merge records, `via`, agent names, work item updates, default checks detection).
- **0.11** — Update banner and one-click update on the board (one optional request a day, off with `updates.check`).
- **0.10** — Codex support (experimental): Codex as worker, reviewer and orchestrator; a richer Sessions view (current activity, role and task, parent / child tree, filters, private mode).
- **0.9** — First public release: orchestrator skill, worker / reviewer / refuter agents, five-section briefs, task state machine, three-stage review, lessons, hooks, local board.

## Unreleased / next release

What is on `main` and will ship in the next version (details under "Unreleased" in the [CHANGELOG](../CHANGELOG.md)).

- **Gates follow the repo and can be enforced.** Git events and gate checks use the repository a command targets (`cd`, `git -C`); `gates.enforce` (`remind`, `confirm`, `block`) with a PreToolUse(Bash) hook; `gates.require_user_turn`; the session id read from `CLAUDE_CODE_SESSION_ID`. `confirm` is unverified in bypass-permissions mode, and Codex stays on `remind`.
- **History.** `#/history` looks back up to 90 days with the Sessions statistics, by day, with a range and project filter.
- **Timeline polish.** A search box, tool durations across page edges, and crewgate events older than the board's recent event tail.
- **Board layout.** Capped, scrolling lists inside cards, wide-screen layout up to 2400 px, more grid columns.
- **Stability fixes from real use.** Redirects and heredocs are not parsed as git words, a hook error log (`hook-errors.jsonl`) and `crew doctor` counts, `subagent.stop` `last` only from a final message, deduplicated Codex session events and merges, orphan subagent marking, timestamps in `board.log`.
- **Office view v3.** Redrawn pixel art; behaviour follows the activity (reading, searching, editing, running, waiting), errands between sessions, a lounge for idle sessions, walking out when done, and a different look per role.

## Later

- **Per-account labelling of sessions.** Show which Claude account or plan a session used, with an optional "expected account" warning per project. Idea stage: it is not verified that the account can be detected from what Claude Code exposes locally.
- **Office view: test-result reactions** (a celebration or a slump when checks pass or fail; the result is not in the data the office receives today) and **bigger character sprites**.
- **Enhanced WebGL Office (planned for the next release).** In the same optional `crewgate-office` plugin, sharing its data model, with the pixel-art view as the fallback for browsers without WebGL. The main plugin gains no dependency.
- **Plan tree step 3 (planned for the next release).** Follow-up work from code review attaches to the plan, always as a proposed `[?]` node that counts only once accepted; work unrelated to the goal is suggested for another plan.
- **Promoted-rule scoring.** Measure whether a promoted lesson actually reduces repeat corrections.
- **Codex.** Verification on more platforms and Codex versions, honouring hook `ask` / `deny` if Codex supports it, and Codex subagent workers once their sandbox can commit.

## Exploring

- **Office view (experimental).** The list view stays the default and the only one that must work everywhere. Still open: feedback from real use, and more poses and room decoration.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
