---
name: auditing-a-repo
description: Use when a repository or a branch needs a criteria-driven audit — criteria are derived from the stacks actually present and the repo's own conventions, then interviewed for, never assumed — producing findings ranked by severity, impact, and fix complexity, each with file-referenced evidence and a concrete fix.
---

# Auditing a Repo

Turn a repository into a ranked list of findings the user can act on, one cycle at a
time. Runs standalone via `/devcycle:audit`, or as a cycle stage feeding the findings
the user picks into brainstorm as that cycle's scope.

**What separates an audit from a code review is where the criteria come from: the
user.** A sweep against criteria you chose yourself measures the repo against your
taste, not the user's priorities — it is why step 1 exists and why nothing downstream
of it may start before it answers.

Resolve `profile` before anything else — read
`${CLAUDE_PLUGIN_ROOT}/references/config.md` and follow it; its `audit depth` row sets
how far steps 2–3 go (see Depth below). Report as
`${CLAUDE_PLUGIN_ROOT}/references/output.md` requires.

## The walk

0. **Scope and discovery.** Runs first, in both modes, and is shallow — enough to propose
   criteria, not the deep sweep step 2 performs.

   **Mode.** **Branch-scoped** mode is selected by the branch this skill is handed — from
   `/devcycle:audit` by the `$ARGUMENTS` grammar that command owns, or directly by the cycle
   stage. No branch means **full-codebase** mode (the whole repo or a named subsystem). A
   branch is never inferred: this skill audits the branch it was given and guesses none.
   Everything downstream of this step — the gate, sourcing, the sweep, the finding format,
   the coverage statement — is identical in both modes.

   **Branch-scoped scope derivation.** The base, the merge-base-guarded diff, and where file
   contents are read from are owned by "Deriving a branch's file set" in
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md` — read it there and follow it; it is not
   restated here. What this skill does with the file set that derivation returns:
   - *Evidence resolves against the audited branch*: every `file:line` a finding cites must
     resolve against the audited branch's content — a line read from the checked-out working
     tree points at different code, so the finding describes one branch while citing another.
   - *Expansion to the feature dependency graph*: from the changed files, trace outward —
     callers, callees, shared types and DTOs, tests exercising them, and any config or schema
     belonging to the same feature — repeating until an iteration pulls in no new file. The
     audit runs against this stabilized set, never the raw diff: a change's correctness
     routinely depends on code it did not touch.
   - *Frontier*: if the stabilized set is larger than the resolved profile's depth can
     genuinely read, audit the highest-risk subset and name **every** file left at the
     frontier in the coverage statement, with the reason it was not read. Never truncate
     silently.

   **Discovery (both modes):**
   - **Detect every stack present in the audited scope**, from what the files, manifests, and
     toolchain configs actually show. A repo may hold several — frontend, backend, ML,
     scripts, infrastructure — and each detected stack gets its own criteria. No stack is
     assumed and none is hardcoded here.
   - **Inventory the repo's own conventions before reaching for generic advice**:
     `CONTRIBUTING.md`, `ARCHITECTURE.md`, `CLAUDE.md` / `AGENTS.md`, ADRs, style guides,
     linter/formatter/CI configs, and any documented desired-pattern or anti-pattern.

   Read `${CLAUDE_PLUGIN_ROOT}/references/audit-criteria.md` here and follow it: it owns the
   criteria catalog, the sourcing precedence, and the seed index, and is not restated in this
   skill.

   Discovery **feeds** step 1's proposal. It never replaces the interview and never settles a
   criterion on its own — deriving a good proposal is not permission to act on it.

1. **Interview for the criteria.** Ask via AskUserQuestion, 1–4 questions in one
   batch, each with concrete options plus Other.
   - **Slot 1 is a criteria set you derived from this repo**, presented for the user
     to correct — never a blank menu. Derive it from step 0's discovery (detected
     stacks, the repo's own convention documents, layout, test and CI setup, obvious
     pain): a user handed a proposal corrects it in one turn, a user handed an empty
     list has to invent one.
   - What the proposal and the remaining slots draw from is the catalog in
     `${CLAUDE_PLUGIN_ROOT}/references/audit-criteria.md` — its universal criteria plus the
     stack-specific criteria for each stack step 0 detected. That file is the single owner of
     what an audit measures against, and no second menu lives here to drift from it.
   - Settle here too: **audit scope** — the whole repo or a named subsystem — and any
     criterion the user adds that the catalog does not carry.
   - **The audit plan, in this same batch**: which areas will be covered, risk-ranked, and
     why. It is a visible artifact presented at this stop, not hidden reasoning — a wrong
     plan is corrected here, before a full pass is spent on it. It names areas, never
     findings: drafting a finding before the user replies violates the STOP below.
   - **In branch mode**, show the derived base and the stabilized file set from step 0 here
     too. Both are correctable at this stop, exactly like the criteria.
   - **Hard STOP after asking**, exactly as `devcycle:scoping-interview` stops: no
     research sweep, no draft findings, no assumed answers until the user has replied.
     Criteria are never assumed, never inferred from the request's wording, and never
     defaulted because the answer looks obvious.

2. **Research.** Run the canonical repo-research procedure `devcycle:scoping-interview`
   defines (graphify graph first when one exists, otherwise plain reading and search
   plus the two-phase `*.md` index-then-fetch) — read-only, never triggering a graph
   build or `--update`. Relevance here is judged against the confirmed criteria and the
   confirmed scope, not against the original request.

   **Sourcing, for confirmed criteria no local convention already covers.** Order: the seed
   index in `${CLAUDE_PLUGIN_ROOT}/references/audit-criteria.md` first, then a live lookup
   for any stack the seed does not carry and for any seed link that has moved or 404s. The
   precedence that file defines is binding and is cited per finding. With no web access the
   audit still runs against repo conventions plus the seed, and records that limit in the
   coverage statement.

   **What the sweep covers** for each confirmed criterion is that same file's catalog: the
   universal cross-cutting criteria, the stack-specific criteria for each stack step 0
   detected, and its rules for reuse before rebuild, multi-file feature chains, data contracts
   across every boundary they cross, and accessibility wherever the scope contains a UI.

3. **Findings.** Every finding carries all eleven fields, in this order, with none omitted:

   ```
   Title
   Severity | Complexity | Impact
   Category
   Location(s) (file:line)
   What's wrong
   Why it's wrong (root cause)
   Impact if unaddressed
   How to verify/reproduce
   Suggested fix direction
   Confidence (verified vs. suspected)
   Effort estimate
   ```

   Detailed enough that someone reading only this one finding can start work immediately —
   what, where, why, and how. `What's wrong` stays symptom-first and in plain language: the
   mechanism belongs in `Why it's wrong`.

   **Rubric — fixed, never profile-conditional:**
   - **Severity** — Critical / High / Medium / Low, by the user- or system-facing consequence
     if the finding is left unaddressed.
   - **Impact** — how much of the system or user base the issue touches. This is the blast
     radius of the *issue*, distinct from step 0's scope blast radius; the
     `Impact if unaddressed` field is this rating's prose justification.
   - **Complexity** — effort to fix, as a T-shirt size (S / M / L / XL). `Effort estimate` is
     that size's concrete grounding: the files and rough size of the change, or the time.

   **A finding without file-referenced evidence is not reported.** "This could be a problem",
   "this pattern is often risky", "there may be more of these" are not findings — the same
   discipline `agents/red-team-reviewer.md` applies to review claims. If you suspected
   something and could not point at it in a file, it does not appear in the document at all.

   **Anti-false-positive discipline:**
   - Every finding rests on an actually-traced code path, never a pattern-match guess.
   - `Confidence` is tagged **verified** or **suspected** on every finding — never omitted,
     and never upgraded to verified because the pattern is familiar.
   - Cross-reference the existing tests before flagging. If a test already exercises the
     concern, the finding is reclassified as a test-coverage gap, not reported as a live bug.
   - Every finding names what it is measured against — a repo convention or a named external
     source — per the precedence rule in
     `${CLAUDE_PLUGIN_ROOT}/references/audit-criteria.md`.

   **Order** the list Severity (desc) → Impact (desc) → Complexity (asc), so within a severity
   tier the quickest high-value wins surface first. Keep the tier grouping, so the user reads
   a shortlist rather than a flat dump.

4. **Coverage statement.** The document states what was read and what was not — areas
   skipped, criteria the evidence was thin for, limits the scope imposed. Silent
   truncation must never read as completeness; a partial audit that says so is useful,
   one that does not is misleading.

5. **Output.**

   The document opens with a provenance header — each line **omitted rather than guessed**
   when it cannot be determined: the audited **branch**, the **sha of the audited content**,
   and a **PR link** when one exists (via `gh` when it is available and authenticated). In
   branch mode it also records the derived base and the merge-base sha. Locations inside
   findings stay plain `file:line`; the header is the only place provenance appears.

   That sha is defined per mode, because "HEAD" is not the audited content in both: in
   **branch mode** it is the audited branch's tip (`git rev-parse <branch>`), recorded
   alongside the branch name; in **full-codebase mode** it is the audited checkout's HEAD as
   read during the sweep. It is **never** the sha of the topic branch this document is
   committed on — that branch is cut below, after the audit, and its HEAD need not contain
   the audited code. A provenance sha that does not contain what was audited is worse than no
   sha at all, which is what the omitted-rather-than-guessed rule above exists to prevent.

   Write `docs/audits/YYYY-MM-DD-<topic>.md` (today's date, a short topic
   slug), then commit it under an explicit pathspec naming that one file:
   `git add docs/audits/YYYY-MM-DD-<topic>.md && git commit -- docs/audits/YYYY-MM-DD-<topic>.md`.
   The `git add` is not optional — the document is a new file, and a pathspec naming a
   path git does not know yet aborts the commit outright. Never `git add -A` and never
   a bare `git commit`: the document is the only thing this run authored, and an
   unscoped commit ships whatever else the checkout happened to have staged. If
   `git check-ignore` covers the path, write the file and skip the commit: the repo's
   own ignore rules decide what lands in history, not this skill.

   The document is a commit, so branch discipline applies either way — but whether the
   branch is recorded depends on whether this run owns a state file:
   - **In-cycle** (the audit is running as a cycle stage, a `.devcycle/state.md` exists
     and this cycle owns it): read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and
     follow it in full, including writing the topic branch to the state file's
     `branch:` line.
   - **Standalone** (`/devcycle:audit`, no cycle): follow
     `${CLAUDE_PLUGIN_ROOT}/references/branch.md`, plus one case standalone adds on top
     of it. That baseline forces a topic branch only off a default or integration
     branch; an audit run while another cycle is in flight starts on that cycle's topic
     branch instead, and committing an unrelated document there lands it in that
     cycle's history and its review. So the document always gets its own topic branch,
     cut from the current HEAD whatever branch was checked out. Name that branch and
     the HEAD it was cut from in the report — a standalone run records it nowhere else,
     because it must NOT create, read-modify, or write `.devcycle/state.md`: a
     standalone audit is not a cycle and owns no state file, so an existing one belongs
     to somebody else's in-flight cycle and its `branch:` line is not yours to rewrite.

6. **End.** Present the ranked list and **stop**. The user picks what to act on; each
   pick starts its own `/devcycle:cycle` naming that finding. Never auto-chain into
   brainstorming, planning, or a fix — an audit that starts implementing has taken the
   selection decision away from the user.

## Depth by profile

How far steps 2–3 sweep is the `audit depth` row of
`${CLAUDE_PLUGIN_ROOT}/references/config.md` — read it there; it is not repeated here.

What that row's deepest value means here — the `thorough` verification pass: before a
finding is reported, a second reader tries to refute it against the repo, to show the
evidence does not say what the finding claims or that the code already handles the case.
Refuted findings are dropped, not softened. Depth never touches step 1 or step 3's evidence rule: a `lean` audit
interviews for its criteria and drops evidence-free findings exactly as a `thorough`
one does.

## In-cycle use

When the audit runs as a cycle stage rather than standalone, it also writes
`.devcycle/state.md` — `stage: audit` while the stage is the one to resume at, and the
`audit:` artifact line pointing at the document from step 5. The findings the user
selects at step 6 become that cycle's scope and the walk continues at brainstorm.

Emit this stage's handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` with
`Stage completed: audit` — its table's `audit → brainstorm (findings selected)` row
gives the context action.

## Read-only — the audit never modifies code

The audit produces findings and nothing else. It does not fix what it notices in passing,
not even a one-line trivial issue, and the findings document from step 5 is the only file it
writes. Remediation is a separate, later cycle driven by the findings list — keeping the two
apart is what leaves the selection decision with the user, which is the whole point of step 6.

## Red flags — if you catch yourself thinking any of these, return to the walk

| Rationalization | Reality |
| --- | --- |
| "It's obvious what this repo needs audited" | That is your taste, not the user's priorities. Step 1 is the skill; derive a proposal and let them correct it. |
| "I'll research first and interview with real findings" | Research before criteria audits the whole repo against everything. The stop after step 1 is hard. |
| "The user said 'audit it', that's permission to pick criteria" | It is permission to run the audit, not to choose what it measures. Ask. |
| "I'm sure this is a problem, I just can't point at the line" | Then it is not a finding. No `file:line`, no entry. |
| "I only got through half of it, close enough" | Say so in the coverage statement. Silent truncation reads as completeness. |
| "Finding 1 is clearly the most urgent, I'll just start fixing it" | Step 6 stops. The user picks, and each pick is its own cycle. |
| "It's a one-line fix, I'll just do it while I'm here" | The audit writes findings, never code. Fixing while auditing takes the selection decision away from the user. |
| "The pattern looks wrong; I don't need to trace the call path" | Then it is a guess. Trace the path and mark it verified, tag it suspected, or drop it. |
| "The severity is obvious — the other ten fields are busywork" | All eleven fields, every finding. A finding nobody can start work from was mentioned, not reported. |
