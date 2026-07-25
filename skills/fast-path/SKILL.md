---
name: fast-path
description: Use when devcycle triage has confirmed a trivial request and the run takes the fast path — in-session implementation with evidence, one task-reviewer pass, then the finish stage.
---

# Fast Path

The mini-cycle for requests triage has judged trivial and the user has confirmed
via the AskUserQuestion gate (fast path vs. full pipeline). This skill never
re-litigates that verdict — by the time it runs, the trivial checklist has already
passed and confirmation has already happened. What it runs instead of the full
scoping → brainstorm → planning → execution → branch-review → on-device walk is a
single in-session pass: implement, commit, one reviewer pass, hand to finish. All
four guardrails a plan task would carry — branch discipline, verbatim evidence, an
escalation valve, and an independent review — still apply; only the ceremony
around them (subagents, plan file, ledger events) is dropped.

**Announce at start:** "I'm using the fast-path skill to implement this in-session."

## The mini-cycle

1. **Branch discipline.** If the current branch is the repo's default branch or an
   integration branch (e.g. `dev`), create a topic branch first. Never implement
   directly on either — this holds here exactly as it holds for every plan task.
2. **Implement in-session.** No subagents, no plan file, no ledger entries — just
   make the change. It still carries an evidence class exactly as a plan task
   would, determined already at the triage gate, with verbatim before/after
   evidence:
   - `red-green` — behavior change: capture the failing test first, then the
     passing one.
   - `green-green` — behavior-preserving: capture the same suite green before the
     change and green after.
   - `convention` — docs/config: capture the repo's own named verification
     command's output before and after.

   (Full definitions: `docs/DECISIONS.md`, 2026-07-25 entry, "per-task evidence
   classes replace unconditional red→green" — this is a restatement, not a
   redefinition.)
3. **Escalation valve.** If implementation reveals the change is not trivial after
   all — the blast radius is spreading past what triage saw, or a real design
   choice has surfaced that the request didn't settle — stop, say so, and re-enter
   the normal pipeline at whichever stage the discovery calls for (usually scoping
   or brainstorm), updating `.devcycle/state.md` accordingly. Never push a
   non-trivial change through the fast path just because it is already in flight.
4. **Commit** with a Conventional Commit subject.
5. **Light review.** Dispatch exactly ONE `devcycle:task-reviewer` subagent with
   the diff and the evidence captured in step 2. On reject: fix, re-verify the
   evidence, re-dispatch until accept. No review panel, no cross-model lens, no
   red-team — those belong to the full branch-review stage, not here.
6. **Handoff.** Emit this stage's block (`Stage completed: fast-path`), set
   `stage: finish` in `.devcycle/state.md`, and hand to
   `devcycle:finishing-the-cycle` unchanged — that skill's policy resolution and
   git action apply exactly as they do at the end of the full pipeline.

## State file

Fast-path runs still write `.devcycle/state.md` in the standard shape
(`commands/cycle.md`), with these fields specifically:

- `scope:`, `spec:`, `plan:` stay `none` — the mini-cycle produces none of them.
- `request:` carries the intent (what step 2 is implementing).
- `ledger:` stays the standard `.superpowers/sdd/progress.md` line but is unused —
  the fast path has no wave dispatches to log.

## Handoff block

```markdown
## Handoff
- Stage completed: fast-path
- Artifacts: <branch; commit sha>
- Carry-overs: <or "none">
- Context action: Continue
- Compaction hint: Keep the branch name and commit sha. Drop the implementation reasoning.
```

`Context action` is always `Continue` here — fast path and finish fit in one
session, unlike the full pipeline's stage boundaries.

## Resume (`/devcycle:continue`)

On re-entry at `stage: fast-path`, re-derive position from git evidence rather
than trusting conversation memory:

| git evidence | resume action |
| --- | --- |
| change absent, or present but uncommitted | (re)implement (step 2) |
| committed but not yet reviewed | dispatch the task reviewer (step 5) |
| review accepted | hand to `devcycle:finishing-the-cycle` (step 6) |

## Guardrails preserved vs. dropped

| Rationalization | Reality |
| --- | --- |
| "It's trivial, skip the reviewer pass" | Step 5 is not optional — one `devcycle:task-reviewer` dispatch is the floor, even for a one-line change. |
| "It's trivial, evidence isn't worth capturing" | The evidence class from step 2 still needs verbatim before/after output; "it obviously works" is not evidence. |
| "It got bigger, but I'm already halfway through" | That is exactly what the escalation valve (step 3) exists for — stop and re-enter the pipeline, don't finish a non-trivial change on the fast path because it's in flight. |
| "It's a doc/config tweak, branch discipline doesn't matter" | Step 1 applies to every fast-path change — never implement directly on the default or an integration branch. |
