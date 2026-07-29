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

Resolve every knob and the profile per `${CLAUDE_PLUGIN_ROOT}/references/config.md`,
including its resolution order — which decides when an explicitly configured knob
wins over the profile's column and when the profile applies instead. Read it there;
none of it is repeated here. What this stage consumes:

- `reviewDepth` — `${user_config.reviewDepth}`, allowed `single` | `panel`.
  Whatever it resolves to picks the engine in "Engine selection" below.
- `crossModelReview` — `${user_config.crossModelReview}`, default `false`.
- `branchReviewModel` — `${user_config.branchReviewModel}`. What it resolves to
  (an explicit model id, binding; or the session tier) is what every rule below
  means by "the branch-review model".
- The **round cap** for the findings loop is the profile's branch-review round
  cap, read from that file's matrix.

## Fresh context (bias control — non-negotiable)

The rule and its rationale are owned by `devcycle:reviewing-code`; this stage names it and
does not restate it. What it constrains here is the **Inputs** above: those three are
deliberately all a reviewer receives.

## Engine selection

Delegated in full to `devcycle:reviewing-code`. It picks the engine from `reviewDepth`,
invokes `workflows/review-panel.js` for `panel`, runs the same lenses inline plus the
refutation pass for `single`, degrades `panel→single` with the reason disclosed, and exports
`DEVCYCLE_PANEL_MODEL` when `branchReviewModel` is an explicit id. None of that is restated
here.

Invoke it with `scope: {ref: "<base>..<branch>"}`, the spec path as `specPath`, and this
stage's criteria — what the spec requires and forbids, plus the default criteria set — and
record the engine line it returns **verbatim** in the report below.

The built-in `code-review` skill is user-invocation-only in current Claude Code — an agent
cannot launch it, so never plan a review around it. It is an opportunistic fold-in only: if
the user has run it on the branch independently, fold its findings into this review and
record the engine as `single + user-run code-review`.

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
   per round to `.devcycle/ledger.md`, in the shape the ledger defines, with
   `task=branch`, `outcome=round <n> (<engine>)`, and — this stage's binding
   use of that field — `ref=` set to the spec path recorded on the `spec:` line
   of `.devcycle/state.md` (a file path, which is what `ref=` takes). Log a
   `review-verdict` event for the round's outcome too. Log the
   `review-round` event BEFORE the round's reviewers are dispatched, so a round
   that dies mid-flight still counts as spent.

   **The ledger is the round counter, and the count is per cycle.** The ledger
   lives at one fixed path per repo and is never reset between cycles, so the
   count has to be scoped by something the lines themselves carry — which is
   what the `ref=` spec path above is for. On entry, including every re-entry
   via `/devcycle:continue` after a `fixes-required` stop or a `/clear`, derive
   the round number by counting the `task=branch event=review-round` lines in
   `.devcycle/ledger.md` whose `ref=` equals THIS cycle's spec path: the round
   about to run is that count plus one. Rounds an earlier cycle spent carry a
   different spec path and are not counted, so a fresh cycle in a repo with a
   long ledger starts at round 1 no matter how many reviews came before it.

   Two things this leans on. The spec path has to be the cycle's own — dated and
   slugged, as the pipeline writes them; a repo that pointed every cycle at one
   generic filename would hand its later cycles a count already spent, which is
   the exact failure the scoping exists to stop. And `spec:` has to be a real
   path: a state file reading `spec: none` cannot enter this stage at all (see
   **Inputs**), so on finding one, stop and say so rather than count rounds you
   cannot attribute.

   Within a cycle the count is never restarted. A session that finds it already
   at the cap opens no further round — it re-presents the outstanding blocking
   findings for a user decision, per 5's second terminal state. Without this the
   cap would bind only within one session, and a stage that deliberately keeps
   `stage: branch-review` would hand the next session a fresh full cap.

   Only the user may grant rounds beyond the cap, and only explicitly. Record
   that as `task=branch event=user-decision outcome=review-cap extended to <n>`
   and treat `<n>` as the cap from then on; the report's `Rounds:` line names it.
2. **Only blocking findings re-open the loop.** **Blocking means `critical` or `high`** —
   `${CLAUDE_PLUGIN_ROOT}/references/findings.md` owns the severity vocabulary and derives
   blocking from it, and neither is restated here. Each blocking finding goes to a fresh
   `devcycle:implementer` dispatch (brief = the finding plus the spec path; never the review
   conversation). Non-blocking findings — `medium` and `low` — are recorded as carry-overs
   the round they are first raised, and never re-open the loop or consume a round.
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
severity to reach the cap or close the loop faster — `references/findings.md`
owns that rule. A cap that could launder a blocking
finding into a pass would make every `pass` from this gate unreadable. This guardrail is
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
above — no variants. `[severity]` on a finding is one of the four values
`references/findings.md` defines; the carry-overs line holds exactly the
non-blocking ones. Findings in plain everyday language, symptom first;
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
