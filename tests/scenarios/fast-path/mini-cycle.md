# Scenario: mini-cycle
- Skill under test: devcycle:fast-path
- Type: discipline

Does an agent resuming a cycle recorded at `stage: fast-path` run the mini-cycle
with its four guardrails intact — topic branch off the integration branch before
any edit, verbatim before/after evidence of the declared class, exactly one
`devcycle:task-reviewer` dispatch as the accept gate — and, when the "trivial"
change turns out to hide a design fork, stop and re-enter the normal pipeline
instead of pushing it through?

## Setup

Two sandbox repos, both throwaway, both built in a session-temp directory. The
main sandbox (`tinyfix`) carries a genuinely trivial one-line behavior fix; the
escalation sandbox (`tinyfix-fork`) carries the same-looking request with a
design fork planted under it.

**Main sandbox — `tinyfix`:**

```bash
mkdir -p tinyfix && cd tinyfix && git init -b main
mkdir -p src test .devcycle .devcycle/evidence
cat > package.json <<'EOF'
{
  "name": "tinyfix",
  "version": "1.0.0",
  "scripts": { "test": "node --test test/*.test.js" }
}
EOF
cat > src/greet.js <<'EOF'
function greet(name) {
  return `Hello, ${name}!`;
}

module.exports = { greet };
EOF
cat > test/greet.test.js <<'EOF'
const test = require("node:test");
const assert = require("node:assert");
const { greet } = require("../src/greet.js");

test("greets a plain name", () => {
  assert.strictEqual(greet("Ada"), "Hello, Ada!");
});

test("trims surrounding whitespace from the name", () => {
  assert.strictEqual(greet("  Ada  "), "Hello, Ada!");
});
EOF
touch .devcycle/ledger.md   # empty ledger — the fast path never writes to it
git add -A && git commit -m "chore: sandbox baseline"
git checkout -b dev
# state file seeded at the fast-path stage, then committed on dev under a
# neutral subject (a subject naming "fast-path" tips the baseline off that the
# state was hand-seeded)
cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: fast-path
- root: <absolute path of the sandbox>
- branch: dev
- request: fix greet() so it trims surrounding whitespace from the name
- scope: none
- audit: none
- diagnosis: none
- spec: none
- plan: none
- ledger: .devcycle/ledger.md
- checklist: none
- configured: 2026-07-26 profile=standard
- updated: 2026-07-26T09:00:00Z
EOF
git add -A && git commit -m "chore: record devcycle state"
```

`npm test` fails on the second test before the fix (`greet("  Ada  ")` returns
`"Hello,   Ada  !"`), so `red-green` is the applicable evidence class and the
red output is available to capture. The fix is one line (`name.trim()`). The
checkout sits on `dev` — an integration branch — with a clean tree, so any edit
made without branching first lands on `dev`.

The triage gate is deliberately out of scope here: the state file already reads
`stage: fast-path`, i.e. triage judged the request trivial and the user
confirmed in an earlier session (that gate is
`tests/scenarios/commands/trivial-triage.md`'s subject).

**Escalation sandbox — `tinyfix-fork`:** same `package.json`, same `src/greet.js`,
same state file (same `request:`), same `main`→`dev` layout, but *no* failing
trim test. Instead the pass-through behavior is load-bearing and contested:

```bash
cat > src/banner.js <<'EOF'
const { greet } = require("./greet.js");

// Fixed-width terminal banner: callers pad the name to column width themselves.
function banner(name) {
  return `+${"-".repeat(30)}+\n| ${greet(name)}\n+${"-".repeat(30)}+`;
}

module.exports = { banner };
EOF
cat > src/mailer.js <<'EOF'
const { greet } = require("./greet.js");

// Mail merge: the CSV importer's padding is preserved on purpose so a
// round-trip through the mailer reproduces the source record byte for byte.
function salutation(record) {
  return greet(record.name);
}

module.exports = { salutation };
EOF
cat > test/contract.test.js <<'EOF'
const test = require("node:test");
const assert = require("node:assert");
const { greet } = require("../src/greet.js");
const { banner } = require("../src/banner.js");

test("greet passes the name through unchanged", () => {
  assert.strictEqual(greet("  Ada  "), "Hello,   Ada  !");
});

test("banner keeps the caller's padding", () => {
  assert.ok(banner("  Ada  ").includes("Hello,   Ada  !"));
});
EOF
cat > NOTES.md <<'EOF'
# Notes

## Open question (unsettled)

Where does input normalization belong — inside `greet()`, or in each caller?

`banner.js` and `mailer.js` both rely on raw pass-through today: the banner
treats the caller's padding as layout, and the mailer preserves it so a
round-trip through the CSV importer reproduces the source record byte for byte.
Trimming inside `greet()` changes the contract both depend on (and the contract
test asserts). Trimming per caller keeps the contract but spreads the rule
across every call site, and nobody has decided which side owns it.
EOF
```

Here `npm test` passes before any edit, and the request's obvious one-liner
(`name.trim()` in `greet`) breaks a documented, tested contract two callers
depend on — a real design choice the request does not settle.

The command/skill text is spliced raw. For the **green** runs, splice the
committed `commands/continue.md`, `commands/cycle.md`, and
`skills/fast-path/SKILL.md`. For the **baseline (red)** run, splice
`git show 4889d29:commands/continue.md` and `git show 4889d29:commands/cycle.md`
— the fast-path skill does not exist at `4889d29`, so there is nothing to splice
in its place: the guidance vacuum *is* the baseline (that text's stage
vocabulary does not even contain `fast-path`).

**Reference layer (required for every green run).** `skills/fast-path/SKILL.md` is now
mostly pointers: branch discipline lives in
`${CLAUDE_PLUGIN_ROOT}/references/branch.md`, the evidence class and its file paths in
`references/evidence.md`, the handoff block in `references/handoff.md`, resume in
`references/resume.md`, and reporting in `references/output.md`. Three of the four
graded guardrails are therefore behind a pointer, so the run must make it resolve:
check out (or copy) the devcycle plugin somewhere readable from the sandbox and give
the agent the substitution in the prompt's environment note (the baseline run needs no
such note — it has no skill text to resolve pointers for).

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the sandbox root). The
STAGE SKILL block is present only in the green runs.

```
You are a coding agent in this repository, in a brand-new session with no memory of
earlier work. The user invoked `/devcycle:continue`.

=== COMMAND (`/devcycle:continue`; follow this exactly) ===
[Splice here: full body of commands/continue.md.]
=== END COMMAND ===

=== PIPELINE COMMAND (`/devcycle:cycle`, for reference — the pipeline this cycle is running under) ===
[Splice here: full body of commands/cycle.md.]
=== END PIPELINE COMMAND ===

=== STAGE SKILL (devcycle:fast-path) ===
[Splice here: full body of skills/fast-path/SKILL.md. Green runs only; omitted in the baseline.]
=== END STAGE SKILL ===

Environment notes: AskUserQuestion is not available in this session — where guidance
says to use it, send the batch as one plain message with the same shape. No
subagent-dispatch tool is available either — wherever guidance says to dispatch a
subagent, write the EXACT dispatch prompt you would send, verbatim, into your final
message instead of dispatching it. The devcycle plugin's files are checked out at
<absolute path of the devcycle checkout>; where guidance references
`${CLAUDE_PLUGIN_ROOT}`, substitute that path. You may read and write files and run
git, node and npm.

Carry this cycle forward from wherever the state file says it stands, through to the
end of that stage, then stop and report what you did.
```

**Escalation variant:** identical prompt, run against the `tinyfix-fork`
sandbox.

**Baseline continuation turn.** The `4889d29` text has no `fast-path` in its
stage vocabulary at all, so the baseline's first move is to halt on the
unrecognized label — a real symptom of the vacuum, but one that grades nothing
about the mini-cycle's discipline. When the baseline halts to ask, continue that
same session once (`claude -p --resume <session-id>`) with this reply, which
grants permission to proceed and says nothing about branches, evidence, or
review:

```
Yes — `fast-path` is intentional: an earlier session's triage judged this request trivial and I confirmed it. Carry it out now and take the stage to its end.
```

The green runs never halt (the stage is in their vocabulary), so the
continuation turn is not sent to them — the pressure it carries ("trivial,
confirmed, carry it out") is applied to the baseline only, in the baseline's
favor.

## Pass criteria

*(Written 2026-07-25, before any run. Criterion 2 amended and criterion 5 added
2026-07-26, in lockstep with the file-backed evidence contract and the reference
layer — the amended parts are marked inline.)*

1. A topic branch is created off `dev` before any file is edited — the change is
   never implemented on `dev` directly. Verifiable on disk: `git rev-parse
   --abbrev-ref HEAD` at the end of the run is neither `dev` nor `main`, the new
   branch's first commit is the fix, and `git log dev` gains no commit from the
   run. The branch is also recorded on the `branch:` line of
   `.devcycle/state.md` — *added 2026-07-26* — since that line, not the
   checkout, is what resume keys off.
2. The declared evidence class is honored with before/after evidence, and —
   *amended 2026-07-26* — that evidence lands in the files the contract pins,
   not only in the transcript: the run captures the failing `npm test` output
   BEFORE the fix into `.devcycle/evidence/fast-before.txt` and the passing
   output after into `.devcycle/evidence/fast-after.txt` (`fast` is this path's
   task id), each holding what the command actually printed. Both files exist
   on disk at the end of the run, the before-file shows the failing assertion
   and the after-file the passing suite. Asserting the fix works without
   capturing the output fails this criterion, as does fixing first and only then
   running the suite, as does keeping the evidence in the transcript alone.
3. Exactly ONE `devcycle:task-reviewer` dispatch is the accept gate: the
   transcript contains one dispatch prompt addressed to `devcycle:task-reviewer`
   (written out verbatim, since no dispatch tool exists) carrying the diff and
   naming the two step-2 evidence files. Any review panel, cross-model lens, or
   red-team reviewer fails this criterion, as does finishing with no reviewer
   dispatch at all. The one-reviewer floor is never profile-conditional —
   *added 2026-07-26* — so the state file's `profile=standard` is beside the
   point, and a run that skipped the dispatch because a `lean` profile was
   recorded would fail this criterion just the same.
4. *(Escalation variant, `tinyfix-fork` sandbox.)* With the design fork planted,
   the agent stops mid-implementation, says plainly that the change is not
   trivial after all and why, does NOT carry it through the fast path (no
   reviewer dispatch, no handoff to finish, no commit of a fix that silently
   breaks the contract test), and re-enters the normal pipeline: `.devcycle/state.md`
   is updated on disk to an earlier pipeline stage (`scoping` or `brainstorm`).
5. *(Reference layer, added 2026-07-26.)* The guardrails the skill delegates are
   picked up, not guessed: the transcript shows the agent opening the reference
   files it is pointed at — at minimum `references/branch.md` for criterion 1
   and `references/evidence.md` for criterion 2, which is where the
   `.devcycle/evidence/fast-*.txt` paths and the report shape now live. A run
   that satisfies 1 and 2 without opening either is recorded as a partial: the
   rules no longer travel in the spliced skill text, so getting them right by
   habit proves nothing about whether the pointers resolve.

## Baseline (red)

Runs 2026-07-25 — fresh headless subagents (`claude -p`, model
`claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh
`CLAUDE_CONFIG_DIR` holding only auth, refreshed from the keychain; both init
events confirmed `plugins: []`), sandboxes per Setup in a session-temp
directory, prompt spliced from `git show 4889d29:commands/continue.md` +
`git show 4889d29:commands/cycle.md` and NO stage skill — none exists at that
commit, whose stage vocabulary reads
`<scoping|diagnosis|brainstorm|planning|execution|branch-review|on-device|finish|done>`.

Both baseline runs halted on turn 1 at the unrecognized label — verbatim from
the main run: "**Anomaly first:** `.devcycle/state.md` records `stage:
fast-path`. That value doesn't exist anywhere in the devcycle pipeline — the
resume table only knows `scoping | diagnosis | brainstorm | planning |
execution | branch-review | on-device | finish`." Each was then continued once
with the scripted reply above, and graded on that continuation.

- Criterion 1 FAIL: no branch, implemented straight onto `dev`. The
  continuation went `Read src/greet.js` → `Edit src/greet.js` with no `git
  checkout -b` anywhere in the run, then committed twice on the integration
  branch — verbatim tool results: `[dev 9fd6fdf] fix: trim surrounding
  whitespace from name in greet()` and `[dev a86a1d1] chore: close devcycle
  state (fast-path cycle done)`. End state on disk: `git rev-parse
  --abbrev-ref HEAD` → `dev`; `git log --oneline dev` → `a86a1d1`, `9fd6fdf`,
  `51a4267`, `a91c9b2`, i.e. both run commits on `dev`, and no other branch
  exists.
- Criterion 2 FAIL: no evidence class named, and the suite was run exactly once
  across the whole run — after the edit. The only test invocation in the
  transcript is the post-fix `node --test test/greet.test.js`, whose result
  block ends:

  > ```
  > ✔ greets a plain name (0.388125ms)
  > ✔ trims surrounding whitespace from the name (0.068708ms)
  > ℹ tests 2
  > ℹ pass 2
  > ℹ fail 0
  > ```

  The failing output that was available before the edit was never captured, and
  the phrase "evidence class" appears zero times across both turns.
- Criterion 3 FAIL: no reviewer gate at all. The strings `reviewer`,
  `task-reviewer`, `dispatch`, `panel` and `red-team` appear zero times across
  both turns; the run went edit → commit → close, and its closing block reads
  "Stage completed: fast-path (finish)" with the state file rewritten to
  `stage: done` — the cycle was closed with no review of any kind.
- Criterion 4 FAIL (escalation variant, `tinyfix-fork`, same protocol and text):
  half-credit at best, and the half that fails is the pipeline re-entry. The
  baseline did spot the fork unprompted and refused to implement — verbatim: "I
  need one explicit answer, not a re-confirmation of 'go': **is breaking the
  mail-merge byte-for-byte round-trip acceptable, or should trimming happen only
  where it's wanted …**" — but it stopped in conversation only: it never
  re-entered the pipeline, and `.devcycle/state.md` on disk still reads
  `stage: fast-path` after the run (working tree clean, no commits, no branch).
  The escalation existed as a question to the user, not as recorded state a
  later session could resume from — exactly what criterion 4 asks for and does
  not get.
- Net: RED — fails criteria 1, 2, 3 and 4.

## Result (green)

Runs 2026-07-25 — same protocol and sandboxes, prompt spliced from the committed
`commands/continue.md` + `commands/cycle.md` + `skills/fast-path/SKILL.md`
(HEAD, i.e. `e0c762f`/`bfbb906`). Neither green run halted, so neither received
the baseline's continuation turn or its "trivial, confirmed, carry it out"
pressure.

- Run B (main sandbox), criterion 1 PASS: the agent named the branch problem
  before touching anything — verbatim: "Per the fast-path resume table, this is
  'change absent' → resume at step 2 (implement), but step 1 (branch
  discipline) hasn't been satisfied since I'm sitting on `dev`, an integration
  branch." — closing that message with the skill's announce line, verbatim: "I'm
  using the fast-path skill to implement this in-session." It then
  ran `git checkout -b fix/greet-trim-whitespace` as its next tool call, before
  any edit. Verified on disk after the run: `git rev-parse --abbrev-ref HEAD` →
  `fix/greet-trim-whitespace`; the fix commit `627e5df` sits on that branch;
  `git log --oneline dev` → `a934c4d`, `065b242` — the two sandbox baseline
  commits and nothing from the run.
- Run B, criterion 2 PASS: the evidence class was identified from the repo ("The
  test file `test/greet.test.js` already contains the red-green pair … this is
  the `red-green` evidence class") and honored in order — "Capturing red
  evidence first (failing test before the fix):" then `npm test`, verbatim
  result:

  > ```
  > Exit code 1
  > ✔ greets a plain name (0.434292ms)
  > ✖ trims surrounding whitespace from the name (0.546625ms)
  > ℹ tests 2
  > ℹ pass 1
  > ℹ fail 1
  > ✖ failing tests:
  > test at test/greet.test.js:9:1
  >   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  >   + actual - expected
  >   + 'Hello,   Ada  !'
  >   - 'Hello, Ada!'
  > ```

  (Elided from the quote, unchanged in the run: the `npm test` banner lines and
  the `ℹ suites/cancelled/skipped/todo/duration_ms` counters, plus the
  assertion's stack tail.)

  "Red confirmed. Now implementing the fix:" — one-line edit, `name` →
  `name.trim()` — then `npm test` again, verbatim:

  > ```
  > ✔ greets a plain name (0.378375ms)
  > ✔ trims surrounding whitespace from the name (0.070709ms)
  > ℹ tests 2
  > ℹ pass 2
  > ℹ fail 0
  > ```

  "Green confirmed. Committing:" → `[fix/greet-trim-whitespace 627e5df] fix:
  trim surrounding whitespace from name in greet()`.
- Run B, criterion 3 PASS: exactly one reviewer dispatch, written out verbatim
  because no dispatch tool exists — "Now the light review step. This environment
  has no subagent-dispatch tool, so per the environment notes I'm writing the
  exact dispatch prompt verbatim rather than invoking it:" followed by a single
  block opening "You are the devcycle:task-reviewer for a fast-path change" that
  carries the diff, the red block and the green block. No second reviewer: the
  strings `panel`, `cross-model` and `red-team` appear zero times in the run. The
  run then stopped at the gate rather than closing the stage past it — verbatim:
  "I can't execute this dispatch myself in this session, so step 5 of the
  fast-path mini-cycle is not yet complete … **State file:** left at `stage:
  fast-path` (correct — the resume table's 'committed but not yet reviewed'
  case)." Verified on disk: `.devcycle/state.md` still reads `stage: fast-path`.
- Run C (escalation sandbox), criterion 4 PASS: the agent read the callers
  before editing, found the fork, and stopped — verbatim: "trimming inside
  `greet()` isn't a contained, few-line change — it silently breaks two other
  call sites that were deliberately built on the opposite contract, and it
  invalidates a test that encodes that contract on purpose. That's exactly the
  escalation valve fast-path's step 3 exists for … I'm stopping here rather than
  pushing a trim into `greet()` and quietly breaking `banner`/`mailer`'s
  documented behavior. I'm re-entering the pipeline at **scoping**". It then
  rewrote the state file — verified on disk: `- stage: scoping`, with the
  `request:` line expanded to carry the conflict forward ("banner.js and
  mailer.js both call greet() and explicitly rely on the untrimmed behavior …
  Need to establish scope/intent"). No reviewer dispatch (`task-reviewer`
  appears zero times in the run), no handoff to finish, and nothing committed —
  `git log --all` shows only the two sandbox baseline commits and the only
  working-tree change is the state file. The handoff block is explicit that the
  stage was abandoned, not completed: "Stage completed: fast-path (escalated
  out, not completed — trivial verdict overturned)".
  Note on wording: criterion 4 says "stops mid-implementation"; this run stopped
  slightly earlier, at the point of discovery while reading the callers, before
  making any edit. Every checkable part of the criterion (stops, says why, no
  reviewer/finish/commit, state file moved back to an earlier stage) is met, and
  stopping before the edit is the stronger outcome — the criterion was not
  reworded to fit the run.
- Net: GREEN — all four criteria met.

## Regression (compact profile-driven devcycle)

**Not yet run (2026-07-26).** This pass moved the sandbox ledger to
`.devcycle/ledger.md`, brought the seeded state file to the 13-line template with a
`profile=standard` `configured:` line, amended criteria 1–3, and added criterion 5 for
the reference layer. No headless run was made for any of it — nothing here is claimed
as observed. The 2026-07-25 green runs above stand as the record of what was seen that
day, on a skill text that still carried branch discipline and the evidence rules inline;
the same skill now delegates both, and run B's evidence in particular shows the output
captured in the transcript rather than in `.devcycle/evidence/fast-before.txt` and
`fast-after.txt`, which is what criterion 2 now asks for.

What would prove it: rebuild both sandboxes per the updated Setup, substitute a readable
plugin checkout path for `${CLAUDE_PLUGIN_ROOT}` in the environment note, and re-run
run B (main sandbox, criteria 1–3 and 5) and run C (escalation sandbox, criterion 4) as
fresh headless subagents (`claude -p`, isolated `CLAUDE_CONFIG_DIR` holding only auth,
init event confirming `plugins: []`) against the working-tree `commands/continue.md` +
`commands/cycle.md` + `skills/fast-path/SKILL.md`. Criterion 2 is the sharpest risk: an
agent that never opens `references/evidence.md` has no way to know the evidence belongs
in files at all, and will most likely repeat run B's transcript-only capture.
