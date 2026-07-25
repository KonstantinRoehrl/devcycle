---
description: "Run the devcycle pipeline: triage a feature/bug/refactor description, then walk scoping → spec → plan → execution → review → verification."
---

# /devcycle:cycle

Run the devcycle pipeline for the request in `$ARGUMENTS`. Files are the state; the
conversation is a cache — every stage writes its artifacts to disk so the pipeline
survives `/clear` and resumes via `/devcycle:continue`.

## Configuration

Knob values arrive via `${user_config.KEY}` placeholders, each read by the stage
skill that consumes it (gitPolicy by `devcycle:finishing-the-cycle`, models and
review depth and the on-device gate by their stages). The resolution convention,
everywhere: a value that still reads as a literal `${user_config...}` placeholder
is unset, and a value outside its allowed set is invalid — both fall back to the
knob's documented default. When a knob's placeholder is literal but the state
file's `configured:` line records a value for it (first-run walkthrough below),
that recorded value governs this run — same-session substitution cannot refresh,
so `--config` writes only reach future sessions.

## Step 0 — create the state file (FIRST action, binding)

Before triage, before any stage work, before any other output: ensure the state
file exists at exactly `<repo root>/.devcycle/state.md`, where repo root is
`git rev-parse --show-toplevel` of the current working directory — never a state
file found anywhere else (a parent directory, a sibling checkout, a search hit).
If it is absent, create it with `stage: scoping`, the current repo root and
branch, a one-line `request:` distilled from `$ARGUMENTS`, `configured: no`, and
`none` for every artifact line.

**Ownership check first, on any existing file:** if its `root:` line differs
from the current repo root, the file belongs to another checkout or leaked from
another project — never resume or silently reset it. Tell the user what its
`root:` and `request:` say, and let them choose: adopt it (the repo genuinely
moved — rewrite `root:` to the current toplevel, keep everything else) or start
fresh. A file with no `root:` line predates this format and is not foreign:
adopt it by writing `root:` and `request:` at the next rewrite.

Then: if the file has `stage: done` (a prior completed cycle in this repo),
carry its `configured:` line forward unchanged and reset every other line for
the new cycle (fresh `request:` included). If it has any OTHER stage, an
in-flight cycle exists: do NOT reset it — tell the user, naming its stage,
branch, and `request:`, and offer to resume it via `/devcycle:continue` or to
start over; only on explicit confirmation of starting over reset the file
(carrying `configured:` forward as above). This shape is the single source of
truth — every later rewrite uses exactly it:

```markdown
# devcycle state
- stage: <scoping|diagnosis|brainstorm|planning|execution|branch-review|on-device|finish|done>  (the stage to RESUME at)
- root: <absolute repo toplevel this cycle belongs to>
- branch: <git branch>
- request: <one line: what this cycle is building/fixing>
- scope: <path or none>
- diagnosis: <path or none>
- spec: <path or none>
- plan: <path or none>
- ledger: .superpowers/sdd/progress.md
- checklist: <path or none>
- configured: <no | defaults | date + KEY=VALUE list>
- updated: <ISO-8601 UTC>
```

`root:` and `request:` pin the file to one project and one goal: every reader
verifies `root:` against its own `git rev-parse --show-toplevel` before trusting
anything else in the file.

`stage:` records the stage the NEXT session should resume at, never the stage
just completed: at every transition, write the upcoming stage's name.

Creating this file is the pipeline's first action, not a side effect of the first
stage transition — a cycle interrupted mid-scoping must still leave a state file
for `/devcycle:continue` to resume from. If triage (below) picks a later entry
stage, that is a stage transition: rewrite the file then.

## First-run configuration (after Step 0, before triage)

Offer a one-time configuration walkthrough if and only if BOTH hold:
`${user_config.gitPolicy}`, `${user_config.reviewDepth}`,
`${user_config.crossModelReview}`, and `${user_config.onDeviceGate}` all still
render as literal `${user_config` placeholders, AND the state file's
`configured:` line reads `no`. Otherwise skip straight to triage.

The walkthrough is ONE AskUserQuestion batch over those four knobs — one line
of meaning each, the default marked "(recommended)" — plus a first-class
option **"use defaults, don't ask again"**:

- `gitPolicy` — what the finish stage may do with the branch
  (`local-commits-only` recommended · `push-allowed` · `open-pr`).
- `reviewDepth` — branch review engine (`single` recommended · `panel`).
- `crossModelReview` — add a cross-model lens to the review panel
  (`false` recommended · `true`).
- `onDeviceGate` — whether the on-device checklist closes only via a human
  walkthrough (`human-required` recommended · `auto-ok`).

Model knobs are excluded: models are chosen automatically per task unless you
pin one in `/plugin configure`.

Apply the answers via `claude plugin install devcycle@devcycle --config
KEY=VALUE` (one `--config` per knob) — including on "use defaults": write the
explicit default values, so the placeholders substitute in future sessions and
this offer never fires again. Record the answers in the state file's
`configured:` line — `defaults`, or the date plus the KEY=VALUE list. Because
same-session substitution cannot refresh, stage skills read THIS run's values
from that line (see Configuration above).

## Triage the input

Judge `$ARGUMENTS` on two axes and announce both verdicts with the entry stage
before proceeding.

**Maturity** picks the entry stage:

- **Rough idea, vague ticket, or one-liner** (scope, intent, or constraints not yet
  established) → start at the **scoping** stage.
- **Detailed ticket or spec** (concrete requirements, constraints, acceptance
  criteria already established) → skip scoping; start at **brainstorm** as a
  validation pass of the provided material. If an approved spec document already
  exists on disk, start at **planning**.

**Kind** (feature | bug | refactor) shapes the walk:

- **Bug** → the **diagnosis** stage runs between scoping and brainstorm unless the
  input already names the root cause with evidence (not a hunch — a stated cause
  plus how it was established). You cannot spec a fix for an undiagnosed problem:
  scoping for a bug collects the symptom and reproduction, diagnosis establishes
  the cause, and only then is a fix designed. A mature bug ticket with
  reproduction but unknown cause enters at **diagnosis**, not brainstorm.
- **Feature / refactor** → diagnosis is skipped (its handoff block still records
  the skip only when the stage was entered and judged inapplicable; a kind that
  never routes there emits nothing).

## State file

Maintain `.devcycle/state.md` (created in Step 0) and rewrite it at EVERY stage
transition, in exactly Step 0's shape with current values: `stage:` names the
stage to resume at (the upcoming stage), and the `configured:` line is always
preserved.

## Stage walk

Run the stages in order, each via the named skill:

1. **scoping** — `devcycle:scoping-interview` (skipped for mature input per triage).
2. **diagnosis** (bugs only, per triage) — `superpowers:systematic-debugging`
   (upstream, unmodified): reproduce the failure first, then isolate the root
   cause. The stage ends with a root-cause report written to
   `.devcycle/diagnosis.md` — reproduction steps, the established cause with its
   evidence, and the surfaces involved — recorded in the state file's
   `diagnosis:` line. The report pins the reproduction precisely enough for
   planning to turn it into the fix task's failing test. Design questions
   (how to fix it) stay out: they belong to brainstorm, which takes this report
   as its explored context. If diagnosis overturns the confirmed scope (the bug
   lives somewhere else entirely), say so and return to scoping rather than
   designing a fix for the wrong problem.
3. **brainstorm** — `superpowers:brainstorming` (upstream, unmodified), with two
   notes layered on top. First: the user's batching preference carries into this
   stage — where the upstream skill says to ask questions one at a time, ask via
   AskUserQuestion in batches of 1–4 with concrete options plus Other instead.
   Second: before upstream's "commit the design document to git" step, check
   whether the spec's path is covered by the target repo's own `.gitignore`
   (`git check-ignore`); if so, write the file but skip the commit — respect the
   repo's own ignore rules rather than force-adding past them. Everything else
   upstream stands. When the spec is approved, transition to
   `devcycle:planning-waves` (not directly to upstream writing-plans).
4. **planning** — `devcycle:planning-waves`.
5. **execution** — `devcycle:executing-waves`.
6. **branch-review** — `devcycle:reviewing-the-branch`.
7. **on-device** — `devcycle:verifying-on-device` (skip only when the change has no
   rendered/on-device surface; record the skip in the handoff).
8. **finish** — `devcycle:finishing-the-cycle`: resolves the effective git policy
   (the configured `gitPolicy` clamped by two external push signals), acts on it,
   and closes the state file with `stage: done`.

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

At a wave → wave boundary within execution the first field is instead
`Wave completed: <n> of <m> (stage: execution)` — `Stage completed:` is
reserved for true stage ends. These are the only two sanctioned first-field
labels.

At the finish stage specifically, the block carries one additional line, directly after
`Artifacts:` — the resolved git policy, in the exact shape `devcycle:finishing-the-cycle`
defines. No other stage's block carries this line.

Pick the context action from this table and recommend it to the user explicitly:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| scoping → diagnosis (bugs) | Continue | everything | — |
| diagnosis → brainstorm (root cause established) | Compact with hint | diagnosis report path, reproduction steps, root cause | debugging transcripts, ruled-out hypotheses |
| brainstorm → planning (spec approved) | Compact with hint | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Compact if over ~40% context | ledger/plan paths, pinned interfaces, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear + `/devcycle:continue` or Fresh session (a reviewer that watched the code being written inherits the implementer's assumptions) | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |

### Await the context action — never run past a recommended compact or clear

Emitting the handoff block is NOT permission to continue. **Only a `Continue` action lets the
pipeline proceed to the next stage in the same turn.** For every other action — `Compact with
hint`, `Clear + /devcycle:continue`, `Fresh session`, or a `wave → wave` boundary where the
~40% condition to compact is met — STOP after the block and wait: the user must run `/compact`
or `/clear` (or explicitly tell you to continue anyway) before any next-stage work begins. Never
begin the next stage in the same response that recommended a compact or clear — a user who looks
away would otherwise sail past the boundary with an un-cleared context, exactly what this gate
prevents. `/clear` ends the session by design; state the `/devcycle:continue` resume path in the
same message you halt on.
