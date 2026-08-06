# On-device checklist contract

The single owner of what an on-device checklist is: where it lives, what an item looks like,
which dimensions it covers, and what may ever be checked off without a human.
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` generates one mid-wave from the plan; `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md`
generates one from a branch diff and walks either. Both name this file and neither restates it.

## Paths

- **Plan-derived (in-cycle)** — `docs/<feature>/on-device-checklist.md` in the target repo.
  The path is pinned because `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md`'s handoff consumes it. Record it
  in the `checklist:` field of `.devcycle/state.md`.
- **Diff-derived (standalone `/devcycle:verify`)** — `.devcycle/on-device-checklist-<branch-slug>.md`,
  where `<branch-slug>` is the branch name with every character outside `[A-Za-z0-9._-]`
  replaced by `-` (`feat/csv export` → `feat-csv-export`). Scratch for the run: never
  committed. Where else a standalone run may record this path is
  `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md`'s rule, not this file's.

## Item shape

Every item is an UNCHECKED box naming one concrete outcome a human can observe on the running
app. No item is pre-checked and no item carries `(auto)` at generation time. Items are
concrete and user-verifiable — never "looks good", never a code-level assertion.

```markdown
- [ ] <one concrete observable outcome>
      Where: <route / screen / module>  ·  How to get there: <click path from app root>
```

The two navigation fields are **optional** for plan-derived items, where the plan and the
implementation conversation already supply that context, and **required** for diff-derived
ones, where no plan exists to imply them: a walkthrough of someone else's branch cannot start
without being told where to look.

## Dimensions

Cover every dimension applicable to the change:

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

One exception, keyed to an observable predicate: an item asserting DOM structure, CSS values,
or exact text that a structural browser check — via claude-in-chrome (the intended engine: it
navigates, screenshots, and reads the DOM/CSS/text/network of a page in the user's own Chrome)
or an equivalent structural check — has verified, fresh output in hand, may be checked off
with the tag `(auto)`. claude-in-chrome is preferred because the user can open an
authenticated page in their real Chrome and hand the agent that already-logged-in session to
inspect — which a separate browser context (e.g. Playwright's) cannot do without
re-authenticating. When claude-in-chrome is not available, nothing is auto-checked: every item
stays a human item. Everything a browser check cannot structurally see (feel, smoothness,
visual alignment, contrast, legibility) stays unchecked for the human.

| Rationalization | Reality |
|---|---|
| "claude-in-chrome confirmed the page" | A structural read covers only DOM/CSS/text — check off exactly those items, `(auto)`-tagged, nothing more |
| "The screenshot looks right" | A screenshot cannot show jank, focus order, interaction feel, or a breakpoint reflow |
| "We're behind schedule" | Pressure does not convert human items into script items |
| "The code clearly implements it" | Rendered outcome and code intent diverge exactly often enough to need this checklist |
