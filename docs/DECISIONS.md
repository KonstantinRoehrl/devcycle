# Decision log

Dated records of decisions that changed the project's course, so older docs that predate a
reversal have somewhere to point. Newest first. Each entry: the decision, why, and what it
supersedes. Historical documents (the dry-run report, platform notes, the founding spec)
are evidence of their moment — they get a forward pointer here, never a rewrite.

## 2026-08-05 — dreaming's mining splits into map→reduce, corpus staging replaces a budget gate, and disposition goes two-tier

**Decision:** Five changes land together as amendment 2 to the 2026-08-04 design. First,
mining splits into a fast-tier **map** stage (one dispatch per session slice, writing an
observation record to the durable store at `.devcycle/dreaming/observations/`) and a
caller-tier **reduce** stage that reads the *full* store, because a single-slice dispatch
saw exactly one session and could never cite a second — evidence spanning two or more
sessions was structurally impossible, not merely rare, under the old per-slice design.
Second, the corpus a dream mines is staged by signal density — memory, then
archives/findings/ledgers, then user-correction turns, then raw transcript text — and how
far a run goes into that stage order is gated by `profile`, not by a token budget. Third,
disposition becomes two-tier: one reviewed decision covers the bulk of the artifact
(adopt, discard, or adopt-with-exclusions), while every sensitive-flagged candidate and
every `contradiction-resolution` stays at per-item confirmation, decoupling the cost of
deciding from how many good candidates a run finds. Fourth, the candidate-type list gains
`enforcement-gap` (the rule already exists and is being violated; the fix is enforcement,
not a new rule) and drops scratch-code recurrence detection as a named non-goal. Fifth,
`contradiction-resolution` is still never auto-resolved by recency — that remains a
deliberate divergence from the external reference this design's four-stage model draws
from, because that reference's consolidated memory is a private store it may freely
rewrite, while devcycle's output is a committed instruction surface other developers
inherit on pull, where a silent latest-wins could delete a decision a human already made.
**Why:** Each change follows from evidence the first benchmark produced. The map→reduce
split follows directly from that benchmark scoring 0/29 on cross-session evidence,
structurally rather than by accident, and from a genuine contradiction surfacing as two
independent doc-edits aimed at two different files — confirming both would have written
conflicting rules into the repo. Staging by signal density (not by budget) follows because
a budget gate makes coverage nondeterministic — two runs over the same corpus would mine
different amounts, destroying the marginal-vs-first-run comparison the design's own
measurement depends on — and a signal-heuristic gate would let a quiet high-density stage
suppress mining the denser evidence underneath it; profile-gating also finally gives `lean`
an implemented input (previously its whole job, memory dedup, had none) and moves the
expensive raw-transcript stage to the profile a user opted into. Two-tier disposition
follows because per-candidate confirmation does not scale with a corpus that grows every
cycle, while the two categories that most need a human's individual attention — flagged
content and genuine conflicts — are small by construction and the ones confirmation exists
to protect. `enforcement-gap` follows because three of the first benchmark's candidates
were rediscoveries of rules the repo already states, which the prior vocabulary forced to
masquerade as `doc-edit`s proposing text already present — restating an unenforced rule is
the one fix guaranteed not to work. Scratch-code recurrence drops because the map→reduce
architecture subsumes its signal (a re-derived fixture now clusters across sessions like
any other observation) and because it never produced a datapoint: the prior design gated it
to `thorough`, the benchmark ran at `standard`, so no code path that could produce the type
ever executed.
**Supersedes:** The 2026-08-04 entry's engine/skill split describes the prior per-slice
dispatch design; this entry's map→reduce split replaces its mining mechanism, not its
architectural boundary (the engine/skill split itself — `scripts/dream.mjs` deterministic,
`dreaming-across-sessions` judgemental — stands unchanged). It also completes a carry-over
from the same cycle: an earlier confirmed promotion asked for a missing `dreaming depth`
row in `DESIGN.md` §15.2's profile matrix; that matrix is deleted in this same change
(replaced by a pointer to `references/config.md`, the matrix's single owner), so the
row-addition carry-over is now moot rather than actioned.

## 2026-08-04 — dreaming's engine/skill split, corpus, and artifact handoff settle four departures from the originating ticket

**Decision:** Four points diverge from the ticket that proposed session-memory dreaming.
First, promotion records are committed under `docs/devcycle/promotions/` rather than
`.devcycle/promotions/`, because `.gitignore` excludes `.devcycle/` repo-wide and git has no
mechanism to re-include one subdirectory of an excluded parent — the checkpoint and dream
artifact stay under `.devcycle/` since only the promotion records need to survive a clone.
Second, the corpus a dreaming pass mines is transcripts plus memory, not transcripts plus an
accumulated ledger, because devcycle keeps no such ledger; archiving is added at finish so a
ledger-shaped corpus exists for future passes without inventing one retroactively for this
one. Third, the semantic mining and clustering work lives in the skill layer
(`dreaming-across-sessions`) rather than in `scripts/doctor.mjs`, because doctor is not
guaranteed to emit message text at all profiles and semantic work needs it; the engine
(`scripts/dream.mjs`) stays deterministic and owns only what doesn't need message text —
checkpoint, corpus enumeration, the 100-session cap, artifact freshness, promotion records,
and recurrence matching. Fourth, the dream artifact is the handoff between the two invocation
paths (`/devcycle:dream` standalone and `distilling-learnings` step 0) rather than the
checkpoint, because advancing the checkpoint from a read-only preview run would discard
candidates a later real run should still see.
**Why:** Each departure follows from a constraint the ticket didn't carry: `.gitignore`'s
repo-wide exclusion is a git limitation, not a design preference, so the artifacts that must
ship with the repo need a path outside `.devcycle/` entirely rather than a narrower ignore
rule. The corpus choice follows the same principle as the profile-knob entries below — build
the mechanism the repo actually has (transcripts, memory) rather than assume infrastructure
(a ledger) that doesn't exist yet, and grow it forward from here. The engine/skill split
follows doctor's actual contract: a deterministic script can be trusted to run unattended and
cheaply, but it cannot promise message text, so the step that needs message text has to be
where an agent, not a script, does the reading. The artifact-as-handoff choice protects the
one asymmetry between the two callers — `/devcycle:dream` is allowed to preview without
committing, and only the artifact (not the checkpoint) can capture that without also making
the preview run un-repeatable for the caller that does commit.
**Supersedes:** Nothing reversed — the originating ticket proposed `.devcycle/promotions/`,
transcripts-only corpus mining inside `doctor.mjs`, and checkpoint-as-handoff; none of those
were ever implemented, so nothing here reverses shipped behavior. The named non-goal:
cross-developer raw aggregation (pooling promotion records or dream artifacts across
contributors into one corpus) is documented as a future direction, not built in this pass.

## 2026-08-01 — context depth becomes measurable, and implementer routing inverts

**Decision:** Two reversals ship together. First, context depth becomes a measured quantity
rather than an estimated one: `references/delegation.md`'s claim that "an agent cannot
reliably observe its own context fill" is retired, because the live transcript's
`message.usage` records exact depth per request and a running session can read its own
transcript — the probe (`scripts/doctor.mjs --depth`) and the depth gate are therefore one
design, not two, and the depth ceiling is now enforceable rather than aspirational. Second,
implementer routing inverts from session-by-default to fast-by-default with named escalation
triggers, on the evidence that fast-declared implementers did the same raw work (785k vs 794k
raw context units per run, 18k vs 20k output tokens) at a fifth of the price, and that a wrong
cheap guess costs at most one review round.
**Why:** Both reversals rest on the same kind of correction — a premise that was assumed
rather than checked. The depth premise was checked by reading what the transcript actually
carries; the routing premise was checked by measuring what fast and session implementers
actually cost and produced. The 15%/20% depth thresholds in the new gate are recorded as
absolute measurements taken on 1M-window sessions, divided by 1M — expressing them as
fractions is a deliberate approximation so they adapt to smaller-window models, even though
cache-read cost actually scales with absolute tokens, not with the fraction of the window
used. Doctor's own per-model band data is what should confirm or correct these thresholds as
more models are profiled.
**Supersedes:** `references/delegation.md`'s "an agent cannot reliably observe its own context
fill" claim, and the session-by-default implementer routing predicate it and
`references/config.md` previously encoded.

## 2026-07-31 — the context reset becomes binding at every boundary, and the stage budget is counted rather than estimated

**Decision:** Every stage boundary in `references/handoff.md` now defaults to a reset, and the
action column takes exactly three values — `Continue` · `Clear + /devcycle:continue` ·
`Fresh session`. `Compact with hint` is retired as an action; the `Keep`/`Drop` compaction hint
stays, as the instruction the *resumed* session is briefed with rather than a way to avoid
resuming. `Continue` is no longer any boundary's default except `finish → (end)`, and is
reachable at five named boundaries only when the ended stage stayed under budget, dispatched no
implementer, task-reviewer or sweep, and left the next stage's inputs on disk; any doubt resolves
to the table's default. The await gate is unconditional: emitting the block is not permission to
proceed. The budget the coordinator must stay under is a count it can actually keep — **~30 tool
calls** or **~15 files read** within one stage — and a new `references/delegation.md` owns it
together with the coordinator's duties and the repo-research procedure that other skills now
point at.
**Why:** The two mechanisms meant to bound context both already existed and neither bound
anything: the action table offered `Continue` as a legitimate per-row value and the await gate
let a `Continue` action pass through, so a coordinator that wanted to keep going always had a
sanctioned way to. Measurement is what settled it — a 268k median context in `executing-waves`
and 244k in on-device, with the main thread taking 43% of turns but 72% of cost, which is the
signature of work that should have been delegated or reset staying on the expensive thread.
`Compact with hint` went because compaction is not a reset and the numbers say so: the month's
most expensive session was 39% post-`/compact` and still the single largest line item, so the
mechanism sold as the cheap middle path demonstrably failed to bound the thing it was there to
bound, while reading as compliance. The budget is counted rather than estimated because an agent
cannot reliably observe its own context fill — the same reasoning `references/config.md` already
applies when it restricts the model-tier derivation predicates to dispatch-time-observable
inputs. Tool calls made and files read are things a coordinator can tally as it goes; "about 40%
full" is a guess wearing a threshold's clothes, so the ~40% figure survives only as an explicitly
non-binding hint beside the two counters.
**Supersedes:** `references/handoff.md`'s four-value action column, whose fourth value
`Compact with hint` is now unsanctioned, and its per-row `Continue` values, replaced by resets
plus the narrow three-condition softening test. It also ends `devcycle:scoping-interview`'s
ownership of the repo-research procedure, which it spelled out in full: the procedure now lives
in `references/delegation.md`, and scoping-interview — with planning and audit research — points
at it rather than carrying a copy.

## 2026-07-27 — `auto` releases a knob back to the profile; the upgrade trap is asked about, not fixed silently

**Decision:** `auto` becomes a sanctioned value on the two profile-covered behavioral knobs
(`reviewDepth`, `onDeviceGate`), meaning "let the profile govern this" — the same convention
the four `*Model` knobs already use, and one more case in `references/config.md`'s single
resolution list rather than a second rule. `/devcycle:cycle` detects the upgrade signature
before any stage runs — `${user_config.profile}` still a literal placeholder (it ships in
this release, so nobody has set it) while at least one behavioral knob substitutes to a real
value (only an earlier configuration can have set one) — and asks ONE question: adopt a
profile and let it govern (writing `profile=<value>` plus `auto` for the shadowing knobs
only), keep the current explicit knobs and skip the profile, or customize. Every completion
of either configuration offer records a `· profile-asked` marker on the state file's
`configured:` line, and the marker — not the signature — is what makes the offer one-time.
**Why:** The previous entry's fix — write only `profile` at first run — protects future
users and does nothing for existing ones. The pre-0.8.0 walkthrough wrote all four
behavioral knobs explicitly, "including on 'use defaults'", so every user who ever completed
it upgrades into a state where `profile: thorough` changes nothing at all, silently: the
feature is dead on arrival for exactly the people already running the plugin. Silently
ignoring an explicit knob when a profile is set would fix the symptom and lose something
real — the user chose that value, and demoting a stated choice without asking is a worse
defect than the one it cures, especially for `onDeviceGate`, where the discarded choice is
"a human must sign off". Hence a value rather than a deletion (`--config <knob>=auto` keeps
the knob visible and re-pinnable), and a question rather than an action. The signature alone
is NOT sufficient to identify an upgrader, and an earlier draft of this change wrongly
assumed it was: this release's own customize path writes a moved knob without writing
`profile`, so a brand-new user who pins `reviewDepth` reproduces the signature exactly on
their next cycle and would have been asked to undo a choice they had just made. Hence the
marker, written on every completion of either offer — the invariant is "never ask a user
this release has already asked", which no property of the rendered knobs can express. It is
per-repo, so the two answers that do not write `profile` hold for one repo rather than
globally; being asked once more in another repo is the accepted cost of never acting
unasked. Its scope is deliberately narrower than its trigger —
`gitPolicy` and `crossModelReview` are outside the profile matrix, so an explicit value
there shadows nothing and is never rewritten, and when the shadowing set is empty there is
nothing to migrate and the ordinary first-run walkthrough runs instead.
**Supersedes:** Nothing reversed. It completes the 2026-07-26 `profile` entry below, whose
resolution order (an explicit knob wins verbatim and forever) is exactly the mechanism that
makes the trap possible and is left intact — that entry described the trap for the first-run
path and closed it there, but did not carry the reasoning across the upgrade boundary. It
also narrows that entry's reading of `auto` as a `*Model`-only convention: `auto` is now
general, and a stage skill's allowed-value enumeration (`single` | `panel`) names what a
knob resolves *to*, never a set that makes `auto` invalid.

## 2026-07-26 — one `profile` knob sizes the pipeline; an unset knob takes the profile's value

**Decision:** A new `profile` option (`lean` | `standard` | `thorough`, default `standard`)
picks the cost/rigor of every stage at once: the planning and execution engine, the
branch review engine, the on-device gate, the evidence tail in subagent reports, the
branch-review round cap, and audit depth. Resolution order, binding and stated once in
`references/config.md`: a knob explicitly configured — neither a literal `${user_config...}`
placeholder nor `auto` — wins verbatim; otherwise the profile's column value applies;
`profile` itself falls back to `standard` when unset or out of range, with the state file's
`configured:` line governing the current run. The first-run walkthrough becomes ONE question
over `profile` and writes only `profile=<value>`; the old four-knob batch survives as its
"customize individual knobs" branch.
**Why:** The cost/rigor trade-off was a fixed shape with no dial — a one-file docs change and
a multi-subsystem feature paid the same overhead — and the only way to move it was to assemble
it by hand from four unrelated switches. Writing the individual knobs at first run would have
been worse than not asking: an explicit knob shadows the profile forever, so a walkthrough that
wrote out that moment's defaults would quietly pin them and the profile could never move them
again.
**Supersedes:** The knob-resolution convention recorded in the 2026-07-25 "finish stage
extracted into the finishing-the-cycle skill" entry — "literal placeholder = unset,
out-of-range = invalid, both → the knob's documented default" — on both counts. The documented
default is no longer what an unset knob resolves to; the profile's column is, and the
per-knob default in `plugin.json` now only describes what `standard` happens to resolve to.
That entry also placed the convention canonically in `/devcycle:cycle`'s Configuration
section; it lives in `references/config.md` now, and the command carries a pointer.
`standard`'s column reproduces the pre-0.8.0 defaults for `reviewDepth` and `onDeviceGate`,
so the only intentional change of default behavior is the execution engine (next entry).
Also supersedes the four-knob AskUserQuestion batch and the "use defaults, don't ask again"
answer of the 2026-07-23 "first-run config walkthrough" entry. That entry's reasoning — make
the invisible unset-means-default behavior visible exactly once — still holds, and is why the
offer survives at all; what it got wrong is the mechanism. Its instruction to apply the answers
by writing the explicit default values, "including on 'use defaults'", is precisely the trap
above: it would have made all four knobs explicit and permanently un-profileable for every
user who took the recommended answer.

## 2026-07-26 — `lean` and `standard` run devcycle-native engines; upstream overlays move to `thorough`

**Decision:** At `lean` and `standard`, `devcycle:planning-waves` and
`devcycle:executing-waves` are self-contained: they do NOT load `superpowers:writing-plans`
or `superpowers:subagent-driven-development`, and carry the plan template, right-sizing,
step-granularity, brief-slicing and review-loop mechanics they need inline. At `thorough`
they overlay upstream exactly as they did through 0.7.0. One behavioral contract spans both
engines — the same plan output contract, the same wave-formation invariants, the same ledger
events, the same green gate, the same review cycle — so a finished plan and a finished wave
have the same shape whichever engine produced them; only the *source* of the mechanics
differs. The `red-green` TDD splice follows the same rule: the full
`superpowers:test-driven-development` content at `thorough`, and at `lean`/`standard` an
excerpt carrying exactly three things (failing test first; run it and capture red before
writing implementation; then minimal code and capture green). `superpowers:brainstorming` and
`superpowers:systematic-debugging` are unchanged at every profile — they are interview and
diagnosis stages whose value is the process itself.
**Why:** Measured: devcycle's own surface is 100.9k chars and upstream added 70.1k on top, of
which `subagent-driven-development` alone is 28.1k loaded under a 14.3k overlay. Every run
paid for the whole upstream skill in order to reach mechanics the overlay had already narrowed
or replaced — its final-code-reviewer dispatch and its finishing-a-development-branch step
never applied here, its implementers-commit convention is inverted in devcycle (the
coordinator commits), and its progress-file path was overridden. The overlay is not wrong;
it is simply not worth its weight at every size of change, which is what a profile is for.
**Supersedes:** No earlier entry in this log decided the unconditional overlay — it is a
founding-spec premise, carried in both skills' `REQUIRED SUB-SKILL` lines since the day each
skill was created. This
narrows that premise to `thorough` rather than abandoning it, and it does not touch the
superpowers dependency itself: `superpowers:brainstorming`,
`superpowers:systematic-debugging`, `superpowers:requesting-code-review` and `thorough`'s
overlays still require it, so the 2026-07-23 dependency-pin entry and the 2026-07-23
"install: linked, not documented" entry stand unchanged.

## 2026-07-26 — the profile's engine row is narrowed to planning and execution; brainstorm stays upstream

**Decision:** The profile matrix row reads `planning / execution engine`, not
`brainstorm / planning / execution engine`. Only `devcycle:planning-waves` and
`devcycle:executing-waves` carry a profile-keyed engine-selection block; the brainstorm stage
runs `superpowers:brainstorming` unmodified at every profile, exactly as the diagnosis stage
runs `superpowers:systematic-debugging` unmodified at every profile. `references/config.md`'s
row is narrowed to match what shipped; `README.md` and `DESIGN.md` carry the narrowed row.
**Why:** The row as pinned promised a devcycle-native brainstorm engine at `lean` and
`standard`, and none was built — nothing in `/devcycle:cycle` switches the brainstorm stage on
the profile. Offered the choice between building one and narrowing the claim, the repo owner
chose to narrow it, and the stage is the reason: brainstorm's value is the interview process
itself, so a compact reimplementation would be cutting the substance rather than the ceremony
— the same argument that keeps `systematic-debugging` untouched. Leaving the wide row in place
was the worse option on its own terms: a matrix that advertises a switch the tree does not make
is precisely the phantom-default failure this release already corrects once, for
`reviewDepth: single`, and shipping a second one in the same release would undercut the
correction.
**Supersedes:** The `brainstorm / planning / execution engine` row as pinned in this cycle's
own plan (`docs/superpowers/plans/2026-07-26-compact-profile-driven-devcycle.md`) and its
design spec, and the first version of that row in `references/config.md`. The plan and the
shipped tree therefore differ here **by decision, not drift** — the plan records what was
ordered and is not rewritten, per this log's rule for historical artifacts, and this entry is
the pointer that accounts for the difference. Nothing in the native-engines entry above changes:
planning and execution do switch, and their single behavioral contract across both engines
stands. The narrowing is reversible in the widening direction — a devcycle-native brainstorm
engine remains buildable later and would re-widen the row rather than contradict this entry.

## 2026-07-26 — `reviewDepth: single` redefined: `code-review` is a fold-in, not the engine

**Decision:** `single` IS this pipeline's own review: `reviewing-the-branch`'s
spec-compliance layer plus the reviewer guidance of `superpowers:requesting-code-review`
(severity calibration, read-only review of the work product, structured findings, crafted
reviewer context rather than session history). The built-in `code-review` skill is
user-invocation-only in current Claude Code — an agent cannot launch it — so it is demoted to
an opportunistic fold-in: if the user has run it on the branch independently, its findings are
folded in and the engine line reads `single + user-run code-review`. The "graceful
degradation" framing is removed from `single` (nothing is degraded any more) and kept for
`panel`, which falls back to `single` and says so. The engine line's permitted values are
pinned to exactly five: `single`, `single + user-run code-review`, `panel`,
`panel [+ cross-model lens]`, `panel→single (panel unavailable: <reason>)`.
**Why:** The default branch-review engine named a skill no agent can invoke, so in practice
every default-configuration review took the "degraded" path and labelled itself degraded in
its own report — the plugin's default gate describing itself as a failure mode while running
the exact review it always meant to run. A report shape that can only ever print the
apology makes the engine line worthless for auditing which engine actually ran.
**Supersedes:** `reviewing-the-branch`'s engine-selection rule ("run the built-in
`code-review` skill against the branch, then layer the spec-compliance review on top") and its
degradation clause. It also finishes the job of the 2026-07-23 "red-team-reviewer wired into
the panel; mechanical-sweep demoted to manual" entry: that entry's principle — a component
documented as used must either be wired in or have its docs match reality — was applied to
`red-team-reviewer` and `mechanical-sweep.js` while `code-review`, an orphan of exactly the
same kind sitting in the default path, was left promising an integration that could not
exist.

## 2026-07-26 — the ledger moves into devcycle's own namespace

**Decision:** The ledger lives at `.devcycle/ledger.md`, everywhere and unconditionally, and
its event enum gains `review-round`:
`dispatched|report-received|review-round|review-verdict|committed|user-decision`. At
`thorough`, where upstream `subagent-driven-development` is loaded, devcycle's path overrides
upstream's progress-file path — stated explicitly in `executing-waves` so the two are never
both written.
**Why:** The ledger was the last piece of devcycle's durable state living in another plugin's
namespace while `state.md`, `diagnosis.md`, the evidence files and `sweep-report.json` all sit
under `.devcycle/`. Two concrete costs: a user who gitignores or clears `.devcycle/` (which
the README now recommends for target repos) got a half-cleared cycle with an orphan ledger
still claiming tasks were committed, and anyone reading `.superpowers/sdd/` found two plugins'
records interleaved with no owner marked on either.
**Supersedes:** The pinned upstream path in `executing-waves` — "single source of truth for
progress, at upstream's path `.superpowers/sdd/progress.md`" — and every restatement of it in
`/devcycle:cycle`'s state shape, `/devcycle:continue`, both short-path skills, and
`reviewing-the-branch`. Not retroactive: existing `.superpowers/sdd/progress.md` files are
records of past runs and are kept where they are, per this log's own rule about historical
artifacts. Breaking for a cycle in flight at the upgrade — see the release note below.

## 2026-07-26 — evidence lives in files; reports name paths, not transcripts

**Decision:** Verification output is written to `.devcycle/evidence/<task-id>-before.txt` and
`-after.txt` (`<task-id>` = the plan's task number, or `fast` / `sweep` on the short paths).
The implementer report names those paths with their exit statuses and quotes only a tail of
the "after" output, `<N>` lines sized by the profile (10 / 20 / 50) and pinned per dispatch in
the brief as `**Evidence tail:** <N>`. The task reviewer reads the named files directly rather
than trusting the tail, and rejects when a named file is missing or empty, when an exit status
contradicts the declared class (a `red-green` "before" that exited 0, a `green-green` "before"
that did not exit 0), or when the class mismatches the diff. On the sweep path, where no
implementer exists, the coordinator writes the two files itself.
**Why:** The coordinator's green gate re-runs the task's command and reads the exit status, so
the coordinator already holds ground truth — the inlined copy duplicated it at the price of a
whole suite's output per task per review round, carried through the implementer's report, the
reviewer's dispatch prompt, and the coordinator's own context.
**Supersedes:** The 2026-07-25 "per-task evidence classes replace unconditional red→green"
entry, in the one respect that each class's proof must be carried as verbatim output inside
the report — `red-green` as "verbatim failing-then-passing test output", `green-green` as "the
same suite command verbatim green before and after". That entry's substance is untouched and
still governs: planning picks the class, the implementer works to it, the reviewer rejects
reports lacking the evidence their class requires. What it got wrong is where the proof lives,
and the mistake was not only cost. Making the reviewer's rejection rule depend on text the
report copies in let a report be internally consistent and still wrong about the run it
describes; reading the files and their exit statuses checks the artifact instead of the claim,
which is strictly stronger than what it replaces.

## 2026-07-26 — the branch-review loop is bounded, with both terminal states named

**Decision:** `reviewing-the-branch`'s findings loop gains a termination contract. The round
cap comes from the profile (2 / 3 / 5), with one `review-round` ledger event per round. Round 1
reviews the whole branch; rounds 2..N review the fix diff plus a re-check of the specific
findings the previous round raised, not a fresh whole-branch pass. Only blocking findings
re-open the loop; non-blocking findings are recorded as carry-overs when first raised and never
consume a round. At the cap there are exactly two terminal states: no blocking findings
outstanding → verdict `pass` with the residue listed as carry-overs; blocking findings
outstanding → verdict `fixes-required`, the stage stops and reports for a user decision,
keeping `stage: branch-review` in the state file and emitting its handoff block for the stop.
**Why:** The loop said "loop until a review returns no blocking findings" with no bound, no
narrowing between rounds, and no defined outcome for a loop that does not converge — so
non-convergence had no representation in the system at all and could only be ended by hand.
This repo's own previous cycle is the evidence: `.superpowers/sdd/progress.md:282` records
`outcome=STOP-loop-user-directed-close-round14-findings-accepted-as-carry-overs` — fourteen
rounds and thirteen fix commits, terminated by a human because the skill had no way to stop
itself.
**Supersedes:** The unbounded findings loop in `reviewing-the-branch`. Its rule "never
downgrade a finding to close the loop faster" is kept verbatim in force and extended to the cap
itself: reaching the cap NEVER converts an outstanding blocking finding into a pass, and no
finding is downgraded in severity to reach it. A cap that could launder a blocking finding into
a pass would make every `pass` from this gate unreadable — the bound limits effort, never
truth, and that guardrail is unconditional at every profile.

## 2026-07-26 — branch discipline belongs to every committing path

**Decision:** Branch discipline is stated once, in `references/branch.md`, and invoked by
every path that commits: `executing-waves`' pre-flight before wave 1, step 1 of both short-path
skills, and `/devcycle:continue` on resume. The rule: before any stage that commits, if the
checkout is on the repo's default branch or on an integration branch — `dev`, `develop`,
`integration`, or one the user names — create a topic branch and record it on the `branch:`
line of `.devcycle/state.md`; never commit cycle work directly to either.
**Why:** The full pipeline had no rule of its own — it delegated to upstream
`subagent-driven-development`'s never-start-on-main rule, which covers `main` and `master`
only. A cycle started on `dev` therefore had the coordinator committing every accepted task
straight onto the integration branch, wave after wave, with nothing in the pipeline objecting.
The gap ran backwards: the two paths with the least ceremony already forbade exactly that. And
under the native engines above, upstream is not loaded at `lean` or `standard` at all, so
delegation would have left the full pipeline with no rule whatsoever.
**Supersedes:** `executing-waves`' reliance on upstream's rule, and the framing of the two
2026-07-25 short-path entries — "triage gains a size axis; trivial requests take a fast path"
and "sweep routing wired in at both levels" — both of which counted topic-branch discipline
among the guardrails the short path *keeps* relative to the full pipeline. That framing was
the reason the gap survived review: listing branch discipline as something the short paths
preserve implies the full pipeline is where it came from, when in fact the short paths were
the only place it was written down. It is not theirs to keep; it belongs to every committing
path, and those two entries' guardrail lists should be read with that correction.

## 2026-07-26 — triage confirms every verdict, not just the short-path one

**Decision:** Triage judges maturity, kind and size as before, then puts all of them to the
user in ONE AskUserQuestion **before any stage runs**: the entry stage the maturity verdict
picked and why, the kind verdict, and the size verdict when one fired. The options are confirm;
start at scoping instead; take the offered short path (`fast-path`, `sweep`, or the new
audit-in-place-of-scoping route); or run the full pipeline. Net question count is unchanged —
this replaces the size-only question rather than adding to it — and it is not
profile-conditional: a `lean` run asks it too.
**Why:** The maturity verdict decides whether the scoping interview happens at all, which is
the highest-blast-radius call triage makes, and it was announced rather than asked. A request
that merely read as well-specified went straight past the interview, and the user's only
recourse was to notice the announcement mid-stream and object. Meanwhile the lowest-stakes
verdict already had a confirm gate. Asking about all three costs one question and puts the
consequential judgment where the never-assume rule already says judgments of this size belong.
**Supersedes:** The confirmation rule of the 2026-07-25 "triage gains a size axis" entry —
"the verdict never auto-fires: triage announces it and asks" — which was scoped to the size
verdict alone, and the 2026-07-25 "triage gains a kind axis" entry, under which triage judged
maturity and kind and merely "announced all verdicts with the entry stage before proceeding".
Both entries treated announcement as sufficient for maturity and kind while treating
confirmation as necessary for the short path; the ranking was backwards, since choosing the
short path is recoverable (the escalation valve exists) while a skipped scoping interview is
only discovered later, in a spec built on assumptions nobody stated.

## 2026-07-26 — release note: these are breaking, nothing was in flight, and the release is `0.8.0`

Three of the entries above break a cycle that is in flight across the upgrade: the ledger move
(a running cycle's ledger path changes underneath it), the file-backed evidence and report
shape (an in-flight wave's implementer reports no longer carry what the reviewer now demands),
and the change in what an unset knob resolves to (a run relying on a documented default now
takes the profile's column value — for the execution engine, a different engine). No cycle was
in flight: the only run in progress was this one, which introduced them. Nothing is migrated
and nothing is rewritten backwards; artifacts of past runs stay where they are.

The release is **`0.8.0`, not `1.0.0`, by explicit choice.** devcycle is pre-1.0 with no
external consumer pinned to the 0.7.0 shapes, and 0.x minor bumps are exactly where breaking
rearrangement is meant to happen; spending the 1.0 signal on an internal restructure would say
something about stability that is not yet true.

The consequence, recorded here so it is not later "fixed": **this cycle's commit subjects
deliberately carry no `!` marker and no body carries a `BREAKING CHANGE:` trailer.**
`scripts/bump-version.mjs` reads Conventional Commit subjects since the last tag and computes
`major` — `0.7.0` → `1.0.0` — from either marker; without them a `feat` subject computes the
intended `0.8.0`. The PR title is likewise `feat(devcycle): compact, profile-driven pipeline
with an audit skill`, with no `!`. The absent marker is a statement about the version number,
not an oversight about the breakage; the breakage itself is recorded in this log, and in the
commit subjects the release turns into the changelog. Nothing is hand-written into
`CHANGELOG.md` for this cycle, deliberately: `scripts/bump-version.mjs` collects the
Conventional Commit subjects since the last tag and prepends them as that release's section
at bump time. The subjects ARE the entry, which is the second reason they all have to parse
as Conventional Commits — a hand-written entry here would not be a record the tooling honors,
it would be a duplicate sitting above the generated one saying the same thing.

## 2026-07-25 — sweep routing wired in at both levels

Triage gains a bulk-mechanical Size verdict (gate 1: sweep path vs. full
pipeline), backed by the new `sweeping-mechanical-changes` skill — parameter
derivation, a blast-radius confirm gate (gate 2), one
`workflows/mechanical-sweep.js` run, one commit, one task-reviewer pass, then
the normal finish stage. Plans may mark a task `**Execution:** sweep` (all
three sweep parameters pinned in the task body) and executing-waves runs it
through the same workflow instead of an implementer dispatch, keeping the
per-task review cycle and green gate. This supersedes the 2026-07-23 entry
demoting `mechanical-sweep.js` to a manual utility: the script's contract is
unchanged, but the pipeline now invokes it — routing is judged by triage or
planning and always user-confirmed, never automatic.

## 2026-07-25 — triage gains a size axis; trivial requests take a fast path

**Decision:** `/devcycle:cycle` triage makes a third judgment alongside maturity and kind:
size. A request counts as **trivial** only when every criterion of a conjunctive checklist
holds — fully specified by the request itself, nothing left to design; no design decisions
and no new interfaces; blast radius ≤ ~2 files / a few lines; the evidence class
(`red-green` | `green-green` | `convention`) already determinable from the request; and,
for a bug, a root cause already evident (an undiagnosed bug is never trivial). Any doubt
on any criterion → not trivial. The verdict never auto-fires: triage announces it and asks
(fast path vs. full pipeline). Confirmed → the state file is rewritten with
`stage: fast-path` and the new `devcycle:fast-path` skill runs a mini-cycle that keeps all
four guardrails — the state file and handoff blocks, evidence classes, the `gitPolicy`
clamps, and topic-branch discipline. The mini-cycle itself is short: implement in-session
with verbatim before/after evidence, commit, one `task-reviewer` pass, then the normal
finish stage — with an escalation valve back into the full pipeline the moment the change
stops looking trivial.
Declined → the verdict is discarded, the normal walk proceeds, nothing extra recorded.
**Why:** Every input walked the full pipeline, so a typo or a rename cost a scoping
interview, a spec, a plan, a wave dispatch, and a whole-branch review — enough overhead
that the practical workaround was to fix such things out of band, by hand, outside
devcycle. That workaround lost every guardrail at once: no state file or handoff trail, no
evidence class, no `gitPolicy` clamp, no topic-branch discipline — and no review either. A
size axis keeps the small change inside the system and pays only for the parts that still
earn their keep at that size.
**Supersedes:** The two-axis (maturity + kind) triage recorded in the 2026-07-25
"triage gains a kind axis" entry below — this extends that triage with a third axis; the
kind axis and the diagnosis stage it introduced are unchanged.

## 2026-07-25 — per-task evidence classes replace unconditional red→green

**Decision:** Every plan task declares an `**Evidence:**` class — `red-green` (new or
changed behavior; verbatim failing-then-passing test output), `green-green`
(behavior-preserving; the same suite command verbatim green before and after the change),
or `convention` (non-code tasks and repos without a suite; the repo's own documented
verification convention with before/after output). Planning picks the class; the
implementer works to it; the task reviewer rejects reports lacking the evidence their
class requires — including a `green-green` claim on a diff that adds behavior.
**Why:** The reviewer's old rule — reject any report lacking red→green evidence, its only
carve-out keyed to the repo having no test suite — was unsatisfiable for
behavior-preserving refactors and docs tasks in tested repos: no honest red state exists
there, so the rule forced either rejecting correct work forever or manufacturing a fake
red (break the code, watch tests fail, restore it). The coordinator's green gate is
unaffected: it re-runs the task's command either way.
**Supersedes:** The unconditional red→green requirement in `agents/task-reviewer.md` and
`agents/implementer.md`, and planning-waves' unconditional test-first step ordering.

## 2026-07-25 — triage gains a kind axis; bugs get a diagnosis stage

**Decision:** `/devcycle:cycle` triage judges the input on two axes: maturity (as before,
picking the entry stage) and kind (feature | bug | refactor). For bugs whose root cause is
not yet established with evidence, a **diagnosis** stage — upstream
`superpowers:systematic-debugging`, unmodified — runs between scoping and brainstorm,
ending in a root-cause report at `.devcycle/diagnosis.md` (new state-file line
`diagnosis:`; new stage enum value). Scoping interviews bugs for symptom and reproduction
instead of design intent.
**Why:** Triage previously sorted by maturity only, and no stage of the pipeline
referenced debugging at all. A vague bug report went straight from a design-intent
interview into `superpowers:brainstorming` — designing a fix for an undiagnosed problem —
and planning's feasibility gate had no established cause to validate the plan against.
The user's answer to "what should happen" is trivially "it should work"; the real unknown
is the cause, which only diagnosis can settle.
**Supersedes:** The maturity-only triage in `/devcycle:cycle` and scoping-interview's
single unconditional handoff to `superpowers:brainstorming`.

## 2026-07-25 — `auto` model derivation names capability tiers, not model ids

**Decision:** The `auto` derivation paths resolve to one of two tiers: **session tier**
(dispatch with no model override — the subagent inherits the coordinator session's own
model, the strongest the user has already sanctioned) and **fast tier** (the newest
fast/small Claude model available, currently the Sonnet-class generation; when in doubt,
fall back to the session tier). The derivation predicates (task size, dependency count,
diff size) are unchanged; only what they select changed. Explicit configured ids stay
binding. The panel's `DEVCYCLE_PANEL_MODEL` export is now sent only for explicit ids;
session-tier runs omit it and take the CLI's configured default.
**Why:** The 2026-07-23 `auto` decision removed rotting ids from *config defaults* but
left them in the derivation prose — `claude-sonnet-5` vs `claude-opus-4-8` predicates,
and a branch-review chain of "first available of claude-opus-4-8, then claude-sonnet-5"
(with no defined way to probe availability). Newer model generations shipped and the
skills would never select them; the same rot the decision named had just moved.
**Supersedes:** The hardcoded model ids in `executing-waves` Model routing,
`reviewing-the-branch`'s derived-model chain and unconditional `DEVCYCLE_PANEL_MODEL`
export, and `verifying-on-device`'s fixed walkthrough model id.

## 2026-07-25 — finish stage extracted into the finishing-the-cycle skill

**Decision:** The finish stage's logic — configured-policy resolution, the two-signal
effective-policy clamp, acting on the policy, the `Git policy:` handoff line, the
`stage: done` close — lives once, in the new `devcycle:finishing-the-cycle` skill. Both
`/devcycle:cycle` and `/devcycle:continue` invoke it, like every other stage runs
through its skill. In the same consolidation pass: the knob-resolution convention
(literal placeholder = unset, out-of-range = invalid, both → documented default) is
stated canonically in `/devcycle:cycle`'s Configuration section, and the
graphify-first/index-then-fetch repo-research procedure is stated canonically in
scoping-interview, with planning-waves referencing it and adding only its own relevance
filter.
**Why:** The finish logic was duplicated nearly verbatim (~40 lines) across both
commands — the original rationale, "read here because this session may never load
`/devcycle:cycle`", is exactly the argument for a skill both can invoke. Hand-synced
copies drift; the 2026-07-23 clamp decision already had to be applied twice.
**Supersedes:** The inline finish-stage prose in `/devcycle:cycle` Step 7 and
`/devcycle:continue`, and the near-identical research-procedure copies in
scoping-interview and planning-waves.

## 2026-07-25 — the state file self-identifies: root + request lines, verified by every reader

**Decision:** `.devcycle/state.md` carries two identity lines — `root:` (the absolute
repo toplevel the cycle belongs to) and `request:` (one line naming the cycle's goal).
The file is only ever read or written at `<git rev-parse --show-toplevel>/.devcycle/state.md`
— never a state file discovered anywhere else — and every reader (`/devcycle:cycle`
Step 0, `/devcycle:continue`, scoping-interview's backstop) verifies `root:` against its
own toplevel before trusting anything else in the file. On a mismatch: stop and report
(the user chooses adopt-after-move or leave it); never resume or silently reset a
foreign state file. `/devcycle:continue` announces the recorded `request:` so a
wrong-project state is spotted instantly. Files without `root:` predate the format and
are adopted at the next rewrite.
**Why:** A real incident: another repo's state file was picked up and resumed, driving
a cycle with the wrong project's stage and artifacts. The state file recorded a branch
but nothing that bound it to a repository or a goal, so nothing forced the mismatch to
surface.
**Supersedes:** The previous state-file shape (no identity lines) and readers that
trusted whatever `.devcycle/state.md` they found.

## 2026-07-23 — finish stage resolves gitPolicy against external push signals

**Decision:** Before acting on `push-allowed`/`open-pr`, the finish stage
(`/devcycle:cycle` Step 7 and `/devcycle:continue`'s mirrored section) resolves an
**effective** git policy: if a Claude Code permission `deny` rule matches `git push`, or
the cycle's branch is the repo's release/default branch, the effective policy clamps to
`local-commits-only` for that run regardless of the configured value. The finish stage's
Handoff block always states the effective policy, naming the configured value and reason
when they differ. `local-commits-only` needs no check — it was already the floor.
**Why:** `gitPolicy` was evaluated in isolation from anything outside devcycle's own
config. Two gaps followed directly: a Claude Code permission deny on `git push` would
only surface as a failed tool call mid-finish rather than a clean downgrade, and nothing
stopped `push-allowed` from pushing straight to the repo's default branch if a cycle
happened to start there — violating the user's own "never push a release branch
directly" rule with no devcycle-side guard.
**Supersedes:** Nothing reversed — this adds a resolution step in front of the existing
`gitPolicy` branch in `/devcycle:cycle` Step 7 and `/devcycle:continue`.

## 2026-07-23 — superpowers dependency re-pinned to the official plugin directory

**Decision:** `plugin.json` declares `{ "name": "superpowers", "marketplace":
"claude-plugins-official" }` (with `allowCrossMarketplaceDependenciesOn:
["claude-plugins-official"]` in `marketplace.json`) instead of pinning obra's
`superpowers-marketplace`.
**Why:** superpowers is published in both marketplaces, but dependency satisfaction is
keyed on `name@marketplace`, not name — a user whose superpowers came from the official
directory left devcycle disabled with `dependency-unsatisfied` even though the plugin was
installed and enabled (reproduced in an isolated config). The official directory is
configured by default in every Claude Code install, so pinning it makes auto-install work
with zero marketplace setup; the schema has no "either marketplace" form, and a bare name
resolves inside the declaring plugin's own marketplace (fails). Known side effect: users
who installed superpowers from obra's marketplace get a second copy auto-installed —
both load; the README's Troubleshooting section covers deduping.
**Supersedes:** The `superpowers-marketplace` dependency pin shipped through v0.3.0 (from
the founding spec and v1 plan), and `docs/platform-notes.md`'s consequence note that
users must have `obra/superpowers-marketplace` configured for auto-resolution.

## 2026-07-23 — superpowers install: linked, not documented

**Decision:** The README links the [superpowers](https://github.com/obra/superpowers) repo
and tells users to install it per its own instructions; devcycle's docs never spell out
superpowers' install mechanics (marketplace-add command included).
**Why:** Another project's install commands may change; duplicating them here would rot
silently. The README instead names the expected symptom (devcycle shows "failed to load"
until superpowers is present) so the intermediate state reads as normal, not broken.
**Supersedes:** `docs/platform-notes.md` §(d)'s recommendation that the README tell users
to add the superpowers marketplace first, and `docs/dry-run-report.md` rough edge #1
("the README should carry step 3").

## 2026-07-23 — model options default to `auto`; an explicit id is binding

**Decision:** All four model options (`implementerModel`, `taskReviewerModel`,
`branchReviewModel`, `walkthroughModel`) default to `auto`: the coordinator derives the
model per task from plan-observable attributes and logs each derivation in the ledger. An
explicitly configured model id is binding — used verbatim, never overridden or
"improved on".
**Why:** Fixed default model ids rot as models change, and a "provisional lineup, propose
rerouting" rule was unenforceable prose. Derivation from observable predicates is
checkable after the fact; binding explicit ids keep the user's word final.
**Supersedes:** The fixed per-role default model ids shipped through v0.3.0, and the
skills' former deference to upstream's model-selection guidance for defaults.

## 2026-07-23 — first-run config walkthrough

**Decision:** When `/devcycle:cycle` starts with nothing configured, it offers one batched
walkthrough of the four behavioral options (`gitPolicy`, `reviewDepth`,
`crossModelReview`, `onDeviceGate`) with recommended defaults and a first-class "use
defaults, don't ask again" answer; choices are applied via `--config` so the offer
self-extinguishes. Model options are excluded (they default to `auto`).
**Why:** The literal-`${user_config.KEY}`-means-unset behavior is correct but invisible;
a one-time offer surfaces the knobs exactly once without making configuration a
prerequisite.
**Supersedes:** Nothing reversed — the silent documented-defaults path remains; this adds
the one-time offer in front of it.

## 2026-07-23 — red-team-reviewer wired into the panel; mechanical-sweep demoted to manual

**Decision:** The `red-team-reviewer` agent's adversarial charter is spliced into
`review-panel.js`'s per-finding verification pass, making the panel's "adversarially
re-verified" claim structurally true. `mechanical-sweep.js` is documented as a manual
utility — no pipeline stage invokes it.
**Why:** Both components were orphans: defined and documented as used, dispatched by
nothing. One earned its documented role by being wired in; the other's docs now match
reality instead of promising an integration that doesn't exist.
**Supersedes:** The README/DESIGN claim that `red-team-reviewer` is "used by execution and
the panel" (it is used by the panel only, and via charter splice rather than agent
dispatch) and any reading of `mechanical-sweep.js` as a pipeline component.
(The demotion half of this entry is superseded by the 2026-07-25 sweep-routing entry.)

## 2026-07-22 — README: comprehension outranks brevity

**Decision:** The README is written for comprehension first — a reader should understand
what each stage and option actually does without opening other files — even where that
costs length.
**Why:** The pre-rewrite README was compact but assumed the pipeline's internal
vocabulary; evaluating the plugin required reading DESIGN.md and skill sources.
**Supersedes:** The earlier brevity-first README style (rewritten in v0.3.0, "docs:
rewrite README for comprehension").
