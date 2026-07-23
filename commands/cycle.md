---
description: "Run the devcycle pipeline: triage a feature/bug/refactor description, then walk scoping → spec → plan → execution → review → verification."
disable-model-invocation: true
---

# /devcycle:cycle

Run the devcycle pipeline for the request in `$ARGUMENTS`. Files are the state; the
conversation is a cache — every stage writes its artifacts to disk so the pipeline
survives `/clear` and resumes via `/devcycle:continue`.

## Configuration

Git policy for the finish stage: `${user_config.gitPolicy}` — if that value still
begins with the literal text `${user_config`, the option is unset; use the
default `local-commits-only`. Allowed values: `local-commits-only`, `push-allowed`,
`open-pr`; treat anything else as invalid and fall back to the default. Other knobs
(models, review depth, on-device gate) are read the same way, via their own
`${user_config.KEY}` placeholders, by the stage skills that consume them.

## Step 0 — create the state file (FIRST action, binding)

Before triage, before any stage work, before any other output: create
`.devcycle/state.md` in the target repo with exactly this content (stage `scoping`,
the current branch, artifact lines empty):

```markdown
# devcycle state
- stage: scoping
- branch: <current git branch>
- spec: none
- plan: none
- ledger: .superpowers/sdd/progress.md
- checklist: none
- updated: <ISO-8601 UTC>
```

Creating this file is the pipeline's first action, not a side effect of the first
stage transition — a cycle interrupted mid-scoping must still leave a state file
for `/devcycle:continue` to resume from. If triage (below) picks a later entry
stage, that is a stage transition: rewrite the file then.

## Triage the input

Judge the maturity of `$ARGUMENTS`:

- **Rough idea, vague ticket, or one-liner** (scope, intent, or constraints not yet
  established) → start at the **scoping** stage.
- **Detailed ticket or spec** (concrete requirements, constraints, acceptance
  criteria already established) → skip scoping; start at **brainstorm** as a
  validation pass of the provided material. If an approved spec document already
  exists on disk, start at **planning**.

Announce the triage verdict and the entry stage before proceeding.

## State file

Maintain `.devcycle/state.md` (created in Step 0) and rewrite it at EVERY stage
transition, exactly this shape:

```markdown
# devcycle state
- stage: <scoping|brainstorm|planning|execution|branch-review|on-device|finish>
- branch: <git branch>
- spec: <path or none>
- plan: <path or none>
- ledger: .superpowers/sdd/progress.md
- checklist: <path or none>
- updated: <ISO-8601 UTC>
```

## Stage walk

Run the stages in order, each via the named skill:

1. **scoping** — `devcycle:scoping-interview` (skipped for mature input per triage).
2. **brainstorm** — `superpowers:brainstorming` (upstream, unmodified), with one
   note layered on top: the user's batching preference carries into this stage —
   where the upstream skill says to ask questions one at a time, ask via
   AskUserQuestion in batches of 1–4 with concrete options plus Other instead.
   Everything else upstream stands. When the spec is approved, transition to
   `devcycle:planning-waves` (not directly to upstream writing-plans).
3. **planning** — `devcycle:planning-waves`.
4. **execution** — `devcycle:executing-waves`.
5. **branch-review** — `devcycle:reviewing-the-branch`.
6. **on-device** — `devcycle:verifying-on-device` (skip only when the change has no
   rendered/on-device surface; record the skip in the handoff).
7. **finish** — per the git policy resolved above:
   - `local-commits-only`: hand the branch back — report branch name and commits;
     do not push, do not open a PR.
   - `push-allowed`: push the branch; NEVER merge it.
   - `open-pr`: push the branch and open a PR whose title parses as a Conventional
     Commit; do not merge it.

## Stage boundaries

At every boundary: update `.devcycle/state.md`, then emit the handoff block as the
stage's final output. **One block per completed stage, no batching:** when several
stages complete in a single response or session, each stage still emits its own
`## Handoff` block, in order, at that stage's end — never one merged or summary
block for the run. A stage that is skipped or judged not applicable (e.g.
on-device with no rendered surface) still emits its block: the skip IS the stage
outcome. The finish stage emits the pipeline's final block. The block shape:

```markdown
## Handoff
- Stage completed: <stage>
- Artifacts: <paths, one per line>
- Carry-overs: <pinned interfaces / open decisions, or "none">
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <X>. Drop <Y>.
```

Pick the context action from this table and recommend it to the user explicitly:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| brainstorm → planning (spec approved) | Compact with hint | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Compact if over ~40% context | ledger/plan paths, pinned interfaces, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear or fresh agents (a reviewer that watched the code being written inherits the implementer's assumptions) | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |
