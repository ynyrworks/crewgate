# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md).

## Next (0.10)

- **Richer Sessions view.** Answer "who is doing what right now" at a glance: current activity (thinking,
  running a tool and on what, writing, waiting for you), role and task of each session and subagent, a
  parent/child tree, last prompt and reply snippets, branch and worktree, filters, and a private mode.
  Everything stays local, tail-read and redacted.
- **Codex support (experimental, shipped in this cycle).** Codex as a worker through `crew task run --engine codex` (crewgate commits, because the Codex sandbox cannot), Codex as a reviewer, and Codex as an orchestrator through the same plugin folder (hooks, skill, custom agents). Still to do: verification on more platforms and Codex versions, and Codex subagent workers once their sandbox can commit.

## Later

- Session statistics: duration, prompts, tool counts, tokens and cost per session.
- A per-session activity timeline you can drill into.
- Promoted-rule scoring: measure whether a promoted lesson actually reduces repeat corrections.

## Exploring

- **Office view (done, experimental).** `#/office` shows live sessions as a pixel-art office, drawn from
  scratch on a canvas. The list view stays the default and the only one that must work everywhere. Still
  open: feedback from real use, more poses and room decoration, and whether a 3D variant is worth it.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
