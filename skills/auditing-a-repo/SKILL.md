---
name: auditing-a-repo
description: Use when a repository needs a criteria-driven audit — the criteria are interviewed for, never assumed — producing a findings list ranked by priority and impact, with file-referenced evidence and a concrete fix per finding.
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

1. **Interview for the criteria.** Ask via AskUserQuestion, 1–4 questions in one
   batch, each with concrete options plus Other.
   - **Slot 1 is a criteria set you derived from this repo**, presented for the user
     to correct — never a blank menu. Derive it from a shallow orientation pass of
     step 2's procedure (root docs, layout, languages, test and CI setup, obvious
     pain): a user handed a proposal corrects it in one turn, a user handed an empty
     list has to invent one.
   - The menu the proposal and the remaining slots draw from: correctness and bugs ·
     token and context cost · dead or duplicated code · docs-vs-reality drift · test
     coverage · architecture and separation of concerns · security · performance ·
     dependency hygiene · conformance to the project's own stated conventions.
   - Settle here too: **audit scope** — the whole repo or a named subsystem — and any
     criterion the user adds that the menu does not carry.
   - **Hard STOP after asking**, exactly as `devcycle:scoping-interview` stops: no
     research sweep, no draft findings, no assumed answers until the user has replied.
     Criteria are never assumed, never inferred from the request's wording, and never
     defaulted because the answer looks obvious.

2. **Research.** Run the canonical repo-research procedure `devcycle:scoping-interview`
   defines (graphify graph first when one exists, otherwise plain reading and search
   plus the two-phase `*.md` index-then-fetch) — read-only, never triggering a graph
   build or `--update`. Relevance here is judged against the confirmed criteria and the
   confirmed scope, not against the original request.

3. **Findings.** Each finding carries, in this order:
   - a symptom-first statement in plain language — what is wrong, before the mechanism;
   - **evidence as `file:line` references** into the repo;
   - a concrete fix — what to change, specifically enough to become a cycle's request;
   - a severity and an impact estimate.

   **A finding without file-referenced evidence is not reported.** "This could be a
   problem", "this pattern is often risky", "there may be more of these" are not
   findings — the same discipline `agents/red-team-reviewer.md` applies to review
   claims. If you suspected something and could not point at it in a file, it does not
   appear in the document at all.

   Rank by priority × impact and group the ranked list into tiers, so the user reads a
   shortlist rather than a flat dump.

4. **Coverage statement.** The document states what was read and what was not — areas
   skipped, criteria the evidence was thin for, limits the scope imposed. Silent
   truncation must never read as completeness; a partial audit that says so is useful,
   one that does not is misleading.

5. **Output.** Write `docs/audits/YYYY-MM-DD-<topic>.md` (today's date, a short topic
   slug), then commit it. If `git check-ignore` covers the path, write the file and
   skip the commit: the repo's own ignore rules decide what lands in history, not this
   skill.

   The document is a commit, so branch discipline applies either way — but whether the
   branch is recorded depends on whether this run owns a state file:
   - **In-cycle** (the audit is running as a cycle stage, a `.devcycle/state.md` exists
     and this cycle owns it): read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and
     follow it in full, including writing the topic branch to the state file's
     `branch:` line.
   - **Standalone** (`/devcycle:audit`, no cycle): create the topic branch per
     `${CLAUDE_PLUGIN_ROOT}/references/branch.md` when the checkout is on a default or
     integration branch, and do NOT create, read-modify, or write `.devcycle/state.md`
     — a standalone audit is not a cycle and owns no state file, so an existing one
     belongs to somebody else's in-flight cycle and its `branch:` line is not yours to
     rewrite.

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

## Red flags — if you catch yourself thinking any of these, return to the walk

| Rationalization | Reality |
| --- | --- |
| "It's obvious what this repo needs audited" | That is your taste, not the user's priorities. Step 1 is the skill; derive a proposal and let them correct it. |
| "I'll research first and interview with real findings" | Research before criteria audits the whole repo against everything. The stop after step 1 is hard. |
| "The user said 'audit it', that's permission to pick criteria" | It is permission to run the audit, not to choose what it measures. Ask. |
| "I'm sure this is a problem, I just can't point at the line" | Then it is not a finding. No `file:line`, no entry. |
| "I only got through half of it, close enough" | Say so in the coverage statement. Silent truncation reads as completeness. |
| "Finding 1 is clearly the most urgent, I'll just start fixing it" | Step 6 stops. The user picks, and each pick is its own cycle. |
