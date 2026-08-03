# Scenario: description-sufficiency
- Skill under test: devcycle:scoping-interview
- Type: description-sufficiency

Is `skills/scoping-interview/SKILL.md`'s frontmatter `description` alone — without the
body — sufficient for a model to correctly decide invoke-or-not?

## Setup

None beyond the skill's own frontmatter. The judge is shown only this line, quoted
verbatim from `skills/scoping-interview/SKILL.md`:

```
description: Use when a development request arrives as a rough idea, vague ticket, or one-liner whose scope, intent, or constraints are not yet established.
```

## Subagent prompt

Run the judge agent 6 times, once per prompt below, each as an independent fresh
session:

> You are deciding whether to invoke a skill. Here is its full description — nothing
> else is available to you:
>
> "Use when a development request arrives as a rough idea, vague ticket, or one-liner
> whose scope, intent, or constraints are not yet established."
>
> Given this user request: "<PROMPT>"
>
> Should this skill be invoked? Answer only YES or NO.

Trigger prompts (expect YES):
1. "add some kind of export feature to the app"
2. "users keep asking for a way to share reports, can you look into it"
3. "make the settings page better"

Non-trigger prompts (expect NO):
4. "fix the null pointer exception in src/api/users.ts:42 that throws when email is missing"
5. "rename the `fetchUser` function to `getUser` across the codebase"
6. "run the test suite and tell me what's failing"

## Pass criteria

All 6 verdicts match their expected label (YES for 1-3, NO for 4-6).

## Result

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. What would prove it: running the 6 judge invocations above and confirming
each verdict matches its expected label.
