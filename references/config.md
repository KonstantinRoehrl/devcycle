# Configuration — knobs, profile, model tiers

The single owner of how devcycle resolves configuration. A skill, command, or agent
that needs any of this names this file and does not restate it.

## Knob resolution

Knob values arrive via `${user_config.KEY}` placeholders, each read by the stage
skill that consumes it (gitPolicy by `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md`,
docTrackingPolicy by every stage that writes an artifact — § Doc tracking below owns which —
models and review depth and the on-device gate by their stages).

**Resolution order — binding, and stated only here.** For every knob, in order:

1. **An explicitly configured value wins, verbatim**: one that is neither a
   literal `${user_config...}` placeholder nor `auto`, and that lies inside the
   knob's allowed set. It beats the profile and any documented default, for as
   long as it stays configured. For a `*Model` knob the allowed set includes an
   ordered, comma-separated pool of ids as well as a single id — the Model tiers
   section below owns what a pool means.
2. **Everything else falls back** — a literal placeholder and `auto` are unset, a
   value outside the knob's allowed set is invalid, and both take the same route.
   `auto` is sanctioned on every knob, not only the `*Model` ones: it is how a user
   says *let the profile govern this* without deleting the key. Where a stage skill
   enumerates a knob's allowed values (e.g. `single` | `panel`), that names what the
   knob resolves *to* — `auto` is settled here, before that enumeration applies, and
   is never the invalid case. A knob with a row in the profile matrix below falls
   back to that row's column value; every other knob — `gitPolicy`,
   `crossModelReview`, and the `*Model` knobs (whose unset value is `auto`, derived
   per the model tiers below) — falls back to its own documented default.
3. **`profile` itself** takes the same two steps: a literal placeholder or a value
   outside `lean | standard | thorough` is unset, and falls back to `standard`.
4. **The state file's `configured:` line supplies the configured value** for steps
   1–3 whenever a knob's placeholder still renders literally but that line records
   one for it — same-session substitution cannot refresh, so `--config` writes only
   reach future sessions.

## The knob roster

Every knob devcycle ships, the surface that owns how it resolves — a playbook, or a section of
this file — and what an unset value falls back to.
This set is hand-kept in three places — this table, README's config table, and
`.claude-plugin/plugin.json`'s `userConfig` — so `tests/unit/golden-path.test.mjs` asserts the
three carry the same keys; without it the copies drift one release at a time.

| Knob | Owner | Falls back to |
| --- | --- | --- |
| `profile` | § The profile, below | `standard` |
| `gitPolicy` | `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` | `local-commits-only` |
| `docTrackingPolicy` | § Doc tracking, below | `standard` |
| `reviewDepth` | `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md` | the profile's branch-review row |
| `crossModelReview` | `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md` | `false` |
| `onDeviceGate` | `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md` | the profile's on-device row |
| `implementerModel` | `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` | `auto` — § Model tiers derives it per task |
| `taskReviewerModel` | `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` | `auto` — § Model tiers derives it per task |
| `branchReviewModel` | `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md` | `auto` — the session's own model |
| `walkthroughModel` | `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md` | `auto` — a fast model |

An unset knob is a literal `${user_config...}` placeholder or `auto`; the resolution order above
owns what "unset" then resolves to, and this column only names the endpoint.

## The state file's `configured:` line

`.devcycle/state.md` carries one `configured:` line, written in the form
`<no | defaults | date + KEY=VALUE list (possibly empty)>[ · profile-asked]`
(`${CLAUDE_PLUGIN_ROOT}/references/resume.md` owns the rest of that file's shape).
One form per outcome, and this is the list that decides between them:

- `no` — configuration was never offered.
- `defaults` — an offer ran and wrote nothing because every answer matched its
  recommended default, so nothing is explicitly configured.
- `<date>` plus a KEY=VALUE list — an offer ran and wrote those.
- `<date>` with an empty list — an offer ran and wrote nothing, but explicit knobs
  remain from before it (the upgrade offer's *keep* answer). This is not `defaults`,
  which asserts the opposite.

The `· profile-asked` marker rides on any of the last three. **Its only producer is
first-run configuration below** — every completion of either offer writes it — **and
its only consumer is that section's path 2**, which is what stops the configuration
question being put twice to
the same user in the same repo. Nothing else on the line distinguishes a knob pinned
by choice from one inherited from an older version.

## The profile

`profile` ∈ `lean | standard | thorough`, default `standard`.

| | `lean` | `standard` | `thorough` |
| --- | --- | --- | --- |
| planning / execution engine | devcycle-native compact | devcycle-native compact | upstream overlays |
| branch review engine (`reviewDepth`) | `single` | `single` | `panel` |
| on-device gate (`onDeviceGate`) | `auto-ok` | `human-required` | `human-required` |
| evidence tail in reports | 10 lines | 20 lines | 50 lines |
| branch-review round cap | 2 | 3 | 5 |
| audit depth | named criteria, ranked findings | full criteria sweep | full sweep + adversarial verification |
| learn depth | journal + memory | + archives / findings / ledgers + user-correction turns | + raw transcripts |

Which column applies, and when a knob overrides it, is the resolution order above —
this table supplies the values, not the rule for choosing them.

The learn depth column controls how deep a run mines, staged densest signal
first: **journal → memory → archives/findings/ledgers → user-correction turns → raw transcript text**.
Gating is by profile, never by token budget or a signal heuristic — a budget gate would make
coverage nondeterministic and destroy the marginal-vs-first-run comparison the measurement gate
depends on.

**Never profile-conditional:** the state file, handoff blocks, evidence classes, the
coordinator's green gate, the `gitPolicy` clamps, branch discipline, the one-`task-reviewer`
floor on short paths, and the never-assume interview rule. A `lean` run may skip a stage; it
never fakes one and never reports a gate as passed that did not run.

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

## Doc tracking — what each policy commits

`docTrackingPolicy` ∈ `all-local | standard | all-tracked`, default `standard`. It sits outside
the profile matrix, so no profile column moves it. This table is the single owner of what each
policy does with each artifact devcycle writes; a stage that writes one names this table instead
of deciding for itself.

| Artifact | `all-local` | `standard` (default) | `all-tracked` |
| --- | --- | --- | --- |
| spec — `docs/superpowers/specs/` | local | local | commit |
| plan — `docs/superpowers/plans/` | local | local | commit |
| lessons — `docs/devcycle/lessons.md` | local | commit | commit |
| promotion records — `docs/devcycle/promotions/` | local | commit | commit |
| audit report — `docs/audits/` | local | commit | commit |
| on-device checklist, in-cycle — `docs/<feature>/` | never committed | never committed | never committed |
| onboarding scaffold — `CLAUDE.md`, `.gitignore` lines | exempt | exempt | exempt |
| run scratch — `.devcycle/` | never committed | never committed | never committed |

**`git check-ignore` vetoes every `commit` cell, always**, and it is consulted second: the policy
states what devcycle attempts, the host repo's own ignore rules decide what lands. The order is
not interchangeable — a repo where `/devcycle:onboard` never ran has no ignore lines at all, so
gating on `check-ignore` alone fails open.

Three rows state a boundary rather than a policy, which is why their cells agree across all
three columns. The in-cycle checklist is generated by the coordinator mid-wave, and no shipped
step names it in a pathspec, so nothing commits it — there is no commit site to attach a policy
to. Onboarding is exempt because
gating the installer on the policy it installs is circular, and under `all-local` it would leave
the ignore lines the policy depends on unwritten. And `.devcycle/` is run scratch that no policy ever tracks, so there is no cell to vary.

A site that commits an artifact resolves the policy, checks this table permits tracking, checks
`git check-ignore` vetoes nothing, names the side effect, asks the user, then commits with an
explicit pathspec. `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`'s step 3 is the
reference implementation of that order.

## Model tiers

Model names are configuration, not prose. Each stage's `*Model` knob
(`implementerModel`, `taskReviewerModel`, `walkthroughModel`, `branchReviewModel`)
resolves the same way:

- still a literal `${user_config...}` placeholder (unset) OR the value
  `auto` → derive the model per the predicates below;
- a value with no comma → a pin: use it verbatim for every dispatch, subject
  only to the ceiling below;
- a value with one or more commas → a **pool**: an ordered list of ids,
  ascending by capability, position declaring order. Entries are trimmed and
  empties dropped, so a pool that parses to one id is a pin. A pool cannot be
  an array in the manifest — `userConfig` types are `string | number | boolean |
  directory | file` — so the comma is the ordering, not a workaround.

Derivation picks between two tiers — defined by capability, never by a
model id written here, because ids in skill prose rot as models change:

- **session tier** — dispatch with NO model override, so the subagent
  inherits this coordinator session's own model: the strongest model the
  user has already sanctioned, tracking model generations without this
  skill naming any. This only works when the agent definition itself carries
  no `model:` frontmatter key — an omitted dispatch-time override resolves to
  the agent definition's own frontmatter model when it has one, and only
  falls through to the caller's model when the definition names none. The
  session tier therefore requires every agent definition it dispatches to be
  free of a `model:` key.
- **fast tier** — the newest fast/small Claude model available to this
  session (the current Sonnet-class generation). If no such id can be
  resolved with confidence, fall back to the session tier — a stronger
  model is never the wrong direction.

Derivation predicates (dispatch-time-observable inputs only):

- **implementer**: **fast tier by default.** Escalate to session tier only
  on a dispatch-time-observable signal — the task's `**Files:**` block lists
  more than 5 files; or `**Dependencies:**` is anything other than `none`; or
  any step fails to name its file and expected behavior; or a prior review
  round on this task returned blocking findings (escalate on retry, never on
  the first attempt). Measured, fast-tier implementers did the same raw work
  as session-tier ones (785k vs 794k context units, 18k vs 20k output tokens
  per run) at a fifth of the price, and a wrong cheap guess costs at most one
  review round.
- **task-reviewer**: fast tier iff the task diff is ≤400 changed lines
  and ≤5 files; else session tier.
- **research / exploration dispatch** (`references/delegation.md` §
  Research dispatches): fast tier, always — read-only work whose output is a
  map rather than a judgment. Session tier remains for dispatches that must
  judge: review, diagnosis, design.

**The ladder.** A pool uses the same predicates as `auto`, counted rather than
thresholded: `rung = 1 + the number of escalation signals that fired`, clamped
to the pool's length. Zero signals is rung 1, which is why leaving a knob unset
behaves exactly as it does today. `walkthroughModel` and `branchReviewModel`
have no complexity predicate — both judge — so a pool on either saturates the
ladder and resolves to its top rung, still under the ceiling below.

**The ceiling.** No dispatch, by any path — `auto`, a pool, or a pin — resolves
to a model above the orchestrator's own tier. Ordering is by family, held in
`${CLAUDE_PLUGIN_ROOT}/references/model-tiers.json` rather than in this text, for
the reason this section already gives about ids in prose; a newer model of a
weaker family does not outrank an older model of a stronger one. A pick above the
ceiling clamps to the highest entry at or below it; a pin has no lower entry to
fall to, so a pin above the ceiling clamps to the orchestrator's own id, dispatched
as an explicit override. Where nothing qualifies — an
id or an orchestrator the table cannot rank, or a pool whose every rung sits above
the orchestrator — resolution dispatches with no model override at all, the one
form that cannot exceed the orchestrator by construction. A clamp is logged, never
silent.

**Resolving a configured knob.** When a `*Model` knob resolves to a single id or a
comma-separated pool — never for `auto` or an unsubstituted `${user_config…}` placeholder, which
this section already treats as unset — run the pin, pool, ladder and ceiling arithmetic rather
than reasoning it out:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/model-pool.mjs" --value "<the knob's value>" \
      --orchestrator "<this session's own model id>" --signals <escalation signals fired>

It prints one line of JSON — `{"model": "<id>"|null, "outcome": "<audit string>"}`. Dispatch on
`model`, with `null` meaning dispatch with no model override at all, and record `outcome` verbatim
as the ledger event's `outcome=` field: it is already written in every form the Auditability
paragraph below enumerates. Pass `--signals Infinity` for `walkthroughModel` and
`branchReviewModel`, which have no complexity predicate and saturate the ladder. The `auto`
predicates above stay with the caller — the caller derives, this module only keeps the result
under the ceiling, which is why an unset knob needs no invocation at all.

Upstream's Model Selection tiers are background only; these predicates
decide. Auditability: every dispatch's ledger event records the decision and
its inputs — `outcome=model fast:<resolved id> (auto: files=3, deps=none,
steps=specified)` or `outcome=model session (auto: escalated on files=9)` for
derived choices, `outcome=model <id> (pinned)` for explicit config. A pooled
pick records `outcome=model <id> (pooled: rung <n>/<len>)`, gaining
`, clamped from <requested-id>` when the ceiling moved it; a clamped pin records
`outcome=model <id> (pinned, clamped from <requested-id>)`; a fall-through to no
override records `outcome=model session (ceiling: <id> unranked)` or
`outcome=model session (ceiling: no rung at or below <orchestrator-id>)`. An
escalation always names the signal that fired. Research dispatches that run
before any ledger exists log nothing; where a ledger exists, same shape.
