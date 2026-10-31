# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md); what changed in each version is in
the [CHANGELOG](../CHANGELOG.md).

## Released

One line per minor version; the full notes are in the [CHANGELOG](../CHANGELOG.md).

- **0.20** — A crew session no longer takes over the machine: tests run at a quarter of the cores, sessions run at below-normal priority, and on Windows each session has a CPU cap and cleanup at exit. A hook enforces limits on crew agents and on dispatch. HD Office characters no longer pile up; `crew task accept` notes changes that were not re-reviewed; the History page shows accounts.
- **0.19** — `crew release record` writes one committed record per version, flagging changes that were not re-reviewed; the project page shows recent merges and task activity when its cards are empty; the HD Office view ships as an opt-in test version in the optional add-on.
- **0.18.1** — After a one-click update the page shows the result, even when the new board answers before the page notices the restart.
- **0.18** — Under Codex, a `never` gate and an unapproved `ask` gate under `confirm` or `block` are denied before the command runs; sessions show their Claude account and a project can name the one it expects; a board killed outright can be dated.
- **0.17** — A task notification no longer counts as a user message for the gate rule; workers and reviewers are told to keep changes to the brief; `crew doctor` reports stale agent copies, a broken CLI path and project gates; the board's session counts match the Sessions page.
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

Nothing yet: `main` matches the latest release. Each version's record is in [docs/releases](releases/).


## Known issues

Open problems in the latest release, and what has not been checked.

- **The board is sometimes killed outright.** The cause is not established; closing or updating the desktop app is the untested suspect. It logs nothing when this happens. Since 0.18 it records when it was last alive, so the next death can be dated. `board.autostart` brings it back at the next session.
- **Machine load.** Cleanup at the end of a session is proven with stand-in sessions only: the desktop-app quit from the incident was not reproduced, and under `claude -p` leftovers were gone even with cleanup off. The whole machine at saturation and the 60% cap in real use are not measured. Processes started before the job is set up, and anything created through WMI, escape it. macOS and Linux have no cap and no cleanup. A Windows Terminal tab opened from a session can count as background and be stopped; not measured. If `wscript.exe` is disabled there is no cap and no cleanup.
- **Timing-sensitive tests.** `board-autostart` waits up to 60 s and prints what it needs when it fails. The cause of the CI failures is most likely a slow start on a busy machine, not proven, and two runs under heavy load never came up within 60 s. The SessionStart latency check in `hooks-contract` has failed under load and passed alone.
- **Gates are best effort.** Scripts, configured aliases, variables and other tools are not seen. Use branch protection on the server for a hard stop.
- **Codex.** Hooks installed through the plugin are not verified, only hooks in `.codex/hooks.json`, and a real run covered only `never`. The Office add-on install through Codex is not verified. Codex versions older than 0.164 were not measured.
- **Account labels.** Only new sessions in crew projects have one.
- **One-click update.** Clicking the board's button updated 0.17.0 to 0.18.0 on the GitHub marketplace. The page kept the old "update available" banner for up to a minute because the new board answered first. The fix is in 0.18.1 and shows only from the update after that, since the old page runs the update. It has not been seen working yet.
- **HD Office test version.** Tone and foreground are unfinished. Four seated and four idle characters were seen only while walking. It runs in Chrome, but in the Claude desktop app's built-in browser pane it often measures as too slow and falls back to the pixel view, even on a fast GPU; the cause is not established. Performance on integrated graphics is not measured. The no-WebGL and load-failure messages have unit tests only.
- **Agent limits are best effort.** Since 0.20 a hook denies what it can recognise in a command line. Scripts, files and variables are not seen, a real reviewer being denied has not been seen, and the `SendMessage` field is read from the documentation.
- **Project page.** The orchestrator's log and work items depend on an instruction in the skill, so they can be missed. The events scan reads up to 8 MB each time a project's events file changes, which is cheap at today's sizes of under 100 KB.

## To do

Decided, not started or not finished.

- **HD Office.** The look stays frozen as v0.1.0 for now. Still to do before it can be the default: warm tone, foreground, and performance on integrated graphics.
- **Machine load in real use.** Check `session.cleanup` counts and the absence of windows in real desktop sessions.
- **How this reached the user.** A root-cause review of why the crew flow let the load and window problems through, and what it should change.
- **Codex.** Verification on more platforms and versions, and on plugin-installed hooks.

## Later

- **Office view: test-result reactions** (a celebration or a slump when checks pass or fail; the result is not in the data the office receives today) and **bigger character sprites**.
- **Codex subagent workers,** once their sandbox can commit. Codex CLI 0.164 still cannot: `git add` in a worktree fails with permission denied.

## Exploring

- **Office view (experimental).** The list view stays the default and the only one that must work everywhere. Still open: feedback from real use, and more poses and room decoration.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
