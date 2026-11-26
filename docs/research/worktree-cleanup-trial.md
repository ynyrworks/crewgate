# Worktree cleanup: real trial

Plan `worktree-cleanup`, 2026-11-26. A trial in two throwaway projects with real git and the real CLI, one command at a time, run by the orchestrator. "New" is the repository's CLI at `174735b` (rc/0.21); the control is the installed 0.26.2 CLI, whose task and lesson code is the same as 0.26.3. Each project had its own `CREWGATE_HOME`. The script is not kept in the repository; the steps are below.

Each task: `crew task create` with a worktree, `git worktree add`, one commit in the worktree, `crew task report`, `crew task accept`, then the step named in the row.

| Case | New CLI | Control (0.26.2) |
|---|---|---|
| A. Branch merged into main, worktree clean, `crew task merge` from the main checkout | "Removed worktree ...", folder gone, branch kept | folder still there |
| B. Merged, one uncommitted change in the worktree | "stays: it has changes", folder kept | folder still there, no message |
| C. `crew lesson add` run inside the worktree | lesson in the main checkout's `.crew/LESSONS.md` (1), none in the worktree (0); worktree removed at merge | lesson only in the worktree (1), none in the main checkout (0), also after the merge |
| D. Merged, `crew task merge` run from inside the worktree | "stays: you are inside it" with the command to run from the main checkout | folder still there, no message |
| E. Cancelled task | folder kept | folder kept |
| `crew task clean` | lists B (has changes), D (can be removed), E (cancelled, with the hand command) and "1 can be removed" | the command does not exist (usage text) |
| `crew task clean --apply` | D removed; B and E kept; "removed 1, kept 2" | - |
| Session start, two finished tasks with a folder left | "finished tasks with a worktree still on disk: 2; `crew task clean` lists them" | no such line |
| F. Task accepted, branch already merged, session start | "accepted tasks whose branch is already merged: 1 (id); close each with `crew task merge <id>`" | not run |
| New CLI's `crew task clean --apply` on the control project's five leftovers | A and D removed; B and C kept (changes; C's change is the lesson written into the tracked LESSONS.md by the old CLI); E kept (cancelled) | - |

Also seen on real tasks of this repository: `crew task merge` with the new CLI removed the worktrees of tasks `t-20261126-mptl` and `t-20261126-7ra9` and kept their branches.

## Not covered by this trial

- The adoption of an untracked `.crew/LESSONS.md` left in a worktree: the new CLI no longer writes lessons there, and in the control project the file is tracked, so the worktree counts as changed. Covered by the unit tests only (`worktree-merge.test.js`, `lessons-main-checkout.test.js`).
- A removal that git refuses (locked file, long path): unit tests with `git worktree lock` only.
- Sizes: every trial worktree was a few bytes ("0.0 MB"); the 2-second limit and "at least" were not seen for real.
- Squash and rebase merges (reported as not merged by design), a large repository and the 500 ms limit of the session-start git call, and anything other than Windows.
- A read-only `crew task clean` in another real project (Ynyr_WASD) listed nothing: its leftover worktrees belong to tasks still in `accepted`, which the command does not list; the session-start line for accepted tasks is what covers them. The hook was not run in that project.
