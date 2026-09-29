# First-run configuration

This file is the single owner of devcycle's first-run configuration dialogue.
Only `/devcycle:cycle` runs it — no other stage loads it.

## First-run configuration

`/devcycle:cycle` runs this only when its first-run test passes — after it resolves knobs,
before triage; no other command offers configuration. Nothing here is profile-conditional. Every question below takes an Other answer, and none of them journals one: `user-correction-at-gate` needs a run record, and this walkthrough runs before `/devcycle:cycle` mints it — `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns that condition.

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
`claude plugin install devcycle@devcycle --config profile=<value>` — and nothing else:
writing any other knob would freeze this moment's value, because an explicitly configured
knob beats the profile verbatim for as long as it stays configured (`references/config.md`
§ Knob resolution), so the profile could never move it again. Report each install command's
exit status — `/devcycle:cycle` re-resolves with only the values whose install exited 0.

### The five-knob customize path

Ask the five knobs in one AskUserQuestion batch — one line of meaning each, the default
marked "(recommended)" — then write ONLY the knobs whose answer differs from the offered
default, one `--config` per changed knob. A knob the user simply accepted at its
"(recommended)" value is left unwritten — same rationale as the walkthrough above: writing
it would make that knob explicitly configured forever. If every
answer matches its default, nothing is written. The five:

- `gitPolicy` — what the finish stage may do with the branch (`local-commits-only`
  recommended · `push-allowed` · `open-pr`).
- `docTrackingPolicy` — what devcycle attempts to commit in a host repo (`standard`
  recommended · `all-local` · `all-tracked`); the repo's own `.gitignore` always wins.
  Outside the profile matrix, like `gitPolicy`.
- `reviewDepth` — branch review engine (`single` recommended · `panel`).
- `crossModelReview` — add a cross-model lens to the review panel (`false` recommended ·
  `true`).
- `onDeviceGate` — whether the on-device checklist closes only via a human walkthrough
  (`human-required` recommended · `auto-ok`).

Model knobs are excluded either way: models are chosen automatically per task unless you pin
one in `/plugin configure`.

Record what was written on the `configured:` line — the date plus the KEY=VALUE list, or
`defaults` when the walkthrough ran and wrote nothing (a customize pass that accepted
every default). Either way the line stops reading `no`, so the walkthrough is offered once
and not again.
