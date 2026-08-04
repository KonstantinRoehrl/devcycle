# Scenario: description-sufficiency
- Skill under test: devcycle:dreaming-across-sessions
- Type: description-sufficiency

Is `skills/dreaming-across-sessions/SKILL.md`'s frontmatter `description` alone —
without the body — sufficient for a model to correctly decide invoke-or-not?

## Setup

None beyond the skill's own frontmatter. The judge is shown only this line, quoted
verbatim from `skills/dreaming-across-sessions/SKILL.md`:

```
description: Use when the session transcripts and memory accumulated for this repo since the last dream are ready for a cross-session consolidation pass — mining, clustering, and deduping recurring patterns and contradictions into promotion candidates for devcycle:distilling-learnings, screening every candidate and cluster signature for sensitive content. Read-only: writes only a dated dream artifact and its own checkpoint; promotes nothing itself.
```

## Subagent prompt

Run the judge agent 6 times, once per prompt below, each as an independent fresh
session, using the same judge-prompt template as the `auditing-a-repo` sibling scenario
(substituting this skill's description and the prompts below).

Trigger prompts (expect YES):
1. "can you consolidate what we've learned across all our past sessions before I run distill"
2. "mine our session history for recurring patterns we haven't captured as memory yet"
3. "check whether the same contradiction keeps showing up in our memory before I clean it up"

Non-trigger prompts (expect NO):
4. "review this one pull request diff before I merge it"
5. "add a new endpoint for exporting notes as CSV"
6. "audit this repo for security and correctness issues before we ship"

## Pass criteria

All 6 verdicts match their expected label (YES for 1-3, NO for 4-6). Prompt 6 in
particular distinguishes this skill from its confusable sibling `auditing-a-repo`,
whose own trigger this line is drawn from.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. Expected red: no `description` exists pre-task (the skill file did not exist),
so no verdict can be produced at all.

## Result (green)

Not yet run — same blocker. What would prove it: running the 6 judge invocations above
and confirming each verdict matches its expected label.
