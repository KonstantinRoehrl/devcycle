# Verifying On-Device

## Overview

Rendered outcomes — how the UI looks, feels, and behaves on a real device — have no proving
command; the human walking the running app is the verification command. Claiming one from a
script, a screenshot, or a code reading is an unverified completion claim
(`superpowers:verification-before-completion`, REQUIRED background).

This playbook is the on-device stage proper — walkthrough, gate, handoff — run in a fresh
session after the branch review. Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons on-device`. No store, no output.

## Checklist source

Two sources, one engine. Which one applies is settled before the walkthrough begins;
everything after is identical either way.

**Plan-derived (in-cycle).** `playbooks/executing-waves.md` produced
the checklist during execution; read its path from the `checklist:` field of
`.devcycle/state.md`. When that field reads `none` because branch review's trace found a
rendered surface, generate one diff-derived, as below, and write and record it where
`${CLAUDE_PLUGIN_ROOT}/references/checklist.md` § Paths puts that case.

**Diff-derived (standalone, `/devcycle:verify <branch>`).** No checklist exists yet: generate
one from the branch, **automatically — there is no confirmation step**, because the branch is
the whole instruction.

- *Base and changed files*: follow "Deriving a branch's file set" in
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md`. Its merge-base guard is what keeps the
  walkthrough from being handed a file set built from local uncommitted edits.
- *Affected UI areas*: run § Applicability of `${CLAUDE_PLUGIN_ROOT}/references/checklist.md`
  over that file set. On `nothing renders (<reason>)`, write no checklist and report the stage
  not applicable with that reason.
- *Generation*: follow `${CLAUDE_PLUGIN_ROOT}/references/checklist.md`, header lines and each
  item's `Tier:` included. Its `Where:` and `How to get there:` fields are REQUIRED here: without
  a plan, nothing else tells the human where to look.

Generating the checklist needs only git refs; the walkthrough needs the branch's files on
disk. When `<branch>` is not the current checkout, generate the checklist, say so plainly, and
offer two ways forward — this stage switches the checkout in neither:

- **The user checks the branch out** in the current checkout; or
- **a throwaway worktree**, offered exactly as `${CLAUDE_PLUGIN_ROOT}/references/branch.md`
  says to offer one. On acceptance, run the rest of the stage from that worktree. The
  checklist stays at its scratch path in the **invoking** checkout, so removing the worktree
  does not take the run's only artifact with it.

Either way this stage launches the app itself, from the checkout it runs in (§ The walkthrough, step 1).

## The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Its model cannot be routed from inside it, so the
recommendation travels producer-side: the branch-review handoff carries a `Start the fresh
session on <model>` line, resolved from `walkthroughModel` per
`references/model-routing.md`. Where that knob derives rather than pins, the
walkthrough takes the fast tier per `references/delegation.md`.

§ The gate decides which of steps 2, 4 and 5 run.

1. **Launch.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/checklist.md launch-contract`
   and follow it from the checkout this stage runs in, through
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/on-device-launch.mjs"`: first `stop`, which ends whatever
   an earlier session left running, then `start --cmd '<command>'` once per `Launch:` line, then
   `ready` with the checklist's `Ready:` check (`--url <url>` or `--log-match <regex>`). When
   `start` or `ready` fails, show the human its output and have them start the app; continue
   once they say it is up.
2. **Agent pass** (`auto`, `auto-ok`). Dispatch `devcycle:on-device-driver` with the launched URL
   and every `structural` and `agent-observable` item. It runs on this session's model, the one
   `walkthroughModel` recommended above. The driver reports observations, never a verdict. Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/checklist.md tiers` and apply
   it to what the driver reported.
3. **Announce the gate.** One line, before the first question: the gate, why it applies, and the
   split, e.g. `onDeviceGate=auto (default); driver available: 4 structural items auto-checked,
   3 proposed for one confirmation, 2 for you one by one`. Offer every `Feasibility:` item for a
   waive in the same message, before any item is walked.
4. **Batch** (`auto`; under `auto-ok`, the observed failures only). Put every `agent-observable`
   item and every observed failure into ONE question: per item, the proposed verdict (with a
   severity for a `FAILED`), a one-line observation and the evidence path. Options: **Confirm
   all**, or Other, naming the items to override and their verdicts. List the `(auto)`-ticked
   items in the same message; they need no answer.
5. **Human pass** (`auto`: the `needs-eyes` items; `human-required`: every item), under the
   interview rule below.
6. **Teardown.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/on-device-launch.mjs" stop` whenever the
   stage ends: complete, blocked, or stopped for a user decision.

**No driver** (claude-in-chrome not connected): nothing is ticked `(auto)`, every item goes to
the human pass, and the announce line says so (`driver unavailable: all N items are yours`).

Interview rule: **ONE question per checklist item, never batched** for every `needs-eyes` item, and for
every item under `human-required`. This is a deliberate exception to devcycle's batched-interview
standard, because findings quality drops when items are bundled. Each question covers exactly
one item and tells the human how to observe it (where to click, which viewport, which theme).
Wait for the verdict before the next item. A verdict given via Other, in the batch or on one
item, appends `user-correction-at-gate` on the in-cycle entry, where a run record exists, and
nothing on standalone `/devcycle:verify` — `references/ledger.md` owns that condition. Under
`human-required` the driver may still observe an item to help the human; the human still gives
every verdict.

The walkthrough ends with an agent-actionable results report, one line per item, plain
language, symptom first. Run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/checklist.md verdicts` for its
words and markers:

```markdown
## On-device results: <feature>
- <item>: passed (auto: .devcycle/evidence/<file>) — <what the driver read>
- <item>: passed (confirmed from batch) — <what the agent observed>
- <item>: passed — <what the user confirmed seeing>
- <item>: FAILED — <what the user sees instead> — severity: <high|medium|low>
- <item>: waived — <the reason>
- <item>: unverified — <why no one could observe it>
```

## The gate

Read `onDeviceGate` from the `knobs:` line per `${CLAUDE_PLUGIN_ROOT}/references/config.md`
§ Knob channel. What each resolved value means here:

| Value | Agent pass | The human answers | The stage is complete when |
| --- | --- | --- | --- |
| `auto` (default) | yes | the batch and the `needs-eyes` items | every item has an `(auto)` tick, a confirmed batch verdict, or a per-item human verdict |
| `human-required` | none; the driver may observe an item to help the human | every item, one question each | every item has a human verdict |
| `auto-ok` | yes | only the batch of observed failures, when there are any | the agent pass has run and every observed failure has a human verdict; every other item without an `(auto)` tick is listed in the handoff as `unverified` residue |

`auto-ok` relaxes the closing condition, never the reporting: the handoff still states which
happened — a human pass, or a close without one and what stayed unverified. It never licenses
reporting a walkthrough that did not run as done, and never fakes a checkmark.

## Standalone runs

`/devcycle:verify <branch>` is not a pipeline stage and owns no cycle. It **must not create,
read-modify, or write `.devcycle/state.md`** — an existing state file belongs to somebody
else's in-flight cycle, exactly as `playbooks/writing-the-findings-document.md`'s
standalone rule establishes. The checklist is scratch at the diff-derived path
`${CLAUDE_PLUGIN_ROOT}/references/checklist.md` pins, handled as that file states, and its
path goes in the handoff and nowhere else. Everything else — walkthrough, interview rule,
gate, results report — is unchanged: a standalone run is a different source for the checklist,
not a different standard for verifying it.

## Handoff

The two paths differ in one thing, the state file:

- **In-cycle:** end the stage by updating `.devcycle/state.md` — set `stage: finish`, the
  stage the next session resumes at.
- **Standalone:** write no state file and set no stage; the block names the branch, the
  checklist path, and the results instead.

Both then emit the handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with the
same contents:

- `Artifacts:` the checklist path and the results report path — or `none (no rendered
  surface)` when this stage judges itself not applicable. Evidence the driver captured
  (DOM dumps, console output, screenshots) lives under `.devcycle/evidence/`.
- `Carry-overs:` failed items with severity, unverified residue under `auto-ok`, the skip
  reason when skipped, or `none`.
- `Compaction hint:` n/a — clears. Failed items already carry via `Carry-overs:`.
