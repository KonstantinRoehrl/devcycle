---
name: scoping-interview
description: Use when a development request arrives as a rough idea, vague ticket, or one-liner whose scope, intent, or constraints are not yet established.
---

# Scoping Interview

Turn a rough request into an established scope before any design work starts. This is
the devcycle pre-stage in front of `superpowers:brainstorming`: it settles *what is
being asked*; design exploration, approach trade-offs, and spec writing stay upstream.

## The discipline

Whenever scope, intent, architecture, data, or user preference is uncertain:
**interview, never guess.**

1. **Research BEFORE questions.** Read the relevant code and docs first, so every
   question is informed by what the repo already shows. Never ask what the repo can
   answer.
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

When the interview resolves (answers in, remaining unknowns marked `<tbd>`), present
the scope summary: confirmed intent, constraints, in/out of scope, open `<tbd>` items.

REQUIRED next stage: `superpowers:brainstorming`, with the scope summary as its
explored context — its questioning then targets design refinement, not
re-establishing scope. Do not restate or replace its process here.

End the stage by naming the next stage explicitly in your final output — state
that the cycle now hands off to `superpowers:brainstorming` with the scope
summary as its explored context — followed by the devcycle handoff block
(scoping → brainstorm continues in the same conversation, per the pipeline
lifecycle):

```markdown
## Handoff
- Stage completed: scoping
- Artifacts: <paths, one per line, or "none (scope summary above)">
- Carry-overs: <confirmed scope, constraints, open `<tbd>` items>
- Context action: Continue
- Compaction hint: Keep everything. Drop nothing.
```
