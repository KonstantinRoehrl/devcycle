# Promotion records

One file per landed promotion, named `<landing-date>-<slug>.md`. Never a single shared
log: two developers landing promotions on parallel branches would collide on the same
lines almost every time, while separately-named files essentially never conflict.

These records are committed. They hold no raw session data — only promotions a human
already confirmed and that already landed as doc or skill edits.

**Who writes, who reads, and when.** `devcycle:distilling-learnings` writes one file here
per confirmed promotion, calling `dream.mjs --record-promotion` right after the edit's
commit lands. On every later dreaming run, `dream.mjs`'s `--check-recurrence` step reads
every record in this directory and matches its `cluster-signature` against the corpus
accumulated since that record's `landed` date, folding any hit into that run's
`.devcycle/dreaming/<date>-dream.md` artifact. `devcycle:doctor` never reads this directory
directly and never invokes the dreaming engine — it renders its "previously promoted — did
it hold" appendix from that dream artifact instead, so doctor stays runnable standalone and
pays none of a dream's cost.

## Record shape

- `promotion-type` — one of `doc-edit`, `skill-edit`, `contradiction-resolution`,
  `config-proposal`, `extract-to-script`. The last two are reserved for deferred phases and
  no current code path produces them.
- `cluster-signature` — the stable phrase later runs match against. Screened for secrets
  before it is written: a signature can be more revealing than the fix it describes.
- `files-touched` — comma-separated repository-relative paths, as stored in the record
  file (e.g. `files-touched: agents/task-reviewer.md, README.md`). The `--record-promotion`
  JSON payload's `filesTouched` field is an array of the same paths; `dream.mjs` joins it
  with `", "` when writing the record line above.
- `landed` — `YYYY-MM-DD`.
- `commit` — the sha the promotion landed in.

## Example

    # Reviewer rejects unauthorized-file claims on shared working trees
    - promotion-type: skill-edit
    - cluster-signature: task-reviewer flags files from a concurrent task's uncommitted edits
    - files-touched: agents/task-reviewer.md
    - landed: 2026-08-04
    - commit: 0000000
