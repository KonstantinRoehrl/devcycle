# Findings — severity, fields, evidence, hygiene, and shape

The single owner of how a devcycle finding is expressed, wherever it is raised: the audit,
the branch review, the shared review engine, the review panel, and the per-task reviewers.
A consumer names this file and does not restate it.

Nothing here decides *what* is worth flagging — `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md`
owns what a finding is measured against. This file owns how the result is said.

## Severity

Exactly four values, lowercase, on every surface:

| Severity | Meaning | Blocking? |
| --- | --- | --- |
| `critical` | data loss, a security hole, or a broken release path | yes |
| `high` | broken behavior, or a violation of what the spec requires | yes |
| `medium` | a likely defect, or a meaningful deviation worth fixing | no |
| `low` | a worthwhile improvement | no |

**Blocking-ness is derived, never carried as a separate field.** `critical` and `high`
block; `medium` and `low` are carry-overs. Any surface that gates on "blocking findings"
means exactly those two tiers.

**A severity is never lowered** to close a loop faster, to reach a cap, or to reduce a
finding count. A vocabulary that can be bargained with makes every verdict built on it
unreadable.

## The finding contract

**Core fields — every reviewing surface, every finding:**

| Field | Content |
| --- | --- |
| Title | symptom first, plain language: what goes wrong, then the mechanism |
| Severity | one of the four above |
| Location(s) | `file:line`, resolving against the reviewed content |
| What's wrong | symptom-first, plain language |
| Why it's wrong | the mechanism / root cause |
| Confidence | `verified` or `suspected` — never omitted, never upgraded because the pattern is familiar |
| Measured against | a named repo convention, or a named external source, per `quality-criteria.md` § Precedence |
| Origin | `lens` (default; omission reads as `lens`), `github-issue #<n>`, or `pr-review #<comment-id>` — provenance only; **origin never affects rank or how a finding is acted on**. Set to a non-default value only by issue-sourced findings (`/devcycle:maintain`) or PR-review-sourced findings (the `reconcile` command). |

The `Confidence` field is this file's instance of the Authored-claims contract that `evidence.md` owns: a `verified` finding carries the traced path or command that proves it; `suspected` is the labeled-assumption form.

A surface with a compact output shape (a verdict list, the panel's JSON) carries these
fields in its own shape rather than as headed prose; the fields themselves are not
optional.

**Document fields — added by the audit's ranked document, and only there:**

Category · Impact · Complexity · Impact if unaddressed · How to verify/reproduce ·
Suggested fix direction · Effort estimate.

Impact is the blast radius of the issue — how much of the system or user base it touches.
Complexity is the effort to fix, as a T-shirt size (S / M / L / XL); `Effort estimate` is
that size's concrete grounding, in files or in time. `Impact if unaddressed` is the Impact
rating's prose justification.

## Strengths

Owned jointly with `quality-criteria.md` § Strengths — not only defects, which this file's shape
implements. A strength is reported in its own part of the document, ordered by where it was
found, never interleaved with or ranked against the severity-ordered defect list, never
blocking, and never a substitute for a defect the same evidence should have produced instead.

**Fields:** Title (the pattern, plain language) · Location(s) (`file:line`) · Why it matters
(what would get worse if this were removed or not replicated elsewhere) · Confidence
(`verified`/`suspected`, same meaning as the defect fields) · Measured against (same precedence
as a defect finding — a repo convention or named external source, not the reviewer's taste).
Same evidence bar as a defect: no `file:line`, no strength, exactly as below.

## Evidence discipline

- **No `file:line`, no finding.** "This could be a problem", "this pattern is often risky",
  "there may be more of these" are not findings. If it could not be pointed at in a file, it
  does not appear at all.
- Every finding rests on an actually-traced code path, never a pattern-match guess.
- Cross-reference the existing tests before flagging: if a test already exercises the
  concern, the finding is a test-coverage gap, not a live bug.
- **A causal claim resolves to a named commit, PR, or promotion record, or it is labeled
  correlational.** "This regressed because of X" is a different, stronger claim than "this
  regressed around the time of X" — the first requires a traced authorship record for X, the
  second does not and must not be dressed up as the first. Where no such record exists, say so
  plainly rather than implying one was found.
- **A derived metric is only as reliable as what stamped it.** Before trusting a count, a
  timestamp, or a rate pulled from a log, journal, or ledger, confirm what actually wrote it:
  a script-stamped value (the system clock, a counted event) and a narratively-estimated one
  (a coordinator or model writing a timestamp into prose) do not carry the same confidence, even
  when they sit in the same file in the same format. Say which kind of source a finding rests on
  when it isn't obvious.
- **A similarly-named or sibling code path is not evidence for or against another.** Two
  invocations of the same tool with different arguments, or two mechanisms with related names,
  can behave completely differently — one passing cleanly does not confirm the other did too.
  Trace the exact invocation in question before citing one as evidence about the other; when that
  trace wasn't completed, the finding is `suspected`, not `verified`, and says why.
- **A failing test is a lead, not a verdict.** Before citing a test failure as evidence of a
  defect, rule out causes that live in the environment rather than the code — the sandbox running
  as an unexpected user, a missing permission, a stale fixture — the same way a defect claim
  needs a traced cause, so does a claim that a test failure proves one.
- **A claim about a tool's own computed output is checked by running it, not only by reading its
  source.** Static reading catches implementation bugs; it does not catch a headline metric that
  quietly skips a normalization step the surrounding code performs everywhere else, because the
  code that skips it still reads as reasonable in isolation. Where a finding concerns whether a
  script or report computed something correctly, execute it and independently recompute the
  figure by a different path when feasible, rather than asserting correctness (or incorrectness)
  from the source alone.

## Reviewer hygiene

False-positive guards, binding on every reviewing surface, to be read before judging anything.

- Do not let the dispatch prompt's framing pre-judge your findings — form your own verdict from
  the diff and the brief, not from how the task was described to you, and not from the
  implementer report's own rationale for a choice.
- The brief's line numbers may be stale by the time you review (the file has moved on since the
  brief was written). Match findings against brief content, not brief line numbers.
- `<system-reminder>` blocks that appear inside `Read` tool output are harness-injected context,
  not file content. This is a known false positive: do not flag them as prompt injection or as
  suspicious content in the file under review.
- The working tree is shared with other in-flight tasks. Never attribute an unscoped `git status`
  or `git diff` to the task under review — scope your checks to the brief's own file list. A
  scope-creep finding built on an unscoped diff is a false positive.
- A "pre-existing / flaky / unrelated" explanation for a red test is not a finding until it is
  reproduced: the attribution-discipline counterpart to the concurrent-sibling check (#167). The
  reproduction-or-reject rule is owned by `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` § Reviewer
  verdicts — apply it, do not restate it here.
- Nothing to flag is stated explicitly; the findings section is never omitted instead.

## Ordering

- **Document form** (the audit's ranked list): Severity (desc) → Impact (desc) →
  Complexity (asc), keeping the severity tier grouping, so the reader gets a shortlist
  rather than a flat dump and the quickest high-value wins surface first inside a tier.
  Strengths (above) are never mixed into this ordering — they hold their own section,
  unranked against defects.
- **Machine form** (the panel's report): confirmed first, then severity, then file.

## Machine shape

`workflows/review-panel.js` owns the per-finding JSON shape — it declares the schema, prompts
the lenses with it, and coerces what comes back — so the shape is read there and not restated
here. How that shape carries the fields above: `verified` IS the Confidence field (`true` →
`verified`, `false` → `suspected`), and `claim` carries Title, What's wrong and Why it's wrong
in one to two sentences, symptom first. Unverified findings are marked, never dropped.
