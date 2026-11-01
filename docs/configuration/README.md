# Configuration

Set options with `/plugin configure devcycle@devcycle` (or
`claude plugin install devcycle@devcycle --config KEY=VALUE`). In `/plugin configure`, `profile`,
`gitPolicy`, `docTrackingPolicy`, `reviewDepth` and `onDeviceGate` are pick-lists with their
default preselected. Everything has a working default; configure nothing and the pipeline still
runs. The first time `/devcycle:cycle` runs with nothing configured, it asks one question — which
`profile` to run — and never asks again; answer *customize* instead and it asks the five
behavioral options in one batch.

The knob history — every `userConfig` addition, rename, and deprecation and the version each
landed in — is [`config-changelog.md`](config-changelog.md), read by `doctor`'s config-drift mode
and stamped by the release step.

## `profile`

**`profile`** is the one knob most people need. It is a preset that sizes the whole run — which
engines the stages use, how deep the review goes, how much evidence reports carry — so you don't
tune options one at a time to say "cheaper" or "be thorough". `lean` is the cheapest pass,
`standard` is the default, and `thorough` is the most rigorous: it swaps in the upstream planning
and execution overlays, runs the branch review as a panel, and carries the longest evidence
tails. The dimension-by-dimension matrix — every stage dimension against all three profiles —
lives in [`references/config.md`](../../references/config.md) § The profile, which owns it.

Resolution order, in one rule: **an option you configured explicitly wins verbatim, always;
an option left at its default never pins anything the profile governs.** The profile sets the
stage dimensions in the matrix `references/config.md` owns, and `reviewDepth`'s default, `auto`,
sizes the branch review within the profile's bounds — switch to `thorough` and the branch review
becomes `panel` on its own, unless you pinned `reviewDepth: single` yourself, in which case your
value stands and the profile never moves it. A `profile` that is unset or set to anything outside
the three reads as `standard`.

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

Only `reviewDepth` can shadow a profile, because it is the one option with a row in the profile
matrix `references/config.md` owns. (`gitPolicy`, `crossModelReview` and `onDeviceGate` are
outside the profile, so an explicit value there shadows nothing; an old explicit
`onDeviceGate: human-required` still makes every item yours, and `auto` is what puts the agent
first.) Hand `reviewDepth` back to the profile's row by setting it to `profile`:

```
claude plugin install devcycle@devcycle --config reviewDepth=profile
```

`profile` takes the profile's branch-review row as it is; `auto`, the default, sizes the review
from the branch diff within the profile's bounds instead. Either is a value, not a deletion, so
the option stays visible in `/plugin configure` and you can pin it again later.

To spot a shadowing option, read the `explicit:` line the entry command prints next to
`knobs:` — it names every option that won because you configured it.

## How a knob reaches a stage

Only a command's own text has `${user_config.KEY}` substituted, so every entry command except
`/devcycle:doctor` runs `scripts/resolve-knobs.mjs` with every rendered placeholder as its first
configuration step (`/devcycle:continue` only once its ownership check and `resume-check` have
passed) and prints one `knobs:` line; each stage reads its values from that line. Inside a
cycle the state file keeps a `- knobs:` copy, and `/devcycle:continue` asks before applying a
value you changed mid-cycle; a "keep" holds until you change the value again. The exceptions are
`subagentBudget`, whose global value the hooks module reads; `executionMode`, whose fresh value
`/devcycle:continue` reads at execution start and whenever it decides whether a start is confirmed; and `driveWatch`
and `drivePlugins`, whose fresh values it reads each time it starts an unattended run: it asks
about none of them, and a "keep" cannot hold them. Values are
global, as `/plugin configure` stores them: a repo's old `configured:` values are shown once as a
drift notice, never applied, then dropped from the state file.
[`references/config.md`](../../references/config.md) § Knob channel owns the details.

If a release renames an option, your value carries over: the resolver reads it from the old name in `settings.json`, and a `knob-renamed:` line gives the command that stores it under the new name. This reads the user settings file only, so a project- or local-scoped install falls back to the default until you set the new name.

Developing devcycle itself: a checkout loaded with `claude --plugin-dir` sees none of these values
and silently runs every knob at its fallback. [`docs/platform-notes.md`](../platform-notes.md)
§ (h) records why, and how to try a branch with your real settings.

## All options

| Option | What it controls | Values | Default |
| --- | --- | --- | --- |
| `profile` | Cost against rigor, across every stage at once | `lean` / `standard` / `thorough` | `standard` |
| `gitPolicy` | What the finish stage may do with git | `local-commits-only` / `push-allowed` / `open-pr` | `local-commits-only` |
| `docTrackingPolicy` | What devcycle attempts to commit (the repo's `.gitignore` still decides what lands) | `standard` / `all-local` / `all-tracked` | `standard` |
| `reviewDepth` | How the branch review runs | `auto` / `profile` / `single` / `panel` | `auto` (sized from the branch diff within the profile's bounds; `profile` takes the profile's row) |
| `crossModelReview` | Adds a second-model lens to the panel | `true` / `false` | `false` |
| `onDeviceGate` | Who settles the on-device checklist | `auto` / `human-required` / `auto-ok` | `auto` (the agent checks first; you judge the rest) |
| `implementerModel` | Model for implementer subagents | `auto` / model id / comma-separated pool | `auto` (derived per task; set a model id to pin) |
| `taskReviewerModel` | Model for per-task reviewers | `auto` / model id / comma-separated pool | `auto` (derived per task; set a model id to pin) |
| `branchReviewModel` | Model for the whole-branch review | `auto` / model id / comma-separated pool | `auto` (inherits your session's model; set a model id to pin) |
| `walkthroughModel` | Model for the on-device walkthrough session | `auto` / model id / comma-separated pool | `auto` (a fast model; set a model id to pin) |
| `learnStalenessSessions` | Unmined sessions since the last `/devcycle:learn` before the finish stage nudges you to run it again | integer `0` or more (`0` nudges every cycle) | `5` |
| `learnStalenessDays` | Days since the last `/devcycle:learn` before the finish stage nudges you to run it again | integer `0` or more (`0` nudges every cycle) | `14` |
| `learnSessionCap` | How many sessions one `/devcycle:learn` run may mine | integer `1` or more (`0` is refused, not a no-op run) | `100` |
| `subagentBudget` | What devcycle's hooks module does with a subagent past its context budget | `off` / `warn` / `enforce` | `warn` (from 15% of its window, a note on its next tool result and every fifth after; `enforce` also refuses reads at 20%) |
| `handoffNotification` | Whether devcycle notifies you when a handoff is safe to clear and when an unattended run stops for you | `off` / `terminal` / `push` / `both` | `off` (`terminal` goes through Claude Code's own notification channel and, like `both`'s terminal half, does nothing on a Claude Code build without `$.ui.notify`; `push` sends a push notification where the session can) |
| `executionMode` | How `/devcycle:continue` runs the waves at execution start; once the cycle records its choice, the live value still decides whether a start is confirmed | `ask` / `manual` / `unattended` | `ask` (asks Start unattended or Walk the waves manually; `manual` walks them in the session; `unattended` starts the driver with no question and resumes it without a confirm; a run that stopped for you still asks) |
| `driveWatch` | How much of an unattended run the session that started it relays to you; each relayed line costs a model turn | `end` / `wave` / `all` | `end` (only the run's end, while the band above the prompt shows progress; `wave` adds session starts, finished waves, waits and stops; `all` adds every task outcome) |
| `drivePlugins` | Which plugins an unattended run's sessions load besides devcycle and superpowers; they start with no MCP servers | `none` / `all` / comma-separated plugin names | `none` (`all` gives them every plugin and MCP server your own sessions load) |

## Other options

The remaining seventeen knobs above are secondary to `profile` — most runs never touch them.

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

**`reviewDepth`** picks the branch-review engine. `auto`, the default, sizes it from the
branch diff: always `single` at `lean`, always `panel` at `thorough`, and at `standard` `panel`
once the diff passes the size thresholds `scripts/review-depth.mjs` names (lockfiles and
generated files left out), `single` otherwise. A review with no diff to measure — a repo audit,
`/devcycle:maintain`, a path review — takes the profile's row, and so does `profile`, set
explicitly; `single` and `panel` pin the engine. [`playbooks/reviewing-code.md`](../../playbooks/reviewing-code.md)
§ 3 owns the rule, and the review report's `Depth:` line says which engine was picked and why.
`single` runs the review's two to five criteria lenses as inline read-only
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

**`onDeviceGate`** governs the last verification. The stage launches the app itself, and every
checklist item is tagged by what can settle it: `structural` (DOM, CSS values, exact text), which
a browser can confirm; `agent-observable` (a request fired, a clean console, a route, a state
that persists), which a browser can watch but not judge alone; and `needs-eyes` (how it looks and
feels), which only you can judge. The browser is claude-in-chrome — Claude Code driving your own
authenticated Chrome (install the plugin and grant the extension the page's site permissions;
without it, nothing is auto-checked and every item is yours). `auto`, the default, runs the agent
first: structural items that hold are ticked `(auto)`, the agent-observable items and any failure
it saw come to you as one batch of proposed verdicts to confirm, and the `needs-eyes` items are
asked one by one. `human-required` asks you every item, one by one. `auto-ok` lets the agent pass
close the stage unless it saw a failure, explicitly listing what remains unverified — it skips
the human, it never fakes the checkmarks. Telling the on-device session to walk the checklist
itself applies `auto-ok` for the rest of that cycle, whatever this option says. Every `FAILED` item
then needs your decision — fix it on the branch now, waive it, or accept it as a known carry-over —
before finish closes the cycle. No profile sets this option, so a `lean` run that
should close on the agent pass sets `auto-ok` itself. [`references/checklist.md`](../../references/checklist.md)
owns the tiers and verdicts, [`playbooks/verifying-on-device.md`](../../playbooks/verifying-on-device.md)
§ The gate what each value does. A branch with nothing that renders skips the stage in branch
review, so this option never comes into play there.

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

One caveat bounds "the session's own model": devcycle gets it by dispatching with no
model override, and a dispatch with no override resolves to Claude Code's *default
subagent model* whenever you have configured one — not to your session's model. If you
have set one, expect every role that would take the session tier to run at that default
instead: the resolver can name the coordinator's own model id explicitly rather than
inherit, but nothing in the pipeline asks it to yet, so the caveat stands. That escape
hatch is also narrower than the caveat: it reaches only a role you set to a pool, never one
left at `auto`, and among the four roles only the implementer and the task reviewer even
then — the branch review and the walkthrough have no complexity predicate, so a pool on
either jumps straight to its top rung without a signal firing, and it is the firing the hatch
keys on. So a role on the default stays uncovered even once something asks for it.
The rule, those bounds and the unwired escape hatch are owned by
[`references/model-routing.md`](../../references/model-routing.md) § Model tiers.
