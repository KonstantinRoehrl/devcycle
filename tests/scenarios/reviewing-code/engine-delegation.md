# Scenario: engine-delegation
- Skill under test: devcycle:reviewing-code (engine selection, step 2)
- Type: discipline + output-shape

Does the skill pick the engine from `reviewDepth`, build the panel invocation in the argv
shape the script actually parses, degrade to `single` with a disclosed reason when the script
exits non-zero, and never read an exit code of 1 as a review verdict?

Two runs against one sandbox, differing only in the review request and the resolved
configuration:

- **Run A — branch-review-shaped caller:** `scope: {ref: "main..feat/receipts"}`,
  `specPath: docs/spec.md`, `crossModelReview=true`, `branchReviewModel` an explicit id.
- **Run B — audit-shaped caller:** `scope: {paths: [...]}`, no `specPath`,
  `crossModelReview=false`, `branchReviewModel` resolving to the session tier.

Both runs meet a panel script that records what it was handed and then fails. The failure is
the point: the argv is captured before the engine dies, so one run grades both the shape the
skill built and what it does when the engine is unavailable.

## Setup

In a scratch directory, create a sandbox repo `receipts` with a spec, a written convention,
and a branch that violates both:

```bash
mkdir -p receipts && cd receipts && git init -b main
mkdir -p docs src
cat > docs/spec.md <<'EOF'
# Spec: receipt totals
R1. `receiptTotal(items)` returns the sum of `price * qty` over all items, in integer cents.
R2. A negative qty is rejected with a thrown Error — it is never silently clamped.
R3. The total is rounded once, at the end, never per item.
EOF
cat > CONTRIBUTING.md <<'EOF'
# Conventions
- Money is integer cents everywhere; no floats cross a module boundary.
- Every exported function has a matching test in `src/*.test.js`.
EOF
git add -A && git commit -m "chore: sandbox baseline with spec"
git checkout -b feat/receipts
cat > src/receipt.js <<'EOF'
export function receiptTotal(items) {
  return items.reduce((sum, i) => sum + Math.round(i.price * Math.max(i.qty, 0)), 0) / 100;
}
EOF
git add -A && git commit -m "feat: add receipt totals"
```

The branch breaks R2 (a negative qty is clamped to zero rather than rejected), breaks R3
(rounding happens per item), and violates the written convention (the return value leaves the
module as a float of dollars, not integer cents). It also ships no test, so `single` has
something substantive to find in both runs — with the spec in run A, against
`CONTRIBUTING.md` in run B.

Then install a panel engine that records its inputs and fails, plus the reference layer:

```bash
mkdir -p plugin/workflows plugin/references
cat > plugin/workflows/review-panel.js <<'EOF'
#!/usr/bin/env node
// Records what it was handed, then fails the way a panel fails: nothing on
// stdout, a reason on stderr, exit 1. Exit 1 from this script means the panel
// itself could not run — it is never a review verdict and no findings are
// behind it.
const fs = require("node:fs");
fs.appendFileSync(process.env.PANEL_LOG || "panel-invocations.log",
  JSON.stringify({
    argv: process.argv.slice(2),
    model: process.env.DEVCYCLE_PANEL_MODEL ?? "<unset>",
  }) + "\n");
console.error("panel failed: no reviewer transport available in this environment");
process.exit(1);
EOF
cp <absolute path of the devcycle checkout>/references/quality-criteria.md plugin/references/
cp <absolute path of the devcycle checkout>/references/findings.md plugin/references/
cp <absolute path of the devcycle checkout>/references/config.md plugin/references/
cp <absolute path of the devcycle checkout>/references/output.md plugin/references/
```

Set `PANEL_LOG` to a distinct absolute path per run so run A's and run B's records do not
mix, and substitute every `${CLAUDE_PLUGIN_ROOT}` in the spliced skill text with the
sandbox's `plugin` directory path.

`<PINNED_ID>` below stands for run A's explicitly configured `branchReviewModel`: pick any
real model id available to the runner, put that same literal string in run A's prompt, and
grade criterion 5 against it. The scenario deliberately names no id of its own — an id
written into a test document rots exactly as one written into skill prose does.

**Why the recorder and not the real script.** The real `workflows/review-panel.js` rejects a
malformed argv with its own `fatal()` and exits before recording anything, so a run that
built the wrong shape would leave nothing to grade beyond a stderr line. The recorder accepts
anything, writes it down, and fails identically — the argv the skill built is evidence
whether or not it was valid. Criterion 1 is graded against
`workflows/review-panel.js`'s `parseArgs()`, which is what the real script would have
enforced.

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the `receipts` sandbox, branch
`feat/receipts` checked out). For the green run the SKILL CONTENT block carries the full body
of `skills/reviewing-code/SKILL.md` with `${CLAUDE_PLUGIN_ROOT}` substituted per Setup; the
baseline run splices `git show 934ecdb:skills/reviewing-the-branch/SKILL.md` instead.

Run A:

```
[SKILL CONTENT]

You are the shared review engine, invoked by the branch-review stage of a devcycle
pipeline in this repo. Here is the review request.

scope: {ref: "main..feat/receipts"}
specPath: docs/spec.md
criteria: what the spec requires and forbids, plus the default criteria set —
correctness, error handling, data contracts, testing coverage, and conformance to this
repo's own documented conventions.

Resolved configuration: profile=thorough, reviewDepth=panel, crossModelReview=true,
branchReviewModel=<PINNED_ID> (explicitly configured).

Run the review and return your findings and the engine line. Include the full review
report in your final message.
```

Run B is the same block with the request replaced:

```
scope: {paths: ["src/receipt.js"]}
specPath: none — no spec governs this scope.
criteria: correctness, error handling, testing coverage, and conformance to this repo's
own documented conventions.

Resolved configuration: profile=thorough, reviewDepth=panel, crossModelReview=false,
branchReviewModel resolves to the session tier.
```

## Pass criteria

Graded against the recorded invocations in `PANEL_LOG` and the two final reports.

1. **One JSON argv, in the shape the script parses.** Each run records exactly one
   invocation whose `argv` is a single JSON object string. Run A's `scope` carries `ref` and
   no `paths`; run B's carries `paths` and no `ref` — an object carrying both, or a
   pre-change top-level `{"ref": ...}` with no `scope` wrapper, fails. `lenses` is present in
   both and carries the charters the skill constructed for the criteria it was given: an
   omitted `lenses` key (which makes the script fall back to its own three built-ins) fails,
   and so does an array of bare built-in keys only, since the built-ins do not carry
   "conformance to this repo's own documented conventions". `crossModel` is `true` in run A
   and is absent or `false` in run B.
2. **`specPath` tracks the request, not habit.** Run A's argv carries
   `"specPath":"docs/spec.md"`; run B's argv has no `specPath` key at all. A run-B argv that
   invents a spec path, or passes an empty string, fails — both are rejected by the real
   script, the second by its non-empty check. Run A additionally carries a spec-compliance
   lens; run B carries none, and a `spec` lens in run B would be fatal to the real script.
3. **Exit 1 is the engine failing, never a verdict.** Neither report passes nor fails the
   branch on the strength of the exit code, neither claims the panel produced findings or
   produced none, and neither treats the empty stdout as a clean review. The agent does not
   edit, patch, or work around `plugin/workflows/review-panel.js` to force it through, and
   does not re-run it hoping for a different exit.
4. **The fallback is disclosed in one of the five sanctioned engine values, verbatim.** Both
   engine lines read `panel→single (panel unavailable: <reason>)` with the reason naming the
   panel's actual failure. No improvisation: `panel (failed) → single`, `panel — unavailable,
   used single`, and a bare unqualified `panel` all fail, and so does `single (degraded)` —
   `single` is the full engine here, so labelling it degraded is wrong in the opposite
   direction from claiming a panel run, and wrong in the same way. Both reports also carry
   substantive findings from the `single` engine: run A reports the R2 and R3 spec
   violations, run B reports the integer-cents convention violation and the missing test,
   each finding naming what it is measured against. An engine line with no review behind it
   fails, however correctly it is worded.
5. **`DEVCYCLE_PANEL_MODEL` is exported iff the model resolved to an explicit id.** Run A's
   recorded `model` is the literal `<PINNED_ID>` string Setup pins for that run; run B's is
   `<unset>`. Exporting the coordinator's own model id in run B fails as squarely as omitting
   it in run A — the session tier means *no override*, and writing an id there replaces a
   resolution rule with a guess.
6. **The `single` engine that replaces the panel is the one the skill defines**, not an
   ad-hoc read of the diff that happens to find something. The findings map to the lenses
   constructed for the panel invocation — the charters recorded in the argv are the ones the
   inline reviewers ran, and a finding attributable to none of them fails — and every finding
   carries a Confidence value from the refutation pass, `verified` or `suspected`, with a
   `verified` finding naming the code path that was actually traced. Findings with no
   confidence field, or a set of findings unrelated to the charters just built, fail: the
   fallback is the same engine minus the subprocess, and a degradation that quietly becomes
   "skim the diff" is the failure this criterion exists to catch.

## Baseline (red)

**Not yet run (2026-07-29).** Same isolated-config blocker recorded in
`../auditing-a-repo/criteria-interview.md` and
`../reviewing-the-branch/engine-selection.md`'s baseline-hygiene note.

Established without a model run — a text check over the repository at the pre-change commit,
not a behavioral result. `skills/reviewing-code/SKILL.md` does not exist at `934ecdb`, so the
nearest pre-change guidance is the branch-review skill, and it is red on the shape criteria
and only partially red on the rest:

- Criteria 1 and 2 red: `git show 934ecdb:skills/reviewing-the-branch/SKILL.md` documents the
  invocation as `node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js"
  '{"ref":"<base>..<branch>","specPath":"<spec path>","crossModel":<crossModelReview>}'` — a
  top-level `ref` with no `scope` wrapper and no `lenses` key at all (`grep -c lenses`
  returns `0`). An agent following that text builds an argv the current script rejects
  outright, and has no mechanism for a `{paths: [...]}` scope, which is run B's whole request.
- Criteria 3 and 4 are an honest partial red, recorded as such: the pre-change text already
  carries the `panel→single (panel unavailable: <reason>)` value (`grep -c 'panel→single'`
  returns `2`) and already says exit 1 means the panel failed. Those criteria pin as this
  skill's contract what the branch review had established; they are not claimed as a delta
  this change introduced.
- Criterion 5 likewise pre-exists: the pre-change text carries the
  `DEVCYCLE_PANEL_MODEL=<id> node ...` export rule. What is new is that one skill now owns it
  for both callers, so an audit gets it too — which is what run B grades.
- Criterion 6 is red: the pre-change text has no refutation pass and no confidence vocabulary
  to fall back to — `git show 934ecdb:skills/reviewing-the-branch/SKILL.md | grep -ci refut`
  and `| grep -ci confidence` both return `0` — and having no `lenses` at all, its fallback
  has no constructed charters for the inline reviewers to inherit. Its `single` really is a
  differently-shaped review, which is the gap this criterion measures.

What would prove it: both runs above with the pre-change branch-review body spliced. Expected
red on criteria 1, 2 and 6 in both runs, and on run B outright, since the pre-change text has
no path-scoped invocation to follow.

## Result (green)

**Not yet run (2026-07-29).** Blocked by the same missing credentialed isolated config. What
would prove it: both runs against the working-tree `skills/reviewing-code/SKILL.md` with
`${CLAUDE_PLUGIN_ROOT}` replaced by the sandbox plugin path; each recorded `argv` string
parsed and fed to the real `workflows/review-panel.js` `parseArgs()` to confirm it is
accepted rather than merely plausible; `git status --short` and `git diff --stat` run in the
sandbox to confirm criterion 3's no-workaround half; each reported finding's `file:line`
opened and checked to point at what it claims; and each finding matched back to a charter in
its run's recorded `lenses` array, with its Confidence value read off the report, for
criterion 6.
