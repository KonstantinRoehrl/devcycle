# Model routing — the *Model knobs and dispatch tiers

The single owner of how a `*Model` knob's value becomes a dispatch model. A playbook, command, or
agent that needs any of this names this file and does not restate it.

A `*Model` knob's value arrives on the `knobs:` line
(`${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob channel): `auto`, a single id, or a
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
  playbook naming any. This only works when the agent definition itself carries
  no `model:` frontmatter key — an omitted dispatch-time override resolves to
  the agent definition's own frontmatter model when it has one, and only
  falls through to the caller's model when the definition names none. The
  session tier therefore requires every agent definition it dispatches to be
  free of a `model:` key. **Caveat:** that inheritance is what "no override"
  assumes, and it does NOT hold for a subagent when a default subagent model
  is configured — a dispatch with no override then resolves to that default,
  not to the orchestrator's own model, and **nothing mitigates that today**:
  with one configured, every dispatch that resolves to this tier runs at that
  default instead. The escape hatch is implemented, unwired, and **narrower than
  this caveat** — `resolveModel` in `scripts/model-pool.mjs` takes a
  `sessionTierUnreachable` parameter (its `--session-tier-unreachable` CLI flag)
  under which an escalation that would land on the session tier names the
  orchestrator's own id as an explicit override instead, and an escalation there is
  only a **pool** whose ladder climbed on a **counted** signal. Each half of that
  excludes a shape that lands on this tier identically with the flag and without it.
  An `auto` or unset knob — every knob's shipped default — is no pool, so the
  implementer default below stays uncovered and closing that case needs a different
  fix. A pool on `walkthroughModel` or `branchReviewModel` saturates the ladder with
  no signal having fired, because the saturating `Infinity` the invocation below has
  them pass is a sentinel rather than a counted signal — its top rung, but no climb.
  That leaves `implementerModel` and `taskReviewerModel` the only knobs that can reach
  the hatch at all. What it does cover is a pool on one of those two that climbed and
  then fell through to this tier for any reason: the climb is the whole test, so an
  unrankable rung fires it even when a dispatchable lower rung sits in the pool, and
  the orchestrator's own id must itself be rankable, since that id is what the
  override names. No caller passes it: not the invocation below, not any other file
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
comma-separated pool — never for `auto`, which this section already treats as unset — run the
pin, pool, ladder and ceiling arithmetic rather than reasoning it out:

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
`outcome=model session (ceiling: no rung at or below <orchestrator-id>)`. Two further forms are
implemented but have no producer yet. With `--session-tier-unreachable` set, an escalation that
lands on the session tier records, naming the orchestrator's own id,
`outcome=model <id> (escalated, session unreachable: explicit override)`, or
`outcome=model session (escalated, unreachable and unranked)` when that id cannot be ranked. Both
forms need an escalation: a pin that falls through instead records
`outcome=model session (ceiling: <id> unranked)`. What counts as an escalation is the session-tier
caveat above, which also records that no caller passes that flag — so neither form can appear in a
ledger this version writes. An escalation always names the signal that fired. Research dispatches
that run before any ledger exists log nothing; where a ledger exists, same shape.
