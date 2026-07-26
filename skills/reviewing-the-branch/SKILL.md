---
name: reviewing-the-branch
description: Use when a plan's implementation is complete and committed and the branch needs its whole-branch review gate before finishing.
---

# Reviewing the Branch

The whole-branch review gate between execution and finishing: one review of
everything the branch does, against the spec that ordered it, before the
pipeline moves on to on-device verification or finishing.

**Inputs** (from the execution handoff / `.devcycle/state.md`): the branch,
the spec file path, the ledger path (`.devcycle/ledger.md`). These three are
ALL the review needs — deliberately (see fresh context below). One further
read serves the handoff, not the review: the `checklist:` line of
`.devcycle/state.md`, which this stage's own handoff carries forward.

This stage, and every agent it dispatches, reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Configuration

Resolve every knob and the profile per `${CLAUDE_PLUGIN_ROOT}/references/config.md`:

- `reviewDepth` — `${user_config.reviewDepth}`, allowed `single` | `panel`.
  Whatever it resolves to picks the engine in "Engine selection" below.
- `crossModelReview` — `${user_config.crossModelReview}`, default `false`.
- `branchReviewModel` — `${user_config.branchReviewModel}`. What it resolves to
  (an explicit model id, binding; or the session tier) is what every rule below
  means by "the branch-review model".
- The **round cap** for the findings loop is the profile's branch-review round
  cap, read from that file's matrix.

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

**reviewDepth = `single`:** this skill's spec-compliance layer (below) plus the
reviewer guidance of `superpowers:requesting-code-review` — severity-calibrated
findings (critical / important / minor), read-only review of the work product,
structured findings, and precisely crafted reviewer context rather than session
history. That combination IS the engine: a complete review in its own right,
with nothing missing and nothing to apologise for.

The built-in `code-review` skill is user-invocation-only in current Claude
Code — an agent cannot launch it, so never plan a review around it. It is an
opportunistic fold-in only: if the user has run it on the branch independently,
fold its findings into this review and record the engine as `single + user-run
code-review`. With no such user-run pass available, the engine is `single`.

**reviewDepth = `panel`:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '{"ref":"<base>..<branch>","specPath":"<spec path>","crossModel":<crossModelReview>}'
```

Args are a single JSON argv. The JSON report is the panel's stdout ONLY —
progress output goes to stderr — with `findings` (file, line, claim,
severity, lens, verified, verification) plus `summary`. The panel runs
2–3 read-only lens reviewers (spec compliance, correctness + security,
simplification) with per-finding adversarial verification; it never mutates
files or git. Pass `"crossModel": true` only when the crossModelReview
option is true, and record the engine as `panel [+ cross-model lens]` when it
ran. When branchReviewModel is an explicit id, export it before invoking:
`DEVCYCLE_PANEL_MODEL=<id> node ...` — omitting it would silently replace the
user's binding choice with the CLI's default. When it resolved to the session
tier, omit the export: the panel's subagents then run on the claude CLI's
configured default model.

**Graceful degradation of `panel` — a first-class path, not an apology.** When
`review-panel.js` is missing, or exits non-zero, the panel engine is
unavailable: an exit code of 1 means the panel itself failed, NOT that findings
exist, and it is never a review verdict. Fall back to `single` — the full
engine above — and say so in the engine line as `panel→single (panel
unavailable: <reason>)`. A fallback silently presented as a panel run makes the
gate unauditable; the disclosure is what keeps it honest.

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

## Findings loop (bounded by the round cap)

1. **Round 1 reviews the whole branch.** Log one `review-round` ledger event
   per round to `.devcycle/ledger.md`, in the shape the ledger defines
   (`task=branch`, `outcome=round <n> (<engine>)`), plus a `review-verdict`
   event for the round's outcome. Log the `review-round` event BEFORE the
   round's reviewers are dispatched, so a round that dies mid-flight still
   counts as spent.

   **The ledger is the round counter — the count is never restarted.** On entry,
   including every re-entry via `/devcycle:continue` after a `fixes-required`
   stop or a `/clear`, derive the round number by counting the
   `task=branch event=review-round` lines already in `.devcycle/ledger.md` for
   this cycle: the round about to run is that count plus one. A session that
   finds the count already at the cap opens no further round — it re-presents
   the outstanding blocking findings for a user decision, per 5's second
   terminal state. Without this the cap would bind only within one session, and
   a stage that deliberately keeps `stage: branch-review` would hand the next
   session a fresh full cap.

   Only the user may grant rounds beyond the cap, and only explicitly. Record
   that as `task=branch event=user-decision outcome=review-cap extended to <n>`
   and treat `<n>` as the cap from then on; the report's `Rounds:` line names it.
2. **Only blocking findings re-open the loop.** Each goes to a fresh
   `devcycle:implementer` dispatch (brief = the finding plus the spec path;
   never the review conversation). Non-blocking findings are recorded as
   carry-overs the round they are first raised, and never re-open the loop or
   consume a round.
3. **Rounds 2..N are narrow.** After the fixes are committed, re-run the SAME
   engine over the fix diff plus a re-check of the specific findings the
   previous round raised — not a fresh whole-branch pass. Round 1 already
   covered the branch; repeating it spends rounds on untouched code.
4. The loop ends as soon as a round leaves no blocking findings outstanding:
   verdict `pass`, with any non-blocking residue listed as carry-overs in the
   handoff. Never close the gate on "fixed" without the re-review.
5. **At the cap (round N complete), exactly two terminal states:**
   - **No blocking findings outstanding → verdict `pass`.** The residue is
     non-blocking; list it as carry-overs in the handoff.
   - **Blocking findings outstanding → verdict `fixes-required`.** The stage
     stops here and reports the outstanding findings for a user decision. It
     does not hand off to on-device and does not proceed to finishing.

**The cap bounds effort, never truth.** Reaching the cap NEVER converts an
outstanding blocking finding into a pass, and a finding is NEVER downgraded in
severity — to non-blocking, to a carry-over, to a note — in order to reach the
cap or close the loop faster. A cap that could launder a blocking finding into
a pass would make every `pass` from this gate unreadable. This guardrail is
unconditional: it holds at every profile, and the cap's own value never softens
it.

## Review report (REQUIRED shape)

```markdown
## Branch review report
- Engine: <single | single + user-run code-review | panel | panel [+ cross-model lens] | panel→single (panel unavailable: <reason>)>
- Branch: <base>..<branch>
- Spec: <path>
- Rounds: <n> of <cap>
- Findings:
  1. [severity] <symptom first, plain language — what goes wrong, then the mechanism>
- Carry-overs: <non-blocking findings accepted as residue, or "none">
- Verdict: pass | fixes-required
```

The engine line records what actually ran, and its value is one of the five
above — no variants. Findings in plain everyday language, symptom first;
jargon only where it adds precision.

## Handoff

When the gate passes, update `.devcycle/state.md` — set `stage: on-device`
(the stage the next session resumes at) — then emit the block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- Stage completed: `branch-review`
- Artifacts: the review report location and the branch
- Carry-overs: the accepted non-blocking findings (or `none`), followed by
  `Start the fresh session on <model>.`
- Compaction hint: keep the checklist path and the branch; drop all review and
  implementation context. When the state file records `checklist: none` (no
  rendered surface produced a checklist), keep instead `checklist: none —
  on-device stage will judge applicability` and the branch.

The `Start the fresh session on <model>` line is this stage's job because
the on-device session's model is chosen by whoever launches it — an
instruction inside that session would arrive too late. `<model>` is whatever
`walkthroughModel` resolves to per `${CLAUDE_PLUGIN_ROOT}/references/config.md`,
named by its present id.

A `fixes-required` verdict at the cap still emits this stage's block — the
outcome IS the stage result, and without a block nothing records that
branch-review ran and stopped. Keep `stage: branch-review` in
`.devcycle/state.md` so the cycle resumes here rather than at on-device, and
emit `Stage completed: branch-review` with the review report as its artifact,
the outstanding blocking findings as its carry-overs, and the stop-for-a-
user-decision outcome stated in the block. The block reports a stop; it never
reports a pass. The resuming session re-derives the round count from the ledger
per the findings loop's step 1 — it re-enters at the cap, not at round 1.
