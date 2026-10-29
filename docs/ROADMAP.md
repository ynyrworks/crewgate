# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md).

## Next (0.10)

- **Richer Sessions view.** Answer "who is doing what right now" at a glance: current activity (thinking,
  running a tool and on what, writing, waiting for you), role and task of each session and subagent, a
  parent/child tree, last prompt and reply snippets, branch and worktree, filters, and a private mode.
  Everything stays local, tail-read and redacted.
- **Codex support (experimental, shipped in this cycle).** Codex as a worker through `crew task run --engine codex` (crewgate commits, because the Codex sandbox cannot), Codex as a reviewer, and Codex as an orchestrator through the same plugin folder (hooks, skill, custom agents). Still to do: verification on more platforms and Codex versions, and Codex subagent workers once their sandbox can commit.

## Built, waiting for a release

- Session statistics: duration, prompts, tool counts, subagents, tokens and estimated cost per session, with totals per parent (cached incrementally per file, bounded work per request).
- A per-session activity timeline you can drill into (`#/s/<id>`): 200 steps per page, paging backwards by byte offsets, filter by kind, links to subagent pages.

## Later

- Timeline polish: tool durations at the page boundary, a search box, and crewgate events older than the board's event tail.
- Statistics for sessions older than the 24-hour list window (a history view).
- Promoted-rule scoring: measure whether a promoted lesson actually reduces repeat corrections.

## Exploring

- An optional visual "office" view of the agents (2D or 3D), built from scratch. The list view stays the
  default and the only one that must work everywhere. Contributions are welcome; open an issue first.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
