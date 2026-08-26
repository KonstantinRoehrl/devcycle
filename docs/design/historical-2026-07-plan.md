# devcycle Plugin — Design: frozen 2026-07 pre-implementation plan

This file holds the sections of the original 2026-07-22 `DESIGN.md` that described the plugin's
**planned** migration and its author-context framing, kept for the record. They are frozen: the
live design and architecture reference is [`README.md`](README.md) in this directory. Nothing here
is maintained against the shipped surface — read it as history, not current truth.

---

## 8. Playbook Roadmap — Global Plugin

Names are the shipped `playbooks/` files (§3); the ordering is the historical port order.

| Playbook | Purpose | Priority |
| --- | --- | --- |
| executing-waves | Ledger, briefs, green gate, model routing, wave compaction, handoff blocks | v1 — first port |
| planning-waves | Wave/dispatch-map/pinned-interface plan contract | v1 |
| verifying-on-device | claude-in-chrome auto-verdicts + human checklist interview | v1 |
| reviewing-the-branch | Branch gate via review-panel workflow + agents | v1 |
| scoping-the-request + /devcycle:cycle + /devcycle:continue + state file | Entry, triage, resume glue | v1 — last |
| onboarding-a-repo | Bootstrap tier-2 anywhere: detect real commands, scaffold CLAUDE.md/per-package rules, run allowlist scan, wire verification commands | v1.x — right after the pipeline works |
| learning-from-sessions | Observe → propose → confirm → land: sessions and memory become doc edits, standalone `/devcycle:learn` | v1.x |
| sweeping-mechanical-changes | Bulk uniform migrations, pilot-first | shipped |
| reviewing-code | Interviewed criteria → ranked, file-referenced findings; standalone `/devcycle:review` or the in-cycle audit stage | shipped |
| profiling-sessions | Token/context/routing/startup-cost analysis and config drift, standalone `/devcycle:doctor` | shipped |
| running-headless-ci | `-p --output-format stream-json` CI stage | Later — when a CI use case exists |
| Agent-teams review backend | Native shared-task-list adversarial review | Later — token-heavy; workflow panel covers it |

---

## 9. Repo-Tier Roadmap — Company Monorepo (tier 2)

*(Moved to the trailing appendix — author context, not part of the plugin.)*

---

## 11. Classification of Existing Config

*(Moved to the trailing appendix — author context, not part of the plugin.)*

---

## 12. Migration Sequence

Governing rule: **when a skill ships (historical: devcycle ships playbooks, not skills — this section records the migration as it was
planned, not the surface as it stands), the corresponding global-CLAUDE.md section is deleted in the same step** —
no phase is ever double-defined.

1. Create the public repo: manifest + marketplace + README skeleton; declare superpowers dependency; install via
   `claude plugin marketplace add`; enable that marketplace's auto-update toggle.
2. Port in order: executing-waves → planning-waves → verifying-on-device → reviewing-the-branch (+ agents +
   review-panel workflow) → scoping-the-request + /cycle + state file.
3. Each port gets the writing-skills treatment: scenario-tested (STOP-discipline and output-shape tests, as in
   a prior skill overhaul) before it replaces the prose it supersedes; description-budget check per
   release; version bump per release. *(The prose scenario harness was retired 2026-08-06 —
   `CONTRIBUTING.md` owns what replaced it; the rest of this step stands.)*
4. Slim `~/.claude/CLAUDE.md` to tier 3; set userConfig values; delete superseded memories.
5. v1.x playbooks (onboarding-a-repo, learning-from-sessions); repo-tier roadmap items
   in parallel via promotion sessions.
6. Later, one team decision: repo `.claude/settings.json` provisions superpowers + devcycle for
   teammates.

### Release automation (CI) — added 2026-07-22, rewired 2026-08-06

Version handling on GitHub is enforced by CI, not discipline alone. **`CONTRIBUTING.md`
§ Releasing owns the procedure**; the design point it implements is this one: the version bump
arrives inside the release PR, so `main` only ever changes through a checked pull request, and
the `Release` workflow tags and publishes what `main` already carries rather than writing to it.
`validate.yml` is the gate the release depends on — manifests, command frontmatter and the
description budget (the mechanized form of amendment §4.6), the routing table against each
command's guard, balanced fences, the redaction and duplication checkers, the unit suite, and a
full-history secret scan.

---

## 14. Open Questions (deferred to implementation)

- Exact Stop-hook wiring for the green gate on subagents (hook vs coordinator re-run — pick during
  executing-waves port; coordinator re-run is the fallback if subagent Stop hooks prove awkward).
- `.claude/agent-memory/` feature details (verify against docs before the repo-tier item).
- Description char budget exact numbers (verify via /context during release checks).
- Whether `verifying-on-device`'s claude-in-chrome pre-pass needs repo-specific target config in tier 2
  (likely not: the user drives their own authenticated Chrome, so there is no separate target/URL config to pin).

---

## Appendix: upstream comparison summaries

Full memos live in `docs/comparisons/`; each one compares a planned devcycle stage against its
nearest superpowers upstream skill(s) before it was built, per the §11 comparison
mandate. Summaries below are 2–3 lines each — read the linked memo for the complete (a)/(b)/(c)
breakdown and conflict resolutions. The memos keep the names the units had when they were
written; `scoping-interview` is today's `playbooks/scoping-the-request.md`, and the other four
kept their names as playbooks (§3).

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

---

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
| Brainstorming-first mandate, feasibility gate | 1 | /cycle triage + scoping-the-request |
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
