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
- configured: <no | defaults | date + KEY=VALUE list (possibly empty)>[ · profile-asked]
- updated: <ISO-8601 UTC>
```

`root:` and `request:` pin the file to one project and one goal: every reader
verifies `root:` against its own `git rev-parse --show-toplevel` before trusting
anything else in the file.

`configured:` has one form per outcome, and this is the list that decides between
them: `no` — never offered. `defaults` — an offer ran and wrote nothing because
every answer matched its recommended default, so nothing is explicitly configured.
`<date> + KEY=VALUE list` — an offer ran and wrote those. `<date>` with an empty
list — an offer ran and wrote nothing, but explicit knobs remain from before it
(the upgrade offer's *keep* answer); this is not `defaults`, which asserts the
opposite. The `· profile-asked` marker rides on any of the last three: it records
that this release's configuration question has already been put to the user in
this repo, whichever offer put it there and whatever the answer wrote.

`stage:` records the stage the NEXT session should resume at, never the stage
just completed: at every transition, write the upcoming stage's name.

Creating this file is the pipeline's first action, not a side effect of the first
stage transition — a cycle interrupted mid-scoping must still leave a state file
for `/devcycle:continue` to resume from. If triage (below) picks a later entry
stage, that is a stage transition: rewrite the file then.

## First-run configuration (after Step 0, before triage)

Read five knobs as they render in THIS text — `${user_config.profile}`,
`${user_config.gitPolicy}`, `${user_config.reviewDepth}`,
`${user_config.crossModelReview}`, `${user_config.onDeviceGate}` — each either
substituted to a real value (explicitly configured) or still a literal
`${user_config` placeholder (never configured). That reading picks exactly one
path, checked in order:

1. `profile` substituted → it is already configured; skip to triage.
2. `profile` literal AND at least one of the four behavioral knobs substituted
   AND the `configured:` line does NOT carry `· profile-asked` → **the upgrade
   offer** below.
3. `profile` literal, all four behavioral knobs literal, AND the `configured:`
   line reads `no` → **the first-run walkthrough** below.

Anything else skips to triage. None of this is profile-conditional.

### The upgrade offer (explicit knobs shadow the profile)

Two different users render path 2's knob combination, and the marker is the only
thing that tells them apart:

- someone configured **before** `profile` existed — most likely through the
  pre-0.8.0 walkthrough, which wrote all four knobs explicitly, including on its
  "use defaults" answer. They have never been asked about `profile`, and their
  knobs will silently make any profile they pick do nothing. This offer is for
  them;
- someone already asked on **this** release, whose answer wrote a knob without
  writing `profile` — the customize path does exactly that. They pinned that knob
  deliberately, days ago, and must never be asked to undo it.

The `· profile-asked` marker separates the two, which is why every completion of
either offer writes it. Reaching this offer therefore means the profile question
has not been put to this user in this repo. It is a per-repo record: see the
caveat at the end of this section.

The reason any of this matters is the resolution order in
`references/config.md` — an explicitly configured knob wins over the profile
verbatim and forever.

Only profile-covered knobs can shadow a profile. The **shadowing set** is
whichever of `reviewDepth` and `onDeviceGate` render substituted here.
`gitPolicy` and `crossModelReview` are outside the profile matrix — an explicit
value there shadows nothing and is never rewritten. If the shadowing set is
empty there is nothing to migrate: run the first-run walkthrough below instead
and record its outcome exactly as that section says, marker included.

Otherwise ask ONE AskUserQuestion, before any stage runs — a batch of two:

- **What should govern these settings?** State first, in plain language, which
  knobs are explicitly set and to what, that those values override whatever
  profile is picked so switching profiles would otherwise change nothing, and
  that `auto` means "let the profile govern this" rather than deleting the key.
  Offer: **adopt a profile and let it govern** (recommended) · **keep my current
  knobs, skip the profile** · **customize individual knobs**.
- **Which profile, if you adopt one?** `lean` · `standard` (recommended, its
  column reproduces the pre-0.8.0 defaults) · `thorough`. Ignored unless the
  first answer is *adopt*.

What each answer writes, and nothing more:

- **Adopt** — the profile plus `auto` for each knob in the shadowing set:

  ```
  claude plugin install devcycle@devcycle --config profile=<value> --config reviewDepth=auto --config onDeviceGate=auto
  ```

  Drop the `--config <knob>=auto` for any knob not in the shadowing set.
  `gitPolicy` and `crossModelReview` are not written.
- **Keep my current knobs** — nothing is written at all, not even `profile`
  (unset, it reads as `standard`). The state file is what stops the re-ask.
- **Customize** — the four-knob path below, with one change: the comparison
  baseline is each knob's currently configured value shown in the question, not
  the offered default, so a knob is written only when the answer moves it.

Then record the outcome on the `configured:` line per Step 0's form list: the
date, the KEY=VALUE list of what was written (empty on *keep* — not `defaults`,
which would assert the opposite), and the `· profile-asked` marker. So
`configured: 2026-07-27 profile=thorough, reviewDepth=auto · profile-asked` on
*adopt*, `configured: 2026-07-27 · profile-asked` on *keep*.

**The marker is per-repo; only *adopt* closes the question globally.** *Adopt*
writes `profile`, so `${user_config.profile}` substitutes in every later session
everywhere and path 1 takes over. *Keep* and *customize* leave `profile`
unwritten, so the state file is the only record that the question was asked — and
`.devcycle/state.md` lives in one repo. Those two answers therefore hold for this
repo, and the same user starting a cycle in a different repo will be asked once
there too. That is the honest limit of a per-repo record, and it is why the offer
never acts on its own: being asked twice across two repos is recoverable, having
a knob silently rewritten is not.

### The first-run walkthrough

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
- `reviewDepth` — branch review engine (`single` recommended · `panel` · `auto`).
- `crossModelReview` — add a cross-model lens to the review panel
  (`false` recommended · `true`).
- `onDeviceGate` — whether the on-device checklist closes only via a human
  walkthrough (`human-required` recommended · `auto-ok` · `auto`).

`auto` on the two profile-covered knobs means "let the profile govern this". It
is worth offering only when the knob is already explicitly configured — reaching
this path from the upgrade offer — since leaving a knob unwritten has the same
effect and is what a first run does anyway.

Model knobs are excluded either way: models are chosen automatically per task
unless you pin one in `/plugin configure`.

Record what was written in the state file's `configured:` line — the date plus
the KEY=VALUE list, or `defaults` when the walkthrough ran and wrote nothing (a
customize pass that accepted every default) — **and always the `· profile-asked`
marker**, on every completion of this walkthrough, whether it was reached
directly or from the upgrade offer above. Always, because the customize path
writes a moved knob without writing `profile`: without the marker that user
renders the upgrade offer's exact signature on their next cycle, and would be
invited to convert to `auto` the knob they had just deliberately pinned. The
marker is the record that this release has already asked; nothing else on the
line distinguishes a knob pinned by choice from one inherited from an older
version. Either way the line stops reading `no`, so the walkthrough is offered
once and not again. Because same-session substitution cannot refresh, stage
skills read THIS run's values from that line.

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
  scoping: `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` establishes what is wrong before anything
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
`stage: sweep`, or `stage: audit` and invoke `${CLAUDE_PLUGIN_ROOT}/playbooks/taking-the-fast-path.md`,
`${CLAUDE_PLUGIN_ROOT}/playbooks/sweeping-mechanical-changes.md`, or `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`
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

1. **scoping** — `${CLAUDE_PLUGIN_ROOT}/playbooks/scoping-the-request.md` (skipped for mature input per triage).
2. **audit** (audit-shaped input only, per triage) — `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`,
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
   `${CLAUDE_PLUGIN_ROOT}/playbooks/planning-waves.md` (not directly to upstream writing-plans).
5. **planning** — `${CLAUDE_PLUGIN_ROOT}/playbooks/planning-waves.md`.
6. **execution** — `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md`.
7. **branch-review** — `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md`.
8. **on-device** — `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md` (skip only when the change has no
   rendered/on-device surface; record the skip in the handoff).
9. **finish** — `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md`: resolves the effective git policy
   (the configured `gitPolicy` clamped by two external push signals), acts on it,
   and closes the state file with `stage: done`.

At `lean` and `standard`, planning and execution run devcycle-native — the two
skills above are the whole engine. At `thorough` they overlay their upstream
counterparts. Each skill owns that switch and resolves the profile per
`${CLAUDE_PLUGIN_ROOT}/references/config.md`; do not second-guess it from here.
