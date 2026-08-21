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

First-run and upgrade configuration lives in `references/first-run-config.md`, loaded only by
`/devcycle:cycle` — no other stage loads it.

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
