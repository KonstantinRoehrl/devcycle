# Scenario: dependency-declarations
- Skill under test: devcycle:planning-waves
- Type: output-shape

## Setup

No repo files are needed — the spec is embedded in the subagent prompt and the agent is told to answer with plan text only. Run the subagent from an empty sandbox directory. The prompt's first line pins the agent to the guidance between the markers; without it, machine-local global instructions (which may already encode wave-planning habits) contaminate the baseline.

For the **green** run, splice the full text of `skills/planning-waves/SKILL.md` into the prompt at the marked slot in addition to the upstream skill. For the **baseline (red)** run, include only the upstream `superpowers:writing-plans` SKILL.md there.

## Subagent prompt

> You are planning an implementation. Follow ONLY the planning guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files.
>
> === PLANNING GUIDANCE ===
> [Splice here: full text of the upstream superpowers:writing-plans SKILL.md. Green run only: also the full text of skills/planning-waves/SKILL.md.]
> === END GUIDANCE ===
>
> Spec — "notes" CLI (fresh Node.js project, no existing code, tests with node:test):
>
> 1. `lib/store.js`: `addNote(text)` appends `"<ISO timestamp> <text>\n"` to `notes.txt` and returns the written line.
> 2. `lib/search.js`: `searchNotes(term)` reads `notes.txt` and returns the array of lines containing `term` (case-insensitive).
> 3. `bin/notes.js`: command dispatcher — `node bin/notes.js add <text>` calls addNote and prints the written line; `node bin/notes.js search <term>` calls searchNotes and prints each match. Unknown commands print usage and exit 1.
>
> Write the complete implementation plan now. Reply with the plan as markdown only — do not create files and do not use any tools.

## Pass criteria

1. Every task carries a `**Dependencies:**` line in exactly one of the three forms: `none (completely independent)` / `Task N (reason)` / `Tasks N+M committed`.
2. The plan contains a `## Dispatch Map` section listing numbered waves of tasks.
3. No wave contains two tasks whose `**Files:**` lists share a path (the store task and the search task may share a wave; the dispatcher task may not join either).
4. The dispatcher task declares its dependency on the store and search tasks and sits in a later wave than both.
5. Each task's `**Interfaces:**` block pins exact names and signatures (e.g. `addNote(text)` returning the written line), not vague descriptions.
6. The plan header includes Goal, Architecture, and a Global Constraints section, and steps are checkboxes in test-first order (P5 contract complete).

## Baseline (red)

Run 2026-07-22 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`), upstream writing-plans only, isolation header in place.

- Output: a well-formed upstream-style plan — header (Goal/Architecture/Tech Stack/Global Constraints), 3 tasks with `**Files:**`/`**Interfaces:**` blocks and TDD checkbox steps, ending in upstream's subagent-vs-inline execution choice.
- Criterion 1 FAIL: no task carries any `**Dependencies:**` line.
- Criterion 2 FAIL: no `## Dispatch Map` section; the words "wave" and "dispatch" appear nowhere in a planning sense.
- Criteria 3+4 FAIL: no wave structure exists at all — tasks are implicitly sequential in written order, and project setup was folded into the store task, coupling the search task's test run to it.
- Criterion 5 PASS: interfaces pinned exactly (upstream already enforces this).
- Criterion 6 PASS: header and test-first checkbox steps present.
- Net: RED — the plan cannot drive parallel wave dispatch (fails criteria 1–4).

Note: an earlier run without the prompt's isolation header produced a partial dispatch-map paragraph — traced to the author's machine-global instructions leaking into the headless subagent, which is why the isolation header is part of the protocol.

## Result (green)

Run 2026-07-22 — same protocol, upstream writing-plans + planning-waves skill content spliced in.

- Criterion 1 PASS: Task 1 `**Dependencies:** none (completely independent)`; Task 2 `**Dependencies:** none (completely independent; file-disjoint from Task 1)` — the `none` form with an extra clause appended inside the parenthetical, judged an acceptable extension of the template, not a deviation; Task 3 `**Dependencies:** Tasks 1+2 committed (imports real addNote/searchNotes; …)` — the `Tasks N+M committed` form with a reason appended.
- Criterion 2 PASS: `## Dispatch Map` — Wave 1 = Tasks 1+2 (file-disjoint, no dependencies), Wave 2 = Task 3.
- Criterion 3 PASS: wave 1 file sets are disjoint (`package.json` + `lib/store.js` + `tests/store.test.js` vs `lib/search.js` + `tests/search.test.js`); the dispatcher shares no wave with either.
- Criterion 4 PASS: dispatcher declares Tasks 1+2 committed and sits alone in wave 2.
- Criterion 5 PASS: interfaces pinned exactly — `addNote(text, filePath='notes.txt') => string`, `searchNotes(term, filePath='notes.txt') => string[]`, `main(argv) => number`.
- Criterion 6 PASS: header (Goal/Architecture/Tech Stack/Global Constraints); checkbox steps in test-first order.
- Beyond the criteria, the skill's other mandates also appeared: an explicit Feasibility Gate with **Verdict: GO**, the agentic-workers line naming `devcycle:executing-waves` (upstream's execution choice not offered), and a closing devcycle Handoff block with pinned interfaces as carry-overs.
- Net: GREEN — all six criteria met.
