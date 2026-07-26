---
name: verifying-on-device
description: Use when implemented changes affect rendered UI or on-device behavior that automated tests cannot fully verify, or when a walkthrough of an on-device checklist is requested.
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

The checklist this stage walks is produced during execution by `devcycle:executing-waves`,
at `docs/<feature>/on-device-checklist.md` (path recorded in the `checklist:` field of
`.devcycle/state.md`).

## The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Its model cannot be routed from inside it (the session and
its model already exist by the time this text is read), so the recommendation travels
producer-side: the branch-review handoff carries a `Start the fresh session on <model>`
line, resolved from `walkthroughModel` per
`${CLAUDE_PLUGIN_ROOT}/references/config.md`. When that knob derives rather than pins, the
walkthrough takes the fast tier — it is interview mechanics, and per-task derivation buys
nothing here.

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

Resolve `onDeviceGate` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`: an explicitly
configured knob wins, otherwise the profile decides — `auto-ok` at `lean`,
`human-required` at `standard` and `thorough`.

- `human-required`: the stage is complete ONLY when every non-`(auto)` item has a human
  verdict from the walkthrough.
- `auto-ok`: the checklist may close without a human pass — the stage may complete once all
  structurally verifiable items are `(auto)`-checked, with the remaining items left
  unchecked and listed in the handoff as unverified residue.

`auto-ok` relaxes the closing condition, never the reporting. It never licenses reporting a
walkthrough that did not run as done, and never fakes a checkmark: the handoff states which
happened — a human pass, or a close without one and what stayed unverified.

## Handoff

End the stage by updating `.devcycle/state.md` — set `stage: finish` (the stage the next
session resumes at) — then emit the handoff block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- `Artifacts:` the checklist path and the results report path — or `none (no rendered
  surface)` when this stage judges itself not applicable.
- `Carry-overs:` failed items with severity, unverified residue under `auto-ok`, the skip
  reason when skipped, or `none`.
- `Compaction hint:` Keep checklist path, branch, failed items. Drop walkthrough transcript.
