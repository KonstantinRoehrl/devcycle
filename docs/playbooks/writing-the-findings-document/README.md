# Writing the Findings Document

The last step of an audit run — standalone `/devcycle:review` or the pipeline's Audit stage — and
of a `/devcycle:maintain` pass. [`reviewing-code`](../reviewing-code/README.md) reads it once its
verify → dedup → rank step has returned the findings; the in-cycle branch-review stage never
reaches it, because it takes its findings back inline instead.

It writes `docs/audits/YYYY-MM-DD-<topic>.md`: every finding at the detailed document tier, a
coverage statement of what was and was not read (silent truncation never reads as completeness),
and a provenance header naming the audited branch, the audited sha, and a PR link — each line
omitted rather than guessed when it cannot be determined. Where one finding's reliability rests on
another's fix, the document says so and closes with a suggested sequencing line. The document is a
local per-run snapshot it does **not** commit (audit reports stay local at every policy depth).
Branch discipline is resolved by caller class: the cycle's own audit stage follows the cycle's
state file and hands off, standalone `/devcycle:review` cuts its own topic branch and never touches
`.devcycle/state.md`, and `/devcycle:maintain` holds no state at all. Then it stops: the user picks
a finding, and each pick starts its own `/devcycle:cycle`.

A standalone `/devcycle:review` audit run over a `branch` scope with an open PR can take one
further, opt-in step: **filing** its ranked findings onto that PR as one batched, diff-anchored
review — confirm-first behind a content gate and a post gate, read-only toward code, with every
comment body drafted through the comment-body contract
[`references/review-comments.md`](../../../references/review-comments.md) owns.

## How it fits
- Up: [`reviewing-code`](../reviewing-code/README.md) — the review engine whose audit runs and
  `/devcycle:maintain` passes end here.
- Source: [`playbooks/writing-the-findings-document.md`](../../../playbooks/writing-the-findings-document.md)
  — the behavior spec this page summarizes.
- Other callers: [`maintaining-the-repo`](../maintaining-the-repo/README.md) reaches this playbook
  through `reviewing-code`.
