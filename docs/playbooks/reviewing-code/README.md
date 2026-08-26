# Reviewing Code

The shared review engine: the pipeline's Audit stage, standalone `/devcycle:review`, and
`maintaining-the-repo` (which wraps it for `/devcycle:maintain`'s fold-in reviews) all dispatch
into it as **audit runs**; the branch-review stage below is a fourth, in-cycle caller that skips
its interview and document.

Given a scope (`branch`, `repo`, or `files`) and a set of criteria, this engine answers one
question: what is wrong with this code? Which caller invoked it decides more than the scope
does. An audit run — `/devcycle:review` standalone, the pipeline's Audit stage, or
`maintaining-the-repo` — runs a criteria interview first (never assuming criteria; drafted from
a repo-convention and stack-detection discovery pass, then confirmed with you) and ends by
writing a ranked findings document. The branch-review stage instead inherits the cycle's spec
criteria, skips the interview, and takes its findings back inline rather than writing a
document.

Internally, the confirmed criteria are grouped into **2–5 lens charters by kind, not by
count** — related criteria share a charter so each reviewer holds something it can actually
hold, and a lens is never one criterion wide. `reviewDepth` then picks the engine: `panel`
dispatches every charter through `workflows/review-panel.js` as one JSON argument (`scope`,
`specPath`, a `lenses` array of `{key, charter}` objects, and a `crossModel` flag that adds a
non-Claude lens via the `codex` CLI); `single` runs the same charters as inline read-only
reviewers instead — a complete review in its own right, not a degraded panel. A non-zero or
missing `review-panel.js` degrades to `single`, disclosed verbatim in the engine line rather
than silently substituted. Every finding is then adversarially refuted by a second reader,
deduplicated across lenses, and ranked before anything is reported.

Reviewers work from fresh context — the scope, criteria, and spec path only, never the
authoring conversation — and never write the tree they're reviewing (formatters and linters run
check-mode only). Only an audit run takes the final step: writing
`docs/audits/YYYY-MM-DD-<topic>.md`, complete with a coverage statement and a provenance header,
then committing it scoped to that one path. A branch-review run returns findings and an engine
line and stops there — the rounds-and-cap loop, the ledger cross-check, and the handoff belong
to that stage, not this one.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — where the Audit stage sits.
- Source: [`playbooks/reviewing-code.md`](../../../playbooks/reviewing-code.md) — the behavior
  spec this page summarizes.
- Other callers: [`playbooks/maintaining-the-repo.md`](../../../playbooks/maintaining-the-repo.md)
  wraps this engine for `/devcycle:maintain`; standalone
  [`commands/review.md`](../../../commands/review.md) runs it directly, outside any cycle.

```mermaid
---
title: reviewing-code — lens construction through the findings hand-off
accDescr: Playbook-internal flowchart of the review engine, from criteria selection through lens-charter grouping, parallel per-charter dispatch with an optional cross-model lens, aggregation, and either an audit run's findings document or a branch-review's inline return.
---
flowchart TD
    CRIT("Criteria selected — an audit run's interview, or a branch-review's inherited spec criteria"):::stage
    CRIT --> CHARTER("Group into 2–5 lens charters, by kind"):::stage
    CHARTER --> DISPATCH("Dispatch each lens charter in parallel"):::stage
    DISPATCH --> XM{"crossModel set?"}:::stage
    XM -->|yes| XMLENS("+ one non-Claude lens via the codex CLI"):::stage
    XM -->|no| AGG
    XMLENS --> AGG
    AGG("Refute each finding, dedup across lenses, rank"):::stage
    AGG --> CALLER{"audit run or branch-review?"}:::stage
    CALLER -->|"audit run"| DOC[("docs/audits/YYYY-MM-DD-&lt;topic&gt;.md")]:::structural
    CALLER -->|"branch-review"| RETURN("Return findings inline — this playbook's role ends here"):::stage

    classDef stage fill:#EEEDFE,stroke:#534AB7,color:#3C3489;
    classDef tool fill:#E1F5EE,stroke:#0F6E56,color:#085041,stroke-dasharray:5 5;
    classDef structural fill:#F1EFE8,stroke:#5F5E5A,color:#444441;
```

Playbook-internal — for where Audit sits in the pipeline, see
[docs/pipeline/](../../pipeline/README.md).
