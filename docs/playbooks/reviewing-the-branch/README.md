# Reviewing the Branch

The pipeline's branch-review stage: the gate between execution and finishing, one review of
everything the branch does against the spec that ordered it, before on-device verification.

This stage takes just three inputs from the execution handoff — the branch, the spec path, and
the ledger path — and delegates engine choice in full to `reviewing-code` (below): which of
`panel` or `single` runs (under `reviewDepth: auto`, the default, sized from the branch diff by
that playbook's § 3), how an oversize diff is chunked, and the `panel→single` degradation are
all that engine's rules, restated nowhere here. The report's `Depth:` line says which engine was
picked and why, and in a cycle the stage records the engine that actually ran in the run record,
so doctor can compare single and panel runs. What this stage owns instead is its own
**spec-compliance layer** (every requirement the spec states is checked against the whole
branch, not just the diff, and the ledger is cross-checked so every committed task is on the
branch and nothing on the branch lacks a ledger trail) and its **findings loop**: round 1
reviews the whole branch; only `critical`/`high` findings are blocking and re-open the loop;
each blocking finding goes to a fresh implementer dispatch the coordinator commits before a
narrow re-review of just that fix; and the loop is bounded by a per-cycle round cap tracked
through `.devcycle/ledger.md`'s `review-round` events. A round that dies stays spent, and on the panel
the next round runs only the lenses and refutations missing from `.devcycle/review/round-<d>/`; a
`single` round re-runs whole. The cap bounds effort, never truth — it
never converts an outstanding blocking finding into a pass.

The stage ends in exactly one of two verdicts: `resolved` (no blocking findings outstanding;
any residue is carried over as non-blocking) or `exhausted-unresolved` at the cap (the stage
stops and reports the outstanding findings for a user decision, never proceeding to on-device or
finishing).

On `resolved` it also decides where the cycle goes next. It skips on-device only when two
signals agree: execution recorded no checklist, and the rendered-surface trace
[`references/checklist.md`](../../../references/checklist.md) owns finds nothing that renders in
the branch's diff. It then records on-device as skipped, moves the state file to finish, and
hands off through one `Clear + /devcycle:continue` boundary with the skip and its reason in the
carry-overs. A trace that finds a rendered surface, or any doubt, goes to on-device as before.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — where branch review sits, between execution and
  on-device verification.
- Source: [`playbooks/reviewing-the-branch.md`](../../../playbooks/reviewing-the-branch.md) — the
  behavior spec this page summarizes.
- Engine: [`reviewing-code`](../reviewing-code/README.md) — the shared engine this stage
  delegates engine selection and dispatch to.

```mermaid
---
title: reviewing-the-branch — the findings loop and the on-device call
accDescr: Playbook-internal flowchart of the branch-review findings loop, from round 1's whole-branch review through the blocking-findings check, the round-cap check, fresh implementer dispatches for blocking findings, and narrow re-review, to the resolved or exhausted-unresolved verdict; on resolved, the stage skips on-device straight to finish when no checklist exists and nothing renders, and goes to on-device otherwise.
---
flowchart TD
    R1("Round 1 — review the whole branch"):::stage
    R1 --> BLOCKING{"blocking findings outstanding? (critical/high)"}:::stage
    BLOCKING -->|no| RESOLVED[("verdict: resolved")]:::structural
    BLOCKING -->|yes| CAP{"round cap reached?"}:::stage
    CAP -->|yes| EXHAUSTED[("verdict: exhausted-unresolved — stop for a user decision")]:::structural
    CAP -->|no| FIX("Fresh implementer dispatch per blocking finding; coordinator commits each fix"):::stage
    FIX --> RN("Round N — re-run the same engine over just the fix diff, plus the findings it raised"):::stage
    RN --> BLOCKING
    RESOLVED --> APPLIES{"checklist: none and nothing renders?"}:::stage
    APPLIES -->|"yes — on-device skipped"| FINISH(["finish, after one clear"]):::tool
    APPLIES -->|"no, or any doubt"| ONDEV(["on-device verification"]):::tool

    classDef stage fill:#EEEDFE,stroke:#534AB7,color:#3C3489;
    classDef tool fill:#E1F5EE,stroke:#0F6E56,color:#085041,stroke-dasharray:5 5;
    classDef structural fill:#F1EFE8,stroke:#5F5E5A,color:#444441;
```

Playbook-internal — for where branch review sits in the pipeline, see
[docs/pipeline/](../../pipeline/README.md).
