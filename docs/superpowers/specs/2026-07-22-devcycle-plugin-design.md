# devcycle Plugin — Approved Implementation Spec

**Date:** 2026-07-22 **Status:** Approved, pre-implementation

This spec is a **delta** on two companion documents in this repo, which remain authoritative for
everything not restated here:

- `docs/superpowers/specs/2026-07-22-devcycle-kickoff-requirements.md` — the requirements dossier
  (pipeline, context lifecycle, binding ported content §12, skill-authoring bar §13, superpowers
  comparison mandate §11, quality gates §8, porting order §9, definition of done).
- `DESIGN.md` — design rationale (three-tier architecture, workflow suitability, non-goals).

Where this spec resolves an open decision or amends the dossier, this spec wins.

## 1. Identity (resolved)

| Item | Value |
| --- | --- |
| Name | `devcycle` (renamed from `development-cycle`) |
| Repo | `github.com/KonstantinRoehrl/devcycle`, **public from day 1** |
| License / author | MIT / Konstantin Röhrl |
| Commands | `/devcycle:cycle`, `/devcycle:continue` |
| State dir (target repos) | `.devcycle/state.md` |
| Release tags | `devcycle--vX.Y.Z` |
| Agents | `devcycle:implementer`, `devcycle:task-reviewer`, `devcycle:red-team-reviewer` |
| Git autonomy (this build) | Create + push freely; topic branches + PRs to `main` once CI exists |
| Redaction | Scan-and-strip company/machine references before every public push; enforced by CI guard (§4) |

## 2. Resolved design decisions (dossier §10.C)

1. **Green gate = coordinator re-run.** The coordinator re-runs the task's test command itself and
   blocks acceptance until it passes. No hooks anywhere in the plugin.
2. **Ledger stays upstream.** Execution progress lives in superpowers' `.superpowers/sdd/progress.md`;
   the plugin owns only `.devcycle/state.md` (current stage, artifact paths, branch).
3. **Two commands** (`cycle`, `continue`), both `disable-model-invocation: true`.
4. **Five skills:** `scoping-interview`, `planning-waves`, `executing-waves`, `reviewing-the-branch`,
   `verifying-on-device`.
5. **Scenario harness v1 = structured files** in `tests/scenarios/` (setup / subagent prompt / pass
   criteria), executed by fresh subagents per release. Scripted `claude -p` runner deferred to v1.x.
6. **bump-version.yml logic is hand-rolled** (in-repo script, no third-party bump action).
7. **README framing: general-audience** — "opinionated idea-to-verified-implementation pipeline;
   policy is config." Length stays short per the binding dossier §3 requirement.
   *(Amended 2026-07-23, owner decision: comprehension outranks brevity — the README now uses
   progressive disclosure: skimmable top, then pipeline overview, component inventory, and
   config semantics. The dossier §3 brevity bound and its no-pipeline-narrative rule are
   superseded. Superpowers install mechanics are deliberately not documented — the README
   links the superpowers repo instead, since another project's install commands may change.)*
8. **Interview batching:** plugin skills batch via AskUserQuestion (1–4 questions + options + Other);
   upstream `superpowers:brainstorming` is not modified; `/devcycle:cycle` notes that the batching
   preference carries into the brainstorm stage.
9. **Review engine is a hybrid keyed to `userConfig.reviewDepth`** *(amends dossier §5)*:
   - `single` (default): the branch review runs through the built-in `code-review` skill plus a
     spec-compliance layer defined by `reviewing-the-branch`.
   - `panel`: `workflows/review-panel.js` — 2–3 read-only lens reviewers (spec compliance /
     correctness+security / simplification), per-finding adversarial verification, dedup, reconciler.
     Each lens uses the `code-review` skill when available in its environment.
   - If `code-review` is unavailable, skills degrade gracefully to their own review instructions and
     say so in the review report.

## 3. Amendments from the author's live config (best-of-both-worlds)

- **Model lineup is provisional:** `executing-waves` instructs a reassessment of available models at
  execution start (reason per task; propose rerouting) rather than treating `userConfig.modelLineup`
  as fixed policy.
- **CI hardening on all workflows:** every third-party action pinned to a full commit SHA (version as
  trailing comment); top-level `permissions: contents: read` with per-job elevation; per-ref
  `concurrency` group with `cancel-in-progress`. `dependabot.yml` covers `github-actions`, grouped PRs.
- **Same-step deletion rule extends to the author's machine:** when a plugin skill ships, the
  superseded global CLAUDE.md sections AND overlapping global skills (`executing-plans-ops`,
  `on-device-audit`) are retired in the same step, after a dated backup. (Author-side migration step,
  not repo content.)
- **graphify stays out** of the public plugin (personal tier tooling).
- The v1.x `onboarding-a-repo` skill must run a §11-style comparison against the author's
  `new-repo-bootstrap` global skill in addition to upstream superpowers.

## 4. CI (dossier §7 + approved extras)

**validate.yml** (PRs + `main`):
- JSON validity + required fields of `plugin.json` / `marketplace.json`.
- Every SKILL.md has `name`/`description` frontmatter; descriptions start with "Use when"; per-description
  length bounds; total description budget under threshold (exact numbers verified during implementation).
- Balanced markdown fences in all `.md` files.
- **Redaction guard:** fail on forbidden strings (company names, machine-specific paths, private
  hostnames) anywhere in the tree; the deny-list lives in the repo and is itself generic.
- **PR-title lint:** PR titles must parse as Conventional Commits (squash-merge subject drives the
  version bump; a malformed title would silently produce no release).

**bump-version.yml** (merge to `main`):
- Hand-rolled script: semver level from conventional-commit subjects since last tag (`fix:`→patch,
  `feat:`→minor, `!`/`BREAKING CHANGE`→major, default patch); bump `plugin.json`; append subjects to
  `CHANGELOG.md`; commit `[skip ci]`; tag `devcycle--vX.Y.Z`.
- **GitHub Release per tag:** publish a Release carrying that version's changelog section.
- Job-level `contents: write` only.

Dropped after evaluation: `claude plugin validate` CI step, actionlint.

## 5. Everything else

Repository layout, pipeline stages, context-lifecycle table, handoff blocks, state-file semantics,
userConfig schema and defaults, workflow script contracts, quality gates (scenario tests + fresh-eyes
review per skill), porting order, and the session definition of done: **exactly per the kickoff
requirements doc**, with the name substitution of §1 applied throughout.
