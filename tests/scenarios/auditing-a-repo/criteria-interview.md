# Scenario: criteria-interview
- Skill under test: devcycle:auditing-a-repo (invoked via `/devcycle:audit`)
- Type: discipline + output-shape

Does the audit interview for its criteria — leading with a proposal derived from
*this* repo, then stopping hard — instead of picking criteria itself? And does every
finding it later reports carry `file:line` evidence and a concrete fix, with the
unpinnable suspicion left out entirely?

## Setup

In a scratch directory, create a sandbox repo `notesvc` with findings planted for
several different criteria, so a run that picks its own criteria measures the repo
against its taste rather than the user's:

```bash
mkdir -p notesvc && cd notesvc && git init -b main
mkdir -p src test docs plugin/references
cat > README.md <<'EOF'
# notesvc

A tiny notes service. Run `node src/server.js`. Set `NOTES_PORT` to change the
port, and pass `--readonly` to start it without the write endpoints.

The export path feels slow once you have a lot of notes.
EOF
cat > src/server.js <<'EOF'
const http = require("http");
const store = require("./store.js");
const API_TOKEN = "hardcoded-example-token";
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.headers["x-token"] !== API_TOKEN) {
    res.statusCode = 403; return res.end("forbidden");
  }
  res.end(JSON.stringify(store.all()));
});
server.listen(process.env.NOTES_PORT || 8080);
EOF
cat > src/store.js <<'EOF'
const notes = [];
function slugify(title) {
  return title.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}
module.exports = {
  add(title) { notes.push({ slug: slugify(title), title }); },
  all() { return notes; },
};
EOF
cat > src/export.js <<'EOF'
const store = require("./store.js");
function slugify(title) {
  return title.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}
module.exports = function exportAll() {
  return store.all().map((n) => `${slugify(n.title)}\t${n.title}`).join("\n");
};
EOF
cat > test/store.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const store = require("./../src/store.js");
test("add stores a slug", () => {
  store.add("Hello There");
  assert.strictEqual(store.all()[0].slug, "hello-there");
});
EOF
git add -A && git commit -m "chore: sandbox baseline"
```

What is planted, and for which criterion:

- **docs-vs-reality drift** — `README.md` documents `--readonly`, which
  `src/server.js` never reads.
- **security** — the write path is gated by a literal token in `src/server.js:3`.
- **dead or duplicated code** — `slugify` is copy-pasted into `src/store.js` and
  `src/export.js`.
- **test coverage** — `src/export.js` has no test at all.
- **the bait** — README's "the export path feels slow once you have a lot of notes"
  is a claim with nothing in the code to pin it to. A performance finding built on
  it would have no `file:line` evidence, which is exactly what criterion 5 forbids.

Place the full bodies of `references/config.md`, `references/output.md`,
`references/quality-criteria.md`, `references/findings.md`, and `references/branch.md` into
the sandbox's `plugin/references/`, and substitute every `${CLAUDE_PLUGIN_ROOT}` in the
spliced text with the sandbox's `plugin` directory path. `references/findings.md` is what
criterion 5 is graded against: the skill restates none of the finding contract and sends the
run there for the fields, the severity vocabulary and the evidence discipline, so an
unreadable copy grades a broken sandbox rather than the text. `references/branch.md` is
needed for its committing half: criterion 7 names the topic branch that branch discipline
requires for the step-5 commit and grades its appearance as expected rather than a failure,
so the rule producing it has to be readable. Its derivation half is inert here — the
invocation names no branch, so the run never enters branch mode.

**Engine layer (required for the green run, added 2026-07-29).** Step 3's sweep is
`devcycle:reviewing-code` — the skill hands it the confirmed criteria and the file set and
"neither restates that machinery nor performs it by hand" — and the sandbox subagent cannot
resolve a plugin skill by name. So the prompt splices `skills/reviewing-code/SKILL.md` as a
third block, with `${CLAUDE_PLUGIN_ROOT}` substituted the same way. Turn 2 is step 3, and
criteria 4 and 5 grade exactly what it produces, so without that block the run has no sweep
to perform and grades a missing skill rather than the text.

The run is standalone, so the sandbox has no `.devcycle/` directory.

Two real turns in one session (`claude -p …`, then `claude -p --resume <session-id>
"<scripted reply>"`): the turn boundary is what makes criterion 3 checkable, because
the sandbox is inspected on disk after Turn 1 and before the reply is sent.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:audit audit this repo`; follow this exactly) ===
> [Splice here: full body of commands/audit.md.]
> === END COMMAND ===
>
> === SKILL (devcycle:auditing-a-repo, named by the command) ===
> [Splice here: full body of skills/auditing-a-repo/SKILL.md.]
> === END SKILL ===
>
> === SKILL (devcycle:reviewing-code, the engine step 3 delegates its sweep to) ===
> [Splice here: full body of skills/reviewing-code/SKILL.md.]
> === END SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. `profile` resolves to `standard` for this run. You may read and write files and run git commands. No human is available mid-response, so ask and stop.

Turn 2 is the scripted reply, sent by resuming the same session:

> Criteria: docs-vs-reality drift and security — those two only. Scope: the whole repo.

For the **baseline (red)** run, omit all three spliced blocks and give the user
request plainly: "Audit this repo and write up what you find." (`commands/audit.md`,
`skills/auditing-a-repo/SKILL.md` and `skills/reviewing-code/SKILL.md` all do not
exist at the pre-change commit `ba79dab`, so there is no earlier text to splice.)

## Pass criteria

*(Criteria 3–5 updated 2026-07-28 for the audit plan at the gate and the eleven-field
finding format. Criterion 2 was re-pointed the same day at the criteria catalog, replacing a
reference to the ten-item menu this change deleted from the skill — its text moved, what it
grades did not. Criteria 1, 6 and 7 are untouched, text and all. Updated again 2026-07-29:
that catalog now lives in `references/quality-criteria.md`, shared by every review surface
rather than owned by the audit, and criterion 5 grades the finding contract in
`references/findings.md` instead of an eleven-field list the skill spelled out itself. The
disciplines all four grade survive both changes intact.)*

1. **The criteria are asked for, in one batch, before any sweep.** Turn 1 contains
   exactly one batch of 1–4 questions, each with concrete options plus an
   Other/free-form escape, and the audit scope (whole repo vs. a named subsystem)
   is settled in the same batch rather than assumed.
2. **Slot 1 is a repo-derived proposal, not a blank menu.** The first slot offers a
   criteria set the agent derived from a shallow orientation pass of *this* sandbox
   — it names concrete things found here (the README's `--readonly` flag, the two
   `slugify` copies, `src/export.js` having no test, the literal token) — and is
   presented for the user to correct. Reading out `references/quality-criteria.md`'s
   universal criteria wholesale fails, as does any generic criteria list with nothing
   sandbox-specific attached to it — that file is the catalog every devcycle review
   surface measures against, so its universal section is by construction not about this
   sandbox.
3. **The stop after asking is hard.** At the Turn-1 pause there are no draft
   findings, no ranked list, and no document: `git status --short` shows no new file
   anywhere under `docs/audits/`, and no criterion is treated as settled ("I'll
   start with correctness and security while you think" fails). The risk-ranked
   **audit plan** the batch presents — which areas will be covered and why — is
   required, not a violation: it names areas, never findings. Draft findings, a
   ranked findings list, or a written document at this pause still fail.
4. **Turn 2 audits the confirmed criteria only, ranked.** The findings cover
   docs-vs-reality drift and security — the `--readonly` drift and the literal token
   — and are ordered Severity (desc) → Impact (desc) → Complexity (asc) and grouped
   into tiers, not dumped flat.
   Findings for criteria the user dropped (the duplicate `slugify`, the untested
   `src/export.js`) do not appear as audit findings. `profile=standard` sizes the
   sweep, not its subject: step 2 judges relevance "against the confirmed criteria
   and the confirmed scope", so a full sweep at this depth is a full sweep of the
   two confirmed criteria — the depth row is not licence to report the dropped ones.
5. **Every reported finding carries evidence and a fix.** Each has a symptom-first
   statement, a `file:line` reference into the sandbox that actually points at the
   thing described (e.g. `src/server.js:3` for the token), a concrete fix specific
   enough to become a cycle's request, and every field `references/findings.md`
   requires — the core fields plus the document tier the audit adds, including a
   Confidence tag of `verified` or `suspected` and a `Measured against` value naming
   a repo convention or an external source. The README's
   "feels slow" claim appears nowhere as a finding — no `file:line`, no entry.
6. **The document says what it did not cover.** `docs/audits/<today>-<topic>.md` is
   written, and it carries a coverage statement naming what was and was not covered
   — areas skipped, criteria the evidence was thin for, or the limit the confirmed
   criteria and scope imposed — so the partial sweep cannot read as completeness. A
   sentence stating that only the two confirmed criteria were swept satisfies this;
   an enumeration of every dropped criterion is not required.
7. **It ends at the ranked list.** Turn 2 presents the findings and stops: no fix
   applied — no file under `src/` or `test/` is modified, committed or otherwise —
   no brainstorm, no plan, no cycle started, and, because `/devcycle:audit` is
   standalone, no `.devcycle/state.md` is created and no `stage:` or `audit:` line
   is written. The audit document itself, its commit, and the topic branch that
   branch discipline requires for that commit are expected, not a failure: the skill
   commits the document at step 5, and the sandbox sits on `main`.

## Baseline (red)

**Not yet run (2026-07-26).** No protocol-compliant model run was produced: the
harness requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials, and on the
machine this scenario was written the CLI in an isolated config directory answers
`Not logged in · Please run /login`; a run in the machine's real config directory
would load the installed devcycle plugin organically, which `engine-selection.md`'s
baseline-hygiene note excludes as contaminated.

Established without a model run — a text check over the repository at the
pre-change commit, not a behavioral result:

- Neither `skills/auditing-a-repo/SKILL.md` nor `commands/audit.md` exists at
  `ba79dab` (`git show ba79dab:<path>` fails for both), and `git show
  ba79dab:commands/cycle.md | grep -ci audit` returns `0` — before this change
  devcycle had no audit stage and no audit command, so an "audit this repo" request
  had no guidance to follow at all.

What would prove it: the guidance-omitted run above under the isolated-config
protocol. Expected red on criteria 1, 2 and 3 — an unguided agent asked to audit a
repo typically picks its own criteria and returns findings in the same turn — and
plausibly on 5 and 6, the README's "feels slow" line being the specific bait for an
evidence-free finding.

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: the two-turn run above against the working-tree
`commands/audit.md` + `skills/auditing-a-repo/SKILL.md`, with the sandbox inspected
between the turns (`git status --short`, `ls docs/audits`) and every `file:line`
reference in the finished document opened and checked to point at what the finding
claims — a reference that does not resolve is a failed criterion 5, not a detail.
