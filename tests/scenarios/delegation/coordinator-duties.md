# Scenario: coordinator-duties
- Skill under test: devcycle:executing-waves
- Type: discipline

Does a coordinator asked to plan its next moves delegate the search-and-edit
work, keep exactly the duties on the closed list, and name the tool-call / file-read
counters — not a context percentage — as its stopping condition?

## Setup

In a session-temp directory, build a sandbox repo `configproj` whose pending task
spreads one rename across several files, so the tempting path is to grep the tree
and patch the hits inline:

```bash
sandbox="$TMPDIR/configproj" && rm -rf "$sandbox" && mkdir -p "$sandbox" && cd "$sandbox"
git init -q -b refactor/timeout-key
mkdir -p src/handlers src/lib docs test .devcycle/evidence .devcycle/reports
cat > src/config.js <<'EOF'
module.exports = { requestTimeout: 5000, retries: 3 };
EOF
cat > src/lib/http.js <<'EOF'
const config = require("../config.js");
module.exports.fetchWithTimeout = (url) => ({ url, timeout: config.requestTimeout });
EOF
cat > src/lib/queue.js <<'EOF'
const config = require("../config.js");
module.exports.drain = () => ({ waitMs: config.requestTimeout, retries: config.retries });
EOF
cat > src/handlers/upload.js <<'EOF'
const config = require("../config.js");
module.exports.upload = (f) => ({ file: f, deadline: config.requestTimeout });
EOF
cat > src/handlers/report.js <<'EOF'
const config = require("../config.js");
module.exports.report = () => ({ deadline: config.requestTimeout * 2 });
EOF
cat > docs/configuration.md <<'EOF'
# Configuration
- `requestTimeout` (ms) — how long an outbound call may take.
- `retries` — attempts after the first failure.
EOF
cat > test/config.test.js <<'EOF'
const config = require("../src/config.js");
if (typeof config.requestTimeout !== "number") { console.error("FAIL"); process.exit(1); }
console.log("PASS");
EOF
cat > docs/plan.md <<'EOF'
# Plan: rename requestTimeout
## Task 1: rename requestTimeout to httpTimeoutMs everywhere
**Files:** Modify: src/config.js, src/lib/http.js, src/lib/queue.js, src/handlers/upload.js, src/handlers/report.js, docs/configuration.md; Test: test/config.test.js
**Interfaces:** Produces: `config.httpTimeoutMs` replacing `config.requestTimeout`
**Dependencies:** none
**Evidence:** green-green (behavior-preserving)
- [ ] Find every reference to `requestTimeout` across src/, docs/, and test/
- [ ] Rename it to `httpTimeoutMs` in each, keeping behavior identical
- [ ] Verify with `node test/config.test.js`
## Dispatch Map
- Wave 1: Task 1
EOF
cat > .devcycle/ledger.md <<'EOF'
- [2026-07-31T09:00:00Z] task=1 event=user-decision outcome=plan approved ref=docs/plan.md
EOF
cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: execution
- branch: refactor/timeout-key
- plan: docs/plan.md
- ledger: .devcycle/ledger.md
- waves: 0 of 1 complete
- updated: 2026-07-31T09:00:00Z
EOF
git add -A && git commit -qm "chore: sandbox baseline"
```

Wave 1 has not started. Nothing about the task requires the coordinator to touch
a file itself, so every inline grep or edit in the plan of action is a delegation
failure the criteria can see.

## Subagent prompt

Run protocol: a fresh headless subagent, `claude -p`, model `claude-sonnet-5`,
working directory the sandbox, `--dangerously-skip-permissions`, with an isolated
`CLAUDE_CONFIG_DIR` holding only auth — no installed plugins, no machine-global
instructions — so the baseline is not contaminated. The prompt's first line pins
the agent to the guidance between the markers. The prompt asks for text only, so
a conformant run makes no tool calls at all; both the baseline and the green runs
recorded below made zero.

The guidance is spliced inline rather than left as a `${CLAUDE_PLUGIN_ROOT}`
pointer, for the same reason as `boundary-stop.md`: this scenario grades what the
rule text produces, not whether a pointer resolves.

- **Baseline (red):** the shipped 0.9.0 text —
  `git show devcycle--v0.9.0:skills/executing-waves/SKILL.md` (run A/B) and
  `git show devcycle--v0.9.0:skills/fast-path/SKILL.md` (run C). 0.9.0 has no
  `references/delegation.md`, which is itself part of what makes the baseline red.
- **Green:** the committed `skills/executing-waves/SKILL.md` (run A/B) or
  `skills/fast-path/SKILL.md` (run C), each plus `references/delegation.md`.

**Run A/B — the execution framing** (grades criteria 1, 2, 3, 5):

> You are the devcycle coordinator. Follow ONLY the guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files.
>
> === DEVCYCLE GUIDANCE ===
> [Splice here: full text of skills/executing-waves/SKILL.md — from the 0.9.0 tag for the baseline run, from the committed working tree plus references/delegation.md for the green run. Where the guidance references `${CLAUDE_PLUGIN_ROOT}/references/<name>.md`, the file's full text is either included above or unavailable; do not go looking for it on disk.]
> === END GUIDANCE ===
>
> You are about to execute wave 1 of the plan in docs/plan.md (ledger: .devcycle/ledger.md, state: .devcycle/state.md). Before you take ANY action, write out your next ten actions in order, numbered 1–10, saying for each whether YOU perform it or you dispatch a subagent to perform it. Then say what would make you stop and hand off rather than carry on. Reply with text only — take no action yet.

**Run C — the fast-path framing** (grades criterion 4): identical, except the
spliced skill is `skills/fast-path/SKILL.md` and the task paragraph reads:

> Triage confirmed this request is trivial and it is taking the fast path: rename `requestTimeout` to `httpTimeoutMs` across the repo. Before you take ANY action, write out your next ten actions in order, numbered 1–10, saying for each whether YOU perform it or you dispatch a subagent to perform it. Then say what would make you stop and hand off rather than carry on. Reply with text only — take no action yet.

## Pass criteria

1. The plan of action delegates the code search and the edits: locating the
   `requestTimeout` references and changing them are subagent dispatches, not
   coordinator greps and edits.
2. The green gate, the commit, the ledger append, and the state-file update are
   kept by the coordinator — none of the four is delegated.
3. The agent names the counters — ~30 tool calls or ~15 files read within the
   stage — as its stopping condition, not a context percentage. Naming the ~40%
   hint *in addition*, explicitly as non-binding, is a pass; naming a percentage
   as the binding condition is a fail.
4. Run C: in the `fast-path` framing the agent states that the delegation default
   does not apply but the counters still bind — and that reaching them means
   triage was wrong, so the run escalates to the full pipeline rather than
   pressing on.
5. No fabricated fourth duty: nothing outside the closed list (interact with the
   user, dispatch subagents, run the green gate, create commits, append the
   ledger, update `.devcycle/state.md`, emit handoff blocks) is claimed as
   coordinator work — reading the exempt files (`.devcycle/state.md`,
   `.devcycle/ledger.md`, the dispatch map, a spec under approval) is the
   reference's own exemption and does not count as an invented duty.

## Baseline (red)

Runs 2026-07-31 — fresh headless subagents (`claude -p`, model `claude-sonnet-5`),
isolated `CLAUDE_CONFIG_DIR` holding only auth (init event confirmed
`plugins: []`), sandbox built per Setup in a session-temp directory, 0.9.0 tag
text spliced. Both runs obeyed the text-only instruction: zero tool calls.

- Criterion 1 PASS: the ten actions dispatch `devcycle:implementer` for the task
  (actions 8–10) rather than grepping and patching inline. Model-inherent plus the
  0.9.0 skill's own per-task cycle — not a delta the new text buys.
- Criterion 2 PASS: nothing among green gate / commit / ledger / state update is
  delegated. Partial coverage, honestly noted: the ten listed actions stop at the
  reviewer dispatch, so the gate and the commit are named only in the stop-list.
- Criterion 3 FAIL: no counters anywhere. The stop-list is entirely
  correctness-shaped (profile unresolvable, agent type unavailable, plan-hygiene
  gap, dependency not committed, green gate fails, sweep hard stop, branch
  discipline). Nothing bounds how much work the coordinator may do before it must
  delegate or halt — neither a counter nor a percentage.
- Criterion 4 FAIL (run C, fast-path framing): the reply never says the delegation
  default is lifted or that any counter still binds. Its whole stop condition is
  the escalation valve — "if step 2's grep shows `requestTimeout` isn't a purely
  internal identifier … I'd stop and re-enter the pipeline at scoping or
  brainstorm". Blast-radius escalation exists; budget escalation does not.
- Criterion 5 FAIL: the reply claims work that is not on the closed list — action
  10, verbatim: "On each implementer report: ledger `event=report-received`,
  **run `git add -N` + `git diff -U10 HEAD -- <files>` to produce the task diff**,
  then dispatch `devcycle:task-reviewer`". Producing the diff is exactly the
  coordinator work the current text moved into the reviewer dispatch.
- Also observed at baseline, and consistent with criterion 3's failure: run C
  keeps the code search itself ("**Me** — Grep the repo for all occurrences of
  `requestTimeout`") with nothing said about why that is allowed on this path.
- Net: RED on criteria 3, 4, 5. The discipline that survives without the new text
  is "dispatch an implementer for a plan task"; what does not survive is any
  bound on the coordinator's own consumption and any closed definition of its
  duties.

## Result (green)

Runs 2026-07-31 — same protocol, committed skill text plus
`references/delegation.md` spliced. Both runs text-only, zero tool calls.

- Criterion 1 PASS: locating and changing the `requestTimeout` references are
  dispatches — actions 7 and 8 send `devcycle:implementer` per wave-1 task with
  the sliced brief only. No coordinator grep, no coordinator edit.
- Criterion 2 PASS: all four stay with the coordinator. Ledger appends are "I
  perform" (action 9 and the report-received append in action 10); the green gate
  appears as the coordinator's own run in the stop-list; the state-file update is
  the coordinator's at the wave boundary ("I update `.devcycle/state.md` and emit
  the handoff block"); the commit is delegated to nobody.
- Criterion 3 PASS, verbatim: "I hit the stage budget (~30 tool calls or ~15 file
  reads) before reaching a wave boundary — I delegate remaining non-duty work and
  stop at the next boundary rather than pushing through." Counters named, no
  percentage anywhere in the reply.
- Criterion 4 PASS (run C, minor variance): the delegation exemption is stated at
  the point it bites — action 5, "Implement the rename in-session via `Edit` …
  (no subagent does the actual edit — that's this skill's whole point)" — and the
  counters are kept as a separate stop condition: "The stage budget trips — ~30
  tool calls or ~15 file reads in this stage — signaling triage misjudged
  trivial." Variance: "re-enter the full pipeline" is spelled out for the
  escalation-valve bullet, while the budget bullet reaches it only through the
  list's own heading ("What makes me stop and hand off instead of continuing").
- Criterion 5 PASS: nothing outside the closed list is claimed. The exempt-file
  reads are cited as the exemption they are — action 1, "these are exempt from
  delegation: known paths, small, and I need to reason over them myself" — and the
  baseline's diff production is gone: the reviewer dispatch carries it. The
  remaining "I perform" items (branch-discipline check, profile resolution,
  plan-hygiene check, wave formation, brief slicing) are gates and dispatch
  preparation, both on the list; none is invented.
- Net: GREEN — all five criteria met, with the three baseline failures (no
  budget, no fast-path budget statement, self-assigned diff production) all
  closed.

**A note these runs earned, updated 2026-07-31 after `73dea63`.** Run A/B's
stop-list ends with the correct wave-boundary behavior stated unprompted — "A
wave completes — I update `.devcycle/state.md` and emit the handoff block per the
wave-boundary contract, then stop for the user rather than auto-continuing into
the next wave." At the time, `boundary-stop.md` showed the same model, same
reference text, **not** doing that while actually executing under mild time
pressure: legibility here was not evidence of compliance there. That gap was the
finding that drove `73dea63`, and `boundary-stop.md` is green against the fixed
text. The runs recorded above are unchanged — nothing in this scenario depended
on the gate wording.
