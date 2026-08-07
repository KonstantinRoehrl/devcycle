# Verifying On-Device

## Overview

Rendered outcomes — how the UI looks, feels, and behaves on a real device — have no proving
command; the human walking the running app is the verification command. Claiming one from a
script, a screenshot, or a code reading is an unverified completion claim
(`superpowers:verification-before-completion`, REQUIRED background).

This playbook is the on-device stage proper — walkthrough, gate, handoff — run in a fresh
session after the branch review. Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Checklist source

Two sources, one engine. Which one applies is settled before the walkthrough begins;
everything after is identical either way.

**Plan-derived (in-cycle).** `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` produced
the checklist during execution; read its path from the `checklist:` field of
`.devcycle/state.md`.

**Diff-derived (standalone, `/devcycle:verify <branch>`).** No checklist exists yet: generate
one from the branch, **automatically — there is no confirmation step**, because the branch is
the whole instruction.

- *Base and changed files*: follow "Deriving a branch's file set" in
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md`. Its merge-base guard is what keeps the
  walkthrough from being handed a file set built from local uncommitted edits.
- *Affected UI areas*: from the changed files, trace routes, navigation, and component usage
  outward — which screens render these components, which routes reach those screens —
  repeating until an iteration pulls in no new surface. Items are written against those
  surfaces, not against the changed files: a diff in a shared component is verified wherever
  it renders.
- *Generation*: follow `${CLAUDE_PLUGIN_ROOT}/references/checklist.md`. Its `Where:` and
  `How to get there:` fields are REQUIRED here: without a plan, nothing else tells the human
  where to look.
- *Nothing renders*: if the traced set contains no rendered surface, write no checklist, and
  report the stage not applicable with that reason — the same outcome the in-cycle skip has.

Generating the checklist needs only git refs; the walkthrough needs the branch's files on
disk. When `<branch>` is not the current checkout, generate the checklist, say so plainly, and
offer two ways forward — this stage switches the checkout in neither:

- **The user checks the branch out** in the current checkout and starts the app there; or
- **a throwaway worktree**, offered exactly as `${CLAUDE_PLUGIN_ROOT}/references/branch.md`
  says to offer one. On acceptance, run the rest of the stage from that worktree. The
  checklist stays at its scratch path in the **invoking** checkout, so removing the worktree
  does not take the run's only artifact with it.

Either way the human starts the app: this stage does not build, serve, or launch anything.

## The walkthrough

Runs in a **fresh session** — it needs only the checklist path and the branch, nothing from
the implementation conversation. Its model cannot be routed from inside it, so the
recommendation travels producer-side: the branch-review handoff carries a `Start the fresh
session on <model>` line, resolved from `walkthroughModel` per
`${CLAUDE_PLUGIN_ROOT}/references/config.md`. Where that knob derives rather than pins, the
walkthrough takes the fast tier per `${CLAUDE_PLUGIN_ROOT}/references/delegation.md`.

Interview rule: **ONE question per checklist item, never batched** — a deliberate exception to
devcycle's batched-interview standard, because findings quality drops when items are bundled.
Each question covers exactly one item and tells the human how to observe it (where to click,
which viewport, which theme). Wait for the verdict before the next item. When the app renders
as a page and claude-in-chrome is connected, dispatch `devcycle:on-device-driver` to observe an
item rather than observing it yourself; the human still gives every verdict.

The walkthrough ends with an agent-actionable results report, one line per item, plain
language, symptom first:

```markdown
## On-device results: <feature>
- <item>: passed — <what the user confirmed seeing>
- <item>: FAILED — <what the user sees instead> — severity: <high|medium|low>
```

## The gate

Resolve `onDeviceGate` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`. What each resolved
value means here:

- `human-required`: the stage is complete ONLY when every non-`(auto)` item has a human
  verdict from the walkthrough.
- `auto-ok`: the checklist may close without a human pass — complete once all structurally
  verifiable items are `(auto)`-checked, with the remaining items left unchecked and listed in
  the handoff as unverified residue.

`auto-ok` relaxes the closing condition, never the reporting: the handoff still states which
happened — a human pass, or a close without one and what stayed unverified. It never licenses
reporting a walkthrough that did not run as done, and never fakes a checkmark.

## Standalone runs

`/devcycle:verify <branch>` is not a pipeline stage and owns no cycle. It **must not create,
read-modify, or write `.devcycle/state.md`** — an existing state file belongs to somebody
else's in-flight cycle, exactly as `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`'s
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
  surface)` when this stage judges itself not applicable.
- `Carry-overs:` failed items with severity, unverified residue under `auto-ok`, the skip
  reason when skipped, or `none`.
- `Compaction hint:` Keep checklist path, branch, failed items. Drop walkthrough transcript.
