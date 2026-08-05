# Dreaming skill — first real-conditions benchmark

- Date: 2026-08-04
- Branch: `feat/session-memory-dreaming` @ `2319230`
- Repo under test: this repo (devcycle dogfooding itself)
- Profile resolved: `standard`
- Spec: `docs/superpowers/specs/2026-08-04-session-memory-dreaming-design.md` (§10 amendment authoritative)

## What was and was not exercised

**Production wiring was NOT exercised.** The installed devcycle plugin is v0.10.1, which
ships no `dreaming-across-sessions` skill, no `commands/dream.md`, and no `scripts/dream.mjs`
(verified: `ls ~/.claude/plugins/marketplaces/devcycle/skills/` lists 13 skills, none of them
dreaming; `scripts/` holds 7 files, no `dream.mjs`). So `/devcycle:dream` and
`/devcycle:distill` could not invoke this code at all. The branch was driven directly:
`skills/dreaming-across-sessions/SKILL.md` followed literally, invoking `./scripts/dream.mjs`
from the repo root.

Untested as a consequence — name these as untested, not as working:

- auto-invocation of the dream from `/devcycle:distill`
- `/devcycle:dream` standalone command wiring
- skill triggering from a description match
- `doctor`'s consumption of the artifact's recurrence appendix
- `distilling-learnings`' `--record-promotion` call path
- the `lean` and `thorough` profile branches (only `standard` ran)
- the scratch-code pass (1b-i), which spec §8 makes `thorough`-only

## Phase 0 — preflight

| check | result |
| --- | --- |
| working tree clean | yes — only pre-existing untracked `graphify-out/` |
| branch-review fixes committed | yes — HEAD `2319230`, all 7 round-1 and 3 round-2 blockers landed |
| memory snapshot taken | 4 entries + `MEMORY.md` → scratchpad |
| `.devcycle/dreaming/state.md` | did not exist (first run) |
| baseline memory entries | **4** |

**Validation-gate baseline.** A 1:1 distill run batches 4 memory entries. At 1–4 entries per
`AskUserQuestion` batch that is **1 promotion round** (best case, all four in one batch) and
at worst 4. This is the number the spec §10 gate asks the dream to beat.

## Phase 1 — engine checks on real data

| id | check | verdict | evidence |
| --- | --- | --- | --- |
| E1 | corpus scoping | **PASS** | 69 sessions in manifest = 69 `.jsonl` in the repo's project dir; 442 files total, **0** outside `-Users-konstantin-Programming-devcycle` (subagent transcripts live under per-session `subagents/` subdirs and are correctly included) |
| E2 | redaction | **PASS** | 0 occurrences of `feat/session-memory-dreaming`, `feat/`, `session-memory`. All 650 strings in the manifest are UUIDs, ISO timestamps, or project paths — no prose. The only branch-name "hit" (`dev`) is a substring of `devcycle` in the path |
| E3 | cap honesty | **PASS** | `capped:false` at 69/100. Forced `cap=10` → `capped:true`, 10 sessions kept, and they are exactly the 10 most recent (eviction order correct) |
| E4 | freshness, both directions | **FAIL under real conditions** | see below |
| E5 | checkpoint advances exactly once | **PASS** | `state.md` absent → written once by `--commit-checkpoint`. Byte-identical after a subsequent `--plan` and `--check-recurrence`; neither writes it |
| E6 | recurrence with zero records | **PASS** | 0.52 s real / 206 MB RSS, exit 0, `{"capped":false,"hits":[]}` — against the 6.0 s / 279 MB pre-fix cost |
| E7 | failure handling per §9 | **PARTIAL FAIL** | see below |

### E4 in detail — the defect is real, and it is the one round 3 named

In a **frozen sandbox** (5 real transcripts copied out of the live corpus so nothing appends),
the mechanism is correct in both directions:

```
initial            → artifactFresh: false, 5 sessions          (mine — correct)
+artifact +ckpt    → artifactFresh: true,  0 sessions to mine   (reuse — correct)
+newer session     → artifactFresh: false, 1 session            (stale — correct)
```

Against the **live repo** it can never be true. This session's own transcript is rank 1 of 69
in its own corpus and keeps growing:

```
first  --plan  895e909e … lastTimestamp 2026-08-04T20:07:08.246Z
later  --plan  895e909e … lastTimestamp 2026-08-04T20:12:52.590Z
```

And end-to-end, after the real dream wrote its artifact and advanced the checkpoint:

```
--commit-checkpoint 2026-08-04T20:31:15Z
--plan → artifactFresh: false | sessions in window: 1
         895e909e @ 2026-08-04T20:31:16.568Z      (1.5 s after the checkpoint)
```

This is **B1** exactly: the reuse fast path is unreachable in live use, so a distill run right
after a standalone preview re-mines the whole corpus — the most expensive step in the feature.

**B2 also reproduces.** Freshness compares timestamps lexicographically while
`commitCheckpoint` accepts three ISO forms. Two of the three invert the comparison:

```
since = 2026-08-05T12:00:00+02:00 (=10:00Z), session 11:00Z → artifactFresh TRUE   (wrong)
since = 2026-08-05T12:00Z,                   session 12:00:30Z → artifactFresh TRUE (wrong)
since = 2026-08-05T10:00:00.000Z,            session 11:00Z → artifactFresh false  (right)
```

A caller in a non-UTC zone running `--commit-checkpoint "$(date -Iseconds)"` produces the
first case on the first try, and the widened regex tells that caller the value is fine. Since
a true `artifactFresh` also skips the checkpoint advance, the bad value is never replaced and
every later dream in that repo is a permanent no-op.

Note the two defects currently mask each other: B1 forces `artifactFresh` false, which is why
B2 does not bite today. Fixing B1 alone would expose B2 immediately.

### E7 in detail

| condition | behavior | verdict |
| --- | --- | --- |
| projects root unreadable (file where dir expected), `--plan` | `dream: projects root exists but could not be read: …`, exit 1 | correct |
| projects root **missing entirely**, `--plan` | full manifest JSON, `sessions: 0`, **exit 0** | silent empty success — a wrong `CLAUDE_DREAM_PROJECTS` or a machine without Claude Code reports "nothing to dream about" rather than failing |
| projects root unreadable, `--check-recurrence` | raw Node stack trace from `dream.mjs:315`, exit 1 | round-3 finding F5, still live |

## Phase 2 — the dream run

Followed `SKILL.md` in order: Announce → Profile → Plan → Mine → Cluster → Contradictions →
Screen → Check recurrence → Write and checkpoint.

| | |
| --- | --- |
| manifest | 69 sessions, `since: null` (first run, full history), `capped: false`, 0 archives |
| **mined** | **20 slices** (32,923 of 45,403 records, 72.5%) |
| candidates | **29** from 19 slices; one slice returned 0 with reasoning |
| subagent tokens | **1,741,885** |
| tool calls | **416** |
| wall time (mining fan-out) | **≈ 11 min 20 s**; slowest slice 318.6 s, median ≈ 200 s |
| engine cost | `--plan` 1.70 s / 195 MB; `--check-recurrence` 0.52 s / 206 MB |
| cap bound the input | **no** |
| artifact | `.devcycle/dreaming/2026-08-04-dream.md` |
| checkpoint | advanced once, to `2026-08-04T20:31:15Z` |

### Two declared deviations from the skill text

1. **20 of 69 slices mined, not 69.** The skill says one dispatch per manifest slice. 69
   dispatches over 154.1 MB was judged too expensive. 49 sessions were enumerated and never
   read, so absence of a pattern in this report is not evidence of absence in the corpus.
2. **Slice text was extracted mechanically before dispatch.** The largest slice is 22.6 MB /
   5,929 records across 61 files — unreadable inside a subagent context, and
   `references/delegation.md`'s read discipline forbids printing file contents through Bash.
   Each slice was reduced by a deterministic extractor mirroring the engine's own
   `messageText()` (154.1 MB → 3.5 MB, 2.3%). **The engine exposes no such affordance and the
   skill does not cover this case** — this is a gap, not a licence.

### Archives were invisible

`archives: 0`, although `.devcycle/archive-doctor-attribution/` exists. The engine matches
`archive-<YYYY-MM-DD>-<slug>`; this directory predates that convention, so the archived-cycle
half of the mining corpus contributed nothing and was never exercised.

## Cost accounting

| item | value |
| --- | --- |
| mining subagents | 20 (all `sonnet`, explicitly pinned — none inherited the orchestrator tier) |
| verification subagents (benchmark-only, not part of the skill) | 4 |
| mining tokens | 1,741,885 |
| tokens per candidate | ≈ 60,065 |
| tokens per candidate surviving both grounding and novelty | see Phase 3 |

Extrapolated to the full 69-slice corpus the skill actually specifies: **≈ 6.0M tokens** per
dream at `standard`, before any distill-side confirmation cost.

## Phase 3 — candidate scoring

29 candidates, scored 0/1 on each criterion. Grounding and novelty were verified by four
adversarial subagents instructed to refute, each opening the cited session digests and
grepping the repo. Two of their verdicts were overturned — see "verification caveat" below.

| criterion | rate | notes |
| --- | --- | --- |
| **C1 GROUNDED** — cites ≥2 distinct sessions | **0/29 (0%)** | structural, see below |
| C1′ — the cited evidence actually exists | **29/29 (100%)** | zero fabricated patterns |
| C1″ — free of inaccurate sub-claims | **25/29 (86%)** | 4 carry an embellished or wrong detail |
| C1‴ — cluster-level, ≥2 sessions | **7/11 clusters (64%)** | 4 singleton clusters |
| **C2 NOVEL** | **26/29 (90%)** | 3 restate a rule the repo already has |
| **C3 ACTIONABLE** | **29/29 (100%)** | every one names a target file and a concrete edit |
| **C4 CORRECTLY TYPED** | **28/29 (97%)** | one contradiction typed as two conflicting doc-edits |
| **C5 DEDUPED** | **29/29 distinct edits** | but 1 pair should have merged, 1 pair conflicts |
| **C6 SCREENED** | **29/29 (100%)** | 1 correctly flagged sensitive; no secret in any candidate or signature |
| **C7 INSTRUCTION-QUALITY** | **29/29 (100%)** | zero pure fact capture |

### C1 — the headline result, stated plainly

**No candidate cites two distinct sessions, and none structurally can.** The skill dispatches
one mining subagent per manifest slice, each dispatch sees exactly one session, and each
returns candidates citing only that session. Cross-session evidence is therefore impossible to
produce at the mining stage. It can only appear at the Cluster step — which the skill assigns
to the coordinator, working from candidate *text*, with no cross-session evidence index and no
instruction to re-open any transcript to confirm two candidates describe the same pattern.

Against the criterion as written, C1 is 0%. Against the weaker "is this real" reading, it is
100%: every one of the 29 candidates' cited evidence was located in its own session digest.
**The single worst outcome — an ungrounded candidate — did not occur once.**

Four candidates carry a sub-claim that does not survive checking, none of which invalidates
the underlying pattern:

1. `scenario-sandbox-tool-ban-copied-without-reverification` — "it recurred in a second
   scenario" is unsupported; every occurrence in the digest names the same file,
   `tests/scenarios/planning-waves/quality-constraints.md`.
2. `mirrored-file pinned text drifts out of parity` — "three separate times, each caught by a
   later review round" is really ~4 divergences across 2 rounds.
3. `changelog-unreleased-hand-write-regression` — cites a `docs/DECISIONS.md` entry dated
   2026-07-23; the entry is dated 2026-07-26.
4. `keychain-credential-extraction-for-headless-scenario-runs` — says the command is present
   "verbatim" at `artifact-cleanup.md:137`. That line does describe `.credentials.json`
   refreshed from the keychain, so the citation is substantially right; the literal command
   is not there — it is allowlisted in `.claude/settings.local.json:87`.

The failure mode is **precision inflation on a real finding**, not invention. That is a
tractable defect (a mining-dispatch rule to state only what the slice shows), and materially
better than the alternative.

### C2 — the three that were not novel

- `review-fix-dispatch-instructs-commit-vs-implementer-never-commits` —
  `agents/implementer.md:57-62` already says "NEVER run git commit… even if your brief or
  dispatch prompt instructs you to". The evidence shows the rule is **not holding** (three
  implementers handled it three different ways), which is a real finding, but the fix is
  enforcement, not a new rule.
- `wave-boundary-handoff-skipped-across-waves` —
  `skills/executing-waves/SKILL.md:292-298` and `references/handoff.md:81-84` already state
  the gate is unconditional. A compliance failure, not a documentation gap.
- `changelog-unreleased-hand-write-regression` — `docs/DECISIONS.md` already records the
  mechanism.

All three are the same shape: **the dream rediscovered a rule that exists and is being
violated.** Spec §6 has no type for that. "The rule exists but is not followed" is arguably
the most actionable thing a corpus can tell you, and the current type vocabulary forces it to
masquerade as a doc-edit.

### C4 — typed correctly, but 1b-i went unexercised

All three `contradiction-resolution` candidates are genuine contradictions, each verified
verbatim against the repo at HEAD. **No candidate offered `scratch-code-recurrence` as
promotable**, so §6's automatic-fail condition did not trigger.

That is a vacuous pass, not a real one: spec §8 makes the scratch-code pass `thorough`-only
and this run resolved to `standard`, so no code path that could produce the type ever ran.
**C4 is untested.**

The one typing miss is the contradiction the design cannot see (below).

### C5 — the contradiction the per-slice design structurally cannot detect

Two candidates propose **opposing rules for the same convention**:

- from `f2a2877b`: omitting `## Baseline (red)` / `## Result (green)` is **acceptable** when
  the brief did not include executing the run → `CONTRIBUTING.md`
- from `f52079c2`: those sections are **required**, even for `Type: discipline` scenarios →
  `references/evidence.md`

Verified as a genuine conflict: in one session a reviewer judged full omission "a reasonable,
disclosed judgment call rather than a spec violation worth rejecting over"; in the other, a
reviewer treated the identical omission as a **blocking** finding on materially the same fact
pattern. Per spec §6 this is exactly a `contradiction-resolution` candidate with both sides
preserved. Instead it surfaced as two independent doc-edits pointed at two different files —
**confirming both would have written contradictory rules into the repo.**

Neither dispatch could see the other. The Contradictions step runs in the coordinator after
mining, but nothing gives it the cross-session comparison it would need.

One further overlap: `plan-authored boundary/verification claims unchecked` and `plan asserts
unverified facts` substantially duplicate — a count-check is a special case of
boundary/verification consistency. They should have merged.

### C6 — the screen worked, and found something

The one candidate flagged `sensitive` was flagged correctly, and its cluster signature —
which names a credential-extraction technique — is itself screenable content, exactly the
case §7 says to catch. No secret value appears anywhere in the candidate set.

The underlying finding is real and worth acting on independently of this benchmark:
extracting the live Claude Code OAuth credential from the macOS keychain into plaintext is
**documented run protocol in four tracked scenario files** (`artifact-cleanup.md:137`,
`mini-cycle.md:270`, `state-file-resume.md:102`, `handoff-block-shape.md:267`) with
`Bash(security find-generic-password *)` allowlisted in `.claude/settings.local.json:87`, and
no governing document prohibits or bounds it.

Note the limit of the §7 backstop: `redaction-check.mjs` screens tracked files only for
absolute home paths and hash-denylisted terms. It passes clean on all four of those files and
could never catch a described credential-handling practice.

### C7 — the thesis holds

**29 of 29 candidates are instruction or skill improvements; zero are fact capture.** Targets
are `skills/*/SKILL.md`, `agents/*.md`, `references/*.md`, `CONTRIBUTING.md`, `DESIGN.md` —
every one an instruction surface. This is the clearest positive result in the benchmark and
directly supports spec §1/§6's claim that dreaming surfaces clearer instructions rather than
merely capturing facts.

### The memory store was never read

Of the 4 memory entries: **1 was surfaced** (`reserve-feat-for-substantial-changes`, from its
own origin session `476c8706`), 1 was touched adjacently
(`devcycle-dev-branch-release-plan`, via the changelog candidate), and 2 were missed entirely
(`on-device-engine-claude-in-chrome`, `pin-cheap-models-on-subagent-dispatch`).

But that framing flatters the run. **Nothing read the memory store at all.** `--plan` emits
`memoryDir` and no code path or dispatch consumes it; the mining dispatches received session
slices only. The one "surfaced" entry was rediscovered from the transcript it originally came
from — coincidence, not consolidation. This confirms the round-1 carry-over ("the memory
store is never read, so `lean` has no source") as a live defect, and it means the `lean`
profile — whose entire job is memory dedup — has no implemented source of input.

### Verification caveat

Two of the four verifiers returned `grounded: 0` with a "fabricated citation" verdict for
`e658312c` and `78e5967c`, because those two digest files had vanished from the scratchpad by
the time they ran. Both were regenerated and the quoted evidence confirmed present
("must show no changes", "Task 17", "unsatisfiable as written"; "tighten" ×11, "surgical
edits" ×3, "over-long"). Both verdicts are overturned in the table above.

Recorded because it is a methodology lesson with teeth: **an adversarial verifier pointed at
ephemeral scratch state will report absence as fabrication.** Any future automated grounding
check must verify against durable inputs, or distinguish "evidence absent" from "evidence
unreachable."

## Phase 4 — the decision run

29 candidates walked through `distilling-learnings`' batched confirmation, 4 per
`AskUserQuestion`, with the sensitive flag surfaced on the one candidate carrying it and the
three not-novel candidates labelled as such before the choice.

| type | confirmed | skipped | rate |
| --- | --- | --- | --- |
| doc-edit | 16 | 2 | **88.9%** |
| skill-edit | 8 | 0 | **100%** |
| contradiction-resolution | 3 | 0 | **100%** |
| scratch-code-recurrence | — | — | **never produced** (thorough-only; this run was standard) |
| **total** | **27** | **2** | **93.1%** |

**Per spec §10, a low confirm rate on a type is itself a finding. No type scored low.** The
inverse reading is the one worth attention: a 93% confirm rate on a first run is high enough
to suspect the confirmation step is not discriminating much. Two things support that worry —
every candidate was pre-screened by a mining dispatch told "0 candidates is a good answer",
and the two skips were both cases I flagged as not-novel *before* asking. A confirmation gate
that only rejects what the presenter already labelled rejectable is not adding much
independent signal.

### The two skips, and why

- `scenario-file-authored-without-headless-run` — skipped as the losing side of the
  contradiction. Resolved in favour of "Baseline/Result required, use honest 'Not yet run'
  placeholders."
- `changelog-unreleased-hand-write-regression` — skipped: already recorded in
  `docs/DECISIONS.md`, and restating it in `CONTRIBUTING.md` would create the second owner
  that two other confirmed promotions exist to eliminate.

### Two candidates were reframed rather than taken as written

Both not-novel cases were confirmed only after being redirected at the actual gap:

- the commit contradiction → land the *enforcement* half (the fix brief must not instruct a
  commit) rather than restating `agents/implementer.md`'s existing rule;
- the wave-boundary handoff → land the *trigger placement* (a pointer at the per-task commit
  step) rather than a third statement of an already-unconditional rule.

This is a type-vocabulary gap, not a scoring accident. Spec §6 has no type for "the rule
exists and is being violated," so both arrived mistyped as `doc-edit`.

### Nothing was landed

All 26 promotions (27 confirmations, with two merging into one) were **carried into the new
cycle as input** rather than applied here — they touch the same files the cycle will edit, and
the repo's own discipline routes non-trivial change through the pipeline.

**Consequence for the benchmark:** `--record-promotion` was never exercised, no promotion
record was written, and the recurrence metric therefore still has zero records to match
against on the next run. The lagging metric remains unexercised end to end.

## Phase 5 — the spec §10 validation gate

| | baseline (1:1 distill) | this dream |
| --- | --- | --- |
| promotion rounds | **1** | **7** |
| token spend | ~0 | **1,741,885** |
| items processed | 4 memory entries | 29 candidates from 20 sessions |
| promotions produced | ≤4 | 26 |

The gate: *"compare distill-run promotion-round count and token spend before and after… If
neither drops measurably, the consolidation step is not earning its cost and needs rework
before Phase 2 starts."*

**Neither dropped. Both rose sharply. By the gate as written, this run fails it.**

That verdict must be read with its limits stated plainly, and it is **not** a passed gate
under any reading:

- **N of 1.** Four memory entries is not a sample. One run, one repo, one profile.
- **The two sides are not the same work.** The baseline consolidates 4 memory entries. The
  dream read 20 sessions and surfaced 29 patterns, **none of which existed in memory**. It did
  not do the same job cheaper; it did a much larger job at real cost. The gate compares a
  cheap narrow step against an expensive broad one and can only ever report "more expensive."
- **The gate may be measuring the wrong quantity.** Round count rises with candidate count, so
  a *better* dream scores *worse*. Cost per accepted promotion — 1.74M / 26 ≈ **67k tokens per
  confirmed promotion** — is the comparison that would actually discriminate, and the spec
  does not define it.

The gate needs redefinition before it can decide anything. That is itself a finding.

## Non-destructive check

- Memory store: **byte-identical** to the pre-run snapshot (`diff -r` clean). All 4 entries
  present; nothing deleted, since no promotion landed.
- `docs/devcycle/promotions/`: still only `README.md`.
- Working tree: only `docs/benchmarks/` (this report) and the pre-existing untracked
  `graphify-out/`. The artifact and checkpoint are under gitignored `.devcycle/`.
- Green gate after the run: **160/160 tests pass**; `validate`, `redaction-check`,
  `duplication-check` all exit 0.

Spec §11's "a dream never modifies the memory store, the transcripts, or the ledgers" **held**.

## What worked

1. **C7, the thesis — 29/29 candidates are instruction or skill improvements, zero are fact
   capture.** This is the strongest result and directly supports spec §1/§6. Every target is
   an instruction surface.
2. **No fabricated patterns.** All 29 candidates' cited evidence was located in the cited
   session. The single worst outcome did not occur.
3. **C3 actionability 29/29** — every candidate named a specific file and a concrete edit.
   Not one "consider improving X".
4. **The screen did real work.** It correctly flagged the one sensitive candidate, correctly
   screened its signature, and surfaced a live security-posture issue (keychain credential
   extraction as documented protocol in four tracked files) that no automated check catches.
5. **The engine's cost fixes hold.** Recurrence with zero records is 0.52 s / 206 MB against
   6.0 s / 279 MB pre-fix — an order of magnitude, verified.
6. **Corpus scoping and redaction are solid.** E1 and E2 both clean on real data: zero foreign
   sessions, zero branch names, zero prose in the manifest.
7. **Mining dispatches showed discipline.** One returned 0 candidates with reasoning; several
   explicitly rejected patterns after grepping the repo and finding them already covered.

## What needs improvement

Each tied to the evidence above.

1. **B1 — the reuse fast path is unreachable** (E4). The running session is in its own corpus,
   so `artifactFresh` is permanently false. Reproduced end to end: checkpoint at 20:31:15Z,
   next `--plan` stale 1.5 s later. `excludeSelf` exists and is applied to recurrence but not
   to planning/freshness.
2. **B2 — lexicographic timestamp comparison** (E4). Two of the three accepted ISO forms
   invert the comparison and make the dream a permanent no-op. Masked today by B1; fixing B1
   alone exposes it.
3. **C1 is structurally unsatisfiable.** One dispatch per slice means no candidate can ever
   cite two sessions. Cross-session evidence exists only if the Cluster step produces it, and
   the coordinator gets candidate text with no evidence index and no instruction to confirm
   two candidates describe one pattern.
4. **Contradiction detection cannot see across slices** (C5). A genuine, verified contradiction
   surfaced as two independent doc-edits aimed at two different files; landing both would have
   written conflicting rules into the repo. The Contradictions step has no cross-session input.
5. **The memory store is never read.** `--plan` emits `memoryDir`; nothing consumes it. The
   `lean` profile, whose entire job is memory dedup, has no implemented source.
6. **Mining is unbounded and unaffordable as specified.** One dispatch per slice over 69
   sessions / 154.1 MB extrapolates to ≈6.0M tokens per dream at `standard`. The manifest
   carries `records` but no byte size, so nothing warns that a 22.6 MB slice is unreadable.
7. **No text-extraction affordance.** A slice cannot be read raw, and the read discipline
   forbids cat-ing it. The engine has `messageText()` internally for recurrence and does not
   expose it for mining. Every real run must reinvent this.
8. **Precision inflation.** 4 of 29 candidates embellished a real finding ("recurred in a
   second scenario" with one file; "three rounds" for two; a wrong date; "verbatim" for a
   paraphrase). Needs a dispatch rule to state only what the slice shows.
9. **No type for "the rule exists and is violated."** Three candidates were rediscovered
   existing rules. Spec §6's vocabulary forces them to masquerade as doc-edits.
10. **E7 — a missing transcript root is a silent empty success** at exit 0, and
    `--check-recurrence` still emits a raw stack trace (round-3 F5, unfixed).
11. **The §10 gate cannot discriminate.** Round count rises with candidate count, so a better
    dream scores worse. Needs a cost-per-accepted-promotion definition.
12. **`--record-promotion` and the recurrence metric are unexercised end to end.** No record
    has ever been written by a real run, so the lagging metric has never had data.
13. **Archived cycles contribute nothing.** `.devcycle/archive-doctor-attribution/` predates
    the `archive-<date>-<slug>` pattern, so `archives: 0` and that half of the corpus never ran.
14. **The confirmation gate may not discriminate** (93.1% confirm). The only rejections were
    ones flagged as rejectable before asking.
15. **Adversarial verification against ephemeral state reports absence as fabrication.** Two of
    four verifiers returned false "fabricated citation" verdicts because scratch digests had
    been cleaned up. Any automated grounding check needs durable inputs.
