# Evidence — classes, the file-backed contract, report and verdict shapes

<!-- evidence-contract-version: 2 -->

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
- ``**Evidence:** convention (`<command>`)`` — non-code tasks (docs, config) and
  repos with no test suite: the repo's documented verification command as exactly one code span,
  its before/after output captured the same way — both run the identical, untruncated command,
  even if both exit 0. Its `cmd:` may also be the plan's `**Verification gate:**`.

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

`node "${CLAUDE_PLUGIN_ROOT}/scripts/authored-claims-check.mjs" <file>` mechanizes the
line-reference and count-claim subset of this rule: it exits 0 when clean and 1 on an unverified
line-reference or count claim, and a flagged claim clears by carrying a `(verified: <cmd>)` or
`(assumption)` marker on its own or an immediately adjacent line. It skips the lines under a
report's `- Tail (…):` field, which are captured output, not prose. Superlative and uniqueness
claims are the reviewer's judgment, not linted.

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
- Every `-before.txt`/`-after.txt`/`-red.txt` capture is written by
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-evidence.mjs" --task <task-id> --phase before|after|red [--cmd "<command>"]`,
  never by a hand-written redirect. It runs the command through `sh -c`, writes
  `# devcycle-cmd: <the string it ran>`, the combined output and `# exit <n>`, and prints the
  report lines to copy; `cmd:` is its printed string, byte for byte. Without `--cmd` it runs the
  task's gate command: a convention task's parenthetical, any other task's plan-header
  `**Verification gate:**`. `--cmd` is required for `red` and for a task no plan names (`fast`,
  `sweep`). A before/after capture whose `--cmd` is not the gate needs a `- Narrowing:` line. **Before and after:**
  the two headers are identical, or — `red-green`/`green-green` only — the before is the task's gate
  and the after is the report's `cmd:`, carrying the scope a `- Narrowing:` line declares (a sibling's
  uncommitted red forced a narrower after). `evidence-completeness-check.mjs <report> --task <task-id>`
  rejects any other pair, naming the half that failed, an after header that differs from `cmd:`, and a
  `cmd:` that differs from the gate with no `- Narrowing:` line. A capture blocks until its command exits: run it in the foreground under the
  Bash tool's `timeout: 600000`, or, when it can run longer, in the background and wait for its
  completion notification. Never wait by polling an evidence file or its marker line.
- The captured command for `-before.txt` and `-after.txt` is the repo's whole
  verification gate, except in a concurrent wave: a brief carrying a `**Capture command:**` line
  captures that command for both, with the `- Narrowing:` line the brief supplies.
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/evidence-completeness-check.mjs" <report>` also mechanizes the narrow-selector subset of this rule — a `cmd:` naming one test file or
  carrying a test-name filter flag. The concurrent-wave case, a whole-suite red from a sibling's
  uncommitted edit, can reach an implementer's capture but not the coordinator's gate, which
  proves each commit in a scratch worktree. The check also requires an `(exit <n>)` status —
  read from the report line, not file contents — on any present `- Before:`/`- After:` line of
  any class; a `red-green`/`green-green` report additionally needs its `- After:` file to carry a
  test-runner summary line (read with colour and cursor escapes stripped; Karma's `TOTAL:` line, or
  its last `Executed <n> of <m>` line once complete or failed, counts). The normal `red-green` case is a task whose own new tests fail that
  whole gate, so `-before.txt` exits non-zero honestly. When a task's red is instead a subset
  inside an otherwise-green suite, the whole-gate `-before.txt` legitimately exits 0; capture the
  honest subset red as `.devcycle/evidence/<task-id>-red.txt` before any implementation code is
  written.
- A narrowing is declared as `- Narrowing: <selector/scope> — <reason>`. A valid declaration
  clears `evidence-completeness-check.mjs`'s narrow-selector guard (its reason is echoed on
  stdout); the reviewer then judges whether the reason is legitimate (§ Reviewer verdicts). A
  declaration with no `— <reason>` (the em-dash before the reason) is a hard error —
  `malformed narrowing declaration (needs "<selector/scope> — <reason>")`. Silently narrowing
  without the declaration is a defect.
- A `<task-id>-gate.txt` ends `# devcycle-proof: sha=<sha> tree=<tree> parent=<parent>`, then one
  `# devcycle-proof-limit: <note>` per known limit: an editable install in a linked `.venv`/`venv`
  or a linked `vendor` (a Composer path repository) reads the shared checkout, and submodules are
  never populated in the proof worktree. A `node_modules/.bin` link with an absolute target into
  the shared checkout reads it too, with no note.
- A repo may own a required-checks manifest at `tests/fixtures/required-gate-checks.json`: a JSON
  array of substrings that every whole-gate `cmd:` must contain, enforced by
  `evidence-completeness-check.mjs` (overridable via `--required-checks <path>`) and, on a plan's
  pinned gates, by `plan-check.mjs`. Absent, it is a no-op, keeping the plugin repo-agnostic.
- **Scope every capture to the task's own `**Files:**` list**, as a pathspec — `git diff -- <the
  task's files>`, never a bare `git diff`. Concurrent implementers share one checkout, and wave
  formation guarantees no two of them touch the same file, so a file-scoped capture sees exactly
  this task's work and nothing else.
- **`git stash` is forbidden.** It reverts siblings' uncommitted work across the shared checkout.
  With the capture scoped above there is nothing it could be needed for; using it is a defect, not
  a judgment call.

The report itself is a file on the same principle: the implementer writes it to
`.devcycle/reports/<task-id>.md` in the shape below, and the dispatch returns only the short
envelope `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/delegation.md return-envelopes`
prints. A report pasted into the dispatch's reply instead of written to that path is the same
defect as an inlined evidence tail.

- Implementer report shape:

```markdown
## Task report
- Files changed: <list>
- Evidence: <red-green | green-green | convention> | cmd: <the cmd: capture-evidence.mjs printed>
- Before: <path> (exit <n>)
- After: <path> (exit <n>)
- Tail (after, last <N> lines):
  <N lines>
- Deviations: <list, or none>
- Narrowing: <selector/scope> — <reason>, or omit
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
  (`.devcycle/evidence/<task-id>-flaky.txt`) carrying the failing test
  run against **clean HEAD** and against **the change** at the **same iteration count** with their
  actual pass/fail counts (the "clean 20/20; change 6/20" shape), and the #167 foreign-change check,
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/foreign-change-check.mjs" <task files>`, ruled out
  concurrent-sibling pollution. `evidence-completeness-check.mjs` bounces a line
  pairing a failure word with pre-existing, unrelated or environmental (flaky alone suffices) unless
  negated ("no X", "X: none") or citing a non-empty `<task-id>-flaky.txt`.
- a `- Narrowing:` declaration's reason does not hold up: accept a legitimate concurrent-wave
  narrowing, reject a reason that is
  lazy partial coverage dressed up as narrowing.
- the report fails `node "${CLAUDE_PLUGIN_ROOT}/scripts/authored-claims-check.mjs" <report>`
  (a non-zero exit) and any flagged claim carries neither a `(verified: <cmd>)` nor an
  `(assumption)` marker.

A reviewer returns its verdict in this shape. A `needs-changes` verdict carries a mandatory
`Culprit: <slug>` line directly under `Verdict:` — a `references/culprits.json` slug or
`novel:<kebab-slug>`, the two shapes `scripts/run-record.mjs`'s `validateCulprit` admits — and an
`accept` verdict carries none. Either line may carry a heading or list marker, and `approve`,
`approved` and `accepted` read as `accept`; a `Verdict` heading may carry its word alone on the
next line.

```markdown
Verdict: accept | needs-changes
Culprit: <slug>

1. [severity] <finding, symptom first>
2. [severity] <finding, symptom first>
...
```

## Why the evidence lives in files

The coordinator's green gate re-runs the command itself and reads the exit status, so an
inlined copy of the output duplicated ground truth at the cost of a whole suite's output per
task per round.
