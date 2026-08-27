# Configuration

Set options with `/plugin configure devcycle@devcycle` (or
`claude plugin install devcycle@devcycle --config KEY=VALUE`). Everything has a working
default; configure nothing and the pipeline still runs. The first time `/devcycle:cycle`
runs with nothing configured, it asks one question — which `profile` to run — and never asks
again; answer *customize* instead and it asks the five behavioral options in one batch.

## `profile`

**`profile`** is the one knob most people need. It is a preset that sizes the whole run — which
engines the stages use, how deep the review goes, how much evidence reports carry — so you don't
tune options one at a time to say "cheaper" or "be thorough". `lean` is the cheapest pass,
`standard` is the default, and `thorough` is the most rigorous: it swaps in the upstream planning
and execution overlays, runs the branch review as a panel, and carries the longest evidence
tails. The dimension-by-dimension matrix — every stage dimension against all three profiles —
lives in [`references/config.md`](../../references/config.md) § The profile, which owns it.

Resolution order, in one rule: **an option you configured explicitly wins verbatim, always;
anything left at its default takes the profile's column value.** So the `Default` column in the
table below is really the `standard` column of the profile matrix `references/config.md` owns —
switch to `thorough` and the branch review becomes `panel` on its own, unless you pinned
`reviewDepth: single` yourself, in which case your value stands and the profile never moves it. A
`profile` that is unset or set to anything outside the three reads as `standard`.

What the profile never touches: the state file, handoff blocks, evidence classes, the
coordinator's green gate re-run, the `gitPolicy` clamps, branch discipline, the
one-reviewer floor on the short paths, and the rule that nothing is assumed instead of
interviewed for. A `lean` run may skip a stage; it never fakes one, and never reports a
gate as passed that did not run.

### Upgrading from a version before `profile`

If you configured devcycle before the profile existed, your options may quietly outrank it.
The old first-run walkthrough wrote all four behavioral options explicitly — including when
you answered "use defaults, don't ask again" — and an explicit option wins verbatim and
forever. Set `profile: thorough` on top of that and the branch review stays `single`, with
nothing to tell you why.

Two of the four can shadow a profile, because only they have a row in the profile matrix
`references/config.md` owns: `reviewDepth` and `onDeviceGate`. (`gitPolicy` and
`crossModelReview` are outside the profile, so an explicit value there shadows nothing and
needs no change.) Hand a shadowing option back to the profile by setting it to `auto`:

```
claude plugin install devcycle@devcycle --config reviewDepth=auto --config onDeviceGate=auto
```

`auto` is a value, not a deletion — it means "let the profile govern this", the same way it
already does for the four model options — so the option stays visible in
`/plugin configure` and you can pin it again later.

You don't have to spot this yourself: the first `/devcycle:cycle` after upgrading recognizes
the combination (a profile you have never set, next to options you have) and asks once,
before it starts any work — adopt a profile and let it govern, keep your current options as
they are, or customize. It records the answer, so it asks once and not every cycle, and it
never rewrites an option without asking. One wrinkle if you decline: adopting a profile
writes one, which settles the question everywhere, but *keep* and *customize* write no
profile, so the only record is the `.devcycle/state.md` of the repo you were in — expect the
question once more the first time you run a cycle in a different repo.

## All options

| Option | What it controls | Values | Default |
| --- | --- | --- | --- |
| `profile` | Cost against rigor, across every stage at once | `lean` / `standard` / `thorough` | `standard` |
| `gitPolicy` | What the finish stage may do with git | `local-commits-only` / `push-allowed` / `open-pr` | `local-commits-only` |
| `docTrackingPolicy` | What devcycle attempts to commit (the repo's `.gitignore` still decides what lands) | `standard` / `all-local` / `all-tracked` | `standard` |
| `reviewDepth` | How the branch review runs | `single` / `panel` / `auto` | `single` |
| `crossModelReview` | Adds a second-model lens to the panel | `true` / `false` | `false` |
| `onDeviceGate` | Whether a human must finish the on-device checklist | `human-required` / `auto-ok` / `auto` | `human-required` |
| `implementerModel` | Model for implementer subagents | `auto` / model id / comma-separated pool | `auto` (derived per task; set a model id to pin) |
| `taskReviewerModel` | Model for per-task reviewers | `auto` / model id / comma-separated pool | `auto` (derived per task; set a model id to pin) |
| `branchReviewModel` | Model for the whole-branch review | `auto` / model id / comma-separated pool | `auto` (inherits your session's model; set a model id to pin) |
| `walkthroughModel` | Model for the on-device walkthrough session | `auto` / model id / comma-separated pool | `auto` (a fast model; set a model id to pin) |
| `learnStalenessSessions` | Unmined sessions since the last `/devcycle:learn` before the finish stage nudges you to run it again | integer | `5` |
| `learnStalenessDays` | Days since the last `/devcycle:learn` before the finish stage nudges you to run it again | integer | `14` |

## Other options

The remaining eleven knobs above are secondary to `profile` — most runs never touch them.

**`gitPolicy`** is the pipeline's blast radius: `local-commits-only` means it only ever
commits on a local branch and hands it to you (never pushes); `push-allowed` lets it push
the branch (never merge); `open-pr` lets it push and open a pull request (never merge that
either). Merging is always yours.

Configuring `push-allowed` or `open-pr` doesn't guarantee a push happens: the finish
stage also checks two things outside this config before it pushes anything — whether
your Claude Code permission settings deny `git push`, and whether the cycle ran on the
repo's default branch (direct pushes there are never allowed) — and falls back to
`local-commits-only` behavior for that run if either is true, stating why in the finish
stage's output. `local-commits-only` is unaffected either way; it never pushes.

**`reviewDepth`** picks the branch-review engine — `single` at `lean` and `standard`,
`panel` at `thorough`, unless you set it yourself (or set it to `auto`, which hands it back
to the profile). `single` runs the review's two to five criteria lenses as inline read-only
reviewers, then re-verifies each finding against the code — a complete review in its own
right, not a degraded panel. Claude Code's built-in `code-review` skill is
user-invocation-only, so an agent cannot launch it; if you have run it on the branch
yourself, its findings are folded in and the engine line says `single + user-run
code-review`. `panel` runs `review-panel.js` instead: two to five read-only reviewers,
each with a lens built from the criteria the review is measuring against (spec compliance
when a spec governs the branch, then groupings drawn from `quality-criteria.md` and the
repo's own conventions), whose findings are adversarially re-verified against the code and
merged into one report — slower and more expensive, harder to fool. With
`crossModelReview: true` the panel adds one more lens run by a non-Claude model via the
`codex` CLI, if installed — a hedge against blind spots one model family might share.

**`onDeviceGate`** governs the last verification. The checklist is hybrid by design:
items a browser can structurally verify are auto-checked through claude-in-chrome — Claude
Code driving your own authenticated Chrome (install the plugin and grant the extension the
page's site permissions; without it, nothing is auto-checked and every item is yours);
the rest need a human. `human-required` (what `standard` and `thorough` take) blocks the
pipeline until you've walked every human item; `auto-ok` — `lean`'s value — lets it finish
once the auto-checkable items pass, explicitly
listing what remains unverified — it skips the human, it never fakes the checkmarks. As with
`reviewDepth`, `auto` hands the choice back to the profile.

The four **model options** trade cost against capability per role. They default to
`auto`: for implementers and task reviewers the coordinator derives the model per task
from what the plan makes observable (task size, dependency count, diff size) and records
each derivation in the ledger — the session's own model where judgment matters, a fast
one where the task is narrow and fully specified; the branch review inherits the
session's model and the walkthrough takes a fast one. Research and exploration dispatches
always take the fast tier, whatever the stage: their output is a map rather than a
judgment, and the roles that must judge — review, diagnosis, design — are the ones that
keep the session's model. Deriving by tier rather than by
model ids written into the plugin means new model generations are picked up without a
plugin update. Set an explicit model id to pin a role; an explicit id is binding and
never second-guessed.
