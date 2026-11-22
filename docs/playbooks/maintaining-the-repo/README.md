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
and runs a deterministic-facts pre-pass — dependency audit, lint, a dead-code hygiene sweep whose candidates one verification dispatch confirms, and the duplication, dead-export and cross-reference checks only when the repo is devcycle's own source — so the engine's lenses receive tooling facts instead of
re-deriving them. The confirmed criteria (plus **Abstraction** at `standard`, plus a history
inspector's signal at `thorough`) are then handed to `reviewing-code.md` at `repo` scope, which
owns the panel dispatch and dedup-and-rank, then hands off to
[`writing-the-findings-document`](../writing-the-findings-document/README.md) for the ranked
`docs/audits/` document itself.

Two things this playbook still owns end to end. First, a second input source folds in at every
depth: the target repo's own open GitHub issues, fetched read-only and folded through the shared
pipeline `references/issue-folding.md` owns, then ranked into the same list as the lens findings —
distinguished only by provenance, never by rank. The playbook keeps only what is maintain's own: the
scoping-gate exclusion, the coverage statement and the merge.
Second, cross-pass memory: each finding gets a stable id and is compared against the prior-pass
store to render as new, persisting, or dismissed; it can be dismissed with a load-bearing reason;
and, only on the user's confirmation after a complete pass, a finding no longer detected is
resolved out of the store. Before any lens runs, a pass checks for an earlier pass's store writes
that never landed. The store is written through one command, in a worktree on its own
`chore/maintenance-findings-<date>` branch, committed and opened as a PR only on the user's say —
or, when doc tracking vetoes committing it, left uncommitted in the session's checkout (the
playbook's step 8) — which is the only write this otherwise read-only playbook makes.

Each pass mints its own run record and asks, every time, whether the sweep may run repo code: its
executing-class tools and, separately, a coverage run. The answers go on that record, with the
sweep's per-kind counts, which **Trending** compares against the latest earlier pass on this machine.
A dead-code finding resolves out of the store only when every source behind its kind ran in full.

A fan-out ceiling bounds the whole pass: at most 5 concurrent panel lenses and 9 total LLM
dispatches, with a hard stop at the ≥20% context-depth band. The playbook mutates no code and no
GitHub issue at any depth; selecting a finding to act on starts a separate `/devcycle:cycle`.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — devcycle's guided cycle; `maintain` sits
  outside it as a standalone entry point.
- Source: [`playbooks/maintaining-the-repo.md`](../../../playbooks/maintaining-the-repo.md) — the
  behavior spec this page summarizes.
- Engine: [`reviewing-code`](../reviewing-code/README.md) — the review engine this playbook
  wraps rather than duplicates; see that page for the lens-charter and panel-dispatch mechanics.
