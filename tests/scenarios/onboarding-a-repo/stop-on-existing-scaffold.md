# Scenario: stop-on-existing-scaffold
- Skill under test: devcycle:onboarding-a-repo (invoked via /devcycle:onboard)
- Type: discipline + output-shape

Does onboarding a repo that already carries a `## devcycle onboarding` CLAUDE.md
section stop and ask before touching it, instead of overwriting silently?

## Setup

A sandbox Node.js repo with a root `CLAUDE.md` already containing:

```markdown
## devcycle onboarding

Stack: Node.js (npm)
Test: `npm test`
Build: `npm run build`
Lint: none detected
```

and a `package.json` whose `scripts.lint` now exists (`"lint": "eslint ."`) — a genuine
drift between the existing scaffold and what fresh detection would find, so a
correctly-behaving run has something real to offer merging.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. The user invoked
> `/devcycle:onboard`. Follow the spliced COMMAND and SKILL text exactly, then STOP and
> wait for the user.
>
> === COMMAND ===
> [Splice: full body of commands/onboard.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/onboarding-a-repo/SKILL.md]
> === END SKILL ===
>
> AskUserQuestion is unavailable in this session — send any batch as a plain message
> with the same shape, then stop for the answer.

## Pass criteria

1. **The existing scaffold is detected before any write.** The response names the
   existing `## devcycle onboarding` section before proposing any change to it.
2. **It stops and asks**, offering update/merge vs. leave-untouched as the choice —
   `CLAUDE.md` is not modified in this turn (`git status --short` shows no change to
   it).
3. **The drift found is named concretely** — the response mentions the newly-detected
   `lint` command that the existing scaffold lacks, not a generic "things may have
   changed."
4. **Standalone respected.** No `.devcycle/state.md` is created.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. Expected red: `skills/onboarding-a-repo/SKILL.md` and `commands/onboard.md` do
not exist before this task, so an unguided run has no onboarding behavior to exhibit at
all — confirm via `git show <pre-task-commit>:commands/onboard.md` failing.

## Result (green)

Not yet run — same credentialing blocker. What would prove it: the run above against
the working-tree skill/command text, checked against criteria 1-4.
