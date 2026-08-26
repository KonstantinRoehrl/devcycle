# Maintaining the Repo

The standalone command `/devcycle:maintain`'s playbook: assess a repository's longitudinal
health and stop at a ranked findings document — it starts no cycle, and it is entered directly
rather than reached as a pipeline stage.

This playbook adds no control plane of its own; it mostly hands off to
[`reviewing-code`](../reviewing-code/README.md), which is why there is no diagram here beyond
that hand-off — a box pointing at another box would say nothing a sentence doesn't already say.
What this playbook contributes on top of the engine: it resolves a maintenance depth (`lean` /
`standard` / `thorough`) that gates which criteria apply, orients the pass graph-first (an
availability probe picks a graph-backed research dispatch over a bounded `Explore` fallback),
and runs a deterministic-facts pre-pass — dependency audit, lint, the duplication and dead-export
checks, cross-reference checking — so the engine's lenses receive tooling facts instead of
re-deriving them. The confirmed criteria (plus **Abstraction** at `standard`, plus a history
inspector's signal at `thorough`) are then handed to `reviewing-code.md` at `repo` scope, which
owns the panel dispatch, dedup-and-rank, and the ranked `docs/audits/` document itself.

Two things this playbook still owns end to end. First, a second input source folds in at every
depth: the target repo's own open GitHub issues, fetched read-only, decomposed into
independently verifiable claims, classified (bug/refactor fragments become candidates, feature
fragments are counted but excluded), verified against an existing lens methodology, then ranked
into the same list as the lens findings — distinguished only by provenance, never by rank.
Second, cross-pass memory: each finding gets a stable id, is compared against a prior-pass store
to render as persisting/resolved/regressed/new, can be dismissed with a load-bearing reason, and
is persisted back to that store — the only new write this read-only playbook makes.

A fan-out ceiling bounds the whole pass: at most 5 concurrent panel lenses and 8 total LLM
dispatches, with a hard stop at the ≥20% context-depth band. The playbook mutates no code and no
GitHub issue at any depth; selecting a finding to act on starts a separate `/devcycle:cycle`.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — devcycle's guided cycle; `maintain` sits
  outside it as a standalone entry point.
- Source: [`playbooks/maintaining-the-repo.md`](../../../playbooks/maintaining-the-repo.md) — the
  behavior spec this page summarizes.
- Engine: [`reviewing-code`](../reviewing-code/README.md) — the review engine this playbook
  wraps rather than duplicates; see that page for the lens-charter and panel-dispatch mechanics.
