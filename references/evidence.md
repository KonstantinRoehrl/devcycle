# Evidence — classes, the file-backed contract, report and verdict shapes

The single owner of how devcycle proves a task did what it claims. A skill, command,
or agent that needs any of this names this file and does not restate it.

## The three evidence classes

Every task carries an `**Evidence:**` line naming the proof its implementation must
produce, in exactly one of these forms:

- `**Evidence:** red-green` — the task adds or changes behavior: verbatim failing (red)
  test output before the code, verbatim passing (green) output after. The default; use it
  whenever a failing test can express the task's outcome.
- `**Evidence:** green-green (behavior-preserving)` — refactors and other
  behavior-preserving changes, where no honest red state exists: the same suite command
  run green before the change and green after, both captured verbatim.
- `**Evidence:** convention (<command or procedure>)` — non-code tasks (docs, config) and
  repos with no test suite: the repo's own documented verification convention, its
  before/after output captured the same way — the before-capture command is the identical
  string used for after-capture, never a truncated subset, even when both exit 0.

The class is planning's call, not the implementer's: derive it from what the task actually
changes, and never declare `red-green` where no failing test can exist — that forces the
implementer to fake a red or the reviewer to reject correct work.

## Preloading a class into a brief

The content a dispatching stage splices into a task's brief, per class: `red-green` at
`thorough`, the relevant **superpowers:test-driven-development** content (REQUIRED);
`red-green` at `lean`/`standard`, an excerpt carrying exactly three things and nothing beyond
them — write the failing test first, run it and capture the red output before writing
implementation code, then write only enough code to pass and capture the green output;
`green-green` and `convention`, no TDD splice but the exact suite or convention command their
before/after evidence must run. Plus any convention-skill content the task needs — never an
instruction for the subagent to fetch a skill itself, which it can silently skip where injected
content cannot. Evidence is never profile-conditional; only `<N>` varies.

## File-backed evidence

- Paths: `.devcycle/evidence/<task-id>-before.txt`, `.devcycle/evidence/<task-id>-after.txt`.
  `<task-id>` is the plan's task number on the full pipeline, `fast` on the fast path,
  `sweep` on the sweep path.
- When the verification command chains multiple steps with `&&`, brace-group them before
  redirecting — `{ c1 && c2; } > file 2>&1` — never the bare `c1 && c2 > file 2>&1` form,
  which redirects only the last command and silently drops every earlier command's output.
- The captured command for `-before.txt` and `-after.txt` is always the repo's whole
  verification gate; capturing fewer commands than the gate runs in either file is a
  declared deviation. The normal `red-green` case is a task whose own new tests fail that
  whole gate, so `-before.txt` exits non-zero honestly. When a task's red is instead a
  subset inside an otherwise-green suite — new tests added to a file that's part of a
  green whole — the whole-gate `-before.txt` legitimately exits 0; capture the honest
  subset red as a third file, `.devcycle/evidence/<task-id>-red.txt`, running just the
  subset command, before any implementation code is written.

The report itself is a file on the same principle: the implementer writes it to
`.devcycle/reports/<task-id>.md` in the shape below, and the dispatch returns only the short
envelope `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` defines (`## Return envelopes`). A
report pasted into the dispatch's reply instead of written to that path is the same defect as
an inlined evidence tail.

- Implementer report shape:

```markdown
## Task report
- Files changed: <list>
- Evidence: <red-green | green-green | convention> | cmd: <exact command>
- Before: <path> (exit <n>)
- After: <path> (exit <n>)
- Tail (after, last <N> lines):
  <N lines>
- Deviations: <list, or none>
- On-device items: <list, or none>
```

- `<N>` is pinned per dispatch in the brief as `**Evidence tail:** <N>`, sourced from the
  profile.
- On the sweep path no implementer exists: the coordinator writes `sweep-before.txt` from
  its own pre-sweep verify run on the clean tree, captured before the sweep script is
  invoked, and `sweep-after.txt` from step 5's real-tree verify; `.devcycle/sweep-report.json`
  keeps the per-file detail.

## Reviewer verdicts

The reviewer reads the named evidence files directly rather than trusting the tail in the
report. Reject when:

- a named evidence file is missing or empty;
- an exit status contradicts the declared class with no explanation for it — a `red-green`
  "before" that exited 0 without an accompanying `<task-id>-red.txt` subset-red file, or a
  `green-green` "before" that did not exit 0;
- the class mismatches the diff.

## Why the evidence lives in files

The coordinator's green gate re-runs the command itself and reads the exit status, so an
inlined copy of the output duplicated ground truth at the cost of a whole suite's output per
task per round.
