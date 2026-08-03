# Scenario: config-drift-mode
- Skill under test: devcycle:doctor (invoked via /devcycle:doctor drift <path>)
- Type: output-shape

Given a target file referencing a changelog-marked-superseded key, is it flagged with
the exact stale line and the recorded replacement?

## Setup

A sandbox `references/config-changelog.md` containing one `deprecated` record for key
`legacyReviewMode` (superseded by `reviewDepth`), and a target `CLAUDE.md` containing
the line `Set legacyReviewMode to strict for this repo.` at line 3.

## Pass criteria

1. **The exact stale line is reported**, `CLAUDE.md:3`, quoting the matched text.
2. **The replacement is named**, citing `reviewDepth` per the changelog record's note.
3. **No cost-analysis output appears** — this mode skips that machinery entirely.
4. **A clean target file (no stale references) reports cleanly**, no false positive.

## Baseline (red)

Not yet run — same credentialing blocker as the sibling scenario. Expected red:
pre-Task-9 `commands/doctor.md` has no `drift <path>` invocation documented and
pre-Task-7 `scripts/doctor.mjs` has no `--drift` flag, so the mode does not exist to
run at all.

## Result (green)

Not yet run — same blocker. What would prove it: the run above against the
working-tree text, checked against criteria 1-4.
