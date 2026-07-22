# Development-Cycle Plugin & Three-Tier Agent Setup — Design

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
   on-device/Playwright verification → PR-ready branch. Repo-agnostic; adapts to any repository.
2. **company in-repo tier** — the existing `agents/` + `Docs/` + `.github/instructions/` structure, formalized
   (NOT packaged as a plugin). Versions with branches, updates via git pull, teammates get it by cloning.
3. **Personal tier** — a slimmed `~/.claude/CLAUDE.md` (~½ page) + plugin `userConfig` values + the memory
   system as learning inbox.

Decisions locked (2026-07-22): public GitHub repo hosting; in-repo form for the company-repo tier; thin overlay on
superpowers (declared dependency, no forking); memory-as-inbox learning (promotion sessions, no /retro
machinery); plugin name **`devcycle`**.

---

## 2. Three-Tier Architecture

| Tier | Form | Updates via | Contains |
| --- | --- | --- | --- |
| 1. `devcycle` | Public GitHub repo = plugin + marketplace in one (`marketplace.json` points at `./`) | Marketplace auto-update (opt-in toggle; post-session-start pull) | General pipeline skills, commands, agents, workflow scripts |
| 2. Company in-repo | `agents/` + `Docs/` + `.github/instructions/` + `.claude/` in the monorepo | `git pull` | ticket workflow, repo skills, UI conventions, domain docs, stack commands, allowlist |
| 3. Personal | Slim `~/.claude/CLAUDE.md`, plugin `userConfig`, memory dir | Manually | Git trust policy, RTK/graphify env, budgets, memory conventions |

**Core principle: personal policy becomes plugin configuration.** The public plugin ships zero personal policy;
anything that is a trust preference (e.g. "never push") is a typed `userConfig` knob with a conservative default.
Structure over trust: config is checked every run; memory and prose are recalled probabilistically.

Verified mechanics this design relies on (checked against official docs 2026-07-22):

- Plugins ship skills, commands, agents, hooks, MCP/LSP configs, `bin/`, settings; manifest supports
  `dependencies` (semver, auto-install, loads-disabled on unsatisfied) and `userConfig`.
- Cross-marketplace dependency on superpowers requires `allowCrossMarketplaceDependenciesOn:
  ["superpowers-marketplace"]` in the plugin's marketplace.json.
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
│   ├── plugin.json               # name, version (bump per release), dependencies: ["superpowers"],
│   │                             # userConfig (see §7)
│   └── marketplace.json          # source "./", allowCrossMarketplaceDependenciesOn: ["superpowers-marketplace"]
├── commands/
│   ├── cycle.md                  # entry: input-maturity triage → stage walk; disable-model-invocation: true
│   └── cycle-continue.md         # resume from .devcycle/state.md after /clear (see §5)
├── skills/
│   ├── scoping-interview/        # rough idea → bounded scope; batched AskUserQuestion; nothing assumed;
│   │                             # hands off to superpowers:brainstorming
│   ├── planning-waves/           # layers on superpowers:writing-plans — file-disjoint tasks, explicit
│   │                             # dependencies, dispatch map, pinned interfaces
│   ├── executing-waves/          # layers on superpowers:subagent-driven-development — ledger, brief/diff file
│   │                             # handoffs, TDD green gate, model routing, wave compaction, handoff blocks
│   ├── reviewing-the-branch/     # whole-branch gate via review-panel workflow + optional cross-model pass
│   ├── verifying-on-device/      # generalized from the existing on-device-verification skill
│   ├── onboarding-a-repo/        # bootstrap tier-2 in any repo (see §8)
│   ├── distilling-learnings/     # memory→docs/skills promotion session, codified (see §8)
│   └── sweeping-mechanical-changes/  # bulk uniform edits via workflow/`claude -p` fan-out (see §8)
├── agents/
│   ├── implementer.md            # brief-driven TDD implementer template
│   ├── task-reviewer.md          # per-task reviewer; read-only tools allowlist
│   └── red-team-reviewer.md     # adversarial lens; read-only tools allowlist
├── workflows/
│   ├── review-panel.js           # multi-lens review → adversarial verify → dedup → reconcile
│   └── mechanical-sweep.js       # pipeline over file list, worktree isolation, verify stage
└── README.md                     # pipeline narrative + demo transcript; CHANGELOG alongside
```

Pipeline stages: intake triage (`/cycle`) → scoping-interview (rough input only) → superpowers:brainstorming →
spec → planning-waves → executing-waves (per-wave: dispatch → TDD → review → commit) → reviewing-the-branch →
verifying-on-device → finish per `gitPolicy`.

---

## 4. Blueprint Amendments (source-mined, 2026-07-22)

1. **Deterministic green gate.** The implementer's red→green claim is verified by re-running the task's test
   command (coordinator re-run, or Stop hook on the implementer subagent) before "done" is accepted. Evidence,
   not self-report.
2. **Reviewers structurally read-only.** `task-reviewer` and `red-team-reviewer` declare a `tools:` allowlist
   (Read/Grep/Glob/Bash) — Edit/Write are structurally absent, not merely forbidden by prose.
3. **Skill preloading in briefs.** Implementer dispatches inject TDD + relevant repo-convention skill content at
   dispatch time instead of instructing the subagent to invoke skills itself.
4. **Entry points cannot auto-fire.** `/cycle` and any side-effectful skill carry
   `disable-model-invocation: true`; commands are the only entry points that cannot be silently substituted.
5. **Review panel as saved workflow** (see §6) — resumable, concurrency-capped, deterministic lens assignment.
6. **Description-budget release check.** Skill/command descriptions share a finite char budget (check via
   `/context`); verify before each release that devcycle + superpowers + a repo tier fit. (Exact budget
   numbers: verify during implementation.)
7. **Context lifecycle as a first-class protocol** (see §5): handoff blocks, state file, `/cycle continue`.

---

## 5. Context Lifecycle

**Principle: files are the state; the conversation is a cache.** Every stage ends by writing its artifact; the
conversation that produced it is then expendable. Each boundary picks the cheapest sufficient action.

Mechanics:

- **Handoff block** — every stage skill's required final output: artifact paths, pinned carry-overs (interfaces,
  open decisions), and a ready-made compaction hint for the user (skills cannot invoke /compact themselves).
- **State file** — `.devcycle/state.md`: current stage, artifact paths, branch. `/cycle continue`
  re-derives pipeline position from state + ledger + plan, making **clear-and-resume** viable (cheaper and
  cleaner than compaction).

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| spec → planning | Compact with hint | spec path, approved decisions, constraints | design back-and-forth, rejected alternatives |
| plan → execution | **Clear + `/cycle continue`** | nothing in-context (plan/briefs/state carry it) | entire planning conversation |
| wave → wave | Compact if >~40% | ledger + plan paths, pinned interfaces, dispatch map, wave status, open decisions | implementer transcripts, resolved findings, superseded diffs |
| execution → branch review | **Clear (or fresh agents only)** | branch, spec path, ledger path | all implementation context |
| review → on-device | Fresh session | checklist path, branch | everything else |
| verification → finish | Continue | results report path | — |

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
| Mechanical sweeps | **Strong** — pipeline over file list, worktree isolation | **`mechanical-sweep.js` ships v1** |
| Repo research | Good | Optional `repo-research.js`, post-v1 |
| On-device verification | None (human phase) | Never; Playwright pre-pass needs no workflow |

`review-panel.js` shape: 2–3 lens reviewers (spec compliance / correctness+security / simplification) →
adversarial verify per finding → dedup → reconciler ranks confirmed findings; optional cross-model (Codex) lens
gated by `userConfig.crossModelReview`.

---

## 7. userConfig Schema

```json
{
  "gitPolicy": "local-commits-only | push-allowed | open-pr",
  "modelLineup": {
    "implementer": "...", "taskReviewer": "...",
    "walkthrough": "...", "branchReview": "..."
  },
  "reviewDepth": "single | panel",
  "crossModelReview": false,
  "onDeviceGate": "human-required | auto-ok"
}
```

- Shipped defaults: `gitPolicy: local-commits-only` (most conservative), `reviewDepth: single`,
  `crossModelReview: false`, `onDeviceGate: human-required`.
- The finishing stage branches on `gitPolicy`: local-commits-only ends with the branch handed back (the author's
  mode); `open-pr` automates push + PR for users who want it.
- Model names are config values, not skill prose — they rot otherwise.
- Once encoded, corresponding personal memories (e.g. never-local-merge-to-dev) are deleted.

---

## 8. Skill Roadmap — Global Plugin

| Skill | Purpose | Priority |
| --- | --- | --- |
| executing-waves | Ledger, briefs, TDD green gate, model routing, wave compaction, handoff blocks | v1 — first port |
| planning-waves | Wave/dispatch-map/pinned-interface plan contract | v1 |
| verifying-on-device | Playwright auto-verdicts + human checklist interview (near-pure move of existing skill) | v1 |
| reviewing-the-branch | Branch gate via review-panel workflow + agents | v1 |
| scoping-interview + /cycle + /cycle continue + state file | Entry, triage, resume glue | v1 — last |
| onboarding-a-repo | Bootstrap tier-2 anywhere: detect real commands, scaffold CLAUDE.md/per-package rules, run allowlist scan, wire verification commands | v1.x — right after the pipeline works |
| distilling-learnings | Codified promotion session: memory/observation inbox → vetted docs/skill edits via writing-skills TDD | v1.x |
| sweeping-mechanical-changes | Bulk uniform migrations, pilot-first | v1.x |
| running-headless-ci | `-p --output-format stream-json` CI stage | Later — when a CI use case exists |
| Agent-teams review backend | Native shared-task-list adversarial review | Later — token-heavy; workflow panel covers it |

## 9. Repo-Tier Roadmap — Company Monorepo (tier 2)

| Item | Purpose | Priority |
| --- | --- | --- |
| Per-package `CLAUDE.md` + directory-scoped `.claude/skills/` | Auto-load guidance/skills by touched subtree (e.g. PowerSync skills scoped to `Source/Libs/shared-mobile-core/`); complements the root routing map | High |
| `Tools/SyncRules` generator | One canonical rules source generating both `.github/instructions/*` (Copilot `applyTo`) and Claude-native path-scoped rules — extends the repo's SyncMcp canonical→adapters pattern; single source of truth | High |
| Committed role memory (`.claude/agent-memory/<role>/MEMORY.md`) | Durable team-shared reviewer/implementer gotchas; team-visible sibling of personal memory; promotion-session landing zone | Medium — verify feature details first |
| Sandbox/auto-mode paragraph in working-with-coding-agents.md | Unattended-wave story alongside the allowlist | Low |
| Ticket-CLI wrapper note in ticket skill | Lean script beats MCP tokens for bulk/verbose ops | Low |
| Remaining memory promotions | easy-language emphasis → review instructions; "user runs translate" → i18n guide; "never `feat`" → verify git-workflow.md documents it | Low, ongoing |

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
5. v1.x skills (onboarding-a-repo, distilling-learnings, sweeping-mechanical-changes); repo-tier roadmap items
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
- Commands: `/devcycle:cycle`, `/devcycle:cycle-continue`.
- Skills: verb-first gerunds (`executing-waves`, `planning-waves`, `verifying-on-device`,
  `reviewing-the-branch`, `scoping-interview`, `onboarding-a-repo`, `distilling-learnings`,
  `sweeping-mechanical-changes`).
- Agents: `devcycle:implementer`, `devcycle:task-reviewer`,
  `devcycle:red-team-reviewer`.

## 14. Open Questions (deferred to implementation)

- Exact Stop-hook wiring for the green gate on subagents (hook vs coordinator re-run — pick during
  executing-waves port; coordinator re-run is the fallback if subagent Stop hooks prove awkward).
- `.claude/agent-memory/` feature details (verify against docs before the repo-tier item).
- Description char budget exact numbers (verify via /context during release checks).
- Whether `verifying-on-device`'s Playwright pre-pass needs repo-specific target config in tier 2
  (likely: an `accesslint.config.json`-style target file).

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
