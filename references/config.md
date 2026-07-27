# Configuration — knobs, profile, model tiers

The single owner of how devcycle resolves configuration. A skill, command, or agent
that needs any of this names this file and does not restate it.

## Knob resolution

Knob values arrive via `${user_config.KEY}` placeholders, each read by the stage
skill that consumes it (gitPolicy by `devcycle:finishing-the-cycle`, models and
review depth and the on-device gate by their stages).

**Resolution order — binding, and stated only here.** For every knob, in order:

1. **An explicitly configured value wins, verbatim**: one that is neither a
   literal `${user_config...}` placeholder nor `auto`, and that lies inside the
   knob's allowed set. It beats the profile and any documented default, for as
   long as it stays configured.
2. **Everything else falls back** — a literal placeholder and `auto` are unset, a
   value outside the knob's allowed set is invalid, and both take the same route.
   Where they land depends on whether the profile matrix (below) covers the knob:
   - Profile-covered — the branch review engine (`reviewDepth`), the on-device
     gate (`onDeviceGate`), the evidence tail, the branch-review round cap, the
     audit depth, and the planning/execution engine choice: the profile's column
     value.
   - Not profile-covered — `gitPolicy`, `crossModelReview`, and the `*Model`
     knobs (whose unset value is `auto`, derived per the model-tier rules
     below): that knob's own documented default.
3. **`profile` itself** takes the same two steps: a literal placeholder or a value
   outside `lean | standard | thorough` is unset, and falls back to `standard`.
4. **The state file's `configured:` line supplies the configured value** for steps
   1–3 whenever a knob's placeholder still renders literally but that line records
   one for it — same-session substitution cannot refresh, so `--config` writes only
   reach future sessions.

## The profile

`profile` ∈ `lean | standard | thorough`, default `standard`.

| | `lean` | `standard` | `thorough` |
| --- | --- | --- | --- |
| planning / execution engine | devcycle-native compact | devcycle-native compact | upstream overlays |
| branch review engine | `single` | `single` | `panel` |
| on-device gate | `auto-ok` | `human-required` | `human-required` |
| evidence tail in reports | 10 lines | 20 lines | 50 lines |
| branch-review round cap | 2 | 3 | 5 |
| audit depth | named criteria, ranked findings | full criteria sweep | full sweep + adversarial verification |

Which column applies, and when a knob overrides it, is the resolution order above —
this table supplies the values, not the rule for choosing them.

**Never profile-conditional:** the state file, handoff blocks, evidence classes, the
coordinator's green gate, the `gitPolicy` clamps, branch discipline, the one-`task-reviewer`
floor on short paths, and the never-assume interview rule. A `lean` run may skip a stage; it
never fakes one and never reports a gate as passed that did not run.

## Model tiers

Model names are configuration, not prose. Each stage's `*Model` knob
(`implementerModel`, `taskReviewerModel`, `walkthroughModel`, `branchReviewModel`)
resolves the same way:

- still a literal `${user_config...}` placeholder (unset) OR the value
  `auto` → derive the model per the predicates below;
- any other value → binding: use it verbatim for every dispatch, never
  override or downshift it.

Derivation picks between two tiers — defined by capability, never by a
model id written here, because ids in skill prose rot as models change:

- **session tier** — dispatch with NO model override, so the subagent
  inherits this coordinator session's own model: the strongest model the
  user has already sanctioned, tracking model generations without this
  skill naming any.
- **fast tier** — the newest fast/small Claude model available to this
  session (the current Sonnet-class generation). If no such id can be
  resolved with confidence, fall back to the session tier — a stronger
  model is never the wrong direction.

Derivation predicates (dispatch-time-observable inputs only):

- **implementer**: fast tier iff the task's `**Files:**` block lists ≤2
  files AND `**Dependencies:** none` AND every step names its file and
  expected behavior; else session tier.
- **task-reviewer**: fast tier iff the task diff is ≤400 changed lines
  and ≤5 files; else session tier.

Upstream's Model Selection tiers are background only; these predicates
decide. Auditability: every dispatch's ledger event records the decision
and its inputs — e.g. `outcome=model fast:<resolved id> (auto: files=1,
deps=none, steps=specified)` or `outcome=model session (auto: files=4)`
for derived choices, or `outcome=model <id> (pinned)` for explicit
config.
