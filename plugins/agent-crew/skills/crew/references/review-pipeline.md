# Review pipeline

Goal: you read a handful of verified findings instead of a wall of speculation. Three stages; you
only see the survivors.

## Stage 1: find

`crew review run <task>` (`--engine <name>` to use an external engine from `engines` in the config).

- Engine `claude` (default): the command prints the exact prompt for the reviewer subagent and the
  round's raw file path. Dispatch it with the Agent tool (`subagent_type: crew-reviewer`). The
  reviewer is read-only; it sees the diff, the brief and `.crew/REVIEW.md`, and **not** the worker's
  report. It saves its findings by piping JSON to `crew review submit <task> --round N`.
- External engine (for example Codex CLI): the command runs it itself, sends the prompt on stdin,
  extracts the JSON array from its output and writes `findings/<round>.raw.json`. A failure or
  output without a JSON array is reported; nothing is guessed.

Finding schema (an element of the array):

```json
{ "id": "f1", "category": "correctness", "severity": "major",
  "file": "src/a.js", "line": 42, "symbol": "parse", "snippet": "offending code, copied exactly",
  "claim": "what is wrong and why it matters",
  "evidence": ["src/a.js:42", "test/a.test.js:10"],
  "verified_by": "repro", "confidence": 0.9, "suggestion": "optional" }
```

`category` comes from `review.categories`; `severity` is `blocker|major|minor|nit`; `verified_by` is
`repro|test|code-trace|inference`. Optional `pattern` (for example `theoretical-race`, `style`) lets
the filter downgrade it.

## Stage 2: filter (deterministic)

`crew review filter <task>` applies, in order, and records everything dropped with its reason in
`findings/<round>.filtered.json`:

1. invalid entries (schema problems are listed, never crash the run);
2. the dismissed ledger `.crew/dismissed.jsonl` (see below);
3. `verified_by: inference`, unless `review.report_inference` is true;
4. `confidence` below `review.min_confidence`;
5. patterns in `review.downgrade_to_nit` become nits unless `verified_by` is `repro`;
6. nits beyond `review.nit_cap` (lowest confidence first).

Survivors are saved as `<round>.kept.json` and printed with the refuter prompt.

## Stage 3: refute

Dispatch the refuter subagent (`crew-refuter`) with the printed prompt. It tries to disprove each
finding using only the diff, the brief and REVIEW.md, and submits `{id, verdict, evidence}` entries
(`upheld|refuted|uncertain`) with `crew review submit <task> --round N --kind refutations`.
Then `crew review finalize <task>` (or `--refutations-file f.json`): refuted findings are dropped
(and logged), upheld and uncertain ones are written to `findings/<round>.json`. A finding without a
usable verdict stays as `uncertain` with a warning. Finalize also moves a `returned` task to
`reviewing`.

## Deciding

- `blocker`/`major` upheld: send back (or fix after takeover). Quote the finding id, file:line and
  the claim in your note.
- `uncertain`: check the cited `file:line` yourself, in a line range, before deciding.
- `minor`/`nit`: batch them into one send-back note, or accept and mention them to the user.
- Wrong or irrelevant: `crew review dismiss <task> <finding-id> --scope once|always --reason "..."`.
  - `once`: this occurrence only; it stops matching when the snippet no longer exists in the file.
  - `always`: this pattern is accepted in this project; it also adds a lesson candidate suggesting a
    rule in `.crew/REVIEW.md`. Use it sparingly and tell the user.

Fingerprint of a finding = sha256 of category, file, symbol and the whitespace-normalised snippet,
so reformatting does not resurrect a dismissed finding.

## Rounds

Each `review run` starts a new round (`1.raw.json`, `2.raw.json`, ...). Re-review after a send-back
with a new round; old rounds stay for the record. `crew review show <task> [--round N]` prints a round.

## Calibrating the reviewer

Edit `.crew/REVIEW.md` (severity calibration, what not to report). Rules that keep recurring in
dismissals belong there, not in your head.
