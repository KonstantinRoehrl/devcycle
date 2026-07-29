# Scenario: quality-constraints
- Skill under test: devcycle:planning-waves (quality constraints, before any task is written)
- Type: output-shape

Does planning emit a `## Quality Constraints` section that stays distinct from
`## Global Constraints` — `QC<n>` ids, one line each, every line naming what it is measured
against, filtered to the confirmed scope — and does every task carry a
`**Quality constraints:**` line resolving to those ids?

The two sections come from different places and the precedence rule needs the difference to
stay visible: Global Constraints are copied verbatim from the spec, Quality Constraints are
derived from the criteria catalog. A plan that merges them, or that carries the catalog
forward wholesale, has destroyed the distinction the ids exist to preserve.

## Setup

In a scratch directory, create a sandbox holding the confirmed scope, the repo's own written
conventions, and the plugin surface the skill points at:

```bash
mkdir -p logtail && cd logtail && git init -b main
mkdir -p .devcycle plugin/references
cat > CONTRIBUTING.md <<'EOF'
# Conventions
- Every exported function has a matching test under `test/`, run with `node --test`.
- Errors carry a `code` string; no bare `throw new Error(msg)` crosses a module boundary.
- No file reads the whole log into memory; streaming only.
EOF
cat > .devcycle/scope.md <<'EOF'
# Confirmed scope
A single Node.js CLI package. No web frontend, no HTTP server, no database, no ML,
no mobile target. In scope: `lib/`, `bin/`, `test/`.
EOF
git add -A && git commit -m "chore: sandbox baseline"
cp <absolute path of the devcycle checkout>/references/quality-criteria.md plugin/references/
cp <absolute path of the devcycle checkout>/references/evidence.md plugin/references/
cp <absolute path of the devcycle checkout>/references/config.md plugin/references/
cp <absolute path of the devcycle checkout>/references/output.md plugin/references/
cp <absolute path of the devcycle checkout>/references/handoff.md plugin/references/
```

The scope is deliberately single-stack and deliberately narrow. The catalog the skill reads
is much wider than it: accessibility, data contracts across a frontend/backend boundary, ML
reproducibility, DI lifetimes and memory ownership are all in the catalog and none of them
can apply here. Criterion 3 is what that gap is for.

`CONTRIBUTING.md` deliberately restates none of the spec-wide requirements the prompt
supplies. If it repeated the Node 20 floor or the no-runtime-dependencies rule, those lines
would be a spec requirement and a genuine repo convention at once, and a plan that emitted
either as a QC id would be defensible while tripping criterion 2's last clause. The three
conventions left are ones the spec never states, so the two sections' sources stay cleanly
separable.

**Reference layer.** Five files, not one. The quality-constraints section names only
`references/quality-criteria.md`, but the body being spliced is the whole skill, and it also
names `references/output.md` (its reporting line), `references/config.md` (profile
resolution), `references/evidence.md` — which owns the exact `**Evidence:**` declaration
forms, the line criterion 4 grades the new per-task line as sitting beside — and
`references/handoff.md` (its closing block). A spliced skill pointing at files the sandbox
does not carry grades a broken sandbox rather than the text. Substitute every
`${CLAUDE_PLUGIN_ROOT}` in the spliced skill text with the sandbox's `plugin` directory path.

Because the skill's own plan-mechanics section applies at `lean`/`standard` and defers to the
upstream sub-skill at `thorough`, the run resolves `profile=standard` so the plan is written
by the text under test.

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the `logtail` sandbox). The prompt's
first line pins the agent to the guidance between the markers; without it, machine-local
global instructions may already encode planning habits and contaminate the baseline — the
same isolation header `dependency-declarations.md` uses and for the same reason.

**The two runs splice one skill each, and only one.** The green run carries the full body of
the working-tree `skills/planning-waves/SKILL.md` alone; the baseline run carries the same
skill at the pre-change commit, `git show 934ecdb:skills/planning-waves/SKILL.md`, alone.

Neither run splices `superpowers:writing-plans` alongside it, and that is not a stylistic
choice: the skill's engine selection says in as many words that at `lean`/`standard` you do
**not** load `superpowers:writing-plans`, and this run resolves `profile=standard`. Splicing
both would hand the agent two competing plan headers and two task templates, one of them with
no `## Quality Constraints` section and no `**Quality constraints:**` line, so an ambiguous
result on criteria 1 and 4 would be reachable through no fault of the text under test.

Using the same skill's pre-change body as the control is also what isolates the delta: both
runs carry devcycle's own plan mechanics, waves, dependency declarations and evidence
classes, and differ only in the section this change added. Upstream `writing-plans` alone
remains available as a weaker second control — it shows what planning looked like with no
devcycle skill at all — but it changes two things at once and is not the primary baseline.

```
You are planning an implementation. Follow ONLY the planning guidance between the markers
below, exactly; ignore any other standing instructions from configuration or memory files.

=== PLANNING GUIDANCE ===
[Splice here: exactly one skill body, with ${CLAUDE_PLUGIN_ROOT} replaced by the sandbox's
plugin directory. Green run — the working-tree skills/planning-waves/SKILL.md. Baseline run —
git show 934ecdb:skills/planning-waves/SKILL.md. Never both, and never with upstream
writing-plans alongside.]
=== END GUIDANCE ===

The confirmed scope is in .devcycle/scope.md and this repo's conventions are in
CONTRIBUTING.md. Read those two files, and any file the guidance above tells you to read,
before you plan. Resolved configuration: profile=standard.

Spec — "logtail", a Node.js CLI (fresh package, no existing code under lib/ or bin/):

1. `lib/reader.js`: `streamLines(path)` returns an async iterator over the file's lines.
2. `lib/filter.js`: `matchLines(iter, pattern)` yields only the lines matching `pattern`,
   a string treated as a case-insensitive substring.
3. `bin/logtail.js`: `node bin/logtail.js <path> <pattern>` prints each match to stdout.
   A missing file exits 2 with a message on stderr; an unreadable pattern exits 1.

Spec-wide requirements: Node 20 or newer; no runtime dependencies; every message the CLI
prints to a user is lowercase and fits one line.

Write the complete implementation plan now. Reply with the plan as markdown only. You may
read files; do not create, modify, or delete any.
```

The read permission is load-bearing and is where this scenario departs from
`dependency-declarations.md`, whose prompt forbids all tool use. That sandbox is genuinely
empty and its spec is entirely inline, so an agent needs nothing from disk. Here the sandbox
*is* half the fixture: criterion 2 grades QC lines against `CONTRIBUTING.md`, criterion 3
against `.devcycle/scope.md`, and criteria 5 and 6 against the catalog's `## Forward use`
rules in `plugin/references/quality-criteria.md`. An agent obeying a blanket no-tools clause
reads none of the three and fails those criteria for a reason that has nothing to do with the
text under test. The write ban survives intact — the plan comes back in the reply, and
criterion 1's "both sections exist" is graded on that text.

## Pass criteria

1. **Both sections exist and neither absorbs the other.** The plan carries a
   `## Global Constraints` section and a separate `## Quality Constraints` section. One
   section carrying both kinds of line fails, whatever it is titled; so does a plan that
   drops Global Constraints because the quality section "covers it".
2. **Each section's lines come from where that section's lines come from.** Every
   `## Global Constraints` line traces to the spec: the Node 20 floor, the rule forbidding
   runtime dependencies, and the lowercase one-line message rule, with the exact values copied
   verbatim. Every `## Quality Constraints` line is numbered `QC<n>`, is one line, and names
   what it is measured against — a repo convention (`CONTRIBUTING.md`, by name) or a named
   external source. A QC line with no `(measured against: …)` fails; so does one whose source
   is `best practices`, `standard practice`, or the plan's own judgement. A spec requirement
   restated as a QC id fails criterion 1's distinction from the other side.
3. **No constraint applies to a stack the confirmed scope does not contain.** The scope is a
   dependency-free Node CLI. A QC line about accessibility, DTO-versus-schema data
   contracts, ML reproducibility, DI lifetimes, memory ownership, or a frontend of any kind
   fails — the catalog offers all of them, and filtering to the confirmed scope is what makes
   the section usable rather than ceremonial.
4. **Every task carries the per-task line.** Each task has a `**Quality constraints:**` line
   beside `**Dependencies:**` and `**Evidence:**`, holding either `QC<n>` ids or the literal
   `none`. A task missing the line fails; a task carrying prose instead of ids fails.
5. **The catalog does not appear in the plan.** The Quality Constraints section is a filtered
   selection, not a transcription: a section that reproduces the catalog's universal criteria
   one-for-one as QC1…QC17 fails even if every line is individually well-formed, and no QC
   line pastes a paragraph of the catalog's prose. This is the catalog's own cost rule, and
   the section it governs is the one place a plan is most tempted to break it.
6. **The per-task lines are filtered per task, not stamped on every task.** At least two
   tasks carry different id sets, and a task lists an id only where its own `**Files:**`
   could violate that constraint — the streaming-only constraint belongs to the reader task,
   not to the CLI-argument task. An identical full id list on every task fails: it is the
   catalog anti-pattern moved down one level, and it tells an implementer nothing.
7. **No dangling ids.** Every `QC<n>` a task names is defined in the `## Quality Constraints`
   section, and every id defined there is either claimed by at least one task or the plan
   says why it binds the whole plan. An id referenced but never defined fails.

**Not covered by this scenario:** what `devcycle:executing-waves` does with the ids when it
slices a brief. The plan is graded as a document; resolving `QC3` back to its verbatim line
in an implementer brief is that skill's contract, graded in its own directory.

## Baseline (red)

**Not yet run (2026-07-29).** Same isolated-config blocker the sibling scenarios record: the
harness requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials, and on the machine
this scenario was written the CLI in an isolated config directory answers `Not logged in`; a
run in the machine's real config directory would load the installed devcycle plugin
organically, which `../reviewing-the-branch/engine-selection.md`'s baseline-hygiene note
excludes as contaminated.

Established without a model run — a text check over the repository at the pre-change commit,
not a behavioral result:

- `git show 934ecdb:skills/planning-waves/SKILL.md` contains no quality-constraints machinery
  of any kind: `grep -c 'Quality Constraints'`, `grep -c 'Quality constraints'`, `grep -c QC`
  and `grep -ci criteria` over it all return `0`. The pre-change plan header is
  Goal/Architecture/Tech Stack/Global Constraints only, and the pre-change task template
  carries `**Files:**`, `**Interfaces:**`, `**Dependencies:**` and `**Evidence:**` with no
  fifth line. The pre-change text therefore cannot satisfy criteria 1, 2, 4, 6 or 7 — there
  is no section to emit and no per-task line to carry.

What would prove it: the run above with `git show 934ecdb:skills/planning-waves/SKILL.md`
spliced alone. Expected red on criteria 1, 4, 6 and 7 outright. Criteria 3 and 5 are
vacuously satisfied by a plan with no quality section at all and should be graded
`n/a (no section emitted)` in the red run rather than recorded as passes — a criterion
nothing can violate is not evidence.

## Result (green)

**Not yet run (2026-07-29).** Blocked by the same missing credentialed isolated config. What
would prove it: the run above with the working-tree `skills/planning-waves/SKILL.md` spliced
alone, grading criteria 1–7 against the returned plan text, with every QC line's named source
opened — `CONTRIBUTING.md` in the sandbox for a repo convention, the cited document for an
external one — and checked to actually say what the constraint claims. A QC line citing
`CONTRIBUTING.md` for a rule that file does not contain is a failed criterion 2, not a
detail. `git status --short` afterwards must show the sandbox unchanged: the prompt permits
reads and bans writes, and a plan written to disk is a protocol deviation on the run.
