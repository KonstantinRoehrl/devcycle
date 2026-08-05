---
name: verifying-on-device
description: Use when implemented changes affect rendered UI or on-device behavior that automated tests cannot fully verify, when a walkthrough of an on-device checklist is requested, or when a branch must be verified on-device without a plan — including code this session did not write.
---

# Verifying On-Device

## Overview

Rendered outcomes — how the UI looks, feels, and behaves on a real device — usually have no
proving command. For them, the human walking the running app IS the verification command.
The general claim discipline of `superpowers:verification-before-completion` (REQUIRED
background) applies unchanged: claiming a visual outcome from a script, screenshot, or code
reading is an unverified completion claim.

This skill is the on-device stage proper: walkthrough, gate, handoff. It runs in a fresh
session after the branch review, and it reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Checklist source

Two sources, one engine. Which one applies is settled before the walkthrough begins;
everything after — the walkthrough, the gate, the results report — is identical either way.

**Plan-derived (in-cycle, unchanged).** The checklist was produced during execution by
`devcycle:executing-waves`; read its path from the `checklist:` field of `.devcycle/state.md`.

**Diff-derived (standalone, `/devcycle:verify <branch>`).** No checklist exists yet: generate
one from the branch, **automatically — there is no confirmation step**, because the branch is
the whole instruction.

- *Base and changed files*: "Deriving a branch's file set" in
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md` owns both — read it there and follow it; it is
  not restated here. Its merge-base guard is what keeps the walkthrough from being handed a
  file set built from local uncommitted edits.
- *Affected UI areas*: from the changed files, trace routes, navigation, and component-usage
  outward — which screens render these components, which routes reach those screens —
  repeating until an iteration pulls in no new surface. Items are written against those
  surfaces, not against the changed files: a diff in a shared component is verified wherever
  it renders.
- *Generation*: follow `${CLAUDE_PLUGIN_ROOT}/references/checklist.md` — the same contract
  `devcycle:executing-waves` follows. Its `Where:` and `How to get there:` fields are
  REQUIRED here: without a plan, nothing else tells the human where to look.
- *Nothing renders*: if the traced set contains no rendered surface, write no checklist, and
  report the stage not applicable with that reason — the same outcome the in-cycle skip has.

The checklist is generated from git refs, so it does not need the branch checked out — that
follows from the content source `${CLAUDE_PLUGIN_ROOT}/references/branch.md` pins. The
walkthrough is the part that does: it is performed against the running app, which needs the
branch's files on disk.

When `<branch>` is not the current checkout, generate the checklist, say so plainly, and offer
two ways forward — this stage switches the checkout in neither:

- **The user checks the branch out** in the current checkout and starts the app there; or
- **a throwaway worktree**, offered exactly as `${CLAUDE_PLUGIN_ROOT}/references/branch.md`
  says to offer one. On acceptance, run the rest of the stage from that worktree: the app is
  started there and the walkthrough observes it. The checklist stays at its scratch path in
  the **invoking** checkout, not in the worktree, so removing the worktree does not take the
  run's only artifact with it.

Either way the human starts the app: this stage does not build, serve, or launch anything.

## The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Its model cannot be routed from inside it (the session and
its model already exist by the time this text is read), so the recommendation travels
producer-side: the branch-review handoff carries a `Start the fresh session on <model>`
line, resolved from `walkthroughModel` per
`${CLAUDE_PLUGIN_ROOT}/references/config.md`. When that knob derives rather than pins, the
walkthrough takes the fast tier, named explicitly per
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md` — it is interview mechanics, and per-task
derivation buys nothing here.

Interview rule: **ONE question per checklist item, never batched.** This is a deliberate
exception to devcycle's batched-interview standard — findings quality drops when items are
bundled. Each question covers exactly one item and tells the human how to observe it
(where to click, which viewport, which theme). Wait for the verdict before the next item.

The walkthrough ends with an agent-actionable results report, one line per item, plain
language, symptom first:

```markdown
## On-device results: <feature>
- <item>: passed — <what the user confirmed seeing>
- <item>: FAILED — <what the user sees instead> — severity: <high|medium|low>
```

## The gate

Resolve `onDeviceGate` per `${CLAUDE_PLUGIN_ROOT}/references/config.md` — read it and
follow it. What each resolved value means for this stage:

- `human-required`: the stage is complete ONLY when every non-`(auto)` item has a human
  verdict from the walkthrough.
- `auto-ok`: the checklist may close without a human pass — the stage may complete once all
  structurally verifiable items are `(auto)`-checked, with the remaining items left
  unchecked and listed in the handoff as unverified residue.

`auto-ok` relaxes the closing condition, never the reporting. It never licenses reporting a
walkthrough that did not run as done, and never fakes a checkmark: the handoff states which
happened — a human pass, or a close without one and what stayed unverified.

## Standalone runs

`/devcycle:verify <branch>` is not a pipeline stage and owns no cycle. Two consequences, both
binding:

- **It must not create, read-modify, or write `.devcycle/state.md`.** An existing state file
  belongs to somebody else's in-flight cycle — exactly as `devcycle:auditing-a-repo`'s
  standalone rule establishes — and its lines are not this run's to rewrite. The checklist
  path goes in the handoff instead, and nowhere else.
- **The checklist is scratch**: it goes to the diff-derived path
  `${CLAUDE_PLUGIN_ROOT}/references/checklist.md` pins, handled as that file states.

The walkthrough, the interview rule, the gate, and the results report are unchanged: a
standalone run is a different source for the checklist, not a different standard for verifying
it.

## Handoff

The two paths differ in one thing, the state file:

- **In-cycle:** end the stage by updating `.devcycle/state.md` — set `stage: finish`, the
  stage the next session resumes at.
- **Standalone:** write no state file and set no stage; the block names the branch, the
  checklist path, and the results instead.

Both then emit the handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with the
same contents:

- `Artifacts:` the checklist path and the results report path — or `none (no rendered
  surface)` when this stage judges itself not applicable.
- `Carry-overs:` failed items with severity, unverified residue under `auto-ok`, the skip
  reason when skipped, or `none`.
- `Compaction hint:` Keep checklist path, branch, failed items. Drop walkthrough transcript.
