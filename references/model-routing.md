# Model routing — the *Model knobs and dispatch tiers

The single owner of how a `*Model` knob's value becomes a dispatch model. A playbook, command, or
agent that needs any of this names this file and does not restate it.

A `*Model` knob's value arrives on the `knobs:` line
(`references/config.md` § Knob channel): `auto`, a single id, or a
comma-separated pool the resolver has already normalized.

## Model tiers

Model names are configuration, not prose. Each stage's `*Model` knob
(`implementerModel`, `taskReviewerModel`, `walkthroughModel`, `branchReviewModel`)
resolves the same way:

- the value `auto` → derive the model per the predicates below;
- a value with no comma → a pin: use it verbatim for every dispatch, subject
  only to the ceiling below;
- a value with one or more commas → a **pool**: an ordered list of ids,
  ascending by capability, position declaring order. Entries are trimmed and
  empties dropped, so a pool that parses to one id is a pin. A pool cannot be
  an array in the manifest — `userConfig` types are `string | number | boolean |
  directory | file` — so the comma is the ordering, not a workaround.

Derivation picks between two tiers — defined by capability, never by a
model id written here, because ids in playbook prose rot as models change:

- **session tier** — dispatch with NO model override, so the subagent
  inherits this coordinator session's own model: the strongest model the
  user has already sanctioned, tracking model generations without this
  playbook naming any. In a driven run the session tier is the cycle's **ceiling**, the drive
  row's `model=` (`references/drive.md`). The coordinator there runs below it, so a session-tier
  dispatch names the ceiling's id explicitly rather than omitting the override. This only works when the agent definition itself carries
  no `model:` frontmatter key — an omitted dispatch-time override resolves to
  the agent definition's own frontmatter model when it has one, and only
  falls through to the caller's model when the definition names none. The
  session tier therefore requires every agent definition it dispatches to be
  free of a `model:` key. **Caveat:** that inheritance is what "no override"
  assumes, and it does NOT hold for a subagent when a default subagent model
  is configured — a dispatch with no override then resolves to that default,
  not to the orchestrator's own model, and **in an interactive run outside planning nothing mitigates that today**:
  with one configured, every dispatch that resolves to this tier runs at that
  default instead, while its `dispatch` row records the session's own id. In a driven run the
  caveat does not apply: the driver removes `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and `CLAUDE_CODE_SUBAGENT_EFFORT` from the session's
  environment, and every session-tier dispatch names the ceiling. The escape hatch is implemented, unwired, and **narrower than
  this caveat** — `resolveModel` in `scripts/model-pool.mjs` takes a
  `sessionTierUnreachable` parameter (its `--session-tier-unreachable` CLI flag)
  under which an escalation that would land on the session tier names the
  orchestrator's own id as an explicit override instead, and an escalation there is
  only a **pool** whose ladder climbed on a **counted** signal. Each half of that
  excludes a shape that lands on this tier identically with the flag and without it.
  An `auto` or unset knob — every knob's shipped default — is no pool, so the
  implementer default below stays uncovered and closing that case needs a different
  fix. A pool on `walkthroughModel` or `branchReviewModel` saturates the ladder to its top rung
  with no signal having fired: the saturating `Infinity` `scripts/model-policy.mjs`
  passes for them is a sentinel, not a counted signal, so nothing climbs.
  That leaves `implementerModel` and `taskReviewerModel` the only knobs that can reach
  the hatch at all. What it does cover is a pool on one of those two that climbed and
  then fell through to this tier for any reason: the climb is the whole test, so an
  unrankable rung fires it even when a dispatchable lower rung sits in the pool, and
  the orchestrator's own id must itself be rankable, since that id is what the
  override names. No caller passes it: not `scripts/model-policy.mjs`, not any other file
  in the surface.
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
  per run) at the lower per-token rates `scripts/pricing.mjs` holds, and a wrong cheap guess
  costs at most one review round. `scripts/task-dispatch.mjs` derives all four signals but the
  unnamed-step one, which the coordinator passes as `--steps-unspecified`.
- **task-reviewer**: fast tier iff the task diff is ≤400 changed lines
  and ≤5 files; else session tier. `scripts/task-dispatch.mjs` applies it through `scripts/model-policy.mjs`, which holds both limits.
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
to a model above the orchestrator's own tier. In a driven run the orchestrator's tier is the
ceiling's, the model the cycle was opted in on, not the coordinator's. Ordering is by family, held in
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

**Resolving a configured knob.** `scripts/task-dispatch.mjs` resolves `implementerModel` and
`taskReviewerModel` per dispatch. The branch review and the on-device walkthrough are not dispatched
through it, so a caller resolves `branchReviewModel` and `walkthroughModel` with § Roles'
`model-policy.mjs --role branch-review|walkthrough --knob "<the knob's value>"`. It runs the pin,
pool, ladder and ceiling arithmetic of `scripts/model-pool.mjs`, giving a pool the saturating
`Infinity` signal, and prints `model`, `dispatch`, `effort` and `outcome`. Dispatch on `model`, with
`null` meaning dispatch with no model override at all, and record `outcome` verbatim as the ledger
event's `outcome=` field: it is already written in every form the Auditability paragraph below
enumerates. Nothing runs `model-pool.mjs` by hand.

Upstream's Model Selection tiers are background only; these predicates
decide. Auditability: every dispatch's ledger event records the decision and
its inputs — `outcome=model fast:<resolved id> (auto: files=3, deps=none,
steps=specified)` or `outcome=model session (auto: escalated on files=9)` for
derived choices, `outcome=model session (auto)` for an unset knob passed to the module
anyway, `outcome=model fast:<resolved id> (auto: lines=40, files=2)` for a task reviewer, `outcome=model <id> (pinned)` for explicit config.
In a driven run a session-tier outcome names the ceiling, as in
`outcome=model session:<ceiling id> (auto: escalated on files=9)`. An escalation whose session
and fast tiers share a family records
`outcome=model fast:<id> (auto: session tier is the fast tier; signals files=9)`, never an
escalation. The coordinator's start records `model <id> (coordinator: fast tier under <ceiling id>)`
or `model <id> (coordinator: ceiling)`. A pooled
pick records `outcome=model <id> (pooled: rung <n>/<len>)`, gaining
`, clamped from <requested-id>` when the ceiling moved it; a clamped pin records
`outcome=model <id> (pinned, clamped from <requested-id>)`; a fall-through to no
override records `outcome=model session (ceiling: <id> unranked)` or
`outcome=model session (ceiling: no rung at or below <orchestrator-id>)`. Two further forms are
implemented but have no producer yet. With `--session-tier-unreachable` set, an escalation that
lands on the session tier records, naming the orchestrator's own id,
`outcome=model <id> (escalated, session unreachable: explicit override)`, or
`outcome=model session (escalated, unreachable and unranked)` when that id cannot be ranked. Both
forms need an escalation: a pin that falls through instead records
`outcome=model session (ceiling: <id> unranked)`. What counts as an escalation is defined by the session-tier
caveat above, which also records that no caller passes that flag — so neither form can appear in a
ledger this version writes. An escalation always names the signal that fired. Research dispatches
that run before any ledger exists log nothing; where a ledger exists, same shape.

## Roles

`references/model-policy.json` owns which model each devcycle role runs on and
`scripts/model-policy.mjs` resolves it. A caller runs the resolver, or the script that does
(`scripts/task-dispatch.mjs` for implementers and task reviewers, `scripts/drive-execution.mjs` for
the coordinator), never this table.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/model-policy.mjs" --role <role> --ceiling <this session's own model id> [--driven] [--knob <value>] [--facts '<json>']

It prints `model` (the id), `dispatch` (the alias the Agent tool takes, which accepts only `sonnet`,
`opus`, `haiku` or `fable`), `effort` and `outcome`.

| Role | Layer | Default | Override |
| --- | --- | --- | --- |
| `starter` | interactive session that starts the driver | the user's own model; hands off, no relayed turns at driveWatch=end | none |
| `driver` | Node script | none: model-free | none |
| `coordinator` | driven claude -p, one per wave | fast tier, capped at the ceiling | none |
| `implementer` | subagent | fast tier; session tier on the existing signals | `implementerModel` |
| `task-reviewer` | subagent | fast tier within the line and file limits, else session tier | `taskReviewerModel` |
| `branch-review` | subagent | session tier | `branchReviewModel` |
| `walkthrough` | subagent | session tier | `walkthroughModel` |
| `planning-session` | session or a later driven session | session tier | none |
| `research` | planning subagent | fast tier | none |
| `spike` | planning subagent | fast tier | none |
| `checker` | planning subagent | fast tier | none |
| `drafter` | planning subagent | fast tier; session tier on a code-pinned task, a new abstraction, too many files or cross-package scope | none |
| `repair` | planning subagent | the tier of the drafter it repairs | none |

Planning names the model of every dispatch it makes (`--role research|spike|drafter|repair|checker`,
with the drafter's facts `codePinned`, `newAbstraction`, `maxFiles` and `crossPackage`): a fast-tier
dispatch names the fast-tier id, and a session-tier one names the orchestrator's own id rather than
omitting the override, so a configured default subagent model cannot take it over.
`references/delegated-planning.md` owns the role, `repair` included.

A planning dispatch's audit record is its `agent-cost` run-record row: the `model` and `explicitModel`
fields the dispatch sensor writes. Doctor's Planning breakdown reads them and flags a
`spike`, `research` or `checker` dispatch that ran outside the fast tier (`tier-fit:`) and lists each
drafter's turns and model (`drafters:`), since a cheaper model can take more turns.
