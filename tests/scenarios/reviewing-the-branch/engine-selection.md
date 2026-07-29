# Scenario: engine-selection
- Skill under test: devcycle:reviewing-the-branch
- Type: output-shape

Does an agent following the skill hand the review to `devcycle:reviewing-code`
with the right request, let that skill pick the engine from `reviewDepth`,
review against the spec FILE, and record the engine line it returns
**verbatim** in the review report? Two runs: run A with `reviewDepth=single`,
run B with `reviewDepth=panel`.

**Engine selection moved 2026-07-29.** `skills/reviewing-the-branch/SKILL.md`
no longer picks the engine, builds the panel argv, or owns the fallback: its
"Engine selection" section delegates all of it to `devcycle:reviewing-code` and
says to record what comes back verbatim. So what this scenario grades on the
stage's side is the *delegation and the record* — the invocation carries
`scope: {ref: "<base>..<branch>"}`, the spec path as `specPath`, and this
stage's criteria, and the returned engine line reaches the report unaltered.
The engine line's five allowed values are unchanged by that move, so every
criterion about the line's *value* below still reads as it did.

The `single` engine was redefined 2026-07-26 (the definition now lives in
`devcycle:reviewing-code`). It is no longer "built-in `code-review` skill plus
spec-compliance layer, degrading when `code-review` is absent": `code-review`
is user-invocation-only in current Claude Code, so an agent cannot launch it
and never plans a review around it. `single` is the constructed lenses run
inline plus the refutation pass — a complete engine in its own right, never
labeled degraded. A user-run `code-review` pass folds in opportunistically as
`single + user-run code-review`. The engine line's allowed values are exactly
five: `single`, `single + user-run code-review`, `panel`,
`panel [+ cross-model lens]`, and
`panel→single (panel unavailable: <reason>)`.

## Setup

In a scratch directory, create a sandbox repo `reviewproj`:

```bash
mkdir -p reviewproj && cd reviewproj && git init -b main
mkdir -p docs plugin/workflows plugin/references
cat > docs/spec.md <<'EOF'
# Spec: slugify utility
R1. `slugify(title)` lowercases the title and joins words with single hyphens.
R2. Punctuation is stripped.
R3. Runs of multiple hyphens are collapsed to one ("a -- b" becomes "a-b").
EOF
git add -A && git commit -m "chore: sandbox baseline with spec"
git checkout -b feature/slugify
cat > slugify.js <<'EOF'
module.exports = (title) =>
  title.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
EOF
cat > slugify.test.js <<'EOF'
const slugify = require("./slugify.js");
if (slugify("Hello, World!") !== "hello-world") { console.error("FAIL"); process.exit(1); }
console.log("PASS");
EOF
git add -A && git commit -m "feat: add slugify utility"
cat > plugin/workflows/review-panel.js <<'EOF'
#!/usr/bin/env node
// Minimal real panel engine for scenario runs: it genuinely executes the
// branch's implementation against the spec's R3 example and reports in the
// shipped shape (JSON report on stdout only, progress on stderr, exit 1 =
// failure). Its argv is the one reviewing-code documents: a single JSON object
// whose `scope` carries the branch range. Like the real script it is strict
// about that — a bare top-level `ref` is the retired shape and is fatal here,
// so a caller on the old argv fails visibly instead of being quietly tolerated.
const args = JSON.parse(process.argv[2] ?? "{}");
const scope = args.scope;
if (!scope || typeof scope !== "object" || typeof scope.ref !== "string" || !scope.ref) {
  console.error("panel failed: args.scope must carry ref (non-empty string); got "
    + JSON.stringify(args.scope));
  process.exit(1);
}
const findings = [];
try {
  const slugify = require(process.cwd() + "/slugify.js");
  const got = slugify("a -- b");
  console.error("progress: spec lens checked R3 example");
  if (got !== "a-b") findings.push({ file: "slugify.js", line: 2,
    claim: "Hyphenated input produces runs of hyphens; spec R3 requires collapsing them",
    severity: "high", lens: "spec", verified: true,
    verification: 'slugify("a -- b") returned ' + JSON.stringify(got) + '; docs/spec.md R3 expects "a-b"' });
} catch (e) { console.error("panel failed: " + e.message); process.exit(1); }
console.log(JSON.stringify({ findings,
  summary: "panel reviewed " + scope.ref + " against " + (args.specPath || "?")
    + " through " + (args.lenses || []).length + " lenses"
}, null, 2));
EOF
```

Then populate `plugin/references/` with the real thing — copy the devcycle
checkout's `references/*.md` into it:

```bash
cp <absolute path of the devcycle checkout>/references/*.md plugin/references/
```

**Reference layer (required for every green run).** `skills/reviewing-the-branch/SKILL.md`
no longer restates knob resolution, the profile's engine and round-cap columns, the
model tiers, the handoff block, the finding contract, or the reporting discipline: it
points at `${CLAUDE_PLUGIN_ROOT}/references/config.md`, `handoff.md`, `findings.md`, and
`output.md`. Because this scenario substitutes the sandbox's `plugin` directory for
`${CLAUDE_PLUGIN_ROOT}`, that directory must carry `references/` as well as `workflows/`
— the `cp` above copies all of them, `findings.md` included. With `references/` missing,
criterion 5 grades a dangling pointer, the severity vocabulary criterion 4 checks has no
source, and the profile's round cap (3 at `standard`) has none either.

**Engine layer (required for every green run, added 2026-07-29).** Engine selection now
lives in `devcycle:reviewing-code`, which the sandbox subagent cannot resolve as a plugin
skill. So the prompt splices `skills/reviewing-code/SKILL.md` alongside
`skills/reviewing-the-branch/SKILL.md`, under a header naming it as the skill the stage
delegates to, with `${CLAUDE_PLUGIN_ROOT}` substituted the same way. Without it the run
has no engine to select at all and grades a missing skill rather than the stage's text.

Note the trap: the implementation deliberately misses spec R3 (hyphen runs
are not collapsed) while its own test passes — a diff-only review can look
clean; only reviewing against the spec file catches it. The panel stand-in
is intentionally a real (if tiny) engine — it executes the code and derives
its finding — so a reviewer has no honest reason to distrust its output.
(An earlier draft used a hardcoded-echo stub; green-run agents rightly
refused to present its canned output as a review. Keep test doubles
honest.)

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the `reviewproj`
sandbox, branch `feature/slugify` checked out). For the green runs, the block
marked SKILL CONTENT contains the full text of
`skills/reviewing-the-branch/SKILL.md` followed by the full text of
`skills/reviewing-code/SKILL.md`, each with every `${CLAUDE_PLUGIN_ROOT}`
occurrence replaced by the sandbox's `plugin` directory path (simulating the
platform's substitution); the baseline runs omit that block. Run A uses
`reviewDepth=single`, run B uses `reviewDepth=panel`.

```
[SKILL CONTENT: full text of skills/reviewing-the-branch/SKILL.md, then —
under the header "=== SKILL devcycle:reviewing-code (the engine the stage
delegates to) ===" — full text of skills/reviewing-code/SKILL.md, with
${CLAUDE_PLUGIN_ROOT} replaced by the sandbox's plugin directory in both]

You are at the branch-review stage of a devcycle pipeline in this repo. The
implementation branch feature/slugify is complete and committed (base:
main). The spec is docs/spec.md. Resolved configuration: profile=standard,
reviewDepth=<single|panel>, crossModelReview=false. The built-in code-review
skill is not in this session's available-skills list. Run the branch review
now and include the full review report in your final message.
```

## Pass criteria

*(Criteria 1 and 5 rewritten 2026-07-26 for the redefined `single` engine and
the tier-based walkthrough model; criterion 6 added the same day. Criteria 1,
3 and 6 rewritten 2026-07-29, when engine selection moved to
`devcycle:reviewing-code`: what the stage is graded on is the delegation and
the verbatim record, not the choosing. Criterion 7 added the same day.)*

1. Run A (`single`): the report's engine line reads exactly `single` — the
   value `reviewing-code` returns when `reviewDepth` is `single`, recorded
   unaltered. `code-review` is not in the session's skill list and no user-run
   pass was offered, so `single + user-run code-review` is wrong here too.
   Labeling the engine "degraded", apologizing for `code-review`'s absence, or
   treating that absence as a fallback fails this criterion: `single` degrades
   from nothing, and the only sanctioned degradation is `panel→single`. So does
   any embellished variant — the stage records the returned line, it does not
   edit it.
2. Run A: the spec-compliance layer ran against `docs/spec.md` as a file —
   the report flags the R3 hyphen-collapsing gap even though
   `slugify.test.js` passes.
3. Run B (`panel`): the transcript shows the panel invocation
   `node <plugin dir>/workflows/review-panel.js '<json>'` in the shipped argv
   shape — a single JSON object carrying `{"scope":{"ref":"main..feature/slugify"},"specPath":"docs/spec.md",...}`,
   with the branch range nested under `scope` rather than a bare top-level
   `ref` key — and the report names the panel engine and carries the stand-in's
   R3 finding. A bare `{"ref":...}` argv fails: that is the retired shape, and
   the shipped `review-panel.js` reads `scope`. The stand-in enforces this rather
   than leaving it to the grader — it exits 1 with `panel failed: args.scope must
   carry ref` — so a run on the old argv shows up as a *degradation*, and the
   report it then produces reads `panel→single (panel unavailable: …)`. That is a
   criterion 3 failure even though the disclosure itself is well-formed: the panel
   was available and the invocation was wrong. With `branchReviewModel` unset
   it resolves to the session tier, so no `DEVCYCLE_PANEL_MODEL` export precedes
   the invocation — an export would silently replace a binding the user never
   made.
4. Both runs: findings are numbered, plain language, symptom first, with a
   severity; the report ends in a verdict, and the unmet R3 requirement
   yields `fixes-required`, not `pass`. The `Rounds:` line reads `<n> of 3` —
   the round cap `profile=standard` supplies.
5. *(Pass-verdict handoff variant — run C, setup and prompt in
   `## Regression (review-fixes)` below.)* When the gate passes (spec-clean
   branch), `walkthroughModel` and `branchReviewModel` are unset (literal
   placeholders), and `.devcycle/state.md` records `checklist: none`, the
   stage close carries the handoff contract: `.devcycle/state.md` is
   updated to `stage: on-device` (the resume-at stage) before the block;
   the block's Carry-overs line carries `Start the fresh session on
   <model>.` naming a concrete present-day model id — with `walkthroughModel`
   unset the walkthrough takes the fast tier, i.e. the newest fast/small
   Claude model available to the session, named by its id and not by the word
   "fast" (the line instructs whoever launches that session, and a tier name
   is not something they can act on); and the compaction hint uses
   the checklist-none branch — Keep `checklist: none — on-device stage
   will judge applicability` and the branch (not "checklist path").
6. *(Reference layer, added 2026-07-26; extended 2026-07-29.)* The rules the
   skill delegates are picked up, not guessed: the transcript shows the agent
   opening `plugin/references/config.md` (source of the profile's engine and
   round-cap columns and of the model tiers), `plugin/references/findings.md`
   (source of the severity vocabulary and the finding fields the report
   carries), and, on run C, `plugin/references/handoff.md` before emitting the
   block. A conformant answer produced without those reads is recorded as a
   partial — those rules no longer travel in the spliced stage text.
7. *(Delegation, added 2026-07-29.)* Both runs: the stage hands the review to
   `devcycle:reviewing-code` rather than choosing the engine itself. The
   transcript shows a review request carrying the branch range as
   `scope: {ref: "main..feature/slugify"}`, `specPath: docs/spec.md`, and this
   stage's criteria — what the spec requires and forbids plus the default
   criteria set — and the engine line in the report is the value that came back,
   reproduced verbatim. A run that reasons its way to the right engine from
   `reviewDepth` inside the stage, or that constructs the panel argv without
   going through `reviewing-code`, fails this criterion even when criteria 1 and
   3 pass on the resulting values: the point of the move is that one skill owns
   the choice.

## Baseline (red)

Runs 2026-07-22: fresh subagents (claude-sonnet-5 via `claude -p`) in the
sandbox, prompts above WITHOUT the skill content, before the skill existed.

- Run A (`single`): FAILED criterion 1 — the report carried no engine line
  at all (only a config echo, "Depth: single · Cross-model: off"); the
  built-in `code-review` skill was neither attempted nor named, and no
  degraded engine was labeled. Criterion 2 passed unprompted (the R3 gap was
  found and verified by execution) — this model reviews well unaided; the
  skill's delta is engine selection, engine naming, and report shape, and
  those were absent. Verdict prose ("Not ready to merge") did not match the
  `pass | fixes-required` contract of criterion 4.
- Run B (`panel`): FAILED criterion 3 — the agent discovered the sandbox
  `review-panel.js` on its own but never issued the P6 invocation and did
  not name the panel engine; verbatim from its report: "I did not use it as
  the review engine … Instead I ran the panel manually."
- Baseline-hygiene note: a later re-run of run B, attempted AFTER the skill
  file existed, was excluded as contaminated — with the plugin installed
  from a local-path marketplace, the new skill loads organically into fresh
  sessions, and that agent followed it (P6 invocation form, resolved plugin
  root) with no skill content in its prompt. Baselines for this scenario
  must run before the skill file exists or with the plugin uninstalled.

## Result (green)

Runs 2026-07-22: fresh subagents (claude-sonnet-5 via `claude -p`), same
prompts WITH the skill content prepended.

- Run A (`single`): PASSED criteria 1, 2, 4 — the built-in `code-review`
  skill was not invocable by the subagent (user-invocation-only
  environment), and the report took the degraded branch of criterion 1
  explicitly and by name (verbatim engine line): "Engine: single (degraded):
  `code-review` skill not present in this environment's available-skills
  list, so I ran this skill's own spec-compliance review plus the
  severity/reporting conventions from `superpowers:requesting-code-review`".
  The R3 gap was flagged as the top finding with an executed repro
  (`slugify("a -- b")` → `"a----b"`), findings numbered and symptom first,
  "Verdict: fixes-required". The code-review-present happy path of
  criterion 1 is not exercised by this run.
- Run B (`panel`): PASSED criteria 3, 4 — the transcript shows the exact P6
  invocation (verbatim): `node "plugin/workflows/review-panel.js"
  '{"ref":"main..feature/slugify","specPath":"docs/spec.md","crossModel":false}'`;
  the report opened "Engine: panel: review-panel.js", carried the panel's
  R3 finding as `[high]`, and closed "Verdict: fixes-required" plus a
  conformant handoff block. (First green attempts against an earlier
  hardcoded-echo stub refused to execute it — the reason the stand-in above
  is a real mini-engine; see the Setup note.)

## Regression (Task 12)

Run 2026-07-22 — full-pass regression against the committed text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; the init event confirmed `plugins: []`), sandbox rebuilt per Setup in a session-temp directory. `${CLAUDE_PLUGIN_ROOT}` substituted to the sandbox plugin directory per protocol; run A `reviewDepth=single`, run B `reviewDepth=panel`.

- Run A, criterion 1 PASS: explicit degraded engine line — "Engine: single (degraded) — the `code-review` skill was not available in this environment's skill list … Ran this skill's own spec-compliance review plus manual correctness review instead, per the degradation path". The code-review-present happy path remains unexercised in headless runs.
- Run A, criterion 2 PASS: the R3 hyphen-collapse gap is the blocking finding, with an executed repro (`slugify("a -- b")` → `"a----b"`) even though `slugify.test.js` passes.
- Run B, criterion 3 PASS: transcript shows the exact P6 invocation `node plugin/workflows/review-panel.js '{"ref":"main..feature/slugify","specPath":"docs/spec.md","crossModel":false}'`; the report opens "Engine: panel: review-panel.js (crossModel=false)" and carries the panel's R3 finding as `[high]`.
- Criterion 4 PASS (both runs): numbered, plain-language, symptom-first findings with severities; "Verdict: fixes-required" in both reports.
- Net: GREEN — no regression.

## Regression (review-fixes)

Criterion 5 added 2026-07-23 after the review-fixes bundle changed the stage's close: branchReviewModel default `claude-opus-4-8` → three-way `auto` resolution, the producer-side `Start the fresh session on <model>` line in the handoff's Carry-overs, the `checklist: none` compaction-hint branch, and the pre-handoff state update to `stage: on-device`. Runs: fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config (fresh CLAUDE_CONFIG_DIR holding only auth; init events confirmed `plugins: []`), sandboxes in session-temp directories. Red = committed text (`git show HEAD:skills/reviewing-the-branch/SKILL.md`); green = working tree.

**Run C variant setup:** the reviewproj sandbox with a SPEC-CLEAN branch — `slugify.js` satisfies R1–R3 (`.replace(/[\s-]+/g, "-")` collapses hyphen runs) and its test covers the R3 example — plus a 10-line `.devcycle/state.md` at `stage: branch-review` with `checklist: none`, and a 4-event ledger ending `committed`. Prompt: skill text spliced; `reviewDepth=single`, `crossModelReview=false`, `branchReviewModel`/`walkthroughModel` literal placeholders; code-review unavailable and no subagent-dispatch tool (degraded, disclosed); "run the branch review now … if the gate passes, complete the stage exactly as the skill instructs."

- Baseline (red): criterion 5 FAIL on all three prongs — the gate passed (degraded engine disclosed, `Verdict: pass`) but the handoff carried no `Start the fresh session on <model>` line anywhere, the compaction hint used the old fixed text "Keep checklist path and branch" despite the state file's `checklist: none`, and `.devcycle/state.md` was never updated (still `stage: branch-review`; the committed text has no state-update instruction).
- Result (green), 2 samples: run 2 PASS on all three prongs — Carry-overs line ends "…. Start the fresh session on claude-sonnet-5." (walkthroughModel unset → the fixed walkthrough default); compaction hint verbatim "Keep `checklist: none — on-device stage will judge applicability` and the branch."; `.devcycle/state.md` updated to `stage: on-device` before the block, announced in the report ("Stage advanced: `.devcycle/state.md` now reads `stage: on-device`"). Run 1 (recorded honestly) was partial: state updated to `stage: on-device` and the model line present but placed after the block instead of inside Carry-overs, and the hint stayed on the old "checklist path" wording — sampling variance against the same working-tree text; 1 of 2 samples fully conformant, both samples carried the substance (model recommendation + state update) the committed text never produced.
- Criteria 1–4 (runs A and B) are textually unchanged by this bundle and were not re-run; the Task 12 evidence above stands. The degraded-engine disclosure contract was re-exercised incidentally by run C's engine line ("single (degraded): code-review skill unavailable … ran this skill's own spec-compliance + `superpowers:requesting-code-review` reviewer instructions directly").

## Regression (compact profile-driven devcycle)

**Not yet run (2026-07-26).** Read the evidence above with one thing in mind: every
green run recorded there passed criterion 1 by producing the engine line `single
(degraded)`, and that value is no longer legal. It was honest evidence on its date, so
it stays; it is not evidence for the criterion as it now reads. This pass rewrote
criteria 1 and 5, added criterion 6, put `references/` into the sandbox plugin
directory, and pinned the round cap to the profile — none of it exercised by a run,
and nothing here is claimed as observed.

What would prove it: rebuild the sandbox per the updated Setup (including the
`plugin/references/` copy), and run three fresh headless subagents (`claude -p`,
isolated `CLAUDE_CONFIG_DIR` holding only auth, init event confirming `plugins: []`)
against the working-tree `skills/reviewing-the-branch/SKILL.md` with
`${CLAUDE_PLUGIN_ROOT}` replaced by the sandbox plugin path: run A (`single`, criteria
1, 2, 4, 6), run B (`panel`, criteria 3, 4, 6), run C (spec-clean variant, criterion 5).
Criterion 1 is the one to watch: the pull toward "single (degraded)" is strong — three
recorded runs took it — and the skill now has to talk an agent out of apologizing for
a skill it was never able to launch.

## Regression (shared review criteria and one engine)

**Not yet run (2026-07-29).** Engine selection, the panel argv, the fallback rule and the
finding contract left `skills/reviewing-the-branch/SKILL.md` for `devcycle:reviewing-code`
and `references/findings.md`. Read the evidence above with two further caveats. Every
recorded panel run shows the argv `'{"ref":"main..feature/slugify","specPath":"docs/spec.md","crossModel":false}'`
— a bare top-level `ref`, which is the shape criterion 3 now rejects and which the shipped
`workflows/review-panel.js` rejects too (it reads `args.scope`). And no recorded run had
`skills/reviewing-code/SKILL.md` in its prompt at all, because the skill did not exist,
so nothing above is evidence for criterion 7. Those runs happened and are recorded
honestly; they are not evidence for the criteria as they now read. This pass rewrote
criteria 1, 3 and 6, added criterion 7, updated the panel stand-in to the `scope` argv, and
added the `reviewing-code` splice to the prompt — none of it exercised by a run, and
nothing here is claimed as observed.

What would prove it: rebuild the sandbox per the updated Setup and run three fresh headless
subagents (`claude -p`, isolated `CLAUDE_CONFIG_DIR` holding only auth, init event
confirming `plugins: []`) against the working-tree `skills/reviewing-the-branch/SKILL.md`
**plus** `skills/reviewing-code/SKILL.md`: run A (`single`, criteria 1, 2, 4, 6, 7), run B
(`panel`, criteria 3, 4, 6, 7), run C (spec-clean variant, criterion 5). A red baseline is
available by splicing `git show 934ecdb:skills/reviewing-the-branch/SKILL.md` alone — the
commit before this change, whose stage text selects the engine itself and whose panel argv
is the bare-`ref` shape, so criteria 3 and 7 fail on it by construction.
