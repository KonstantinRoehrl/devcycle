# Configuration — knobs, profile, model tiers

The single owner of how devcycle resolves configuration. A skill, command, or agent
that needs any of this names this file and does not restate it.

## Knob resolution

Knob values arrive via `${user_config.KEY}` placeholders, each read by the stage
skill that consumes it (gitPolicy by `devcycle:finishing-the-cycle`, models and
review depth and the on-device gate by their stages). The resolution convention,
everywhere: a value that still reads as a literal `${user_config...}` placeholder
is unset, and a value outside its allowed set is invalid — both fall back to the
knob's documented default. When a knob's placeholder is literal but the state
file's `configured:` line records a value for it, that recorded value governs
this run — same-session substitution cannot refresh, so `--config` writes only
reach future sessions.

## The profile

`profile` ∈ `lean | standard | thorough`, default `standard`.

| | `lean` | `standard` | `thorough` |
| --- | --- | --- | --- |
| brainstorm / planning / execution engine | devcycle-native compact | devcycle-native compact | upstream overlays |
| branch review engine | `single` | `single` | `panel` |
| on-device gate | `auto-ok` | `human-required` | `human-required` |
| evidence tail in reports | 10 lines | 20 lines | 50 lines |
| branch-review round cap | 2 | 3 | 5 |
| audit depth | named criteria, ranked findings | full criteria sweep | full sweep + adversarial verification |

Resolution order, binding:

1. A knob explicitly configured — neither a literal `${user_config...}` placeholder nor
   `auto` — wins verbatim.
2. Otherwise the profile's column value applies.
3. `profile` itself: a literal placeholder or a value outside the three means unset → use
   `standard`; the state file's `configured:` line governs the current run when the
   placeholder is literal but a value was recorded there.

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
