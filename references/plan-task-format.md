# Plan task format

How one task of a plan is written, by whoever drafts it: `playbooks/planning-waves.md` inline, or a
drafter on the delegated path (`references/delegated-planning.md`). It binds under every engine.

## The task block

**Task template — each task carries, in this order:** an H3 `Task N: <Component Name>`; `**Files:**`
(Create / Modify, with `path.py:123-145` line ranges where they help / Test; a `{a,b}` brace list
declares one path per alternative, and outside the comma list right after a `Create:`/`Modify:`/`Test:`
label an extensionless path counts only as a code span); `**Interfaces:**` (Consumes
— what this task uses from earlier tasks, exact signatures; Produces — what later tasks rely on, exact
function names and parameter and return types); the declaration lines below, an optional
`**Detail:**` line (No placeholders), plus a
`**Quality constraints:**` line — the ids (`QC1, QC3`) of the plan header's `## Quality Constraints`
section whose subject the task's own `**Files:**` touch, or `none` when no id's subject is touched — and
a `**Lessons:**` line right after it, emitted empty by
planning and filled with the task's matched lessons by `task-dispatch.mjs` at dispatch; then
`- [ ]` steps carrying the exact command and the expected output inline, and the code the task's detail level pins (No placeholders).

**Derive each Files block.** Before writing a task's `**Files:**`, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/blast-radius-check.mjs" --scan <changed-file…> [--symbol <name>…]`
on the files it modifies. It walks every text code file and matches each declared symbol and the
basename, with or without its extension; `--symbol` adds a name it misses. Every consumer, subclass
and test it lists, and each paired test it lists under a referencer, goes into the block, or gets a `Blast-radius override` line with a reason. Advisory: `plan-check.mjs` still checks the block, and its `gateRules` leg adds the files the repo's own `tests/fixtures/gate-rules.json` requires.

**No placeholders.** None of these may appear: "TBD", "TODO", "implement later", "fill in details";
"add appropriate error handling" / "add validation" / "handle edge cases"; "write tests for the above"
without the test code; a back-reference such as "similar to Task N" (tasks are read out of order, and
concurrently); a reference to a type, function, or method no task defines. A `red-green` task pins its
full `**Interfaces:**` block (exact signatures and constants), its complete failing test code (every
case) in a fenced block, and its exact gate commands with expected red and green output; its
implementation steps are prose. `**Detail:** code-pinned — <reason>` opts into a full implementation
body, for an algorithm the signature and tests leave open; `interface-pinned — <reason>` is still
accepted. `green-green` and doc-only tasks keep their shape. A Consumes
item drawn from another task reads `- Consumes (Task N): <that task's Produces text, verbatim>`.

**Steps.** Each step is one action,
2–5 minutes of work, ordered as the evidence class requires — for `red-green`: write the failing test /
run it and confirm red / write the minimal code / run it and confirm green, opened by a step that writes a minimal
stub when the task creates the module under test, so the red is an assertion failure and not a missing module; for `green-green`, the baseline
suite run is step 1. Never a commit step.

## The three per-task declaration lines

- `**Dependencies:**` — **derived, not decreed**: a task depends on exactly the tasks whose produced
  interfaces or files it consumes, nothing more, unless a real ordering constraint exists that
  consumption doesn't capture (a migration before schema users, a destructive step last), declared
  with its reason like any other dependency; anything not forced into sequence stays parallel. The
  line takes exactly one of `none (completely independent)`, `Task 2 (consumes its X interface)`, or
  `Tasks 1+4 committed`.
- `**Evidence:**` — read the three classes and their exact declaration forms from
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/evidence.md the-three-evidence-classes`; use those forms verbatim.
- `**Execution:** sweep` — optional, and declared only when the task is one uniform edit rule applied
  identically across its whole file list AND the task body pins all three sweep parameters verbatim:
  the instruction, the concrete file list, and the verifyCommand. Executing-waves then runs the task
  through `workflows/mechanical-sweep.js` instead of dispatching an implementer, so the evidence
  class stays orthogonal and is typically `green-green (behavior-preserving)`. Any per-file judgment
  in the rule disqualifies the marker; a normal implementer takes the
  task. Wave placement rules are unchanged.

## Per-task checks

Run on each task before it joins the plan, fixing findings inline:

1. **Placeholder scan:** search the task for the failures above and fix them.
2. **Factual-claim accuracy:** every load-bearing plan-authored claim — file/section targets,
   locked "must show no changes" regions, verification greps, counts — was checked by running
   the proving command/grep and citing its result, or is marked an assumption; never stated as
   bare fact (`references/evidence.md` § Authored claims). Its mechanized backstop is the plan gate's
   `authoredClaims` leg — a blocking lint that flags an unguarded `path.ext:line` reference or a
   bare count claim, cleared by a `(verified: <cmd>)` or `(assumption)` marker on the same or an
   adjacent line.
3. **Assumed-tooling and pinned-code cross-check:** every tool or pattern a brief assumes (mock approach, a lint gate such as `prettier --check`, a named test-helper identifier) exists and is accepted by this repo's toolchain — an invented identifier or rejected pattern is an unverified claim (item 2); verify each against the repo. Every command a step prescribes must also be one a guarded dispatch may run: `hooks/block-destructive-git.mjs` decides, and the plan gate's `briefCompleteness` leg notes each one it denies. For each task, run every side-effect-free command a brief pins, inline or fenced, and compare each pinned block with the quality-constraint ids its task lists. Inline commands carry no gate; dry-running them is this item's job alone.
4. **Per-draft gate:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" --draft <task file>`. A task joins the plan only once it passes or carries an override line. A path whose producer is a named, undrafted dependency (no `tasks/task-<n>.md` yet) is deferred to the whole-plan gate; any other needs a `Consumes (Task N)` code span or `- Citation override: <path> — <reason>`.
