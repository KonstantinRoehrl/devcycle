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

## Regression (Task 12)

Runs 2026-07-22 — full-pass regression against the committed skill text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; init event confirmed `plugins: []`), taskly sandbox rebuilt per Setup in a session-temp directory.

- Run 1 (committed text) FAILED criterion 2: under the plain-message fallback the batch lost its shape — the summary confirmation appeared as a preamble paragraph instead of slot 1, and two of the three questions offered concrete options but no explicit Other/free-form escape. Criteria 1, 3, 4 passed (one batch of 3 questions; research-informed — flagged `tasks.json` resolving from the cwd; no implementation).
- Fix applied to the owning skill: the AskUserQuestion-unavailable fallback sentence in `skills/scoping-interview/SKILL.md` now pins the same batch shape for the plain-message path ("the summary confirmation as item 1, and every question still listing its concrete options plus an explicit Other/free-form escape").
- Run 2 (fixed text) PASSED all four criteria: one batch of 4 questions in a single message, with the agent first verifying AskUserQuestion was unavailable and announcing the fallback ("same shape, options plus Other on each"); slot 1 = summary confirmation offered for confirm/correct; questions 2–4 each carry lettered options plus "d) Other"; research-informed (task IDs assigned as `tasks.length + 1`, discovered from `lib/tasks.js`, driving the conflict-handling question); no implementation, no design draft, and it holds for answers before any scope summary.
- Net: GREEN after fix — the fix is part of this task's diff for the coordinator to commit.
