# Finishing the Cycle

The pipeline's last stage, run by both `/devcycle:cycle` and `/devcycle:continue`: resolve the
effective git policy, act on it, then close the state file.

The configured policy resolves from `${user_config.gitPolicy}` — `local-commits-only`
(default), `push-allowed`, or `open-pr` — read once per run; this stage never re-offers the
first-run configuration walkthrough, which belongs to `/devcycle:cycle` alone.
`local-commits-only` is already the floor, so it needs no further checks; for the other two,
the stage checks two signals before pushing anything: a **permission-settings signal** (any
effective Claude Code settings file carries a `deny` rule matching `git push`) and a
**protected-branch signal** (this cycle's branch, from `.devcycle/state.md`, is the repo's
resolved default branch). Either signal firing clamps the **effective policy** to
`local-commits-only` regardless of what was configured — silently, but always narrated in the
handoff's `Git policy:` line.

Acting on the effective policy is the same three-way split as the intent it clamps from:
`local-commits-only` just hands the branch back with its commits; `push-allowed` pushes it and
never merges; `open-pr` pushes and opens a PR whose title parses as a Conventional Commit and
matches this run's derived commit convention, and is likewise never merged. Before the state
file closes, two more gates run: a redaction screen (`redaction-check.mjs`) over the real,
gitignored `.devcycle/` directory and the run-record store — CI's own screen never reaches
either, so this is their only check, and a non-zero exit stops the stage rather than continuing
past an unscreened finding — and a workload-signature append (`run-record.mjs workload`) that
records only counts and enums (request kind, base sha, planned task/wave counts) and never
paths or prose. That append is a final refresh, not the primary collection: the
`hooks/workload-sensor.mjs` commit-sensor already writes the same record progressively on every
commit during the run, and the last-wins join makes this closing write harmless. The stage's
final write to `.devcycle/state.md` sets `stage: done`.

Before offering any cleanup, the stage unconditionally copies this cycle's audit trail —
`ledger.md` plus the `briefs/`, `evidence/`, `findings/`, and `reports/` directories — into
`.devcycle/archive-<date>-<branch-slug>/`, first moving any superseded findings-loop status
files into that same archive. Only then does it offer, in one question, to delete the ephemeral
set that only ever existed to pass content between this cycle's dispatches
(`.devcycle/reports/*`, `.devcycle/evidence/*`, `.devcycle/findings/*`, sweep-argument/report
files, generated per-task briefs); anything short of an explicit yes leaves every file in
place, and the state file, ledger, scope, spec, plan, checklist, and on-device results — plus
anything git-tracked — are never removed regardless of the answer.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — where finish sits, the pipeline's last stage.
- Source: [`playbooks/finishing-the-cycle.md`](../../../playbooks/finishing-the-cycle.md) — the
  behavior spec this page summarizes.

```mermaid
---
title: finishing-the-cycle — policy resolution through cleanup
accDescr: Playbook-internal flowchart of the finish stage, from resolving the configured git policy through the permission and protected-branch signal checks, acting on the effective policy, the redaction and workload gates, the unconditional archive copy, and the ephemeral-cleanup offer.
---
flowchart TD
    CFG("Resolve the configured gitPolicy — local-commits-only | push-allowed | open-pr"):::stage
    CFG --> FLOOR{"already local-commits-only?"}:::stage
    FLOOR -->|"yes — no signal checks needed"| ACT
    FLOOR -->|"no"| SIGNALS{"permission-deny on git push, or is this branch the repo's default branch?"}:::stage
    SIGNALS -->|"either fires"| CLAMP("Effective policy clamps to local-commits-only — narrated, not paused"):::stage
    SIGNALS -->|"neither fires"| ACT
    CLAMP --> ACT
    ACT{"Act on the effective policy"}:::stage
    ACT -->|"local-commits-only"| HANDBACK("Hand the branch back — no push"):::stage
    ACT -->|"push-allowed"| PUSH("Push the branch — never merge"):::stage
    ACT -->|"open-pr"| PR("Push + open a Conventional-Commit-titled PR — never merge"):::stage
    HANDBACK --> REDACT
    PUSH --> REDACT
    PR --> REDACT
    REDACT{"redaction-check.mjs over .devcycle/ and the run-record dir — exit 0?"}:::stage
    REDACT -->|"no"| STOP[("stage stops — surface the finding")]:::structural
    REDACT -->|"yes"| RECORD("Append the workload signature via run-record.mjs"):::stage
    RECORD --> ARCHIVE[("Archive ledger, briefs, evidence, findings, reports into .devcycle/archive-&lt;date&gt;-&lt;branch-slug&gt;/")]:::structural
    ARCHIVE --> CLEAN("Offer to delete the ephemeral set — one question, removes only on explicit yes"):::stage
    CLEAN --> DONE("stage: done — handoff"):::stage

    classDef stage fill:#EEEDFE,stroke:#534AB7,color:#3C3489;
    classDef tool fill:#E1F5EE,stroke:#0F6E56,color:#085041,stroke-dasharray:5 5;
    classDef structural fill:#F1EFE8,stroke:#5F5E5A,color:#444441;
```

Playbook-internal — for where finish sits in the pipeline, see
[docs/pipeline/](../../pipeline/README.md).
