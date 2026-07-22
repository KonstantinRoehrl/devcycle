# Scenario: batched-questions
- Skill under test: devcycle:scoping-interview
- Type: output-shape

## Setup

Reuse the "taskly" sandbox from `stop-gate.md` (tiny Node.js CLI todo app: `package.json`, `lib/tasks.js` with `addTask`/`listTasks`/`completeTask` persisting to `tasks.json`, `bin/taskly.js` dispatcher, `README.md`, committed to git). Run the subagent from the sandbox root.

For the **green** run, splice the full text of `skills/scoping-interview/SKILL.md` into the prompt at the marked slot. For the **baseline (red)** run, omit the guidance block entirely.

## Subagent prompt

> You are a coding agent working in this repository. The user has just sent the request below. Produce your single next response to the user, exactly as you would send it. Do not simulate further turns.
>
> === GUIDANCE (follow exactly; green run only) ===
> [Splice here: full text of skills/scoping-interview/SKILL.md.]
> === END GUIDANCE ===
>
> User request: "taskly should sync between my machines somehow"

## Pass criteria

1. The response contains exactly one batch of questions — a single AskUserQuestion call (or one plain-message batch if the tool is unavailable) with 1–4 questions. Not a lone question with more promised later ("let's start with…", "first question:"), and not more than 4.
2. Every question offers concrete options plus an Other/free-form escape; slot 1 is a summary confirmation of the agent's reading of the request.
3. The questions are research-informed: at least one references something actually discovered in the sandbox (e.g. the `tasks.json` storage file, the `add`/`list`/`done` commands, or the single-file `lib/tasks.js` design) rather than being generic sync questions that could be asked of any project.
4. The response contains no implementation, no design draft, and no assumed answers to its own questions.

## Baseline (red)

Run 2026-07-22 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`), guidance block omitted, isolated taskly sandbox in a session-temp directory.

- Criterion 1 FAIL: exactly one question, with more promised later — "Before I propose approaches, one question: **How do you want sync to work day-to-day?**" — the trickle pattern the skill exists to prevent.
- Criterion 2 FAIL: no summary confirmation slot; the lone question carried A/B/C options but the batch shape (slot-1 summary + per-question options + Other) was absent.
- Criterion 3 PASS: research-informed — it flagged that `tasks.json` is resolved relative to the cwd, discovered from `lib/tasks.js`.
- Criterion 4 PASS: no implementation or design draft.
- Net: RED — fails criteria 1 and 2.

## Result (green)

Run 2026-07-22 — same protocol, full `skills/scoping-interview/SKILL.md` spliced into the guidance slot.

- Criterion 1 PASS: one batch of 4 questions in a single message; the agent noted AskUserQuestion was unavailable in the session and used the skill's one-plain-message fallback ("here's the full batch as one message"), with unanswered items declared to become explicit `<tbd>`.
- Criterion 2 PASS: slot 1 = summary check ("My read: you want the same task list visible/editable from multiple machines…"); sync mechanism offered as options A–D plus Other; conflict-resolution and sync-trigger questions each listed concrete options plus Other.
- Criterion 3 PASS: leads with sandbox-specific findings — "tasks are stored in `tasks.json` — but that path is relative to the current working directory … Any sync design needs to account for that."
- Criterion 4 PASS: ends "I'll hold here — no design or code until you've answered."
- Net: GREEN — all four criteria met.
