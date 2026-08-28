---
description: "Run the devcycle pipeline: triage a feature/bug/refactor description, then walk scoping → spec → plan → execution → review → verification."
---

# /devcycle:cycle

Run the devcycle pipeline for the request in `$ARGUMENTS`. Files are the state, the conversation
is a cache: every artifact is on disk, so the pipeline survives `/clear` and resumes via
`/devcycle:continue`.

## Conventions this command does not restate

- Knobs, the `profile`, and model tiers: `${CLAUDE_PLUGIN_ROOT}/references/config.md`.
- The first-run configuration this command runs once per repo — after the state file, before
  triage: `${CLAUDE_PLUGIN_ROOT}/references/first-run-config.md`.
- The state file's shape, lifecycle, ownership check: `${CLAUDE_PLUGIN_ROOT}/references/resume.md`.
- Stage boundaries — handoff shape, context actions, await gate: `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`.
- Branch discipline before any stage that commits: `${CLAUDE_PLUGIN_ROOT}/references/branch.md`.
- How this command and its agents report: `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Before the first confirmation

Before the first user confirmation, this command may only read the repository, write `.devcycle/state.md`, resolve config, then
mint the run record and append its `session` line — both after config resolution, so `--profile` is already known. Mint: `node
${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs new --plugin-version <this plugin's plugin.json version> --plugin-sha <git -C
${CLAUDE_PLUGIN_ROOT} rev-parse HEAD> --profile <the resolved profile> --knob gitPolicy=<value> --knob reviewDepth=<value>
--knob crossModelReview=<value> --knob onDeviceGate=<value> --knob implementerModel=<value> --knob taskReviewerModel=<value>
--knob branchReviewModel=<value> --knob walkthroughModel=<value>`, its id on the `run:` row. Then: `run-record.mjs append --run
<that id> --kind session --sessionId "$CLAUDE_CODE_SESSION_ID"`. No branch, no commit. These are the pipeline's first actions,
not a side effect of the first stage transition: a cycle interrupted mid-scoping still leaves something to resume from. A state
file at `stage: done` is reused — carry `configured:`, mint a fresh `run:` and `session` line, reset the rest, ask nothing; not
a collision. At any other stage, surface the collision and ask — never overwrite it.

## Triage the input

Judge `$ARGUMENTS` on three axes, then confirm every verdict with the user in ONE
AskUserQuestion **before any stage runs**. Nothing here is profile-conditional. The run record is minted by now, so an Other answer at this gate or any later one appends `user-correction-at-gate`, whose rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns.

**Maturity** picks the entry stage: a rough idea, vague ticket, or one-liner starts at
**scoping**; a detailed ticket or spec skips it for **brainstorm** as a validation pass, or
**planning** when an approved spec already exists on disk; an audit-shaped request ("audit X",
"review the repo for Y" — an assessment of existing code, not a change to it) runs **audit** in
place of scoping, establishing what is wrong before anything is designed and feeding brainstorm.

**Kind** shapes the walk. A **bug** routes through **diagnosis** between scoping and brainstorm unless the
input already names the root cause with evidence — a stated cause plus how it was established, never a
hunch; a fix cannot be specced for an undiagnosed problem, so a mature bug ticket with a reproduction but no
known cause enters at **diagnosis**. **Feature** and **refactor** skip diagnosis entirely.

**Size** may offer a short path. **Trivial** (`fast-path`): fully specified by the request
itself, no design decisions and no new interfaces, a blast radius of roughly two files and a few
lines, an evidence class already determinable, and for a bug a root cause already evident.
**Bulk-mechanical** (`sweep`): one uniform edit rule applied with no per-file judgment, fully
specified, many affected files (beyond fast-path scale) discoverable by search, success
checkable by one command. Both need every criterion — any doubt disqualifies the verdict, and
trivial beats bulk-mechanical; an undiagnosed bug is never either.

**The confirmation, one question, always.** No verdict is ever acted on automatically. State in
the question itself the entry stage the maturity verdict picked **and why**, the kind verdict,
and the size verdict when one fired. Offer: **confirm** · **start at scoping instead**, the
input being less settled than it reads · **take the offered short path**, only when one is on
the table · **run the full pipeline**. Declined → the verdict is discarded, the normal
maturity/kind walk applies, and nothing extra is recorded.

Once confirmed, write `- kind: <the confirmed requestKind>` onto `.devcycle/state.md` — the exact
form `- kind: <feature|bug|refactor|audit|docs|chore>` — and append the triage run-record line:
`run-record.mjs append --run <runId> --kind triage --requestKind <feature|bug|refactor|audit|docs|chore> --entryStage <the confirmed entry stage>`.
This is what makes `requestKind` available to doctor independently of the workload record — the
non-circular signal the `missing-workload` compliance check needs — written once per cycle.

On a confirmed short path, rewrite the state file with `stage: fast-path`, `stage: sweep`, or
`stage: audit` and enter that playbook from the walk below. For the sweep this is gate 1 of a
two-step confirm; the second gate is the concrete file list and verify command, which the sweep
playbook owns and runs before any agent edits.

## Stage walk

Run these in order, rewriting the state file at every transition; two short paths bypass the walk on
confirmation (`fast-path`, `sweep`). One further stage, `receiving-review`, is off-walk in a different
sense: it is a standalone `reconcile` stage entered directly, never reached by this pipeline
walk, so it carries a resume row but no numbered entry below. Each stage's playbook and its re-entry
conditions live in
`${CLAUDE_PLUGIN_ROOT}/references/resume.md` § Resuming at the recorded stage. The line below is the
stage enum's single source of truth — `scripts/validate.mjs` reads its literal form:

- stage: <scoping|audit|diagnosis|brainstorm|planning|execution|branch-review|on-device|fast-path|sweep|receiving-review|finish|done>

1. **scoping** — (skipped per triage).
2. **audit** (audit-shaped input only) — in place of scoping. It writes
   `docs/audits/YYYY-MM-DD-<topic>.md`, recorded on the state file's `audit:` line; a cycle that
   ends at the report, no change selected, closes there.
3. **diagnosis** (bugs only) — `superpowers:systematic-debugging` (upstream, unmodified):
   reproduce the failure, then isolate the root cause. The stage ends by writing a root-cause
   report to `.devcycle/diagnosis.md` — reproduction steps, the established cause stated with the
   command or output that establishes it (per evidence.md § Authored claims), the surfaces
   involved — recorded on the `diagnosis:` line, and pinned precisely
   enough for planning to turn the reproduction into the fix task's failing test. How to fix it
   belongs to brainstorm, which takes the report as its context; if diagnosis overturns the
   confirmed scope, return to scoping.
4. **brainstorm** — `superpowers:brainstorming` (upstream, unmodified) with two notes on top.
   Ask in AskUserQuestion batches of 1–4 with concrete options plus Other, where upstream asks
   one question at a time. And gate upstream's "commit the design document to git" step per
   `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc tracking: resolve
   `${user_config.docTrackingPolicy}` first, then `git check-ignore` the spec's path — write the
   file and skip the commit unless both permit it. An approved spec transitions to planning below,
   never directly to upstream's writing-plans.
5. **planning** — wave-based plan.
6. **execution**.
7. **branch-review**.
8. **on-device** — skipped only when the change has no rendered surface (record the skip in the
   handoff).
9. **finish** — closing the state file with `stage: done`.

Whether planning and execution run devcycle-native or overlay their upstream counterparts is the
`profile`'s call, resolved by each playbook per `${CLAUDE_PLUGIN_ROOT}/references/config.md`.
