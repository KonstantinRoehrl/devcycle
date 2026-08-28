# devcycle Plugin — Design

**Status:** Live design, architecture, and convention reference for the `devcycle` plugin — the
current source of truth for how the plugin is structured and why. The frozen 2026-07-22
pre-implementation plan (the migration sequence and author-context sections, kept only for the
record) lives in [`docs/design/historical-2026-07-plan.md`](historical-2026-07-plan.md).

---

## 1. Goal

Restructure the current agent setup (a ~4k-word global `~/.claude/CLAUDE.md` + repo-local skills + personal
memory) into:

1. **`devcycle`** — a public, auto-updating Claude Code plugin implementing the general pipeline:
   rough idea or detailed ticket → interviewed scope → brainstormed spec → wave-based file-disjoint plan →
   subagent execution with TDD and model routing → per-task review → whole-branch multi-lens review →
   on-device verification (structural checks via claude-in-chrome) → PR-ready branch. Repo-agnostic; adapts to any repository.
2. **company in-repo tier** — the existing `agents/` + `Docs/` + `.github/instructions/` structure, formalized
   (NOT packaged as a plugin). Versions with branches, updates via git pull, teammates get it by cloning.
3. **Personal tier** — a slimmed `~/.claude/CLAUDE.md` (~½ page) + plugin `userConfig` values + the memory
   system as learning inbox.

Decisions locked (2026-07-22): public GitHub repo hosting; in-repo form for the company-repo tier; thin overlay on
superpowers (declared dependency, no forking); memory-as-inbox learning (promotion sessions, no /retro
machinery); plugin name **`devcycle`**.

---

## 2. Core Principle & Verified Platform Mechanics

*(The three-tier architecture table that opened this section moved to the trailing
appendix — author context, not part of the plugin.)*

**Core principle: personal policy becomes plugin configuration.** The public plugin ships zero personal policy;
anything that is a trust preference (e.g. "never push") is a typed `userConfig` knob with a conservative default.
Structure over trust: config is checked every run; memory and prose are recalled probabilistically.

Verified mechanics this design relies on (checked against official docs 2026-07-22):

- Plugins ship skills, commands, agents, hooks, MCP/LSP configs, `bin/`, settings; manifest supports
  `dependencies` (semver, auto-install, loads-disabled on unsatisfied) and `userConfig`.
- Cross-marketplace dependency on superpowers requires the target marketplace in
  `allowCrossMarketplaceDependenciesOn` in the plugin's marketplace.json. Dependency
  satisfaction is keyed on `name@marketplace`, so the pin targets `claude-plugins-official`
  (configured by default everywhere) — see `docs/decisions/README.md`, 2026-07-23.
- Auto-update is opt-in per marketplace for non-Anthropic marketplaces; version pinning via `plugin.json`
  `version` (bump per release; omitting it makes every commit an update).
- Team distribution: a repo's `.claude/settings.json` can declare `extraKnownMarketplaces` + `enabledPlugins`;
  teammates are prompted after workspace trust (v2.1.195+).
- Plugin skills are namespaced (`devcycle:skill-name`) — no collisions with repo or personal
  skills. devcycle ships none: since 2026-08-06 its orchestration prose lives in `playbooks/`,
  loaded by path, so the only `devcycle:` ids that resolve are its commands and agents (§3).

---

## 3. Plugin Blueprint

**Five layers, one directory each** (restructured 2026-08-06), so a file's layer is readable
from its path and enforceable per-directory rather than by convention:

| layer | directory | holds | rules |
| --- | --- | --- | --- |
| L0 | `commands/` | the nine entry points | the only surface listed to a user; names are verbs; per-file line budget owned by tests/fixtures/surface-budget.json |
| L1 | `playbooks/` | orchestration prose | loaded by path, in no roster, no frontmatter; names are gerunds; per-file line budget owned by tests/fixtures/surface-budget.json |
| L2 | `agents/` | typed workers | separately dispatched contexts; names are role nouns; no `model:` in frontmatter |
| L3 | `references/` | shared concepts | exactly one owner, at least one consumer; loaded on demand (§15.1) |
| L4 | `scripts/`, `workflows/` | deterministic engines | anything deterministic lives here; may grow; outside the line budget |

The L1/L2 boundary is a property of how a file is consumed, not a judgment about how much
dispatching a stage does: L1 is loaded into the coordinator's own context, L2 runs as a
separately dispatched context.

```
devcycle/                (public GitHub repo)
├── .claude-plugin/
│   ├── plugin.json               # name, version (bump per release), dependency on superpowers
│   │                             # userConfig (see §7)
│   └── marketplace.json          # source "./", allowCrossMarketplaceDependenciesOn: ["claude-plugins-official"]
├── commands/                     # L0 — the whole user-facing surface; intents mapped in docs/routing.md
│   ├── cycle.md                  # entry: input-maturity triage → stage walk; model-invocable (wrappers can call it)
│   ├── continue.md               # resume from .devcycle/state.md after /clear (see §5)
│   ├── review.md                 # a branch, this repo, or a file set, scoped by argument; starts no cycle (see §15.3)
│   ├── verify.md                 # standalone on-device walkthrough; starts no cycle
│   ├── learn.md                  # sessions + memory → landed doc edits; --preview lands nothing
│   ├── doctor.md                 # standalone token/context/routing profile and config drift; starts no cycle
│   ├── maintain.md               # read-only longitudinal repo-health assessment; starts no cycle
│   ├── onboard.md                # bootstrap tier-2 in a repo; starts no cycle (see §8)
│   └── reconcile.md              # triage/fix/reply to a PR's review comments; re-enters the branch's cycle when one exists
├── playbooks/                    # L1 — loaded only as ${CLAUDE_PLUGIN_ROOT}/playbooks/<name>.md
│   ├── scoping-the-request.md    # rough idea → bounded scope; batched AskUserQuestion; nothing assumed;
│   │                             # hands off to superpowers:brainstorming
│   ├── planning-waves.md         # file-disjoint tasks, explicit dependencies, dispatch map, pinned interfaces
│   ├── executing-waves.md        # ledger, brief/diff file handoffs, green gate, model routing, handoff blocks
│   ├── reviewing-code.md         # the review engine both whole-scope reviews share, and the audit stage (§15.3, §16)
│   ├── reviewing-the-branch.md   # whole-branch gate: spec-compliance layer + the bounded rounds loop
│   ├── verifying-on-device.md    # claude-in-chrome structural checks + the human checklist walkthrough
│   ├── finishing-the-cycle.md    # finish stage: gitPolicy resolution + push-signal clamp
│   ├── taking-the-fast-path.md   # confirmed-trivial mini-cycle: in-session implementation, one reviewer pass
│   ├── sweeping-mechanical-changes.md  # bulk uniform edits via the sweep path + **Execution:** sweep tasks
│   ├── learning-from-sessions.md # observe → propose → confirm → land, one loop (see §8)
│   ├── profiling-sessions.md     # token/context/routing/startup-cost analysis, ranked by impact
│   ├── maintaining-the-repo.md   # longitudinal-health engine behind /devcycle:maintain; wraps reviewing-code
│   └── onboarding-a-repo.md      # bootstrap tier-2 in any repo (see §8)
├── agents/                       # L2
│   ├── implementer.md            # brief-driven implementer template
│   ├── task-reviewer.md          # per-task reviewer; read-only apart from its own findings file
│   ├── red-team-reviewer.md      # adversarial charter; read-only allowlist; spliced into
│   │                             # review-panel's per-finding verification pass
│   ├── history-inspector.md      # read-only git-history lens for /devcycle:maintain; bounded traversal
│   └── on-device-driver.md       # drives claude-in-chrome for the on-device stage; the only
│                                 # origin the browser guard below permits
├── hooks/                        # L4 — the one hook that ships (docs/decisions/README.md, 2026-08-20)
│   ├── hooks.json                # registers the guard on PreToolUse over mcp__claude-in-chrome__.*
│   └── block-main-thread-browser.mjs  # denies browser calls from any origin but on-device-driver
├── references/                   # L3 — one owner per convention; enumerated in §15.1
├── scripts/                      # L4 — validate.mjs, doctor.mjs, dream.mjs, the checkers, bump-version.mjs
├── workflows/                    # L4
│   ├── lib/agent-cli.js          # shared subprocess layer: tagged logger, run(), claudeStructured()
│   ├── review-panel.js           # multi-lens review → adversarial verify → dedup → reconcile
│   └── mechanical-sweep.js       # pipeline over file list, worktree isolation, verify stage
│                                 # (invoked by the sweep stage and **Execution:** sweep tasks)
└── README.md                     # pipeline narrative; CHANGELOG alongside
```

Pipeline stages: intake triage (`/cycle`; a confirmed-trivial request short-circuits to fast-path → finish) →
scoping-the-request (rough input only) *or* the audit stage over reviewing-code (audit-shaped input, in place
of scoping — see §15.3) → superpowers:brainstorming → spec → planning-waves → executing-waves
(per-wave: dispatch → implement → review → commit) → reviewing-the-branch → verifying-on-device →
finish per `gitPolicy`.

---

## 4. Blueprint Amendments (source-mined, 2026-07-22)

1. **Deterministic green gate.** The implementer's red→green claim is verified by re-running the task's test
   command (coordinator re-run, or Stop hook on the implementer subagent) before "done" is accepted. Evidence,
   not self-report.
2. **Reviewers structurally read-only.** `task-reviewer` and `red-team-reviewer` declare a `tools:` allowlist;
   `Edit` is structurally absent from both, not merely forbidden by prose. `red-team-reviewer` stays fully
   Write-less (Read/Grep/Glob/Bash). `task-reviewer` was given one scoped `Write` (2026-08-28, issue #107) for
   its own gitignored `.devcycle/findings/<task-id>-round-<n>.md` file only — it remains read-only with
   respect to the working tree and source, and never gets `Edit` or a write path into source.
3. **Skill preloading in briefs.** Implementer dispatches inject TDD + relevant repo-convention skill content at
   dispatch time instead of instructing the subagent to invoke skills itself.
4. **Entry points cannot auto-fire — except `/cycle`, intentionally.** Side-effectful commands and
   `/devcycle:continue` carry `disable-model-invocation: true` so they cannot be silently substituted.
   `/cycle` is a deliberate exception (reversed 2026-07-24): it is model-invocable so a wrapper skill —
   e.g. one that loads/saves tickets around a run — can call the pipeline programmatically.
   The rule itself now lives in `docs/routing.md`, which declares each command's
   `consequence` class and the guard that class requires; `scripts/validate.mjs` fails the build
   when a command's frontmatter disagrees with it. This amendment records why the exception was
   granted, not where it is enforced.
5. **Review panel as saved workflow** (see §6) — resumable, concurrency-capped, deterministic lens assignment.
6. **Description-budget release check.** Skill/command descriptions share a finite char budget (check via
   `/context`); verify before each release that devcycle + superpowers + a repo tier fit. (Exact budget
   numbers: verify during implementation.)
7. **Context lifecycle as a first-class protocol** (see §5): handoff blocks, state file, `/devcycle:continue`.

---

## 5. Context Lifecycle

**Principle: files are the state; the conversation is a cache.** Every stage ends by writing its artifact; the
conversation that produced it is then expendable. Each boundary picks the cheapest sufficient action.

Mechanics:

- **Handoff block** — every stage playbook's required final output: artifact paths, pinned carry-overs
  (interfaces, open decisions), and a ready-made compaction hint for the user (playbooks cannot invoke
  /compact themselves).
- **State file** — `.devcycle/state.md`: current stage, artifact paths, branch. `/devcycle:continue`
  re-derives pipeline position from state + ledger + plan, making **clear-and-resume** viable (cheaper and
  cleaner than compaction).

The action column takes exactly three values — `Continue`, `Clear + /devcycle:continue`, `Fresh session`.
**`references/handoff.md` owns the table** of per-boundary defaults, the one test that softens a
default to `Continue`, and the await gate that stops the pipeline at every other boundary; read it
there. This section kept its own copy of that table until 2026-08-06, and the copy had already
drifted — a second answer to the same question is worse than one place to look.

What this costs the user is stops: the pipeline halts at nearly every boundary, so a cycle spans several short
sessions instead of one long one. Compacting is gone as an action entirely — compaction leaves the
expensive part of a context behind, and the measured case was decisive: the month's most expensive session sat at
39% *after* `/compact` and was still the single largest line item. Clearing is the only action that actually
returns the context, and files already carry everything the next stage needs.

The execution→review boundary is **bias control**, not just cost hygiene: a reviewer that watched the code being
written inherits the implementer's assumptions. Context loss there is the point.

---

## 6. Workflows: Deterministic Orchestration

A workflow is a saved JavaScript orchestration script (`workflows/*.js`) run by the Workflow tool: subagents via
`agent()` composed with `pipeline()`/`parallel()`, schema-validated outputs, resumable
(`resumeFromRunId`), budget- and concurrency-capped. Key property: **code holds the control flow**, so
orchestration discipline stops depending on model judgment in a filling context. A plugin command whose
instructions invoke a workflow is a sanctioned opt-in path.

Suitability per stage:

| Stage | Fit | Decision |
| --- | --- | --- |
| Scoping/brainstorm | None — interactive | Never |
| Planning | Marginal | Optional plan-critique panel, not v1 |
| Wave execution | Partial — mutates git state; user checkpoints are valuable | Ledger-based default; hands-off workflow wave mode is a v2 experiment |
| Whole-branch review | **Strong** — read-only fan-out, verify, dedup, reconcile | **`review-panel.js` ships v1** |
| Mechanical sweeps | **Strong** — pipeline over file list, worktree isolation | **`mechanical-sweep.js` ships v1** (routed from triage's bulk-mechanical verdict and task-level **Execution:** sweep) |
| Repo research | Good | Optional `repo-research.js`, post-v1 |
| On-device verification | None (human phase) | Never; the claude-in-chrome pre-pass needs no workflow |

`review-panel.js` shape: 2–3 lens reviewers (spec compliance / correctness+security / simplification) →
adversarial verify per finding (the `red-team-reviewer` charter is spliced into each verifier prompt) →
dedup → reconciler ranks confirmed findings; optional cross-model (Codex) lens
gated by `userConfig.crossModelReview`.

---

## 7. userConfig Schema

```json
{
  "profile": "lean | standard | thorough",
  "gitPolicy": "local-commits-only | push-allowed | open-pr",
  "docTrackingPolicy": "standard | all-local | all-tracked",
  "reviewDepth": "single | panel | auto",
  "crossModelReview": false,
  "onDeviceGate": "human-required | auto-ok | auto",
  "implementerModel": "auto | <model id>",
  "taskReviewerModel": "auto | <model id>",
  "branchReviewModel": "auto | <model id>",
  "walkthroughModel": "auto | <model id>",
  "learnStalenessSessions": 5,
  "learnStalenessDays": 14
}
```

- `profile` (added 2026-07-26) is the preset behind the rest: every other option keeps its
  own shipped default, and any option left at that default takes the profile's column value
  instead (matrix and resolution order in `references/config.md`). It is what the
  first-run walkthrough asks about — one question, not the four-knob batch, which stays
  available behind a *customize* answer.
- The model options are four flat string keys — the plugin manifest's `userConfig` schema
  supports no object-valued options, so the originally planned `modelLineup` object was not
  expressible (verified in `docs/platform-notes.md` §(a)).
- Model options default to `auto`: the coordinator derives the model per task from
  plan-observable attributes and logs the derivation in the ledger. An explicitly configured
  model id is binding — used verbatim, never overridden.
- `reviewDepth` and `onDeviceGate` also accept `auto` (added 2026-07-26): it hands the knob
  back to the profile's column, the same route an unset knob takes — the escape hatch for a
  user upgrading from an older config whose explicit value would otherwise shadow the profile
  forever (resolution order in `references/config.md`).
- Shipped defaults: `gitPolicy: local-commits-only` (most conservative), `reviewDepth: single`,
  `crossModelReview: false`, `onDeviceGate: human-required`, all four model options `auto`.
- The finishing stage branches on `gitPolicy`: local-commits-only ends with the branch handed back (the author's
  mode); `open-pr` automates push + PR for users who want it.
- Before acting on `push-allowed`/`open-pr`, the finishing stage resolves an **effective**
  policy against two external signals — a Claude Code permission `deny` rule on `git
  push`, and the cycle's branch being the repo's default branch — clamping to
  `local-commits-only` for that run if either fires. `local-commits-only` needs no check;
  it is already the floor.
- Model names are config values, not skill prose — they rot otherwise.
- `learnStalenessSessions` (5) and `learnStalenessDays` (14) are non-profile integer knobs
  gating the finish stage's staleness nudge: the finish stage runs `dream.mjs --staleness`
  against the distilling checkpoint's `last-run:` and, when either threshold is crossed,
  surfaces one advisory line suggesting another `/devcycle:learn` pass (resolution and
  ownership in `references/config.md` § Learn staleness).
- Once encoded, corresponding personal memories (e.g. never-local-merge-to-dev) are deleted.

---

## 10. Non-Goals (explicitly rejected)

- **Second plugin for the company repo** — the repo tier is better served in-repo (zero drift, no second repo).
- **`/retro` machinery** — memory-as-inbox + promotion sessions chosen instead.
- **Forking superpowers skills** — thin overlay with declared dependency.
- **RPI "3 specialist planning docs"** — source is promotional, unverified; wave planning covers the substance.
- **Auto-generated lint rules via GitHub App; Opus permission-scanning hook** — unverified community claims.
- **`/goal` evaluator per task** — heavy; the deterministic green gate covers it.
- **Monitors/LSP/themes/bin**, auto-PR bots.

---

## 13. Naming

- Plugin: **`devcycle`** (user decision 2026-07-22; over full-cycle/dev-cycle/idea-to-pr).
- **Commands are verbs, playbooks are gerunds, agents are role nouns.** `doctor` is the single
  recorded exception, justified by `brew doctor` / `flutter doctor` / `npm doctor` — a noun
  every developer already reads as "diagnose this".
- Commands (the whole user-facing surface, seven from 2026-08-06, eight since 2026-08-22,
  nine since 2026-08-26):
  `/devcycle:cycle`, `/devcycle:continue`, `/devcycle:review`, `/devcycle:verify`,
  `/devcycle:learn`, `/devcycle:doctor`, `/devcycle:maintain` (read-only longitudinal
  repo-health assessment; starts no cycle), `/devcycle:onboard`, `/devcycle:reconcile`
  (triage a PR's review comments into fixes and consented replies; re-enters the branch's
  cycle when one exists). `docs/routing.md` maps each
  to the intent it serves and what it may do before its first confirmation.
- Playbooks: verb-first gerunds, listed in §3. They are addressed by path, never as
  `devcycle:<name>`, so a playbook name is never a user-typed string.
- Agents: `devcycle:implementer`, `devcycle:task-reviewer`,
  `devcycle:red-team-reviewer`, `devcycle:on-device-driver`, `devcycle:history-inspector`. The plugin id is not decoration:
  the harness passes `<plugin>:<name>` as a subagent's `agent_type`, which is the spelling the
  browser guard's allowlist must carry (`docs/platform-notes.md` § (e)).
- Hooks: one, `block-main-thread-browser`, named for what it denies rather than what it guards —
  the only surface component that is not loaded by a command.

## 15. Compaction — the reference layer, profiles, and the audit stage (added 2026-07-26)

### 15.1 The reference layer: one owner per convention

`references/` holds seventeen plain markdown files, each the sole owner of one cross-cutting
convention; each file and what it owns is enumerated, one line apiece, in the
[references index](../../references/README.md).

A consumer names one — "Read `${CLAUDE_PLUGIN_ROOT}/references/<name>.md` and follow it" —
and does not restate its content.

**Why.** These conventions are needed by most stages, so before this each playbook carried its
own copy of them. Copies drift: a fix to branch discipline had to be found and reapplied in
every file that mentioned it, and any one that was missed became a second, contradictory
answer to the same question. The copies also cost context on every load, in a plugin whose
whole premise is that context is the scarce resource.

The invariant that makes it work is stronger than "add a pointer": **a file that consumes a
reference names it and deletes its own prose on the subject.** A pointer added next to a
retained restatement leaves two owners, which is worse than one bad owner — the reader now
has to decide which is authoritative. What stays in a playbook is only what is unique to that
stage. `scripts/duplication-check.mjs` is the mechanized form of this invariant.

These files are addressed only by path. They carry no frontmatter, are never invoked by
name as `devcycle:<something>`, and take no share of the description budget §4.6 tracks —
they cost nothing until a playbook in flight names one and reads it. Since 2026-08-06 the
playbook layer works the same way (§3), so `commands/` alone spends the description budget.

### 15.2 Native engines vs upstream overlays, keyed to `profile`

`profile` ∈ `lean | standard | thorough`, default `standard`. It is one preset over the
knobs that size a run. `references/config.md` is the single owner of the profile matrix and
its resolution order — see it there rather than a second copy here, per §15.1's own
one-owner invariant applied to this file.

**The engine split.** Two stages take it, and each owns its own switch rather than being
told from `/cycle`:

- `planning-waves` — at `lean`/`standard` it does **not** load `superpowers:writing-plans`;
  the plan location, scope check, right-sizing, step granularity, templates, and self-review
  are carried inline. At `thorough` it loads upstream and overlays it.
- `executing-waves` — same shape: at `lean`/`standard` the brief-slicing, file handoffs, and
  review/fix loop are self-contained; at `thorough` it loads
  `superpowers:subagent-driven-development` and overlays it, minus upstream's tail (its
  final-code-reviewer dispatch and finishing-a-development-branch step, which devcycle's own
  branch-review and finish stages replace).

Brainstorm and diagnosis are **not** part of the split: `superpowers:brainstorming` and
`superpowers:systematic-debugging` run upstream and unmodified at every profile. The
dependency on superpowers is therefore real at every profile, not just `thorough`.

§10's no-forking non-goal is about upstream's *files*, and in that sense it holds: nothing
under superpowers is edited, and the `thorough` path stays a genuine consumer of it. What the
native engines do is narrower and worth stating plainly — they inline the planning and
execution mechanics with devcycle's overrides already folded in, so the skill that runs is
the whole instruction rather than a delta on top of a general one. Some of that inlined text
tracks upstream's wording closely where devcycle had no quarrel with it (plan location, task
right-sizing); the goal was never to say those things differently, only to say them once, in
the place that runs. That carries a real cost: those passages are now a second copy that
upstream revisions will not reach on their own, so an upstream change has to be diffed in
deliberately instead of inherited.

**Why not always overlay.** The overlay pays for a general skill's full prose on every run
to then override most of it. Below `thorough` that trade is bad: the same behavior arrives
in less context. What keeps it honest is a single behavioral contract across both engines —
the same wave-formation invariants, ledger events, green gate, and review cycle — so a plan
and a run have the same shape whichever engine produced them. Only the *source* of the
mechanics differs.

**What the profile may never touch:** the list in `references/config.md` § The profile. Cost is
allowed to buy less depth, never a false claim.

### 15.3 The audit stage

Triage's maturity axis gained a third verdict: **audit-shaped** input ("audit X", "review
the repo for Y" — an assessment of existing code rather than a change to it) routes to the
**audit** stage, which runs *in place of* scoping. `playbooks/reviewing-code.md` establishes
what is wrong before anything is designed; the findings the user selects become brainstorm's
explored context, and the walk continues normally. This is the same ordering rule §3's
diagnosis stage follows for bugs — you cannot spec a fix for a problem nobody has
established. A cycle where the user selects nothing closes at the report.

Two properties carry the stage:

- **Criteria are interviewed for, never chosen.** A sweep against criteria the auditor
  picked measures the repo against the auditor's taste, not the user's priorities. The
  interview proposes a criteria set derived from a shallow orientation pass — a user handed
  a proposal corrects it in one turn, a user handed a blank menu has to invent one — and
  then hard-stops exactly as `scoping-the-request` stops: no research, no draft findings until
  the user has replied.
- **No `file:line`, no finding.** The evidence discipline `red-team-reviewer` applies to
  review claims applies to audit claims. A suspicion that cannot be pointed at in a file
  does not appear in the document at all, and a coverage statement names what was not read,
  so a partial audit cannot read as a complete one.

Only depth is profile-conditional (the matrix row in `references/config.md`); the interview
and the evidence rule are not.

`/devcycle:review` exposes the same playbook standalone — over a branch, this repository, or a
file set, per its argument — and is deliberately **not** a pipeline
stage: it neither creates nor requires `.devcycle/state.md`, leaves any in-flight cycle's
state file untouched, emits no handoff block, and ends at the findings document. Turning a
finding into work is a separate, explicit call — `/devcycle:cycle <request>` naming that
finding. The reason is the same as §4.4's: an entry point that chains onward takes the
selection decision away from the user.

## 16. Shared review criteria (added 2026-07-29)

The audit and the whole-branch review were two implementations of one idea, and each held
what the other lacked. The audit owned the criteria — stack-derived, precedence-ranked,
externally sourced — but verified findings in prose. The review owned the machinery — lens
fan-out, per-finding refutation, dedup, ranking — but measured against three charters
hardcoded in JavaScript that no repo convention informed. Severity was spoken four different
ways across five surfaces.

**Two references, split by axis.** `quality-criteria.md` owns *what you measure against*;
`findings.md` owns *how you report what you found*. The split is not cosmetic: the consumers
differ. `planning-waves` needs only the first, `task-reviewer` needs only the second, and the
two whole-scope reviews need both. One combined file would force every consumer to load both
halves — the cost §15.1 exists to avoid.

**One shared engine.** `playbooks/reviewing-code.md` owns what both whole-scope reviews
share: lens construction from the criteria, engine selection and its `panel→single`
degradation, the fresh-context rule, and verify → dedup → rank. `playbooks/reviewing-the-branch.md`
stays a separate file because its stops, outputs and lifecycle genuinely differ — it enumerates
a spec and runs a bounded rounds loop, where the audit interviews for criteria and stops for a
user selection. *(Amended 2026-08-06: the audit's own two steps — the criteria interview and the
findings document — moved into `reviewing-code.md` as sections marked "audit runs only", so the
audit is no longer a separate file. The branch review's separation is unchanged.)*

**Blocking is derived.** Severity is `critical` / `high` / `medium` / `low`, and blocking
means `critical` or `high` — not a separate field a reviewer can set independently. Before
this, `reviewing-the-branch` gated on "blocking findings" without defining the word; the gate
is now stricter and predictable. Deliberately: a vocabulary that can be bargained with makes
every verdict built on it unreadable.

**The knowledge reaches forward.** The criteria catalog was the best statement in the repo of
what good code looks like, and it was readable only by the audit — i.e. only after the code
was written. `planning-waves` now derives a `## Quality Constraints` section from it, filtered
to the confirmed scope, and `executing-waves` splices each task's own constraint lines into
that task's brief. An implementer is told up front what the audit would later flag it for,
and no brief carries the whole catalog.

**The panel generalized.** `review-panel.js` takes a `scope` that is either a ref or a file
list, an optional `specPath`, and caller-built lens charters. That is what lets the audit use
the same machinery over a file set that the branch review uses over a diff. Its read-only
guarantee, its exit-code taxonomy, and its "unverified findings are marked, never dropped"
contract are unchanged.

---

## 17. Description-sufficiency contract (added 2026-08-03, rescoped 2026-08-06)

Every **command's** frontmatter `description` must be sufficient **on its own** — without its
body — for a model to correctly decide invoke-or-not. This is distinct from the
length-*budget* check §4.6 already runs (`scripts/validate.mjs`'s 6000-char total ceiling
across `commands/`): that check asks whether the descriptions are short enough; this one asks
whether each is complete enough. The need is sharper now that a consuming `CLAUDE.md` carries
zero restated trigger-condition prose per the migration rule (§12) — the description is the
*only* signal a model sees before deciding whether to read the body at all.

The contract used to cover skills. It covers commands because, since 2026-08-06, commands are
the only files with frontmatter: playbooks are loaded by path and carry no description at all
(§3), so nothing but a command can be selected by description. `docs/routing.md` carries
the same information in prose a human reads, and `scripts/validate.mjs` fails the build when a
command is absent from it — which is the closest thing to a mechanized sufficiency check the
repo has.

The rest is a review-time convention, deliberately not a CI gate: judging whether a description
is complete enough needs a model, and no model credential is available to GitHub Actions. A new
or materially-changed command's description is written against the intents in `routing.md` and
checked by the reviewer of the change. The prose scenario harness that formerly held this as a
`description-sufficiency` test type was retired 2026-08-06 — see `CONTRIBUTING.md` and the
decision log.
