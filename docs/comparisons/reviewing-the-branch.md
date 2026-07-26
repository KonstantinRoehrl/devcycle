# Comparison memo: reviewing-the-branch vs upstream superpowers

Upstream baseline: `superpowers/6.1.1/skills/requesting-code-review/` (SKILL.md + its
`code-reviewer.md` dispatch template) from the plugin cache, read 2026-07-22. Memo
refreshed 2026-07-26 for the profile split. 6.2.0 is now installed alongside 6.1.1; the
upstream content this memo relies on (the dispatch template, its read-only/worktree rule,
its severity calibration, and the `{PLAN_OR_REQUIREMENTS}` placeholder) was spot-checked
and still holds there, but the memo has not been fully re-derived against it.

Expected relationship per the kickoff table — **replace/extend: panel workflow +
read-only reviewer agents vs upstream's single-reviewer template** — confirmed, with the
nuance that upstream already carries part of the fresh-context idea (see (d)1).

## Engine per profile

This skill has **no overlay/native switch**: it never loads an upstream skill, and it
references `superpowers:requesting-code-review`'s reviewer guidance at every profile as
part of the `single` engine. What the profile changes is which engine runs by default and
how many rounds the findings loop gets.

| profile | default `reviewDepth` | engine | upstream guidance in play | round cap |
| --- | --- | --- | --- | --- |
| `lean` | `single` | this skill's spec-compliance layer + upstream reviewer guidance | yes | 2 |
| `standard` | `single` | same | yes | 3 |
| `thorough` | `panel` | `workflows/review-panel.js` | only if the panel degrades to `single` | 5 |

An explicitly configured `reviewDepth` wins verbatim over the profile column, so a `lean`
run can be pinned to `panel` and a `thorough` run to `single`; the profile only supplies
the default. Resolution order and the model tiers come from `references/config.md`.

## (a) Upstream's share — referenced, never restated (at every profile)

`superpowers:requesting-code-review` covers the *single-reviewer dispatch*:

- **Review cadence**: review early and often — after each task in subagent-driven
  development, after major features, before merge.
- **Dispatch mechanics**: capture a `BASE_SHA..HEAD_SHA` range and dispatch a fresh
  subagent with "precisely crafted context for evaluation — never your session's history".
- **The reviewer prompt template** (`code-reviewer.md`): senior-reviewer framing; a
  read-only-review rule (never mutate the checkout; use a temporary worktree for other
  revisions); a full check catalogue (plan alignment, code quality, architecture, testing,
  production readiness); severity calibration ("not everything is Critical", acknowledge
  strengths); a structured output contract.
- **Acting on feedback**: fix Critical immediately, Important before proceeding; push back
  with technical reasoning when the reviewer is wrong.

That content is exactly what a single fresh-dispatch review needs, so the skill names
`superpowers:requesting-code-review` for it and does not restate it — on the `single` path
at any profile, and on a `panel→single` fallback at `thorough`.

## (b) Our delta

Unless a line says otherwise, it holds at every profile.

- **A pipeline gate, not a habit.** This is the mandatory whole-branch review stage between
  execution and finishing, with its inputs deliberately limited to the branch, the spec
  path, and the ledger path, and with a handoff block and the branch-review → on-device
  context action. Upstream prescribes cadence but no pipeline placement.
- **Profile-keyed hybrid engine.** `reviewDepth` resolves per the table above:
  `single` → this skill's spec-compliance layer plus upstream's reviewer guidance;
  `panel` → `workflows/review-panel.js` (lens reviewers for spec compliance /
  correctness + security / simplification, per-finding adversarial verification, dedup,
  reconciler), invoked as a single JSON argv per `docs/platform-notes.md` (c), with the
  JSON report on stdout and progress on stderr. Upstream has one engine, always.
- **The built-in `code-review` skill is never the engine.** It is user-invocation-only in
  current Claude Code — an agent cannot launch it — so no review is ever planned around it.
  It folds in opportunistically: if the user has run it on the branch independently, its
  findings join this review and the engine is recorded as `single + user-run code-review`.
  (This corrects the earlier design assumption that `single` meant "the built-in
  `code-review` skill plus a spec layer".)
- **Graceful degradation as a first-class, disclosed path.** When `review-panel.js` is
  missing or exits non-zero, the panel engine is unavailable — an exit code of 1 means the
  panel failed, never that findings exist, and it is never a verdict. The stage falls back
  to the full `single` engine and says so as `panel→single (panel unavailable: <reason>)`.
  A fallback presented silently as a panel run would make the gate unauditable.
- **Engine named in the report, from a closed set of five values** (`single`,
  `single + user-run code-review`, `panel`, `panel [+ cross-model lens]`,
  `panel→single (panel unavailable: <reason>)`), so a degraded run can never masquerade as
  an engine run.
- **Spec-compliance layer.** Review against the spec FILE, not just the diff: enumerate
  what it requires and forbids, check every requirement against the branch as a whole, file
  findings both for what the spec ordered and the branch lacks and for what the branch does
  that the spec never asked for, and cross-check the ledger against what is actually on the
  branch. Upstream's `{PLAN_OR_REQUIREMENTS}` placeholder accepts a pasted summary; we
  require the file.
- **Findings loop bounded by the profile's round cap.** Round 1 reviews the whole branch;
  only blocking findings re-open the loop, each going to a fresh `devcycle:implementer`
  dispatch briefed with the finding and the spec path, never the review conversation;
  rounds 2..N are narrow, re-running the same engine over the fix diff plus a re-check of
  the previous round's findings. Non-blocking findings become carry-overs and never consume
  a round. Upstream's verdict is one-shot.
- **The cap bounds effort, never truth** — unconditional, at every profile and every cap
  value. Reaching the cap never converts an outstanding blocking finding into a pass, and a
  finding is never downgraded in severity to close the loop faster. At the cap there are
  exactly two terminal states: no blocking findings outstanding → `pass` with carry-overs,
  or blocking findings outstanding → `fixes-required`, which stops the stage for a user
  decision and hands off to neither on-device nor finishing.
- **A handoff even on `fixes-required`.** The stop IS the stage result: the block is
  emitted with the outstanding findings as carry-overs and `stage: branch-review` kept in
  `.devcycle/state.md` so the cycle resumes here.
- **Config and model routing** through `references/config.md` — `branchReviewModel`,
  `crossModelReview`, and the unset-placeholder rule — plus one panel-specific mechanic:
  when `branchReviewModel` resolves to an explicit id it is exported as
  `DEVCYCLE_PANEL_MODEL` before invoking the panel, since omitting it would silently
  replace the user's binding choice with the CLI default.
- **Producer-side routing of the next stage's model.** The handoff carries
  `Start the fresh session on <model>` (resolved from `walkthroughModel`) because the
  on-device session's model is chosen by whoever launches it — an instruction inside that
  session would arrive too late.
- **Plain-language findings**: symptom first, mechanism second.

## (c) Conflicts and resolutions

All four are live wherever upstream's guidance is in play — the `single` path at any
profile, and a `panel→single` fallback. devcycle's side of each resolution is
unconditional.

1. **Fresh context: economy vs bias control.** Upstream keeps the reviewer free of "your
   session's history" mainly to focus the reviewer and preserve the coordinator's context.
   devcycle's boundary is stricter and differently motivated: a reviewer that watched the
   code being written inherits the implementer's assumptions and reviews the intention
   instead of the code. **Resolution:** adopt the stricter form as a hard gate — reviewers
   receive only the branch, spec path, and ledger path, and a coordinator carrying
   implementation context dispatches fresh reviewers rather than reviewing directly.
   Upstream's crafted-context practice is the compatible mechanism, not a conflict in
   direction.
2. **Review target: pasted requirements vs the spec file.** Upstream reviews a SHA range
   against whatever text fills `{PLAN_OR_REQUIREMENTS}`. **Resolution:** the spec path is
   always passed and the reviewer reads the file itself; a summary is never a substitute.
3. **Verdict model: one-shot vs loop.** Upstream ends at "Ready to merge? Yes / No / With
   fixes". **Resolution:** the verdict feeds the bounded findings loop — blocking findings
   always trigger implementer fixes and a re-review, and the gate closes only on a round
   that leaves none outstanding, or stops at the cap as `fixes-required`.
4. **Which engine, given the built-in `code-review` skill.** Upstream's template predates
   that skill and would appear to compete with it on the single path. **Resolution,
   changed 2026-07-26:** there is no competition, because an agent cannot launch
   `code-review` at all. Upstream's template content *is* the reviewer guidance of the
   `single` engine, at every profile; `code-review` contributes only as an opportunistic
   fold-in of a pass the user ran themselves.

**Verdict:** real delta confirmed at every profile. The skill is devcycle-native
throughout — it references upstream for reviewer guidance rather than overlaying it — and
the profile moves only the default engine, the round cap, and nothing about the gate's
honesty.
