# Promotion records

One file per landed promotion, named `<landing-date>-<slug>.md`. Never a single shared
log: two developers landing promotions on parallel branches would collide on the same
lines almost every time, while separately-named files essentially never conflict.

These records are committed. They hold no raw session data — only promotions a human
already confirmed and that already landed as doc or skill edits. Later dreaming runs match
`cluster-signature` against sessions accumulated since `landed` to check whether a
promotion held; `devcycle:doctor` reads the same files for its "previously promoted — did
it hold" appendix.

## Record shape

- `promotion-type` — one of `doc-edit`, `skill-edit`, `contradiction-resolution`,
  `config-proposal`, `extract-to-script`. The last two are reserved for deferred phases and
  no current code path produces them.
- `cluster-signature` — the stable phrase later runs match against. Screened for secrets
  before it is written: a signature can be more revealing than the fix it describes.
- `files-touched` — comma-separated repository-relative paths.
- `landed` — `YYYY-MM-DD`.
- `commit` — the sha the promotion landed in.

## Example

    # Reviewer rejects unauthorized-file claims on shared working trees
    - promotion-type: skill-edit
    - cluster-signature: task-reviewer flags files from a concurrent task's uncommitted edits
    - files-touched: agents/task-reviewer.md
    - landed: 2026-08-04
    - commit: 0000000
