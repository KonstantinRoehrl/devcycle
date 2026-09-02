# Evidence — classes, the file-backed contract, report and verdict shapes

The single owner of how devcycle proves a task did what it claims. A playbook, command,
or agent that needs any of this names this file and does not restate it.

## The three evidence classes

Every task carries an `**Evidence:**` line naming the proof its implementation must
produce, in exactly one of these forms:

- `**Evidence:** red-green` — the task adds or changes behavior: verbatim failing (red) test
  output before the code, verbatim passing (green) output after. The default; use it whenever a
  failing test can express the task's outcome. The red failure must be an **assertion/behavior**
  failure that discriminates the missing behavior — a test that fails only because a symbol does
  not exist yet (an import/collection error) and would then pass vacuously once the symbol
  exists does not satisfy red-green. When the symbol must exist first, write a minimal stub so
  the red is a genuine assertion failure against a naive implementation.
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

## Authored claims

Every authored artifact — a plan, a dispatch brief, an implementer report, a review finding, a
diagnosis writeup — states a load-bearing claim about repo or source state (disk state,
library/vendor behavior, a count, whether something was "already done", CI behavior, a root
cause) in exactly one of two forms:

- **verified** — the claim carries the command or grep that proves it and the output it
  produced. "I verified X" without a captured command backing it is not a verified claim.
- **assumption** — the claim is explicitly labeled a belief or assumption, not fact.

It is never stated as bare fact. `findings.md`'s
`Confidence: verified | suspected` field is this contract's instance on the review surface; a
finding is the same discipline said in that file's own shape.

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
- Each `-before.txt`/`-after.txt`/`-red.txt` capture begins with the exact command as its
  first line: `{ echo "# devcycle-cmd: <the exact command>"; <the exact command>; } > file 2>&1`.
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/evidence-completeness-check.mjs"` reads that header from
  the before and after files and rejects the report when the two command strings differ — a
  narrower before-command than after-command is a partial-gate defect even when both exit 0.
- The captured command for `-before.txt` and `-after.txt` is always the repo's whole
  verification gate; capturing fewer commands than the gate runs in either file is a
  declared deviation.
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/evidence-completeness-check.mjs" <report>` mechanizes
  the narrow-selector subset of this rule — a `cmd:` naming one test file or carrying a
  test-name filter flag. The concurrent-wave case — a whole-suite red caused by a sibling's
  uncommitted edit rather than the task under review — is mechanized by **the concurrent-sibling
  guard** `node "${CLAUDE_PLUGIN_ROOT}/scripts/foreign-change-check.mjs" <task files>`, which
  `playbooks/executing-waves.md` step 6 runs on a green-gate failure to defer a sibling-caused
  red instead of attributing it. `evidence-completeness-check.mjs` also requires an
  `(exit <n>)` status — read from the report line, not file contents — on any present
  `- Before:`/`- After:` line of any class; a `red-green`/`green-green` report additionally
  needs its `- After:` file to carry a test-runner summary line. The normal
  `red-green` case is a task whose own new tests fail that
  whole gate, so `-before.txt` exits non-zero honestly. When a task's red is instead a
  subset inside an otherwise-green suite — new tests added to a file that's part of a
  green whole — the whole-gate `-before.txt` legitimately exits 0; capture the honest
  subset red as a third file, `.devcycle/evidence/<task-id>-red.txt`, running just the
  subset command, before any implementation code is written.
- **Scope every capture to the task's own `**Files:**` list**, as a pathspec — `git diff -- <the
  task's files>`, never a bare `git diff`. Concurrent implementers share one checkout, and wave
  formation guarantees no two of them touch the same file, so a file-scoped capture sees exactly
  this task's work and nothing else.
- **`git stash` is forbidden.** It reverts siblings' uncommitted work across the shared checkout.
  With the capture scoped above there is nothing it could be needed for; using it is a defect, not
  a judgment call.

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
- Claims: every prose claim about source state carries its backing command, or is labeled an assumption (per § Authored claims); none stated as bare fact
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
- a `red-green` before/red whose failure is a bare missing-symbol, import, or collection error
  rather than a discriminating assertion failure — the test never proved the behavior was absent;
- the class mismatches the diff.
- a red test is explained as **pre-existing / flaky / unrelated / environmental** without a logged
  reproduction. Such an explanation is an unverified authored claim (§ Authored claims); accept it
  only when the verdict cites an evidence artifact
  (`.devcycle/evidence/<task-id>-flaky.txt`, on the file-backed principle) carrying the failing test
  run against **clean HEAD** and against **the change** at the **same iteration count** with their
  actual pass/fail counts (the "clean 20/20; change 6/20" shape), and the #167 foreign-change check
  ruled out concurrent-sibling pollution. The reviewer reads that file rather than trusting the
  claim.

A reviewer returns its verdict in this shape:

```markdown
Verdict: accept | needs-changes

1. [severity] <finding, symptom first>
2. [severity] <finding, symptom first>
...
```

## Why the evidence lives in files

The coordinator's green gate re-runs the command itself and reads the exit status, so an
inlined copy of the output duplicated ground truth at the cost of a whole suite's output per
task per round.
