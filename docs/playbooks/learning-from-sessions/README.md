# Learning from Sessions

The standalone command `/devcycle:learn`'s playbook: observe → propose → confirm → land, one
loop mining this repo's sessions and memory for recurring patterns — entered directly, never as
a stage of the guided cycle, and it starts no cycle.

The loop plans its corpus from `dream.mjs --plan` rather than walking transcripts directly; the
run-record journal is read first and is never itself mined, so a cold-start repo with no journal
falls through to the memory store and mining rather than reporting nothing found. Each unmined
slice the resolved profile admits — the memory store at every profile, archives/findings/ledgers
and user-correction turns at `standard`/`thorough`, raw transcripts at `thorough` only — gets one
fast-tier dispatch that writes and self-verifies its own observation file, so an interrupted run
resumes rather than re-mining. A single dispatch then reads the full deduped observation store
plus the journal's grouped events, assigns every candidate a stable culprit-id before clustering,
screens for anything sensitive, partitions bulk from explicit candidates, and checks recurrence
(`standard`/`thorough`) against prior promotions. The result is written as one dated candidate
JSON and rendered into a proposal document, advancing the corpus checkpoint — `--preview` stops
here, landing nothing.

A default run instead carries that proposal into **Confirm**: bulk candidates get one reviewed
decision for the whole partition, explicit candidates (sensitive-flagged, and every
contradiction) each need their own `AskUserQuestion`; every candidate is routed by fault
(`repo` vs. `pipeline`, the latter never landing locally) and, for repo-fault candidates, by
scope (`repo-devs` vs. `just-me`); every landing's placement is resolved against the target
section's cap before it can land, with an eviction shown and approved rather than silently
displacing another line. **Land** then applies each adopted candidate at the highest mechanizable
rung — r3 mechanical check, r2 lessons-digest line, r1 always-loaded prose (only with a recorded
justification), or r0 memory — records the promotion, and offers to commit the freshly written
output before re-rendering the report in outcome mode and rewriting the run's own checkpoint.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — devcycle's guided cycle; `learn` sits outside it
  as a standalone entry point.
- Source: [`playbooks/learning-from-sessions.md`](../../../playbooks/learning-from-sessions.md) —
  the behavior spec this page summarizes.

```mermaid
---
title: learning-from-sessions — the observe-propose-confirm-land loop
accDescr: Playbook-internal flowchart of the learn loop, from planning the corpus and mining unmined slices, through clustering, screening and recurrence-checking into a rendered candidate proposal, the --preview exit, and a default run's Confirm routing and ladder-first Land steps ending at the outcome-mode report.
---
flowchart TD
    PLAN("Plan the corpus — dream.mjs --plan; journal read first, never mined"):::stage
    PLAN --> MINE("Mine each unmined slice — one fast-tier dispatch per slice, self-verified write"):::stage
    MINE --> CLUSTER("Cluster, screen, check recurrence — assign culprit-ids, partition bulk/explicit"):::stage
    CLUSTER --> CANDFILE[("dated candidates.json + rendered proposal doc")]:::structural
    CANDFILE --> PREVIEW{"--preview?"}:::stage
    PREVIEW -->|yes| STOP(["candidates delivered — nothing lands"]):::tool
    PREVIEW -->|no| CONFIRM("Confirm — bulk/explicit disposition, fault + scope routing, eviction resolution"):::stage
    CONFIRM --> LAND("Land, ladder-first — r3 mechanical > r2 digest line > r1 always-loaded prose > r0 memory"):::stage
    LAND --> OUTCOME[("outcome-mode report + advanced checkpoints")]:::structural

    classDef stage fill:#EEEDFE,stroke:#534AB7,color:#3C3489;
    classDef tool fill:#E1F5EE,stroke:#0F6E56,color:#085041,stroke-dasharray:5 5;
    classDef structural fill:#F1EFE8,stroke:#5F5E5A,color:#444441;
```

Playbook-internal — for where learning sits relative to the pipeline, see
[docs/pipeline/](../../pipeline/README.md).
