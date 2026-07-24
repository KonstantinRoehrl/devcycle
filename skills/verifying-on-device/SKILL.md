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

This skill has two consumers, split into two parts: **Part A** is a mid-wave duty of the
executing coordinator (via `devcycle:executing-waves`); **Part B** is the on-device stage
proper, run in a fresh session after the branch review. Read the part that matches your
role.

## Part A — during execution (consumed by executing-waves): checklist generation + `(auto)` boundary

### Generating the checklist

**Trigger: the moment a task produces rendered changes** — generate or update the checklist
in that same wave. Never defer it to the end of the wave or the branch.

- Path (pinned; consumed by reviewing-the-branch handoffs): `docs/<feature>/on-device-checklist.md`
  in the target repo.
- Record the path in the `checklist:` field of `.devcycle/state.md`.
- Every item is an UNCHECKED box naming one concrete outcome a human can observe on the
  running app. No item is pre-checked and no item carries `(auto)` at generation time.
- Cover every dimension applicable to the change:
  - visual rendering vs intent
  - layout / alignment / spacing
  - interaction feel (drag, hover, focus)
  - responsive behavior at real breakpoints
  - theme parity, where the surface supports themes
  - keyboard / accessibility
  - empty / loading / error states
  - animation timing

### The `(auto)` boundary

```
A SCRIPT OR SCREENSHOT NEVER CHECKS OFF A CHECKLIST ITEM.
```

One exception, keyed to an observable predicate: an item asserting DOM structure, CSS
values, or exact text that a structural browser check — via claude-in-chrome (the intended
engine: it navigates, screenshots, and reads the DOM/CSS/text/network of a page in the
user's own Chrome) or an equivalent structural check — has verified, fresh output in hand,
may be checked off with the tag `(auto)`. claude-in-chrome is preferred because the user can
open an authenticated page in their real Chrome and hand the agent that already-logged-in
session to inspect — which a separate browser context (e.g. Playwright's) cannot do without
re-authenticating. When claude-in-chrome is not available, nothing is auto-checked: every
item stays a human item. Everything a browser check cannot structurally see (feel,
smoothness, visual alignment, contrast, legibility) stays unchecked for the human.

| Rationalization | Reality |
|---|---|
| "claude-in-chrome confirmed the page" | A structural read covers only DOM/CSS/text — check off exactly those items, `(auto)`-tagged, nothing more |
| "The screenshot looks right" | A screenshot cannot show jank, focus order, interaction feel, or a breakpoint reflow |
| "We're behind schedule" | Pressure does not convert human items into script items |
| "The code clearly implements it" | Rendered outcome and code intent diverge exactly often enough to need this checklist |

## Part B — the on-device stage (fresh session): walkthrough + gate + handoff

### The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Its model cannot be routed from inside it (the session and
its model already exist by the time this text is read), so the recommendation travels
producer-side: the branch-review handoff carries a `Start the fresh session on <model>`
line. That model is `${user_config.walkthroughModel}` when it names an explicit model id
(binding); otherwise — the value `auto`, or a value that still reads as a literal
`${user_config...}` placeholder, which means the option is unset — it is fixed
`claude-sonnet-5`, since a walkthrough is interview mechanics and per-task derivation buys
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

### The gate

Read `${user_config.onDeviceGate}`; a literal placeholder means unset (the walkthrough's
placeholder rule above) — use the default `human-required`.

- Predicate `onDeviceGate == "human-required"` (default): the stage is complete ONLY when
  every non-`(auto)` item has a human verdict from the walkthrough.
- Predicate `onDeviceGate == "auto-ok"`: the stage may complete once all structurally
  verifiable items are `(auto)`-checked; remaining items still stay unchecked and are listed
  in the handoff as unverified residue — `auto-ok` skips the human gate, it never fakes the
  checkmarks.

### Handoff

End the stage by updating `.devcycle/state.md` — set `stage: finish` (the stage the next
session resumes at) — then emit the pipeline handoff block:

```markdown
## Handoff
- Stage completed: on-device
- Artifacts: <checklist path, results report path>
- Carry-overs: <failed items with severity, unverified residue under auto-ok, or "none">
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep checklist path, branch, failed items. Drop walkthrough transcript.
```

The block is REQUIRED even when this stage judges itself not applicable (no
rendered surface, nothing to walk): the skip IS the stage outcome — emit the
block with the skip recorded in it (`Artifacts: none (no rendered surface)`,
Carry-overs naming the skip reason), not prose or the state file alone. And
when finish runs in the same response, this stage's block still appears
separately, before the finish stage's output.
