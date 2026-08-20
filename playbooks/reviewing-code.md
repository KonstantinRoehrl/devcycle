# Reviewing Code

The single review engine: *given this scope and these criteria, what is wrong with this code?*
**Which caller invoked it decides more than the scope does.** An **audit run** — `/devcycle:review`
standalone, or `/devcycle:cycle`'s audit stage, at any scope below — runs the criteria interview
(step 1) and ends in the ranked findings document (step 5). **The branch-review stage**
(`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md`) skips both, inheriting the cycle spec's
criteria and taking its findings back inline. Resolve `profile` first per
`${CLAUDE_PLUGIN_ROOT}/references/config.md` (`audit depth` sets how far an audit sweeps) and report
per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons audit`. No store, no output.

## Scope

Exactly one scope argument, plus `criteria` — confirmed at step 1 on an audit run, the spec's
requirements plus the default criteria for the branch-review stage — and `specPath` when a spec
governs it.

| form | argument | what is reviewed |
| --- | --- | --- |
| `branch` | `{ref: "<base>..<branch>"}` | that branch's diff, expanded below |
| `repo` | a repo path — whole repo or named subsystem | a whole-repo audit |
| `files` | `{paths: [...]}` | exactly that file set |

Scope and caller are independent: `/devcycle:review branch:<name>` is an audit run at `branch` scope
and gets the interview and the document like any other audit. A branch is never inferred — the
`branch` form reviews the branch it was handed, deriving its base, its merge-base-guarded diff and
where contents are read from per "Deriving a branch's file set" in
`${CLAUDE_PLUGIN_ROOT}/references/branch.md`, plus three rules on top:

- **Evidence resolves against the reviewed branch**: a `file:line` read from the working tree points
  at different code, so the finding cites a branch it does not describe.
- **Expand to the feature dependency graph**: trace outward from the changed files (callers, callees,
  shared types and DTOs, tests, config and schema of the same feature) until an iteration adds
  nothing, and review that stabilized set — correctness routinely depends on untouched code.
- **Frontier**: if that set exceeds what the profile can genuinely read, review the highest-risk
  subset and name **every** file left at the frontier, with its reason, in the coverage statement.

## 1. Discovery and the criteria interview — audit runs only

**What separates an audit from a code review is where the criteria come from: the user** — criteria
you picked yourself measure the code against your taste. Discovery is shallow, enough to propose
criteria rather than to run step 2's sweep:

- **Detect every stack present in the scope** from what files, manifests and toolchain configs show;
  a repo may hold several, and each detected stack gets its own criteria.
- **Inventory the repo's own conventions before reaching for generic advice**: `CONTRIBUTING.md`,
  `ARCHITECTURE.md`, `CLAUDE.md` / `AGENTS.md`, ADRs, style guides, linter/formatter/CI configs, and
  any documented desired-pattern or anti-pattern.

Interview via AskUserQuestion, 1–4 questions in one batch, concrete options plus Other — an Other
answer appends `user-correction-at-gate` when this stage runs inside a cycle run, and nothing on
the standalone `/devcycle:review` entry; `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns that condition. Slot 1 is
**a criteria set you derived from discovery**, for the user to correct — never a blank menu, and a
good proposal is never permission to act on it. It and the other slots draw from
`${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md`, the single owner of what a review measures
against; no second menu lives here to drift from it. Settle in the same batch the audit scope — at
`branch` scope show the derived base and stabilized file set here too, correctable exactly like the
criteria — any criterion the catalog does not carry, and **the audit plan**: which areas will be
covered, risk-ranked, and why — areas, never findings. Then **hard STOP**, exactly as
`${CLAUDE_PLUGIN_ROOT}/playbooks/scoping-the-request.md` stops: no sweep, no draft findings, no
assumed answers until the user replies.

## 2. Research and lens construction

On an audit run, first run the repo-research procedure
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns (`## Research dispatches`), filtered by the
confirmed criteria and scope rather than the request's wording. Source any criterion no local
convention covers in `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md`'s order; that precedence
is binding and is cited per finding. Without web access the sweep still runs against repo conventions
plus that file's seed index, recording the limit in the coverage statement.

On an audit run, match the stabilized scope to its lessons before the lenses are grouped: the coordinator runs
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --match --stage audit --files "<the stabilized audit scope files>"`
and folds the printed lesson lines (only the lines, not the stage section they came from) into
the lens charters as known risks the reviewers must weigh the scope against. The `--lesson
<id>` tail on each line lets a reviewer pull that record when a lens needs it. Nothing is
folded in when the match returns empty.

Then, for every caller, read that same file — owner of the catalog, the sourcing precedence and the
seed index — and group the criteria into **2–5 lens charters**, **by kind, not by count**: related
criteria share a lens so each reviewer holds a charter it can actually hold ("correctness and data
contracts across boundaries", "the repo's own documented conventions"), and a lens is never one
criterion wide. Below two it stops being a panel; above five each charter thins. Each charter names
what it measures against, so findings can carry it. With a `specPath`, one lens is spec compliance.

## 3. Engine selection

Keyed to `reviewDepth`, resolved per `${CLAUDE_PLUGIN_ROOT}/references/config.md`. **`panel`** runs
the constructed lenses through the workflow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '{"scope":{"ref":"<base>..<branch>"},"specPath":"<path>","lenses":[{"key":"<key>","charter":"<charter>"}],"crossModel":<crossModelReview>}'
```

One JSON argv: `scope` carries exactly one of `ref` or `paths`, `specPath` is omitted when no spec
governs the scope, `lenses` mixes built-in keys and `{key, charter}` objects, and `crossModel`
mirrors `crossModelReview`. The JSON report is stdout ONLY — progress goes to stderr. When
`branchReviewModel` resolves to an explicit id, export it (`DEVCYCLE_PANEL_MODEL=<id> node ...`) or
the CLI's default silently replaces the user's binding choice; on the session tier omit it.

The panel splits an oversize diff at file — and, for a lone file past the cap, `@@` hunk —
boundaries into chunks each within the cap and runs every lens over every chunk, so the whole diff
is reviewed rather than sampled. The `COVERAGE WARNING` its summary can open with fires whenever any
input reached the reviewers truncated — an oversize lone hunk, an oversize spec, or an oversize
file list.

**`single`** — the same lenses as inline read-only reviewers, same refutation pass, same finding
shape; a complete review in its own right, not a degraded panel.

**Reviewers never write the working tree — the owner of that rule for every reviewer, inline or
dispatched; the reviewer agents and the branch-review stage name it and do not restate it.** A
reviewer's `Bash` is read-only, so it never runs a command that writes the tree: `prettier
--write`, `eslint --fix`, `dotnet format` (without `--verify-no-changes`), `black`, `ruff --fix`,
`gofmt -w`, or any formatter/codemod in write mode. Formatters and linters run in check mode only
(`--check`, `--verify-no-changes`, `--list-different`); reformatting the code under review destroys
the review's independence. The one permitted write is a `task-reviewer` `git add -N` on an
untracked file, which only makes it diff-visible and reverts nothing.

**Dirty-tree backstop.** Snapshot `git status --porcelain` before the reviewer runs — the single
inline reviewer here, a dispatched reviewer subagent in the branch-review stage — and again after.
A reviewer that left the tree dirtier than it found it, beyond that permitted `git add -N`, mutated
the code it was assessing, so the review is invalid: file it as a blocking process finding in
`${CLAUDE_PLUGIN_ROOT}/references/findings.md`'s shape, discard that verdict, and re-run from the
clean tree.

**`panel→single` degradation is a first-class path, not an apology.** A missing or non-zero
`review-panel.js` means the panel is unavailable: **exit 1 means the panel failed, never that findings
exist, and is never a review verdict.** Fall back to `single` and disclose it in the engine line — a
fallback presented as a panel run makes the review unauditable.

## 4. Fresh context, verify → dedup → rank, and what this returns

**Fresh context is bias control and non-negotiable.** A reviewer that watched the code being written
reviews the author's intention instead of the code, so reviewers receive ONLY the scope, the criteria
and the spec path — never the authoring conversation, task reports, or implementer reasoning — and a
caller carrying authoring context dispatches fresh reviewers rather than reviewing directly. This
rule and its rationale live here; callers name it and do not restate it.

Every finding is adversarially verified before it is reported: a second reader tries to REFUTE it,
and confidence follows what that reader found. Unverified findings are marked, never dropped;
findings are then deduplicated across lenses and ranked. The severity vocabulary, core fields,
evidence discipline and machine ordering are owned by
`${CLAUDE_PLUGIN_ROOT}/references/findings.md`. Depth never weakens step 1 or this pass, which is
real machinery at every profile rather than a paragraph performed by hand.

**The branch-review stage returns exactly this and stops**, taking no step 5: findings in
`references/findings.md`'s shape plus an **engine line** naming what ran — `single`, `single +
user-run code-review`, `panel`, `panel [+ cross-model lens]` when the cross-model lens ran, or
`panel→single (panel unavailable: <reason>)` — recorded verbatim, no variants. The rounds-and-cap
loop, spec-requirement enumeration, the ledger cross-check and every state-file and handoff duty
belong to that stage. An audit run continues below, at every scope.

## 5. The findings document — audit runs only

Every finding also carries the **document tier** `references/findings.md` lists — detailed enough to
start work from that one finding alone: what, where, why, how. The document adds a **coverage
statement** of what was read and what was not (areas skipped, criteria the evidence was thin for,
limits the scope imposed; silent truncation must never read as completeness) and a **provenance
header** whose every line is **omitted rather than guessed** when it cannot be determined: the audited
**branch**, the **sha of the audited content** (that branch's tip at `branch` scope, the sweep's
checkout HEAD otherwise — never this document's own topic branch, which need not contain the audited
code), and a **PR link** when one exists. Locations inside findings stay plain `file:line`.

Write `docs/audits/YYYY-MM-DD-<topic>.md` and commit it scoped per
`${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit":
`git add docs/audits/… && git commit -- docs/audits/…`. The `git add` is not optional — a pathspec
naming a path git does not know yet aborts the commit. If `git check-ignore` covers the path, write
the file and skip the commit: the repo's own ignore rules decide what lands in history.

Branch discipline follows `${CLAUDE_PLUGIN_ROOT}/references/branch.md`. **In-cycle** (a
`.devcycle/state.md` exists and this cycle owns it): follow it in full including the `branch:`-line
write, keep `stage: audit` while that is the stage to resume at, record the document on the `audit:`
line, and emit the handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` with
`Stage completed: audit`. **Standalone** (`/devcycle:review`): that baseline forces a topic branch only
off a default or integration branch, so a run during another cycle would land this document in that
cycle's history and review. It therefore always gets its own topic branch, cut from current HEAD and
named in the report, and must NOT create, read-modify, or write `.devcycle/state.md`.

**Then stop.** Present the ranked list; the user picks, and each pick starts its own
`/devcycle:cycle` naming that finding — never auto-chain. This playbook is **read-only**: it fixes
nothing it notices in passing, even a trivial one, and that document is the only file it writes.
