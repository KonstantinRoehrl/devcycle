# Configuration — knobs and profile

The single owner of how devcycle resolves configuration. A playbook, command, or agent
that needs any of this names this file and does not restate it.

## Knob resolution

Knob values reach stages through the channel below, each read by the stage
playbook that consumes it (gitPolicy by `playbooks/finishing-the-cycle.md`,
docTrackingPolicy by every stage that writes an artifact — § Doc tracking below owns which —
models and review depth and the on-device gate by their stages).

**Resolution order — binding, and stated only here.** For every knob, in order:

1. **An explicitly configured value wins, verbatim**: one that is neither a
   literal `${user_config...}` placeholder nor `auto`, and that lies inside the
   knob's allowed set. It beats the profile and any documented default, for as
   long as it stays configured. For a `*Model` knob the allowed set includes an
   ordered, comma-separated pool of ids as well as a single id —
   `references/model-routing.md` owns what a pool means.
2. **Everything else falls back** — a literal placeholder and `auto` are unset, a
   value outside the knob's allowed set is invalid, and both take the same route.
   `auto` is sanctioned on every knob, not only the `*Model` ones: it is how a user
   says *let the profile govern this* without deleting the key. Where a stage playbook
   enumerates a knob's allowed values (e.g. `single` | `panel`), that names what the
   knob resolves *to* — `auto` is settled here, before that enumeration applies, and
   is never the invalid case. A knob with a row in the profile matrix below falls
   back to that row's column value; every other knob — `gitPolicy`,
   `crossModelReview`, and the `*Model` knobs (whose unset value is `auto`, derived
   per `references/model-routing.md`) — falls back to its own documented default.
3. **`profile` itself** takes the same two steps: a literal placeholder or a value
   outside `lean | standard | thorough` is unset, and falls back to `standard`.

`scripts/resolve-knobs.mjs` is the executable form of this order; nothing else resolves a knob.

## Knob channel

Only command text is templated — `${user_config.KEY}` substitutes in a command the harness
loads, never in a file a stage opens with Read — so knobs reach stages through one channel:

- **Commands resolve.** Every entry command except `/devcycle:doctor`, which consumes no knob,
  runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-knobs.mjs"` with all fourteen rendered
  placeholders as its first configuration step. That invocation is the only place a
  `${user_config.<key>}` may appear; `scripts/validate.mjs` fails one anywhere else. It prints
  `knobs: <key>=<value> …` in roster order and `explicit: <the keys that won at step 1>`. A
  non-zero exit — a missing or unknown flag, or a configured value whose single quote broke the
  invocation's quoting — is reported and stops the run; the cure for the last is correcting that
  value in `/plugin configure`. Nothing resolves a knob by hand in its place. A stderr warning
  names a rejected out-of-set value and the fallback used: surface it once and proceed.
- **Stages read.** A stage reads its knobs from the `knobs:` line its session's entry command
  printed — in-cycle and standalone alike, including a playbook both share. Inside a cycle the
  state file's `- knobs:` line is the persisted copy: a stage reads it when the printed line is
  no longer in context, and in place of the printed line whenever `/devcycle:continue` kept this
  cycle's values over changed global ones. A stage that finds neither stops and asks for its entry
  command to be re-run (`/devcycle:continue` inside a cycle); it never falls back to defaults on
  its own. Profile-row values — round cap, evidence tail, engine, audit, learn and maintenance
  depth — are looked up in § The profile under the `knobs:` line's `profile`. The one value read
  elsewhere is `subagentBudget`: the hooks module (`hooks/devcycle-mod.mjs`) takes it from the
  `options` Claude Code hands its `register`, never from the `knobs:` line, which still prints it
  for the state file.
- **Drift notice.** Values are global, as `/plugin configure` stores them — there is no per-repo
  value. Where the state file's `configured:` line records a KEY=VALUE list, `/devcycle:cycle`
  and `/devcycle:continue` rerun their final resolver invocation with
  `--compare '<that configured: line>'` appended, and for each key it prints show the repo's
  recorded value, the global value now in effect, and the
  `claude plugin install devcycle@devcycle --config KEY=VALUE` that restores it — noting that it
  applies to every repo. Informational: nothing is applied, and nothing is asked. Then rewrite
  `configured:` to its date alone, keeping any `· profile-asked` marker: the list is retired, so
  the notice is shown once, never again.

## The knob roster

Every knob devcycle ships, the surface that owns how it resolves — a playbook, or a section of
this file — and what an unset value falls back to.
This set is hand-kept in five places — this table, `docs/configuration/README.md`'s option
table, `.claude-plugin/plugin.json`'s `userConfig`, `docs/design/README.md` §7's schema, and
`scripts/resolve-knobs.mjs`'s `ROSTER` — so `tests/unit/golden-path.test.mjs` asserts the five
carry the same keys; without it the copies drift one release at a time.

| Knob | Owner | Falls back to |
| --- | --- | --- |
| `profile` | § The profile, below | `standard` |
| `gitPolicy` | `playbooks/finishing-the-cycle.md` | `local-commits-only` |
| `docTrackingPolicy` | § Doc tracking, below | `standard` |
| `reviewDepth` | `playbooks/reviewing-the-branch.md` | the profile's branch-review row |
| `crossModelReview` | `playbooks/reviewing-the-branch.md` | `false` |
| `onDeviceGate` | `playbooks/verifying-on-device.md` | the profile's on-device row |
| `implementerModel` | `playbooks/executing-waves.md` | `auto` — `references/model-routing.md` derives it per task |
| `taskReviewerModel` | `playbooks/executing-waves.md` | `auto` — `references/model-routing.md` derives it per task |
| `branchReviewModel` | `playbooks/reviewing-the-branch.md` | `auto` — the session's own model |
| `walkthroughModel` | `playbooks/verifying-on-device.md` | `auto` — a fast model |
| `learnStalenessSessions` | § Learn staleness | `5` |
| `learnStalenessDays` | § Learn staleness | `14` |
| `learnSessionCap` | § Learn staleness | `100` |
| `subagentBudget` | `hooks/devcycle-mod.mjs` | `warn` |

An unset knob renders as a literal `${user_config...}` placeholder, empty, or `auto`; the
resolution order above owns what "unset" then resolves to, and this column only names the endpoint.

## The state file's `configured:` line

The state file's `configured:` line records what the first-run offer wrote and is never a source
of knob values; `references/resume.md` owns its forms.

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
| maintenance depth | existing-criteria lenses only | + abstraction (degraded evidence if no history) | + history (bounded traversal) |

Which column applies, and when a knob overrides it, is the resolution order above —
this table supplies the values, not the rule for choosing them.

The learn depth column controls how deep a run mines, staged densest signal
first: **journal → memory → archives/findings/ledgers → user-correction turns → raw transcript text**.
Gating is by profile, never by token budget or a signal heuristic — a budget gate would make
coverage nondeterministic and destroy the marginal-vs-first-run comparison the measurement gate
depends on.

The reinforcement severity percentile also keys on profile — a leaner profile sets a higher "severe"
bar and reinforces less readily, a thorough one a lower bar — but its value is not a column here:
`references/reinforcement-policy.md` owns `severityPercentileByProfile`, and the matrix above keeps no
copy of it.

The maintenance depth row governs `/devcycle:maintain`'s longitudinal lenses: **lean** runs the
existing criteria only; **standard** adds the Abstraction criterion
(`references/abstraction-and-strengths.md`), which degrades to
consumer/implementation/invariant evidence and states the gap when no history exists;
**thorough** also dispatches the history inspector within its bounded traversal window.
Resolves through the same knob order as `audit depth`. **Known gap (§M7):** a maintenance pass
deliberately emits no `workload` run-record — it produces zero diff by design — so it is visibly
excluded from doctor's `## At a glance` and `EXCESS-COST` views; its cost stays visible in the
workload-independent `## Cost by stage` / `## Cost by version` tables.

**Never profile-conditional:** the state file, handoff blocks, evidence classes, the
coordinator's green gate, the `gitPolicy` clamps, branch discipline, the one-`task-reviewer`
floor on short paths, and the never-assume interview rule. A `lean` run may skip a stage; it
never fakes one and never reports a gate as passed that did not run.

First-run configuration lives in `references/first-run-config.md`, which `/devcycle:cycle` loads
only when its first-run test passes — no other stage loads it.

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
| routing advisories — `docs/devcycle/routing-advisories.md` | local | commit | commit |
| promotion records — `docs/devcycle/promotions/` | local | commit | commit |
| maintenance findings — `docs/devcycle/maintenance-findings/` | local | commit | commit |
| audit report — `docs/audits/` | local | local | local |
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

A site that commits an artifact resolves the policy, checks this table permits tracking, drops
any path `git check-ignore` vetoes, names the side effect, asks the user, then commits with an
explicit pathspec. `playbooks/learning-from-sessions.md`'s step 3 is the
reference implementation of that order.

## Learn staleness

`learnStalenessSessions` (default `5`) and `learnStalenessDays` (default `14`) are two
non-profile integer knobs, each accepting `0` or more — **`0` nudges after every cycle**.
They sit outside the profile matrix — no profile column moves them — and gate the single
staleness nudge `playbooks/finishing-the-cycle.md` surfaces at cycle end.

That playbook runs `scripts/dream.mjs --staleness`, which reads the distilling checkpoint's
`last-run:` (`.devcycle/distilling-state.md`, owned by
`playbooks/learning-from-sessions.md`) and reports whether enough
unmined sessions or elapsed days have accrued to warrant another `/devcycle:learn` pass.
**Whichever threshold crosses first triggers the nudge** — `learnStalenessSessions` unmined
sessions since `last-run:`, or `learnStalenessDays` days since it — and a corpus that was
never mined (`last-run:` unset or `never`) is always stale. The nudge is advisory: it never
forces a mining run and advances no checkpoint.

`learnSessionCap` reaches the engine the same way: `playbooks/learning-from-sessions.md`
and `playbooks/finishing-the-cycle.md` pass `--cap <n>` to
`scripts/dream.mjs --plan` and `--staleness` respectively. **Its minimum is `1`**, unlike the two
thresholds above: a cap of `0` is refused rather than mining nothing and printing a manifest
indistinguishable from a corpus with nothing left to mine.

## Model tiers

`references/model-routing.md` owns how a `*Model` knob's value becomes a dispatch model — read it
where a stage dispatches.
