# Graphify Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `devcycle:executing-waves` to implement this plan wave-by-wave via subagent implementers. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, read-only "check for an existing graphify graph before researching" step to `scoping-interview` and `planning-waves`, each guarded by scenario-test evidence, so devcycle's research steps draw on a target repo's graphify graph when present and behave exactly as today when absent.

**Architecture:** Two independent, independently-worded additions per the approved spec (no shared snippet): `scoping-interview` extends its "Research BEFORE questions" discipline item; `planning-waves` extends its "Reuse before rebuild" section. Each carries its own scenario test file per `CONTRIBUTING.md`'s harness — real headless `claude -p` runs, red baseline then green result, covering both the graph-present and graph-absent branches in one file. A third task updates the two README stage bullets once both skill texts are settled, sequenced after purely to avoid two tasks touching `README.md` in the same wave.

**Tech Stack:** Markdown skill files (Claude Code plugin), Node.js validator scripts (`scripts/validate.mjs`, `scripts/redaction-check.mjs`), scenario harness driven by headless `claude -p` runs.

## Global Constraints

- Read-only orientation only: neither skill may trigger a `graphify` build or `--update` as a side effect of scoping or planning (spec §2 hard constraint).
- Detection is skill-presence only (is `graphify` listed among this session's available skills) plus a target-repo file check (`graphify-out/` and/or root `GRAPH_REPORT.md`) — never a bare `graphify` CLI PATH check (spec §6).
- Applies to the target repo devcycle is operating on, never to the devcycle repo itself.
- Fallback is always silent: no note to the user, no error, whether the skill is absent, the graph is absent, or the graph is stale/thin for the area in question.
- Text lives inline, independently worded per skill — no new shared snippet file, no new skill (spec §3; duplication is accepted).
- No `CHANGELOG.md` edit — the changelog and version bump come from the squash-merge PR title (a `feat:` for this change), per `CONTRIBUTING.md`.
- Every behavior change ships with scenario evidence per `CONTRIBUTING.md`'s harness: fresh headless `claude -p` runs, isolated `CLAUDE_CONFIG_DIR` (auth only — no installed plugins, no machine-global instructions — confirm `plugins: []` on the init event), matching the "baseline-hygiene protocol" already used throughout `tests/scenarios/`.
- Before considering any task done: `node scripts/validate.mjs` and `node scripts/redaction-check.mjs` both exit clean (no absolute machine home-directory paths in any new file, balanced code fences, frontmatter untouched).

---

## Feasibility Gate

**Verdict: GO.**

- The check itself is two cheap, real operations: (a) is a skill literally named `graphify` present in this session's available-skills listing — a prompt-level fact, no repo I/O; (b) does the target repo have `graphify-out/` and/or a root `GRAPH_REPORT.md` — a plain filesystem check (`ls`/`test -e`). Neither invents an API; both are things a running agent can already do with existing tools (skill-list awareness, `Read`/`Bash`).
- No dependency on graphify internals, query syntax, or CLI — the spec scopes this to skill-presence + file-presence, deferring "run graphify queries" to prose the agent already follows once it's reading a `graphify` skill's own instructions (out of scope here).
- The scenario-harness convention (`tests/scenarios/<skill>/<name>.md`, red/green via `claude -p`) is already exercised by 10+ existing scenario files in this repo — reused, not invented.
- No spike needed; proceeding to detailed planning.

---

### Task 1: graphify orientation — scoping-interview

**Files:**
- Modify: `skills/scoping-interview/SKILL.md` (discipline item 1, "Research BEFORE questions")
- Create: `tests/scenarios/scoping-interview/graphify-orientation.md`

**Interfaces:**
- Consumes: none.
- Produces: none consumed by later tasks — Task 3's README clause paraphrases this skill's committed behavior in prose but does not import any symbol or exact string from it.

**Dependencies:** none (completely independent)

- [ ] **Step 1: Write the scenario file's Setup, Subagent prompt, and Pass criteria (no results yet)**

Create `tests/scenarios/scoping-interview/graphify-orientation.md`:

````markdown
# Scenario: graphify-orientation
- Skill under test: devcycle:scoping-interview
- Type: discipline

## Setup

Build a throwaway "shelfie" sandbox in a temp directory: a tiny Node.js inventory CLI.

- `package.json` — name `shelfie`, `type: module`, no dependencies.
- `lib/inventory.js` — exports `addItem(name, qty)`, `removeItem(name)`, `listItems()`, persisting to `inventory.json` in the cwd.
- `bin/shelfie.js` — dispatches `add`/`remove`/`list` to `lib/inventory.js`.
- `README.md` — one line: "shelfie — a tiny inventory CLI."
- `git init`, `git add -A`, `git commit` so the sandbox is a real repo.

For the **graph-present** runs, additionally add before committing:
- `graphify-out/manifest.json` — `{"nodes": 4, "generated": "2026-07-20"}`.
- `GRAPH_REPORT.md` (repo root):

  ```markdown
  # Graph Report — shelfie

  ## God Nodes
  - `lib/inventory.js` — central module; every mutation (`addItem`, `removeItem`) and
    read (`listItems`) flows through it. Consumed by `bin/shelfie.js`.

  ## Communities
  - Core inventory (`lib/inventory.js`, `bin/shelfie.js`)
  ```

Run three fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh `CLAUDE_CONFIG_DIR` holding only auth — no installed plugins, no machine-global instructions; confirm `plugins: []` on the init event), each from its own sandbox copy in a session-temp directory:

- **Baseline (red):** graph-present sandbox, guidance block = current committed `skills/scoping-interview/SKILL.md` only (no graphify awareness).
- **Result A (green, graph present):** graph-present sandbox, guidance block = working-tree `skills/scoping-interview/SKILL.md` (this task's change).
- **Result B (green, graph absent):** same sandbox WITHOUT `graphify-out/`/`GRAPH_REPORT.md`, guidance block = working-tree `skills/scoping-interview/SKILL.md`.

## Subagent prompt

> You are a coding agent working in this repository. A `graphify` skill is listed among your available skills this session, described as: "graphify: turns a codebase into a queryable knowledge graph (god nodes, communities); read-only query tools available, no build step invoked here." Assume no other skills exist. The user has just sent the request below. Produce your single next response to the user, exactly as you would send it. Do not simulate further turns.
>
> === GUIDANCE (follow exactly) ===
> [Splice here: full text of skills/scoping-interview/SKILL.md — committed text for Baseline, working tree for Results A/B.]
> === END GUIDANCE ===
>
> User request: "shelfie should warn me before I run out of an item"

(For Result B only, drop the `graphify` skill-availability sentence AND omit `graphify-out/`/`GRAPH_REPORT.md` from the sandbox — testing the "no graph exists yet" fallback branch.)

## Pass criteria

1. (Result A only) The response's research is visibly informed by `GRAPH_REPORT.md`'s content — it names or paraphrases the "God Node" framing for `lib/inventory.js` (e.g. "central module every mutation flows through") — not solely narrated as a raw read of `lib/inventory.js`'s source.
2. (Result A only) The response never proposes or narrates running a graphify build/update/refresh (no "let me regenerate the graph" or equivalent) — read-only.
3. (Result A only) The response does not call special attention to graphify usage as a notable event to the user (no "Since a graphify graph exists, I'll use it" meta-commentary) — it incorporates the finding quietly, same tone as any other research finding.
4. (Result B only) The response contains no mention of `graphify`, `GRAPH_REPORT.md`, or "graph" anywhere — behavior identical to a run with no graphify awareness at all.
5. (Results A and B) The scoping-interview batching discipline still holds: exactly one batch of 1–4 questions, slot 1 a summary confirmation, every question with concrete options plus Other, no implementation or assumed answers.
6. (Baseline only) The response shows no graph-specific research framing (no "God Node"/community language) even though `GRAPH_REPORT.md` exists in the sandbox — establishing the contrast with Result A.
````

- [ ] **Step 2: Run the Baseline (red) headless session and record it**

Build the graph-present sandbox per Setup, splice the **committed** `skills/scoping-interview/SKILL.md` (`git show HEAD:skills/scoping-interview/SKILL.md`) into the prompt, run headless per the baseline-hygiene protocol. Append a `## Baseline (red)` section to the scenario file with the run date, model, isolation confirmation, and a criterion-by-criterion note — expect criterion 6 to pass (no graph-aware framing) since the committed skill has no graphify logic yet.

- [ ] **Step 3: Implement the skill text change**

In `skills/scoping-interview/SKILL.md`, extend discipline item 1 (currently: "**Research BEFORE questions.** Read the relevant code and docs first, so every question is informed by what the repo already shows. Never ask what the repo can answer.") by appending, in the same numbered item:

```
   If a `graphify` skill is listed among this session's available skills, check the
   target repo (never this plugin's own repo) for `graphify-out/` and/or a root
   `GRAPH_REPORT.md` before falling back to file-by-file reading: when present, read
   the report and query the graph for the research this step needs; when absent, or
   too stale/thin for the area in question, research exactly as before. This is
   read-only — never trigger a graphify build or `--update` as a side effect of
   scoping — and silent either way: no note to the user about whether a graph was
   used.
```

- [ ] **Step 4: Run Result A (green, graph present) and Result B (green, graph absent), record both**

Same protocol as Step 2, working-tree skill text, once against the graph-present sandbox and once against the graph-absent sandbox (Result B also drops the graphify-availability prompt sentence, per the scenario's note). Append `## Result A (green, graph present)` and `## Result B (green, graph absent)` sections with dated evidence against every applicable criterion above. All criteria must PASS; if any fails, fix the skill text (Step 3) and re-run before proceeding.

- [ ] **Step 5: Verify repo-wide checks**

Run:
```bash
node scripts/validate.mjs
node scripts/redaction-check.mjs
```
Expected: both print their `... ok` line and exit 0. Fix any absolute-path leakage or unbalanced fence in the new scenario file before continuing.

---

### Task 2: graphify orientation — planning-waves

**Files:**
- Modify: `skills/planning-waves/SKILL.md` ("Reuse before rebuild" section)
- Create: `tests/scenarios/planning-waves/graphify-orientation.md`

**Interfaces:**
- Consumes: none.
- Produces: none consumed by later tasks (see Task 1's note — Task 3 paraphrases, doesn't import).

**Dependencies:** none (completely independent)

- [ ] **Step 1: Write the scenario file's Setup, Subagent prompt, and Pass criteria (no results yet)**

Create `tests/scenarios/planning-waves/graphify-orientation.md`, reusing the same "shelfie" sandbox recipe as Task 1's scenario (built independently here — duplication is accepted per the spec, so this task's brief carries everything needed on its own):

````markdown
# Scenario: graphify-orientation
- Skill under test: devcycle:planning-waves
- Type: discipline

## Setup

Build a throwaway "shelfie" sandbox in a temp directory: a tiny Node.js inventory CLI.

- `package.json` — name `shelfie`, `type: module`, no dependencies.
- `lib/inventory.js` — exports `addItem(name, qty)`, `removeItem(name)`, `listItems()`, persisting to `inventory.json` in the cwd.
- `bin/shelfie.js` — dispatches `add`/`remove`/`list` to `lib/inventory.js`.
- `README.md` — one line: "shelfie — a tiny inventory CLI."
- `git init`, `git add -A`, `git commit` so the sandbox is a real repo.

For the **graph-present** runs, additionally add before committing:
- `graphify-out/manifest.json` — `{"nodes": 4, "generated": "2026-07-20"}`.
- `GRAPH_REPORT.md` (repo root):

  ```markdown
  # Graph Report — shelfie

  ## God Nodes
  - `lib/inventory.js` — central module; every mutation (`addItem`, `removeItem`) and
    read (`listItems`) flows through it. Consumed by `bin/shelfie.js`.

  ## Communities
  - Core inventory (`lib/inventory.js`, `bin/shelfie.js`)
  ```

Run three fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh `CLAUDE_CONFIG_DIR` holding only auth — no installed plugins, no machine-global instructions; confirm `plugins: []` on the init event), each from its own sandbox copy in a session-temp directory. The prompt splices the upstream `superpowers:writing-plans` SKILL.md (6.1.1) plus the guidance under test, matching this repo's existing planning-waves scenario convention (see `tests/scenarios/planning-waves/feasibility-gate.md`):

- **Baseline (red):** graph-present sandbox, guidance = upstream writing-plans + current committed `skills/planning-waves/SKILL.md` (no graphify awareness).
- **Result A (green, graph present):** graph-present sandbox, guidance = upstream writing-plans + working-tree `skills/planning-waves/SKILL.md`.
- **Result B (green, graph absent):** sandbox WITHOUT `graphify-out/`/`GRAPH_REPORT.md`, guidance = upstream writing-plans + working-tree `skills/planning-waves/SKILL.md`.

## Subagent prompt

> You are planning an implementation. Follow ONLY the planning guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files. A `graphify` skill is listed among your available skills this session, described as: "graphify: turns a codebase into a queryable knowledge graph (god nodes, communities); read-only query tools available, no build step invoked here." Assume no other skills exist.
>
> === PLANNING GUIDANCE ===
> [Splice here: full text of the upstream superpowers:writing-plans SKILL.md, plus the guidance under test — committed skills/planning-waves/SKILL.md for Baseline, working tree for Results A/B.]
> === END GUIDANCE ===
>
> Spec — "low-stock alerts" (extends the existing shelfie inventory CLI; tests with `node --test`):
>
> 1. `shelfie alert-threshold <item> <qty>` records a low-stock threshold for `<item>` in a new `thresholds.json`.
> 2. `shelfie list` additionally flags any item at or below its threshold.
> 3. Wire both into the existing `bin/shelfie.js` dispatcher.
>
> Reply with markdown only — do not create files and do not use any tools other than reading the repo.

(For Result B only, drop the `graphify` skill-availability sentence AND omit `graphify-out/`/`GRAPH_REPORT.md` from the sandbox.)

## Pass criteria

1. (Result A only) The plan's "Reuse before rebuild" reasoning is visibly informed by `GRAPH_REPORT.md` — it names or paraphrases the "God Node" framing for `lib/inventory.js` — not solely narrated as a raw read of `lib/inventory.js`'s source.
2. (Result A only) The reply never proposes or narrates running a graphify build/update/refresh — read-only.
3. (Result A only) The reply does not call special attention to graphify usage as a notable event to the user — incorporated quietly, same tone as any other research finding.
4. (Result B only) The reply contains no mention of `graphify`, `GRAPH_REPORT.md`, or "graph" anywhere — identical to a run with no graphify awareness.
5. (Results A and B) The rest of planning-waves' contract still holds: an explicit feasibility verdict before task detail, `**Dependencies:**` on every task, and a `## Dispatch Map` grouping file-disjoint, dependency-ready waves.
6. (Baseline only) The reply shows no graph-specific research framing even though `GRAPH_REPORT.md` exists in the sandbox — establishing the contrast with Result A.
````

- [ ] **Step 2: Run the Baseline (red) headless session and record it**

Build the graph-present sandbox per Setup, splice upstream writing-plans + the **committed** `skills/planning-waves/SKILL.md` (`git show HEAD:skills/planning-waves/SKILL.md`), run headless per the baseline-hygiene protocol. Append a `## Baseline (red)` section with dated evidence — expect criterion 6 to pass (no graph-aware framing yet).

- [ ] **Step 3: Implement the skill text change**

In `skills/planning-waves/SKILL.md`, extend the "Reuse before rebuild" section (currently: "Each task names the existing modules, helpers, or components it extends (found by searching the codebase during planning). A task that introduces a new abstraction must state why no existing one fits.") by appending a new paragraph:

```
Before searching file-by-file, check the target repo (never this plugin's own repo)
for an existing graphify graph — `graphify-out/` and/or a root `GRAPH_REPORT.md` —
whenever a `graphify` skill is listed among this session's available skills: if
present, read the report and query the graph for the structural picture (modules,
existing patterns, what already exists) this step needs, before falling back to
plain search when the graph is absent, stale, or too thin for the area in question.
Read-only here too — never trigger a graphify build or `--update` — and silent
either way: no note to the user about whether a graph was used.
```

- [ ] **Step 4: Run Result A (green, graph present) and Result B (green, graph absent), record both**

Same protocol as Step 2, working-tree skill text, once against each sandbox variant (Result B also drops the graphify-availability prompt sentence). Append `## Result A (green, graph present)` and `## Result B (green, graph absent)` sections with dated evidence against every applicable criterion. All criteria must PASS; if any fails, fix the skill text (Step 3) and re-run before proceeding.

- [ ] **Step 5: Verify repo-wide checks**

Run:
```bash
node scripts/validate.mjs
node scripts/redaction-check.mjs
```
Expected: both print their `... ok` line and exit 0.

---

### Task 3: README stage-bullet clauses

**Files:**
- Modify: `README.md:54-57` (Scoping stage bullet), `README.md:60-65` (Planning stage bullet)

**Interfaces:**
- Consumes: none (the exact clause wording is pinned below, independent of Tasks 1–2's runtime output).
- Produces: none.

**Dependencies:** Tasks 1+2 committed (real ordering constraint, not consumption — this task never shares a file with Task 1 or 2, but is sequenced into its own wave so it isn't racing anything for `README.md`)

- [ ] **Step 1: Add the Scoping bullet clause**

In `README.md`, item 1 ("**Scoping**"), insert one clause before the final period:

Before:
```
1. **Scoping** — batched interview that turns your request into a precise, well-structured
   goal: you answer questions about intent and desired outcomes; devcycle researches the
   repo itself to establish what the change touches and confirms that picture with you.
   Skipped when your input is already concrete.
```

After:
```
1. **Scoping** — batched interview that turns your request into a precise, well-structured
   goal: you answer questions about intent and desired outcomes; devcycle researches the
   repo itself to establish what the change touches and confirms that picture with you —
   research draws on an existing graphify graph when one is available. Skipped when your
   input is already concrete.
```

- [ ] **Step 2: Add the Planning bullet clause**

In `README.md`, item 3 ("**Planning**"), insert the same clause before its final period:

Before:
```
3. **Planning** — a feasibility check, then an implementation plan that doubles as the
   execution strategy: the work is cut into small, self-contained tasks — each implementable
   from its own brief alone, so every subagent works with a small context — dependencies are
   derived from what each task consumes, and everything not forced into sequence by a real
   dependency is grouped into *waves* of file-disjoint tasks that run in parallel. You
   approve the plan.
```

After:
```
3. **Planning** — a feasibility check, then an implementation plan that doubles as the
   execution strategy: the work is cut into small, self-contained tasks — each implementable
   from its own brief alone, so every subagent works with a small context — dependencies are
   derived from what each task consumes, and everything not forced into sequence by a real
   dependency is grouped into *waves* of file-disjoint tasks that run in parallel — research
   draws on an existing graphify graph when one is available. You approve the plan.
```

- [ ] **Step 3: Verify repo-wide checks**

Run:
```bash
node scripts/validate.mjs
node scripts/redaction-check.mjs
```
Expected: both print their `... ok` line and exit 0.

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
- Wave 2: Task 3 (needs Tasks 1+2 committed — file-conflict avoidance on `README.md`, not consumption)
</content>
