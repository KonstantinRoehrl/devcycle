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
7. Every declared dependency names WHAT is consumed — the specific interface or file (e.g. `Task 1 (consumes its addNote(text) interface)`) — or states its real ordering reason; no bare `Task N` / `Tasks N+M committed` with no reason attached. (`none (completely independent)` declares no dependency and is exempt.)
8. The plan states why the tasks sharing a wave are file-disjoint: the Dispatch Map entry (or the task bodies) names the same-wave tasks' disjoint file sets — e.g. `Wave 2: Task 1, Task 2 (file-disjoint — lib/store.js + its test vs lib/search.js + its test)` or a task-body clause like `file-disjoint from Task 1`. A bare `(file-disjoint)` tag with no identification of the sets fails.

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

## Regression (Task 12)

Run 2026-07-22 — full-pass regression against the committed text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; the init event confirmed `plugins: []`), sandbox rebuilt per Setup in a session-temp directory. Prompt: isolation header + upstream writing-plans 6.1.1 + committed planning-waves skill.

- Criterion 1 PASS (minor variance): this run produced four tasks (a project-scaffold task emerged); every task carries a `**Dependencies:**` line — `none (completely independent)`, `Task 1 committed (reason)` twice, and `Tasks 2+3 committed (reason)` — the committed forms with a reason appended, the same accepted extension the original green run recorded.
- Criterion 2 PASS: `## Dispatch Map` with three numbered waves.
- Criterion 3 PASS: the store and search tasks share wave 2 with disjoint file sets; the dispatcher joins neither.
- Criterion 4 PASS: dispatcher declares `Tasks 2+3 committed` and sits alone in the final wave.
- Criterion 5 PASS: exact signatures pinned (`addNote(text: string): string`, `searchNotes(term: string): string[]`, shared `NOTES_FILE` constant).
- Criterion 6 PASS: header (Goal/Architecture/Tech Stack/Global Constraints) and test-first checkbox steps; the skill's other mandates also appeared (`## Feasibility Gate` with **Verdict: GO**, the `devcycle:executing-waves` worker line, closing Handoff block).
- Net: GREEN — no regression.

## Regression (dry-run fixes)

Criteria 7–8 added 2026-07-23 for the skill's "Execution strategy — twin goals" contract (derived dependencies name what is consumed; same-wave file-disjointness stated explicitly). Both runs: fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth; init event confirmed `plugins: []`), empty sandbox, prompt per Setup with upstream writing-plans 6.1.1 spliced in.

**Baseline (red) — scripted run 2026-07-23 against the PREVIOUS committed planning-waves text** (pre-twin-goals, via `git show HEAD:skills/planning-waves/SKILL.md`):

- Criterion 7 PASS in red — an honest partial red: the run's one real dependency read `Tasks 1+2 committed (requires lib/store.js and lib/search.js to exist and export addNote/searchNotes)`; the old text's `Task 2 (consumes its X interface)` example already models a reason, so the model appended one unforced. The criterion pins as contract what was previously habit.
- Criterion 8 FAIL in red: the Dispatch Map read `Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)` — the bare template tag, with the disjoint file sets named nowhere (no task-body disjointness clause either).
- Net: RED on criterion 8.

**Result (green) — run 2026-07-23 against the twin-goals text (working tree):**

- Criterion 7 PASS: four tasks; every declared dependency names its consumption — `Task 0 (needs lib/ directory and package.json test script)` (twice), `Tasks 1+2 committed (dispatcher calls addNote and searchNotes directly)`; the scaffold task declares `none (completely independent)`.
- Criterion 8 PASS: `Wave 2: Task 1, Task 2 (both depend only on Task 0; file-disjoint — lib/store.js + test/store.test.js vs. lib/search.js + test/search.test.js)` — the disjoint file sets named in the Dispatch Map entry itself.
- Criteria 1–6 re-checked on the same run, all PASS: three declaration forms only (with the accepted reason-appended extension); `## Dispatch Map` with three numbered waves; wave-2 file sets disjoint and the dispatcher waving alone after `Tasks 1+2 committed`; exact signatures pinned (`addNote(text, notesFile = path.join(process.cwd(), 'notes.txt'))`, `searchNotes(term, notesFile = ...)`, `main(argv)` returning an exit code); header (Goal/Architecture/Tech Stack/Global Constraints) with test-first checkbox steps, plus Feasibility Gate **Verdict: GO** and the closing Handoff block.
- Net: GREEN — all eight criteria met.
