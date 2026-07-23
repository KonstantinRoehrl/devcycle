# Graphify Orientation — Approved Design

**Date:** 2026-07-23 **Status:** Approved, pre-implementation

## 1. Problem

`scoping-interview`'s "Research BEFORE questions" step and `planning-waves`' "Reuse before
rebuild" step both research the target repo from scratch every run — file-by-file reading and
ad hoc search. When the target repo already has a `graphify` knowledge graph — a separate,
external tool/skill, not part of this plugin — that research is strictly slower than it needs to
be: the graph already holds the structural picture a graph query can answer directly.

This is a **best-effort, fully optional** addition. graphify is not a devcycle dependency: most
target repos will never have a graph, and the two affected skills must behave exactly as they do
today whenever one is absent.

## 2. The check (identical logic in both skills)

Applied to the **target repo** devcycle is operating on (never to the devcycle repo itself):

1. Is a `graphify` skill listed among this session's available skills? If not, stop — behave
   exactly as today, no repo I/O for this check, no mention to the user.
2. If yes: does the target repo already have `graphify-out/` and/or a root `GRAPH_REPORT.md`? If
   yes, read the report and run graphify queries for the specific research need instead of ad hoc
   file/grep reading.
3. If no graph exists yet, or the existing graph is stale/thin for the area in question, fall
   back to plain search — exactly as today.

**Hard constraint:** orientation only ever *reads* an existing graph. Neither skill may trigger a
graphify build or `--update` as a side effect of scoping or planning — that would turn an
information-gathering step into an unbounded, expensive side task the user did not ask for.

Fallback is always silent: no note to the user, no error, no "graphify unavailable" message —
the two research steps simply proceed as they do today.

## 3. Where the text lives

Inline, per skill — matching devcycle's existing convention that each `SKILL.md` is
self-contained with nothing shared/cross-referenced. No new shared snippet file, no new skill.

- `skills/scoping-interview/SKILL.md` — extends discipline item 1, "Research BEFORE questions."
- `skills/planning-waves/SKILL.md` — extends the "Reuse before rebuild" section.

The two additions carry the same check (§2) worded independently in each skill's own voice —
duplication is accepted here, consistent with how the plugin already treats each skill as
independently readable.

## 4. Testing

Per `CONTRIBUTING.md`'s scenario harness convention, a behavior change to a skill ships with
scenario evidence. Two new files:

- `tests/scenarios/scoping-interview/graphify-orientation.md`
- `tests/scenarios/planning-waves/graphify-orientation.md`

Each covers both branches within one scenario: a sandbox with `graphify-out/`/`GRAPH_REPORT.md`
present and the prompt declaring the `graphify` skill available (green: research visibly draws on
the report/query output, and never attempts to build or update the graph) — and the same sandbox
with the graph or skill absent (behavior identical to the pre-change baseline). Baseline (red) is
the current, unmodified skill text, which has no graph-awareness at all. This requires real
headless `claude -p` runs during execution, per the harness's evidence requirement — flagged here
since it is real model-call cost, not a documentation formality.

## 5. Docs

One clause added to each of the README's Scoping and Planning stage-description bullets, e.g.
"...research draws on an existing graphify graph when one is available." No `CHANGELOG.md` edit:
per `CONTRIBUTING.md`, the changelog and version bump are generated from the squash-merge PR
title, which will be a `feat:` for this change.

## 6. Out of scope

- `reviewing-the-branch`, `executing-waves`, and any other stage — this change touches only
  `scoping-interview` and `planning-waves`.
- Any change to CLAUDE.md or files outside this repo.
- A shared/cross-referenced graphify-orientation snippet.
- Detecting or invoking a bare `graphify` CLI on PATH — detection is skill-presence only (§2.1),
  since a PATH check would miss environments where graphify is only reachable through a specific
  interpreter, and hardcoding any such interpreter path would be machine-specific, not portable
  across the repos and machines this plugin runs on.
