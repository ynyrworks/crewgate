# Postmortem: crew work took over the user's machine

Date: 2026-10-31 to 2026-11-01. Versions: found on 0.19.0, partly fixed in 0.20.0 and 0.20.1.

The user called this a hard flaw of the project, and this review agrees. Crewgate's purpose is to let someone hand work over with confidence. During this work it made the machine unusable, left processes running after the app was closed, and then popped up windows at every session, and each safeguard came after the harm.

## What happened

1. The orchestrator's brief for a flaky test asked for a test run "while several copies of a busy loop run", with no count and no time limit. A worker ran 40 to 48 `node -e "for(;;){}"` processes and reported that none was left.
2. The orchestrator sent that task back and asked for one more batch at 48 loops. It was also running four workers against a limit of three, after a warning.
3. The user's Task Manager showed `bash.exe` with 93 children and 100% CPU. The user closed the whole app, expecting that to end it.
4. It did not. Six loops were still running, each with about 6,100 CPU seconds, and their parents were gone. Three stuck test runs from another worktree were running too. The orchestrator stopped them by pid.
5. The first fix added rules, then hook denials. The user rejected that as only limiting, and asked for the cause to be removed and for outside research.
6. Measurement found that normal work was the larger problem (below). Test concurrency, session priority and a Windows Job Object followed.
7. The Job Object holder was started in a way that opened a Windows Terminal window at each start. The user saw it. A worker had checked by reading window handles seconds later and passed it.
8. 0.20.0 was tagged and pushed before CI ran. macOS failed on all jobs, and Windows failed on some. 0.20.1 fixed it, with no release for 0.20.0.

## Measurements

All on Windows 11, 32 threads, Node 24, one run each unless stated. No artificial load was used except where stated, and those loops ended by themselves.

| What | Result |
|---|---|
| `node --test`, default concurrency (`availableParallelism() - 1`) | 97% peak CPU, 57 node processes, 58 s |
| `--test-concurrency=8` | 38%, 20 processes, 84 s |
| `--test-concurrency=4` | 23%, 14 processes, 132 s |
| Normal-priority probe, 4 loops on one core at normal | worst delay 378.9 ms, 269 samples in 4 s |
| Same, loops at below normal | worst delay 2.5 ms, 387 samples |
| Same, loops at idle | worst delay 1.3 ms, 387 samples |
| Same, no loops | worst delay 1.4 ms, 387 samples |
| 8 loops for 4.5 s, no job cap | 35.8 CPU seconds |
| 8 loops for 4.5 s, 10% job cap | 14.5 CPU seconds (14.4 expected) |
| Holder via detached `cmd /c start /b` | opens a Windows Terminal window |
| Holder via `wscript` with window style 0 | no window, during a start, a full test run and a real `claude -p` |
| Holder via detached `conhost --headless` | the script did not run |
| Below-normal parent, child through `bash.exe` and `&` | child reports priority 10 |

## Root causes

**1. Crewgate has no concept of the user's machine.** It protects the repository: branches, gates, review. No brief section, review category or gate asks what running something will do to the machine. Workers ran on the machine the user was working on, at the same priority as their apps.

**2. The parallel limit counts agents, not load.** The limit of three looks careful, but one `npm test` alone takes 97% of a 32-thread machine, and the rules told every worker to run the full suite. The limit measured something unrelated to the cost.

**3. The orchestrator is an unchecked single point.** It wrote the unbounded brief, asked for 48 more, went past the limit after a warning, and later wrote a push approval itself in a turn that was not the user's. The CLI accepted that; only a hook remarked on it afterwards. Review looks at diffs, not at briefs or dispatches. Most of this incident's errors were the orchestrator's, and nothing could stop them.

**4. Verification looks at code, not at effects.** Each escape had the same shape:

| Problem | Why it passed |
|---|---|
| Leftover processes | The worker's report was believed and not checked |
| Black windows | A handle read seconds later cannot see a window that flashed; reviewers cannot run anything |
| Session cleanup | The first end-to-end test also passed with the feature off, so it proved nothing |
| macOS false denial | Tested on Windows only, with the tag pushed before CI |
| `%` expansion | The filter dropped a true finding as inference; it was seen only by reading the raw file |

**5. The fix added risk.** The Job Object holder starts at every session and stops processes. It caused the windows at once, and three review rounds found 15 problems in it. It is the riskiest part of the product now, and the value of its cleanup is unproven in the real failure.

## What is still unknown

- Why those six processes survived the desktop-app quit. Under `claude -p`, a sleeper started as a detached child, with `&`, with `setsid` or with `run_in_background` was gone within 9 s of ending Claude, with cleanup on or off, and the holder's list was empty. The six start times are about 45 s apart, which does not fit one batch of 48. Cleanup is proven with stand-in sessions only.
- The whole machine at saturation was not measured, and neither was how the 60% cap feels in use.
- Two Windows CI failures have no established cause: the holder test and `hooks-stability` "keeps quiet about the merge".

## What others do

- Claude Code has no fix for this. Reports describe orphaned subagent processes, machines freezing and hard reboots; [#18405](https://github.com/anthropics/claude-code/issues/18405) was closed as not planned by a bot for inactivity, with no maintainer reply. A request for `maxParallelAgents`, [#15487](https://github.com/anthropics/claude-code/issues/15487), went the same way. The docs now list [`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`](https://code.claude.com/docs/en/env-vars), default 20, a limit per session.
- Its [sandbox](https://code.claude.com/docs/en/sandboxing) restricts files and network, not CPU, memory or process count, and it does not run on native Windows.
- [cc-reaper](https://github.com/thequert/cc-reaper) scans for orphans every 30 s and kills process groups. It supports macOS and Linux only and works after the harm.
- [Git worktree guides](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) make the same point this incident did: worktrees isolate files, not processes, and parallel test suites still compete.
- Operating systems already solve this. [Windows priority classes](https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities) preempt lower priorities at once, and [children inherit below-normal and idle](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa). [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) hold a process tree with [a CPU hard cap](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information). On Linux, [`systemd-run` scopes](https://linuxcommandlibrary.com/man/systemd-run) apply a quota to a whole cgroup.
- Build tools share a limit across processes with a [jobserver](https://www.chiark.greenend.org.uk/doc/make-doc/make.html/Integrating-make.html), a named semaphore on Windows. That is the model for sharing test slots across worktrees.
- [`node --test`](https://nodejs.cn/api/cli/test_concurrency.html) defaults to `availableParallelism() - 1` files at once, which is what the measurements above show.
- PreToolUse [`updatedInput`](https://code.claude.com/docs/en/hooks) can wrap a command, but permission rules then match the wrapped form, which can break a user's allow list. It was not used.

## What changed in 0.20

Test concurrency at a quarter of the cores, below-normal priority for the session, a Windows CPU cap and cleanup, a window-free holder, hook denials for over-limit dispatch and unbounded loops, and rules for workers and the orchestrator. Details are in [DESIGN.md](../DESIGN.md), section "Machine load from a crew session".

## Follow-up

**Batch 1: small, high value**
1. Cleanup records without stopping until real data shows its value.
2. CI on a branch must be green before a tag.
3. `crew gate answer` refuses outside a user turn when `require_user_turn` is on.
4. Briefs state their machine impact, and review checks it.
5. A window watcher in Windows CI.

**Batch 2: evidence in place of trust**
6. When a worker ends, the system looks for what it left and shows it in the task.
7. Dispatch looks at actual load, and waits when the machine is busy.
8. Test slots are shared across worktrees.
9. The orchestrator sees findings the filter dropped.

**Batch 3: structure**
10. macOS and Linux: CPU cap and cleanup, after research and measurement.
11. An evaluation of running workers off the user's machine: WSL2, containers or the cloud. This is the only option that isolates by structure, and it costs the most.

Other projects' test runners are not covered by the concurrency fix, only by priority and the cap. Batch 2 item 8 and the evaluation in item 11 are where that gets answered.
