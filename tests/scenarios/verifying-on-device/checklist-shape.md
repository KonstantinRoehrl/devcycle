# Scenario: checklist-shape
- Skill under test: devcycle:executing-waves (checklist generation)
- Type: output-shape

**Splice slot moved 2026-07-26.** Checklist generation is a mid-wave coordinator duty and
now lives in `skills/executing-waves/SKILL.md` ("UI and on-device outcomes" → "Generating
the checklist" and "The `(auto)` boundary"). `skills/verifying-on-device/SKILL.md` is the
on-device stage proper — the fresh-session walkthrough, gate, and handoff — and no longer
carries the generation rules at all, so splicing it here would grade a file that does not
contain the graded behavior. The sections below dated 2026-07-22 and 2026-07-23 graded the
old placement (the skill's Part A) and are kept as the record of what was observed then.

## Setup

Create an empty sandbox git repo (no existing `docs/` directory). No claude-in-chrome or
other browser-inspection tooling is available — which matters: claude-in-chrome is the
intended structural-check engine for the `(auto)` tag, and with it absent nothing may be
auto-checked. The agent is told a task has just produced rendered changes, described as:

> The ticket-list toolbar gained a theme-aware **status-filter dropdown** (options Open,
> Closed, Archived). It has a loading state while options fetch, an empty state
> ("No matching tickets") when the filter excludes everything, an open/close animation,
> keyboard operation (tab to focus, arrows to navigate, Enter to select), and the toolbar
> reflows at the 768px breakpoint. The app supports light and dark themes.

## Subagent prompt

**Reference layer (required for every green run).** `skills/executing-waves/SKILL.md`
points at `${CLAUDE_PLUGIN_ROOT}/references/config.md`, `output.md`, `handoff.md`,
`branch.md`, `evidence.md`, and `resume.md`. None of the graded criteria live in those
files — the checklist rules are stated in the skill itself — but the pointers must still
resolve, or the agent spends the run hunting missing files and the transcript grades that
instead. Check out (or copy) the devcycle plugin somewhere readable from the sandbox and
give the agent the substitution in the environment note.

> <full text of `skills/executing-waves/SKILL.md` inserted here>
>
> A task in the current wave just landed the following rendered change on branch
> `feature/status-filter`: [UI change description from Setup]. Automated tests cover the
> component's logic. Do what the coordinator's on-device duty requires at this moment.
>
> Environment notes: the devcycle plugin's files are checked out at <absolute path of the
> devcycle checkout>; where guidance references `${CLAUDE_PLUGIN_ROOT}`, substitute that
> path. No subagent-dispatch tool is available; do not dispatch anything.

## Pass criteria

*(Criteria 3 and 5 rewritten 2026-07-26 with the splice slot's move to
`devcycle:executing-waves`; criterion 6 added the same day.)*

1. A checklist file is created at `docs/<feature>/on-device-checklist.md` (a feature-named
   folder, e.g. `docs/status-filter/on-device-checklist.md`) — created now, not deferred to
   the end of the wave — and its path is recorded on the `checklist:` line of
   `.devcycle/state.md`.
2. Every item is an unchecked markdown checkbox (`- [ ]`); no item is pre-checked and no
   item carries an `(auto)` tag at generation time.
3. The items cover all the dimensions of the skill's "Generating the checklist" list
   applicable to the described change: visual rendering vs intent, layout/alignment/spacing,
   interaction feel, responsive behavior at the stated 768px breakpoint, theme parity across
   light and dark, keyboard/accessibility, empty and loading states, animation timing.
4. Items are concrete and user-verifiable (each names an observable outcome a human can
   confirm on the running app), not vague ("looks good") and not code-level assertions.
5. *(Stage role split.)* Invoked mid-execution, the coordinator generates the checklist and
   stops there: it does not begin the walkthrough (no per-item interview questions to the
   user) and does not evaluate the on-device gate. Both belong to
   `devcycle:verifying-on-device`, which runs in a fresh session after branch review — a
   separate skill now, not a later part of this one.
6. *(`(auto)` boundary, added 2026-07-26.)* With no claude-in-chrome and no equivalent
   structural browser check available, nothing is auto-checked and the run says so: every
   item stays a human item. If the agent names the engine that would be required, it names
   claude-in-chrome or an equivalent structural check — the retired Playwright wording is a
   stale reference, and a run that auto-checks anything on the strength of code reading or
   a screenshot fails outright.

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

## Regression (compact profile-driven devcycle)

**Not yet run (2026-07-26).** Every run above spliced
`skills/verifying-on-device/SKILL.md`, which no longer contains the checklist-generation
rules this scenario grades — the splice slot is now `skills/executing-waves/SKILL.md`.
Those runs stand as the record of what was observed on their dates, against the placement
current then; they are not evidence for the criteria as they now read, because they
graded a different file. This pass moved the splice slot, rewrote criteria 3 and 5, added
criterion 6 for the `(auto)` boundary's claude-in-chrome engine, and pinned criterion 1's
state-file record. Nothing here is claimed as observed.

What would prove it: an empty sandbox repo per Setup, a readable plugin checkout named in
the environment note, and one fresh headless subagent (`claude -p`, isolated
`CLAUDE_CONFIG_DIR` holding only auth, init event confirming `plugins: []`) run against
the working-tree `skills/executing-waves/SKILL.md`, graded on criteria 1–6. A red baseline
is available by splicing `git show ba79dab:skills/executing-waves/SKILL.md` — the
pre-cycle text, which carried no checklist-generation section at all, so criterion 1's
pinned path had no source in it.
