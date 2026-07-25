---
name: scoping-interview
description: Use when a development request arrives as a rough idea, vague ticket, or one-liner whose scope, intent, or constraints are not yet established.
---

# Scoping Interview

Turn a rough request into an established scope before any design work starts. This is
the devcycle pre-stage in front of `superpowers:brainstorming` — or, for bugs whose
root cause is not yet established, in front of the diagnosis stage
(`superpowers:systematic-debugging`): it settles *what is being asked*; root-cause
hunting, design exploration, approach trade-offs, and spec writing stay downstream.

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

Verify `.devcycle/state.md` exists before any research or questions. If it is
missing (the pipeline creates it as its first action; this check is the backstop),
create it now — stage `scoping`, the current git branch, `none` for the
scope/spec/plan/checklist lines, `configured: no` — so a cycle interrupted
mid-interview still leaves a state file for `/devcycle:continue` to resume from.

## The discipline

Whenever scope, intent, architecture, data, or user preference is uncertain:
**interview, never guess.**

1. **Research BEFORE questions.** Read the relevant code and docs first, so every
   question is informed by what the repo already shows. Never ask what the repo can
   answer.
   **Repo-research procedure** (canonical — planning-waves runs this same procedure
   with its own relevance filter): when a `graphify` skill is listed among this
   session's available skills, check the target repo (never this plugin's own repo)
   for `graphify-out/` and/or a root `GRAPH_REPORT.md`. If present, read the report
   and query the graph for what this step needs — including `document`-type nodes
   for relevant docs (graphify tags markdown separately from code). If absent, or
   too stale/thin for the area in question: research the code by plain reading and
   search, and find docs two-phase — list `*.md` files repo-wide (excluding
   `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, and equivalents), index
   only each file's title/first heading, and read in full only entries judged
   relevant. Always read-only (never trigger a graphify build or `--update`) and
   silent either way: no note about whether a graph was used, and no docs found is
   nothing to report.
   Relevance here is judged against the request itself — scope is not yet
   confirmed — starting from root repo-orientation docs (a `project.md`,
   `architecture.md`, or equivalent).
2. **Batch, don't trickle.** Ask via AskUserQuestion: 1–4 questions per call, each
   with concrete options plus Other — never one question per message. If
   AskUserQuestion is unavailable, send the whole batch as one plain message with
   the SAME shape: the summary confirmation as item 1, and every question still
   listing its concrete options plus an explicit Other/free-form escape.
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

End the stage by naming the next stage explicitly in your final output. Update
`.devcycle/state.md` (`stage: diagnosis` or `stage: brainstorm` — the stage to
resume at — and `scope: .devcycle/scope.md`) before emitting the devcycle
handoff block (both boundaries continue in the same conversation, per the
pipeline lifecycle):

```markdown
## Handoff
- Stage completed: scoping
- Artifacts: .devcycle/scope.md
- Carry-overs: <confirmed scope, constraints, open `<tbd>` items>
- Context action: Continue
- Compaction hint: Keep everything. Drop nothing.
```
