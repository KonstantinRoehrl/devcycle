# Git-Policy Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the finish stage (`/devcycle:cycle` Step 7 and `/devcycle:continue`'s
mirrored section) resolve `userConfig.gitPolicy` against two external signals — a Claude
Code permission deny on `git push`, and the cycle's branch being the repo's default
branch — clamping `push-allowed`/`open-pr` down to `local-commits-only` for that run when
either fires, and always narrating the effective policy in the finish stage's Handoff
block.

**Architecture:** Pure prose/instruction changes to two command files
(`commands/cycle.md`, `commands/continue.md`), each already self-contained (a resumed
session may never load `cycle.md`, so `continue.md` must restate the full resolution
logic, matching the file's existing duplication of the `gitPolicy` default-fallback
explanation). Docs (`README.md`, `DESIGN.md`, `docs/DECISIONS.md`) get matching updates.
A new empirical scenario test (`tests/scenarios/commands/git-policy-reconciliation.md`)
verifies the behavior the same way `tests/scenarios/commands/first-run-config.md` verifies
the first-run walkthrough: real `claude -p` subagent runs against sandboxed repos, before
and after the change.

**Tech Stack:** Markdown command/skill files (Claude Code plugin), Node scripts
(`scripts/validate.mjs`, `scripts/redaction-check.mjs`) for structural regression checks,
`claude -p` headless subagent runs for the empirical scenario test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-git-policy-reconciliation-design.md`. This plan
  implements it verbatim; do not re-derive design decisions already made there.
- The resolution applies **only** when the configured `gitPolicy` is `push-allowed` or
  `open-pr`. `local-commits-only` is already the floor and is checked first — skip both
  signals entirely when it applies.
- **Permission-settings signal:** a `deny` rule matching the literal `git push` command
  (patterns: `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash` deny) in any of: project
  `.claude/settings.local.json`, project `.claude/settings.json`, user
  `~/.claude/settings.json`, or a managed/enterprise policy file present on the platform.
  Read whichever of these exist; a missing file contributes no rules. An `ask`-only rule
  (no matching `deny`) does **not** fire this signal.
- **Protected-branch signal:** resolve the repo's default branch via, in order, `git
  symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json defaultBranchRef`,
  then a `main`/`master` fallback if one of those branches exists and neither command
  succeeded. This signal fires when the branch recorded in `.devcycle/state.md` for this
  cycle **is** that default branch.
- Either signal firing clamps the **effective policy** to `local-commits-only` for that
  run, regardless of configured value — a clamp, not a blend; there is no intermediate
  "push but no PR" state produced by these two signals.
- The clamp is silent (no pause, no question raised to the user) but always narrated in
  the finish stage's Handoff block via an exact `Git policy:` line — pinned format (used
  verbatim in both `cycle.md` and `continue.md`, and checked verbatim by the test task):
  - No clamp: `Git policy: <value> (no override)`
  - Clamp: `Git policy: configured <value> → effective local-commits-only (<reason>)`,
    where `<reason>` is `a permission rule denies git push`, `current branch is the
    repo's default branch; direct pushes to it are not allowed`, or both joined with
    `; ` if both signals fired.
- No new `userConfig` knob. No change to `local-commits-only` behavior.
- Conventional Commit type per task is given in that task's commit step — do not deviate.
- Verification commands available in this repo (no `package.json`/npm scripts): `node
  scripts/validate.mjs` (expect stdout `validate: ok`) and `node
  scripts/redaction-check.mjs` (expect stdout `redaction: ok`). Run both after every
  content edit in this plan.

---

## Dispatch map

- **Wave 1 (parallel — file-disjoint, no dependencies):** Task 1, Task 2, Task 3.
- **Wave 2 (after Wave 1's Tasks 1 and 2 are committed):** Task 4.

---

### Task 1: `/devcycle:cycle` finish-stage resolution

**Files:**
- Modify: `commands/cycle.md` (Step 7 of the "Stage walk" section; the "Stage boundaries"
  section)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the exact `Git policy:` Handoff-line format pinned in Global Constraints
  above — Task 4's scenario test checks this string verbatim. Task 2 restates the same
  format independently (both are pinned by this plan, not derived from each other's
  diff), so there is no runtime dependency between Task 1 and Task 2.

Dependencies: none (completely independent).

- [ ] **Step 1: Replace Step 7 of the Stage walk section**

In `commands/cycle.md`, find this exact block (the numbered item `7. **finish**` in the
"Stage walk" section):

```markdown
7. **finish** — per the git policy resolved above:
   - `local-commits-only`: hand the branch back — report branch name and commits;
     do not push, do not open a PR.
   - `push-allowed`: push the branch; NEVER merge it.
   - `open-pr`: push the branch and open a PR whose title parses as a Conventional
     Commit; do not merge it.

   As the finish stage's final state-file write, set `stage: done` and a fresh
   `updated:` timestamp — nothing remains to resume.
```

Replace it with:

```markdown
7. **finish** — resolve the effective git policy, then act on it. Call the value
   resolved above (Configuration section) the **configured policy**.

   **Resolve effective policy.** If the configured policy is `local-commits-only`, it is
   already the floor — skip straight to "Act on the effective policy" below, effective
   equals configured, no signal checks needed. Otherwise (`push-allowed` or `open-pr`),
   check two signals before pushing anything:

   - **Permission-settings signal:** read the effective Claude Code permission settings —
     project `.claude/settings.local.json`, project `.claude/settings.json`, user
     `~/.claude/settings.json`, and any managed/enterprise policy file present on this
     platform (read whichever exist; a missing file has no rules). Look for a `deny` rule
     whose pattern would match the literal `git push` command — e.g. `Bash(git push:*)`,
     `Bash(git:*)`, or a bare `Bash` deny. If any such deny rule exists in any of those
     files, this signal fires. An `ask`-only rule (no matching `deny`) does NOT fire this
     signal — leave the configured policy alone; the normal permission prompt at push time
     communicates the restriction.
   - **Protected-branch signal:** resolve the repo's release/default branch — try, in
     order, `git symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json
     defaultBranchRef`, then fall back to `main` or `master` if one of those branches
     exists and neither command is available. If the branch recorded in
     `.devcycle/state.md` (this cycle's branch) IS that default branch, this signal
     fires — devcycle never pushes directly to the repo's default branch.

   If either signal fires, the **effective policy** for this run is `local-commits-only`
   regardless of the configured value. Otherwise effective equals configured. This clamp
   is silent (no pause, no question) but always narrated — see the Handoff line below.

   **Act on the effective policy:**
   - `local-commits-only`: hand the branch back — report branch name and commits;
     do not push, do not open a PR.
   - `push-allowed`: push the branch; NEVER merge it.
   - `open-pr`: push the branch and open a PR whose title parses as a Conventional
     Commit; do not merge it.

   As the finish stage's final state-file write, set `stage: done` and a fresh
   `updated:` timestamp — nothing remains to resume.
```

- [ ] **Step 2: Add the Handoff-line addendum to the Stage boundaries section**

In the same file, find this exact paragraph (immediately after the generic Handoff block
shape's closing code fence, in the "Stage boundaries" section):

```markdown
At a wave → wave boundary within execution the first field is instead
`Wave completed: <n> of <m> (stage: execution)` — `Stage completed:` is
reserved for true stage ends. These are the only two sanctioned first-field
labels.
```

Replace it with (adds a new paragraph immediately after, before "Pick the context
action..."):

```markdown
At a wave → wave boundary within execution the first field is instead
`Wave completed: <n> of <m> (stage: execution)` — `Stage completed:` is
reserved for true stage ends. These are the only two sanctioned first-field
labels.

At the finish stage specifically, the block carries one additional line, directly after
`Artifacts:` — the resolved git policy. When the effective policy was not clamped:
`Git policy: <value> (no override)`. When it was clamped (Step 7 above): `Git policy:
configured <value> → effective local-commits-only (<reason>)`, where `<reason>` is `a
permission rule denies git push`, `current branch is the repo's default branch; direct
pushes to it are not allowed`, or both joined with `; ` if both signals fired. No other
stage's block carries this line.
```

- [ ] **Step 3: Verify structural checks still pass**

Run: `node scripts/validate.mjs`
Expected: `validate: ok`

Run: `node scripts/redaction-check.mjs`
Expected: `redaction: ok`

- [ ] **Step 4: Commit**

```bash
git add commands/cycle.md
git commit -m "feat(cycle): resolve gitPolicy against permission and default-branch signals"
```

---

### Task 2: `/devcycle:continue` finish-stage resolution

**Files:**
- Modify: `commands/continue.md` ("Finish stage git policy" paragraph)

**Interfaces:**
- Consumes: nothing from other tasks (the Handoff-line format is pinned in Global
  Constraints, not read from Task 1's diff).
- Produces: same `Git policy:` Handoff-line format as Task 1, restated in full here
  because this file must be self-contained (a resumed session may never load
  `cycle.md` — this is already how the file treats the `gitPolicy` default-fallback
  explanation).

Dependencies: none (completely independent; safe to run in parallel with Task 1 — no
shared files, and no cross-task reads of each other's diffs since both texts are pinned
verbatim by this plan).

- [ ] **Step 1: Replace the "Finish stage git policy" paragraph**

In `commands/continue.md`, find this exact paragraph:

```markdown
**Finish stage git policy** (read here, because this session may never load
`/devcycle:cycle`): `${user_config.gitPolicy}` — if that value still begins with
the literal text `${user_config`, the option is unset; use the default
`local-commits-only`. If the placeholder is literal but the state file's
`configured:` line records a `gitPolicy=` value, that recorded value governs
this run (same-session substitution cannot refresh). Then: `local-commits-only`
= hand the branch back (report branch and commits; no push, no PR);
`push-allowed` = push the branch, NEVER merge; `open-pr` = push and open a PR
with a Conventional-Commit title, do not merge. Treat any other value as
invalid and fall back to the default. Never offer the first-run configuration
walkthrough here — it belongs to `/devcycle:cycle` only.
```

Replace it with:

```markdown
**Finish stage git policy** (read here, because this session may never load
`/devcycle:cycle`): `${user_config.gitPolicy}` — if that value still begins with
the literal text `${user_config`, the option is unset; use the default
`local-commits-only`. If the placeholder is literal but the state file's
`configured:` line records a `gitPolicy=` value, that recorded value governs
this run (same-session substitution cannot refresh). Treat any other value as
invalid and fall back to the default. Call this the **configured policy**.

**Resolve effective policy** before acting. If the configured policy is
`local-commits-only`, it is already the floor — use it as-is, no signal checks needed.
Otherwise (`push-allowed` or `open-pr`), check two signals: (1) a `deny` rule matching
the literal `git push` command (e.g. `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash`
deny) in any of project `.claude/settings.local.json`, project `.claude/settings.json`,
user `~/.claude/settings.json`, or a managed/enterprise policy file present on this
platform (an `ask`-only rule does not count); (2) the branch recorded in
`.devcycle/state.md` for this cycle IS the repo's release/default branch, resolved via,
in order, `git symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json
defaultBranchRef`, then a `main`/`master` fallback. If either signal fires, the
**effective policy** is `local-commits-only` regardless of the configured value;
otherwise effective equals configured. This clamp is silent (no pause, no question) but
always narrated in the Handoff block below.

Then, act on the effective policy: `local-commits-only` = hand the branch back (report
branch and commits; no push, no PR); `push-allowed` = push the branch, NEVER merge;
`open-pr` = push and open a PR with a Conventional-Commit title, do not merge. Never
offer the first-run configuration walkthrough here — it belongs to `/devcycle:cycle`
only.

The Handoff block always includes a `Git policy:` line stating the effective policy.
When it was not clamped: `Git policy: <value> (no override)`. When it was clamped:
`Git policy: configured <value> → effective local-commits-only (<reason>)`, where
`<reason>` is `a permission rule denies git push`, `current branch is the repo's default
branch; direct pushes to it are not allowed`, or both joined with `; ` if both signals
fired.
```

- [ ] **Step 2: Verify structural checks still pass**

Run: `node scripts/validate.mjs`
Expected: `validate: ok`

Run: `node scripts/redaction-check.mjs`
Expected: `redaction: ok`

- [ ] **Step 3: Commit**

```bash
git add commands/continue.md
git commit -m "feat(continue): mirror gitPolicy resolution in the finish stage"
```

---

### Task 3: Document the resolution (README, DESIGN, decision log)

**Files:**
- Modify: `README.md` (Configuration section, after the `gitPolicy` paragraph)
- Modify: `DESIGN.md` (§7 userConfig Schema)
- Modify: `docs/DECISIONS.md` (new dated entry, top of file)

**Interfaces:**
- Consumes: nothing from other tasks (all wording is pinned here, not derived from Task
  1/2's diffs).
- Produces: nothing consumed by other tasks.

Dependencies: none (completely independent; file-disjoint from Tasks 1, 2, and 4).

- [ ] **Step 1: Extend the README's `gitPolicy` explanation**

In `README.md`, find this exact paragraph (Configuration section, right after the
options table):

```markdown
**`gitPolicy`** is the pipeline's blast radius: `local-commits-only` means it only ever
commits on a local branch and hands it to you (never pushes); `push-allowed` lets it push
the branch (never merge); `open-pr` lets it push and open a pull request (never merge that
either). Merging is always yours.
```

Replace it with:

```markdown
**`gitPolicy`** is the pipeline's blast radius: `local-commits-only` means it only ever
commits on a local branch and hands it to you (never pushes); `push-allowed` lets it push
the branch (never merge); `open-pr` lets it push and open a pull request (never merge that
either). Merging is always yours.

Configuring `push-allowed` or `open-pr` doesn't guarantee a push happens: the finish
stage also checks two things outside this config before it pushes anything — whether
your Claude Code permission settings deny `git push`, and whether the cycle ran on the
repo's default branch (direct pushes there are never allowed) — and falls back to
`local-commits-only` behavior for that run if either is true, stating why in the finish
stage's output. `local-commits-only` is unaffected either way; it never pushes.
```

- [ ] **Step 2: Add a bullet to DESIGN.md §7**

In `DESIGN.md`, find this exact block (§7 userConfig Schema, the bullet list after the
JSON schema):

```markdown
- Shipped defaults: `gitPolicy: local-commits-only` (most conservative), `reviewDepth: single`,
  `crossModelReview: false`, `onDeviceGate: human-required`, all four model options `auto`.
- The finishing stage branches on `gitPolicy`: local-commits-only ends with the branch handed back (the author's
  mode); `open-pr` automates push + PR for users who want it.
- Model names are config values, not skill prose — they rot otherwise.
- Once encoded, corresponding personal memories (e.g. never-local-merge-to-dev) are deleted.
```

Replace it with:

```markdown
- Shipped defaults: `gitPolicy: local-commits-only` (most conservative), `reviewDepth: single`,
  `crossModelReview: false`, `onDeviceGate: human-required`, all four model options `auto`.
- The finishing stage branches on `gitPolicy`: local-commits-only ends with the branch handed back (the author's
  mode); `open-pr` automates push + PR for users who want it.
- Before acting on `push-allowed`/`open-pr`, the finishing stage resolves an **effective**
  policy against two external signals — a Claude Code permission `deny` rule on `git
  push`, and the cycle's branch being the repo's default branch — clamping to
  `local-commits-only` for that run if either fires (see
  `docs/superpowers/specs/2026-07-23-git-policy-reconciliation-design.md`).
  `local-commits-only` needs no check; it is already the floor.
- Model names are config values, not skill prose — they rot otherwise.
- Once encoded, corresponding personal memories (e.g. never-local-merge-to-dev) are deleted.
```

- [ ] **Step 3: Add a decision log entry**

In `docs/DECISIONS.md`, find this exact block (the file's intro, ending right before the
first dated entry):

```markdown
# Decision log

Dated records of decisions that changed the project's course, so older docs that predate a
reversal have somewhere to point. Newest first. Each entry: the decision, why, and what it
supersedes. Historical documents (the dry-run report, platform notes, the founding spec)
are evidence of their moment — they get a forward pointer here, never a rewrite.

## 2026-07-23 — superpowers dependency re-pinned to the official plugin directory
```

Replace it with (inserts a new entry at the top, before the existing one, per "Newest
first"):

```markdown
# Decision log

Dated records of decisions that changed the project's course, so older docs that predate a
reversal have somewhere to point. Newest first. Each entry: the decision, why, and what it
supersedes. Historical documents (the dry-run report, platform notes, the founding spec)
are evidence of their moment — they get a forward pointer here, never a rewrite.

## 2026-07-23 — finish stage resolves gitPolicy against external push signals

**Decision:** Before acting on `push-allowed`/`open-pr`, the finish stage
(`/devcycle:cycle` Step 7 and `/devcycle:continue`'s mirrored section) resolves an
**effective** git policy: if a Claude Code permission `deny` rule matches `git push`, or
the cycle's branch is the repo's release/default branch, the effective policy clamps to
`local-commits-only` for that run regardless of the configured value. The finish stage's
Handoff block always states the effective policy, naming the configured value and reason
when they differ. `local-commits-only` needs no check — it was already the floor.
**Why:** `gitPolicy` was evaluated in isolation from anything outside devcycle's own
config. Two gaps followed directly: a Claude Code permission deny on `git push` would
only surface as a failed tool call mid-finish rather than a clean downgrade, and nothing
stopped `push-allowed` from pushing straight to the repo's default branch if a cycle
happened to start there — violating the user's own "never push a release branch
directly" rule with no devcycle-side guard.
**Supersedes:** Nothing reversed — this adds a resolution step in front of the existing
`gitPolicy` branch in `/devcycle:cycle` Step 7 and `/devcycle:continue`, documented in
`docs/superpowers/specs/2026-07-23-git-policy-reconciliation-design.md`.

## 2026-07-23 — superpowers dependency re-pinned to the official plugin directory
```

- [ ] **Step 4: Verify structural checks still pass**

Run: `node scripts/validate.mjs`
Expected: `validate: ok`

Run: `node scripts/redaction-check.mjs`
Expected: `redaction: ok`

- [ ] **Step 5: Commit**

```bash
git add README.md DESIGN.md docs/DECISIONS.md
git commit -m "docs: document gitPolicy effective-policy resolution"
```

---

### Task 4: Scenario test — `git-policy-reconciliation`

**Files:**
- Create: `tests/scenarios/commands/git-policy-reconciliation.md`

**Interfaces:**
- Consumes: the exact `Git policy:` Handoff-line format from Global Constraints (also
  reproduced verbatim in Task 1's and Task 2's diffs) — this task checks that format
  string appears verbatim in real subagent transcripts.
- Produces: nothing consumed by other tasks.

Dependencies: Tasks 1 and 2 (their commits must exist on this branch — this task both
diffs against the pre-Task-1 commit for the baseline/red run and splices the post-Task-2
working-tree text for the green run).

This task is empirical, not code: it follows the same procedure as
`tests/scenarios/commands/first-run-config.md` — real `claude -p` subagent runs against
sandboxed repos, captured verbatim, first against the old text (expected FAIL) then
against the new text (expected PASS). Do not fabricate transcript excerpts; run the
commands below for real and paste the actual output.

- [ ] **Step 1: Locate the pre-change commit**

Run: `git log --oneline --grep "resolve gitPolicy against permission and default-branch signals"`

Expected: one line, the Task 1 commit. Record its short SHA as `TASK1_SHA`.

Run: `git rev-parse ${TASK1_SHA}^`

Record this as `PRE_SHA` — the commit immediately before Task 1's change, i.e. the state
`commands/continue.md` was in before this feature (used for the baseline/red run below).

- [ ] **Step 2: Build the three sandbox variants**

Create a scratch directory outside the repo (e.g. under the scratchpad directory) with
three subdirectories `run-a`, `run-b`, `run-c`. In each: `git init -q`, one commit
containing a minimal `package.json` (`{"name":"sandbox","scripts":{"test":"node
--test"}}`), then create `.devcycle/state.md` with this content, template A (used by
run-a and run-c — configured `gitPolicy=push-allowed`):

```markdown
# devcycle state
- stage: finish
- branch: feat/slugify
- scope: docs/scope.md
- spec: docs/spec.md
- plan: docs/plan.md
- ledger: .superpowers/sdd/progress.md
- checklist: docs/checklist.md
- configured: 2026-07-23 gitPolicy=push-allowed, reviewDepth=single, crossModelReview=false, onDeviceGate=human-required
- updated: 2026-07-23T00:00:00Z
```

and template B (used by run-b only — configured `gitPolicy=open-pr`, per the spec's
explicit requirement to cover the protected-branch signal against `open-pr`, not just
`push-allowed`):

```markdown
# devcycle state
- stage: finish
- branch: main
- scope: docs/scope.md
- spec: docs/spec.md
- plan: docs/plan.md
- ledger: .superpowers/sdd/progress.md
- checklist: docs/checklist.md
- configured: 2026-07-23 gitPolicy=open-pr, reviewDepth=single, crossModelReview=false, onDeviceGate=human-required
- updated: 2026-07-23T00:00:00Z
```

Per variant:
- **run-a (permission-deny):** template A. Default branch `main`; create and check out
  branch `feat/slugify`, commit once more on it (so it's one ahead of `main`). Add
  `.claude/settings.local.json` containing `{"permissions": {"deny": ["Bash(git push:*)"]}}`.
- **run-b (default-branch):** template B. Stay on `main` (the sandbox's default branch) —
  do not create a topic branch. No permission settings file.
- **run-c (no conflict, regression guard):** template A. Identical branch setup to run-a
  (`feat/slugify`, one ahead of `main`) but no `.claude/settings.local.json` at all.

- [ ] **Step 3: Run the baseline (red) subagent against the pre-change text**

For each variant, run (from that variant's sandbox root):

```bash
claude -p "$(cat <<'PROMPT'
You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below.

=== COMMAND (the user invoked `/devcycle:continue`; follow this exactly) ===
[paste here: output of `git show <PRE_SHA>:commands/continue.md` from the devcycle repo]
=== END COMMAND ===

Environment notes: the `claude` and `gh` CLIs are not installed in this sandbox — where the command text says to run either, write the exact command(s) you would run, verbatim, instead of executing them, and reason about their expected output from the sandbox's actual git state (which you may inspect directly, e.g. `git branch --show-current`, `git symbolic-ref refs/remotes/origin/HEAD`, reading `.claude/settings.local.json` if present). You may read and write files and run git commands.
PROMPT
)"
```

Record the full transcript for each of the three variants. Expected (red): none of the
three transcripts contain a `Git policy:` line in the pinned format at all (the
pre-change text has no such line) — run-a and run-c describe pushing unconditionally
under `push-allowed`, and run-b describes pushing and opening a PR unconditionally under
`open-pr`, including run-a and run-b where the new signals should have blocked it.

- [ ] **Step 4: Run the result (green) subagent against the working-tree text**

Same procedure, but splice the current working-tree `commands/continue.md` (post Task 2)
instead of the `PRE_SHA` version. Run all three variants again.

- [ ] **Step 5: Evaluate against pass criteria and write the scenario file**

Create `tests/scenarios/commands/git-policy-reconciliation.md`:

```markdown
# Scenario: git-policy-reconciliation
- Skill under test: commands/continue.md (`/devcycle:continue`) — finish-stage effective
  git-policy resolution (mirrored in commands/cycle.md Step 7)
- Type: output-shape + discipline

Does the finish stage clamp `push-allowed`/`open-pr` to an effective `local-commits-only`
when (a) a Claude Code permission `deny` rule matches `git push`, or (b) the cycle's
branch is the repo's default branch — leaving the configured policy untouched when
neither fires — and does the Handoff block state the effective policy, naming the
configured value and reason when they differ?

## Setup

Three sandbox variants, each a minimal Node repo with `.devcycle/state.md` recording a
fully-completed prior run (`stage: finish`, `configured:` recording `gitPolicy=push-allowed`
for runs A/C or `gitPolicy=open-pr` for run B, plus the other three defaults):

- **Run A (permission-deny, configured `push-allowed`):** default branch `main`; cycle's
  recorded branch is topic branch `feat/slugify`, one ahead of `main`.
  `.claude/settings.local.json` denies `Bash(git push:*)`.
- **Run B (default-branch, configured `open-pr`):** no permission denies. Cycle's
  recorded branch IS `main` — no topic branch was ever created.
- **Run C (no conflict, regression guard, configured `push-allowed`):** no permission
  denies, recorded branch is `feat/slugify` (not the default branch).

The command text is spliced raw, so `${user_config.gitPolicy}` renders literally; the
state file's `configured:` line is what actually governs (same mechanism as the
first-run-config scenario).

## Subagent prompt

[paste the exact prompt template from Step 3/4 above]

## Pass criteria

1. Run A clamps: effective policy is `local-commits-only`, no push attempted. Handoff
   line reads `Git policy: configured push-allowed → effective local-commits-only` with a
   reason naming the permission deny.
2. Run B clamps: effective policy is `local-commits-only`, no push and no PR attempted.
   Handoff line reads `Git policy: configured open-pr → effective local-commits-only`
   with a reason naming the default-branch check.
3. Run C does not clamp: push proceeds (or the exact push command is stated, per the
   environment note) per configured `push-allowed`; Handoff line reads `Git policy:
   push-allowed (no override)`.
4. All three runs still perform `continue.md`'s existing resume logic correctly
   (re-derive position from `.devcycle/state.md`, announce the derived position from file
   evidence) — this scenario is additive, not a replacement for existing resume-stage
   coverage.

## Baseline (red)

[fill in with the actual Step 3 results: date, model, per-variant transcript excerpts,
which criteria fail and why — expected: all three variants fail because the pre-change
text has no `Git policy:` line and no signal checks at all]

## Result (green)

[fill in with the actual Step 4 results: date, model, per-variant transcript excerpts
confirming criteria 1-4 for each variant. State GREEN only if all three variants pass all
applicable criteria; otherwise state exactly which criterion failed on which variant and
stop — do not mark this task done with a failing scenario]
```

If the green run does not pass all criteria, fix `commands/continue.md` and/or
`commands/cycle.md` (re-running Task 1/2's Step "Verify structural checks" after any
fix) and repeat Step 4 until it does — do not write a false GREEN.

- [ ] **Step 6: Commit**

```bash
git add tests/scenarios/commands/git-policy-reconciliation.md
git commit -m "test: add git-policy-reconciliation scenario coverage"
```
