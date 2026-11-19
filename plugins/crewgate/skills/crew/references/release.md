# Release

## Release record

Before tagging a release, run `crew release record <version>` (options: `commands.md`, "Release record").
Read its flag lines: NOT RE-REVIEWED, NO REVIEW, no user turn, gate.missing, not placed.
Write the conclusion in a file and pass it with `--conclusion-file`: what was verified, what was not, which assumptions still stand.
Commit the record with the release. Do not leave the TODO in it.

## Release order: CI before the tag

Never tag a commit CI has not passed. In this order:

1. Push the branch (a push gate: ask, see Gates in `SKILL.md`) and wait for CI on it.
2. Run `crew release check`. It reads the runs of HEAD through `gh`; add `--commit SHA` for another commit.
   Exit 0 means at least one run exists and every job succeeded. Pending, failed or no run exits non-zero and says which.
   It blocks nothing and pushes nothing; the decision is yours.
3. Only then merge to main (step 10 of the loop) and tag.

CI must have run on the same commit that gets tagged. A fast-forward keeps it; a new merge commit or a rebase needs its own push, wait and `crew release check`.
If `gh` is missing the command says so; then check the run on GitHub by hand and do not tag on a guess.
