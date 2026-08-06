// Golden path — structural, deterministic, node-only. This fixture asserts that the
// pipeline's artifacts and wiring hold together across every stage transition. It does NOT
// exercise model behaviour; nothing here proves a stage produces good output.
//
// Why a new file rather than an existing one: every other suite under tests/unit/ is scoped
// to one script (validate, doctor, redaction-check, ...), whereas these assertions cut
// across the whole surface — commands, playbooks, references, agents and workflows — and
// belong to no single script. Adding new scenario assertions here is the intended path:
// they go in this file rather than a parallel golden-path suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");

const stages = (read("commands/cycle.md").match(/stage:\s*<([a-z|-]+)>/)?.[1] ?? "").split("|").filter(Boolean);

test("the stage enum is non-empty and every stage is lowercase-kebab", () => {
  assert.ok(stages.length > 0, "no stage enum found in commands/cycle.md");
  for (const s of stages) assert.match(s, /^[a-z][a-z-]*$/);
});

test("continue's stage table covers every stage in the enum", () => {
  const table = read("commands/continue.md");
  for (const s of stages) assert.match(table, new RegExp(`\\b${s}\\b`), `continue.md does not handle stage "${s}"`);
});

test("every playbook path referenced anywhere in the surface resolves", () => {
  for (const dir of ["commands", "playbooks", "references", "agents"])
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith(".md")) continue;
      const text = read(`${dir}/${f}`);
      for (const [, target] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(playbooks\/[A-Za-z0-9._-]+\.md)/g))
        assert.ok(existsSync(join(root, target)), `${dir}/${f} references missing ${target}`);
    }
});

test("the state fixture round-trips through every stage", () => {
  const template = readFileSync(join(root, "tests/fixtures/golden-path/state.md"), "utf8");
  for (const s of stages) {
    const next = template.replace(/^- stage: .*$/m, `- stage: ${s}`);
    assert.match(next, /^- stage: /m);
    assert.match(next, /^- root: /m);
    assert.match(next, /^- branch: /m);
    assert.equal(next.match(/^- stage: /gm).length, 1, `stage line duplicated at ${s}`);
  }
});

test("the loop-status line format parses for all three statuses", () => {
  const shape = /^status: (resolved|exhausted-with-residue|exhausted-unresolved) rounds: \d+\/\d+ residue: (\d+|none) carried-to: \S+$/;
  assert.match("status: resolved rounds: 1/3 residue: none carried-to: none", shape);
  assert.match("status: exhausted-with-residue rounds: 3/3 residue: 4 carried-to: docs/audits/2026-08-06-disposition-register.md", shape);
  assert.match("status: exhausted-unresolved rounds: 2/2 residue: 1 carried-to: none", shape);
  assert.ok(read("references/loops.md").includes("exhausted-with-residue"), "references/loops.md must own the status vocabulary");
});

test("the ledger fixture's every line parses as a ledger event", () => {
  const shape = /^- \[\d{4}-\d{2}-\d{2}T[\d:]+Z\] task=\S+ event=\S+ outcome=.* ref=\S+$/;
  for (const line of readFileSync(join(root, "tests/fixtures/golden-path/ledger.md"), "utf8").split("\n"))
    if (line.startsWith("- [")) assert.match(line, shape);
});

test("scoping states the batched-questions contract", () => {
  assert.match(read("playbooks/scoping-the-request.md"), /batches of 1[–-]4/);
});

test("every bounded loop names a cap", () => {
  for (const f of ["executing-waves", "taking-the-fast-path", "sweeping-mechanical-changes", "learning-from-sessions"])
    assert.match(read(`playbooks/${f}.md`), /Cap: \d+/, `playbooks/${f}.md declares no cap`);
});

// The green-gate invariant: a `committed` ledger event must carry the gate's outcome, so a
// commit can never be recorded without the gate having been read.
test("a committed ledger event carries the green-gate outcome", () => {
  const ledger = readFileSync(join(root, "tests/fixtures/golden-path/ledger.md"), "utf8");
  for (const line of ledger.split("\n"))
    if (line.includes("event=committed")) assert.match(line, /outcome=green gate passed/);
  assert.match(read("playbooks/executing-waves.md"), /green gate/i);
});

// The no-direct-push invariant: no workflow may push to the release branch.
test("no workflow pushes to the release branch", () => {
  for (const f of readdirSync(join(root, ".github/workflows"))) {
    const text = read(`.github/workflows/${f}`);
    assert.doesNotMatch(text, /git push\s+\S*origin\s+main\b/, `${f} pushes main directly`);
    assert.doesNotMatch(text, /branch:\s*main\b/, `${f} targets main directly`);
  }
});

// ---------------------------------------------------------------------------
// Harvested scenario assertions.
//
// `tests/scenarios/` held 56 prose scenario files that no runner ever executed.
// Each test below carries the part of one scenario's pass criteria that a file
// read can settle, and is named after the scenario it replaces. What a scenario
// graded about a *running* agent — whether a question was well formed, whether a
// review found the real defect — needs a model in the loop and is not asserted
// here; `docs/audits/2026-08-06-disposition-register.md` records that deferral.
// ---------------------------------------------------------------------------

test("harvested: auditing-a-repo/branch-name-validation — names are validated, then bound and quoted", () => {
  const t = read("references/branch.md");
  assert.ok(t.includes('git check-ref-format --allow-onelevel "<name>"'), "no ref-format validation");
  assert.match(t, /reject any name containing `\$`, a backtick, a\s+quote, `;`, `&`, `\|`, `<`, `>`, or a newline/);
  assert.match(t, /reference them quoted — `"\$branch"`, `"\$base"`/);
  assert.match(t, /Never splice a raw name into\s+a command line\./);
});

test("harvested: auditing-a-repo/branch-scope-derivation — the merge base guards the diff and the scope expands past it", () => {
  assert.ok(read("references/branch.md").includes('base_sha=$(git merge-base "$base" "$branch")'), "no merge-base step");
  assert.match(read("references/branch.md"), /never falls\s+through to `git diff --name-only "\$branch"`/);
  assert.match(read("playbooks/reviewing-code.md"), /Expand to the feature dependency graph/);
  assert.match(read("playbooks/reviewing-code.md"), /until an iteration adds\s+nothing, and review that stabilized set/);
});

test("harvested: auditing-a-repo/criteria-interview — criteria are asked for in one batch, then a hard stop", () => {
  const t = read("playbooks/reviewing-code.md");
  assert.match(t, /Interview via AskUserQuestion, 1[–-]4 questions in one batch, concrete options plus Other/);
  assert.match(t, /a criteria set you derived from discovery\*\*, for the user to correct — never a blank menu/);
  assert.match(t, /the audit plan\*\*: which areas will be\s+covered, risk-ranked, and why — areas, never findings/);
  assert.match(t, /hard STOP/);
});

test("harvested: auditing-a-repo/finding-format — every contract field, value set and ordering is pinned", () => {
  const t = read("references/findings.md");
  for (const field of ["Title", "Severity", "Location(s)", "What's wrong", "Why it's wrong", "Confidence", "Measured against"])
    assert.ok(t.includes(`| ${field} |`), `core field missing: ${field}`);
  for (const field of ["Category", "Impact", "Complexity", "Impact if unaddressed", "How to verify/reproduce", "Suggested fix direction", "Effort estimate"])
    assert.ok(t.includes(field), `document-tier field missing: ${field}`);
  assert.match(t, /T-shirt size \(S \/ M \/ L \/ XL\)/);
  assert.match(t, /Severity \(desc\) → Impact \(desc\) →\s+Complexity \(asc\)/);
});

test("harvested: auditing-a-repo/frontier-reporting — the frontier is named file by file in the coverage statement", () => {
  const t = read("playbooks/reviewing-code.md");
  assert.ok(t.includes("name **every** file left at the frontier, with its reason, in the coverage statement"), "frontier rule absent");
  assert.match(t, /silent truncation must never read as completeness/);
});

test("harvested: commands/bulk-mechanical-triage — the sweep verdict has a checklist and two gates", () => {
  const t = read("commands/cycle.md");
  assert.match(t, /one uniform edit rule applied with no per-file judgment/);
  assert.match(t, /many affected files \(beyond fast-path scale\) discoverable by search, success\s+checkable by one command/);
  assert.match(t, /trivial beats bulk-mechanical/);
  assert.match(t, /For the sweep this is gate 1 of a\s+two-step confirm; the second gate is the concrete file list and verify command/);
});

test("harvested: commands/continue-depth — ownership is checked first, then depth, and a failed probe does not block", () => {
  const t = read("commands/continue.md");
  const ownership = t.indexOf("Run the ownership check");
  const depth = t.indexOf("Depth check first");
  assert.ok(ownership > -1, "no ownership check before the resume");
  assert.ok(depth > -1, "no depth check before the resume");
  assert.ok(ownership < depth, "depth is checked before ownership");
  assert.match(t, /If it reports `over-budget` or `hard-stop`, say so and STOP/);
  assert.match(t, /`\/clear` first, then\s+`\/devcycle:continue` again/);
  assert.match(t, /Resuming anyway is the user's explicit call, not yours/);
  assert.match(t, /an unmeasurable depth is not a deep one/);
});

test("harvested: commands/first-run-config — the walkthrough is one profile question that writes only the profile", () => {
  const t = read("references/config.md");
  assert.match(t, /ONE AskUserQuestion over `profile`/);
  for (const option of ["`standard` (recommended)", "`lean`", "`thorough`", "customize individual knobs"])
    assert.ok(t.includes(option), `walkthrough option missing: ${option}`);
  assert.ok(t.includes("claude plugin install devcycle@devcycle --config profile=<value>"), "the profile write command is not stated");
  assert.match(t, /write \*\*only\*\* the profile/);
  assert.match(t, /Model knobs are excluded either way/);
});

test("harvested: commands/git-policy-reconciliation — the clamp is narrated in one fixed handoff line", () => {
  const t = read("playbooks/finishing-the-cycle.md");
  assert.ok(t.includes("Git policy: <value> (no override)"), "unclamped policy line missing");
  assert.ok(t.includes("configured <value> → effective local-commits-only (<reason>)"), "clamped policy line missing");
  assert.match(t, /a\s+permission rule denies git push/);
  assert.match(t, /current branch is the repo's default branch/);
});

test("harvested: commands/profile-resolution — an explicit knob beats the profile and does not drag the rest", () => {
  const t = read("references/config.md");
  assert.match(t, /An explicitly configured value wins, verbatim/);
  assert.ok(t.includes("| branch review engine (`reviewDepth`) | `single` | `single` | `panel` |"), "engine row changed");
  assert.ok(t.includes("| branch-review round cap | 2 | 3 | 5 |"), "round-cap row changed");
  assert.match(t, /`profile` ∈ `lean \| standard \| thorough`, default `standard`/);
  assert.match(t, /· profile-asked/);
});

test("harvested: commands/state-file-resume — the state file's shape and ownership check are pinned", () => {
  const t = read("references/resume.md");
  const template = t.match(/```markdown\n# devcycle state\n([\s\S]*?)```/)?.[1] ?? "";
  const lines = template.trim().split("\n");
  assert.equal(lines.length, 13, "the state template is no longer 13 lines");
  for (const field of ["stage", "root", "branch", "request", "scope", "audit", "diagnosis", "spec", "plan", "ledger", "checklist", "configured", "updated"])
    assert.ok(lines.some((l) => l.startsWith(`- ${field}:`)), `state field missing: ${field}`);
  assert.ok(template.includes("- ledger: .devcycle/ledger.md"), "the ledger path is not pinned");
  assert.match(t, /The ownership check, run before trusting anything else in the file/);
  assert.match(t, /`stage:` names the stage the NEXT session resumes at, never the one just completed/);
});

test("harvested: commands/triage-confirmation — one confirmation covers all three verdicts before any stage", () => {
  const t = read("commands/cycle.md");
  assert.match(t, /confirm every verdict with the user in ONE\s+AskUserQuestion \*\*before any stage runs\*\*/);
  assert.match(t, /No verdict is ever acted on automatically/);
  assert.match(t, /Offer: \*\*confirm\*\* · \*\*start at scoping instead\*\*/);
  assert.match(t, /Declined → the verdict is discarded/);
});

test("harvested: commands/trivial-triage — the trivial verdict needs every condition", () => {
  const t = read("commands/cycle.md");
  assert.match(t, /no design decisions and no new interfaces/);
  assert.match(t, /a blast radius of roughly two files/);
  assert.match(t, /an evidence class already determinable/);
  assert.match(t, /Both need every criterion — any doubt disqualifies the verdict/);
});

test("harvested: delegation/boundary-stop — the context action has three values and the block is not permission to run on", () => {
  const t = read("references/handoff.md");
  assert.ok(t.includes("`Continue`, `Clear + /devcycle:continue`, `Fresh session`"), "the action enum changed");
  assert.doesNotMatch(t, /Compact with hint/, "the retired `Compact with hint` action is back");
  assert.ok(t.includes("| wave → wave (within execution) | Clear + `/devcycle:continue` |"), "the wave-boundary default changed");
  assert.match(t, /Emitting the handoff block is NOT permission to continue/);
  assert.match(t, /state the\s+`\/devcycle:continue` resume path in the same message you halt on/);
});

test("harvested: delegation/coordinator-duties — the duty list is closed and the counters are the stopping condition", () => {
  const t = read("references/delegation.md");
  for (const duty of ["interact with the user", "dispatch subagents", "run the green gate", "create commits", "append the ledger", "update `.devcycle/state.md`", "emit handoff blocks"])
    assert.ok(t.includes(duty), `coordinator duty missing: ${duty}`);
  assert.match(t, /The list is positive and closed/);
  assert.match(t, /\*\*~30 tool calls\*\* made in this stage/);
  assert.match(t, /\*\*~15 files read\*\* in this stage/);
  assert.match(t, /\*\*Exempt from delegation\*\*/);
});

test("harvested: delegation/depth-gate — depth is measured by the probe, and an unknown depth is never a shallow one", () => {
  const d = read("references/delegation.md");
  assert.ok(d.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --depth'), "the depth probe command is gone");
  assert.match(d, /over budget at ≥15% of the window, hard stop at ≥20%/);
  assert.match(d, /An unknown depth is never evidence of a shallow one/);
  assert.ok(read("references/handoff.md").includes("Context depth: unknown (<the probe's one-line reason>)"), "no unknown-depth field shape");
});

test("harvested: distilling-learnings/memory-deleted-on-promotion — a memory is deleted only by its own landed promotion", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /Delete the source memory once its promotion lands, and only if it has one/);
  assert.match(t, /deleting nothing is then the normal outcome, not\s+a skipped step/);
  assert.match(t, /A landed promotion never deletes an entry it did not come from; a declined one\s+leaves its memory untouched/);
  assert.match(t, /references\/branch\.md`'s Committing rule first/);
});

test("harvested: distilling-learnings/stop-on-unconfirmed-promotion — nothing lands before its confirmation", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /Granularity changes; nothing is ever auto-applied/);
  assert.match(t, /`--preview` — mine and propose, write the dated artifact, land nothing, delete no memory/);
  assert.match(t, /Name the side effects\s+\*\*before\*\* asking/);
});

test("harvested: distilling-learnings/two-tier-disposition — the artifact's partition decides the batching", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.ok(t.includes("**Bulk** (ordinary `doc-edit`, `skill-edit`, `enforcement-gap`) and **Requires explicit decision**"), "the two-tier partition changed");
  assert.match(t, /no candidate moves into the bulk to avoid a per-item decision/);
  assert.match(t, /one reviewed decision covers the whole part/);
  assert.match(t, /per-item `AskUserQuestion`, 1[–-]4 at a time; no candidate leaves this set to\s+skip its round/);
});

test("harvested: doctor/config-drift-mode — drift mode skips the cost machinery and reports what the engine printed", () => {
  const t = read("playbooks/profiling-sessions.md");
  assert.match(t, /`\/devcycle:doctor drift <path>` \(internally `--drift <path>`\) skips the cost-analysis machinery/);
  assert.match(t, /takes precedence over every other flag/);
  assert.match(t, /prints each finding as a `file:line` reference with the changelog's recorded/);
  assert.match(t, /never re-parse the changelog or re-grep the target file/);
});

test("harvested: doctor/session-and-history — the script is run, and its vintage and unpriced models are carried forward", () => {
  const t = read("playbooks/profiling-sessions.md");
  assert.ok(t.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--all] [--since <date>] [--until <date>]'), "the invocation changed");
  assert.match(t, /Never re-implement its analysis/);
  assert.match(t, /Carry forward the script's `prices as of` line/);
  assert.match(t, /`UNPRICED MODEL` lines,\s+report them by name/);
  assert.match(t, /This run starts no cycle, writes no `\.devcycle\/state\.md`, and emits no handoff block/);
});

test("harvested: doctor/severity-ranking-and-actionability — severity ranks, dollars support, and the report persists", () => {
  const t = read("playbooks/profiling-sessions.md");
  assert.match(t, /references\/findings\.md`'s vocabulary \*\*verbatim\*\*/);
  assert.match(t, /never the sort key/);
  for (const option of ["**skip**", "**draft a GitHub issue**", "get a `/devcycle:cycle` entry point", "just the overview, no action"])
    assert.ok(t.includes(option), `actionability option missing: ${option}`);
  assert.match(t, /This run never invokes `\/devcycle:cycle` itself/);
  assert.match(t, /writes `\.devcycle\/doctor\/YYYY-MM-DD-report\.md`/);
});

test("harvested: dreaming-across-sessions/contradiction-not-auto-resolved — recency never settles a contradiction", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /\*\*Contradictions are never resolved by recency\*\*/);
  assert.match(t, /"latest" can reintroduce a corrected mistake/);
  assert.match(t, /both sides kept, resolved by a human at Confirm/);
});

test("harvested: dreaming-across-sessions/contradiction-spanning-sessions — a contradiction is always escalated", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /\*\*Requires explicit decision\*\*\s+\(every sensitive-flagged candidate and every `contradiction-resolution`\)/);
  assert.match(t, /a `contradiction-resolution` needs an explicit human choice between its two\s+preserved sides/);
});

test("harvested: dreaming-across-sessions/cross-session-evidence — a claim may state only what its quote shows", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /\*\*an observation may state only what its quote shows\*\*/);
  assert.match(t, /`subject` is the\s+normalized phrase the next stage clusters on across sessions/);
  assert.match(t, /groups records by\s+`subject`/);
});

test("harvested: dreaming-across-sessions/dual-invocation-checkpoint — a fresh artifact is reused and the checkpoint does not re-advance", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /If `artifactFresh` is true, read `artifactPath` and report it — no mining, screening, recurrence\s+check, artifact rewrite, and above all no checkpoint advance/);
  assert.match(t, /advance the corpus\s+checkpoint with `--commit-checkpoint <now, ISO-8601 UTC>`/);
});

test("harvested: dreaming-across-sessions/marginal-run-remines-nothing — an already-mined slice is never re-mined", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /a slice that already has an observation file is never re-mined/);
  assert.match(t, /which is what makes an interrupted run resumable/);
  assert.match(t, /Every stage's work list is its own slice ids minus the manifest's\s+`observations`/);
});

test("harvested: dreaming-across-sessions/sensitive-content-screening — the cluster signature is screened too", () => {
  const t = read("playbooks/learning-from-sessions.md");
  assert.match(t, /\*\*Screen\*\* every candidate's content \*\*and its cluster signature\*\*/);
  assert.match(t, /a signature\s+can reveal more than the fix it describes/);
  assert.match(t, /flag it for human attention/);
});

test("harvested: executing-waves/branch-discipline-preflight — the topic branch is cut before wave 1, off a resolved default", () => {
  const b = read("references/branch.md");
  const symbolic = b.indexOf("git symbolic-ref");
  const gh = b.indexOf("gh repo view --json defaultBranchRef");
  const fallback = b.indexOf("`main` or `master`");
  assert.ok(symbolic > -1 && symbolic < gh && gh < fallback, "the default-branch resolution order changed");
  assert.match(b, /`dev`, `develop`, `development`, `integration`/);
  const preflight = read("playbooks/executing-waves.md").match(/\n## Pre-flight, before wave 1\n([\s\S]*?)\n## /)?.[1];
  assert.ok(preflight, "executing-waves has no pre-flight section");
  assert.match(preflight, /\*\*Branch discipline\.\*\*/, "branch discipline is not a pre-flight step");
});

test("harvested: executing-waves/branch-switch-mid-wave — the branch is re-checked before every commit", () => {
  assert.match(read("references/branch.md"), /\*\*Per-commit re-check\.\*\*/);
  assert.match(read("references/branch.md"), /A mismatch\s+stops the run and surfaces the discrepancy rather than committing to the wrong branch/);
  assert.ok(read("playbooks/executing-waves.md").includes("`git rev-parse --abbrev-ref HEAD` against the recorded `branch:` line"), "no pre-commit re-check in executing-waves");
});

test("harvested: executing-waves/file-backed-evidence — the evidence paths, report shape and rejection conditions are pinned", () => {
  const t = read("references/evidence.md");
  assert.ok(t.includes(".devcycle/evidence/<task-id>-before.txt"), "before-path missing");
  assert.ok(t.includes(".devcycle/evidence/<task-id>-after.txt"), "after-path missing");
  assert.ok(t.includes(".devcycle/reports/<task-id>.md"), "report path missing");
  assert.ok(t.includes("**Evidence tail:** <N>"), "the tail line is not pinned");
  assert.match(t, /`\{ c1 && c2; \} > file 2>&1`/);
  assert.match(t, /a named evidence file is missing or empty/);
  assert.match(t, /an exit status contradicts the declared class/);
  assert.match(t, /the class mismatches the diff/);
});

test("harvested: executing-waves/green-gate-discipline — the gate is the coordinator's, and implementers never commit", () => {
  const t = read("playbooks/executing-waves.md");
  assert.match(t, /\*\*Green gate \(REQUIRED, deterministic\)\.\*\*/);
  assert.match(t, /re-run the task's test command\s+yourself and read the exit status/);
  assert.ok(t.includes("event=review-verdict outcome=rejected (green gate: <symptom>)"), "the rejection ledger shape changed");
  assert.match(t, /The dispatch prompt must NEVER\s+instruct the implementer to commit, stage, or push/);
  assert.match(read("agents/implementer.md"), /NEVER run `git commit`, stage a commit, or push/);
});

test("harvested: executing-waves/handoff-block-shape — five fields, and only two sanctioned first-field labels", () => {
  const t = read("references/handoff.md");
  for (const field of ["- Stage completed:", "- Artifacts:", "- Carry-overs:", "- Context action:", "- Compaction hint:"])
    assert.ok(t.includes(field), `handoff field missing: ${field}`);
  assert.match(t, /Wave completed: <n> of\s+<m> \(stage: execution\)/);
  assert.match(t, /these are the\s+only two sanctioned first-field labels/);
  assert.match(t, /Compaction hint: Keep <X>\. Drop <Y>\./);
});

test("harvested: executing-waves/model-routing — every escalation trigger and the ledger's audit shape are pinned", () => {
  const t = read("references/config.md");
  assert.match(t, /\*\*Files:\*\*` block lists\s+more than 5 files/);
  assert.match(t, /`\*\*Dependencies:\*\*` is anything other than `none`/);
  assert.match(t, /any step fails to name its file and expected behavior/);
  assert.match(t, /a prior review\s+round on this task returned blocking findings \(escalate on retry, never on\s+the first attempt\)/);
  assert.ok(t.includes("outcome=model session (auto: escalated on files=9)"), "the derived-escalation audit shape changed");
  assert.ok(t.includes("outcome=model <id> (pinned)"), "the pinned audit shape changed");
  assert.match(t, /escalation always names the signal that fired/);
});

test("harvested: executing-waves/return-envelopes — a dispatch returns counts and paths, never the report body", () => {
  const t = read("references/delegation.md");
  assert.ok(t.includes("report: .devcycle/reports/<task-id>.md"), "implementer report field missing");
  assert.ok(t.includes("on-device items: <count> | none"), "the on-device count field is gone");
  assert.ok(t.includes("deviations: <count> | none"), "the deviations count field is gone");
  assert.ok(t.includes("findings: .devcycle/findings/<task-id>-round-<n>.md | none"), "reviewer findings field missing");
  assert.match(t, /a short envelope of paths and counts — never\s+the content itself/);
  assert.match(t, /opens a report or findings file only when a decision needs content the\s+envelope cannot carry/);
});

test("harvested: fast-path/mini-cycle — the fast path keeps its evidence files and its one-reviewer floor", () => {
  const t = read("playbooks/taking-the-fast-path.md");
  assert.ok(t.includes(".devcycle/evidence/fast-before.txt"), "fast-path before-evidence path missing");
  assert.ok(t.includes(".devcycle/evidence/fast-after.txt"), "fast-path after-evidence path missing");
  assert.match(t, /Dispatch exactly ONE `devcycle:task-reviewer`/);
  assert.match(t, /one-reviewer floor is never profile-conditional/);
  assert.match(t, /No review panel, no\s+cross-model lens, no red-team/);
  assert.match(t, /\*\*Escalation valve\.\*\*/);
  assert.match(t, /No step is optional because the change is small/);
});

test("harvested: finishing-the-cycle/artifact-cleanup — the ephemeral set is enumerated, confirmed, and bounded", () => {
  const t = read("playbooks/finishing-the-cycle.md");
  assert.match(t, /The ephemeral set is exactly: `\.devcycle\/reports\/\*`, `\.devcycle\/evidence\/\*`,\s+`\.devcycle\/findings\/\*`/);
  assert.match(t, /Nothing else is a candidate/);
  assert.match(t, /file count and size/);
  assert.match(t, /\*\*Remove only on an explicit yes\.\*\*/);
  assert.match(t, /\*\*Never removed, whatever the answer:\*\*/);
  assert.match(t, /git ls-files --error-unmatch/);
  assert.match(t, /Never anything outside the repo root/);
});

test("harvested: onboarding-a-repo/output-shape — the scaffold names real commands and the allowlist is only proposed", () => {
  const t = read("playbooks/onboarding-a-repo.md");
  assert.match(t, /## devcycle onboarding/);
  for (const line of ["Stack: <detected", "Test: `<exact command>`", "Build: `<exact command>`", "Lint: `<exact command"])
    assert.ok(t.includes(line), `scaffold line missing: ${line}`);
  assert.match(t, /never written to `settings\.json` until\s+the user confirms it/);
  assert.match(t, /`git status`, `git diff`, `git log`/);
  assert.match(t, /Detection — read, never guessed/);
});

test("harvested: onboarding-a-repo/stop-on-existing-scaffold — an existing scaffold stops the run and asks", () => {
  const t = read("playbooks/onboarding-a-repo.md");
  assert.match(t, /## Idempotency check, first/);
  assert.match(t, /If found, \*\*stop and ask\*\*/);
  assert.match(t, /never overwrite silently/);
  assert.match(t, /standalone: no `\.devcycle\/state\.md` touch, no handoff block/);
});

test("harvested: planning-waves/dependency-declarations — the three declaration forms and the dispatch map are pinned", () => {
  const t = read("playbooks/planning-waves.md");
  assert.match(t, /line takes exactly one of `none \(completely independent\)`, `Task 2 \(consumes its X interface\)`, or\s+`Tasks 1\+4 committed`/);
  assert.match(t, /## Dispatch Map — required final section/);
  assert.match(t, /never place two tasks touching the same file in one\s+wave, even if both declare `none`/);
  assert.match(t, /pin exact interfaces — signatures, names, values/);
});

test("harvested: planning-waves/feasibility-gate — a NO-GO is a stop, and no substitute is planned silently", () => {
  const t = read("playbooks/planning-waves.md");
  assert.match(t, /## Feasibility gate — before any detailed planning/);
  assert.match(t, /Verdict: \*\*GO\*\*, or \*\*NO-GO\*\* — a stop, not a footnote/);
  assert.match(t, /write no detailed plan/);
  assert.match(t, /never silently substitute a different API or\s+mechanism for one the spec names/);
});

test("harvested: planning-waves/quality-constraints — the two constraint sections never merge, and each task carries its ids", () => {
  const t = read("playbooks/planning-waves.md");
  assert.ok(t.includes("QC1 — <do or don't> (measured against: <repo convention or named source>)"), "the QC line shape changed");
  assert.match(t, /That\s+section is \*\*not\*\* `## Global Constraints`/);
  assert.match(t, /so the two never merge/);
  assert.match(t, /Each task then carries a `\*\*Quality constraints:\*\*` line/);
});

test("harvested: reviewing-code/engine-delegation — one JSON argv, and exit 1 is the panel failing", () => {
  const t = read("playbooks/reviewing-code.md");
  assert.ok(t.includes('\'{"scope":{"ref":"<base>..<branch>"},"specPath":"<path>"'), "the panel argv shape changed");
  assert.match(t, /`scope` carries exactly one of `ref` or `paths`, `specPath` is omitted when no spec\s+governs the scope/);
  assert.match(t, /exit 1 means the panel failed, never that findings\s+exist, and is never a review verdict/);
  assert.ok(t.includes("panel→single (panel unavailable: <reason>)"), "the degradation string changed");
  assert.match(t, /export it \(`DEVCYCLE_PANEL_MODEL=<id> node \.\.\.`\) or\s+the CLI's default silently replaces the user's binding choice; on the session tier omit it/);
});

test("harvested: reviewing-code/lens-construction — 2-5 charters, never one criterion wide, each measured against something", () => {
  const t = read("playbooks/reviewing-code.md");
  assert.match(t, /\*\*2[–-]5 lens charters\*\*, \*\*by kind, not by count\*\*/);
  assert.match(t, /a lens is never one\s+criterion wide/);
  assert.match(t, /Below two it stops being a panel; above five each charter thins/);
  assert.match(t, /Each charter names\s+what it measures against/);
  assert.match(t, /With a `specPath`, one lens is spec compliance/);
});

test("harvested: reviewing-the-branch/bounded-review-loop — the ledger counts the rounds and the cap never converts a blocker", () => {
  const t = read("playbooks/reviewing-the-branch.md");
  assert.match(t, /\*\*Blocking means `critical` or `high`\*\*/);
  assert.match(t, /\*\*The ledger is the round counter, and the count is per cycle\.\*\*/);
  assert.match(t, /Only the user may grant rounds beyond the cap/);
  assert.match(t, /\*\*The cap bounds effort, never truth\.\*\*/);
  assert.match(t, /The fix-dispatch brief never instructs the implementer to\s+commit; the coordinator commits each fix on receipt/);
  assert.ok(t.includes("branch-fix-<round>-<n>"), "the minted fix task-id shape changed");
});

test("harvested: reviewing-the-branch/engine-selection — the report's engine value comes from a closed set", () => {
  const t = read("playbooks/reviewing-the-branch.md");
  assert.ok(t.includes("- Engine: <single | single + user-run code-review | panel | panel [+ cross-model lens] | panel→single (panel unavailable: <reason>)>"), "the engine line's value set changed");
  assert.ok(t.includes("- Rounds: <n> of <cap>"), "the rounds line changed");
  assert.match(t, /its value is one of the five above — no\s+variants/);
  assert.match(t, /Start the fresh\s+session on <model>\./);
  assert.ok(t.includes("checklist: none — on-device stage will judge applicability"), "the checklist-none compaction branch is gone");
});

test("harvested: reviewing-the-branch/graceful-degradation — the fallback is disclosed and recorded verbatim", () => {
  assert.match(read("playbooks/reviewing-the-branch.md"), /record the engine line it returns \*\*verbatim\*\*/);
  assert.match(read("playbooks/reviewing-code.md"), /\*\*`panel→single` degradation is a first-class path, not an apology\.\*\*/);
  assert.match(read("playbooks/reviewing-code.md"), /a\s+fallback presented as a panel run makes the review unauditable/);
});

test("harvested: scoping-interview/batched-questions — research precedes the batch, and the fallback keeps its shape", () => {
  const t = read("playbooks/scoping-the-request.md");
  assert.match(t, /Never one question per message/);
  assert.match(t, /\*\*Research BEFORE questions\.\*\*/);
  assert.match(t, /Never ask what the repo can\s+answer/);
  assert.match(t, /If AskUserQuestion is unavailable, send the whole\s+batch as one plain message with the SAME shape/);
  assert.match(t, /every question still listing its concrete options plus an explicit\s+Other\/free-form escape/);
});

test("harvested: scoping-interview/stop-gate — the stop is hard, unknowns stay <tbd>, and the artifact is written", () => {
  const t = read("playbooks/scoping-the-request.md");
  assert.match(t, /\*\*Hard STOP after asking\.\*\*/);
  assert.match(t, /\*\*At most ONE follow-up round\*\*/);
  assert.match(t, /\*\*Remaining unknowns become explicit `<tbd>` markers\*\*/);
  assert.match(t, /When the user declines to decide something, that is a\s+`<tbd>`, not permission to pick for them/);
  assert.match(t, /write\s+the scope summary to `\.devcycle\/scope\.md`/);
  assert.match(t, /End the stage by naming the next stage explicitly in your final output/);
});

test("harvested: sweeping-mechanical-changes/sweep-walk — gate 2 precedes every edit, and one reviewer gates the commit", () => {
  const t = read("playbooks/sweeping-mechanical-changes.md");
  assert.match(t, /Write the derived parameters to `\.devcycle\/sweep-plan\.md`/);
  assert.match(t, /Nothing runs and no agent edits anything\s+until this gate passes/);
  assert.ok(t.includes(".devcycle/sweep-args.json"), "the confirmed-args file is gone");
  assert.ok(t.includes(".devcycle/evidence/sweep-before.txt"), "sweep before-evidence path missing");
  assert.ok(t.includes(".devcycle/evidence/sweep-after.txt"), "sweep after-evidence path missing");
  assert.match(t, /Dispatch exactly ONE `devcycle:task-reviewer`/);
  assert.match(t, /\*\*Re-run rule\.\*\*/);
  assert.match(t, /Never edit the sweep script to get past a stop/);
  assert.match(t, /\*\*Escalation valve\.\*\*/);
});

test("harvested: verifying-on-device/checklist-shape — the checklist path, unchecked items and dimensions are pinned", () => {
  const t = read("references/checklist.md");
  assert.ok(t.includes("docs/<feature>/on-device-checklist.md"), "the plan-derived checklist path changed");
  assert.match(t, /Record it\s+in the `checklist:` field of `\.devcycle\/state\.md`/);
  assert.match(t, /No item is pre-checked and no item carries `\(auto\)` at generation time/);
  for (const dim of ["visual rendering vs intent", "layout / alignment / spacing", "interaction feel", "responsive behavior at real breakpoints", "theme parity", "keyboard / accessibility", "empty / loading / error states", "animation timing"])
    assert.ok(t.includes(dim), `checklist dimension missing: ${dim}`);
});

test("harvested: verifying-on-device/diff-derived-checklist — the scratch path and navigation fields are required standalone", () => {
  const c = read("references/checklist.md");
  assert.ok(c.includes(".devcycle/on-device-checklist-<branch-slug>.md"), "the diff-derived scratch path changed");
  assert.match(c, /Scratch for the run: never\s+committed/);
  assert.match(c, /\*\*required\*\* for diff-derived\s+ones/);
  const v = read("playbooks/verifying-on-device.md");
  assert.match(v, /\*\*automatically — there is no confirmation step\*\*/);
  assert.match(v, /Its `Where:` and\s+`How to get there:` fields are REQUIRED here/);
  assert.match(v, /this stage switches the checkout in neither/);
  assert.match(v, /\*\*must not create,\s+read-modify, or write `\.devcycle\/state\.md`\*\*/);
});

test("harvested: verifying-on-device/no-script-checkoff — only a structural check may (auto)-tag, and the human gate holds", () => {
  const c = read("references/checklist.md");
  assert.ok(c.includes("A SCRIPT OR SCREENSHOT NEVER CHECKS OFF A CHECKLIST ITEM."), "the (auto) boundary headline is gone");
  assert.match(c, /may be\s+checked off with the tag `\(auto\)`/);
  assert.match(c, /When claude-in-chrome is not\s+available, nothing is auto-checked: every item stays a human item/);
  const v = read("playbooks/verifying-on-device.md");
  assert.match(v, /`human-required`: the stage is complete ONLY when every non-`\(auto\)` item has a human\s+verdict/);
  assert.match(v, /\*\*ONE question per checklist item, never batched\*\*/);
});
