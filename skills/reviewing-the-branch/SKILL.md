---
name: reviewing-the-branch
description: Use when a plan's implementation is complete and committed and the branch needs its whole-branch review gate before finishing.
---

# Reviewing the Branch

The whole-branch review gate between execution and finishing: one review of
everything the branch does, against the spec that ordered it, before the
pipeline moves on to on-device verification or finishing.

**Inputs** (from the execution handoff / `.devcycle/state.md`): the branch,
the spec file path, the ledger path (`.superpowers/sdd/progress.md`). These
three are ALL the review needs — deliberately (see fresh context below).
One further read serves the handoff, not the review: the `checklist:` line
of `.devcycle/state.md`, which this stage's own handoff carries forward.

## Configuration

- reviewDepth: `${user_config.reviewDepth}` (allowed `single` | `panel`; default `single`)
- crossModelReview: `${user_config.crossModelReview}` (default `false`)
- branchReviewModel: `${user_config.branchReviewModel}` (a model id, or `auto`; default `auto`)

A value that still reads as a literal `${user_config...}` placeholder is
unset — use its default. A value outside its allowed set is invalid — use
its default.

branchReviewModel resolves three ways: an explicit model id is binding —
use it verbatim, no second-guessing; the value `auto` OR a literal
placeholder means derive the model here. The derived branch-review model is
the first available of: `claude-opus-4-8`, then `claude-sonnet-5`. The
resolved model (explicit or derived) is what every rule below means by
"the branch-review model".

## Fresh context (bias control — non-negotiable)

A reviewer that watched the code being written inherits the implementer's
assumptions and reviews the intention instead of the code. The branch review
MUST run in fresh context:

- Reviewers receive ONLY the branch, the spec path, and the ledger path —
  never the implementation conversation, task reports, or implementer
  reasoning.
- If you carry implementation context yourself, do not review the branch
  directly: dispatch fresh reviewer subagents (model: the resolved
  branch-review model) and act on their findings.

## Engine selection (keyed to reviewDepth)

**reviewDepth = `single` (default):** run the built-in `code-review` skill
against the branch, then layer the spec-compliance review (below) on top of
its findings.

**reviewDepth = `panel`:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '{"ref":"<base>..<branch>","specPath":"<spec path>","crossModel":<crossModelReview>}'
```

Args are a single JSON argv. The JSON report is the panel's stdout ONLY —
progress output goes to stderr — with `findings` (file, line, claim,
severity, lens, verified, verification) plus `summary`. An exit code of 1
means the panel itself failed, NOT that findings exist: treat it as engine
unavailability (degrade, below), never as a review verdict. The panel runs
2–3 read-only lens reviewers (spec compliance, correctness + security,
simplification) with per-finding adversarial verification; it never mutates
files or git. Pass `"crossModel": true` only when the crossModelReview
option is true. Always export the resolved branch-review model before
invoking — explicit id and derived id alike, never omit the export:
`DEVCYCLE_PANEL_MODEL=<resolved model> node ...`. Omitting it would
silently replace the derived model with the CLI's default.

**Graceful degradation — a first-class path, not an apology.** The built-in
`code-review` skill is user-invocation-only in some environments, so a
reviewer may be unable to run it at all. When `code-review` cannot be
invoked (or `review-panel.js` is missing or exits non-zero), run the review
using this skill's spec-compliance layer plus the reviewer guidance of
`superpowers:requesting-code-review` (severity calibration, read-only
review, structured findings) — and state the degradation explicitly in the
report's engine line. A skill-less review silently presented as an engine
run makes the gate unauditable; the disclosure is what keeps it honest.

## Spec-compliance layer

Review against the spec FILE, not just the diff:

1. Read the spec file; enumerate what it requires and what it forbids.
2. Check every requirement against the branch as a whole, not only the
   changed lines.
3. File findings for anything the spec asks for that the branch does not
   deliver, and anything the branch does that the spec never asked for.
4. Cross-check the ledger: every task it records as committed must actually
   be on the branch, and nothing on the branch should lack a ledger trail.

A branch can be internally clean — tests green, tidy diff — and still fail
its spec: passing tests prove the code does what the tests say, not what
the spec says.

## Findings loop

Findings → implementer fixes → re-review:

1. Blocking findings go to a fresh `devcycle:implementer` dispatch (brief =
   the finding plus the spec path; never the review conversation).
2. After fixes are committed, re-run the SAME engine on the updated branch.
3. Loop until a review returns no blocking findings. Never close the gate
   on "fixed" without a re-review; never downgrade a finding to close the
   loop faster.

## Review report (REQUIRED shape)

```markdown
## Branch review report
- Engine: <single: code-review + spec-compliance | single (degraded): code-review unavailable, ran this skill's own review instructions | panel: review-panel.js [+ cross-model lens]>
- Branch: <base>..<branch>
- Spec: <path>
- Findings:
  1. [severity] <symptom first, plain language — what goes wrong, then the mechanism>
- Verdict: pass | fixes-required
```

The engine line records what actually ran — a degraded run says so here.
Findings in plain everyday language, symptom first; jargon only where it
adds precision.

## Handoff

When the gate passes, update `.devcycle/state.md` — set `stage: on-device`
(the stage the next session resumes at) — then end with the pipeline
handoff block:

```markdown
## Handoff
- Stage completed: branch-review
- Artifacts: <review report location, branch>
- Carry-overs: <accepted non-blocking findings, or "none">. Start the fresh session on <model>.
- Context action: Fresh session
- Compaction hint: Keep checklist path and branch. Drop all review and implementation context.
```

The `Start the fresh session on <model>` line is this stage's job because
the on-device session's model is chosen by whoever launches it — an
instruction inside that session would arrive too late. `<model>` is the
walkthroughModel option when it names an explicit model id (binding);
otherwise (value `auto` or a literal placeholder) `claude-sonnet-5`.

When the state file records `checklist: none` (no rendered surface produced
a checklist), the compaction hint becomes: Keep `checklist: none — on-device
stage will judge applicability` and the branch.

Per the pipeline's context table, review → on-device runs in a fresh
session carrying only the checklist line and the branch.

This stage's block is emitted at this stage's end even when the pipeline
continues past it in the same response or session (on-device and finish
completing in one go): every stage emits its own `## Handoff` block —
never merged into, or replaced by, a later stage's block.
