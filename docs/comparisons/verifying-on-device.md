# Comparison memo: verifying-on-device vs upstream superpowers

Compared against the live installed superpowers 6.1.1
(`~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.1/skills/`), 2026-07-22.
Primary comparison target: `superpowers:verification-before-completion`. The full 6.1.1 skill
list was checked for a closer equivalent (brainstorming, dispatching-parallel-agents,
executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review,
subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees,
using-superpowers, verification-before-completion, writing-plans, writing-skills): none covers
on-device/rendered-output walkthroughs. `verification-before-completion` is the nearest skill,
and only in spirit. Expected relationship per the kickoff table — **mostly new** — confirmed.

## (a) What upstream already covers — reference, do not duplicate

`superpowers:verification-before-completion` establishes the general claim-verification
discipline: no completion claim without fresh verification evidence; run the command, read the
output, then claim; agent success reports are never trusted without independent checking; red
flags ("should work", satisfaction before verification) and a rationalization table.

That discipline is the *parent rule* our skill instantiates for one domain: a script or
screenshot asserting "the UI looks right" is exactly the kind of unverified claim upstream
forbids. The plugin skill references `superpowers:verification-before-completion` by name for
this general discipline and does not restate its gate function, red-flags list, or
rationalization table.

## (b) What §12.3 adds — the plugin skill's content (all new, no upstream counterpart)

- **The on-device checklist artifact**: markdown at `docs/<feature>/on-device-checklist.md` in
  the target repo, concrete user-verifiable items as UNCHECKED boxes, generated the moment a
  task produces rendered changes (not deferred to end of wave).
- **The verification-dimension catalogue**: visual rendering vs intent, layout/alignment/
  spacing, interaction feel, responsive behavior at real breakpoints, theme parity, keyboard/
  accessibility, empty/loading/error states, animation timing.
- **The `(auto)` boundary**: a structural browser check (e.g. via claude-in-chrome) may check
  off ONLY structurally verifiable items (DOM/CSS/text assertions), honestly tagged `(auto)`;
  everything such a check cannot structurally see stays unchecked for the human. Upstream has no notion of a
  human-only verification residue.
- **The fresh-session walkthrough**: runs with only the checklist path + branch as context,
  interviews the human at ONE question per checklist item, produces an agent-actionable
  results report (passed / failed / why / severity).
- **The `onDeviceGate` conditional** (`human-required` vs `auto-ok`) and the
  `walkthroughModel` routing — devcycle pipeline configuration with no upstream analogue.
- **Pipeline integration**: P2 handoff block, `.devcycle/state.md` checklist field, checklist
  path consumed by reviewing-the-branch handoffs.

## (c) Conflicts and resolutions

1. **One-question-per-item vs the batched-interview standard.** The devcycle-wide interview
   discipline (§12.4, carried by scoping-interview) batches questions via AskUserQuestion.
   §12.3 explicitly mandates the opposite for walkthroughs: ONE question per checklist item,
   never batched, because findings quality drops when items are bundled. **Resolution:** the
   walkthrough interview is an explicit, scoped exception, stated in the skill as its own
   rule keyed to the observable situation of walking a checklist; the general batching rule
   is untouched everywhere else.
2. **Upstream's "run the command to verify" vs items no command can verify.** Upstream's frame
   assumes every claim has a proving command. Rendered-output claims often do not.
   **Resolution:** the `(auto)` boundary splits the checklist — command-provable items follow
   upstream discipline (fresh run, evidence, tag `(auto)`); the rest are human-only, and
   claiming them from a script is treated as the same violation upstream describes.

No planned content was dropped as duplicative; the skill is a true delta.
