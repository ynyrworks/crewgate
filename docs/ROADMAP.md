# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md); what changed in each version is in
the [CHANGELOG](../CHANGELOG.md).

## Released

One line per minor version; the full notes are in the [CHANGELOG](../CHANGELOG.md).

- **0.16** — Projects can add their own gates, and their scripts get a CLI path that stays the same across versions; `crew task accept` refuses review findings that skipped the refuter unless a reason is given; `crew plan clarify` keeps settled questions with the plan; `crew lesson score` shows whether a promoted rule helped.
- **0.15.1** — Plan tree step 3: `crew review followup` proposes work a code review found as a `[?]` step that counts only once accepted, next to the task's step or in another plan.
- **0.15** — The pixel-art Office becomes an optional plugin, `crewgate-office`; plans guard their goal (a warning without one, an `off-goal` review finding, clarifying before a non-trivial plan); a gate set to `never` is denied before the command runs, and detection covers the PowerShell tool and wrapped commands.
- **0.14** — Plans: a tree of steps kept as Markdown in the repo, and plan review that turns what a reviewer finds into proposed `[?]` steps. The board says why it stopped and can start itself (`board.autostart`).
- **0.13** — Gates follow the repo a command targets and can be enforced (`gates.enforce`, `gates.require_user_turn`); the History page; timeline search; wider board layouts; Office view v3; stability fixes from real use.
- **0.12** — Session statistics (duration, prompts, tool counts, tokens, estimated cost), a per-session activity timeline (`#/s/<id>`), the experimental Office view, and fixes from real use (recorded gates, hooks-last-seen, merge records, `via`, agent names, work item updates, default checks detection).
- **0.11** — Update banner and one-click update on the board (one optional request a day, off with `updates.check`).
- **0.10** — Codex support (experimental): Codex as worker, reviewer and orchestrator; a richer Sessions view (current activity, role and task, parent / child tree, filters, private mode).
- **0.9** — First public release: orchestrator skill, worker / reviewer / refuter agents, five-section briefs, task state machine, three-stage review, lessons, hooks, local board.

## Unreleased / next release

What is on `main` and will ship in the next version (details under "Unreleased" in the [CHANGELOG](../CHANGELOG.md)): the doctor reports stale agent copies, a broken CLI path and project gates.


## Later

- **Per-account labelling of sessions.** Show which Claude account or plan a session used, with an optional "expected account" warning per project. Idea stage: it is not verified that the account can be detected from what Claude Code exposes locally.
- **Office view: test-result reactions** (a celebration or a slump when checks pass or fail; the result is not in the data the office receives today) and **bigger character sprites**.
- **Enhanced WebGL Office.** A first version is on the `feat/webgl-office` branch, not in a release. In the same optional `crewgate-office` plugin, sharing its data model, with the pixel-art view as the fallback for browsers without WebGL or too slow for it. The main plugin gains no dependency.
- **Codex.** Verification on more platforms and Codex versions, honouring hook `ask` / `deny` if Codex supports it, and Codex subagent workers once their sandbox can commit.

## Exploring

- **Office view (experimental).** The list view stays the default and the only one that must work everywhere. Still open: feedback from real use, and more poses and room decoration.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
