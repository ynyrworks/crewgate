<!-- crewgate:rules:start -->
- Stop only processes you started, by their pid; never kill by image name. (source: no-kill-by-image-name, 2026-10-31–2026-10-31)
- Before reporting a new test that depends on time or files as passing, run it several times. (source: worker-green-once, 2026-10-31–2026-10-31)
- Reviewers and refuters never change a working tree: read other branches with git show or git diff, never git checkout or switch. (source: reviewer-no-checkout, 2026-10-31–2026-10-31)
- A load or stress test on the user's machine needs a process count (at most half the CPU cores) and a time limit after which each process ends by itself; check yourself that nothing is left. (source: no-machine-load, 2026-10-31–2026-10-31)
- To check that something starts with no window, watch window creation while it starts; reading window handles afterwards misses a flash. (source: check-windows-not-handles, 2026-10-31–2026-10-31)
- Before claiming a fix works, run the same check with the fix off; a check that also passes without it proves nothing. (source: verify-with-control, 2026-10-31–2026-10-31)
<!-- crewgate:rules:end -->
