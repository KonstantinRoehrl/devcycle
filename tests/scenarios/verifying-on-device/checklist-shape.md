# Scenario: checklist-shape
- Skill under test: devcycle:verifying-on-device
- Type: output-shape

## Setup

Create an empty sandbox git repo (no existing `docs/` directory). No claude-in-chrome or
other browser-inspection tooling is available. The agent is told a task has just produced rendered changes,
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
3. The items cover all the dimensions of the skill's Part A dimension list applicable to
   the described change: visual rendering vs intent, layout/alignment/spacing, interaction
   feel, responsive behavior at the stated 768px breakpoint, light/dark theme parity,
   keyboard/accessibility, empty and loading states, animation timing.
4. Items are concrete and user-verifiable (each names an observable outcome a human can
   confirm on the running app), not vague ("looks good") and not code-level assertions.
5. *(Part A/B role split.)* Invoked mid-execution — Part A's consumer — the agent generates
   the checklist and stops there: it does not begin Part B's walkthrough (no per-item
   interview questions to the user) and does not evaluate the on-device gate; both belong
   to the on-device stage's fresh session after branch review.

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

## Regression (Task 12)

Run 2026-07-22 — full-pass regression against the committed text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; the init event confirmed `plugins: []`), sandbox rebuilt per Setup in a session-temp directory.

- Criterion 1 PASS: checklist created immediately (not deferred) at `docs/status-filter/on-device-checklist.md`; `.devcycle/state.md` written with `checklist: docs/status-filter/on-device-checklist.md`.
- Criterion 2 PASS: 23 items, all `- [ ]`; zero `[x]`, zero `(auto)` — the final message states none qualify without fresh structural-verification output in hand.
- Criterion 3 PASS: sections cover all eight applicable dimensions, including the 768px breakpoint (with spot-checks just above and below it) and light/dark theme parity per surface state.
- Criterion 4 PASS: every item names an observable outcome (e.g. "Open dropdown panel does not clip, overflow, or overlap adjacent toolbar elements"); none vague or code-level.
- Net: GREEN — no regression.

## Regression (review-fixes)

Criterion 5 added (and criterion 3's stale "§12.3" reference replaced with the skill's Part A dimension list) 2026-07-23 after the review-fixes bundle restructured the skill into labeled parts — Part A (mid-execution checklist generation + `(auto)` boundary, consumed by executing-waves) and Part B (the on-device stage's fresh-session walkthrough + gate + handoff) — with a read-the-part-that-matches-your-role note. Both runs: fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config (fresh CLAUDE_CONFIG_DIR holding only auth; init events confirmed `plugins: []`), empty sandbox repos per Setup in session-temp directories. Red = committed text (`git show HEAD:skills/verifying-on-device/SKILL.md`); green = working tree.

- Baseline (red): criterion 5 FAIL — a genuine role-bleed, not a hypothetical: after generating a conformant checklist (13 items, all unchecked, no `(auto)`), the agent immediately began the walkthrough inline: "Now let's walk through it — I'll ask one item at a time. **Item 1/13 — Dropdown trigger rendering:** … Does the status-filter dropdown trigger appear …?" — Part B's interview started mid-execution, in the implementation session the fresh-session rule exists to keep it out of.
- Result (green): PASS all five criteria. Checklist created immediately at `docs/status-filter/on-device-checklist.md` and recorded in `.devcycle/state.md` (criterion 1); 12 items, all `- [ ]`, zero `[x]`, zero `(auto)` — "no Playwright MCP run occurred, so none are `(auto)`-tagged" (criterion 2); items cover the applicable Part A dimensions — visual rendering vs intent, layout/alignment vs neighboring toolbar controls, light/dark theme parity, loading and empty states, open/close animation smoothness, keyboard operation (Tab focus, arrows, Enter) with focus indicator, and the 768px reflow checked from both sides (criterion 3); every item names an observable outcome (criterion 4); and the run stops at Part A with the split stated in its own words: "This is the mid-wave checklist-generation duty; the actual walkthrough (Part B) happens later in a fresh session against this file" — no interview questions, no gate evaluation (criterion 5).
