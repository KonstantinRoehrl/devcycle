# Comparison memo: verifying-on-device vs upstream superpowers

Upstream baseline: `superpowers/6.1.1/skills/` from the plugin cache, read 2026-07-22.
Primary comparison target: `superpowers:verification-before-completion`. The full 6.1.1
skill list was checked for a closer equivalent (brainstorming,
dispatching-parallel-agents, executing-plans, finishing-a-development-branch,
receiving-code-review, requesting-code-review, subagent-driven-development,
systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers,
verification-before-completion, writing-plans, writing-skills): none covers
on-device/rendered-output walkthroughs. `verification-before-completion` is the nearest
skill, and only in spirit. Expected relationship per the kickoff table — **mostly new** —
confirmed.

Memo refreshed 2026-07-26 for the profile split and for the scope change below. 6.2.0 is
now installed alongside 6.1.1; the upstream content this memo relies on (the red-flags list
and the rationalization table) was spot-checked and still holds there, but the memo has not
been fully re-derived against it.

## Scope change, 2026-07-26 — checklist generation moved out

Generating the on-device checklist used to be this skill's delta. It now belongs to
`devcycle:executing-waves`, which creates or updates
`docs/<feature>/on-device-checklist.md` in the same wave a task produces rendered changes
and records the path in `.devcycle/state.md`. The verification-dimension catalogue and the
`(auto)` boundary — including the rule that a script or screenshot never checks off an item
— moved with it; see `docs/comparisons/executing-waves.md` (c)12 for the delta statement in
its new home.

This skill is now the on-device **stage** only: walkthrough, gate, handoff. It consumes the
checklist it no longer produces.

## Engine per profile

Devcycle-native at every profile — no upstream skill is loaded or overlaid at any of them.
`superpowers:verification-before-completion` is referenced as REQUIRED background
discipline unconditionally, never profile-conditionally.

| profile | engine | upstream loaded? | `onDeviceGate` default |
| --- | --- | --- | --- |
| `lean` | devcycle-native | no | `auto-ok` |
| `standard` | devcycle-native | no | `human-required` |
| `thorough` | devcycle-native | no | `human-required` |

An explicitly configured `onDeviceGate` wins verbatim over the profile column, per
`references/config.md`. The profile changes the gate's **closing condition** and nothing
else: it never changes what is reported, and `auto-ok` never licenses reporting a
walkthrough that did not run as done.

## (a) Upstream's share — referenced, never restated (at every profile)

`superpowers:verification-before-completion` establishes the general claim-verification
discipline: no completion claim without fresh verification evidence; run the command, read
the output, then claim; agent success reports are never trusted without independent
checking; plus red flags ("should work", satisfaction before verification) and a
rationalization table.

That discipline is the *parent rule* this skill instantiates for one domain — a script or
screenshot asserting "the UI looks right" is exactly the kind of unverified claim upstream
forbids. The skill names the upstream skill for the general discipline and does not restate
its gate function, red-flags list, or rationalization table.

## (b) Our delta — every profile

- **The fresh-session walkthrough.** It runs after the branch review with only the
  checklist path and the branch as context — nothing from the implementation conversation.
- **One question per checklist item, never batched.** Each question covers exactly one item
  and tells the human how to observe it (where to click, which viewport, which theme), and
  waits for the verdict before the next. See (c)1.
- **An agent-actionable results report**, one line per item, plain language and symptom
  first, recording passed / FAILED, what the user saw instead, and a severity.
- **Producer-side model routing.** The walkthrough's model cannot be chosen from inside the
  session that already exists, so the recommendation travels in the branch-review handoff
  as `Start the fresh session on <model>`, resolved from `walkthroughModel` per
  `references/config.md`; where that knob derives rather than pins, the walkthrough takes
  the fast tier, since it is interview mechanics. No upstream analogue.
- **The `onDeviceGate` conditional.** `human-required`: the stage is complete only when
  every non-`(auto)` item has a human verdict. `auto-ok`: the checklist may close without a
  human pass once all structurally verifiable items are `(auto)`-checked, with the rest left
  unchecked and listed in the handoff as unverified residue. The relaxation is of the
  closing condition only — the handoff always states which happened, a human pass or a
  close without one and what stayed unverified, and no checkmark is ever faked.
- **Pipeline integration.** `.devcycle/state.md` set to `stage: finish`, the handoff block
  per `references/handoff.md`, artifacts being the checklist and results-report paths — or
  `none (no rendered surface)` when the stage judges itself not applicable, which still
  emits a block, since the skip IS the stage outcome.

## (c) Conflicts and resolutions

Both are unconditional — neither is scoped to a profile.

1. **One-question-per-item vs the batched-interview standard.** The devcycle-wide interview
   discipline, carried by `scoping-interview`, batches questions via AskUserQuestion. This
   skill mandates the opposite for walkthroughs: one question per checklist item, never
   batched, because findings quality drops when items are bundled. **Resolution:** the
   walkthrough interview is an explicit, scoped exception, stated in the skill as its own
   rule keyed to the observable situation of walking a checklist; the general batching rule
   is untouched everywhere else.
2. **Upstream's "run the command to verify" vs items no command can verify.** Upstream's
   frame assumes every claim has a proving command; rendered-output claims often do not.
   **Resolution:** the `(auto)` boundary splits the checklist — command-provable items
   follow upstream discipline (fresh run, evidence, tagged `(auto)`), the rest are
   human-only, and claiming them from a script is the same violation upstream describes.
   The boundary itself is now drawn at generation time by `devcycle:executing-waves`; what
   remains here is the consequence — the human-only residue is exactly what this stage's
   gate is about.

**Verdict:** a true delta at every profile, with a smaller surface than before. Nothing was
dropped as duplicative; checklist generation moved to the stage that now owns it.
