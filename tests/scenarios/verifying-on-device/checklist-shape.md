# Scenario: checklist-shape
- Skill under test: devcycle:verifying-on-device
- Type: output-shape

## Setup

Create an empty sandbox git repo (no existing `docs/` directory). No Playwright or other
test tooling is present. The agent is told a task has just produced rendered changes,
described as:

> The ticket-list toolbar gained a theme-aware **status-filter dropdown** (options Open,
> Closed, Archived). It has a loading state while options fetch, an empty state
> ("No matching tickets") when the filter excludes everything, an open/close animation,
> keyboard operation (tab to focus, arrows to navigate, Enter to select), and the toolbar
> reflows at the 768px breakpoint. The app supports light and dark themes.

## Subagent prompt

> <full text of `skills/verifying-on-device/SKILL.md` inserted here>
>
> A task in the current wave just landed the following rendered change on branch
> `feature/status-filter`: [UI change description from Setup]. Automated tests cover the
> component's logic. Do what the on-device verification stage requires at this moment.

## Pass criteria

1. A checklist file is created at `docs/<feature>/on-device-checklist.md` (a feature-named
   folder, e.g. `docs/status-filter/on-device-checklist.md`) — created now, not deferred to
   the end of the wave.
2. Every item is an unchecked markdown checkbox (`- [ ]`); no item is pre-checked and no
   item carries an `(auto)` tag at generation time.
3. The items cover all the §12.3 dimensions applicable to the described change: visual
   rendering vs intent, layout/alignment/spacing, interaction feel, responsive behavior at
   the stated 768px breakpoint, light/dark theme parity, keyboard/accessibility,
   empty and loading states, animation timing.
4. Items are concrete and user-verifiable (each names an observable outcome a human can
   confirm on the running app), not vague ("looks good") and not code-level assertions.

## Baseline (red)

Run 2026-07-22: fresh subagent (claude-sonnet-5 via `claude -p`) in an empty scratch sandbox
repo, prompt above WITHOUT the skill content. FAILED criterion 1.

- Criterion 1 FAIL: the checklist was created at
  `docs/superpowers/plans/status-filter-on-device-checklist.md` (a convention inherited from
  the operator's global instructions), not the pinned
  `docs/<feature>/on-device-checklist.md` — the path/state contract is exactly the delta the
  skill must pin.
- Criteria 2–4 largely held (all items unchecked, reasonable dimension coverage), so the
  recorded delta is the path convention plus the `.devcycle/state.md` integration, which the
  baseline also lacked.

## Result (green)

Run 2026-07-22: fresh subagent (claude-sonnet-5 via `claude -p`), same sandbox setup, same
prompt WITH the skill content. PASSED all 4 criteria.

- Criterion 1: file created at `docs/status-filter/on-device-checklist.md`, immediately (not
  deferred), and the agent also wrote `.devcycle/state.md` with
  `checklist: docs/status-filter/on-device-checklist.md`.
- Criterion 2: 22 items, all `- [ ]` — grep-verified 22 unchecked, 0 `[x]`, 0 `(auto)`.
- Criterion 3: sections cover all eight dimensions (visual rendering vs intent,
  layout/alignment/spacing, interaction feel, responsive at the 768px breakpoint, light/dark
  theme parity, keyboard/accessibility, empty/loading states, animation timing).
- Criterion 4: items name observable outcomes (e.g. "Open menu does not clip, overflow, or
  get cut off by the toolbar or viewport edges"), none vague or code-level. The agent's
  final message explicitly declined to `(auto)`-check anything: "No items are
  `(auto)`-checked — that requires fresh Playwright/equivalent output structurally verifying
  DOM/CSS/text, which I don't have in hand."
