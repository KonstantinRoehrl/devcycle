# Scenario: description-sufficiency
- Skill under test: devcycle:auditing-a-repo
- Type: description-sufficiency

Is `skills/auditing-a-repo/SKILL.md`'s frontmatter `description` alone — without the
body — sufficient for a model to correctly decide invoke-or-not?

## Setup

None beyond the skill's own frontmatter. The judge is shown only this line, quoted
verbatim from `skills/auditing-a-repo/SKILL.md`:

```
description: Use when a repository or a branch needs a criteria-driven audit — criteria are derived from the stacks actually present and the repo's own conventions, then interviewed for, never assumed — producing findings ranked by severity, impact, and fix complexity, each with file-referenced evidence and a concrete fix.
```

## Subagent prompt

Run the judge agent 6 times, once per prompt below, each as an independent fresh
session, using the same judge-prompt template as the scoping-interview sibling scenario
(substituting this skill's description and the prompts below).

Trigger prompts (expect YES):
1. "can you audit this repo and tell me what's wrong with it"
2. "review the whole codebase for security and correctness issues before we ship"
3. "what would a thorough code review of this project turn up"

Non-trigger prompts (expect NO):
4. "review this one pull request diff before I merge it"
5. "add a new endpoint for exporting notes as CSV"
6. "what does the `slugify` function in src/store.js do"

## Pass criteria

All 6 verdicts match their expected label (YES for 1-3, NO for 4-6).

## Result

Not yet run — same credentialing blocker as the sibling scenario. What would prove it:
running the 6 judge invocations above and confirming each verdict matches its expected
label.
