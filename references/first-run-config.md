# First-run configuration

This file is the single owner of devcycle's first-run and upgrade configuration dialogue.
Only `/devcycle:cycle` runs it — no other stage loads it.

## First-run configuration

`/devcycle:cycle` runs this once per repo, after it writes the state file and before
triage; no other command offers configuration. Nothing here is profile-conditional. Every question below takes an Other answer, and none of them journals one: `user-correction-at-gate` needs a run record, and this walkthrough runs before `/devcycle:cycle` mints it — `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns that condition.

Read six knobs as they render in THIS text — `${user_config.profile}`,
`${user_config.gitPolicy}`, `${user_config.docTrackingPolicy}`,
`${user_config.reviewDepth}`, `${user_config.crossModelReview}`,
`${user_config.onDeviceGate}` — each either
substituted to a real value (explicitly configured) or still a literal `${user_config`
placeholder (never configured). That reading picks exactly one path, checked in order:

1. `profile` substituted → it is already configured; skip to triage.
2. `profile` literal AND at least one of the five behavioural knobs substituted AND the
   `configured:` line does NOT carry `· profile-asked` → **the upgrade offer** below.
3. `profile` literal, all five behavioural knobs literal, AND the `configured:` line
   reads `no` → **the first-run walkthrough** below.

Anything else skips to triage.

### The upgrade offer (explicit knobs shadow the profile)

Two different users render path 2's knob combination, and the marker is the only thing
that tells them apart. Someone who configured **before** `profile` existed — most likely
through the pre-0.8.0 walkthrough, which wrote all four knobs explicitly, including on
its "use defaults" answer — has never been asked about `profile`, and their knobs will
silently make any profile they pick do nothing; this offer is for them. Someone already
asked on **this** release, whose answer wrote a knob without writing `profile` (the
customize path does exactly that), pinned that knob deliberately and must never be asked
to undo it. Reaching this offer therefore means the profile question has not yet been put
to this user in this repo.

Only profile-covered knobs can shadow a profile. The **shadowing set** is whichever of
`reviewDepth` and `onDeviceGate` render substituted. `gitPolicy`, `docTrackingPolicy`,
and `crossModelReview` are outside the profile matrix — an explicit value there shadows
nothing and is never rewritten. If the shadowing set is empty there is nothing to
migrate: run the first-run walkthrough instead and record its outcome exactly as that
section says, marker included.

Otherwise ask ONE AskUserQuestion, before any stage runs — a batch of two:

- **What should govern these settings?** State first, in plain language, which knobs are
  explicitly set and to what, that those values override whatever profile is picked so
  switching profiles would otherwise change nothing, and that `auto` means "let the
  profile govern this" rather than deleting the key. Offer: **adopt a profile and let it
  govern** (recommended) · **keep my current knobs, skip the profile** · **customize
  individual knobs**.
- **Which profile, if you adopt one?** `lean` · `standard` (recommended, its column
  reproduces the pre-0.8.0 defaults) · `thorough`. Ignored unless the first answer is
  *adopt*.

What each answer writes, and nothing more:

- **Adopt** — the profile plus `auto` for each knob in the shadowing set:

  ```
  claude plugin install devcycle@devcycle --config profile=<value> --config reviewDepth=auto --config onDeviceGate=auto
  ```

  dropping the `--config <knob>=auto` for any knob outside that set. `gitPolicy` and
  `crossModelReview` are not written, and neither is any other individual knob: writing
  them would freeze this moment's values, because an explicitly configured knob beats the
  profile verbatim and forever (resolution order above), so the profile could never move
  them again.
- **Keep my current knobs** — nothing is written at all, not even `profile` (unset, it
  reads as `standard`). The state file is what stops the re-ask.
- **Customize** — the five-knob path below, with one change: the comparison baseline is
  each knob's currently configured value shown in the question, not the offered default,
  so a knob is written only when the answer moves it.

Then record the outcome on the `configured:` line per the form list above: the date, the
KEY=VALUE list of what was written (empty on *keep* — not `defaults`, which asserts the
opposite), and the `· profile-asked` marker. So
`configured: 2026-07-27 profile=thorough, reviewDepth=auto · profile-asked` on *adopt*,
and `configured: 2026-07-27 · profile-asked` on *keep*.

**The marker is per-repo; only *adopt* closes the question globally.** *Adopt* writes
`profile`, so it substitutes in every later session everywhere and path 1 takes over.
*Keep* and *customize* leave `profile` unwritten, so the state file is the only record
that the question was asked — and `.devcycle/state.md` lives in one repo. Those two
answers therefore hold for this repo, and the same user starting a cycle in a different
repo is asked once there too. That is the honest limit of a per-repo record, and it is
why the offer never acts on its own: being asked twice across two repos is recoverable,
having a knob silently rewritten is not.

### The first-run walkthrough

ONE AskUserQuestion over `profile` — the preset that sizes cost against rigor across
every stage:

- **`standard` (recommended)** — the default; picking it is also "use defaults, don't
  ask again". Devcycle-native engines, single-reviewer branch review, human-required
  on-device gate.
- **`lean`** — fewer review rounds, shorter evidence tails, `auto-ok` on-device gate.
- **`thorough`** — upstream overlays, review panel, deepest audits.
- **customize individual knobs** — take the five-knob path below instead.

On a profile answer, write **only** the profile —
`claude plugin install devcycle@devcycle --config profile=<value>` — and nothing else,
for the reason the *adopt* answer above gives.

### The five-knob customize path

Ask the five knobs in one AskUserQuestion batch — one line of meaning each, the default
marked "(recommended)" — then write ONLY the knobs whose answer differs from the offered
default, one `--config` per changed knob. A knob the user simply accepted at its
"(recommended)" value is left unwritten — same rationale as the *Adopt* answer above
(lines 146–150): writing it would make that knob explicitly configured forever. If every
answer matches its default, nothing is written. The five:

- `gitPolicy` — what the finish stage may do with the branch (`local-commits-only`
  recommended · `push-allowed` · `open-pr`).
- `docTrackingPolicy` — what devcycle attempts to commit in a host repo (`standard`
  recommended · `all-local` · `all-tracked`); the repo's own `.gitignore` always wins.
  Outside the profile matrix, like `gitPolicy`.
- `reviewDepth` — branch review engine (`single` recommended · `panel` · `auto`).
- `crossModelReview` — add a cross-model lens to the review panel (`false` recommended ·
  `true`).
- `onDeviceGate` — whether the on-device checklist closes only via a human walkthrough
  (`human-required` recommended · `auto-ok` · `auto`).

`auto` on the two profile-covered knobs means "let the profile govern this". It is worth
offering only when the knob is already explicitly configured — reaching this path from
the upgrade offer — since leaving a knob unwritten has the same effect and is what a
first run does anyway. Model knobs are excluded either way: models are chosen
automatically per task unless you pin one in `/plugin configure`.

Record what was written on the `configured:` line — the date plus the KEY=VALUE list, or
`defaults` when the walkthrough ran and wrote nothing (a customize pass that accepted
every default) — **and always the `· profile-asked` marker**, on every completion of this
walkthrough, whether it was reached directly or from the upgrade offer above. Always,
because the customize path writes a moved knob without writing `profile`: without the
marker that user renders the upgrade offer's exact signature on their next cycle, and
would be invited to convert to `auto` the knob they had just deliberately pinned. Either
way the line stops reading `no`, so the walkthrough is offered once and not again.
