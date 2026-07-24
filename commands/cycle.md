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
When a knob's own placeholder is literal but the state file's `configured:`
line records a value for it (first-run walkthrough below), that recorded value
governs this run — same-session substitution cannot refresh, so `--config`
writes only reach future sessions.

## Step 0 — create the state file (FIRST action, binding)

Before triage, before any stage work, before any other output: ensure
`.devcycle/state.md` exists in the target repo. If it is absent, create it with
`stage: scoping`, the current branch, `configured: no`, and `none` for every
artifact line. If a state file already exists with `stage: done` (a prior
completed cycle in this repo), carry its `configured:` line forward unchanged
and reset every other line the same way. If it exists with any OTHER stage, an
in-flight cycle exists: do NOT reset it — tell the user, naming its stage and
branch, and offer to resume it via `/devcycle:continue` or to start over; only
on explicit confirmation of starting over reset the file (carrying
`configured:` forward as above). This shape is the single source of truth —
every later rewrite uses exactly it:

```markdown
# devcycle state
- stage: <scoping|brainstorm|planning|execution|branch-review|on-device|finish|done>  (the stage to RESUME at)
- branch: <git branch>
- scope: <path or none>
- spec: <path or none>
- plan: <path or none>
- ledger: .superpowers/sdd/progress.md
- checklist: <path or none>
- configured: <no | defaults | date + KEY=VALUE list>
- updated: <ISO-8601 UTC>
```

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
transition, in exactly Step 0's shape with current values: `stage:` names the
stage to resume at (the upcoming stage), and the `configured:` line is always
preserved.

## Stage walk

Run the stages in order, each via the named skill:

1. **scoping** — `devcycle:scoping-interview` (skipped for mature input per triage).
2. **brainstorm** — `superpowers:brainstorming` (upstream, unmodified), with two
   notes layered on top. First: the user's batching preference carries into this
   stage — where the upstream skill says to ask questions one at a time, ask via
   AskUserQuestion in batches of 1–4 with concrete options plus Other instead.
   Second: before upstream's "commit the design document to git" step, check
   whether the spec's path is covered by the target repo's own `.gitignore`
   (`git check-ignore`); if so, write the file but skip the commit — respect the
   repo's own ignore rules rather than force-adding past them. Everything else
   upstream stands. When the spec is approved, transition to
   `devcycle:planning-waves` (not directly to upstream writing-plans).
3. **planning** — `devcycle:planning-waves`.
4. **execution** — `devcycle:executing-waves`.
5. **branch-review** — `devcycle:reviewing-the-branch`.
6. **on-device** — `devcycle:verifying-on-device` (skip only when the change has no
   rendered/on-device surface; record the skip in the handoff).
7. **finish** — resolve the effective git policy, then act on it. Call the value
   resolved above (Configuration section) the **configured policy**.

   **Resolve effective policy.** If the configured policy is `local-commits-only`, it is
   already the floor — skip straight to "Act on the effective policy" below, effective
   equals configured, no signal checks needed. Otherwise (`push-allowed` or `open-pr`),
   check two signals before pushing anything:

   - **Permission-settings signal:** read the effective Claude Code permission settings —
     project `.claude/settings.local.json`, project `.claude/settings.json`, user
     `~/.claude/settings.json`, and any managed/enterprise policy file present on this
     platform (read whichever exist; a missing file has no rules). Look for a `deny` rule
     whose pattern would match the literal `git push` command — e.g. `Bash(git push:*)`,
     `Bash(git:*)`, or a bare `Bash` deny. If any such deny rule exists in any of those
     files, this signal fires. An `ask`-only rule (no matching `deny`) does NOT fire this
     signal — leave the configured policy alone; the normal permission prompt at push time
     communicates the restriction.
   - **Protected-branch signal:** resolve the repo's release/default branch — try, in
     order, `git symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json
     defaultBranchRef`, then fall back to `main` or `master` if one of those branches
     exists and neither command is available. If the branch recorded in
     `.devcycle/state.md` (this cycle's branch) IS that default branch, this signal
     fires — devcycle never pushes directly to the repo's default branch.

   If either signal fires, the **effective policy** for this run is `local-commits-only`
   regardless of the configured value. Otherwise effective equals configured. This clamp
   is silent (no pause, no question) but always narrated — see the Handoff line below.

   **Act on the effective policy:**
   - `local-commits-only`: hand the branch back — report branch name and commits;
     do not push, do not open a PR.
   - `push-allowed`: push the branch; NEVER merge it.
   - `open-pr`: push the branch and open a PR whose title parses as a Conventional
     Commit; do not merge it.

   As the finish stage's final state-file write, set `stage: done` and a fresh
   `updated:` timestamp — nothing remains to resume.

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
`Artifacts:` — the resolved git policy. When the effective policy was not clamped:
`Git policy: <value> (no override)`. When it was clamped (Step 7 above): `Git policy:
configured <value> → effective local-commits-only (<reason>)`, where `<reason>` is `a
permission rule denies git push`, `current branch is the repo's default branch — direct
pushes to it are not allowed`, or both joined with `; ` if both signals fired. No other
stage's block carries this line.

Pick the context action from this table and recommend it to the user explicitly:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| brainstorm → planning (spec approved) | Compact with hint | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Compact if over ~40% context | ledger/plan paths, pinned interfaces, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear + `/devcycle:continue` or Fresh session (a reviewer that watched the code being written inherits the implementer's assumptions) | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |
