---
description: "Run the devcycle pipeline: triage a feature/bug/refactor description, then walk scoping → spec → plan → execution → review → verification."
---

# /devcycle:cycle

Run the devcycle pipeline for the request in `$ARGUMENTS`. Files are the state; the
conversation is a cache — every stage writes its artifacts to disk so the pipeline
survives `/clear` and resumes via `/devcycle:continue`.

## Conventions this command does not restate

- Knobs, the `profile`, and model tiers: `${CLAUDE_PLUGIN_ROOT}/references/config.md`.
- Stage boundaries — handoff block shape, context actions, the await gate:
  `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`.
- Branch discipline before any stage that commits:
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md`.
- How this command and every agent it dispatches reports:
  `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Step 0 — create the state file (FIRST action, binding)

Before triage, before any stage work, before any other output: ensure the state
file exists at exactly `<repo root>/.devcycle/state.md`, where repo root is
`git rev-parse --show-toplevel` of the current working directory — never a state
file found anywhere else (a parent directory, a sibling checkout, a search hit).
If it is absent, create it with `stage: scoping`, the current repo root and
branch, a one-line `request:` distilled from `$ARGUMENTS`, `configured: no`, and
`none` for every artifact line.

**Ownership check first, on any existing file:** if its `root:` line differs
from the current repo root, the file belongs to another checkout or leaked from
another project — never resume or silently reset it. Tell the user what its
`root:` and `request:` say, and let them choose: adopt it (the repo genuinely
moved — rewrite `root:` to the current toplevel, keep everything else) or start
fresh. A file with no `root:` line predates this format and is not foreign:
adopt it by writing `root:` and `request:` at the next rewrite.

Then: if the file has `stage: done` (a prior completed cycle in this repo),
carry its `configured:` line forward unchanged and reset every other line for
the new cycle (fresh `request:` included). If it has any OTHER stage, an
in-flight cycle exists: do NOT reset it — tell the user, naming its stage,
branch, and `request:`, and offer to resume it via `/devcycle:continue` or to
start over; only on explicit confirmation of starting over reset the file
(carrying `configured:` forward as above). This shape is the single source of
truth — every later rewrite uses exactly it:

```markdown
# devcycle state
- stage: <scoping|audit|diagnosis|brainstorm|planning|execution|branch-review|on-device|fast-path|sweep|finish|done>  (the stage to RESUME at)
- root: <absolute repo toplevel this cycle belongs to>
- branch: <git branch>
- request: <one line: what this cycle is building/fixing>
- scope: <path or none>
- audit: <path or none>
- diagnosis: <path or none>
- spec: <path or none>
- plan: <path or none>
- ledger: .devcycle/ledger.md
- checklist: <path or none>
- configured: <no | defaults | date + KEY=VALUE list>
- updated: <ISO-8601 UTC>
```

`root:` and `request:` pin the file to one project and one goal: every reader
verifies `root:` against its own `git rev-parse --show-toplevel` before trusting
anything else in the file.

`stage:` records the stage the NEXT session should resume at, never the stage
just completed: at every transition, write the upcoming stage's name.

Creating this file is the pipeline's first action, not a side effect of the first
stage transition — a cycle interrupted mid-scoping must still leave a state file
for `/devcycle:continue` to resume from. If triage (below) picks a later entry
stage, that is a stage transition: rewrite the file then.

## First-run configuration (after Step 0, before triage)

Offer the one-time configuration walkthrough if and only if BOTH hold:
`${user_config.profile}` still renders as a literal `${user_config` placeholder,
AND the state file's `configured:` line reads `no`. Otherwise skip straight to
triage.

The walkthrough is ONE AskUserQuestion over `profile` — the preset that sizes
cost against rigor across every stage:

- **`standard` (recommended)** — the default; picking it is also "use defaults,
  don't ask again". Devcycle-native engines, single-reviewer branch review,
  human-required on-device gate.
- **`lean`** — fewer review rounds, shorter evidence tails, `auto-ok` on-device
  gate.
- **`thorough`** — upstream overlays, review panel, deepest audits.
- **customize individual knobs** — take the four-knob path below instead.

On a profile answer, write **only** the profile:

```
claude plugin install devcycle@devcycle --config profile=<value>
```

Nothing else, deliberately: an explicitly configured knob wins over the profile
verbatim and forever (resolution order in `references/config.md`), so writing
the individual knobs here would freeze this moment's values and the profile
would never move them again.

The **customize** path asks the existing four knobs in one AskUserQuestion batch
— one line of meaning each, the default marked "(recommended)" — and then writes
ONLY the knobs whose answer differs from the offered default, one `--config` per
changed knob. A knob the user simply accepted at its "(recommended)" value is
left unwritten, for the same reason the profile branch writes nothing but the
profile: writing it would make that knob explicitly configured, and an explicit
knob wins over the profile forever, so a later `profile: thorough` would never
move it. If every answer matches its default, nothing is written. The four:

- `gitPolicy` — what the finish stage may do with the branch
  (`local-commits-only` recommended · `push-allowed` · `open-pr`).
- `reviewDepth` — branch review engine (`single` recommended · `panel`).
- `crossModelReview` — add a cross-model lens to the review panel
  (`false` recommended · `true`).
- `onDeviceGate` — whether the on-device checklist closes only via a human
  walkthrough (`human-required` recommended · `auto-ok`).

Model knobs are excluded either way: models are chosen automatically per task
unless you pin one in `/plugin configure`.

Record what was written in the state file's `configured:` line — the date plus
the KEY=VALUE list, or `defaults` when the walkthrough ran and wrote nothing (a
customize pass that accepted every default). Either way the line stops reading
`no`, so the walkthrough is offered once and not again. Because same-session
substitution cannot refresh, stage skills read THIS run's values from that line.

## Triage the input

Judge `$ARGUMENTS` on three axes, then confirm every verdict with the user in
ONE AskUserQuestion **before any stage runs**. Nothing below is
profile-conditional.

**Maturity** picks the entry stage:

- **Rough idea, vague ticket, or one-liner** (scope, intent, or constraints not yet
  established) → start at the **scoping** stage.
- **Detailed ticket or spec** (concrete requirements, constraints, acceptance
  criteria already established) → skip scoping; start at **brainstorm** as a
  validation pass of the provided material. If an approved spec document already
  exists on disk, start at **planning**.
- **Audit-shaped** ("audit X", "review the repo for Y" — an assessment of
  existing code, not a change to it) → the **audit** stage runs **in place of**
  scoping: `devcycle:auditing-a-repo` establishes what is wrong before anything
  is designed, and its selected findings feed brainstorm.

**Kind** (feature | bug | refactor) shapes the walk:

- **Bug** → the **diagnosis** stage runs between scoping and brainstorm unless the
  input already names the root cause with evidence (not a hunch — a stated cause
  plus how it was established). You cannot spec a fix for an undiagnosed problem:
  scoping for a bug collects the symptom and reproduction, diagnosis establishes
  the cause, and only then is a fix designed. A mature bug ticket with
  reproduction but unknown cause enters at **diagnosis**, not brainstorm.
- **Feature / refactor** → diagnosis is skipped (its handoff block still records
  the skip only when the stage was entered and judged inapplicable; a kind that
  never routes there emits nothing).

**Size** judges whether the request can skip the full pipeline, via two special
verdicts. **Trivial** requires ALL of:

- fully specified by the request itself, nothing left to design;
- no design decisions and no new interfaces;
- blast radius of roughly two files or fewer, a few lines;
- the evidence class (`red-green` | `green-green` | `convention`) is already
  determinable from the request;
- for bugs, the root cause is already evident.

**Bulk-mechanical** — one uniform edit rule applied identically across many
files — requires ALL of:

- one uniform edit rule, identical for every affected file, no per-file
  judgment;
- the rule fully specified by the request itself, nothing left to design;
- many affected files (beyond fast-path scale, roughly more than three), and
  discoverable by search;
- success checkable by one command.

Any doubt on any one criterion disqualifies that verdict. Trivial beats
bulk-mechanical; an undiagnosed bug is never either.

### The confirmation (one question, always)

No verdict is ever acted on automatically. State, in the question itself: the
entry stage the maturity verdict picked **and why**, the kind verdict, and the
size verdict when one fired. Offer:

- **Confirm** — start at the announced stage.
- **Start at scoping instead** — the input is less settled than it reads.
- **Take the offered short path** — present only when a short path is on the
  table: `fast-path` (trivial), `sweep` (bulk-mechanical), or `audit` (an
  audit-shaped request, replacing scoping).
- **Run the full pipeline** — discard the short-path verdict and walk the
  stages.

On a confirmed short path, rewrite the state file with `stage: fast-path`,
`stage: sweep`, or `stage: audit` and invoke `devcycle:fast-path`,
`devcycle:sweeping-mechanical-changes`, or `devcycle:auditing-a-repo`
accordingly — for the sweep that is gate 1 of a two-step confirm, the second
gate being the concrete file list and verify command, which belong to the sweep
skill and run before any agent edits. Declined → the verdict is discarded, the
normal maturity/kind walk applies, and nothing extra is recorded.

## State file

Maintain `.devcycle/state.md` (created in Step 0) and rewrite it at EVERY stage
transition, in exactly Step 0's shape with current values: `stage:` names the
stage to resume at (the upcoming stage), and the `configured:` line is always
preserved.

## Stage walk

Run the stages in order, each via the named skill:

1. **scoping** — `devcycle:scoping-interview` (skipped for mature input per triage).
2. **audit** (audit-shaped input only, per triage) — `devcycle:auditing-a-repo`,
   in place of scoping. It writes `docs/audits/YYYY-MM-DD-<topic>.md`, recorded
   in the state file's `audit:` line; the findings the user selects for action
   become brainstorm's explored context. A cycle that ends at the report (no
   change selected) closes there.
3. **diagnosis** (bugs only, per triage) — `superpowers:systematic-debugging`
   (upstream, unmodified): reproduce the failure first, then isolate the root
   cause. The stage ends with a root-cause report written to
   `.devcycle/diagnosis.md` — reproduction steps, the established cause with its
   evidence, and the surfaces involved — recorded in the state file's
   `diagnosis:` line. The report pins the reproduction precisely enough for
   planning to turn it into the fix task's failing test. Design questions
   (how to fix it) stay out: they belong to brainstorm, which takes this report
   as its explored context. If diagnosis overturns the confirmed scope (the bug
   lives somewhere else entirely), say so and return to scoping rather than
   designing a fix for the wrong problem.
4. **brainstorm** — `superpowers:brainstorming` (upstream, unmodified), with two
   notes layered on top. First: the user's batching preference carries into this
   stage — where the upstream skill says to ask questions one at a time, ask via
   AskUserQuestion in batches of 1–4 with concrete options plus Other instead.
   Second: before upstream's "commit the design document to git" step, check
   whether the spec's path is covered by the target repo's own `.gitignore`
   (`git check-ignore`); if so, write the file but skip the commit — respect the
   repo's own ignore rules rather than force-adding past them. Everything else
   upstream stands. When the spec is approved, transition to
   `devcycle:planning-waves` (not directly to upstream writing-plans).
5. **planning** — `devcycle:planning-waves`.
6. **execution** — `devcycle:executing-waves`.
7. **branch-review** — `devcycle:reviewing-the-branch`.
8. **on-device** — `devcycle:verifying-on-device` (skip only when the change has no
   rendered/on-device surface; record the skip in the handoff).
9. **finish** — `devcycle:finishing-the-cycle`: resolves the effective git policy
   (the configured `gitPolicy` clamped by two external push signals), acts on it,
   and closes the state file with `stage: done`.

At `lean` and `standard`, planning and execution run devcycle-native — the two
skills above are the whole engine. At `thorough` they overlay their upstream
counterparts. Each skill owns that switch and resolves the profile per
`${CLAUDE_PLUGIN_ROOT}/references/config.md`; do not second-guess it from here.
