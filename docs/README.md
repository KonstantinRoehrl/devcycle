# devcycle documentation

The documentation hub for devcycle. The top-level [`README.md`](../README.md) is the
cold-reader entry point — what the plugin is and how to install it. This is where you go
deeper: the design, the pipeline, each playbook, the configuration surface, the decision log,
and the full inventory of everything the plugin ships.

## Go deeper

- [`design/`](design/README.md) — why the plugin is shaped the way it is: the folder contract, the boundaries between commands, playbooks, agents, and workflows, and the constraints they hold to.
- [`pipeline/`](pipeline/README.md) — how a request moves through the stages, why every subagent works from its own brief, and where the handoffs sit.
- [`playbooks/`](playbooks/) — one page per playbook: the behaviour spec each stage follows (browse the directory; each playbook has its own page).
- [`playbooks/executing-waves/unattended.md`](playbooks/executing-waves/unattended.md) — running execution unattended: opting in at execution start, how /devcycle:continue starts, watches and restarts the driver, what the driver does and refuses, its options and exit codes, and how to stop it.
- [`configuration/`](configuration/README.md) — the options, the profile presets, and how a value resolves when you configure some but not all of them.
- [`decisions/`](decisions/README.md) — the decision log: the choices that shaped devcycle and why each was made.
- [`platform-notes.md`](platform-notes.md) — platform verification notes and the §10.D gate, including what a plugin update does to a running cycle (§ (m)).
- [`routing.md`](routing.md) — which command answers which intent, and what each may do before your first confirmation.
- [`known-issues.md`](known-issues.md) — confirmed open defects in devcycle's own engines, each with a located cause.
- [`case-studies/`](case-studies/) — devcycle's own before/after payoff, measured from its session corpus. Currently a dated checkpoint: doctor's matched-cohort bar is not yet cleared, so no payoff number is published.

## Commands

The `/devcycle:*` slash commands are the whole invocable surface; everything below them is
machinery a command loads by path.

| Command | What it does |
| --- | --- |
| [`/devcycle:cycle`](../commands/cycle.md) | Runs the full pipeline for a request — scope, plan, execute, review, finish. |
| [`/devcycle:continue`](../commands/continue.md) | Resumes an interrupted cycle: lists every in-flight cycle in this repo with its branch, stage, and age, and asks which one. Warns when the previous session never reached its handoff. At execution start runs the waves as `executionMode` says — `unattended` starts the driver with no question, `ask` asks, then starts and watches the driver; attaches to a cycle a driver is running. `--drive <state>` is the driver's own entry for each driven session, inert without a live driver lock naming that state file and the token that driver hands its sessions. |
| [`/devcycle:stop`](../commands/stop.md) | Stops a cycle at once, at any stage, walked or unattended: halts its work, stops what the platform lets a plugin reach, names what it cannot, and records the position so `/devcycle:continue` resumes at that step. |
| [`/devcycle:review`](../commands/review.md) | Reviews a branch, the whole repository, or a named file set against criteria you confirm, and writes a ranked findings document; on a branch with an open PR, can opt in to filing those findings back onto it. Standalone. |
| [`/devcycle:verify`](../commands/verify.md) | Walks an on-device checklist derived from a branch's diff — verification for code this session did not write. Standalone. |
| [`/devcycle:learn`](../commands/learn.md) | Mines this repo's sessions and memory for recurring patterns and proposes doc and skill edits for confirmation; its report carries a per-period ledger netting recorded win savings against culprit cost, and a routing advisory comparing measured cost per accepted task against the cheapest cell that clears its minimum-dispatch floor, across the models this repo dispatched to. Standalone. |
| [`/devcycle:doctor`](../commands/doctor.md) | Profiles token cost, context depth, model routing, and agent startup cost across devcycle sessions; every cost-analysis reply carries a per-version and per-stage overview. Standalone. |
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
| [`reviewing-code`](playbooks/reviewing-code/README.md) | The shared review engine: lens construction, engine selection, adversarial verification, dedup, and ranking. |
| [`writing-the-findings-document`](playbooks/writing-the-findings-document/README.md) | The ranked findings document an audit run or a `/devcycle:maintain` pass ends in, plus the opt-in filing step onto an open PR. |
| [`reviewing-the-branch`](playbooks/reviewing-the-branch/README.md) | The whole-branch review gate — spec-compliance layer and bounded rounds, over the shared review engine — and the call whether on-device applies: a branch with nothing on screen goes straight to finish. |
| [`verifying-on-device`](playbooks/verifying-on-device/README.md) | Launches the app, lets the browser driver settle what it can, and asks you one batch of proposed verdicts plus the items only your eyes can judge. |
| [`finishing-the-cycle`](playbooks/finishing-the-cycle/README.md) | Resolves the effective git policy and hands back, pushes, or opens the PR. |
| [`taking-the-fast-path`](playbooks/taking-the-fast-path/README.md) | Mini-cycle for confirmed-trivial requests. |
| [`sweeping-mechanical-changes`](playbooks/sweeping-mechanical-changes/README.md) | Triage-confirmed bulk sweep behind a blast-radius gate. |
| [`learning-from-sessions`](playbooks/learning-from-sessions/README.md) | Observe, propose, confirm, land: mines transcripts and memory for durable changes. |
| [`profiling-sessions`](playbooks/profiling-sessions/README.md) | Runs and interprets the token, context, routing, and startup-cost analyzer; carries its script-rendered overview and trend summary into every cost-analysis reply; models the price table lacks are excluded from dollar figures and reported apart. |
| [`onboarding-a-repo`](playbooks/onboarding-a-repo/README.md) | Detects a repo's real build/test/lint commands and scaffolds its setup. |
| [`maintaining-the-repo`](playbooks/maintaining-the-repo/README.md) | The longitudinal-health engine behind `/devcycle:maintain`. |
| [`receiving-review`](playbooks/receiving-review/README.md) | The respond arm of the review write-back path: the standalone reconcile stage that triages a PR's review comments into fixes and consent-gated replies that disclose Claude Code authorship, then resolves the threads it closed from its side. |

## Machinery

The engines, guards, and shims a command or playbook drives by path. The rest of `scripts/` is
this repo's own checkers and libraries; [`CONTRIBUTING.md`](../CONTRIBUTING.md) lists the ones you
run locally.

| Component | What it does |
| --- | --- |
| [`workflows/review-panel.js`](../workflows/review-panel.js) | Multi-lens read-only review engine that runs when the review depth is `panel`, set or picked by `reviewDepth: auto`. |
| [`workflows/mechanical-sweep.js`](../workflows/mechanical-sweep.js) | Pilot-first bulk edit engine behind the sweep path. |
| [`workflows/lib/agent-cli.js`](../workflows/lib/agent-cli.js) | The subprocess layer both workflow engines share to drive `claude` in print mode. |
| [`scripts/self-dev-check.mjs`](../scripts/self-dev-check.mjs) | The self-development landing guard, inert unless the repo under work is this plugin's own source: `--preflight` records what the installed copy holds when a run starts and reports how far it has drifted from the repo, `--assert` fails the finish stage when an expected deliverable is absent from the branch or the installed copy was written to during the run, and `--plugin-digest` mints the run record's content-based plugin identifier. |
| [`scripts/tree-hash.mjs`](../scripts/tree-hash.mjs) | Content identity for a directory tree — the per-file hashes and rolling digest both the landing guard and the run record's plugin identifier read, independent of any version string or VCS state. |
| [`scripts/depth-probe.mjs`](../scripts/depth-probe.mjs) | The depth gate's probe: measures one transcript's last usage record against the running model's context window and prints its depth band; `--agent <id>` measures a subagent's transcript instead of the session's. A model id that names no priced model or family version (after unwrapping `[1m]`, Bedrock and Vertex forms) is measured against an assumed 1M window, labelled as assumed; an unpriced version older than its family's newest priced model has no known window, so its band is reported unknown and the probe exits 1. |
| [`scripts/plan-check.mjs`](../scripts/plan-check.mjs) | Planning's one plan gate: seven legs over the plan file, fail-closed on a missing `## Dispatch Map`, one compact line on success (plus a note count per leg that has notes); while a run is active it appends a `gate-ran` run-record event carrying `pass` or `fail`. |
| [`scripts/read-section.mjs`](../scripts/read-section.mjs) | Prints one `##` section of a reference — the section-read citation form, so a step loads only the section it executes. A citation that turned a heading's apostrophe into a hyphen still resolves; a miss lists the file's sections. |
| [`scripts/wave-setup.mjs`](../scripts/wave-setup.mjs) | `/devcycle:continue`'s execution resume in one call: the ownership check, `resume-check`, the knob comparison, the branch verdict, the depth probe, the plan's wave overview, the ledger slot's verdict and the drive status with its action, then every current-wave task's resume position, with its brief inputs and next review round until it is committed, and the next implementer dispatches, as one JSON object. |
| [`scripts/ledger-slot.mjs`](../scripts/ledger-slot.mjs) | Judges the execution ledger slot: a ledger, or per-task files with no ledger, that another plan or run left is stale, and `--reset` archives it before this run writes its own. |
| [`scripts/task-dispatch.mjs`](../scripts/task-dispatch.mjs) | Writes one implementer or reviewer brief and appends its ledger line, with the next retry index, right before the dispatch; an implementer brief gets the task's matched lessons, and a reviewer dispatch takes only the task's next review round and first moves aside a findings file already at that round's path. A gated implementer brief's gate line states the before/after capture rule by citing it. |
| [`scripts/dispatch-health.mjs`](../scripts/dispatch-health.mjs) | Classifies this session's in-flight dispatches from their records, transcripts and owed files; writes `dispatch-ended` and routes a redispatch once per role (CLI for the coordinator, library for the driver's watchdog, the band and the SubagentStop sensor). |
| [`scripts/task-intake.mjs`](../scripts/task-intake.mjs) | Checks an implementer's report and its evidence fields, lints it for unguarded claims, missing evidence, a `cmd:` that is not the task's gate, and a red explained away without its reproduction file, and answers review, bounce, missing-report or needs-user — retries capped at two. With `--compose-review`, a review answer also writes the reviewer brief and its review round, once per round. The reviewer brief names the findings file by absolute path. |
| [`scripts/task-verdict.mjs`](../scripts/task-verdict.mjs) | Checks the reviewer's findings file and records its verdict — accepted, rejected, missing or unparseable findings (each named with its reason), or needs-user once the round cap or the shared no-verdict retry cap is spent. Given the task commit's flags, an accepted verdict runs `task-commit.mjs` in-process and prints its result. |
| [`scripts/task-commit.mjs`](../scripts/task-commit.mjs) | The coordinator-owned green gate and the task's commit: commits only the task's Files with a `Devcycle-Task: <run>/<task>` trailer, then re-runs the task's gate command itself in a scratch worktree detached at that commit ([`scripts/commit-proof.mjs`](../scripts/commit-proof.mjs)) and takes the commit back if it is red. Finds an earlier commit of the same task instead of committing twice, proving it first. A red gate after round 3's acceptance exhausts the review loop (`needs-user`). |
| [`scripts/capture-evidence.mjs`](../scripts/capture-evidence.mjs) | Runs a task's gate command, or an explicit one, and writes its evidence capture with the command it ran as the header, then prints the report lines to copy. |
| [`scripts/drive-signal.mjs`](../scripts/drive-signal.mjs) | A driven session's only channel to its driver: writes `.devcycle/drive-stop.json` with a named stop reason and a one-line detail. |
| [`scripts/drive-execution.mjs`](../scripts/drive-execution.mjs) | The unattended-execution driver: started by `/devcycle:continue` once the cycle is opted in at execution start, by the user's answer or `executionMode=unattended`, runs one fresh `claude -p` session per wave until branch review, stopping at the first gate that needs the user; POSIX only ([`playbooks/executing-waves/unattended.md`](playbooks/executing-waves/unattended.md)). |
| [`scripts/stop-cycle.mjs`](../scripts/stop-cycle.mjs) | What `/devcycle:stop` runs: lists stoppable cycles, writes the stop request, stops the driver and the on-device app through their owners, then writes `.devcycle/stop.json` and the state file's `stopped:` row. It also lists each foreground subagent the dispatch records show running, which only halts at its next tool call: a record of this cycle's ledger slot and run, never one a stopped driver's own session left (those it stamps stopped). Its `finalize` JSON carries `resume`, `name` or `hold`, the verdict on whether the report may name `/devcycle:continue`. `/devcycle:continue` calls its `resume` to drop that row and file the record under `.devcycle/stop-history/`. |
| [`scripts/review-depth.mjs`](../scripts/review-depth.mjs) | Picks the review engine for `reviewDepth: auto` at `branch` scope: `single` at `lean` and `panel` at `thorough`; at `standard` it measures the branch diff's changed lines and files, lockfiles and generated files left out, and prints `single` or `panel` with its reason. `playbooks/reviewing-code.md` § 3 owns when it runs. |
| [`scripts/on-device-launch.mjs`](../scripts/on-device-launch.mjs) | The on-device stage's launch record: `start` runs a checklist's `Launch:` command in the background, `ready` waits for its `Ready:` check, and `stop` ends every process recorded under `.devcycle/`, an earlier session's leftovers included. |
| [`scripts/on-device-routing.mjs`](../scripts/on-device-routing.mjs) | The on-device stage's routing record: joins the results report with the on-device ledger decisions to say which `FAILED` items are `undecided`, `toFix`, or `carried` (waived or accepted), whether the fix-round cap is spent, and which `FAILED` lines are `malformed` (no `#<n>`). |
| [`bin/devcycle-root`](../bin/devcycle-root) | Prints this plugin's installed root. Claude Code puts `<plugin>/bin` on PATH, so plugin scripts named `"$(devcycle-root)/scripts/<name>.mjs"` resolve from any shell — including a dispatched subagent's, where `${CLAUDE_PLUGIN_ROOT}` is empty. Quote the substitution as shown, or a plugin root containing a space is word-split. |

## Hooks

The hooks the plugin ships: seven settings hooks registered by event in `hooks/hooks.json`, and one
hooks module listed under its `modules`, which Claude Code loads in-process. No command loads them;
each settings hook fires on a matched tool call or — the dispatch-sensor and the process-sensor — when
a subagent or a turn stops, and the module's function hooks run on the turns, tool calls and subagents of a session that joined
an active run.

| Hook | What it does |
| --- | --- |
| [`hooks/block-main-thread-browser.mjs`](../hooks/block-main-thread-browser.mjs) | Registered on `PreToolUse` over `mcp__claude-in-chrome__.*`, it denies any browser tool call whose origin is not the `on-device-driver` subagent — the main thread included — so the coordinator cannot drive the browser at its own context depth ([`decisions/`](decisions/README.md), 2026-08-20). |
| [`hooks/block-destructive-git.mjs`](../hooks/block-destructive-git.mjs) | Registered on `PreToolUse` over `Bash`. For a guarded dispatch origin (`task-reviewer`, `red-team-reviewer`, `implementer`, `spec-reviewer`) it denies destructive or ambiguous git subcommands (`checkout`/`reset`/`restore`/`clean`/`stash`/…), allowing only inspection commands and `git add -N`; on the main thread it denies `git stash` while a `.devcycle/state.md` at or above the call's `cwd` reports a stage other than `done` (`list`/`show` excepted when written plainly), and — while a live `.devcycle/drive.lock` says an execution driver runs — branch-moving or tree-destroying git (`switch`, a `checkout` without paths after `--`, `reset --hard`, a `clean` that is not a dry run) aimed at that checkout, in every session in it, `--git-dir`, `--work-tree`, `GIT_DIR` and `GIT_WORK_TREE` included; under either, a git whose subcommand a substitution, a variable or `xargs` supplies is denied — read past a launcher's own options, with `$(which git)` read as git, and `$GIT` as a command's first word — and under the lock so is a `reset` or `clean` whose options one supplies. A command substitution is judged by the git inside it and by what its output feeds: one that runs or feeds git is denied on ambiguity on a guarded dispatch, and on the main thread in a command that names a word it guards. On a line made only of commands that never run their arguments or input, a heredoc fed to `cat`, `tee` or devcycle's own `task-dispatch.mjs` run alone (an unquoted one when no substitution in it names git) and single-quoted text are data, while quoted text a launcher runs as shell, and text piped into a bare shell or `xargs <shell>` (not a shell behind another launcher), is judged as the commands it holds; `rtk git …` is checked as the `git …` it runs, and a git it cannot parse is denied on ambiguity. The structural backstop for the never-revert-a-sibling ban (#165, #235, #304); also denies a guarded dispatch an `until`/`while` loop that sleeps (`hooks/lib/poll-guard.mjs`). Also denies a live `$(jobs -p)` on a guarded dispatch and on the main thread of a cycle, a trap body included, because it is empty under zsh and the cleanup silently kills nothing (#395); it names the working form. |
| [`hooks/workload-sensor.mjs`](../hooks/workload-sensor.mjs) | Registered on `PostToolUse` over `Bash`, it re-derives the run's `workload` record from `.devcycle/state.md` and git on each HEAD-advancing commit in an active cycle, so workload collection never depends on the finish stage running ([`playbooks/finishing-the-cycle/`](playbooks/finishing-the-cycle/README.md)). |
| [`hooks/dispatch-sensor.mjs`](../hooks/dispatch-sensor.mjs) | Registered on `SubagentStop`, it appends one `agent-depth` run-record row per finished subagent whose session joined the active cycle's run — final context depth, model, tool uses, duration — marking `warn` above 150k and `breach` above 200k (with a `depth-breach` event). Observe-only: never blocks, always exits 0; also marks the stopped agent's dispatch record ended. |
| [`hooks/stop-guard.mjs`](../hooks/stop-guard.mjs) | Registered on `PreToolUse` over every tool. While a `/devcycle:stop` request younger than ten minutes stands, it denies each session the request lists every tool call except `TaskStop`, the `ToolSearch` that loads it and a plain `stop-cycle.mjs` run, so the cycle's work ends at its next tool call; a session that joined later is never bound. After the stop it keeps denying a listed session's subagents until `/devcycle:continue` drops the `stopped:` row. Any error is an allow. |
| [`hooks/process-sensor.mjs`](../hooks/process-sensor.mjs) | Registered on `PostToolUse` over `Agent`, `Bash`, `Monitor` and `TaskStop`, and on `Stop` and `SubagentStop`, it keeps `.devcycle/processes.jsonl`, the registry of background work each session joined to the run started, which is what tells `/devcycle:stop` what to stop and what it can only report. Observe-only: never blocks, always exits 0. |
| [`hooks/leftover-sensor.mjs`](../hooks/leftover-sensor.mjs) | Registered on `PostToolUse` over `Bash`, it runs [`scripts/leftover-processes.mjs`](../scripts/leftover-processes.mjs) at most every 30 seconds for the main thread of a session joined to an active run, and hands any process group it has not yet reported this run to that session as additional context: a group whose leader exited, with a member reparented to PID 1 and no terminal, summing at least 50% CPU and at least 60 seconds old. It reports what it cannot prove ownership of, so it says "on this machine" and kills nothing. Observe-only: never blocks, always exits 0. |
| [`hooks/devcycle-mod.mjs`](../hooks/devcycle-mod.mjs) | The hooks module, listed under `modules` in `hooks/hooks.json` and loaded in-process (Claude Code 2.1.287 or later). In a session that joined the active run it writes one `agent-trace` run-record row per finished subagent turn — peak context depth against the model's window, tool-result characters, the limiter's counts — through `hooks/mod-sink.mjs`; once a subagent — never a fork or a teammate — passes 15% of its window it adds a budget note to its next tool result and to every fifth one after, and under `subagentBudget: enforce` refuses `Read`/`Grep`/`Glob`/`WebFetch`/`WebSearch` at 20%; in an interactive session the status line shows the stage budget. It runs without Node, passes every call through when it fails, and does nothing below 2.1.287, in devcycle's own `claude -p` children, or outside a joined run beyond relaying the terminal notification `scripts/handoff-mark.mjs` asks for and, in an interactive session, drawing the drive band above the prompt from the execution driver's `.devcycle/drive-progress.json` — its `$.state` contract is `types/index.d.ts` ([`decisions/`](decisions/README.md), 2026-10-07). |
| [`hooks/mod-sink.mjs`](../hooks/mod-sink.mjs) | The hooks module's Node side, which the module spawns: `check-joined` answers whether this session joined the active run, and `append` writes one `agent-trace` row carrying the stage at the subagent's stop. Always exits 0. |

## Agents

The read-only or single-task subagents a stage dispatches.

| Agent | What it does |
| --- | --- |
| [`implementer`](../agents/implementer.md) | Implements one task from a brief; never commits. |
| [`task-reviewer`](../agents/task-reviewer.md) | Read-only reviewer for each task during execution. |
| [`red-team-reviewer`](../agents/red-team-reviewer.md) | Adversarial read-only charter, spliced into the panel's per-finding verification pass. |
| [`on-device-driver`](../agents/on-device-driver.md) | Drives claude-in-chrome for the on-device stage; never decides whether an item passes. |
| [`history-inspector`](../agents/history-inspector.md) | Read-only git-history lens for `/devcycle:maintain`. |
| [`spec-reviewer`](../agents/spec-reviewer.md) | Read-only check of a written spec's repo claims against live code, before the brainstorm approval question. |

## References

| Reference set | What it holds |
| --- | --- |
| [`references/`](../references/README.md) | The shared mechanism docs — evidence, delegation, handoff, quality criteria, config, and the rest. The [references index](../references/README.md) is the single inventory of what each file owns. |

## Historical / archive

- [`comparisons/`](comparisons/) — a frozen snapshot comparing five of the shipped playbooks against their upstream `superpowers` skills. It is baselined on an older `superpowers` (6.1.1) than the one now installed (6.3.0), so it is a historical record, not a current account; do not read it as the live behaviour.
