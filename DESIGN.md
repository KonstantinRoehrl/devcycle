# devcycle Plugin — Design

**Date:** 2026-07-22 **Status:** Approved design, pre-implementation **Scope:** Personal tooling restructure —
not part of any product ticket. Kept local (uncommitted) per the no-one-off-specs-in-git rule; this file
becomes the founding DESIGN.md of the `devcycle` plugin repo when that repo is created.

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
  (configured by default everywhere) — see `docs/DECISIONS.md`, 2026-07-23.
- Auto-update is opt-in per marketplace for non-Anthropic marketplaces; version pinning via `plugin.json`
  `version` (bump per release; omitting it makes every commit an update).
- Team distribution: a repo's `.claude/settings.json` can declare `extraKnownMarketplaces` + `enabledPlugins`;
  teammates are prompted after workspace trust (v2.1.195+).
- Plugin skills are namespaced (`devcycle:skill-name`) — no collisions with repo or personal skills.

---

## 3. Plugin Blueprint

```
devcycle/                (public GitHub repo)
├── .claude-plugin/
│   ├── plugin.json               # name, version (bump per release), dependency on superpowers
│   │                             # userConfig (see §7)
│   └── marketplace.json          # source "./", allowCrossMarketplaceDependenciesOn: ["claude-plugins-official"]
├── commands/
│   ├── cycle.md                  # entry: input-maturity triage → stage walk; model-invocable (wrappers can call it)
│   ├── continue.md               # resume from .devcycle/state.md after /clear (see §5)
│   ├── audit.md                  # standalone audit; starts no cycle (see §15.3)
│   ├── verify.md                 # standalone on-device walkthrough; starts no cycle
│   └── doctor.md                 # standalone token/context profile; starts no cycle
├── references/                   # the reference layer: one owner per convention (see §15.1)
│   ├── config.md                 # knob resolution, the profile matrix, model tiers
│   ├── evidence.md               # evidence classes, file-backed evidence, report/verdict shapes
│   ├── resume.md                 # re-entry rules for every stage
│   ├── handoff.md                # handoff block shape and the context-action table
│   ├── branch.md                 # branch discipline for every committing path
│   └── output.md                 # output discipline for every agent and skill
├── skills/
│   ├── scoping-interview/        # rough idea → bounded scope; batched AskUserQuestion; nothing assumed;
│   │                             # hands off to superpowers:brainstorming
│   ├── auditing-a-repo/          # interviewed criteria → ranked, file-referenced findings (see §15.3)
│   ├── doctor/                   # token/context/routing/startup-cost analyzer, ranked by dollar impact
│   ├── planning-waves/           # layers on superpowers:writing-plans — file-disjoint tasks, explicit
│   │                             # dependencies, dispatch map, pinned interfaces
│   ├── executing-waves/          # layers on superpowers:subagent-driven-development — ledger, brief/diff file
│   │                             # handoffs, TDD green gate, model routing, wave compaction, handoff blocks
│   ├── reviewing-the-branch/     # whole-branch gate via review-panel workflow + optional cross-model pass
│   ├── verifying-on-device/      # generalized from the existing on-device-verification skill
│   ├── finishing-the-cycle/      # finish stage: gitPolicy resolution + push-signal clamp (extracted
│   │                             # 2026-07-25 from the duplicated cycle/continue command prose)
│   ├── fast-path/                # confirmed-trivial mini-cycle: in-session implementation, one
│   │                             # reviewer pass, then the normal finish (added 2026-07-25)
│   ├── onboarding-a-repo/        # bootstrap tier-2 in any repo (see §8)
│   ├── distilling-learnings/     # memory→docs/skills promotion session, codified (see §8)
│   └── sweeping-mechanical-changes/  # bulk uniform edits via the sweep path + **Execution:** sweep tasks
├── agents/
│   ├── implementer.md            # brief-driven TDD implementer template
│   ├── task-reviewer.md          # per-task reviewer; read-only tools allowlist
│   └── red-team-reviewer.md     # adversarial charter; read-only allowlist; spliced into
│   │                             # review-panel's per-finding verification pass
├── workflows/
│   ├── review-panel.js           # multi-lens review → adversarial verify → dedup → reconcile
│   └── mechanical-sweep.js       # pipeline over file list, worktree isolation, verify stage
│                                 # (invoked by the sweep stage and **Execution:** sweep tasks)
└── README.md                     # pipeline narrative + demo transcript; CHANGELOG alongside
```

Pipeline stages: intake triage (`/cycle`; a confirmed-trivial request short-circuits to fast-path → finish) →
scoping-interview (rough input only) *or* auditing-a-repo (audit-shaped input, in place of scoping — see §15.3) →
superpowers:brainstorming → spec → planning-waves → executing-waves
(per-wave: dispatch → TDD → review → commit) → reviewing-the-branch → verifying-on-device → finish per `gitPolicy`.

---

## 4. Blueprint Amendments (source-mined, 2026-07-22)

1. **Deterministic green gate.** The implementer's red→green claim is verified by re-running the task's test
   command (coordinator re-run, or Stop hook on the implementer subagent) before "done" is accepted. Evidence,
   not self-report.
2. **Reviewers structurally read-only.** `task-reviewer` and `red-team-reviewer` declare a `tools:` allowlist
   (Read/Grep/Glob/Bash) — Edit/Write are structurally absent, not merely forbidden by prose.
3. **Skill preloading in briefs.** Implementer dispatches inject TDD + relevant repo-convention skill content at
   dispatch time instead of instructing the subagent to invoke skills itself.
4. **Entry points cannot auto-fire — except `/cycle`, intentionally.** Side-effectful skills and
   `/devcycle:continue` carry `disable-model-invocation: true` so they cannot be silently substituted.
   `/cycle` is a deliberate exception (reversed 2026-07-24): it is model-invocable so a wrapper skill —
   e.g. one that loads/saves tickets around a run — can call the pipeline programmatically.
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

- **Handoff block** — every stage skill's required final output: artifact paths, pinned carry-overs (interfaces,
  open decisions), and a ready-made compaction hint for the user (skills cannot invoke /compact themselves).
- **State file** — `.devcycle/state.md`: current stage, artifact paths, branch. `/devcycle:continue`
  re-derives pipeline position from state + ledger + plan, making **clear-and-resume** viable (cheaper and
  cleaner than compaction).

The action column takes exactly three values — `Continue`, `Clear + /devcycle:continue`, `Fresh session` — and
`references/handoff.md` owns the table each boundary defaults to:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Clear + `/devcycle:continue` | scope path, confirmed constraints, open `<tbd>`s | interview transcript, research output |
| scoping → diagnosis (bugs) | Clear + `/devcycle:continue` | scope path, reproduction steps | interview transcript |
| audit → brainstorm (findings selected) | Clear + `/devcycle:continue` | audit path, the selected findings | audit transcript, rejected findings |
| diagnosis → brainstorm (root cause established) | Clear + `/devcycle:continue` | diagnosis report path, reproduction steps, root cause | debugging transcripts, ruled-out hypotheses |
| brainstorm → planning (spec approved) | Clear + `/devcycle:continue` | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Clear + `/devcycle:continue` | ledger/plan paths, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear + `/devcycle:continue` | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |
| fast-path → finish | Clear + `/devcycle:continue` | branch, what changed | the implementation conversation |
| sweep → finish | Clear + `/devcycle:continue` | branch, sweep report path | per-file sweep output |
| finish → (end) | Continue | — | — |

Only one test softens a default. At `scoping → brainstorm`, `scoping → diagnosis`, `audit → brainstorm`,
`fast-path → finish`, and `sweep → finish` — and nowhere else — the action becomes `Continue` when the stage that
just ended stayed under the budget in `references/delegation.md`, dispatched no implementer, task-reviewer, or
sweep, and left all of the next stage's inputs on disk. Any doubt resolves to the table's default.

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
  "reviewDepth": "single | panel | auto",
  "crossModelReview": false,
  "onDeviceGate": "human-required | auto-ok | auto",
  "implementerModel": "auto | <model id>",
  "taskReviewerModel": "auto | <model id>",
  "branchReviewModel": "auto | <model id>",
  "walkthroughModel": "auto | <model id>"
}
```

- `profile` (added 2026-07-26) is the preset behind the rest: every other option keeps its
  own shipped default, and any option left at that default takes the profile's column value
  instead (matrix and resolution order in §15.2 and `references/config.md`). It is what the
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
- Once encoded, corresponding personal memories (e.g. never-local-merge-to-dev) are deleted.

---

## 8. Skill Roadmap — Global Plugin

| Skill | Purpose | Priority |
| --- | --- | --- |
| executing-waves | Ledger, briefs, TDD green gate, model routing, wave compaction, handoff blocks | v1 — first port |
| planning-waves | Wave/dispatch-map/pinned-interface plan contract | v1 |
| verifying-on-device | claude-in-chrome auto-verdicts + human checklist interview (near-pure move of existing skill) | v1 |
| reviewing-the-branch | Branch gate via review-panel workflow + agents | v1 |
| scoping-interview + /devcycle:cycle + /devcycle:continue + state file | Entry, triage, resume glue | v1 — last |
| onboarding-a-repo | Bootstrap tier-2 anywhere: detect real commands, scaffold CLAUDE.md/per-package rules, run allowlist scan, wire verification commands | v1.x — right after the pipeline works |
| distilling-learnings | Codified promotion session: memory/observation inbox → vetted docs/skill edits via writing-skills TDD | v1.x |
| sweeping-mechanical-changes | Bulk uniform migrations, pilot-first | shipped |
| auditing-a-repo | Interviewed criteria → ranked, file-referenced findings; standalone `/devcycle:audit` or the in-cycle audit stage | shipped |
| running-headless-ci | `-p --output-format stream-json` CI stage | Later — when a CI use case exists |
| Agent-teams review backend | Native shared-task-list adversarial review | Later — token-heavy; workflow panel covers it |

## 9. Repo-Tier Roadmap — Company Monorepo (tier 2)

*(Moved to the trailing appendix — author context, not part of the plugin.)*

## 10. Non-Goals (explicitly rejected)

- **Second plugin for the company repo** — the repo tier is better served in-repo (zero drift, no second repo).
- **Hooks in the public plugin** — they fire for every user on every matched tool call; skills + commands suffice.
- **`/retro` machinery** — memory-as-inbox + promotion sessions chosen instead.
- **Forking superpowers skills** — thin overlay with declared dependency.
- **RPI "3 specialist planning docs"** — source is promotional, unverified; wave planning covers the substance.
- **Auto-generated lint rules via GitHub App; Opus permission-scanning hook** — unverified community claims.
- **`/goal` evaluator per task** — heavy; the deterministic green gate covers it.
- **Monitors/LSP/themes/bin**, auto-PR bots.

---

## 11. Classification of Existing Config

*(Moved to the trailing appendix — author context, not part of the plugin.)*

## 12. Migration Sequence

Governing rule: **when a skill ships, the corresponding global-CLAUDE.md section is deleted in the same step** —
no phase is ever double-defined.

1. Create the public repo: manifest + marketplace + README skeleton; declare superpowers dependency; install via
   `claude plugin marketplace add`; enable that marketplace's auto-update toggle.
2. Port in order: executing-waves → planning-waves → verifying-on-device → reviewing-the-branch (+ agents +
   review-panel workflow) → scoping-interview + /cycle + state file.
3. Each port gets the writing-skills treatment: scenario-tested (STOP-discipline and output-shape tests, as in
   a prior skill overhaul) before it replaces the prose it supersedes; description-budget check per
   release; version bump per release.
4. Slim `~/.claude/CLAUDE.md` to tier 3; set userConfig values; delete superseded memories.
5. v1.x skills (onboarding-a-repo, distilling-learnings); repo-tier roadmap items
   in parallel via promotion sessions.
6. Later, one team decision: repo `.claude/settings.json` provisions superpowers + devcycle for
   teammates.

### Release automation (CI) — added 2026-07-22

Version handling on GitHub is enforced by CI, not discipline alone:

- **`bump-version.yml`** — on merge to `main`: derive the semver level from conventional-commit subjects since
  the last tag (`fix:`→patch, `feat:`→minor, `!`/`BREAKING CHANGE`→major; default patch), bump
  `plugin.json` `version`, append the commit subjects to `CHANGELOG.md`, commit with `[skip ci]`, and create
  the tag `devcycle--vX.Y.Z`. Requires `contents: write` for the workflow token.
- **`validate.yml`** — on PRs and `main`: JSON validity + required fields of `plugin.json`/`marketplace.json`,
  skill frontmatter presence (name/description), per-description length and total description-budget threshold
  (mechanized form of amendment §4.6), and balanced-markdown-fence checks on all SKILL.md files.
- Consequence: `main` is always installable, every merge produces exactly one released version, and the brief
  window between merge and bump-commit only ever shows the previous version string to installers.

## 13. Naming

- Plugin: **`devcycle`** (user decision 2026-07-22; over full-cycle/dev-cycle/idea-to-pr).
- Commands: `/devcycle:cycle`, `/devcycle:continue`, `/devcycle:audit`, `/devcycle:verify`,
  `/devcycle:doctor`.
- Skills: verb-first gerunds (`executing-waves`, `planning-waves`, `verifying-on-device`,
  `reviewing-the-branch`, `scoping-interview`, `auditing-a-repo`, `onboarding-a-repo`,
  `distilling-learnings`, `sweeping-mechanical-changes`).
- Agents: `devcycle:implementer`, `devcycle:task-reviewer`,
  `devcycle:red-team-reviewer`.

## 14. Open Questions (deferred to implementation)

- Exact Stop-hook wiring for the green gate on subagents (hook vs coordinator re-run — pick during
  executing-waves port; coordinator re-run is the fallback if subagent Stop hooks prove awkward).
- `.claude/agent-memory/` feature details (verify against docs before the repo-tier item).
- Description char budget exact numbers (verify via /context during release checks).
- Whether `verifying-on-device`'s claude-in-chrome pre-pass needs repo-specific target config in tier 2
  (likely not: the user drives their own authenticated Chrome, so there is no separate target/URL config to pin).

## 15. Compaction — the reference layer, profiles, and the audit stage (added 2026-07-26)

### 15.1 The reference layer: one owner per convention

`references/` holds ten plain markdown files, each the sole owner of one cross-cutting
convention:

| File | Owns |
| --- | --- |
| `config.md` | knob resolution, the profile matrix and its resolution order, the model tiers and their derivation predicates |
| `evidence.md` | the three evidence classes, the file-backed evidence contract, the implementer report and reviewer verdict shapes |
| `resume.md` | settling the branch from the state file, git-evidence resume rules, "review acceptance is never inferable from git" |
| `handoff.md` | the handoff block shape, the context-action table, the one-block-per-stage rule, the await gate |
| `delegation.md` | who does the work: the coordinator's closed duty list, the stage budget's counters, the research-dispatch contract, and the return envelopes |
| `branch.md` | branch discipline for every committing path |
| `output.md` | output discipline for every agent and skill |
| `checklist.md` | the on-device checklist contract: paths, item shape, dimensions, and the `(auto)` boundary |
| `quality-criteria.md` | what any review or plan measures against: the criteria catalog, sourcing precedence, the seed index, and the forward-use rules |
| `findings.md` | how a finding is expressed: severity with blocking derived, the core and document field sets, evidence discipline, ordering, the machine shape |

A consumer names one — "Read `${CLAUDE_PLUGIN_ROOT}/references/<name>.md` and follow it" —
and does not restate its content.

**Why.** These conventions are needed by most stages, so before this each skill carried its
own copy of them. Copies drift: a fix to branch discipline had to be found and reapplied in
every skill that mentioned it, and any one that was missed became a second, contradictory
answer to the same question. The copies also cost context on every load, in a plugin whose
whole premise is that context is the scarce resource.

The invariant that makes it work is stronger than "add a pointer": **a skill that consumes a
reference names it and deletes its own prose on the subject.** A pointer added next to a
retained restatement leaves two owners, which is worse than one bad owner — the reader now
has to decide which is authoritative. What stays in a skill is only what is unique to that
stage.

These files are deliberately not skills. They carry no frontmatter, are never invoked by
name as `devcycle:<something>`, and take no share of the description budget §4.6 tracks —
they cost nothing until a skill in flight names one and reads it.

### 15.2 Native engines vs upstream overlays, keyed to `profile`

`profile` ∈ `lean | standard | thorough`, default `standard`. It is one preset over the
knobs that size a run:

| | `lean` | `standard` | `thorough` |
| --- | --- | --- | --- |
| planning / execution engine | devcycle-native compact | devcycle-native compact | upstream overlays |
| branch review engine | `single` | `single` | `panel` |
| on-device gate | `auto-ok` | `human-required` | `human-required` |
| evidence tail in reports | 10 lines | 20 lines | 50 lines |
| branch-review round cap | 2 | 3 | 5 |
| audit depth | named criteria, ranked findings | full criteria sweep | full sweep + adversarial verification |

Resolution order (binding, stated once in `config.md`): an explicitly configured knob wins
verbatim; otherwise the profile's column value applies; a `profile` that is unset or outside
the three reads as `standard`.

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

**What the profile may never touch:** the state file, handoff blocks, evidence classes, the
coordinator's green-gate re-run, the `gitPolicy` clamps, branch discipline, the
one-`task-reviewer` floor on the short paths, and the never-assume interview rule. A `lean`
run may skip a stage; it never fakes one, and never reports a gate as passed that did not
run. Cost is allowed to buy less depth, never a false claim.

### 15.3 The audit stage

Triage's maturity axis gained a third verdict: **audit-shaped** input ("audit X", "review
the repo for Y" — an assessment of existing code rather than a change to it) routes to the
**audit** stage, which runs *in place of* scoping. `devcycle:auditing-a-repo` establishes
what is wrong before anything is designed; the findings the user selects become brainstorm's
explored context, and the walk continues normally. This is the same ordering rule §3's
diagnosis stage follows for bugs — you cannot spec a fix for a problem nobody has
established. A cycle where the user selects nothing closes at the report.

Two properties carry the stage:

- **Criteria are interviewed for, never chosen.** A sweep against criteria the auditor
  picked measures the repo against the auditor's taste, not the user's priorities. The
  interview proposes a criteria set derived from a shallow orientation pass — a user handed
  a proposal corrects it in one turn, a user handed a blank menu has to invent one — and
  then hard-stops exactly as `scoping-interview` stops: no research, no draft findings until
  the user has replied.
- **No `file:line`, no finding.** The evidence discipline `red-team-reviewer` applies to
  review claims applies to audit claims. A suspicion that cannot be pointed at in a file
  does not appear in the document at all, and a coverage statement names what was not read,
  so a partial audit cannot read as a complete one.

Only depth is profile-conditional (the matrix row above); the interview and the evidence
rule are not.

`/devcycle:audit` exposes the same skill standalone, and is deliberately **not** a pipeline
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

**One shared skill, not a merge.** `reviewing-code` owns the engine both whole-scope reviews
share: lens construction from the criteria, engine selection and its `panel→single`
degradation, the fresh-context rule, and verify → dedup → rank. `auditing-a-repo` and
`reviewing-the-branch` stay separate skills because their stops, outputs and lifecycles
genuinely differ — the audit interviews for criteria and stops for a user selection; the
review enumerates a spec and runs a bounded rounds loop. What they shared was never the
stage, only the engine.

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

## Appendix: upstream comparison summaries

Full memos live in `docs/comparisons/`; each one compares a planned devcycle skill against its
nearest superpowers upstream skill(s) before the skill was built, per the §11 comparison
mandate. Summaries below are 2–3 lines each — read the linked memo for the complete (a)/(b)/(c)
breakdown and conflict resolutions.

- **[executing-waves](docs/comparisons/executing-waves.md)** — vs `subagent-driven-development` +
  `executing-plans`. Upstream covers fresh-subagent dispatch, the per-task review loop, the
  progress ledger, and model-selection guidance. devcycle adds wave-by-readiness dispatch, a
  coordinator-side deterministic green gate, richer ledger events, handoff blocks with
  wave-boundary compaction, userConfig-driven model routing, and TDD-content preloading into
  briefs.
- **[planning-waves](docs/comparisons/planning-waves.md)** — vs `writing-plans`. Upstream covers
  plan file location, task sizing, the interfaces block, and the self-review checklist. devcycle
  adds concurrency as a first-class goal: file-disjoint task boundaries, per-task `Dependencies:`
  declarations, a `Dispatch Map` of waves, a reuse-before-rebuild rule, and a pre-planning
  feasibility gate.
- **[reviewing-the-branch](docs/comparisons/reviewing-the-branch.md)** — vs
  `requesting-code-review`. Upstream supplies the single-reviewer dispatch template and check
  catalogue. devcycle turns it into a mandatory whole-branch gate keyed to
  `userConfig.reviewDepth` (single vs multi-lens panel), adds a spec-compliance layer read
  against the spec file, a findings-fix-and-re-review loop, and disclosed graceful degradation.
- **[scoping-interview](docs/comparisons/scoping-interview.md)** — vs `brainstorming`. Upstream
  owns design exploration and spec writing untouched. devcycle adds a pre-stage that batches
  clarifying questions (resolving an explicit conflict with upstream's one-question-at-a-time
  style), confirms a summary first, hard-stops after asking, and hands off a bounded scope into
  brainstorming.
- **[verifying-on-device](docs/comparisons/verifying-on-device.md)** — vs
  `verification-before-completion`, the nearest (only-in-spirit) equivalent. Upstream supplies
  the general claim-verification discipline. devcycle adds the on-device checklist artifact, a
  verification-dimension catalogue, the `(auto)` script/human boundary, and a fresh-session
  one-question-per-item walkthrough.

## Appendix: the surrounding three-tier setup (author context — not part of the plugin)

devcycle is tier 1 of a three-tier personal agent setup this design originally covered as a
whole. The material below — the tier table from §2, the tier-2 roadmap from §9, and the
config classification from §11 — describes the author's company-repo conventions and
personal config. It is kept for historical context only; nothing in it ships with, or is
required to use, the plugin.

### Three-tier architecture (from §2)

| Tier | Form | Updates via | Contains |
| --- | --- | --- | --- |
| 1. `devcycle` | Public GitHub repo = plugin + marketplace in one (`marketplace.json` points at `./`) | Marketplace auto-update (opt-in toggle; post-session-start pull) | General pipeline skills, commands, agents, workflow scripts |
| 2. Company in-repo | `agents/` + `Docs/` + `.github/instructions/` + `.claude/` in the monorepo | `git pull` | ticket workflow, repo skills, UI conventions, domain docs, stack commands, allowlist |
| 3. Personal | Slim `~/.claude/CLAUDE.md`, plugin `userConfig`, memory dir | Manually | Git trust policy, RTK/graphify env, budgets, memory conventions |

### Repo-tier roadmap — company monorepo (from §9)

| Item | Purpose | Priority |
| --- | --- | --- |
| Per-package `CLAUDE.md` + directory-scoped `.claude/skills/` | Auto-load guidance/skills by touched subtree (e.g. PowerSync skills scoped to `Source/Libs/shared-mobile-core/`); complements the root routing map | High |
| `Tools/SyncRules` generator | One canonical rules source generating both `.github/instructions/*` (Copilot `applyTo`) and Claude-native path-scoped rules — extends the repo's SyncMcp canonical→adapters pattern; single source of truth | High |
| Committed role memory (`.claude/agent-memory/<role>/MEMORY.md`) | Durable team-shared reviewer/implementer gotchas; team-visible sibling of personal memory; promotion-session landing zone | Medium — verify feature details first |
| Sandbox/auto-mode paragraph in working-with-coding-agents.md | Unattended-wave story alongside the allowlist | Low |
| Ticket-CLI wrapper note in ticket skill | Lean script beats MCP tokens for bulk/verbose ops | Low |
| Remaining memory promotions | easy-language emphasis → review instructions; "user runs translate" → i18n guide; "never `feat`" → verify git-workflow.md documents it | Low, ongoing |

### Classification of existing config (from §11)

| Item | Tier | Destination |
| --- | --- | --- |
| Foundational principles, working standards, uncertainty→interview | 1 | README + skill preambles |
| Brainstorming-first mandate, feasibility gate | 1 | /cycle triage + scoping-interview |
| Execution mechanics (waves, ledger, briefs, TDD, dispatch, review flow, backups, wave compaction) | 1 | planning-waves + executing-waves |
| Model routing lineup; cross-model adversarial review | 1 | userConfig |
| On-device checklist + walkthrough interview style | 1 | verifying-on-device |
| Plain-findings-language | 1 | reviewer agent style |
| Reuse-before-rebuild | 1 principle / 2 instances | plugin rule; repo names components |
| Tech stack (Angular/.NET commands) | 2 | PROJECT.md (plugin stays stack-agnostic: "detect real commands") |
| Ticket workflow and conventions | 2 | done (2026-07-22 overhaul) |
| i18n, easy-language, light-only, snackbar/ind-error, PowerSync, commit conventions | 2 | half promoted 2026-07-22; fold the rest |
| Git policy (local-only, never merge dev, commit-on-ask) | 3 → userConfig.gitPolicy | delete memories once encoded |
| RTK, graphify, skill-placement meta, commit-only-durable-docs | 3 | stays personal |
| heic-conversion-design memory | none | ticket-scoped; expires |
| code-review-name-collision memory | resolved by tier 1 | delete once task-reviewer agent ships |
