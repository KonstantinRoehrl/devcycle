# Dreaming skill — second real-conditions benchmark

- Date: 2026-08-05
- Branch: `feat/session-memory-dreaming` @ `49d1949`
- Repo under test: this repo (devcycle dogfooding itself)
- Profile resolved: `standard`, both runs
- Spec: `docs/superpowers/specs/2026-08-04-session-memory-dreaming-design.md` §10 (amended
  below with this run's marginal figure)
- Prior benchmark: `docs/benchmarks/2026-08-04-dreaming-first-run.md`

## What this run tests that the first benchmark could not

The first benchmark measured a single first-ever mining pass over the whole corpus, with no
checkpoint, no observation store, and no two-tier disposition — the engine and skill built
after that benchmark (map-then-reduce over a staged corpus, the observation store, the
two-tier bulk/escalated split) had not landed yet. This benchmark exercises that rebuilt
architecture twice in sequence: once to build the observation store from a cold start, once
to mine only what accrued since. Its purpose is scope item G — producing the marginal-run
figure the spec's §10 gate has never had — never to produce an averaged or "improved" figure
against the first benchmark, since the two measure different operations.

## Methodology and its caveats — stated up front, not buried

1. **The dreaming skill is unreleased.** `skills/dreaming-across-sessions/` exists only on
   this branch; the installed plugin (devcycle 0.10.1) ships no such skill, so
   `/devcycle:dream` could not be invoked. Both runs were driven manually from the repo's own
   `skills/dreaming-across-sessions/SKILL.md`, the only way to benchmark the post-rebuild
   design before release.
2. **Consequence — the `self` marker never landed.** `self` is set by
   `SELF_SKILL_RE = /^devcycle:(dreaming-across-sessions|doctor)$/` matching a `Skill`
   tool_use or `attributionSkill` (`scripts/dream.mjs:268-283`). Driving the skill manually
   raises no such record, so the coordinator session reports `self=false` in both runs even
   though it ran the dream both times. Under real, plugin-invoked conditions that session
   would be `self=true` and excluded from its own corpus; here it was not excluded.
3. All engine invocations ran `node scripts/dream.mjs` from the repo root — never an
   installed plugin copy.
4. **The memory store was verified unmodified by mtime comparison, not by a `diff -r`
   against a pre-run snapshot.** No snapshot was taken before the run started. Plan step 4
   asks for a `diff -r`-clean check; §6 below states plainly that the weaker check is what
   actually ran and names it a limitation, not a substitute.

## 1. Run 1 — first run at `standard` depth

This run mines the corpus that accrued since the *first* benchmark's checkpoint
(`2026-08-04T20:31:15Z`) into a cold observation store — the store held 0 records before this
run, so every in-window slice gets mined regardless of window size. It is not the gate's
zero-checkpoint "first-run" datapoint (that figure, 67k tokens per confirmed promotion, is
fixed from the first benchmark and is not recomputed here); it is this benchmark's own
starting point.

Corpus manifest (`node scripts/dream.mjs --plan`, exit 0):

| field | value |
| --- | --- |
| `since` (checkpoint) | `2026-08-04T20:31:15Z` |
| sessions | 9 |
| `totalBytes` | 28,417,431 |
| `observations` | 0 |
| `unmined` | 9 |
| `archives` | 1 |
| `artifactFresh` | false |
| `capped` | false (cap 100) |

Slices mined: **11** — `memory` (1) + `archive-2026-08-04-1` (1) +
`<session-id>-corrections` (9). Map dispatches issued: **11**, every one pinned to the fast
tier. Observation records written: **38**.

Per-slice record counts (session ids truncated, matching the sibling first-run benchmark's
convention):

| slice | records |
| --- | --- |
| `archive-2026-08-04-1` | 8 |
| `dc6fc2c1…-corrections` | 7 |
| `memory` | 9 |
| `e8b7bff2…-corrections` | 5 |
| `895e909e…-corrections` | 5 |
| `23fe2a8b…-corrections` | 2 |
| `1a1e4b36…-corrections` | 1 |
| `38b49097…-corrections` | 1 |
| `1cc6bb45…-corrections` | 0 |
| `3b3486f9…-corrections` | 0 |
| `e8a3def5…-corrections` | 0 |

Records by kind: `decision` 23, `correction` 7, `friction` 4, `rule-violation` 4,
`contradiction-side` **0**.

Candidates produced: **30** — 15 `doc-edit`, 8 `skill-edit`, 7 `enforcement-gap`, 0
`contradiction-resolution`. Dropped as already-landed: 2. Sensitive-flagged: 0.

**Partition: Bulk 30 / Requires-explicit-decision 0.**

## 2. Run 2 — the marginal run

Manifest after the checkpoint advanced to `2026-08-05T12:26:13Z`:

| field | value |
| --- | --- |
| `since` | `2026-08-05T12:26:13Z` |
| sessions | 1 (the coordinator session) |
| `totalBytes` | 4,218,253 |
| `observations` (already-mined slices reused) | **11** |
| `unmined` | 1 (raw-transcript stage's list; not admitted at `standard`) |
| `archives` | 0 |
| `artifactFresh` | false |
| `capped` | false |

Map dispatches issued: **0**. The `memory` slice and the single in-corpus session's
`-corrections` slice both already had observation files on disk, and no archive fell in
range. The observation store was **reused, not rebuilt** — all three of plan step 3's
expectations confirmed: `unmined` was short (1, and that 1 is the raw-transcript stage,
which `standard` never admits), map dispatches were far fewer than run 1's 11 (zero), and no
session the first run already covered was re-mined.

Candidates produced: **12** — 3 `doc-edit`, 4 `skill-edit`, 5 `enforcement-gap`.
**Partition: Bulk 12 / Requires-explicit-decision 0.**

## 3. Cost — the two numbers, never averaged

| phase | dispatches | subagent tokens |
| --- | --- | --- |
| Run 1 map | 11 | 683,262 (mean 62,115) |
| Run 1 reduce | 1 | 77,831 |
| Run 1 artifact render | 1 | 45,001 |
| **Run 1 total** | **13** | **806,094** |
| Run 2 map | 0 | 0 |
| Run 2 reduce | 1 | 105,549 |
| Run 2 artifact render | 1 | 56,559 |
| **Run 2 total** | **2** | **162,108** |

**The marginal run (Run 2) cost 162,108 tokens — 20.1% of Run 1's 806,094.** The entire
saving is the observation store: 0 map dispatches against Run 1's 11. Run 1 and Run 2 measure
different operations (cold-store mining of a checkpoint-bounded window vs. reuse-eligible
mining of what accrued since) and their tokens are reported side by side here, never summed
or averaged into a single figure.

`doctor --since <window-start> --json`, the identical command string at both window starts:

| window | costUSD | turns | subagent turns | by model | by agent type |
| --- | --- | --- | --- | --- | --- |
| Run 1 (`--since 2026-08-05T10:32:23Z`) | $32.03 | 278 | 185 | opus $25.17 / sonnet $6.87 | `general-purpose` $9.70, `main` $22.33 |
| Run 2 (`--since 2026-08-05T12:26:33Z`) | $11.80 | 105 | 57 | opus $11.28 / sonnet $0.52 | `general-purpose` $4.30, `main` $7.49 |

Only the `general-purpose` share is dream-attributable; `main` is coordinator overhead
including this benchmark's own orchestration, so each `costUSD` is **an upper bound on that
run's dream cost, not the dream cost.** The sonnet collapse ($6.87 → $0.52) is the map phase
disappearing between runs.

**Comparison to the first benchmark's fixed gate figure.** The first benchmark measured
1,741,885 tokens for 26 confirmed promotions ≈ **67k tokens per confirmed promotion** — that
figure is not recomputed here. Run 1 of this benchmark cost 806,094 tokens, 46% of the first
benchmark's total, but for a much smaller corpus (9 sessions accrued since a checkpoint, vs.
20 of 69 sessions mined from a cold, checkpoint-less start) — the two are not directly
comparable operations either, and the 46% figure describes relative total spend, not
relative efficiency.

### Tokens per accepted promotion — the two figures scope item G asks for

- **Marginal run (measured):** the real `distilling-learnings` decision round ran over Run
  2's artifact. 12 of 12 candidates were accepted, 0 skipped. **162,108 / 12 = 13,509 tokens
  per accepted promotion.** This is the first time the marginal-run figure the §10 gate names
  has ever been measured.
- **Run 1 (assumption, not a measurement):** Run 1's 30 candidates were **never disposed** —
  no decision round ran over Run 1's artifact, so its true accept rate is unknown. If Run 1's
  accept rate is *assumed* equal to Run 2's measured 12/12 (100%), the resulting figure would
  be 806,094 / 30 ≈ **26,870 tokens per accepted promotion**. That number rests entirely on an
  assumption borrowed from a different run and must not be read as measured.
- **First benchmark (measured, prior run, restated for context):** 1,741,885 / 26 ≈ **67k
  tokens per confirmed promotion.**

**No absolute pass/fail threshold is set from any of this**, per spec §10 as amended: a
constant chosen from a single observation would either block a working feature or wave
through a broken one. The marginal figure above is the *first* datapoint on the marginal
axis specifically — and a threshold gets set once there are two marginal-run datapoints to
set it from, which this run alone does not supply.

## 4. Disposition round count (plan step 2)

Both runs partition to Bulk N / Requires-explicit-decision 0, so the two-tier disposition
costs **exactly 1 decision round** — 1 bulk decision, 0 escalated items — regardless of
whether the bulk held 30 candidates (Run 1) or 12 (Run 2). Promotion-round count is retired
as a leading metric per spec §10's 2026-08-05 amendment: with the bulk taking one round
regardless of size, round count no longer tracks anything about a run's quality. It is
recorded here as a cost observation only.

## 5. Confirm/skip rate per candidate type — the surviving leading signal

The real decision round ran over Run 2's (the marginal run's) artifact
(`.devcycle/dreaming/2026-08-05-dream.md`), after this benchmark document's raw measurements
were captured:

| type | accepted | skipped | rate |
| --- | --- | --- | --- |
| `doc-edit` | 3 | 0 | **100%** |
| `skill-edit` | 4 | 0 | **100%** |
| `enforcement-gap` | 5 | 0 | **100%** |
| **total** | **12** | **0** | **100%** |

No type scored low, so nothing here surfaces `enforcement-gap` — the newest candidate type —
failing to earn trust; on this one run, all three types it appeared alongside cleared at
100%. A 100% confirm rate on 12 of 12 is also the same shape the first benchmark flagged as
possibly under-discriminating (93.1% there): every candidate had already survived a mining
dispatch told "0 candidates is a good answer" before reaching the decision round, so a clean
sweep does not by itself demonstrate the gate is filtering hard.

The config-drift check that runs as part of the same decision round was clean — **0
findings** — on a run with no prior promotion-record checkpoint to drift against.

Run 1's 30 candidates have no accept/skip data; see §3's tokens-per-accepted-promotion note
for why no per-type rate can be reported for Run 1.

## 6. Non-destructive check (plan step 4's `diff -r` request — what actually ran)

Plan step 4 asks to verify the memory store is byte-identical to its pre-run snapshot via
`diff -r` against that snapshot. **That is not what ran.** No pre-run snapshot of the memory
store was taken before Run 1 started, so a `diff -r` comparison was never possible after the
fact. What actually ran instead: the memory store's 4 files were checked by **mtime
comparison** against Run 1's start time
(`2026-08-05T10:32:23Z` = epoch `1785925943`). Result: **0 of 4 files modified during either
run.** `MEMORY.md`'s mtime (`2026-08-05T09:15:34Z`) predates Run 1's start and corresponds to
an unrelated prior edit (a promotion's memory-entry deletion from before this benchmark
began), not to anything either dream run did.

**This is a weaker check than the plan asked for.** An mtime match is consistent with "the
file was not modified," but it does not prove content equality the way a byte-for-byte
`diff -r` against a captured snapshot would — a write that restored the original bytes, or a
filesystem that does not update mtimes the way assumed, would pass this check without being
a true byte-identity proof. State this as a limitation of this benchmark's verification, not
as the stronger claim the plan text requests.

## 7. C1 — cross-session evidence (0/29 in the first benchmark)

**Run 1: 2 of 30 candidates cite ≥2 sessions. Run 2: 2 of 12.** The axis moved off zero for
the first time. That must not be overstated:

- one multi-session candidate — *task commit made with `git add -A` or a bare `git commit`
  instead of the task's own pathspec* — spans two genuine transcripts (two real session
  ids);
- the other — *subagent dispatch omits a model and silently inherits the caller's* — spans
  one real transcript plus the `memory` pseudo-session, which is **not a second transcript**.

So of the candidates counted as "citing ≥2 sessions," strictly transcript-plural evidence is
**1 of 30**, not 2 of 30 and not 4 of 42 combined. The reduce dispatch itself flagged this
distinction rather than letting the looser count stand uncaveated.

Neither run produced a `contradiction-resolution` candidate (`contradiction-side` records
were 0 in Run 1's mining, and both runs partition to a Bulk-only split with no escalated
item). So the plan step 4 question — whether any contradiction surfaced as one
`contradiction-resolution` rather than as two independent edits — has **no data point from
this run at all**: there was no contradiction to test the mechanism against, in either
direction. That is reported as "not exercised," not as a pass.

## 8. Was the memory store read at `lean`-eligible depth

Both runs resolved to `standard`, not `lean`, so this benchmark did not run the `lean`
profile itself. But `standard`'s slice set is a superset that includes the `memory` slice —
in Run 1, `memory` was one of the 11 mined slices and produced 9 records, the highest
per-slice count of any slice. Run 2 reused that slice's existing observation file rather than
re-mining it. This means the mechanism `lean`'s memory-only design depends on — the memory
store being read into an observation file — is exercised here, at `standard` depth, even
though `lean` itself was never invoked. That is different from, and should not be
mistaken for, running `lean`: no `lean`-scoped run happened, and this benchmark makes no
claim about `lean`'s other-slice exclusions.

This is worth stating in contrast to the first benchmark, where "nothing read the memory
store at all" was itself a finding (`--plan` emitted `memoryDir` and no code path consumed
it). That specific defect no longer reproduces: the memory slice is read and mined under the
rebuilt architecture.

## 9. Precision-inflation check

Every candidate's evidence carries a verbatim `quote` and its session id. The reduce
dispatch declined to inflate: it left four one-run/already-executed decisions uncandidated
and itemized them separately rather than folding them into promotable candidates, and it
explicitly refused to count the `memory` pseudo-session as a second transcript for C1 (see
§7). No candidate was observed claiming more than its quotes support. This is a
reviewer-checkable claim against `.devcycle/dreaming/candidates.json`, which carries the
quotes; it was not independently re-verified by an adversarial pass in this benchmark the
way the first benchmark's four verifier subagents did.

## 10. Findings — none smoothed over

Six findings this run exposed. F1 and F2 are blocking-severity.

### F1 (blocking, design) — `--check-recurrence` is structurally near-incapable of firing

`checkRecurrence` matches a promotion's `cluster-signature` as a **literal normalized
substring** of a session's text (`scripts/dream.mjs:291-304`), where `normalizePhrase`
(`scripts/dream.mjs:257-262`) only lowercases and collapses non-alphanumerics — no stemming,
no stopword removal, no semantic match.

Measured over the real corpus (138,822 normalized words, 26 landed signature-bearing
records):

- signatures matching in full — what a hit requires: **0 / 26**
- mean signature length: **8.8 words**; mean longest matching prefix: **2.1 words**
- signatures with even a 3-word prefix present: 6 / 26; with a 5-word prefix: **1 / 26**
- best case: 6 of 9 words

Signatures are model-authored prose, so they essentially never recur verbatim in a later
transcript — and the skill deliberately suppresses printing them to avoid self-seeding,
which removes the one mechanism that would have made them recur. **The 0-hit result is what
the matcher returns almost regardless of whether the promotions held.** It must not be
reported as evidence the 26 promotions held — that reading is not available from this data.

### F2 (blocking, correctness) — Reduce is not reproducible on identical input

Both reduce runs read a byte-identical store (38 records, 11 files, unchanged between runs —
verified). They produced:

- Run 1: **30** candidates; Run 2: **12** candidates
- exact cluster-signature overlap: **1**; 11 of Run 2's 12 signatures appear nowhere in Run
  1's output

Inspection shows most clusters are the *same finding re-worded*, e.g.:

- Run 1 candidate 20: `engine invocation written into plugin text uses a repo-relative path`
- Run 2 candidate 11: `engine invocation written into plugin text uses the repo-relative
  path`

— differing by a single article. Two consequences:

1. **Lexical instability.** Dedup-against-landed-promotions (the reduce step) and
   `--check-recurrence` both key on signature text, so a one-word drift defeats them. This is
   the same root cause as F1 and makes the durable store's promise — never re-propose what
   already landed — unreliable.
2. **Granularity instability.** Run 2 consolidated a release/merge-back family (Run 1's
   candidates 25–30, six separate `doc-edit`s) into one candidate and dropped clusters it
   judged already fixed in the working tree — a filter the skill never mandates. Nothing pins
   cluster granularity, so "candidates produced" is not comparable across runs, and **tokens
   per accepted promotion inherits that instability in its denominator.**

### F3 (high) — `standard` depth cannot see user turns at all

`messageText` (`scripts/dream.mjs:318-326`) keeps only `content[].type === "text"` blocks and
discards role and per-message timestamps. Verified on a real slice: 550 lines / 31,324 bytes
of flat text from a 719,929-byte transcript, with **0 role markers and 0 ISO timestamps**.

Therefore, at `standard` depth — whose slice is defined as *user-correction turns*:

- a map dispatch **cannot distinguish user turns from assistant turns**; and
- `AskUserQuestion` turns, where this user's decisions actually live, are **stripped
  entirely**, because the answers arrive as `tool_result` rather than text blocks. `doctor`
  reports `AskUserQuestion: 5` for one of these very sessions, so the data exists in the
  transcript and is lost in extraction.

Three of nine correction slices returned **0 records** and reported exactly this. The
archive ledger — one file — yielded 8 records, more than five correction slices combined.
`standard`'s headline source is its weakest.

The `ts` field of every observation record is likewise unpopulatable per-record; a fixed
session-level `ts` was supplied to each slice as a disclosed degradation.

### F4 (medium) — corpus `totalBytes` overstates model-visible input ~34x

`totalBytes` was 28,417,431 for Run 1, but the sum of `--extract` output across all 9
sessions is **843,108 bytes (~210k tokens)**. Budgeting from `totalBytes` — which the skill
explicitly offers as the way to budget a run before it starts — overstates the real cost by
roughly 34x.

### F5 (medium) — slice-level granularity loses within-session growth permanently

The coordinator session grew from 678,475 bytes (Run 1's manifest) to 4,218,253 bytes (Run
2's manifest). Because its `-corrections` slice already had an observation file, Run 2 mined
none of that growth, and no later run ever will: the slice id carries no offset or content
hash. This is the flip side of the resume mechanism that makes marginal runs cheap.

### F6 (low) — a map dispatch wrote a truncated slice filename

One dispatch wrote a slice filename truncated to the session id's first segment instead of
the full session id, despite the exact path being given. It was manually renamed before Run
2; left alone it would have caused Run 2 to re-mine that slice. Nothing in the engine
validates observation filenames against the manifest's slice ids.

## What worked

1. **The resume mechanism holds.** Run 2's `unmined` was 1 (the raw-transcript stage,
   inadmissible at `standard`), map dispatches dropped from 11 to 0, and no session Run 1
   already covered was re-mined — all three of plan step 3's expectations confirmed.
2. **The two-tier disposition delivers on its design.** 30 candidates (Run 1) and 12
   (Run 2) both cost exactly one decision round, where the pre-amendment design would have
   cost one round per candidate.
3. **The memory slice is read and mined**, closing the specific defect the first benchmark
   named ("nothing read the memory store at all").
4. **12 of 12 candidates accepted at 100% across all three types** on the marginal run's real
   decision round, with a clean config-drift check.
5. **The reduce dispatch under-claimed rather than over-claimed** on cross-session evidence
   (§7) and left ambiguous cases uncandidated (§9) rather than inflating them.

## What needs improvement

1. **F1 and F2 are blocking.** The recurrence check cannot fire on real prose (F1), and the
   reduce step is not reproducible on byte-identical input (F2) — the same lexical-matching
   root cause undermines both the lagging metric and the durable store's dedup promise.
2. **`standard` depth loses the data it is named for.** User-turn and `AskUserQuestion`
   content is structurally invisible to it (F3).
3. **The corpus-sizing figure offered for budgeting is off by ~34x** (F4).
4. **Marginal-run economics degrade permanently once a session grows** past its first mining
   pass, with no mechanism to detect or re-mine the growth (F5).
5. **A filename-writing bug can silently break the resume mechanism** this benchmark's Run 2
   depended on (F6) — currently caught only by manual inspection.
6. **The verification of "a dream never modifies the memory store" is weaker than specified**
   (§6): an mtime check, not the `diff -r` against a captured pre-run snapshot the plan
   named. No snapshot exists to run that stronger check retroactively.

## Non-destructive check, and confirmation of scope

- Working tree touched by this benchmark: only
  `docs/benchmarks/2026-08-05-dreaming-second-run.md` (this file) and the local-only, gitignored
  `docs/superpowers/specs/2026-08-04-session-memory-dreaming-design.md` §10 edit. The dream
  artifact, checkpoint, and observation store live under gitignored `.devcycle/dreaming/`.
- `docs/devcycle/promotions/`: not modified by this benchmark — the 12 accepted candidates
  from Run 2's decision round were not applied to any promotion file as part of producing this
  document.
- Memory store: see §6 — verified unmodified by mtime comparison, not by `diff -r`; this is a
  disclosed limitation, not a byte-identity proof.
