# Roadmap

A short, honest list of where crewgate is going. No dates are promised; items move as real use shows
what matters. Details of how things work today are in [DESIGN.md](DESIGN.md).

## Next (0.10)

- **Richer Sessions view.** Answer "who is doing what right now" at a glance: current activity (thinking,
  running a tool and on what, writing, waiting for you), role and task of each session and subagent, a
  parent/child tree, last prompt and reply snippets, branch and worktree, filters, and a private mode.
  Everything stays local, tail-read and redacted.
- **Codex support.** Codex as a worker or reviewer comes first. Codex as an orchestrator is under
  investigation: it depends on how Codex maps hooks, skills and subagents, and we will not ship a guess.

## Later

- Session statistics: duration, prompts, tool counts, tokens and cost per session.
- A per-session activity timeline you can drill into.
- Promoted-rule scoring: measure whether a promoted lesson actually reduces repeat corrections.

## Exploring

- An optional visual "office" view of the agents (2D or 3D), built from scratch. The list view stays the
  default and the only one that must work everywhere. Contributions are welcome; open an issue first.

## 1.0 criteria

- Used on real projects for a sustained period, with the findings fed back.
- Config, CLI and data formats (`.claude/crew.json`, `.crew/`, `events.jsonl`, task files) are stable.
- Migration notes for anything that changed since 0.9.
