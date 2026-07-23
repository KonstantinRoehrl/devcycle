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

## Generating the checklist

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

## The `(auto)` boundary

```
A SCRIPT OR SCREENSHOT NEVER CHECKS OFF A CHECKLIST ITEM.
```

One exception, keyed to an observable predicate: an item asserting DOM structure, CSS
values, or exact text that a Playwright run — via the Playwright MCP server (the intended
engine) or an equivalent structural check — has verified, fresh output in hand, may be
checked off with the tag `(auto)`. When no Playwright MCP is available, nothing is
auto-checked: every item stays a human item. Everything a script cannot structurally see
(feel, smoothness, visual alignment, contrast, legibility) stays unchecked for the human.

| Rationalization | Reality |
|---|---|
| "The Playwright suite is green" | Green covers only its DOM/CSS/text assertions — check off exactly those items, `(auto)`-tagged, nothing more |
| "The screenshot looks right" | A screenshot cannot show jank, focus order, interaction feel, or a breakpoint reflow |
| "We're behind schedule" | Pressure does not convert human items into script items |
| "The code clearly implements it" | Rendered outcome and code intent diverge exactly often enough to need this checklist |

## The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Route it to the model in `${user_config.walkthroughModel}`;
if that value still reads as a literal `${user_config...}` placeholder, the option is unset —
use the default `claude-sonnet-5`.

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

Read `${user_config.onDeviceGate}`; if it still reads as a literal `${user_config...}`
placeholder, the option is unset — use the default `human-required`.

- Predicate `onDeviceGate == "human-required"` (default): the stage is complete ONLY when
  every non-`(auto)` item has a human verdict from the walkthrough.
- Predicate `onDeviceGate == "auto-ok"`: the stage may complete once all structurally
  verifiable items are `(auto)`-checked; remaining items still stay unchecked and are listed
  in the handoff as unverified residue — `auto-ok` skips the human gate, it never fakes the
  checkmarks.

## Handoff

End the stage with the P2 handoff block:

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
