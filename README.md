# devcycle

A Claude Code plugin that turns a one-line feature, bug, or refactor description into a
verified, reviewed implementation on its own git branch. You type one command; devcycle
interviews you about scope, designs a spec with you, plans the work as parallel tasks,
implements them test-first with subagents, reviews the finished branch against the spec, and —
when changes are visible on screen — walks you through checking them on the running app.

Policy — what it may do with git, which models it runs, how deep reviews go — is
configuration, not something you re-explain each session. It builds on the [superpowers]
plugin (a required dependency) instead of replacing it: where superpowers already does
something well, devcycle invokes it; devcycle adds the stages, gates, and mechanics around it.

## Install

```
claude plugin marketplace add KonstantinRoehrl/devcycle
claude plugin install devcycle@devcycle
```

devcycle depends on the [superpowers] plugin — install it per its own instructions.
Until superpowers is present, `claude plugin list` shows devcycle as failed to load; once
both are installed, it shows `devcycle` and `superpowers` as enabled.

For the on-device verification stage's automatic checks, also set up the [Playwright] MCP
server (see below — without it, every checklist item falls to you).

## Use

Start a cycle with a description of any maturity — a one-liner is fine:

```
/devcycle:cycle add CSV export to the report page
```

What to expect: devcycle first judges how developed your description is (a rough idea starts
with a scope interview; a detailed ticket skips ahead). Questions come in small batches with
concrete options to pick from, never one-at-a-time trickles. You approve the spec, then the
plan; implementation, testing, and review then run without you; at the end you get a branch
(and, for UI work, a short guided walkthrough of what to check on the running app).

The pipeline saves its position to files (`.devcycle/state.md` plus its spec/plan/ledger
artifacts) at every stage boundary, so it survives `/clear`, compaction, and new sessions.
Resume any time with:

```
/devcycle:continue
```

## The pipeline

1. **Scoping** — batched interview that turns your request into a precise, well-structured
   goal: you answer questions about intent and desired outcomes; devcycle researches the
   repo itself to establish what the change touches and confirms that picture with you.
   Skipped when your input is already concrete.
2. **Brainstorm** — collaborative design (upstream `superpowers:brainstorming`); ends with a
   spec you approve.
3. **Planning** — a feasibility check, then an implementation plan that doubles as the
   execution strategy: the work is cut into small, self-contained tasks — each implementable
   from its own brief alone, so every subagent works with a small context — dependencies are
   derived from what each task consumes, and everything not forced into sequence by a real
   dependency is grouped into *waves* of file-disjoint tasks that run in parallel. You
   approve the plan.
4. **Execution** — each task goes to a fresh implementer subagent carrying only that task's
   brief, working test-first (failing test before code). A reviewer checks every task, the
   coordinator re-runs the tests itself before accepting (the *green gate*), and only
   accepted work is committed.
5. **Branch review** — a fresh reviewer (no memory of the implementation) reviews the whole
   branch against the spec: everything the spec asked for is there, nothing it didn't ask
   for crept in.
6. **On-device verification** — for changes a human can see: a checklist of outcomes to
   confirm on the running app. What a browser can structurally verify (DOM, CSS values,
   exact text) is auto-checked through the [Playwright] MCP and tagged `(auto)`; everything
   a script cannot truly see — feel, alignment, smoothness, legibility — is walked with you
   one item at a time. Skipped when nothing renders.
7. **Finish** — hands the branch back per your `gitPolicy` (below).

Why the stages are shaped this way — fresh-context reviews, files-as-state, wave
parallelism — is covered in [DESIGN.md](DESIGN.md).

## What's in the plugin

| Piece | What it does |
| --- | --- |
| `/devcycle:cycle` | Runs the pipeline for a request. |
| `/devcycle:continue` | Resumes an interrupted pipeline from the state file. |
| Skill `scoping-interview` | The batched scope interview with a hard stop before design begins. |
| Skill `planning-waves` | Feasibility gate + wave-structured planning (extends `superpowers:writing-plans`). |
| Skill `executing-waves` | Parallel subagent execution with green gate, ledger, and commit discipline. |
| Skill `reviewing-the-branch` | The whole-branch review gate, single-reviewer or panel. |
| Skill `verifying-on-device` | Human-verified checklist for rendered/on-device outcomes. |
| Agent `implementer` | Implements one task from a brief; never commits. |
| Agents `task-reviewer`, `red-team-reviewer` | Read-only reviewers used by execution and the panel. |
| Workflow `review-panel.js` | Multi-lens branch review engine for `reviewDepth: panel`. |
| Workflow `mechanical-sweep.js` | Pilot-first bulk edit helper for repetitive changes. |

## Configuration

Set options with `/plugin configure devcycle@devcycle` (or
`claude plugin install devcycle@devcycle --config KEY=VALUE`). Everything has a working
default; configure nothing and the pipeline still runs.

| Option | What it controls | Values | Default |
| --- | --- | --- | --- |
| `gitPolicy` | What the finish stage may do with git | `local-commits-only` / `push-allowed` / `open-pr` | `local-commits-only` |
| `reviewDepth` | How the branch review runs | `single` / `panel` | `single` |
| `crossModelReview` | Adds a second-model lens to the panel | `true` / `false` | `false` |
| `onDeviceGate` | Whether a human must finish the on-device checklist | `human-required` / `auto-ok` | `human-required` |
| `implementerModel` | Model for implementer subagents | model id | `claude-opus-4-8` |
| `taskReviewerModel` | Model for per-task reviewers | model id | `claude-sonnet-5` |
| `branchReviewModel` | Model for the whole-branch review | model id | `claude-opus-4-8` |
| `walkthroughModel` | Model for the on-device walkthrough session | model id | `claude-sonnet-5` |

**`gitPolicy`** is the pipeline's blast radius: `local-commits-only` means it only ever
commits on a local branch and hands it to you (never pushes); `push-allowed` lets it push
the branch (never merge); `open-pr` lets it push and open a pull request (never merge that
either). Merging is always yours.

**`reviewDepth`** picks the branch-review engine. `single` is one reviewer running Claude
Code's built-in `code-review` skill plus devcycle's spec-compliance checks. `panel` runs
`review-panel.js` instead: two to three read-only reviewers, each with a different lens
(spec compliance; correctness and security; simplification), whose findings are
adversarially re-verified against the code and merged into one report — slower and more
expensive, harder to fool. With `crossModelReview: true` the panel adds one more lens run
by a non-Claude model via the `codex` CLI, if installed — a hedge against blind spots one
model family might share.

**`onDeviceGate`** governs the last verification. The checklist is hybrid by design:
items a browser can structurally verify are auto-checked through the [Playwright] MCP
(set it up per its docs; without it, nothing is auto-checked and every item is yours);
the rest need a human. `human-required` (default) blocks the pipeline until you've walked
every human item; `auto-ok` lets it finish once the auto-checkable items pass, explicitly
listing what remains unverified — it skips the human, it never fakes the checkmarks.

The four **model options** trade cost against capability per role. Defaults put the
strongest model where judgment matters (implementation, final review) and a faster one
where the task is narrower (per-task review, walkthrough).

## See a real run

[docs/dry-run-report.md](docs/dry-run-report.md) — a complete cycle against a sandbox repo,
run headless with nothing configured: every stage, the artifacts it produced, and the rough
edges it exposed.

## Learn more

Design rationale and architecture: [DESIGN.md](DESIGN.md) ·
Release history: [CHANGELOG.md](CHANGELOG.md)

[superpowers]: https://github.com/obra/superpowers
[Playwright]: https://github.com/microsoft/playwright
