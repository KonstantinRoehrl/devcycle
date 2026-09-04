# devcycle documentation

The documentation hub for devcycle. The top-level [`README.md`](../README.md) is the
cold-reader entry point — what the plugin is and how to install it. This is where you go
deeper: the design, the pipeline, each playbook, the configuration surface, the decision log,
and the full inventory of everything the plugin ships.

## Go deeper

- [`design/`](design/README.md) — why the plugin is shaped the way it is: the folder contract, the boundaries between commands, playbooks, agents, and workflows, and the constraints they hold to.
- [`pipeline/`](pipeline/README.md) — how a request moves through the stages, why every subagent works from its own brief, and where the handoffs sit.
- [`playbooks/`](playbooks/) — one page per playbook: the behaviour spec each stage follows (browse the directory; each playbook has its own page).
- [`configuration/`](configuration/README.md) — the options, the profile presets, and how a value resolves when you configure some but not all of them.
- [`decisions/`](decisions/README.md) — the decision log: the choices that shaped devcycle and why each was made.
- [`platform-notes.md`](platform-notes.md) — platform verification notes and the §10.D gate.
- [`routing.md`](routing.md) — which command answers which intent, and what each may do before your first confirmation.
- [`known-issues.md`](known-issues.md) — confirmed open defects in devcycle's own engines, each with a located cause.

## Commands

The `/devcycle:*` slash commands are the whole invocable surface; everything below them is
machinery a command loads by path.

| Command | What it does |
| --- | --- |
| [`/devcycle:cycle`](../commands/cycle.md) | Runs the full pipeline for a request — scope, plan, execute, review, finish. |
| [`/devcycle:continue`](../commands/continue.md) | Resumes an interrupted cycle: lists every in-flight cycle in this repo with its branch, stage, and age, and asks which one. |
| [`/devcycle:review`](../commands/review.md) | Reviews a branch, the whole repository, or a named file set against criteria you confirm, and writes a ranked findings document; on a branch with an open PR, can opt in to filing those findings back onto it. Standalone. |
| [`/devcycle:verify`](../commands/verify.md) | Walks an on-device checklist derived from a branch's diff — verification for code this session did not write. Standalone. |
| [`/devcycle:learn`](../commands/learn.md) | Mines this repo's sessions and memory for recurring patterns and proposes doc and skill edits for confirmation. Standalone. |
| [`/devcycle:doctor`](../commands/doctor.md) | Profiles token cost, context depth, model routing, and agent startup cost across devcycle sessions. Standalone. |
| [`/devcycle:onboard`](../commands/onboard.md) | Bootstraps tier-2 setup: detects real build/test/lint commands, scaffolds `CLAUDE.md`, and proposes a permission allowlist. Standalone. |
| [`/devcycle:maintain`](../commands/maintain.md) | Assesses a repository's longitudinal health — how its abstractions and history trend over time — and writes a ranked findings document. Read-only, standalone. |
| [`/devcycle:reconcile`](../commands/reconcile.md) | The respond arm of the review write-back path: triages a PR's review comments into fixes and consent-gated replies that disclose Claude Code authorship, then resolves the threads it closed from its side. |

## Playbooks

The behaviour spec each stage follows. A command loads these by path; you never invoke them
directly.

| Playbook | What it does |
| --- | --- |
| [`scoping-the-request`](playbooks/scoping-the-request/README.md) | The batched scope interview, with a hard stop before design begins. |
| [`planning-waves`](playbooks/planning-waves/README.md) | Feasibility gate plus wave-structured planning, with self-review gates including budget-fixture and authored-claims checks. |
| [`executing-waves`](playbooks/executing-waves/README.md) | Parallel subagent execution with green gate, ledger, and commit discipline. |
| [`reviewing-code`](playbooks/reviewing-code/README.md) | The shared review engine: lens construction, engine selection, adversarial verification, dedup, and ranking; plus the opt-in write-back that files an audit run's findings onto an open PR. |
| [`reviewing-the-branch`](playbooks/reviewing-the-branch/README.md) | The whole-branch review gate — spec-compliance layer and bounded rounds, over the shared review engine. |
| [`verifying-on-device`](playbooks/verifying-on-device/README.md) | Human-verified checklist for rendered and on-device outcomes. |
| [`finishing-the-cycle`](playbooks/finishing-the-cycle/README.md) | Resolves the effective git policy and hands back, pushes, or opens the PR. |
| [`taking-the-fast-path`](playbooks/taking-the-fast-path/README.md) | Mini-cycle for confirmed-trivial requests. |
| [`sweeping-mechanical-changes`](playbooks/sweeping-mechanical-changes/README.md) | Triage-confirmed bulk sweep behind a blast-radius gate. |
| [`learning-from-sessions`](playbooks/learning-from-sessions/README.md) | Observe, propose, confirm, land: mines transcripts and memory for durable changes. |
| [`profiling-sessions`](playbooks/profiling-sessions/README.md) | Runs and interprets the token, context, routing, and startup-cost analyzer. |
| [`onboarding-a-repo`](playbooks/onboarding-a-repo/README.md) | Detects a repo's real build/test/lint commands and scaffolds its setup. |
| [`maintaining-the-repo`](playbooks/maintaining-the-repo/README.md) | The longitudinal-health engine behind `/devcycle:maintain`. |
| [`receiving-review`](playbooks/receiving-review/README.md) | The respond arm of the review write-back path: the standalone reconcile stage that triages a PR's review comments into fixes and consent-gated replies that disclose Claude Code authorship, then resolves the threads it closed from its side. |

## Machinery

The Node workflows the playbooks drive by path.

| Component | What it does |
| --- | --- |
| [`workflows/review-panel.js`](../workflows/review-panel.js) | Multi-lens read-only review engine for `reviewDepth: panel`. |
| [`workflows/mechanical-sweep.js`](../workflows/mechanical-sweep.js) | Pilot-first bulk edit engine behind the sweep path. |
| [`workflows/lib/agent-cli.js`](../workflows/lib/agent-cli.js) | The subprocess layer both workflow engines share to drive `claude` in print mode. |

## Hooks

The hooks the plugin ships. No command loads them; each fires on a matched tool call.

| Hook | What it does |
| --- | --- |
| [`hooks/block-main-thread-browser.mjs`](../hooks/block-main-thread-browser.mjs) | Registered on `PreToolUse` over `mcp__claude-in-chrome__.*`, it denies any browser tool call whose origin is not the `on-device-driver` subagent — the main thread included — so the coordinator cannot drive the browser at its own context depth ([`decisions/`](decisions/README.md), 2026-08-20). |
| [`hooks/block-reviewer-git-write.mjs`](../hooks/block-reviewer-git-write.mjs) | Registered on `PreToolUse` over `Bash`, it denies destructive or ambiguous git subcommands (`checkout`/`reset`/`restore`/`clean`/`stash`/…) from a reviewer origin (`task-reviewer`, `red-team-reviewer`), allowing only inspection commands and `git add -N` — the structural backstop for the reviewer-write ban (#165). |
| [`hooks/workload-sensor.mjs`](../hooks/workload-sensor.mjs) | Registered on `PostToolUse` over `Bash`, it re-derives the run's `workload` record from `.devcycle/state.md` and git on each HEAD-advancing commit in an active cycle, so workload collection never depends on the finish stage running ([`playbooks/finishing-the-cycle/`](playbooks/finishing-the-cycle/README.md)). |

## Agents

The read-only or single-task subagents a stage dispatches.

| Agent | What it does |
| --- | --- |
| [`implementer`](../agents/implementer.md) | Implements one task from a brief; never commits. |
| [`task-reviewer`](../agents/task-reviewer.md) | Read-only reviewer for each task during execution. |
| [`red-team-reviewer`](../agents/red-team-reviewer.md) | Adversarial read-only charter, spliced into the panel's per-finding verification pass. |
| [`on-device-driver`](../agents/on-device-driver.md) | Drives claude-in-chrome for the on-device stage; never decides whether an item passes. |
| [`history-inspector`](../agents/history-inspector.md) | Read-only git-history lens for `/devcycle:maintain`. |

## References

| Reference set | What it holds |
| --- | --- |
| [`references/`](../references/README.md) | The shared mechanism docs — evidence, delegation, handoff, quality criteria, config, and the rest. The [references index](../references/README.md) is the single inventory of what each file owns. |

## Historical / archive

- [`comparisons/`](comparisons/) — a frozen snapshot comparing five of the shipped playbooks against their upstream `superpowers` skills. It is baselined on an older `superpowers` (6.1.1) than the one now installed (6.3.0), so it is a historical record, not a current account; do not read it as the live behaviour.
