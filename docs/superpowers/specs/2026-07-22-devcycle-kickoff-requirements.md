# KICKOFF: Build the `devcycle` Claude Code Plugin (Session 1 of 2)

**How to use this file:** Start a FRESH Claude Code session (working directory outside the company monorepo,
e.g. `~/Projects/`) and point it at this file. This document is **fully self-contained and authoritative**: every
binding requirement, including the content being ported and the quality bar for authoring skills, is INLINED here
(§12–§13). External paths (§14) are for verification and comparison only — if any of them is unavailable or has
drifted, the inlined content in this file governs. Do not assume the executing session has the user's global
CLAUDE.md, skills, or memories loaded.

**This is a requirements DOSSIER, not a finished design.** The executing session MUST run its own brainstorming
phase first (§1): locked decisions (§10.A) stand and are not re-litigated; every open decision (§10.C) is
brought to the user with 2–3 proposed variants and trade-offs before the design is finalized.

**Session 2 (separate, later):** the author's company repo-specific tier (per-package CLAUDE.md files, SyncRules
generator, role memory, remaining memory promotions). NOT in scope here.

---

## 0. Mission

Create a public GitHub repository `devcycle` that is simultaneously a Claude Code **plugin** and its own
**marketplace**, implementing the user's general development pipeline: rough idea or detailed ticket →
interviewed scope → brainstormed spec → wave-based file-disjoint plan → subagent execution with TDD and model
routing → per-task review → whole-branch multi-lens review → on-device/Playwright verification → branch finished
per configured git policy. The plugin is a **thin overlay on superpowers** (declared plugin dependency, no
blind forking) and is repo-agnostic — personal and company specifics are configuration (§6) or out of scope.

**Superpowers may cover parts of this already.** For every skill built here, upstream superpowers has a related
skill; §11 defines a mandatory compare-and-merge step. Never port the user's mechanics blind over upstream, and
never defer to upstream blind over the user's mechanics — compare, synthesize the best of both, keep the plugin
skill a true delta.

## 1. Process requirements for THIS session

- **Brainstorm first.** Begin with the superpowers **brainstorming** skill, using this dossier as the explored
  context: confirm understanding, then walk the open decisions — §10.B as a batched interview, each §10.C item
  presented with 2–3 concrete variants, trade-offs, and a recommendation (batched per §12.4). Locked decisions
  (§10.A) are settled — do not re-litigate them. Only after the user approves the resulting design delta: write
  the spec, then the superpowers **writing-plans** implementation plan (or, if unavailable, the plan contract in
  §12.2), then execute subagent-driven per §12.1.
- **Collaboration profile (the user):** senior fullstack engineer (Angular/TypeScript + .NET), production-quality
  bar. Expectations: never assume — interview; decisive decisions arrive as multiple proposed variants with a
  recommendation, never a single fait accompli; questions batched, not trickled; plain, symptom-first language.
- **Superpowers presence check first:** the plugin declares `dependencies: ["superpowers"]`. If superpowers is
  not installed in this environment, stop and tell the user before proceeding — the comparison step (§11) and
  the overlay architecture depend on reading upstream.
- **Interview before assuming** (batched AskUserQuestion, max 4 per call, concrete options + Other). §10 lists
  the session-start decisions. Uncertainty at any later point → interview, never guess.
- Commit style in the new repo: standard Conventional Commits. (`feat:` is allowed here — any "never feat" rule
  the session may encounter in the user's other configs is company-repo-specific.)
- Findings and reports in plain everyday language, symptom first, no unexplained jargon.

## 2. Verified platform facts (checked against official docs 2026-07-22 — do not re-derive)

- Plugin anatomy: `.claude-plugin/plugin.json` (required: `name`; plus `version`, `description`, `author`,
  `license`, `dependencies`, `userConfig`, component path overrides). Components: `skills/`, `commands/`,
  `agents/`, `hooks/`, `.mcp.json`, `bin/`, `settings.json`.
- Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner`, `plugins: [{name, source: "./"}]`. A repo
  can be plugin and marketplace at once. Cross-marketplace dependencies require
  `allowCrossMarketplaceDependenciesOn: ["superpowers-marketplace"]`.
- `dependencies: ["superpowers"]` (optionally semver-ranged, `marketplace` qualifier): auto-installs; if
  unsatisfied the plugin loads disabled with `dependency-unsatisfied`.
- Versioning: `plugin.json` `version` is authoritative. Omitting it makes every git commit a new version —
  never omit. Dependency-resolution git-tag format: `devcycle--vX.Y.Z`.
- Auto-update: opt-in per marketplace (toggle in `/plugin` UI); update check runs after session start (delay up
  to ~10 min) — releases reach users next session. Manual: `/plugin update devcycle`.
- Namespacing: skills `devcycle:<skill>`, commands `/devcycle:<command>`, agents
  `agentType: "devcycle:<agent>"`. No collisions with user/repo skills.
- Skill frontmatter supports `disable-model-invocation: true`; agent frontmatter supports a `tools:` allowlist.
- Skill/command descriptions share a finite char budget (checkable via `/context`) — verify exact numbers
  during implementation.

## 3. Repository deliverable

```
devcycle/
├── .claude-plugin/
│   ├── plugin.json               # name, version 0.1.0, description, license, dependencies: ["superpowers"],
│   │                             # userConfig (§6)
│   └── marketplace.json          # source "./", allowCrossMarketplaceDependenciesOn: ["superpowers-marketplace"]
├── commands/
│   ├── cycle.md                  # entry: input-maturity triage → stage walk; disable-model-invocation: true
│   └── cycle-continue.md         # resume from .devcycle/state.md after /clear
├── skills/
│   ├── executing-waves/          # §4 + §12.1   [PORT FIRST]
│   ├── planning-waves/           # §4 + §12.2
│   ├── verifying-on-device/      # §4 + §12.3
│   ├── reviewing-the-branch/     # §4 + §5
│   └── scoping-interview/        # §4 + §12.4
├── agents/
│   ├── implementer.md            # brief-driven TDD implementer template
│   ├── task-reviewer.md          # per-task reviewer; tools: Read/Grep/Glob/Bash ONLY
│   └── red-team-reviewer.md      # adversarial reviewer; same read-only tools allowlist
├── workflows/
│   ├── review-panel.js           # §5
│   └── mechanical-sweep.js       # §5
├── .github/workflows/
│   ├── bump-version.yml          # §7
│   └── validate.yml              # §7
├── tests/scenarios/              # the scenario suite from §8 — kept as regression tests
├── DESIGN.md                     # design rationale (copied from the design doc, §14)
├── README.md                     # SHORT and concise — binding requirement below
└── CHANGELOG.md
```

**README requirement (binding):** the README is deliberately short and concise — a reader decides in under a
minute whether this plugin is for them and how to install it. Contents, in order: what it is (2–3 sentences),
install (marketplace add + plugin install commands), quickstart (`/devcycle:cycle` in one example),
the userConfig knobs as a compact table, links to DESIGN.md and CHANGELOG for everything deeper. The pipeline
narrative and any demo transcript live in DESIGN.md or `docs/` — NOT in the README.

v1.x additions (AFTER v1 works): `onboarding-a-repo` (bootstrap any repo: detect real commands, scaffold
CLAUDE.md/rules, permission-allowlist scan, wire verification commands), `distilling-learnings` (codified
observation→docs/skills promotion session), `sweeping-mechanical-changes` (bulk uniform edits, pilot-first).
Non-goals: hooks in the plugin, /retro machinery, blanket-forked superpowers skills, agent-teams backend,
headless-CI stage (later), monitors/LSP/themes.

## 4. Pipeline & context lifecycle

Stage flow: `/cycle <input>` triages input maturity — detailed ticket/spec → brainstorm-validation or planning;
rough idea → scoping-interview first. Every stage ends with a **handoff block** (required output): artifact
paths + pinned carry-overs + a ready-made compaction hint + the recommended context action from this table:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| spec → planning | Compact with hint | spec path, decisions, constraints | design back-and-forth |
| plan → execution | Clear + `/cycle continue` | nothing (files carry it) | planning conversation |
| wave → wave | Compact if >~40% context | ledger/plan paths, pinned interfaces, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch review | Clear or fresh agents (bias control: a reviewer that watched the code being written inherits the implementer's assumptions) | branch, spec path, ledger path | all implementation context |
| review → on-device | Fresh session | checklist path, branch | everything else |

Principle: **files are the state; the conversation is a cache.** State file `.devcycle/state.md` (in
the TARGET repo a cycle runs in): current stage, artifact paths, branch. `/cycle continue` re-derives position
from state + ledger + plan, making clear-and-resume viable.

## 5. Workflow scripts (v1)

- **review-panel.js** (invoked by `reviewing-the-branch`): 2–3 read-only lens reviewers (spec compliance vs the
  spec file / correctness+security / simplification) via `pipeline()`, per-finding adversarial verification,
  dedup by file+claim, reconciler ranks confirmed findings. Schema-validated outputs at every stage. Inputs via
  `args`: branch/diff ref, spec path. No file mutation. Optional cross-model (Codex) lens gated by
  `userConfig.crossModelReview`.
- **mechanical-sweep.js**: file list + transform instruction via `args`; pilot on 2–3 items, gate on pilot
  verification, then pipeline the rest with `isolation: 'worktree'` and a verify stage; log skipped/dropped
  items (no silent caps).

## 6. userConfig schema (shipped defaults shown)

```json
{
  "gitPolicy": "local-commits-only",        // local-commits-only | push-allowed | open-pr
  "modelLineup": {
    "implementer": "claude-opus-4-8",
    "taskReviewer": "claude-sonnet-5",
    "walkthrough": "claude-sonnet-5",
    "branchReview": "claude-opus-4-8"
  },
  "reviewDepth": "single",                  // single | panel
  "crossModelReview": false,
  "onDeviceGate": "human-required"          // human-required | auto-ok
}
```

Finish stage branches on `gitPolicy`: `local-commits-only` = hand the branch back (push/PR is the user's);
`push-allowed` = may push, never merge; `open-pr` = push + open PR. The plugin ships ZERO personal policy as
prose — trust-related behavior is a knob.

## 7. Versioning & CI (binding)

- Semver in `plugin.json`; `main` is always installable (marketplace source is `./`).
- **bump-version.yml** (on merge to `main`): semver level from conventional-commit subjects since last tag
  (`fix:`→patch, `feat:`→minor, `!`/`BREAKING CHANGE`→major, default patch); bump `plugin.json`; append
  subjects to `CHANGELOG.md`; commit `[skip ci]`; tag `devcycle--vX.Y.Z`; token needs
  `contents: write`.
- **validate.yml** (PRs + main): JSON validity + required fields of both manifests; every SKILL.md has
  name/description frontmatter; descriptions start with "Use when" and respect length bounds; total description
  budget under threshold; balanced markdown fences in all .md files.
- Semver semantics: patch = wording/bugfix; minor = new skill/command/config knob; major = pipeline-contract
  change (plan format, state-file shape, handoff-block shape).

## 8. Quality gates (per skill — non-negotiable)

Every skill is scenario-tested with fresh subagents BEFORE release, per the authoring bar in §13: at minimum one
discipline scenario (does an agent following the skill STOP/gate where required?) and one output-shape scenario
(does the produced artifact match the contract?). Scenarios live in `tests/scenarios/` as the regression suite.
A fresh-eyes re-review by an uninvolved subagent closes each skill. (Reference execution of this exact process:
the 2026-07-22 ticket-creation skill overhaul in the author's company repo — scenario tests caught nothing less than the
STOP gate and template compliance; the fresh-eyes review found 3 real defects.)

## 9. Porting order (v1)

1. Repo scaffold + manifests + CI + README skeleton + DESIGN.md; install locally via
   `claude plugin marketplace add <path>`; verify superpowers dependency resolution.
2. `executing-waves` (§12.1 content + §11 comparison) — on ship, the user deletes the superseded
   execution-mechanics section from their global CLAUDE.md (same-step deletion rule: no phase is ever defined
   in two places).
3. `planning-waves` (§12.2 + comparison) — same deletion rule.
4. `verifying-on-device` (§12.3 + comparison) — generalizes and then retires the user's existing global skill.
5. `reviewing-the-branch` + the three agents + `review-panel.js`.
6. `scoping-interview` (§12.4) + `/cycle` + `/cycle-continue` + state-file conventions.
7. User slims their global CLAUDE.md to the personal tier, sets userConfig values, enables the marketplace
   auto-update toggle, deletes superseded personal memories.

### Session-1 definition of done

- Plugin installs from the marketplace (local path acceptable pre-publish); superpowers dependency resolves.
- **End-to-end dry run:** one small real cycle executed with the plugin on a sandbox/toy repo — rough-idea
  intake → interview → spec → plan → one wave (≥2 file-disjoint tasks) → task reviews with green gate → branch
  review panel → handoff blocks and state file demonstrably produced. The on-device stage may be simulated if
  the sandbox has no UI.
- All shipped skills scenario-tested (§8), scenarios committed under `tests/scenarios/`.
- CI proven: `validate.yml` passing; `bump-version.yml` demonstrated by at least one merge producing a version
  bump + tag.
- Global CLAUDE.md slimmed per the same-step deletion rule — with a **dated backup of the original taken BEFORE
  the first deletion**, restore path reported to the user.
- README install instructions verified by literally following them.

## 10. Decision register

### 10.A Locked (decided 2026-07-22 — do NOT re-litigate)

Public GitHub repo hosting; repo = plugin + marketplace in one; name `devcycle`; thin overlay on
superpowers (declared dependency, no blanket forking); company-repo tier stays in-repo (Session 2); learning =
memory-as-inbox + promotion sessions (no /retro machinery); CI auto-bumps the version on merges to `main`;
three-tier architecture with personal policy as userConfig.

### 10.B Session-start interview (batched; facts only the user has)

1. GitHub org/username and exact repo name; public from day 1 or private until v1?
2. May this session create the repo and push (`gh repo create` / `git push`)? The user's LOCAL-COMMITS-ONLY
   policy is scoped to their company repo — the policy for their own public plugin repo is UNSET. Do not assume.
3. License (MIT / Apache-2.0 / other) + author field content.
4. Redaction pass: the ported content derives from a personal config — machine-specific paths, company
   references, or names must not ship publicly. Confirm the session should scan and strip.

### 10.C Open design decisions — propose 2–3 variants each, with trade-offs and a recommendation

1. Green-gate mechanism: subagent Stop hook vs coordinator re-run vs both (defense in depth).
2. Ledger & state ownership: reuse upstream `.superpowers/sdd/progress.md` + a separate
   `.devcycle/state.md`, vs consolidating both under `.devcycle/`.
3. Command UX: `/cycle` + `/cycle-continue` as specced, vs a single `/cycle` with stage arguments, vs one
   command per stage.
4. Skill granularity: the five planned skills vs merging (e.g. planning+executing) vs splitting further —
   informed by the §11 comparisons and the description budget.
5. Scenario-test harness: manual subagent runs per release vs a scripted runner under `tests/`.
6. `bump-version.yml` implementation: hand-rolled script vs an established third-party action — judged on
   supply-chain trust for a public repo.
7. README positioning: personal-workflow-with-config framing vs general-audience product framing. (Length is
   LOCKED: short and concise per the §3 README requirement — this variant question is framing/tone only.)
8. Resolution of the §11 batching-vs-one-question-at-a-time conflict.

### 10.D Verify during implementation (technical unknowns — not user decisions)

- Exact description char budget (via `/context`).
- **How userConfig values actually reach skill/command content at runtime** — the injection mechanism was NOT
  verified during design. Verify before any skill depends on it; if weaker than assumed, design the fallback
  (e.g. a `.devcycle/config.json` the skills read) and present it as a §10.C-style variant choice.
- Whether plugin-shipped workflow scripts invoke cleanly via the plugin cache path (before
  `reviewing-the-branch` relies on it).

## 11. Superpowers comparison mandate (the "best of both worlds" step)

For EVERY skill below, before writing it: read the current upstream superpowers skill(s), produce a short
comparison memo (kept in the plan or `DESIGN.md` appendix): (a) what upstream already covers — do not duplicate
it, reference it; (b) what the §12 mechanics add — that is the plugin skill's content; (c) conflicts — resolve
each explicitly and record the resolution. The plugin skill must remain a delta: if after comparison a planned
skill adds nothing over upstream, don't build it (say so instead).

| Planned skill | Compare against (superpowers) | Expected relationship |
| --- | --- | --- |
| executing-waves | subagent-driven-development, executing-plans | Overlay: adds waves, model routing, green gate, ledger detail, handoff blocks |
| planning-waves | writing-plans | Overlay: adds Dependencies declarations, dispatch map, pinned interfaces |
| scoping-interview | brainstorming | Pre-stage + KNOWN CONFLICT: superpowers asks one question at a time; the user's standard is batched AskUserQuestion (1–4 with options). Resolution direction: scoping-interview batches; do not modify upstream brainstorming, but the /cycle instructions may note the user's batching preference carries into the brainstorm stage. Compare and settle explicitly. |
| verifying-on-device | verification-before-completion (+ no direct upstream equivalent) | Mostly new; upstream covers claim-verification discipline, not device walkthroughs |
| reviewing-the-branch | requesting-code-review | Replace/extend: panel workflow + read-only reviewer agents vs upstream's single-reviewer template |
| (TDD content preloaded into briefs) | test-driven-development | Use upstream as-is via preloading — never fork |
| (skill authoring throughout) | writing-skills | Use upstream live if installed; §13 inlines the essentials as fallback |

## 12. BINDING PORTED CONTENT (inlined — authoritative even if external paths are unavailable)

### 12.1 Execution mechanics (→ executing-waves)

Waves and tasks: a plan decomposes into tasks; tasks group into waves via the dispatch map. A wave = every task
whose declared dependencies are already committed AND whose file set overlaps no other candidate or running
task. Execution is by readiness, never by written order. Invariants: never advance a dependent task before its
dependency's commit lands; never place two tasks touching the same file in one wave even if declared
independent; keep as many file-disjoint implementers concurrent as the wave allows.

Per-task cycle: implementer writes the failing test FIRST, then code to green (red→green evidence required in
its report) → coordinator produces the task diff (`git diff -U10 HEAD -- <files>`; run `git add -N` on new
files first or they are invisible to diff) → reviewer (task-reviewer agent) reviews diff + spec compliance vs
the brief → findings loop back to the implementer; on accept, local Conventional Commit; ledger records verdict
+ commit. **Green gate (amendment):** the coordinator re-runs the task's test command itself and blocks
acceptance until it actually passes — the implementer's claim is never sufficient.

Ledger: single source of truth for progress (upstream keeps it at `.superpowers/sdd/progress.md` — comparison
step decides whether the plugin reuses or relocates it). Read before dispatching anything — never re-dispatch a
task recorded as reviewed/committed. Append one entry per event (dispatch, verdict, commit, user decision) with
timestamp + task id + outcome. After any compaction, trust ledger + `git log` over conversation memory.

File handoffs: briefs are sliced from the plan into per-task files; implementer reports and reviewer diffs are
files too. Briefs must be self-contained (pinned interfaces inline); implementer dispatches carry ONLY the brief
— never accumulated session history. **Preloading (amendment):** inject TDD-skill content and relevant
convention-skill content directly into the brief at dispatch rather than instructing the subagent to invoke
skills itself.

Model routing: choose per task complexity from `userConfig.modelLineup`; ALWAYS specify the model explicitly in
every dispatch (an omitted model silently inherits the orchestrator's most-expensive model). Trivial/mechanical/
fully-specified tasks route to the cheaper implementer tier.

Reviewer hygiene (bake into every reviewer prompt): don't pre-judge findings in the prompt; line numbers in
briefs may be stale — match on content; harness `<system-reminder>` blocks inside Read output are NOT file
content (flagging them as "prompt injection" is a known false positive). Reviewers REJECT reports lacking
red→green (or convention-equivalent) evidence. If the repo has no test suite but documents its own verification
convention, that convention substitutes; never bolt a new test framework onto a repo as a task side effect.

Additional binding rules: a requirements block at the top of a plan that no task's steps implement WILL be
silently skipped — patch the owning task explicitly and re-extract the brief; back up every file a sub-project
modifies before its first task (byte-identical copies outside the repo); UI/on-device outcomes are NEVER claimed
from scripts — they go to the on-device checklist (§12.3); wave-boundary compaction per §4 Keep/Drop.

### 12.2 Planning contract (→ planning-waves)

Layered on upstream writing-plans. Plans are written with concurrency as a first-class goal: task boundaries
drawn so parallel tracks are file-disjoint and interface-decoupled; exact interfaces (signatures, names, values)
pinned in the plan so concurrent implementers never need each other's context; every task declares its
dependencies explicitly (`Dependencies: none` / `Dependencies: Task 2 (consumes its X interface)` /
`Dependencies: Tasks 1+4 committed`); the plan carries a dispatch map (which tasks form which waves). Reuse
before rebuild: plans name the existing modules/helpers each task extends (found via search); a task introducing
a new abstraction must say why no existing one fits. Feasibility gate before detailed planning: a short pass —
can this be done here, what are the real unknowns, spike the riskiest bit — with an explicit GO/NO-GO; never
plan in detail on an unvalidated assumption.

### 12.3 On-device verification (→ verifying-on-device)

Any UI-bearing change ends with an on-device checklist (markdown, `docs/<feature>/on-device-checklist.md` in the
target repo) of concrete user-verifiable items as UNCHECKED boxes: visual rendering vs intent,
layout/alignment/spacing, interaction feel (drag/hover/focus), responsive behavior at real breakpoints, theme
parity where the surface supports it, keyboard/accessibility, empty/loading/error states, animation timing.
Items are never marked done by a script or screenshot — only the human checks them off, EXCEPT honestly-tagged
`(auto)` verdicts where Playwright can structurally verify DOM/CSS/text assertions; the human interview covers
what a script structurally cannot see. The walkthrough runs in a fresh session (it needs only the checklist path
+ branch), drives an interview at ONE question per checklist item (never batched — findings quality drops when
items are bundled), and ends with an agent-actionable results report: what passed, what failed, why, severity.
Generate/update the checklist the moment a task produces rendered changes — don't defer to the end of the wave.

### 12.4 Interview discipline (→ scoping-interview and used throughout)

Whenever scope, intent, architecture, data, or user preference is uncertain: interview, never guess — batched
via AskUserQuestion (1–4 questions per call, concrete options + Other), not trickled one-per-message. Summary
confirmation occupies slot 1 of the first batch. Then a hard STOP: no drafting, no assuming answers, no
continuing analysis until answered. At most ONE follow-up round, and only when an answer changes scope or
invalidates prior research; remaining unknowns become explicit `<tbd>` markers — never silently defaulted. Small
reversible implementation choices are exempt. Research BEFORE questions, so questions are informed by the code.

### 12.5 Reporting style (all agents)

Findings and reports in plain everyday language: symptom first ("the user never sees the snackbar"), mechanism
second, jargon only where it adds precision. Applies to reviewer findings, walkthrough results, and handoff
blocks.

## 13. SKILL-AUTHORING QUALITY BAR (inlined essentials of superpowers:writing-skills)

- Frontmatter: `name` (letters/numbers/hyphens), `description` in third person, starting "Use when …",
  containing ONLY triggering conditions/symptoms — NEVER a summary of the skill's process (tested failure mode:
  agents follow the description's summary and skip the body). Keep under ~500 chars.
- Match the form to the failure: rule skipped under pressure → prohibition + rationalization table + red-flags
  list; wrong-shaped output → positive recipe/contract stating what the output IS; omitted element → structural
  REQUIRED slot in a template; condition-dependent behavior → conditional keyed to an observable predicate.
  NO nuance clauses ("don't X unless it matters" reopens negotiation); express real exceptions as their own
  observable-predicate conditionals.
- Iron Law: no skill (or skill EDIT) ships without a failing/behavioral test first. Test discipline skills with
  pressure scenarios (does the agent comply under time/sunk-cost pressure?); technique skills with application
  scenarios; reference skills with retrieval scenarios. 5+ reps for wording micro-tests; read every flagged
  match manually; variance across reps means the wording isn't binding.
- Cross-reference other skills by name with explicit REQUIRED markers; never @-link (force-loads context).
- Token efficiency: no redundancy between sections (redundancy = drift surface); one excellent example beats
  many; move heavy reference to separate files.

## 14. External sources (verification & comparison only — §12–§13 govern if these are unavailable)

- The author's global `~/.claude/CLAUDE.md` — original prose being ported (cross-check §12 against it if
  present; it may already be partially slimmed).
- The author's global on-device-verification skill — existing skill behind §12.3.
- `DESIGN.md` in this repository — full design rationale (three tiers, classification tables, workflow
  suitability, non-goals).
- Superpowers plugin cache (e.g.
  `~/.claude/plugins/cache/superpowers-marketplace/superpowers/<current-version>/skills/`) — upstream skills for
  the §11 comparisons. If superpowers is installed, ALWAYS read the live upstream versions; they may be newer
  than anything summarized here.
