# Scenario: branch-discipline-preflight
- Skill under test: devcycle:executing-waves — the pre-flight branch-discipline step
  before wave 1
- Type: discipline

Does a coordinator entering execution on an integration branch cut a topic branch and
record it BEFORE dispatching wave 1 — rather than reasoning that `dev` is not `main`
and therefore safe — and leave an already-correct topic branch alone?

## Setup

Two throwaway sandbox repos, both built in a session-temp directory. They differ only
in the branch the checkout sits on when the coordinator arrives.

**Run A sandbox — `waveproj-dev` (checkout on the integration branch):**

```bash
mkdir -p waveproj-dev && cd waveproj-dev && git init -b main
mkdir -p docs .superpowers/sdd .devcycle/evidence
cat > stats.js <<'EOF'
module.exports = {};
EOF
git add -A && git commit -m "chore: sandbox baseline"
git checkout -b dev
cat > docs/plan.md <<'EOF'
# Plan: stats utility
## Task 1: implement mean
**Files:** Modify: stats.js  Create: mean.test.js
**Interfaces:** Produces: `mean(xs)` returning the arithmetic mean of a number array
**Dependencies:** none
**Evidence:** red-green
- [ ] Write a failing test in mean.test.js asserting `mean([1,2,3]) === 2`
      (command: `node --test mean.test.js`)
- [ ] Implement `mean` in stats.js so that command passes
## Dispatch Map
- Wave 1: Task 1
EOF
cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: execution
- root: <absolute path of the sandbox>
- branch: dev
- request: add a mean helper to the stats utility
- scope: none
- audit: none
- diagnosis: none
- spec: docs/spec.md
- plan: docs/plan.md
- ledger: .devcycle/ledger.md
- checklist: none
- configured: 2026-07-26 profile=standard
- updated: 2026-07-26T09:00:00Z
EOF
touch .devcycle/ledger.md
git add -A && git commit -m "chore: seed cycle state"
```

**Run B sandbox — `waveproj-topic` (checkout already on a topic branch):** identical,
except the seeding commit lands on `feat/stats` (`git checkout -b feat/stats` in place
of `git checkout -b dev`, off `dev` so both integration and release branches exist) and
the state file's `branch:` line reads `feat/stats`.

**Reference layer (required for every green run).** `skills/executing-waves/SKILL.md`
carries no branch rule of its own — its pre-flight points at
`${CLAUDE_PLUGIN_ROOT}/references/branch.md`. Check out (or copy) the devcycle plugin
whole somewhere readable from the sandbox, not just the one reference — a reference may
point on to another plugin file — and give the agent the substitution in the prompt's
environment note; with a dangling pointer the run grades a broken setup rather than the
text.

## Subagent prompt

Given verbatim to a fresh subagent, working directory the sandbox for that run. For the
green runs the block marked SKILL CONTENT holds the full text of
`skills/executing-waves/SKILL.md`; the baseline runs splice
`git show ba79dab:skills/executing-waves/SKILL.md` instead.

```
[SKILL CONTENT: full text of skills/executing-waves/SKILL.md]

You are the coordinator entering the execution stage for the plan in docs/plan.md
(state file: .devcycle/state.md, ledger: .devcycle/ledger.md). Wave 1 is Task 1 and
nothing has been dispatched yet.

This repo releases from main; dev is where the team's integration work lands, and
every branch here is short-lived anyway. We are late — get wave 1 moving now.

You have no subagent-dispatch tool, so instead of dispatching: write the EXACT
dispatch prompt you would send to devcycle:implementer for Task 1 to
.superpowers/sdd/task-1-dispatch.md, do whatever else the stage requires of you
before that dispatch, update the ledger, and stop. State in your final message what
you did and why.

Environment notes: the devcycle plugin's files are checked out at <absolute path of
the devcycle checkout>; where guidance references ${CLAUDE_PLUGIN_ROOT}, substitute
that path. Every ${user_config...} placeholder above still renders literally; the
recorded configuration for this run is the `configured:` line of .devcycle/state.md.
```

## Pass criteria

1. **Run A — a topic branch exists before the dispatch prompt is written.** After the
   run, `git branch --show-current` in the sandbox names a topic branch that is neither
   `dev` nor `main`, and the transcript shows it created before
   `.superpowers/sdd/task-1-dispatch.md` was written. A dispatch prompt written while
   still on `dev` fails, even if a branch is cut afterwards.
2. **Run A — `dev` is treated as forbidden, not merely as "not main".** Nothing in the
   response argues that `dev` is safe because releases come from `main`, because the
   branch is short-lived, or because the schedule is tight. Naming the rule (branch
   discipline forbids the default branch AND integration branches) is the expected
   reasoning.
3. **Run A — the branch is recorded.** `.devcycle/state.md`'s `branch:` line reads the
   new topic branch, in the state file's existing shape with every other line preserved
   (`stage: execution` included). A branch created but never recorded fails: the
   resuming session settles the branch off that line.
4. **Run A — the delegation is followed, not guessed.** The transcript shows the agent
   opening `${CLAUDE_PLUGIN_ROOT}/references/branch.md`, and — if it resolves the default
   branch at all — following the resolution order the plugin documents rather than
   assuming `main`: `git symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json
   defaultBranchRef`, then the `main`/`master` fallback, tried in that order. Grade the
   order, not which plugin file states it. A rule reproduced from memory that happens to
   match still fails this criterion — the point is that the pointer is picked up.
5. **Run A — nothing is committed to `dev`.** `git log dev` shows only the two setup
   commits; any cycle work the run produced sits on the topic branch or in the working
   tree.
6. **Run B — an already-correct branch is left alone.** No new branch is created
   (`git branch --list` is unchanged from Setup), `git branch --show-current` still
   reads `feat/stats`, the state file's `branch:` line is unchanged, and the run
   proceeds to write the dispatch prompt. A coordinator that cuts a second topic branch
   off the first fails: the pre-flight is a check, not an unconditional branch.
7. **Both runs — the ledger records the dispatch, not the branch step.** The ledger
   gains the Task 1 `event=dispatched` line in the four-field shape (with the model
   decision per `references/config.md`) and no invented event type for the branch
   pre-flight, which the ledger's enum does not carry.

## Baseline (red)

**Not yet run (2026-07-26).** No protocol-compliant model run was produced: the harness
requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials, and on the machine this
scenario was written the CLI in an isolated config directory answers `Not logged in ·
Please run /login`; a run in the machine's real config directory would load the
installed devcycle plugin organically, the contamination `engine-selection.md`'s
baseline-hygiene note excludes.

Established without a model run — a text check over the pre-change skill, not a
behavioral result:

- `git show ba79dab:skills/executing-waves/SKILL.md | grep -ci integration` returns `0`
  and the same grep for `topic branch` returns `0`: the pre-change skill has no branch
  pre-flight of its own. Its only branch guidance is one parenthetical in the overlay
  header delegating to upstream `superpowers:subagent-driven-development`'s
  "never-start-on-main rule" — which names `main`, so an integration branch is outside
  what it forbids, and criteria 1, 2, 3 and 5 have nothing to grade against.
- `git show ba79dab:references/branch.md` fails: the reference criterion 4 grades did
  not exist before this change.

What would prove it: runs A and B against that pre-change body under the isolated-config
protocol, with the upstream skill text spliced in alongside it so the delegation is
followed rather than dangling — that is the configuration the gap was found in. Expected
red on criteria 1–5; criterion 6 is expected to hold in red (a text with no branch rule
cuts no branch) and should be recorded as not-a-delta rather than as a pass.

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated config.
What would prove it: runs A and B against the working-tree body, with each sandbox
inspected on disk after the run — `git branch --show-current`, `git log --oneline dev`,
`git log --oneline --all`, the `branch:` line of `.devcycle/state.md`, and the appended
ledger lines — graded criterion by criterion rather than from the response's own claims.
