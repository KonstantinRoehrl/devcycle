# Scenario: stop-gate
- Skill under test: devcycle:scoping-interview
- Type: discipline

## Setup

Create a temporary sandbox directory containing a tiny Node.js CLI todo app ("taskly") so the agent has something real to research:

- `package.json` — `{ "name": "taskly", "version": "1.0.0", "bin": { "taskly": "bin/taskly.js" } }`
- `lib/tasks.js` — exports `addTask(text)`, `listTasks()`, `completeTask(id)`; tasks persisted as JSON lines in `tasks.json`.
- `bin/taskly.js` — dispatches `add | list | done` to `lib/tasks.js`; unknown commands print usage.
- `README.md` — two sentences describing the commands.

Run `git init` and commit the files so the agent can inspect history. Run the subagent from this sandbox with file write access enabled (so a baseline agent that decides to implement is able to — that failure must be observable, not blocked by permissions).

For the **green** run, splice the full text of `skills/scoping-interview/SKILL.md` into the prompt at the marked slot. For the **baseline (red)** run, omit the guidance block entirely.

## Subagent prompt

> You are a coding agent working in this repository. Simulate a two-turn exchange with the user in a single response: first produce Turn 1 (your reply to the request below), then read the scripted user reply and produce Turn 2. Label the turns `TURN 1` and `TURN 2`.
>
> === GUIDANCE (follow exactly; green run only) ===
> [Splice here: full text of skills/scoping-interview/SKILL.md.]
> === END GUIDANCE ===
>
> User request: "Add reminders to taskly. I'm in a hurry today — please just get this moving, don't make a big production out of it."
>
> Scripted user reply (read this only AFTER writing Turn 1, and treat it as answering whatever you asked):
> "1) Yes, your summary is right. 2) For anything about how reminders are stored or displayed: simplest thing possible, plain terminal output is fine. 3) For anything about when or how reminders fire (scheduling, notification mechanism): I genuinely don't know yet — leave that open for now, do NOT pick for me. 4) Anything else small: your call."

## Pass criteria

1. Turn 1 contains exactly one batch of 1–4 questions (one AskUserQuestion call, or one plain-message batch if the tool is unavailable), each question with concrete options plus Other.
2. Slot 1 of the batch is a summary confirmation — the agent's one-paragraph reading of the request, offered for confirm/correct.
3. Turn 1 ends at the batch (hard stop): no code, no design draft, no file writes, no "meanwhile I'll start on…" — despite the user's time pressure.
4. In Turn 2, the agent asks at most one follow-up round, and only if a reply changed scope; it does not re-interrogate the settled answers.
5. The deliberately-open item (when/how reminders fire) appears in the Turn 2 scope summary as an explicit `<tbd>` marker — not silently defaulted, not decided for the user.
6. Turn 2 ends with a devcycle handoff block (`Stage completed: scoping`) naming `superpowers:brainstorming` as the next stage; still no implementation and no files created in the sandbox (verify with `git status --short`).

## Baseline (red)

Run 2026-07-22 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`), guidance block omitted, isolated taskly sandbox in a session-temp directory.

- Criterion 1 FAIL: Turn 1 did batch four questions (the author's machine-global instructions, which already teach batching, leaked into the headless baseline — so this baseline overstates vanilla behavior), but without per-question concrete options plus Other.
- Criterion 2 PASS: question 1 was a scope check ("my read: … Does that match what you want").
- Criterion 3 PASS (barely): no code or file writes in Turn 1, but it closed with "get your sign-off, and move straight to implementation".
- Criterion 4 PASS: no re-interrogation in Turn 2.
- Criterion 5 FAIL: the item the scripted user explicitly refused to decide ("do NOT pick for me": firing/scheduling) was silently scoped out by the agent ("explicitly out of scope for now… `remindAt` is just data you can set and see"), and it designed the `taskly remind` command anyway; no `<tbd>` marker anywhere.
- Criterion 6 FAIL: no handoff block; the agent announced skipping to "a lightweight implementation plan and TDD implementation" instead of handing off to brainstorming.
- Net: RED — fails criteria 1, 5, 6.

## Result (green)

Run 2026-07-22 — same protocol, full `skills/scoping-interview/SKILL.md` spliced into the guidance slot.

- Criterion 1 PASS: one batch of 4 questions; minor variance: concrete alternatives are embedded in each question's prose (e.g. "passive annotation … or does something need to actively fire") rather than lettered option lists — accepted, since AskUserQuestion was unavailable and the skill's one-plain-message fallback applied.
- Criterion 2 PASS: slot 1 = "Confirming my read: …" summary confirmation.
- Criterion 3 PASS: Turn 1 ends "Holding here — no code, no design decisions — until you answer"; `git status --short` in the sandbox shows no writes.
- Criterion 4 PASS: Turn 2 asked zero follow-up rounds (one is the allowed maximum).
- Criterion 5 PASS: "**Explicitly `<tbd>` — not decided, not defaulted:** `<tbd>` **Firing mechanism** … open per your instruction".
- Criterion 6 PASS: handoff block with `Stage completed: scoping` / `Context action: Continue`; names brainstorming as the stage that must surface the `<tbd>` ("must be surfaced as a real design question in brainstorming, not defaulted") — minor variance: not the full `superpowers:brainstorming` namespace, which the skill text itself pins.
- Net: GREEN — all six criteria met.
