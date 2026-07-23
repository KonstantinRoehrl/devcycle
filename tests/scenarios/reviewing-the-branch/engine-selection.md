# Scenario: engine-selection
- Skill under test: devcycle:reviewing-the-branch
- Type: output-shape

Does an agent following the skill select the review engine that matches
`reviewDepth` — built-in `code-review` skill + spec-compliance layer for
`single`, `review-panel.js` for `panel` — review against the spec FILE, and
name the engine that actually ran in the review report? Two runs: run A with
`reviewDepth=single`, run B with `reviewDepth=panel`.

## Setup

In a scratch directory, create a sandbox repo `reviewproj`:

```bash
mkdir -p reviewproj && cd reviewproj && git init -b main
mkdir -p docs plugin/workflows
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
// Minimal real P6 panel engine for scenario runs: it genuinely executes the
// branch's implementation against the spec's R3 example and reports in P6
// shape (JSON report on stdout only, progress on stderr, exit 1 = failure).
const args = JSON.parse(process.argv[2] ?? "{}");
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
  summary: "panel reviewed " + (args.ref || "?") + " against " + (args.specPath || "?")
}, null, 2));
EOF
```

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
`skills/reviewing-the-branch/SKILL.md` with every `${CLAUDE_PLUGIN_ROOT}`
occurrence replaced by the sandbox's `plugin` directory path (simulating the
platform's substitution); the baseline runs omit that block. Run A uses
`reviewDepth=single`, run B uses `reviewDepth=panel`.

```
[SKILL CONTENT: full text of skills/reviewing-the-branch/SKILL.md,
${CLAUDE_PLUGIN_ROOT} replaced by the sandbox's plugin directory]

You are at the branch-review stage of a devcycle pipeline in this repo. The
implementation branch feature/slugify is complete and committed (base:
main). The spec is docs/spec.md. Resolved configuration:
reviewDepth=<single|panel>, crossModelReview=false. Run the branch review
now and include the full review report in your final message.
```

## Pass criteria

1. Run A (`single`): the report contains an explicit engine line naming the
   single engine — the built-in `code-review` skill plus the spec-compliance
   layer, or, if `code-review` could not be invoked in the environment, the
   degraded engine explicitly labeled as such (never an unnamed or implied
   engine).
2. Run A: the spec-compliance layer ran against `docs/spec.md` as a file —
   the report flags the R3 hyphen-collapsing gap even though
   `slugify.test.js` passes.
3. Run B (`panel`): the transcript shows the panel invocation
   `node <plugin dir>/workflows/review-panel.js '<json>'` with `ref` and
   `specPath` keys in the JSON argument, and the report names the panel
   engine and carries the stub's R3 finding.
4. Both runs: findings are numbered, plain language, symptom first, with a
   severity; the report ends in a verdict, and the unmet R3 requirement
   yields `fixes-required`, not `pass`.
5. *(Pass-verdict handoff variant — run C, setup and prompt in
   `## Regression (review-fixes)` below.)* When the gate passes (spec-clean
   branch), `walkthroughModel` and `branchReviewModel` are unset (literal
   placeholders), and `.devcycle/state.md` records `checklist: none`, the
   stage close carries the new handoff contract: `.devcycle/state.md` is
   updated to `stage: on-device` (the resume-at stage) before the block;
   the block's Carry-overs line carries `Start the fresh session on
   claude-sonnet-5` (walkthroughModel unset → the fixed walkthrough
   default, recommended producer-side because the on-device session's
   model is chosen by whoever launches it); and the compaction hint uses
   the checklist-none branch — Keep `checklist: none — on-device stage
   will judge applicability` and the branch (not "checklist path").

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
