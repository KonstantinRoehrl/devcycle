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

Three sandbox variants, each a minimal Node repo (`package.json` with `"test": "node
--test"`, one commit) with a real `origin` remote (a local bare repo, `HEAD` pointing at
`main`) and `.devcycle/state.md` recording a fully-completed prior run (`stage: finish`,
`configured:` recording `gitPolicy=push-allowed` for runs A/C or `gitPolicy=open-pr` for
run B, plus the other three defaults):

- **Run A (permission-deny, configured `push-allowed`):** default branch `main`; cycle's
  recorded branch is topic branch `feat/slugify`, one commit ahead of `main`, not yet
  pushed. `.claude/settings.local.json` denies `Bash(git push:*)`.
- **Run B (default-branch, configured `open-pr`):** no permission denies. Cycle's
  recorded branch IS `main` — no topic branch was ever created.
- **Run C (no conflict, regression guard, configured `push-allowed`):** no permission
  denies, recorded branch is `feat/slugify` (not the default branch), one commit ahead of
  `main`, not yet pushed.

The command text is spliced raw, so `${user_config.gitPolicy}` renders literally; the
state file's `configured:` line is what actually governs (same mechanism as the
first-run-config scenario). Baseline (red) splices `commands/continue.md` as of
`e033858` (`PRE_SHA`, the commit immediately before Task 1's
`46632d3 feat(cycle): resolve gitPolicy against permission and default-branch signals`
— i.e. the state `commands/continue.md` was in before this feature existed, since Task 1
touched `commands/cycle.md` and the mirrored `commands/continue.md` change landed one
commit later in `0e50685`). Result (green) splices the current working-tree
`commands/continue.md` (post Task 2's `0e50685` + `e03201d` fix).

Each sandbox is exercised twice from a fresh clone of its post-setup state — once against
the red text, once against the green text — with git state (and `.devcycle/state.md`)
restored between runs whenever a run actually pushed or wrote to disk, so the two runs
per variant start from byte-identical fixtures.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below.
>
> === COMMAND (the user invoked `/devcycle:continue`; follow this exactly) ===
> [paste here: `git show e033858:commands/continue.md` for the baseline run, or the working-tree `commands/continue.md` for the result run]
> === END COMMAND ===
>
> Environment notes: the `claude` and `gh` CLIs are not installed in this sandbox — where the command text says to run either, write the exact command(s) you would run, verbatim, instead of executing them, and reason about their expected output from the sandbox's actual git state (which you may inspect directly, e.g. `git branch --show-current`, `git symbolic-ref refs/remotes/origin/HEAD`, reading `.claude/settings.local.json` if present). You may read and write files and run git commands.

Run via `claude -p "<prompt above>" --model sonnet --dangerously-skip-permissions` from
each sandbox's root (real `git`, no network — the sandboxes' `origin` remotes are local
bare repos, so a real `git push` genuinely succeeds or fails rather than needing to be
narrated hypothetically).

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

Runs 2026-07-23 — fresh headless subagents (`claude -p --model sonnet
--dangerously-skip-permissions`), sandboxes per Setup, prompt spliced from
`git show e033858:commands/continue.md` (no `Git policy:` line, no permission/
default-branch signal checks anywhere in that text — confirmed by reading the file
directly before running).

- **Run A** (deny rule present, configured `push-allowed`): the agent read
  `.devcycle/state.md` and cross-checked git, found the recorded branch matched and
  no execution-artifact trail (`docs/*.md`, the ledger) existed, and — on its own
  initiative, not because the command text told it to — noticed
  `.claude/settings.local.json`'s deny rule and refused to push, asking the user how to
  proceed: *"`git push` is explicitly denied in this repo's local settings. Do you want
  me to (a) respect that and just hand the branch back with a status report (equivalent
  to `local-commits-only` behavior), or (b) is the deny stale...?"* No `Git policy:` line
  anywhere in the transcript — there is no such line in the source text to produce, and
  no structured signal-checking occurred (the deny rule was noticed by general judgement,
  not by a specified two-signal resolution procedure).
- **Run B** (recorded branch is `main`, configured `open-pr`): the agent likewise
  stopped short, citing its own standing git-workflow rule against pushing `main`
  directly rather than anything in the command text: *"`main` here is the default
  branch (`origin/main`), so the finish-stage instruction 'push the branch, open a PR'
  can't sensibly apply... and I won't push it directly regardless."* No `Git policy:`
  line; no default-branch check is defined anywhere in the pre-change text.
- **Run C** (no conflict): result varied by run (two red attempts were made against this
  variant while stabilizing the sandbox fixture — see Concerns in the task report) — one
  attempt pushed unconditionally (`git push origin feat/slugify` executed for real,
  confirmed on the bare `origin` afterward, `state.md` updated to `status: complete —
  pushed feat/slugify to origin (gitPolicy=push-allowed), no merge performed`), the other
  stopped to question the missing execution artifacts before pushing. Neither transcript
  contains a `Git policy:` line or any signal check — consistent either way with the
  pre-change text having no such logic.
- Net: **RED** — none of the three transcripts contain the pinned `Git policy:` format
  anywhere, and no transcript performs a structured two-signal resolution; whatever
  caution appeared (runs A/B) came from the agent's own general judgement, not from the
  command text, which defines no such check.

## Result (green)

Runs 2026-07-23 — same protocol, working-tree `commands/continue.md` spliced in (Task 1 +
Task 2's mirrored resolution and Handoff narration).

- **Run A** PASS (criterion 1): derived position matched (`branch: feat/slugify`, no
  mismatch), flagged the same missing-artifact discrepancy as red (informational, not
  blocking), then ran the resolution explicitly: *"Signal 1 (push-deny rule):
  `.claude/settings.local.json` in this project contains `"deny": ["Bash(git push:*)"]`
  — this matches `git push` → fires. Signal 2 (branch is default branch):
  `git symbolic-ref refs/remotes/origin/HEAD` → `refs/remotes/origin/main`. Recorded
  branch is `feat/slugify`, not `main` → does not fire. Effective policy:
  `local-commits-only` (clamped from `push-allowed`)."* Handoff block:
  `Git policy: configured push-allowed → effective local-commits-only (a permission
  rule denies git push)` — exact pinned format, exact reason string. No push attempted;
  confirmed on disk (`origin`'s `feat/slugify` ref does not exist; local branch unchanged).
- **Run B** PASS (criterion 2): derived position matched (`branch: main`, no mismatch).
  Resolution: *"Deny rule for `git push`? ... No deny rule found. Is the recorded branch
  (`main`) the repo's default branch? `git symbolic-ref refs/remotes/origin/HEAD` →
  `refs/remotes/origin/main`. Recorded branch `main` is the default branch. → Signal
  fires."* Handoff block: `Git policy: configured open-pr → effective
  local-commits-only (current branch is the repo's default branch; direct pushes to it
  are not allowed)` — exact pinned format, exact reason string. No push, no PR attempted;
  confirmed on disk (origin unchanged, no PR-related output beyond the stated resolution).
- **Run C** PASS (criterion 3): derived position matched (`branch: feat/slugify`, no
  mismatch, flagged the same missing-artifact discrepancy as informational). Resolution:
  neither signal fired (no deny rule; `git symbolic-ref refs/remotes/origin/HEAD` →
  `refs/remotes/origin/main` ≠ `feat/slugify`) → effective = configured = `push-allowed`.
  The agent actually ran the push (real git, real local `origin`): Handoff block reads
  `Git policy: push-allowed (no override)` — exact pinned format — with `Branch:
  feat/slugify (pushed)` and `Result: feat/slugify pushed to origin (commit 69b0929).
  No merge performed, per policy.` Confirmed independently on the bare `origin` repo
  (`git log --oneline feat/slugify` on `origin-c.git` shows `69b0929 feat: wip slugify
  helper` — the push genuinely happened, not narrated) and in `.devcycle/state.md`,
  which the agent appended: `- handoff: 2026-07-23 pushed feat/slugify to origin
  (effective gitPolicy=push-allowed, no clamp); no merge performed`.
- Criterion 4, all three runs: each re-derived stage/branch from `.devcycle/state.md`
  before acting and stated it plainly (runs A and B narrate a full "derived position"
  section including the missing-artifact discrepancy; run C's response is terser — a
  compact Handoff block plus a flag about the same missing artifacts — but its `Stage:
  finish · Branch: feat/slugify` line and on-disk `handoff:` note confirm the position
  was correctly re-derived from file evidence, just narrated more tersely than A/B).
  PASS on all three, with the noted variance in verbosity for run C.
- Net: **GREEN** — all four criteria met on all three variants.

### Notes on running this scenario

- Two authoring passes were needed to get a clean run-C result: the first sandbox build
  had no `origin` remote on any variant, which caused run C's green transcript to resolve
  the policy correctly (`push-allowed`, no clamp) but stop short of the pinned Handoff
  format — it stated the exact push command it would run per the environment note
  (`git push -u origin feat/slugify`) but, on hitting "no remote configured," asked the
  user how to proceed instead of completing a Handoff block, because a *real* push would
  have failed for a reason unrelated to gitPolicy. Rebuilding all three sandboxes with a
  real local bare-repo `origin` (matching how run A's and run B's clamped variants already
  behaved regardless of remote, since they never needed to push) let run C's push actually
  succeed and resolved this — it is a sandbox-fidelity fix, not a change to
  `commands/continue.md` or `commands/cycle.md`.
- A second reset of run C between its red and green invocations left a stale local
  `refs/remotes/origin/feat/slugify` tracking ref (from an earlier red attempt that had
  pushed for real) after the bare `origin` repo was recreated; this made the green run's
  "already up to date with origin" observation false. The variant was rebuilt from
  scratch (fresh `.git`, fresh bare `origin`) and both red and green were rerun; the
  figures and quotes above are from that clean rebuild.
- Model responses showed real run-to-run variance on how they handled the sandboxes'
  missing `docs/scope.md` / `docs/spec.md` / `docs/plan.md` / `docs/checklist.md` /
  ledger files (not part of this feature's scope — those paths are named by
  `.devcycle/state.md` per the Setup but were never created, since this scenario only
  exercises the finish-stage git-policy resolution) — sometimes stopping to ask about the
  discrepancy, sometimes treating it as a non-blocking flag. This did not affect any
  pass/fail criterion: every red run failed to produce a `Git policy:` line regardless of
  which path it took, and every green run reached and correctly narrated the policy
  resolution regardless of which path it took.
