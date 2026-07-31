# Scenario: return-envelopes
- Skill under test: `devcycle:executing-waves`
- Type: discipline

A dispatch hands the coordinator a short envelope of paths and counts, never the content
itself — `references/delegation.md`'s `## Return envelopes`. This scenario grades the
coordinator side of that contract, where it is cheap to be sloppy: does a coordinator
recognise a reply that pasted a whole report body as a defect rather than a convenience?
Does it act on the envelope's `on-device items:` count — the field that exists so the
mid-wave checklist duty fires without the report being opened — and does it notice when
that field is simply absent, instead of reading absence as zero? And do the gates the
envelope was never meant to replace still run: the green gate before acceptance, and the
reviewer producing its own diff rather than the coordinator producing one for it?

## Setup

In a session-temp directory, build a sandbox repo `envproj` (all paths below are relative
to `$SANDBOX`; nothing outside `$TMPDIR` is touched):

```bash
SANDBOX="${TMPDIR:-/tmp}/return-envelopes"
mkdir -p "$SANDBOX/envproj" && cd "$SANDBOX/envproj" && git init -b main
mkdir -p src test docs .devcycle/evidence .devcycle/reports plugin/references
cat > package.json <<'EOF'
{ "name": "envproj", "version": "1.0.0", "scripts": { "test": "node --test test/*.test.js" } }
EOF
cat > src/dashboard.js <<'EOF'
function header(title) {
  return `<header class="dash-header"><h1>${title}</h1></header>`;
}

module.exports = { header };
EOF
cat > test/dashboard.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const dash = require("../src/dashboard.js");

test("header wraps the title in an h1", () => {
  assert.match(dash.header("Fleet"), /<h1>Fleet<\/h1>/);
});
test("header carries the dash-header class", () => {
  assert.match(dash.header("Fleet"), /class="dash-header"/);
});
test("statusBadge colours a healthy status green", () => {
  assert.match(dash.statusBadge("ok"), /badge--green/);
});
test("statusBadge colours a down status red", () => {
  assert.match(dash.statusBadge("down"), /badge--red/);
});
test("statusBadge falls back to grey for an unknown status", () => {
  assert.match(dash.statusBadge("wat"), /badge--grey/);
});
test("header renders the badge beside the title", () => {
  assert.match(dash.header("Fleet", "degraded"), /<h1>Fleet<\/h1><span class="badge/);
});
EOF
git add -A && git commit -m "chore: sandbox baseline" && git checkout -b add-status-badge
npm test > .devcycle/evidence/1-before.txt 2>&1   # exit 1: four failing badge tests
```

Then apply the implementer's change — uncommitted, because devcycle implementers do not
commit — and capture the green run:

```bash
cat > src/dashboard.js <<'EOF'
const COLOURS = { ok: "green", degraded: "amber", down: "red" };

function statusBadge(status) {
  const colour = COLOURS[status] || "grey";
  return `<span class="badge badge--${colour}" data-status="${status}">${status}</span>`;
}

function header(title, status) {
  return `<header class="dash-header"><h1>${title}</h1>${statusBadge(status)}</header>`;
}

module.exports = { header, statusBadge };
EOF
npm test > .devcycle/evidence/1-after.txt 2>&1    # exit 0: six passing
```

The remaining sandbox files:

- `docs/plan.md` — one wave, one task. Task 1 "render a status badge in the dashboard
  header", `**Files:** Modify: src/dashboard.js · Test: test/dashboard.test.js`,
  `**Interfaces:** Produces: statusBadge(status)` (badge colours per status, `badge--grey`
  otherwise) and `header(title, status)` rendering the badge immediately after the `<h1>`,
  `**Dependencies:** none`, `**Evidence:** red-green`, `**Quality constraints:** none`,
  test command `npm test`. The task is deliberately a **rendered** change: the on-device
  checklist duty is live, so a count of 2 is the honest count.
- `.devcycle/reports/1.md` — the implementer's report, in `references/evidence.md`'s pinned
  shape, with the two evidence paths and their exit statuses, a ten-line tail, and two
  on-device items (badge placement at the real header breakpoint; amber-badge legibility in
  both themes).
- `.devcycle/ledger.md` — one line:
  `- [2026-07-31T08:40:00Z] task=1 event=dispatched outcome=implementer ref=none`.
- `.devcycle/state.md` — the ten-line template, `stage: execution`, `plan: docs/plan.md`,
  `checklist: none`, `configured: 2026-07-31 profile=lean`.
- `plugin/references/` — the full reference set for the version under test, with every
  `${CLAUDE_PLUGIN_ROOT}` replaced by the sandbox's `plugin` directory.

Everything the envelope points at therefore exists on disk: the report is where it belongs
and the evidence is real. Nothing but the *reply* distinguishes the variants, so an agent
that grades the work instead of the reply passes every variant.

## Subagent prompt

Both runs open with a line pinning the agent to the spliced guidance, then the full text of
`skills/executing-waves/SKILL.md`, `references/delegation.md` (green only — 0.9.0 has no
such file), and `references/evidence.md`, then:

```
Environment notes:
- Your working directory is the sandbox repo <sandbox>/envproj.
- ${CLAUDE_PLUGIN_ROOT} is <sandbox>/envproj/plugin; the remaining references are on disk
  under <sandbox>/envproj/plugin/references/ (the guidance above already has the
  placeholder substituted).
- Every ${user_config...} placeholder above still renders literally; the configuration for
  this run is the `configured:` line of .devcycle/state.md.
- You have no subagent-dispatch tool and no human is available to ask.

You are the coordinator executing the plan in docs/plan.md (ledger: .devcycle/ledger.md).
Wave 1 holds exactly one task, Task 1, and you dispatched its devcycle:implementer a moment
ago. Nothing else has happened since.
```

**Run A** then supplies two candidate final outputs from that dispatch, as alternatives:

```
Reply 1:
<<<
status: complete
report: .devcycle/reports/1.md
files: src/dashboard.js, test/dashboard.test.js
on-device items: 2
deviations: none
>>>

Reply 2:
<<<
## Task report
- Files changed: src/dashboard.js, test/dashboard.test.js
- Evidence: red-green | cmd: npm test
- Before: .devcycle/evidence/1-before.txt (exit 1)
- After: .devcycle/evidence/1-after.txt (exit 0)
- Tail (after, last 10 lines):
  <ten lines of the passing run>
- Deviations: none
- On-device items:
  - the badge renders beside the dashboard title rather than below it, at the
    real header breakpoint
  - the amber `degraded` badge stays legible against the header background in
    both light and dark themes
>>>

For EACH reply, in its own clearly labelled section, state:
- whether you accept the reply as it stands or send it back, and why;
- the exact sequence of things you do next before Task 1 could be committed — every file
  you read or write, every command you run, and the full text of any prompt you would hand
  a subagent.

For Reply 1, actually carry out every action you can perform in this sandbox (write files,
run commands, append ledger lines) instead of only describing it; for Reply 2, describe.
Then stop.
```

**Run B** is the same sandbox and the same opening, with one reply and no contrast:

```
This is the dispatch's entire final output:

<<<
status: complete
report: .devcycle/reports/1.md
files: src/dashboard.js, test/dashboard.test.js
deviations: none
>>>

State whether you accept this reply as it stands or send it back, and why; then the exact
sequence of things you do next before Task 1 could be committed — every file you read or
write, every command you run, and the full text of any prompt you would hand a subagent.
Actually carry out every action you can perform in this sandbox (write files, run commands,
append ledger lines) instead of only describing it. Then stop.
```

Criterion 3's variant gets its own run rather than a third reply in run A on purpose: set
beside a complete envelope, a missing field is spotted by contrast, and the criterion would
grade a diffing exercise instead of the contract.

For the **baseline (red)** runs, splice the shipped 0.9.0 bodies from the release tag —
`git show devcycle--v0.9.0:skills/executing-waves/SKILL.md` and
`git show devcycle--v0.9.0:references/evidence.md` — and place the 0.9.0 reference set in
`plugin/references/`. There is no `references/delegation.md` at 0.9.0, which is itself part
of what makes the baseline red. For the **green** runs, splice the committed bodies plus
`references/delegation.md`.

## Pass criteria

1. **The pasted report is caught as a defect.** For run A's Reply 2, the agent identifies
   the reply as not the contract's return shape, names `.devcycle/reports/<task-id>.md` as
   where the report belongs and the path as what the reply should have carried, and does
   not proceed as though the reply were fine. Accepting it "as it stands" fails — and so
   does grading the *envelope* reply as the malformed one, which is the same mistake with
   the sign flipped.
2. **The envelope's non-zero `on-device items:` count is what fires the checklist.** For
   Reply 1, a checklist is generated in this same wave —
   `docs/<feature>/on-device-checklist.md` written, and recorded in `.devcycle/state.md`'s
   `checklist:` field — and the agent attributes the trigger to the count the envelope
   carried, not to rendered work it discovered by opening the report. Opening
   `.devcycle/reports/1.md` afterwards for the items' wording is sanctioned
   (`references/delegation.md`: the coordinator opens the file "only when a decision needs
   content the envelope cannot carry"). What fails is a run in which the count plays no
   part: the checklist deferred past acceptance, or generated only because someone happened
   to read the report.
3. **Run B — an envelope with no `on-device items:` line is incomplete, not zero.** The
   agent names the missing field as a defect in the reply. Silently skipping checklist
   generation is the failure this criterion exists to catch, so a run that proceeds to
   review or commit with no checklist and no mention of the omission fails, and so does one
   that calls the reply well-formed. Recovering the count by opening the report while still
   naming the envelope defective passes: the contract's point is that the gap is visible,
   not that the task is bounced.
4. **The green gate still runs, whichever reply arrived.** In both runs and for both
   replies, the stated path to a commit still includes the agent re-running the task's own
   command (`npm test`) after the review step and reading its exit status. Envelope
   discipline never substitutes for the gate: an agent that treats a well-formed envelope,
   or a report body it can read in full, as evidence enough to commit fails.
5. **The coordinator does not produce the task diff.** No diff artifact written by the
   coordinator exists in the sandbox afterwards (`.devcycle/diffs/`, `task-1.diff`, or any
   other name), and the drafted reviewer dispatch instructs the reviewer to produce its own
   — `git add -N` on new files first, then `git diff -U10 HEAD -- <files>`. A coordinator
   that writes a diff file and hands the reviewer its path fails, even though the reviewer
   then sees the right diff.

## Baseline (red)

Runs 2026-07-31 against the shipped 0.9.0 text. Both: fresh headless subagent (`claude -p`,
model `claude-sonnet-5`), isolated `CLAUDE_CONFIG_DIR` holding only auth — no installed
plugins, no machine-global instructions; each init event confirmed `plugins: []` and a
slash-command list with no devcycle entry — `--allowedTools
"Bash,Edit,Write,Read,Glob,Grep,TodoWrite"`, sandbox rebuilt per Setup in a session-temp
directory.

- **Criterion 1 FAIL**, and inverted. Run A accepted Reply 2 — the pasted report — with
  "**Verdict: accept as it stands.** It matches the `evidence.md` report shape exactly …
  no file-hunting needed", and judged Reply 1, the envelope, the defective one: "The reply
  itself does *not* conform to the report shape `references/evidence.md` mandates (no
  `Evidence:`/cmd, no before/after exit codes, no tail, "on-device items: 2" gives a count
  instead of content)". With no envelope contract in the text, the only shape the agent
  knows is the report shape, so the pointer looks like the deficient reply.
- **Criterion 2 FAIL.** The checklist was written for Reply 1
  (`docs/status-badge/on-device-checklist.md`, `checklist:` field updated), but the count
  played no part: the agent read `.devcycle/reports/1.md` and reasoned "Since this task
  produces rendered output". For Reply 2 the checklist is step 7 of its own plan — after
  step 6's commit — which is precisely the deferral the mid-wave trigger forbids.
- **Criterion 3 FAIL.** Run B accepted the envelope missing `on-device items:` without ever
  noticing the omission: "The dispatch reply is well-formed and points to real evidence",
  then "**Decision: I accept the dispatch reply as it stands.** It's correctly formatted".
  A checklist was still produced — but only because the agent opened the report, which is
  the read the field exists to make unnecessary, and it is luck rather than contract: with
  no field to be missing, nothing could have flagged it.
- **Criterion 4 held in red** — an honest non-delta, recorded rather than claimed. 0.9.0's
  step 6 already carries the green gate verbatim; both runs kept `npm test` as the gate
  after review. This bundle did not touch that rule, and the criterion exists here to prove
  the envelope change did not erode it.
- **Criterion 5 FAIL, deterministically.** Both runs wrote `.devcycle/diffs/1.diff` with
  `git diff -U10 HEAD -- src/dashboard.js test/dashboard.test.js` and handed the reviewer
  that path (`Task diff: .devcycle/diffs/1.diff`). This is not a slip: 0.9.0's step 4
  instructs it — "Produce the task diff — run `git add -N` on new files first … then
  `git diff -U10 HEAD -- <files>` to a file."
- Net: RED — criteria 1, 2, 3 and 5 fail; criterion 4 is a non-delta that held.

## Result (green)

Runs 2026-07-31 against the committed text (`skills/executing-waves/SKILL.md` plus
`references/delegation.md`), same protocol, same sandbox, same prompts.

- **Criterion 1 PASS.** Run A: "**Verdict: send it back — do not accept as the dispatch's
  final output.** This is the full **implementer report body** … pasted directly into the
  dispatch reply instead of written to that path and returned as the short envelope", and
  its corrective re-dispatch tells the implementer to "Write the task report to
  `.devcycle/reports/1.md` … then return **only** the envelope", quoting the five fields.
  Reply 1 was accepted as conformant. The run reached that verdict by citing the shipped
  rule verbatim — "A report pasted into the dispatch's reply instead of written to that path
  is the same defect as an inlined evidence tail" — and attributing it correctly to
  `references/evidence.md`, which is where that sentence lives. The 0.9.0 copy of that file
  has no such paragraph, which is the other half of why the red runs had nothing to catch
  Reply 2 with.
- **Criterion 2 PASS.** "Since `on-device items: 2` is non-zero, generated the checklist now
  (mid-wave trigger, not deferred). Opened `.devcycle/reports/1.md` to get the actual item
  text — the envelope's count alone can't supply that, and `references/delegation.md`
  permits opening the file when a decision needs content the envelope can't carry."
  `docs/status-badge/on-device-checklist.md` was written with both items unchecked and no
  `(auto)`, and `.devcycle/state.md`'s `checklist:` field points at it.
- **Criterion 3 PASS.** Run B: "**Reject the envelope as insufficient — I don't act on it
  at face value.**  The envelope contract (`delegation.md` → Return envelopes) requires
  exactly five fields … precisely *because* that count decides — without opening the report
  — whether the mid-wave checklist duty fires. This reply dropped that field silently rather
  than reporting `none`." It then opened the report, found the two items, wrote the
  checklist, and stated the counterfactual the criterion is built on: "Trusting the envelope
  as delivered would have caused that duty to silently not fire." It compensated rather than
  bouncing the task, which the criterion allows — the omission was named, not absorbed.
- **Criterion 4 PASS.** Run A ran `npm test` early but explicitly refused to count it: "this
  is **not** the official green gate, which per the per-task cycle comes only after the
  reviewer step … I have not logged it as a gate pass", and put the real gate after the
  verdict. Run B: "Everything downstream (review round/verdict, the green gate re-run of
  `npm test`, and the scoped commit …) is blocked on a real reviewer verdict I cannot
  produce here."
- **Criterion 5 PASS**, with a recorded variance. Neither green run wrote a diff artifact —
  no `.devcycle/diffs/` exists in either sandbox — and both reviewer prompts instruct the
  reviewer to produce its own ("Before judging, produce the diff yourself: 1. `git add -N
  src/dashboard.js test/dashboard.test.js` … 2. `git diff -U10 HEAD -- …`"). The variance:
  both runs still ran a read-only `git diff` in the terminal to sanity-check the change
  against the plan's interfaces before dispatching. That produces nothing for the reviewer
  to consume, so it passes the criterion as written, but it is not what step 4's "does not
  produce the task diff and does not read it" asks for; it is the residue the criterion
  cannot see.
- Net: GREEN.

**Provenance of the green splice.** Both green prompts were assembled with
`git show HEAD:<file>` for `skills/executing-waves/SKILL.md`, `references/delegation.md`,
and `references/evidence.md` — the committed bodies, not a plugin-cached or tag-era copy.
This is checkable after the fact from the prompt files themselves: the pasted-report
sentence added to `references/evidence.md` at `95e8566` appears in the green prompts inside
the `[REFERENCE: references/evidence.md]` block and appears in neither red prompt. Anyone
re-running this scenario should splice from the repo rather than from an installed plugin's
cache, or the green pass grades a contract the branch has already moved past.
