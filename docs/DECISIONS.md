# Decision log

Dated records of decisions that changed the project's course, so older docs that predate a
reversal have somewhere to point. Newest first. Each entry: the decision, why, and what it
supersedes. Historical documents (the dry-run report, platform notes, the founding spec)
are evidence of their moment — they get a forward pointer here, never a rewrite.

## 2026-07-23 — finish stage resolves gitPolicy against external push signals

**Decision:** Before acting on `push-allowed`/`open-pr`, the finish stage
(`/devcycle:cycle` Step 7 and `/devcycle:continue`'s mirrored section) resolves an
**effective** git policy: if a Claude Code permission `deny` rule matches `git push`, or
the cycle's branch is the repo's release/default branch, the effective policy clamps to
`local-commits-only` for that run regardless of the configured value. The finish stage's
Handoff block always states the effective policy, naming the configured value and reason
when they differ. `local-commits-only` needs no check — it was already the floor.
**Why:** `gitPolicy` was evaluated in isolation from anything outside devcycle's own
config. Two gaps followed directly: a Claude Code permission deny on `git push` would
only surface as a failed tool call mid-finish rather than a clean downgrade, and nothing
stopped `push-allowed` from pushing straight to the repo's default branch if a cycle
happened to start there — violating the user's own "never push a release branch
directly" rule with no devcycle-side guard.
**Supersedes:** Nothing reversed — this adds a resolution step in front of the existing
`gitPolicy` branch in `/devcycle:cycle` Step 7 and `/devcycle:continue`, documented in
`docs/superpowers/specs/2026-07-23-git-policy-reconciliation-design.md`.

## 2026-07-23 — superpowers dependency re-pinned to the official plugin directory

**Decision:** `plugin.json` declares `{ "name": "superpowers", "marketplace":
"claude-plugins-official" }` (with `allowCrossMarketplaceDependenciesOn:
["claude-plugins-official"]` in `marketplace.json`) instead of pinning obra's
`superpowers-marketplace`.
**Why:** superpowers is published in both marketplaces, but dependency satisfaction is
keyed on `name@marketplace`, not name — a user whose superpowers came from the official
directory left devcycle disabled with `dependency-unsatisfied` even though the plugin was
installed and enabled (reproduced in an isolated config). The official directory is
configured by default in every Claude Code install, so pinning it makes auto-install work
with zero marketplace setup; the schema has no "either marketplace" form, and a bare name
resolves inside the declaring plugin's own marketplace (fails). Known side effect: users
who installed superpowers from obra's marketplace get a second copy auto-installed —
both load; the README's Troubleshooting section covers deduping.
**Supersedes:** The `superpowers-marketplace` dependency pin shipped through v0.3.0 (from
the founding spec and v1 plan), and `docs/platform-notes.md`'s consequence note that
users must have `obra/superpowers-marketplace` configured for auto-resolution.

## 2026-07-23 — superpowers install: linked, not documented

**Decision:** The README links the [superpowers](https://github.com/obra/superpowers) repo
and tells users to install it per its own instructions; devcycle's docs never spell out
superpowers' install mechanics (marketplace-add command included).
**Why:** Another project's install commands may change; duplicating them here would rot
silently. The README instead names the expected symptom (devcycle shows "failed to load"
until superpowers is present) so the intermediate state reads as normal, not broken.
**Supersedes:** `docs/platform-notes.md` §(d)'s recommendation that the README tell users
to add the superpowers marketplace first, and `docs/dry-run-report.md` rough edge #1
("the README should carry step 3").

## 2026-07-23 — model options default to `auto`; an explicit id is binding

**Decision:** All four model options (`implementerModel`, `taskReviewerModel`,
`branchReviewModel`, `walkthroughModel`) default to `auto`: the coordinator derives the
model per task from plan-observable attributes and logs each derivation in the ledger. An
explicitly configured model id is binding — used verbatim, never overridden or
"improved on".
**Why:** Fixed default model ids rot as models change, and a "provisional lineup, propose
rerouting" rule was unenforceable prose. Derivation from observable predicates is
checkable after the fact; binding explicit ids keep the user's word final.
**Supersedes:** The fixed per-role default model ids shipped through v0.3.0, and the
skills' former deference to upstream's model-selection guidance for defaults.

## 2026-07-23 — first-run config walkthrough

**Decision:** When `/devcycle:cycle` starts with nothing configured, it offers one batched
walkthrough of the four behavioral options (`gitPolicy`, `reviewDepth`,
`crossModelReview`, `onDeviceGate`) with recommended defaults and a first-class "use
defaults, don't ask again" answer; choices are applied via `--config` so the offer
self-extinguishes. Model options are excluded (they default to `auto`).
**Why:** The literal-`${user_config.KEY}`-means-unset behavior is correct but invisible;
a one-time offer surfaces the knobs exactly once without making configuration a
prerequisite.
**Supersedes:** Nothing reversed — the silent documented-defaults path remains; this adds
the one-time offer in front of it.

## 2026-07-23 — red-team-reviewer wired into the panel; mechanical-sweep demoted to manual

**Decision:** The `red-team-reviewer` agent's adversarial charter is spliced into
`review-panel.js`'s per-finding verification pass, making the panel's "adversarially
re-verified" claim structurally true. `mechanical-sweep.js` is documented as a manual
utility — no pipeline stage invokes it.
**Why:** Both components were orphans: defined and documented as used, dispatched by
nothing. One earned its documented role by being wired in; the other's docs now match
reality instead of promising an integration that doesn't exist.
**Supersedes:** The README/DESIGN claim that `red-team-reviewer` is "used by execution and
the panel" (it is used by the panel only, and via charter splice rather than agent
dispatch) and any reading of `mechanical-sweep.js` as a pipeline component.

## 2026-07-22 — README: comprehension outranks brevity

**Decision:** The README is written for comprehension first — a reader should understand
what each stage and option actually does without opening other files — even where that
costs length.
**Why:** The pre-rewrite README was compact but assumed the pipeline's internal
vocabulary; evaluating the plugin required reading DESIGN.md and skill sources.
**Supersedes:** The earlier brevity-first README style (rewritten in v0.3.0, "docs:
rewrite README for comprehension").
