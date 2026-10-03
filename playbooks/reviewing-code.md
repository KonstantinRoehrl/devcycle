# Reviewing Code

The single review engine: *given this scope and these criteria, what is wrong with this code —
and what does it already do right, concretely enough to name and keep doing?* The second half is
additive, per the Strengths rule `references/abstraction-and-strengths.md` owns.
**Which caller invoked it decides more than the scope does.** An **audit run** — `/devcycle:review`
standalone, or `/devcycle:cycle`'s audit stage, at any scope below — runs the criteria interview
(step 1), then hands off to `playbooks/writing-the-findings-document.md`.
**`/devcycle:maintain`** (`playbooks/maintaining-the-repo.md`) is a third class: it brings its own
longitudinal criteria — depth-gated, not discovered — into that same step-1 interview (its own
scoping gate mandates the hard STOP) rather than skipping it, and it owes that findings document
exactly as an audit run does. **The branch-review stage** (`playbooks/reviewing-the-branch.md`)
skips both, inheriting the cycle spec's criteria and taking its findings back inline. Read
`profile` first from the `knobs:` line per `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob
channel (`audit depth` sets how far an audit sweeps) and report per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons audit`. No store, no output.

## Scope

Exactly one scope argument, plus `criteria` — confirmed at step 1 on an audit run and on
`/devcycle:maintain`, the spec's requirements plus the default criteria for the branch-review
stage — and `specPath` when a spec governs it.

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
  The panel engine realizes this as `maxChunks` (§ 3): it enforces the profile's ceiling on diff
  chunks and discloses the deferred set in its `COVERAGE WARNING`, rather than leaving the cutoff
  to the reviewer's judgment.

## 1. Discovery and the criteria interview — audit runs and `/devcycle:maintain` (maintain skips discovery, not the interview)

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
the standalone `/devcycle:review` entry; `references/ledger.md` owns that condition. Slot 1 is
**a criteria set you derived from discovery**, for the user to correct — never a blank menu, and a
good proposal is never permission to act on it. Read
`${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` and draw it and the other slots from that
catalog; no second menu lives here to drift from it. Settle in the same batch the audit scope — at
`branch` scope show the derived base and stabilized file set here too, correctable exactly like the
criteria — any criterion the catalog does not carry, and **the audit plan**: which areas will be
covered, risk-ranked, and why — areas, never findings. Then **hard STOP**, exactly as
`playbooks/scoping-the-request.md` stops: no sweep, no draft findings, no assumed answers until the
user replies.

## 2. Research and lens construction

**On an audit run**, first run the repo-research procedure
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns (`## Research dispatches`), filtered by the
confirmed criteria and scope rather than the request's wording. Source any criterion no local
convention covers in `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md`'s order; that precedence
is binding and is cited per finding. Without web access the sweep still runs against repo conventions
plus that file's seed index, recording the limit in the coverage statement. **`/devcycle:maintain`**
has already oriented itself (its own playbook's step 3) and hands that result down as the digest
below, so it does not run the procedure again; **the branch-review stage** runs none at all, having
arrived with its criteria rather than sourcing them.

**On an audit run and on `/devcycle:maintain`**, match the stabilized scope to its lessons before
the lenses are grouped: the coordinator runs
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --match --stage audit --files "<the stabilized audit scope files>"`
and folds the printed lesson lines (only the lines, not the stage section they came from) into
the lens charters as known risks the reviewers must weigh the scope against. The `--lesson
<id>` tail on each line lets a reviewer pull that record when a lens needs it. Nothing is
folded in when the match returns empty. **The branch-review stage** does not run this call at all:
it matches its own stage's lessons before invoking this engine, per
`playbooks/reviewing-the-branch.md`.

**Optional caller-supplied orientation (used by `/devcycle:maintain`, ignored otherwise).** A caller
may hand this stage a pre-computed **orientation digest** and **hotspot file list** — the compact
repo picture `references/delegation.md`'s Research-dispatch procedure produces.
When supplied, the `--files` argument above is that hotspot list rather than the whole stabilized
scope (at `repo` scope the stabilized set can be the entire tree, and lessons cluster on central
files, so the hotspot list is cheaper and more relevant), and the digest is offered to the lens
charters as shared context so each lens need not re-read the tree. When absent — every
`/devcycle:review` and branch-review run — this stage derives the file set exactly as it does today;
the input is additive and changes nothing for callers that omit it.

Then, for every caller, read that same file — owner of the catalog, the sourcing precedence and the
seed index — and group the criteria into **2–5 lens charters**, **by kind, not by count**: related
criteria share a lens so each reviewer holds a charter it can actually hold ("correctness and data
contracts across boundaries", "the repo's own documented conventions"), and a lens is never one
criterion wide. Below two it stops being a panel; above five each charter thins. Each charter names
what it measures against, so findings can carry it. With a `specPath`, one lens is spec compliance.
Read `${CLAUDE_PLUGIN_ROOT}/references/abstraction-and-strengths.md`: its Strengths rule binds every
lens, and its Abstraction section applies when that criterion is confirmed.

## 3. Engine selection

Keyed to the `knobs:` line's `reviewDepth`. **`panel`** runs
the constructed lenses through the workflow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '{"scope":{"ref":"<base>..<branch>"},"specPath":"<path>","lenses":[{"key":"<key>","charter":"<charter>"}],"crossModel":<crossModelReview>,"maxChunks":<profile ceiling>}'
```

One JSON argv: `scope` carries exactly one of `ref` or `paths`, `specPath` is omitted when no spec
governs the scope, `lenses` mixes built-in keys and `{key, charter}` objects, and `crossModel`
mirrors `crossModelReview`. The JSON report is stdout ONLY — progress goes to stderr. When
`branchReviewModel` resolves to an explicit id per `${CLAUDE_PLUGIN_ROOT}/references/model-routing.md`,
export it (`DEVCYCLE_PANEL_MODEL=<id> node ...`) or
the CLI's default silently replaces the user's binding choice; on the session tier omit it.

`maxChunks` is the profile's Frontier ceiling on how many diff chunks the panel reviews; past it
the panel reviews the highest-churn chunks and names the deferred files in its `COVERAGE WARNING`.
The playbook reads `profile` from the `knobs:` line and passes the matching ceiling:

| `profile` | `maxChunks` |
| --- | --- |
| `lean` | 2 |
| `standard` | 4 |
| `thorough` | 8 |

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
untracked file, which only makes it diff-visible and reverts nothing. For a dispatched reviewer subagent, `hooks/block-destructive-git.mjs` structurally backstops this
prose: a `PreToolUse` hook denies every destructive/ambiguous git subcommand from a guarded origin
(allowing only inspection commands and that one `git add -N`), so the ban no longer rests on prose the
`tools:` grant contradicts.

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
and confidence follows what that reader found. For a finding about whether a script or tool
*computed something correctly* — a report, a metric, a benchmark — refutation by re-reading the
source is not enough on its own: run it and independently recompute the figure by a different
path where feasible, per `findings.md`'s evidence discipline. A headline number that quietly skips
a normalization step every other code path performs can read as correct from the source alone and
still be wrong in practice. Unverified findings are marked, never dropped; findings are then
deduplicated across lenses and ranked: read `${CLAUDE_PLUGIN_ROOT}/references/findings.md` for
the severity vocabulary, core fields, evidence discipline and machine ordering they follow. Depth
never weakens step 1 or this pass, which is real machinery at every profile rather than a paragraph
performed by hand. A red test explained
as pre-existing/flaky/unrelated/environmental without a logged clean-HEAD-vs-change reproduction
is rejected, per `references/evidence.md` § Reviewer verdicts.

**Cross-reference open work before finalizing.** Check `docs/known-issues.md` and the repo's
live issue tracker for anything already tracking a candidate finding — they are not guaranteed to
agree with each other, so check both rather than trusting either as complete. A match is not
reason to drop the finding; it is reason to say so (cite the existing entry instead of re-deriving
it from scratch) and to check whether the two are independent or one is a **precondition** for the
other — a finding whose evidence rests on data another open defect is already known to corrupt
(a log a known bug under- or over-populates, a timestamp a known bug estimates rather than
measures) inherits that unreliability silently unless the document says so. Note any such
dependency in the finding itself; the findings document carries it into its ordering.

**The branch-review stage returns exactly this and stops**, never reading the findings document
playbook: findings in `references/findings.md`'s shape plus an **engine line** naming what ran —
`single`, `single + user-run code-review`, `panel`, `panel [+ cross-model lens]` when the
cross-model lens ran, or `panel→single (panel unavailable: <reason>)` — recorded verbatim, no
variants. The rounds-and-cap loop, spec-requirement enumeration, the ledger cross-check and every
state-file and handoff duty belong to that stage. An audit run or a `/devcycle:maintain` pass then
reads `${CLAUDE_PLUGIN_ROOT}/playbooks/writing-the-findings-document.md`, at every scope.
