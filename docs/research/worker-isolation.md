# Evaluation: running workers off the user's machine

Date: 2026-11-01. Follows [the machine load postmortem](../postmortems/2026-10-31-machine-load.md), batch 3. Nothing here is built. This is a decision paper.

## The question

Priority, a CPU cap and shared test slots limit the harm a worker does on the user's machine. Only isolation removes it by structure. Should crew workers run somewhere else?

## How workers run today

A worker is a Claude Code subagent, inside the same `claude` process as the orchestrator. Its Bash commands are children of that process, and it works in a git worktree on the same disk. Crewgate does not start that process, and has no control over where it runs. Codex is the exception: `crew task run --engine codex` starts an external CLI per task and collects the result (`plugins/crewgate/lib/features/codexrun.js`).

So moving a worker means moving what starts it, not changing a setting. Subagents cannot be sent elsewhere. Anything isolated runs as a separate CLI process per task, which is the Codex path.

## Options

| Option | CPU and process limit | Who is affected on failure | Needs | Measured here |
|---|---|---|---|---|
| Today: same machine, with priority, cap, slots | Priority always, cap on Windows only | The user's machine, reduced | Nothing | Yes |
| Whole Claude Code in a dev container | `--cpus`, `--memory` on the container, kernel enforced | The container, plus the bind-mounted repo | Docker running, repo mounted | No: Docker Desktop is installed but its engine was off |
| One `claude -p` per task in a container, via an engine like Codex's | Same, per task | The container | Docker running; credentials in the container; a new engine | No |
| WSL2 | Whole-VM limits in `.wslconfig`; the sandbox runs there | The VM | WSL2 installed, repo on the Linux disk | No: not installed here |
| Claude Code on the web or a cloud session | Off the machine entirely | Nothing local | A GitHub repo and environment; network; cost | No |
| GitHub Actions or Codespaces per task | Off the machine | Nothing local | Same, and minutes on a paid plan | No |

## What the sources say

- Claude Code's [dev container](https://code.claude.com/docs/en/devcontainer) runs commands inside the container, with edits appearing in the local repository through a bind mount. It warns that it does not stop a malicious project from reading what is in the container, including credentials, and says not to mount host secrets.
- Its [sandbox](https://code.claude.com/docs/en/sandboxing) limits files and network only, and does not run on native Windows. It does not address load.
- Community setups pass resource limits on launch, such as [`--memory 4g --cpus 2`](https://github.com/Andrevops/claude-sandbox), and advise [keeping the project on the Linux disk under WSL](https://github.com/ShoRoy/claude-docker-sandbox), not on a Windows mount. One [report](https://github.com/anthropics/claude-code/issues/18048) had Claude Code using 21 GB inside WSL2, so a VM limit can also be what stops the session.
- [Worktree guides](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) note that worktrees isolate files, not ports, databases or memory.

No source was found on running parallel worktrees through containers, and no official guidance on resource limits.

## What it would cost Crewgate

- **Gates and hooks.** They run inside each Claude process, so they would have to be installed in the container too, and state under `CREWGATE_HOME` would have to reach the host or the board loses sight of the work.
- **Worktrees.** A linked worktree's `.git` file points at an absolute host path, which breaks inside a container unless the main repository is mounted at the same path.
- **Credentials.** The container needs Claude credentials, and whatever it can read, a task can read.
- **Windows file speed.** A Windows folder mounted into Linux is slow, and test suites are what this is meant to protect against.
- **Tests differ from the user's system.** A Windows project's tests in a Linux container do not check Windows behaviour. Crewgate's own window and Job Object tests could not run there.
- **Startup.** Docker Desktop or a VM holds memory all the time, which is load of its own.

## Decision

Do not build this now, and do not make it the default.

- The layers in 0.20 and the next version address the measured causes at almost no cost. Their value in real use should be seen first: `dispatch.load`, `session.cleanup`, `task.leftovers`.
- An option that needs Docker or WSL2 cannot be the answer for everyone, and this machine has neither running today.
- Isolation is still the only thing that survives a worker that ignores every rule, so the path should stay open.

If real use shows that the layers are not enough, build the smallest version: an engine that runs `claude -p` per task in a container, modelled on `crew task run --engine codex`, opt-in per project, with `--cpus` and `--memory`. A one-day prototype would first need to answer: does a worktree work when mounted, how slow is `npm test` on a mounted Windows folder against the host, and do hooks fire and reach the board.

**What would change this decision:** a `session.cleanup` or `task.leftovers` record showing real leftovers after these fixes; another machine freeze; or a project that needs to run untrusted code.
