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

## File-backed evidence

- Paths: `.devcycle/evidence/<task-id>-before.txt`, `.devcycle/evidence/<task-id>-after.txt`.
  `<task-id>` is the plan's task number on the full pipeline, `fast` on the fast path,
  `sweep` on the sweep path.
- When the verification command chains multiple steps with `&&`, brace-group them before
  redirecting — `{ c1 && c2; } > file 2>&1` — never the bare `c1 && c2 > file 2>&1` form,
  which redirects only the last command and silently drops every earlier command's output.

The report itself is a file on the same principle: the implementer writes it to
`.devcycle/reports/<task-id>.md` in the shape below, and what the dispatch returns to the
coordinator is the short envelope `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` defines
(`## Return envelopes`) — the path plus the few counts the coordinator must act on without
opening the file. A report pasted into the dispatch's reply instead of written to that path is
the same defect as an inlined evidence tail.

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

## Scenario evidence

`CONTRIBUTING.md`'s "The scenario harness" section owns the scenario file shape and its
`## Baseline (red)` / `## Result (green)` sections; this settles one contested point about
them. Both sections are **required** in every scenario file, including `Type: discipline`
scenarios — never omitted. When a scenario is authored without a run having been executed,
the sections carry honest "Not yet run" placeholders instead. (Two reviewers previously
ruled opposite ways on this; the omission side is rejected and must not be reintroduced.)

## Reviewer verdicts

The reviewer reads the named evidence files directly rather than trusting the tail in the
report. Reject when:

- a named evidence file is missing or empty;
- an exit status contradicts the declared class — a `red-green` "before" that exited 0, or
  a `green-green` "before" that did not exit 0;
- the class mismatches the diff.

## Why the evidence lives in files

The coordinator's green gate re-runs the command itself and reads the exit status, so an
inlined copy of the output duplicated ground truth at the cost of a whole suite's output
per task per round.
