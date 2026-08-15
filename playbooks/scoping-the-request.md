# Scoping the Request

Turn a rough request into an established scope before any design work starts. This is
the devcycle pre-stage in front of `superpowers:brainstorming` — or, for bugs whose
root cause is not yet established, in front of the diagnosis stage
(`superpowers:systematic-debugging`): it settles *what is being asked*; root-cause
hunting, design exploration, approach trade-offs, and spec writing stay downstream.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons scoping`. No store, no output.

## The target

The stage ends with the most precise description of the desired end state the
available answers allow, shaped as a well-structured goal — not a tidied-up
restatement of the request. A one-line request leaves many open questions; this
stage exists to resolve them or pin them as explicit `<tbd>`s, so every later
stage is tailored to what the user actually needs.

**Bug requests interview differently.** When the request reports broken behavior,
the questions target the symptom, not design intent: exact reproduction steps,
expected vs. actual behavior, how often and since when it occurs, environment,
and any logs or error output the user has. Asking a bug reporter what the fix
should look like wastes the interview — "it should not lose data" was already
implied. Never ask the user for the root cause either: establishing it is the
diagnosis stage's job, not theirs. The scope summary for a bug carries a
**Reproduction** section (steps, expected vs. actual, evidence) in place of
design-oriented detail.

Division of labor: **the user knows the problem; the repo knows the code.**
Questions ask for intent, desired outcomes, behavior at the edges, and
priorities — things only the user can settle. What the change touches —
components, affected files, other occurrences of the same pattern, whether the
request is really a small fix or drags a larger change behind it — is the
stage's own research job, established from the repo and *presented* to the user
for confirmation, never requested from them. A user who happens to know
internals may volunteer them; the interview must not depend on it.

## Stage entry

Verify `.devcycle/state.md` exists at the target repo's toplevel
(`git rev-parse --show-toplevel`) before any research or questions. If it is
missing (the pipeline creates it as its first action; this check is the backstop),
create it now — stage `scoping`, the repo root in `root:`, the current git
branch, a one-line `request:` distilled from the user's ask, `none` for the
scope/spec/plan/checklist lines, `configured: no` — so a cycle interrupted
mid-interview still leaves a state file, pinned to this repo and goal, for
`/devcycle:continue` to resume from.

## The discipline

Whenever scope, intent, architecture, data, or user preference is uncertain:
**interview, never guess.**

Questions go through AskUserQuestion in batches of 1–4, each with concrete options plus Other.
Never one question per message. A question answered via Other appends `user-correction-at-gate`; `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns the rule.

1. **Research BEFORE questions.** Read the relevant code and docs first, so every
   question is informed by what the repo already shows. Never ask what the repo can
   answer.
   Research is a dispatch, not an inline reading exercise: run the repo-research procedure
   `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns (`## Research dispatches`), which
   covers graph-first precedence, the fallback to plain search with two-phase doc discovery,
   the fast tier, and the read-only-and-silent rule. None of it is restated here.
   Relevance here is judged against the request itself — scope is not yet
   confirmed — starting from root repo-orientation docs (a `project.md`,
   `architecture.md`, or equivalent).
2. **Batch, don't trickle.** If AskUserQuestion is unavailable, send the whole
   batch as one plain message with the SAME shape: the summary confirmation as
   item 1, and every question still listing its concrete options plus an explicit
   Other/free-form escape.
3. **Summary confirmation occupies slot 1** of the first batch: your one-paragraph
   reading of what the user wants, offered to confirm or correct.
4. **Hard STOP after asking.** No drafting, no assuming answers, no continuing
   analysis until the user has answered.
5. **At most ONE follow-up round**, and only when an answer changes scope or
   invalidates prior research.
6. **Remaining unknowns become explicit `<tbd>` markers** in the scope summary —
   never silently defaulted. When the user declines to decide something, that is a
   `<tbd>`, not permission to pick for them.

Exempt: small reversible implementation choices. Decide those; ask everything else
that is uncertain.

## Red flags — if you catch yourself thinking any of these, return to the discipline

| Rationalization | Reality |
| --- | --- |
| "The answer is obvious, I'll assume it" | Obvious-to-you is where scope drift starts. Ask, or mark `<tbd>`. |
| "The user is in a hurry, I'll skip the questions" | Time pressure is exactly when a wrong assumption costs the most. One batch is fast. |
| "One question at a time feels more conversational" | Trickling burns the user's turns. Batch 1–4 with options. |
| "I'll start drafting while I wait" | The stop is hard. Drafting before answers bakes assumptions in. |
| "They said 'your call' about the whole thing" | "Your call" on scope-level unknowns means `<tbd>`, not a free design pass. |

## Output and handoff

This stage reports per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

When the interview resolves (answers in, remaining unknowns marked `<tbd>`), write
the scope summary to `.devcycle/scope.md` — and present it to the user — as a
well-structured goal:

- **End state** — what is observably true when the work is done, in the user's terms.
- **In scope / out of scope** — explicit on both sides.
- **Affected areas** — components, files, and other occurrences of the pattern, as
  established by this stage's research (confirmed, not sourced, with the user).
- **Constraints** — what must not change, compatibility requirements, priorities.
- **Open `<tbd>` items** — every unresolved unknown, none silently defaulted.

REQUIRED next stage — two cases:

- **Bug with the root cause not yet established:** `superpowers:systematic-debugging`
  (the pipeline's diagnosis stage), with the scope summary's Reproduction section as
  its starting evidence. Design comes after the cause is known.
- **Everything else** (features, refactors, bugs whose cause is already established
  with evidence): `superpowers:brainstorming`, with the scope summary as its explored
  context — its questioning then targets design refinement, not re-establishing
  scope. Do not restate or replace its process here.

An audit-shaped request may never reach this stage at all: `/devcycle:cycle`'s triage
can enter the pipeline at the audit stage (`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`) instead, which
then hands its selected findings to brainstorm.

End the stage by naming the next stage explicitly in your final output. Update
`.devcycle/state.md` (`stage: diagnosis` or `stage: brainstorm` — the stage to
resume at — and `scope: .devcycle/scope.md`), then emit the handoff block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- `Stage completed:` scoping.
- `Artifacts:` `.devcycle/scope.md`.
- `Carry-overs:` confirmed scope, constraints, open `<tbd>` items.
