# Review rules

Read by the reviewer and the refuter on every review. Edit freely: this file is yours.
Dismissed findings are remembered in `.crew/dismissed.jsonl`.

## What to report

- Report only problems you can point to with `file:line` evidence in the diff or the code it touches.
- Prefer a reproduction or a failing test (`verified_by: repro|test`), then a traced code path
  (`code-trace`). Pure inference is dropped by default; do not pad the list with it.
- Check the change against the brief: missing acceptance items, work outside the allowed scope,
  and regressions of behaviour listed under "Must not regress".

## Severity calibration

- `blocker`: wrong results, data loss, an exploitable security hole, or a broken build/test on the happy path.
- `major`: a real defect on a realistic path, or a clear regression of existing behaviour.
- `minor`: a defect with limited reach, a missing test for new behaviour, maintainability that will hurt soon.
- `nit`: naming, formatting, taste. At most a handful; the pipeline caps them.

## Do not report

- Anything CI, the linter or the formatter already checks.
- Theoretical issues (for example TOCTOU or other races) without a reproducible path: at most a `nit`
  tagged `"pattern": "theoretical-race"`. Give the interleaving that triggers it to keep a higher severity.
- Style preferences that the project does not enforce (tag them `"pattern": "style"`).
- Pre-existing problems outside the diff, unless the change makes them worse.
- Speculation about code you did not read.

## Project-specific rules

<!-- Add rules that keep recurring in your reviews. -->
