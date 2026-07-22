# Comparison memo: reviewing-the-branch vs upstream superpowers

Compared against the live installed superpowers 6.1.1
(`~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.1/skills/requesting-code-review/`),
2026-07-22. Comparison target per the kickoff table: `superpowers:requesting-code-review`
(SKILL.md + its `code-reviewer.md` dispatch template). Expected relationship —
**replace/extend: panel workflow + read-only reviewer agents vs upstream's single-reviewer
template** — confirmed, with one nuance: upstream already carries part of the fresh-context
idea (see (c)1).

## (a) What upstream already covers — reference, do not duplicate

`superpowers:requesting-code-review` covers the *single-reviewer dispatch*:

- **Review cadence**: review early/often — after each task in subagent-driven development,
  after major features, before merge; optional when stuck or before refactors.
- **Dispatch mechanics**: capture a `BASE_SHA..HEAD_SHA` range, dispatch a fresh
  general-purpose subagent with "precisely crafted context for evaluation — never your
  session's history".
- **The reviewer prompt template** (`code-reviewer.md`): senior-reviewer framing; a
  read-only-review rule (never mutate the checkout; use a temporary worktree for other
  revisions); a full check catalogue (plan alignment, code quality, architecture, testing,
  production readiness); severity calibration guidance ("not everything is Critical",
  acknowledge strengths); a structured output contract (Strengths / Critical / Important /
  Minor / Recommendations / Assessment with a merge verdict).
- **Acting on feedback**: fix Critical immediately, Important before proceeding; push back
  with technical reasoning when the reviewer is wrong.

**What the single-reviewer template still covers in our design:** it remains the reference
prompt content for any single fresh-dispatch review — its check catalogue, severity
calibration, and read-only worktree discipline are exactly what a degraded single-engine
review needs. `reviewing-the-branch` references `superpowers:requesting-code-review` by name
for that content and does not restate it.

## (b) Our delta — the plugin skill's content

- **A pipeline gate, not a habit**: `reviewing-the-branch` is the mandatory whole-branch
  review stage between execution and finishing, with a P2 handoff block and the §4
  context-boundary action (review → on-device: fresh session). Upstream prescribes cadence
  but no pipeline placement.
- **Hybrid engine keyed to `userConfig.reviewDepth`** (design spec §2 item 9): `single`
  (default) → the built-in `code-review` skill plus this skill's spec-compliance layer;
  `panel` → `workflows/review-panel.js` (P6 contract: lens reviewers for spec compliance /
  correctness+security / simplification, per-finding adversarial verification, dedup,
  reconciler), invoked as `node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js"
  '<json-args>'` per `docs/platform-notes.md` (c). Upstream has one engine, always.
- **Graceful degradation as a first-class, disclosed path**: the built-in `code-review`
  skill is user-invocation-only in some environments, so a subagent reviewer may be unable
  to run it at all. When that happens the review runs on this skill's own instructions (plus
  upstream's referenced template content) and the report says so explicitly. Upstream never
  needs this because its template *is* its engine.
- **Spec-compliance layer**: review against the spec file on disk, not just the diff — a
  branch can be internally clean and still miss what the spec ordered. Upstream's
  `[PLAN_OR_REQUIREMENTS]` placeholder accepts a pasted summary; we require the file.
- **Findings loop**: findings → `devcycle:implementer` fixes (fresh dispatch) → re-review
  with the same engine, until no blocking findings. Upstream's verdict is one-shot.
- **Engine named in the report**: the report states which engine actually ran (including
  degraded runs), so a skill-less review can never masquerade as an engine run.
- **Config/model routing**: `branchReviewModel`, `crossModelReview` (extra panel lens), and
  the unset-placeholder default rule from `docs/platform-notes.md` (a).
- **Plain-language findings** (§12.5): symptom first, mechanism second.

## (c) Conflicts and resolutions

1. **Fresh context: economy vs bias control.** Upstream keeps the reviewer free of "your
   session's history" mainly to focus the reviewer and preserve the coordinator's context.
   The dossier §4 boundary is stricter and differently motivated: a reviewer that watched
   the code being written inherits the implementer's assumptions, so the branch review MUST
   run in fresh context (fresh subagents or a cleared session) receiving only branch, spec
   path, and ledger path. **Resolution:** adopt the stricter form as a hard gate; upstream's
   crafted-context practice is the compatible mechanism, not a conflict in direction.
2. **Review target: pasted requirements vs the spec file.** Upstream reviews a SHA range
   against whatever text fills `[PLAN_OR_REQUIREMENTS]`. **Resolution:** the spec path is
   always passed and the reviewer reads the file itself; a summary is never a substitute.
3. **Verdict model: one-shot vs loop.** Upstream ends at "Ready to merge? Yes / No / With
   fixes". **Resolution:** the verdict feeds the findings loop — "fixes required" always
   triggers implementer fixes and a re-review; the gate closes only on a clean re-review.
4. **Which engine when `code-review` exists.** Upstream's template predates the built-in
   `code-review` skill and would compete with it on the single path. **Resolution:** when
   the environment can invoke `code-review`, it supersedes the template as the single-path
   engine (with our spec-compliance layer on top); the template's content is the referenced
   fallback for degraded runs.

Real delta confirmed — the skill is built.
