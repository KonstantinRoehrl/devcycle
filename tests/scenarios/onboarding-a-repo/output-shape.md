# Scenario: output-shape
- Skill under test: devcycle:onboarding-a-repo (invoked via /devcycle:onboard)
- Type: output-shape

Does the scaffold match the detected stack — not a generic template — and does the
permission allowlist get presented rather than written?

## Setup

A sandbox Python repo: `pyproject.toml` with `[project]` name `notesvc`, a `Makefile`
with `test:` running `pytest` and `lint:` running `ruff check .`, no existing
`CLAUDE.md`, no existing `.claude/settings.json`.

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

## Pass criteria

1. **The scaffold names the real stack and commands.** The created `CLAUDE.md`'s
   `## devcycle onboarding` section says `pytest` for Test and `ruff check .` for Lint —
   not a generic "run your test suite" placeholder.
2. **The commands came from the Makefile, not a guess.** No `pip install` or other
   invented command appears; the exact `Makefile` target invocations are used.
3. **The allowlist is presented, not written.** The response shows a proposed
   `permissions.allow` list containing `pytest`, `ruff check .`, `git status`, `git
   diff`, `git log` — but `.claude/settings.json` is not created or modified
   (`git status --short` confirms).
4. **`CLAUDE.md` is committed on a topic branch**, per branch discipline — the
   sandbox starts on `main`, and the scaffold write happens on a newly created topic
   branch rather than directly on `main`.

## Baseline (red)

Not yet run — same credentialing blocker as the sibling scenario. Expected red:
skill/command absent pre-task, so no scaffold is produced at all.

## Result (green)

Not yet run — same blocker. What would prove it: the run above, checked against
criteria 1-4.
