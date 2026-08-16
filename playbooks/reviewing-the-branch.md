# Reviewing the Branch

The whole-branch review gate between execution and finishing: one review of everything the
branch does, against the spec that ordered it, before on-device verification or finishing.

**Inputs** (from the execution handoff / `.devcycle/state.md`): the branch, the spec file path,
the ledger path (`.devcycle/ledger.md`). These three are ALL the review needs — the
fresh-context rule that makes that deliberate is owned by
`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`. One further read serves the handoff, not the
review: the `checklist:` line of `.devcycle/state.md`, which this stage's handoff carries forward.

This stage, and every agent it dispatches, reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons branch-review`. No store, no output.

## Configuration

Resolve every knob and the profile per `${CLAUDE_PLUGIN_ROOT}/references/config.md`, including
its resolution order; none of it is repeated here. What this stage consumes:

- `reviewDepth` — `${user_config.reviewDepth}`, allowed `single` | `panel`; it picks the engine.
- `crossModelReview` — `${user_config.crossModelReview}`, default `false`.
- `branchReviewModel` — `${user_config.branchReviewModel}`. What it resolves to — an explicit
  model id, binding, or the session tier — is what every rule below means by "the branch-review
  model".
- The **round cap** for the findings loop is the profile's branch-review round cap.

## Engine selection

Delegated in full to `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` — engine choice from
`reviewDepth`, panel invocation, the `panel→single` degradation with its disclosed reason, and
the model export are all its rules, and none of them are restated here.

Before that invocation, the coordinator matches this branch's lessons to what it changed —
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --match --stage branch-review --files "<the base..branch diff's changed files>"` —
and splices the matched lesson lines it prints (those lines alone, never a whole stage
section) into the reviewer's dispatch as an explicit known-lesson check: *does this diff
re-introduce any matched lesson's mistake?* Each spliced line ends in its own `--lesson <id>`
pull hint, so the reviewer fetches the full record on demand instead of being handed it up
front. A match that comes back empty adds no such block.

Invoke it with `scope: {ref: "<base>..<branch>"}`, the spec path as `specPath`, and this
stage's criteria — what the spec requires and forbids, plus the default criteria set — and
record the engine line it returns **verbatim** in the report below.

The built-in `code-review` skill is user-invocation-only in current Claude Code — an agent
cannot launch it, so never plan a review around it. It is an opportunistic fold-in only: if the
user has run it on the branch independently, fold its findings in and record the engine as
`single + user-run code-review`.

## Spec-compliance layer

Review against the spec FILE, not just the diff — a branch can be internally clean, tests
green and diff tidy, and still fail its spec:

1. Read the spec file; enumerate what it requires and what it forbids.
2. Check every requirement against the branch as a whole, not only the changed lines.
3. File findings for anything the spec asks for that the branch does not deliver, and anything
   the branch does that the spec never asked for.
4. Cross-check the ledger: every task it records as committed must actually be on the branch,
   and nothing on the branch should lack a ledger trail.

## Findings loop (bounded by the round cap)

1. **Round 1 reviews the whole branch.** Log one `review-round` ledger event per round to
   `.devcycle/ledger.md`, in the shape the ledger defines, with `task=branch`, `outcome=round
   <n> (<engine>)`, and — this stage's binding use of that field — `ref=` set to the spec path
   recorded on the `spec:` line of `.devcycle/state.md`. Log it BEFORE the round's reviewers
   are dispatched, so a round that dies mid-flight still counts as spent, and log a
   `review-verdict` event for the round's outcome too.

   **The ledger is the round counter, and the count is per cycle.** On entry — including every
   re-entry via `/devcycle:continue` after an `exhausted-unresolved` stop or `/clear` — count the
   `task=branch event=review-round` lines whose `ref=` equals THIS cycle's spec path; the round
   about to run is that count plus one. Scoping by spec path is what lets a fresh cycle start at
   round 1 in a repo whose ledger is never reset, so it takes the cycle's own dated-and-slugged
   spec path, and a real one: a state file reading `spec: none` cannot enter this stage at all
   (see **Inputs**) — on finding one, stop and say so.

   Within a cycle the count is never restarted. A session that finds it already at the cap
   opens no further round — it re-presents the outstanding blocking findings for a user
   decision, per 5's second terminal state. Only the user may grant rounds beyond the cap, and
   only explicitly: record that as `task=branch event=user-decision outcome=review-cap extended
   to <n>`, treat `<n>` as the cap from then on, and note that granting it via Other also
   appends `user-correction-at-gate` — `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns both.
2. **Only blocking findings re-open the loop.** **Blocking means `critical` or `high`** —
   `${CLAUDE_PLUGIN_ROOT}/references/findings.md` owns the severity vocabulary and derives
   blocking from it, and neither is restated here. Each blocking finding goes to a fresh
   `devcycle:implementer` dispatch — brief = the finding plus the spec path; never the review
   conversation. It is an implementer dispatch bound by the same evidence contract every other
   one is, so the brief carries a minted task-id (`branch-fix-<round>-<n>`) and an
   `**Evidence:**` class line, and asks the implementer to check the fix against the repo
   conventions it touches, not just satisfy the finding's literal wording. Non-blocking
   findings — `medium` and `low` — are recorded as carry-overs the round they are first
   raised, and never re-open the loop or consume a round.
3. **Rounds 2..N are narrow.** The fix-dispatch brief never instructs the implementer to
   commit; the coordinator commits each fix on receipt. Once it has, re-run the SAME engine
   over the fix diff — `<this round's pre-fix HEAD>..<the fix commit>`, never an earlier
   execution-stage commit — plus a re-check of the specific findings the previous round raised,
   not a fresh whole-branch pass. Round 1 already covered the branch.
4. The loop ends as soon as a round leaves no blocking findings outstanding: verdict `resolved`,
   with any non-blocking residue listed as carry-overs in the handoff. Never close the gate on
   "fixed" without the re-review.
5. **At the cap (round N complete), exactly two terminal states, named by `references/loops.md`:**
   - **No blocking findings outstanding → verdict `resolved`.** The residue is non-blocking;
     list it as carry-overs in the handoff.
   - **Blocking findings outstanding → verdict `exhausted-unresolved`.** The stage stops here
     and reports the outstanding findings for a user decision. It does not hand off to on-device
     and does not proceed to finishing.

**The cap bounds effort, never truth.** Reaching the cap NEVER converts an outstanding
blocking finding into a pass; `${CLAUDE_PLUGIN_ROOT}/references/loops.md` owns that rule and
the vocabulary for each exhaustion outcome. Severity itself is not this stage's to adjust:
`references/findings.md` owns it, including what may and may not change it. This guardrail is
unconditional — it holds at every profile, and the cap's own value never softens it.

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
- Verdict: <one of `${CLAUDE_PLUGIN_ROOT}/references/loops.md`'s three values — never an ad-hoc `pass`>
```

The engine line records what actually ran, and its value is one of the five above — no
variants. `[severity]` is one of the four values `references/findings.md` defines; the
carry-overs line holds exactly the non-blocking ones. Findings in plain everyday language,
symptom first; jargon only where it adds precision.

## Handoff

When the gate passes, set `stage: on-device` in `.devcycle/state.md` — the stage the next
session resumes at — then emit the block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- Stage completed: `branch-review`
- Artifacts: the review report location and the branch
- Carry-overs: the accepted non-blocking findings (or `none`), followed by `Start the fresh
  session on <model>.` — this stage's job, because the on-device session's model is chosen by
  whoever launches it. `<model>` is whatever `walkthroughModel` resolves to per
  `${CLAUDE_PLUGIN_ROOT}/references/config.md`, named by its present id.
- Compaction hint: keep the checklist path and the branch; drop all review and implementation
  context. When the state file records `checklist: none` (no rendered surface produced a
  checklist), keep instead `checklist: none — on-device stage will judge applicability` and
  the branch.

An `exhausted-unresolved` verdict at the cap still emits this stage's block — the outcome IS
the stage result. Keep `stage: branch-review` in `.devcycle/state.md` so the cycle resumes here
rather than at on-device, and emit `Stage completed: branch-review` with the review report as its
artifact, the outstanding blocking findings as its carry-overs, and the stop-for-a-user-decision
outcome stated in the block. The block reports a stop; it never reports a pass. The resuming
session re-derives the round count from the ledger per the findings loop's step 1 — it re-enters
at the cap, not at round 1.
