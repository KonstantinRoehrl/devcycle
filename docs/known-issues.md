# Known issues

Open defects in devcycle's own engines, recorded so they are not rediscovered from scratch.
Each entry names the code it lives in and what goes wrong if it is left alone. **Fixing one
means deleting its entry in the same commit** — an entry that outlives its defect is worse
than no entry.

Not a backlog of ideas: everything here is a confirmed defect with a located cause.

## Dreaming engine — `scripts/dream.mjs`

F1–F6 were exposed by two real-conditions runs over this repo's own session corpus
(2026-08-04 and 2026-08-05). The measurements quoted below come from those runs' reports,
which are local-only and deliberately untracked — so treat the numbers as recorded
observations, not as figures a reader can re-derive from this repo.

### F1 — `--check-recurrence` is structurally near-incapable of firing (blocking, design)

`checkRecurrence` (`scripts/dream.mjs:335`) tests a promotion's `cluster-signature` as a
literal substring of each session's normalized text (`s.normalized.includes(sig)`, `:354`),
and `normalizePhrase` (`:296`) only folds whitespace and case and collapses non-alphanumerics
— no stemming, no stopword removal, no semantic matching.

Measured over 138,822 normalized words and 26 landed signature-bearing records: **0 / 26**
signatures matched in full. Mean signature length 8.8 words against a mean longest matching
prefix of 2.1 words; only 1 / 26 had even a 5-word prefix present; best case 6 of 9 words.

Signatures are model-authored prose, so they essentially never recur verbatim — and the skill
deliberately suppresses printing them to avoid self-seeding, removing the one mechanism that
would have made them recur.

**Consequence:** a 0-hit result is what this matcher returns almost regardless of whether the
promotions held. It must never be reported as evidence that they held; that reading is not
available from this data.

### F2 — Reduce is not reproducible on identical input (blocking, correctness)

Two reduce runs over a byte-identical store (38 records, 11 files, verified unchanged)
produced 30 and 12 candidates respectively, with **exactly 1** cluster-signature in common;
11 of the second run's 12 signatures appeared nowhere in the first. Most were the same finding
re-worded — one pair differed by a single article.

**Consequence, two distinct failures.** *Lexical instability:* dedup-against-landed-promotions
and `--check-recurrence` both key on signature text, so a one-word drift defeats both — the
same root cause as F1, and it makes the durable store's promise never to re-propose landed
work unreliable. *Granularity instability:* nothing pins cluster granularity, so "candidates
produced" is not comparable across runs and tokens-per-accepted-promotion inherits an unstable
denominator.

### F3 — `standard` depth cannot see user turns at all (high)

`messageText` (`scripts/dream.mjs:368`) keeps only `content[].type === "text"` blocks and
discards role and per-message timestamps. Verified on a real slice: 550 lines / 31,324 bytes
of flat text from a 719,929-byte transcript, with 0 role markers and 0 ISO timestamps.

At `standard` depth — whose slice is defined as *user-correction turns* — a map dispatch
therefore cannot distinguish user turns from assistant turns, and `AskUserQuestion` turns are
stripped entirely because their answers arrive as `tool_result` rather than text blocks.
Doctor reports `AskUserQuestion: 5` for one of these very sessions, so the data is in the
transcript and lost in extraction. Three of nine correction slices returned 0 records; a
single archive ledger yielded more than five correction slices combined.

Also makes each observation record's `ts` field unpopulatable per-record.

### F4 — corpus `totalBytes` overstates model-visible input ~34× (medium)

`totalBytes` reported 28,417,431 bytes where the sum of `--extract` output across all 9
sessions was 843,108 bytes (~210k tokens). The skill offers `totalBytes` as the way to budget
a run before starting it, so budgeting from it overstates real cost by roughly 34×.

### F5 — slice granularity loses within-session growth permanently (medium)

Slice ids carry no offset and no content hash, so once a slice has an observation file its
session's later growth is never mined. Observed: the coordinator session grew from 678,475 to
4,218,253 bytes between runs and none of that growth was mined, nor will any later run mine
it. This is the flip side of the resume mechanism that makes marginal runs cheap.

### F6 — observation filenames are never validated against the manifest (low)

One map dispatch wrote a slice filename truncated to the session id's first segment despite
being given the exact path. It was renamed by hand; left alone it would have caused the next
run to re-mine that slice. Nothing in the engine checks observation filenames against the
manifest's slice ids.

### Observation files are validated only on the happy path (medium)

`--check-observations` runs only inside the map dispatch that just wrote the file, so an
*interrupted* dispatch — the exact failure mode the validation exists for — never reaches it.
`planCorpus`'s work list remains existence-only (`scripts/dream.mjs:490`), so a truncated
observation file counts as mined forever.

Closing this properly means rewording the resume mechanism away from "sessions that have no
observation file", which is what currently pins `hasObservations`/`unmined` semantics.

## Doctor — `scripts/doctor.mjs`

### `readRecords` swallows every filesystem error (high)

`readRecords` (`scripts/doctor.mjs:590`) returns `[]` on any read failure, so a
permission-denied or oversized transcript makes the session vanish from the manifest and
`--extract` exit 0 with nothing — a silent empty result that reads as success.

Left deliberately unfixed while the dreaming work was in flight, which froze `doctor.mjs` at
"add `export`, no behavior change". That freeze has since lifted.
