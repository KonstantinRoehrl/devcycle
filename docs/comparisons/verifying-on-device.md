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

## Scope change, 2026-10-24 — launch, driver first, and the skip

The stage now launches the app itself, runs `devcycle:on-device-driver` before any question,
and asks the human one batch of proposed verdicts plus the `needs-eyes` items one by one; the
launch contract, the item tiers and the verdict vocabulary are `references/checklist.md`'s.
Deciding that nothing renders moved to `devcycle:reviewing-the-branch`, which skips this stage
outright; this stage judges applicability itself only when no earlier stage did, as on
standalone `/devcycle:verify`. The (b) and (c) entries below are restated for it.

## Engine per profile

Devcycle-native at every profile — no upstream skill is loaded or overlaid at any of them.
`superpowers:verification-before-completion` is referenced as REQUIRED background
discipline unconditionally, never profile-conditionally.

| profile | engine | upstream loaded? | `onDeviceGate` default |
| --- | --- | --- | --- |
| `lean` | devcycle-native | no | `auto` |
| `standard` | devcycle-native | no | `auto` |
| `thorough` | devcycle-native | no | `auto` |

Since 2026-10-24 the profile sets no `onDeviceGate` value: `auto`, the agent first and the human
for the rest, is the default at every profile, and a `lean` run that should close on the agent
pass sets `auto-ok` itself. The gate changes the stage's **closing condition** and nothing
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
- **One question per `needs-eyes` item, never batched.** Each such question covers exactly
  one item and tells the human how to observe it (where to click, which viewport, which theme),
  and waits for the verdict before the next; under `human-required` every item is asked this
  way. What the driver could observe instead arrives as one batch of proposed verdicts the
  human confirms or overrides. See (c)1.
- **An agent-actionable results report**, one line per item, plain language and symptom
  first, recording each verdict from a fixed set: passed, FAILED with what the user saw
  instead and a severity, waived with a reason, or unverified.
- **Producer-side model routing.** The walkthrough's model cannot be chosen from inside the
  session that already exists, so the recommendation travels in the branch-review handoff
  as `Start the fresh session on <model>`, resolved from `walkthroughModel` per
  `references/model-routing.md`; where that knob derives rather than pins, the walkthrough takes
  the fast tier, since it is interview mechanics. No upstream analogue.
- **The `onDeviceGate` conditional.** `auto`: complete once every item has an `(auto)` tick,
  a confirmed batch verdict, or a per-item human verdict. `human-required`: complete only when
  every item has a human verdict. `auto-ok`: the agent pass may close the stage unless it
  observed a failure, with every item lacking an `(auto)` tick listed in the handoff as
  unverified residue. The relaxation is of the closing condition only — the handoff always
  states which happened, a human pass or a close without one and what stayed unverified, and
  no checkmark is ever faked.
- **Pipeline integration.** `.devcycle/state.md` set to `stage: finish`, the handoff block
  per `references/handoff.md`, artifacts being the checklist and results-report paths — or
  `none (no rendered surface)` when this stage still judges itself not applicable, which
  emits a block of its own. In a cycle, branch review usually makes that call first and skips
  the stage, carrying the skip in its own handoff.

## (c) Conflicts and resolutions

Both are unconditional — neither is scoped to a profile.

1. **One-question-per-item vs the batched-interview standard.** The devcycle-wide interview
   discipline, carried by `scoping-interview`, batches questions via AskUserQuestion. This
   skill mandates the opposite for walkthroughs: one question per `needs-eyes` item (every
   item under `human-required`), never batched, because findings quality drops when items are
   bundled. **Resolution:** the walkthrough interview is an explicit, scoped exception, stated
   in the skill as its own rule keyed to the observable situation of walking a checklist; the
   general batching rule is untouched everywhere else. The batch of proposed verdicts is not a
   breach of the exception: it carries only what the driver observed, never an item that
   needs eyes.
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
