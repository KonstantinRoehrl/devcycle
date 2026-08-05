# Confirmed promotions from the 2026-08-04 dreaming benchmark — cycle input

> **2026-08-05 — superseded by landing.** All 26 promotions below have since landed:
> `docs/devcycle/promotions/` now holds a record for each, and the memory deletion noted at
> the end of this document (promotion 24, `reserve-feat-for-substantial-changes`) has been
> carried out — that memory entry is gone. This document is left otherwise unedited as the
> historical record of the benchmark run; see `docs/DECISIONS.md` for what superseded what.

26 promotions confirmed by explicit human confirmation during the benchmark's Phase 4
decision run, then **deliberately not landed**: they touch the same surfaces the follow-up
cycle edits, so they were carried here as that cycle's input instead of applied inline.

Nothing in this list has been written to its target file. No promotion record exists in
`docs/devcycle/promotions/`. No memory entry has been deleted.

Provenance for each: `docs/benchmarks/2026-08-04-dreaming-first-run.md` and the dream artifact
`.devcycle/dreaming/2026-08-04-dream.md` (gitignored, local).

## Resolved contradiction — decided by the user, do not re-litigate by recency

**Scenario `## Baseline (red)` / `## Result (green)` sections are REQUIRED**, including for
`Type: discipline` scenarios. When a scenario is authored without a run having been executed,
the sections carry honest "Not yet run" placeholders — they are not omitted.

Two sessions' reviewers had ruled opposite ways on materially the same fact pattern
(`f52079c2` blocking vs `f2a2877b` "reasonable, disclosed judgment call"). The losing side —
"omission is acceptable when the brief did not include executing the run" — is **rejected**
and must not be reintroduced.

Target: `references/evidence.md`.

## Confirmed promotions

| # | type | target | edit |
| --- | --- | --- | --- |
| 1 | doc-edit | `references/evidence.md` | Baseline/Result required incl. `Type: discipline`; "Not yet run" placeholders (the resolution above) |
| 2 | doc-edit | `CONTRIBUTING.md` | Prohibit populating an isolated `CLAUDE_CONFIG_DIR` by extracting the production OAuth credential from the keychain; use a test-only credential or skip the run; delete scratch credential files. **Security.** |
| 3 | contradiction-resolution | `agents/task-reviewer.md` | Carve-out: `git add -N` for diff production is not "staging" under the read-only mandate; a dispatch may instruct it for that purpose only, never as a route to committing |
| 4 | contradiction-resolution | `agents/task-reviewer.md` | Add the one-hop pointer `agents/implementer.md` already has: the markdown verdict block goes to the findings file; `references/delegation.md`'s short envelope is what the dispatch returns |
| 5 | doc-edit | `DESIGN.md` | Delete §15.2's embedded profile matrix, replace with a pointer to `references/config.md`, applying §15.1's own one-owner invariant to DESIGN.md itself |
| 6 | doc-edit | `references/handoff.md` | Add the missing `on-device → finish` boundary row (Clear + `/devcycle:continue`) |
| 7 | skill-edit | `agents/task-reviewer.md` | Reviewer hygiene bullet: the tree is shared; never attribute an unscoped `git status`/`git diff` to this task; scope to the brief's file list; unscoped scope-creep findings are false positives |
| 8 | doc-edit | `references/evidence.md` | Brace-group `&&`-chained evidence commands before redirecting — `{ c1 && c2; } > file 2>&1` — never the bare form, which silently drops earlier output |
| 9 | doc-edit | `references/evidence.md` | "Captured the same way" means the before-capture command is the identical string used for after-capture, never a truncated subset, even when both exit 0 |
| 10 | doc-edit | `references/output.md` | Any command transcript in a report or finding must be real captured output, never narration typeset to look like output; paste real output with its exit status or drop the transcript |
| 11 | doc-edit | `skills/reviewing-the-branch/SKILL.md` | Fix dispatches must carry a minted task-id (`branch-fix-<round>-<n>`) and an `**Evidence:**` class line — they are implementer dispatches bound by the same evidence contract |
| 12 | skill-edit | `skills/reviewing-the-branch/SKILL.md` | Define "the fix diff" in rule 3: `<this round's pre-fix HEAD>..<the fix commit>`, never an earlier execution-stage commit |
| 13 | skill-edit | `skills/planning-waves/SKILL.md` | **Merged item.** One Self-review check verifying every plan-authored factual claim — file/section targets, locked "must show no changes" regions, verification greps, stated counts — against the repo and against the task's own supplied text; plus extend the Feasibility gate beyond APIs/modules/tools to document sections and conventions |
| 14 | skill-edit | `skills/planning-waves/SKILL.md` | No referencing an enumerated fact by count alone ("all four guardrails"); any enumeration more than one task must reproduce belongs in Global Constraints, copied verbatim into every brief |
| 15 | skill-edit | `skills/planning-waves/SKILL.md` | When two or more tasks restate the same logic across mirrored files, diff the pinned text blocks for parity before finalizing the plan |
| 16 | doc-edit | `CONTRIBUTING.md` | Copying a scenario carries over its Setup tool-permission clause; re-derive it — a sandbox forbidding the reads its own Pass criteria need grades a broken sandbox |
| 17 | doc-edit | `CONTRIBUTING.md` | When spliced text points onward to another plugin file and a Pass criterion depends on it, the sandbox must place that file; grep sibling scenarios for the same dangling reference before calling the fix done |
| 18 | doc-edit | `CONTRIBUTING.md` | When a scenario run can mutate the sandbox, snapshot clean state after Setup and before red, restore before green |
| 19 | doc-edit | `CONTRIBUTING.md` | Verify citations against the working tree or `git show <ref>:path`, never `${CLAUDE_PLUGIN_ROOT}` — the install cache is version-keyed and lags the branch, making accurate citations look fabricated |
| 20 | doc-edit | `CONTRIBUTING.md` | Before writing corpus enumeration, project-path escaping, or missing/unreadable-directory handling in a new `scripts/*.mjs`, reuse `doctor.mjs`'s exported helpers (`findTranscriptFiles`, `owningSession`, `readRecords`, `inWindow`) |
| 21 | skill-edit | `skills/reviewing-the-branch/SKILL.md` | Fix-dispatch briefs must ask the implementer to check the fix against the repo conventions it touches, not just satisfy the finding's literal wording |
| 22 | doc-edit | `agents/implementer.md` | For convention-class fixes to prose: make the smallest edit that resolves the finding; prefer replacing/removing wrong text over adding rationale; check for existing coverage first |
| 23 | doc-edit | `CONTRIBUTING.md` | `plugin.json`'s userConfig descriptions are a third non-pointer copy; update by hand alongside README's config table and the owning skill — `validate.mjs` checks the key exists, never the description text |
| 24 | doc-edit | `CONTRIBUTING.md` | Reserve `feat:` for substantial user-facing improvements; routine work (engine swaps, doc edits, refactors, small fixes) uses `refactor:`/`fix:`/`docs:`/`chore:` so the automated bump reflects real impact |
| 25 | skill-edit *(reframed)* | `skills/reviewing-the-branch/SKILL.md` | **Enforcement, not restatement.** The fix brief must not instruct the implementer to commit; the coordinator commits on receipt. `agents/implementer.md:57-62` already forbids it and the rule is not holding — remove the conflicting instruction at its source |
| 26 | skill-edit *(reframed)* | `skills/executing-waves/SKILL.md` | **Trigger placement, not restatement.** After the per-task commit step: when this commit closes the wave, stop and go to "Wave boundaries and handoff" before forming the next wave. The rule is already unconditional in two places; it sits in a section the coordinator falls past |

## Skipped, with reasons

- **`scenario-file-authored-without-headless-run`** — the losing side of the contradiction above.
- **`changelog-unreleased-hand-write-regression`** — already recorded in `docs/DECISIONS.md`
  (2026-07-26; the candidate misdated it 2026-07-23). Restating it in `CONTRIBUTING.md` would
  create the second owner that promotions 5 and 23 exist to eliminate.

## Carries a memory deletion

Promotion **24** corresponds to the auto-memory entry `reserve-feat-for-substantial-changes`.
It was confirmed with "land + delete memory". **When 24 actually lands**, delete
`~/.claude/projects/-Users-konstantin-Programming-devcycle/memory/reserve-feat-for-substantial-changes.md`
and its `MEMORY.md` pointer line — not before. The entry is currently intact.

The other 25 have no memory entry to delete: they were mined from transcripts, not from the
memory store. That mismatch between dreaming's output and `distilling-learnings`' delete-on-
promotion contract is unresolved in the spec and is itself a finding for the cycle.
