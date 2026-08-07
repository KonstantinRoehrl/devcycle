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

## Evidence discipline

- **No `file:line`, no finding.** "This could be a problem", "this pattern is often risky",
  "there may be more of these" are not findings. If it could not be pointed at in a file, it
  does not appear at all.
- Every finding rests on an actually-traced code path, never a pattern-match guess.
- Cross-reference the existing tests before flagging: if a test already exercises the
  concern, the finding is a test-coverage gap, not a live bug.

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
- Nothing to flag is stated explicitly; the findings section is never omitted instead.

## Ordering

- **Document form** (the audit's ranked list): Severity (desc) → Impact (desc) →
  Complexity (asc), keeping the severity tier grouping, so the reader gets a shortlist
  rather than a flat dump and the quickest high-value wins surface first inside a tier.
- **Machine form** (the panel's report): confirmed first, then severity, then file.

## Machine shape

`workflows/review-panel.js` owns the per-finding JSON shape — it declares the schema, prompts
the lenses with it, and coerces what comes back — so the shape is read there and not restated
here. How that shape carries the fields above: `verified` IS the Confidence field (`true` →
`verified`, `false` → `suspected`), and `claim` carries Title, What's wrong and Why it's wrong
in one to two sentences, symptom first. Unverified findings are marked, never dropped.
