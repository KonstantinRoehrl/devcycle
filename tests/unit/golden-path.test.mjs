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

// `references/resume.md` § Resuming at the recorded stage now owns every stage's playbook
// path; both run-bearing commands cite it instead of restating a route inline.
const RESUME_REF = "${CLAUDE_PLUGIN_ROOT}/references/resume.md";

// --- deriving a matcher from a documented template -------------------------------------
// Several formats in this surface are pinned as one literal template line in the reference
// that owns them (the ledger's event line, the loop-status line). Tests below derive their
// matcher from that line rather than restating it, so deleting or editing the template is a
// test failure instead of a silent divergence.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A `<...>` placeholder is either an enum of literal values (`<dispatched|committed>`) or the
// *kind* of value that goes there (`<commit-sha|file|none>` — a sha, a path, or `none`). A
// placeholder naming any of these kinds matches a token rather than the kind's own name.
const KIND_WORDS = new Set(["commit-sha", "file", "id", "short", "destination", "count", "n", "cap", "sha", "path"]);

const atom = (name) => {
  const n = name.trim();
  if (/ISO-8601/.test(n)) return "\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z";
  if (/ or none$/.test(n)) return `(?:${atom(n.replace(/ or none$/, ""))}|none)`;
  if (n === "n" || n === "cap" || n === "count") return "\\d+";
  if (n === "short") return ".+"; // a one-line outcome, which may carry spaces
  const parts = n.split("|");
  if (parts.length > 1 && !parts.some((p) => KIND_WORDS.has(p))) return `(?:${parts.map(esc).join("|")})`;
  return "\\S+";
};

const shapeFromTemplate = (template) =>
  new RegExp("^" + template.split(/<([^>]+)>/).map((part, i) => (i % 2 ? atom(part) : esc(part))).join("") + "$");

test("the stage enum is non-empty and every stage is lowercase-kebab", () => {
  assert.ok(stages.length > 0, "no stage enum found in commands/cycle.md");
  for (const s of stages) assert.match(s, /^[a-z][a-z-]*$/);
});

// `done` is the closed state: no playbook resumes it, and cycle.md closes the state file at
// it. Every other stage in the enum must route somewhere real from both entry points.
const TERMINAL = "done";

// Where a stage's text says the run goes next: a playbook file that exists on disk, or an
// upstream skill devcycle delegates the stage to wholesale.
const routesSomewhere = (text) => {
  const paths = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(playbooks\/[A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]);
  return {
    ok: paths.some((p) => existsSync(join(root, p))) || /superpowers:[a-z-]+/.test(text),
    paths,
  };
};

// Each stage, as `/devcycle:cycle` itself resolves it: an entry in the numbered stage walk.
// The two short paths (`fast-path`, `sweep`) bypass the walk on confirmation and carry no
// numbered entry of their own; every stage's actual playbook now comes from the shared table
// in `references/resume.md`, which both commands cite instead of restating.
const cycleRoutes = () => {
  const text = read("commands/cycle.md");
  const routes = new Map();
  const walk = text.split("\n## Stage walk\n")[1] ?? "";
  for (const item of walk.split(/\n(?=\d+\. )/)) {
    const stage = item.match(/^\d+\. \*\*([a-z-]+)\*\*/)?.[1];
    if (stage) routes.set(stage, item);
  }
  return routes;
};

// `references/resume.md` § Resuming at the recorded stage, parsed into stage -> "resume via" cell —
// the one place a stage's playbook path now lives.
const resumeRoutes = () => {
  const resume = read("references/resume.md");
  const section = resume.split("## Resuming at the recorded stage")[1]?.split(/\n## /)[0] ?? "";
  const routes = new Map();
  for (const [, stage, via] of section.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*(.+?)\s*\|$/gm)) routes.set(stage, via);
  return routes;
};

test("cycle.md itself routes every stage in its enum to a playbook that exists", () => {
  const cycle = read("commands/cycle.md");
  assert.ok(cycle.includes("`stage: done`"), "cycle.md no longer names the terminal stage");
  assert.ok(
    cycle.includes(RESUME_REF),
    "commands/cycle.md no longer cites references/resume.md, which owns the stage → playbook routing"
  );
  const walked = cycleRoutes();
  const resumeVia = resumeRoutes();
  for (const s of stages) {
    if (s === TERMINAL) continue;
    if (s !== "fast-path" && s !== "sweep")
      assert.ok(walked.get(s), `commands/cycle.md names stage "${s}" in its enum but has no numbered walk entry for it`);
    const cell = resumeVia.get(s);
    assert.ok(cell, `references/resume.md's stage table has no row for "${s}" for commands/cycle.md's walk to resume through`);
    const { ok, paths } = routesSomewhere(cell);
    assert.ok(ok, `references/resume.md routes stage "${s}" to no playbook that exists (found: ${paths.join(", ") || "none"})`);
  }
});

test("continue's resume table routes every resumable stage to a playbook that exists", () => {
  const continueText = read("commands/continue.md");
  assert.ok(
    continueText.includes(RESUME_REF),
    "commands/continue.md no longer cites references/resume.md, which owns the stage → playbook routing"
  );
  const resumeVia = resumeRoutes();
  for (const s of stages) {
    if (s === TERMINAL) {
      assert.ok(!resumeVia.has(s), `references/resume.md offers to resume the terminal stage "${s}"`);
      continue;
    }
    const cell = resumeVia.get(s);
    assert.ok(cell, `references/resume.md's stage table has no row for stage "${s}"`);
    const { ok, paths } = routesSomewhere(cell);
    assert.ok(ok, `references/resume.md resumes stage "${s}" into no playbook that exists (found: ${paths.join(", ") || "none"})`);
  }
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

test("the loop-status line is the one references/loops.md documents, for all three statuses", () => {
  const loops = read("references/loops.md");
  const template = loops.match(/^\s*status: <.*$/m)?.[0].trim();
  assert.ok(template, "references/loops.md no longer carries the status-line template");
  const documented = [...loops.matchAll(/^- `([a-z-]+)` — /gm)].map((m) => m[1]);
  assert.deepEqual(
    template.match(/<([a-z|-]+)>/)?.[1].split("|"),
    documented,
    "the status-line template and the documented status list name different statuses"
  );
  const shape = shapeFromTemplate(template);
  for (const s of documented)
    assert.match(`status: ${s} rounds: 1/3 residue: none carried-to: none`, shape, `the template rejects status "${s}"`);
  assert.match("status: exhausted-with-residue rounds: 3/3 residue: 4 carried-to: docs/audits/2026-08-06-disposition-register.md", shape);
  // A line missing the fields the template pins is malformed, whatever it says about its cap.
  assert.doesNotMatch("status: resolved rounds: 1/3", shape);
  assert.doesNotMatch("status: cap reached rounds: 3/3 residue: none carried-to: none", shape);
});

const ledgerLines = () =>
  readFileSync(join(root, "tests/fixtures/golden-path/ledger.md"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- ["));

const ledgerEvents = () =>
  ledgerLines().map((line) => ({
    line,
    at: line.match(/^- \[([^\]]+)\]/)?.[1] ?? "",
    task: line.match(/ task=(\S+)/)?.[1] ?? "",
    event: line.match(/ event=(\S+)/)?.[1] ?? "",
    outcome: line.match(/ outcome=(.*) ref=/)?.[1] ?? "",
  }));

test("the ledger fixture parses against the event line references/ledger.md owns", () => {
  const template = read("references/ledger.md").match(/^- \[<ISO-8601 UTC>\].*$/m)?.[0];
  assert.ok(template, "references/ledger.md no longer states the per-event line shape");
  const vocabulary = template.match(/event=<([a-z|-]+)>/)?.[1].split("|") ?? [];
  assert.ok(vocabulary.length > 1, "the ledger's event vocabulary is no longer an enum");
  const shape = shapeFromTemplate(template);
  const events = ledgerEvents();
  assert.ok(events.length > 0, "the ledger fixture records no events — every assertion over it would run over nothing");
  for (const e of events) {
    assert.match(e.line, shape);
    assert.ok(vocabulary.includes(e.event), `the fixture uses event "${e.event}", which references/ledger.md does not list`);
  }
});

test("scoping states the batched-questions contract", () => {
  assert.match(read("playbooks/scoping-the-request.md"), /batches of 1[–-]4/);
});

test("every bounded loop names a cap", () => {
  for (const f of ["executing-waves", "taking-the-fast-path", "sweeping-mechanical-changes", "learning-from-sessions"])
    assert.match(read(`playbooks/${f}.md`), /Cap: \d+/, `playbooks/${f}.md declares no cap`);
});

// The green-gate invariant: a commit is recorded only after the gate ran, so the fixture must
// carry a commit to judge, that commit must name the gate's outcome, and the events that gate
// it — the report and the accepted verdict — must precede it for the same task.
test("the ledger fixture records a gated commit, never a bare one", () => {
  const events = ledgerEvents();
  const committed = events.filter((e) => e.event === "committed");
  assert.ok(committed.length > 0, "the ledger fixture records no `event=committed` — the green-gate assertions would run over nothing");
  for (const c of committed) {
    assert.match(c.outcome, /green gate passed/, `a commit was recorded with outcome "${c.outcome}", which does not name the gate`);
    const before = events.filter((e) => e.task === c.task && e.at < c.at);
    assert.ok(
      before.some((e) => e.event === "report-received"),
      `task=${c.task} was committed with no report-received event before it`
    );
    assert.ok(
      before.some((e) => e.event === "review-verdict" && e.outcome === "accepted"),
      `task=${c.task} was committed with no accepted review verdict before it`
    );
  }
});

test("executing-waves runs the green gate before the commit step, not after it", () => {
  const t = read("playbooks/executing-waves.md");
  const gate = t.indexOf("**Green gate (REQUIRED, deterministic).**");
  const commit = t.indexOf("**Branch re-check, then commit.**");
  assert.ok(gate > -1, "executing-waves.md has no green-gate step");
  assert.ok(commit > -1, "executing-waves.md has no commit step");
  assert.ok(gate < commit, "the commit step precedes the green gate");
  assert.match(t.slice(gate, commit), /On failure, acceptance is blocked: no commit/);
  assert.match(t.slice(commit), /on acceptance: a local commit/);
});

// The no-direct-push invariant: no workflow may push to the release branch. `main` is the
// release branch — `.github/workflows/prepare-release.yml` states that nothing may push
// straight to it, and the version bump travels in the dev → main PR instead.
const RELEASE_BRANCH = "main";

// Every `git push` in a shell snippet, reduced to the branches it would write. What matters is
// each refspec's destination: `origin main`, `-u origin main`, `HEAD:main` and `"$REMOTE" main`
// all write main, while `origin "devcycle--v$V"` writes a tag and `origin dev` writes dev.
// The guard deliberately errs toward flagging. A false positive fails CI and gets a human
// look; a false negative ships a direct push to the release branch. So `git push` inside an
// `echo` or a quoted string is still counted — the parser does not model shell context, and
// making it do so would trade the safe error for the unsafe one.
function pushTargets(text) {
  const targets = [];
  // Quote-aware single-pass scanner. Order matters: comments are stripped FIRST (quote-aware),
  // then continuations are joined (only to non-blank lines), then git push destinations extracted.
  // Stripping before joining prevents a comment ending in \ from swallowing the next real line.

  // FIRST PASS: Strip comments from all lines, preserving quote state
  const stripped = text.split(/\r?\n/).map((line) => {
    let code = "", quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') { code += ch + (line[++i] ?? ""); continue; }
        if (ch === quote) quote = null;
        code += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        code += ch;
      } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        break;
      } else {
        code += ch;
      }
    }
    return code;
  });

  // SECOND PASS: Join continuations (only to non-blank lines) and extract destinations
  for (let i = 0; i < stripped.length; i++) {
    let line = stripped[i];
    // Join continuation backslashes with the next non-blank line only
    while (/\\\s*$/.test(line) && i + 1 < stripped.length && stripped[i + 1].trim() !== "")
      line = line.replace(/\\\s*$/, " ") + stripped[++i].replace(/^\s+/, "");
    line = line.replace(/\\\s*$/, " ");

    // Extract destinations from git push commands in this line
    for (const [, rest] of line.matchAll(/\bgit push\b([^\n;&|]*)/g)) {
      const positional = rest.trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
      for (const spec of positional.slice(1)) {
        // slice(1) drops the remote, which is never a refspec
        const dest = spec.replace(/["']/g, "").replace(/^\+/, "").split(":").pop();
        // Normalize branch names by stripping refs/heads/ prefix, but only if the result
        // looks like a valid ref (no invalid characters like #)
        const normalized = dest.replace(/^refs\/heads\/(?=[A-Za-z0-9\/_.-]+$)/, "");
        targets.push(normalized);
      }
    }
  }
  return targets;
}

// A destination with no literal part could be anything, including the release branch:
// `git push origin "$BRANCH"` records the literal `$BRANCH`, which is not equal to "main", so the
// equality guard alone passed it. A literal prefix constrains the expansion, so `devcycle--v$V`
// — the legitimate tag push pinned by pushes-elsewhere.yml — is fine.
function isBareVariable(dest) {
  return /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)+$/.test(dest);
}

test("the push guard reads a refspec's destination, whatever form the push takes", () => {
  const flagged = pushTargets(read("tests/fixtures/push-guard/pushes-main.yml"));
  assert.equal(flagged.length, 6, `expected six pushes in the fixture, saw ${flagged.length}`);
  for (const t of flagged) assert.equal(t, RELEASE_BRANCH, `an evasive push to main read as "${t}"`);
  const allowed = pushTargets(read("tests/fixtures/push-guard/pushes-elsewhere.yml"));
  assert.ok(allowed.length > 0, "the allowed-pushes fixture has no pushes in it");
  for (const t of allowed) assert.notEqual(t, RELEASE_BRANCH, "a push that does not target main read as one");
});

test("the push guard survives the shapes that previously blinded it", () => {
  // Each of these was a real false negative or a real false positive at some point in this
  // file's history, so each is pinned rather than described.
  const BS = "\\"; // exactly one backslash — the shell line continuation these cases turn on
  assert.deepEqual(pushTargets(`        git push ${BS}\n          origin main\n`), ["main"], "a wrapped push is missed");

  // Comments are stripped before continuations are joined. Joining first let a comment ending
  // in a backslash swallow the next physical line whole — taking a real push down with it.
  const commentThenPush = `        # example: git push ${BS}\n        git push origin main\n`;
  assert.deepEqual(pushTargets(commentThenPush), ["main"], "a real push after a backslash comment is swallowed");

  // CRLF: a workflow edited on Windows must not silently disable the guard.
  assert.deepEqual(pushTargets(`        git push ${BS}\r\n          origin main\r\n`), ["main"], "a CRLF wrapped push is missed");

  // A comment that merely names a push is prose, not a push.
  assert.deepEqual(pushTargets("        # git push origin main is forbidden\n"), []);
});

test("the push guard sees a push that follows a quoted # on the same line", () => {
  // The quote-unaware strip ate to end of line, dropping this push entirely: a workflow could
  // push main and the guard would report zero destinations.
  assert.deepStrictEqual(
    pushTargets('      - run: echo "note #foo" && git push origin main\n'),
    ["main"]
  );
  assert.deepStrictEqual(
    pushTargets("      - run: echo 'note #foo' && git push origin main\n"),
    ["main"]
  );
});

test("a real comment is still stripped when the # is outside quotes", () => {
  assert.deepStrictEqual(pushTargets("# git push origin main\n"), []);
  assert.deepStrictEqual(pushTargets("echo hi # git push origin main\n"), []);
});

test("a blank line ends a continuation instead of merging two pushes", () => {
  // The `\s*` in the continuation join bridged the blank line, collapsing two statements onto one
  // physical line; the greedy scan then read the second statement's words as refspecs.
  assert.deepStrictEqual(
    pushTargets("git push origin main \\\n\ngit push origin dev\n"),
    ["main", "dev"]
  );
});

test("pushTargets keeps a real destination after a # inside a quoted refspec", () => {
  const yaml = 'run: git push origin "refs/heads/main#not-a-comment"\nrun: git push origin next\n';
  const targets = pushTargets(yaml);
  assert.deepStrictEqual(targets, ["refs/heads/main#not-a-comment", "next"]);
});

test("pushTargets does not bridge a blank line into a continuation join", () => {
  const yaml = 'run: git push \\\n\n  origin main\n';
  // A blank line between the continuation backslash and its intended next line must NOT be
  // silently bridged into one push destination — today's \s* join does exactly that.
  const targets = pushTargets(yaml);
  assert.deepStrictEqual(targets, []); // the malformed continuation yields no valid destination, not a merged wrong one
});

test("a bare-variable push destination is rejected", () => {
  assert.strictEqual(isBareVariable("$BRANCH"), true);
  assert.strictEqual(isBareVariable("${BRANCH}"), true);
  assert.strictEqual(isBareVariable("main"), false);
  // A literal prefix constrains what the variable can expand to.
  assert.strictEqual(isBareVariable("devcycle--v$V"), false);
  assert.strictEqual(isBareVariable("release/$NAME"), false);
});

test("isBareVariable flags a concatenated $A$B destination with no literal part", () => {
  assert.strictEqual(isBareVariable("$A$B"), true);
  assert.strictEqual(isBareVariable("${A}${B}"), true);
  assert.strictEqual(isBareVariable("devcycle--v$V"), false); // literal prefix still passes
});

test("the push guard catches a variable destination that could resolve to main", () => {
  const targets = pushTargets(read("tests/fixtures/push-guard/pushes-bare-variable.yml"));
  assert.ok(targets.length > 0, "fixture produced no targets — the assertion would be vacuous");
  assert.ok(targets.some(isBareVariable), "a bare-variable destination was not detected");
});

test("the legitimate tag push is not caught by the bare-variable rule", () => {
  const targets = pushTargets(read("tests/fixtures/push-guard/pushes-elsewhere.yml"));
  assert.ok(targets.length > 0);
  assert.ok(!targets.some(isBareVariable), "a literal-prefixed destination was wrongly flagged");
});

test("no workflow pushes to the release branch", () => {
  let pushes = 0;
  for (const f of readdirSync(join(root, ".github/workflows"))) {
    for (const target of pushTargets(read(`.github/workflows/${f}`))) {
      pushes++;
      assert.notEqual(target, RELEASE_BRANCH, `${f} pushes ${RELEASE_BRANCH} directly`);
      assert.ok(!isBareVariable(target),
        `${f}: push destination "${target}" is a bare variable and could resolve to ${RELEASE_BRANCH}`);
    }
  }
  assert.ok(pushes > 0, "no `git push` was found in any workflow — this guard would assert nothing");
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
  // Scoped to the document-fields list itself. A bare `t.includes(field)` passed on prose
  // elsewhere in the file — "Impact" is satisfied by the sentence at :52 and "Complexity" by
  // :53 — so deleting the list left the assertion green.
  const docFields = t.match(/\*\*Document fields[^*]*\*\*\n\n([\s\S]*?)\n\n/)?.[1];
  assert.ok(docFields, "references/findings.md no longer carries the document-fields list");
  for (const field of ["Category", "Impact", "Complexity", "Impact if unaddressed", "How to verify/reproduce", "Suggested fix direction", "Effort estimate"])
    assert.ok(docFields.includes(field), `document-tier field missing: ${field}`);
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
  assert.equal(lines.length, 14, "the state template is no longer 14 lines");
  for (const field of ["stage", "root", "branch", "request", "scope", "audit", "diagnosis", "spec", "plan", "ledger", "checklist", "run", "configured", "updated"])
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

test("the green gate step instructs both journal appends", () => {
  const text = read("playbooks/executing-waves.md");
  assert.match(text, /--kind event --event\s+gate-fail/,
    "a failing green gate must append a gate-fail event");
  assert.match(text, /--event gate-pass-clean/,
    "a clean green gate must append a gate-pass-clean event");
});

test("the run-record write-site table declares the event kind", () => {
  const row = read("references/ledger.md").split("\n").find((l) => l.startsWith("| `event` |"));
  assert.ok(row, "references/ledger.md's write-site table has no row for the event kind");
  assert.match(row, /gate-fail/);
  assert.match(row, /user-correction-at-gate/);
});

// The invariant, not today's file list: a surface that asks the user anything is a surface
// where an "Other" answer can happen, so it must point at the rule that owns the append —
// wherever that append is possible at all. It needs a run record, and a command that never
// writes a run-record line hands its playbook a run with no id to append to, so the citation
// there would be an instruction no one can follow. Both halves are derived from the surface
// rather than listed, so the exempt set moves by itself when a command starts minting a run
// record. A playbook reachable BOTH ways (`reviewing-code.md` is the audit stage as well as
// standalone `/devcycle:review`) is not exempt: on the in-cycle entry a run record exists, so
// it carries the citation conditioned on one — which is why the run-bearing commands' playbooks
// are subtracted from the exempt set below.
// references/ledger.md is the owner being cited, never a citer of itself.
const OWNER = "references/ledger.md";
const RUN_RECORD = "run-record.mjs";
const TOKEN = "user-correction-at-gate";
const OWNER_REF = `\${CLAUDE_PLUGIN_ROOT}/${OWNER}`;

// Every runtime surface file, the same four directories `scripts/validate.mjs` counts.
const surfaceFiles = () =>
  ["commands", "playbooks", "references", "agents"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `${dir}/${f}`)
  );

// `references/resume.md` § Resuming at the recorded stage is the single owner of the
// stage → playbook mapping; a command that cites it reaches every playbook that table
// routes to, exactly as if it named the path inline.
const resumePlaybooks = () =>
  [...read("references/resume.md").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(playbooks\/[A-Za-z0-9._-]+\.md)/g)].map(
    (m) => m[1]
  );

// The playbooks a command hands its run to, partitioned by whether that command has a run
// record behind it — `cycle.md` mints one, `continue.md` resumes one, everything else has none.
const playbooksReachedFrom = (runBearing) => {
  const reached = new Set();
  for (const path of surfaceFiles().filter((p) => p.startsWith("commands/"))) {
    const text = read(path);
    if (text.includes(RUN_RECORD) !== runBearing) continue;
    for (const [, target] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(playbooks\/[A-Za-z0-9._-]+\.md)/g))
      reached.add(target);
    if (text.includes(RESUME_REF)) for (const target of resumePlaybooks()) reached.add(target);
  }
  return reached;
};

// Exempt = entered with no run record on EVERY entry: reachable from a run-less command and
// from no run-bearing one. A dual-entry playbook is subtracted, because the in-cycle entry can
// append and a surface that can ever append must carry the rule.
const runlessSurfaces = () => {
  const runless = playbooksReachedFrom(false);
  for (const target of playbooksReachedFrom(true)) runless.delete(target);
  return runless;
};

// --- what counts as a gate ---------------------------------------------------------------
// A gate is a gate whatever words it uses. Keying this check on the literal `AskUserQuestion`
// let in-cycle surfaces that ask the user in their own words pass while citing nothing, so the
// detector below is a vocabulary rather than one token. It is a heuristic over prose, and its
// limits are the written-down kind rather than the implied kind:
//   - it matches phrasings, not intent, so a gate worded outside the families below reads as
//     no gate at all — which is exactly why the guards below exist;
//   - it deliberately excludes a stage that stops and reports for a decision taken outside the
//     run (`planning-waves.md`'s NO-GO verdict): that presents no options, so it has no "Other"
//     answer to append. The line between that and a gate is a judgement call, not a fact the
//     text carries;
//   - every phrase is `\s+`-joined, because this surface is hard-wrapped and one of the
//     phrasings below ("ask for\n   confirmation") straddles a line break.
// Families, not fingerprints. Each entry below used to match exactly one file, which meant the
// check recognised today's three token-free gates rather than gate-shaped prose — a rewording
// anywhere would have quietly dropped a surface out of the check instead of failing it. The
// families are still a heuristic over prose, and the two guards below still constrain them from
// both sides: every family must match some surface (dead vocabulary fails), and every surface in
// GATES_WITHOUT_THE_TOKEN must still be detected.
const GATE_PHRASES = [
  /AskUserQuestion/,
  // asking the user, in any of its inflections, for a decision or a confirmation
  /\bask(?:s|ing|ed)?\b[^.]{0,40}?\b(?:the\s+user|for\s+(?:an?\s+)?confirmation|which|whether|before)\b/i,
  // confirming with the user before acting
  /\bconfirm(?:s|ing|ed)?\b[^.]{0,30}?\b(?:with\s+the\s+user|before)\b/i,
  // the user's assent as a precondition
  /\bonly\s+the\s+user\s+may\b/i,
  /\bon\s+an\s+explicit\s+yes\b/i,
  /\bthe\s+user'?s?\s+explicit\s+(?:approval|call|decision|permission)\b/i,
  // presenting options for the user to pick from
  /\blet\s+the\s+user\s+(?:choose|decide|pick)\b/i,
  /\bONE\s+question\s+per\b/,
];
// A denial contains the gate phrasing by construction ("never asks for confirmation"), so matching
// the phrase alone counted a surface that states it gates nothing as a gate, and then demanded a
// citation for a journal entry it never writes. Same defect, and same fix, as NEGATES_APPEND below:
// decide by the sentence's polarity rather than by whether the words occur. Sentence-scoped on
// purpose — a denial in one sentence must not silence a real gate in the next — and clause-scoped
// within the sentence: the window stops at `,`, `;` and `:` as well as `.`, because a negation
// belonging to an earlier clause ("No prior scaffold exists, so ask ...") does not govern the ask
// that follows it, and reading it as one silenced real gates.
const NEGATES_GATE = /\b(?:never|not|no|none|nothing|nor|doesn't|does\s+not|won't|will\s+not)\b[^.,;:]{0,60}?\b(?:ask|asks|asking|asked|question|confirmation|AskUserQuestion)\b/i;
const gatesUser = (text) =>
  text
    .split(/(?<=\.)\s+/)
    .some((sentence) => GATE_PHRASES.some((phrase) => phrase.test(sentence)) && !NEGATES_GATE.test(sentence));

// The surfaces that gate the user without ever writing `AskUserQuestion`. Named so that the
// vocabulary above cannot silently stop matching them.
const GATES_WITHOUT_THE_TOKEN = [
  "playbooks/verifying-on-device.md",
  "playbooks/reviewing-the-branch.md",
  "playbooks/finishing-the-cycle.md",
];

// --- what a citation claims ---------------------------------------------------------------
// `references/ledger.md`'s rule has three outcomes, not two: a gate appends exactly when a run
// record exists at that moment. So a surface that gates either states the append (affirmative),
// states that no append is possible where it sits (negative — `references/config.md`'s
// walkthrough runs before `/devcycle:cycle` mints the record), or is exempt. Asking only whether
// the token and the owner path appear could not tell the first two apart, which made a citation
// claiming a journal that cannot happen indistinguishable from a correct one.
// A conditional citation ("appends ... when this stage runs inside a cycle run") is affirmative:
// the append does happen on the entry where a run record exists.
// A block that names the token and the owner but neither claims nor denies the append is
// `unclear`, and satisfies neither position — a rule the reader cannot act on is the failure
// this check exists to catch, so it fails loudly instead of counting as cited.
// A denial contains the affirmative verb by construction ("never appends", "does not append"),
// so testing AFFIRMATIVE before NEGATIVE — or the reverse — both decide polarity by which array
// happens to run first over text that matches both, not by the sentence's actual polarity. The
// guard below is negation-aware instead: a block reads affirmative only if it contains the
// affirmative verb with no negation word governing it nearby, in the same sentence. That is a
// heuristic over prose, not a parser, and it has known blind spots — named here rather than left
// for the check to silently miss:
//   - it covers negation immediately before the verb ("never appends", "does not append", "no …
//     is appended") within one sentence — the scan window stops at the next `.`, so a negation in
//     an earlier or later sentence of the same block is not seen;
//   - a negation word elsewhere in the *same* sentence, unrelated to the append, can still
//     suppress a genuine affirmative — a false negative, which is the safer direction for a check
//     whose job is proving the append is real rather than assuming it.
const NEGATES_APPEND = /\b(?:never|not|no|none|nothing|nor|doesn't|does\s+not|won't|will\s+not)\b[^.]{0,60}?\bappend/i;
const AFFIRMATIVE = [/\bappends\s+`user-correction-at-gate`/];
const NEGATIVE = [
  /\bnone\s+of\s+them\s+journals\b/i,
  /\bjournals\s+(?:no|none)\b/i,
  /\bappends\s+nothing\b/i,
  /\bnever\s+appends\b/i,
  /\bdoes\s+not\s+append\b/i,
  /\bno\b[^.]{0,60}?\bis\s+appended\b/i,
];
const citationBlocks = (text) =>
  text.split(/\n\s*\n/).filter((block) => block.includes(TOKEN) && block.includes(OWNER_REF));

const citationVerdict = (text) => {
  const blocks = citationBlocks(text);
  if (blocks.length === 0) return "none";
  const isNegative = (block) => NEGATIVE.some((phrase) => phrase.test(block)) || NEGATES_APPEND.test(block);
  const isAffirmative = (block) => AFFIRMATIVE.some((phrase) => phrase.test(block)) && !isNegative(block);
  if (blocks.some(isAffirmative)) return "affirmative";
  if (blocks.some(isNegative)) return "negative";
  return "unclear";
};

// --- attributing a citation to the gate it covers -----------------------------------------
// citationVerdict over a whole file answered "does this file cite anywhere", which a file with
// several gates satisfies with one paragraph. Sections answer "does this gate cite". Ancestors
// count: references/config.md states its negative polarity once, in the `## First-run
// configuration` section whose three subsections do the gating, and demanding three restatements
// of one rule is the duplication this repo's own conventions forbid.
// Fenced blocks are skipped, because a heading-shaped line inside one is not a heading: this
// surface ships file templates (`references/resume.md`'s ```markdown state file opens with
// `# devcycle state`), and reading those as real headings opened a phantom section that swallowed
// the enclosing section's citation and re-parented every later section onto it — the same
// cross-section absolution this whole check exists to remove, one level down.
const sectionTree = (text) => {
  const root = { heading: "(preamble)", level: 0, own: [], parent: null };
  let current = root;
  const all = [root];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+\S/.exec(line);
    if (!m) { current.own.push(line); continue; }
    const level = m[1].length;
    let parent = current;
    while (parent.level >= level) parent = parent.parent;
    current = { heading: line.trim(), level, own: [], parent };
    all.push(current);
  }
  return all;
};
const ownText = (node) => node.own.join("\n");
// A section's verdict is its own, or the nearest ancestor's that takes a position at all.
const sectionVerdict = (node) => {
  for (let n = node; n; n = n.parent) {
    const verdict = citationVerdict(ownText(n));
    if (verdict !== "none") return verdict;
  }
  return "none";
};
const gatingSections = (text) =>
  sectionTree(text)
    .filter((node) => gatesUser(ownText(node)))
    .map((node) => ({ heading: node.heading, verdict: sectionVerdict(node) }));

// Sections whose gate vocabulary matches a *description* of a gate that runs elsewhere, not a gate
// the section itself runs. Measured, not assumed, against the surfaces as they stand. Guarded below
// — an entry naming a section that no longer exists, or no longer matches the vocabulary, fails
// rather than sitting stale.
const DESCRIBES_NOT_GATES = [
  // Describes what the brainstorm stage does with AskUserQuestion; cycle.md's own gate is in
  // `## Triage the input`, which cites correctly.
  "commands/cycle.md § ## Stage walk",
  // States that the user already confirmed at triage, in cycle.md — this playbook runs after that
  // gate and never re-litigates the verdict, as its own next sentence says.
  "playbooks/sweeping-mechanical-changes.md § # Sweeping Mechanical Changes",
  // Says the affected-areas list is one "confirmed ... with the user"; the confirming itself is the
  // interview in `## The discipline`, which cites the write site. This section writes the summary
  // the interview produced and asks nothing of its own.
  "playbooks/scoping-the-request.md § ## Output and handoff",
];

// A gate that runs before any run record exists must say so, rather than claim an append that
// cannot happen there. Listed, not derived: "before the mint" is a fact about when the text runs,
// and nothing in the file structure carries it — `references/config.md`'s walkthrough is reached
// from `commands/cycle.md` exactly like the stages that do append. The list going stale is
// guarded in the test: an entry that stops gating, or that stops running before the mint, fails.
const PRE_MINT_SURFACES = ["references/config.md"];
// The command each pre-mint entry is reached from, and the mint call its hand-off must precede —
// listed here rather than derived for the same reason PRE_MINT_SURFACES is: "which command mints
// after handing off to this entry" is not carried anywhere in the file structure, either. Both
// lists have one entry today; a second pre-mint surface would need a citer of its own.
const PRE_MINT_CITER = "commands/cycle.md";
const MINT_CALL = `${RUN_RECORD} new`;

test("the gate vocabulary still sees the surfaces that gate the user without naming AskUserQuestion", () => {
  const files = surfaceFiles();
  for (const path of GATES_WITHOUT_THE_TOKEN) {
    assert.ok(
      gatesUser(read(path)),
      `${path} gates the user in words GATE_PHRASES no longer matches — add the new wording to the vocabulary ` +
        `rather than letting this check go quiet on that surface`
    );
  }
  // The point of this list is proving the vocabulary reaches past the literal token, which needs
  // only one of the three to lack it — not all three. Requiring every entry to lack the token
  // means a benign edit that adds it to just one of them (still caught by GATE_PHRASES on words
  // other than the token) turns CI red with no defect to fix. Requiring none of the three to lack
  // it would be the opposite failure: the proof would go quiet with all three silently converted.
  const stillWordOnly = GATES_WITHOUT_THE_TOKEN.filter((path) => !read(path).includes("AskUserQuestion"));
  assert.ok(
    stillWordOnly.length > 0,
    `every surface in GATES_WITHOUT_THE_TOKEN now names AskUserQuestion literally (${GATES_WITHOUT_THE_TOKEN.join(", ")}); ` +
      `either add the wording one of them switched to into GATE_PHRASES, or drop that surface from this list — ` +
      `the list needs at least one entry the vocabulary catches without the literal token`
  );
  // Dead vocabulary is worse than none: a phrase matching nothing reads as coverage it has not got.
  for (const phrase of GATE_PHRASES)
    assert.ok(
      files.some((p) => phrase.test(read(p))),
      `no surface matches ${phrase} — the phrase is dead vocabulary and overstates what this check covers`
    );
});

test("an affirmative citation and a negative declaration are told apart", () => {
  const preMint = read(PRE_MINT_SURFACES[0]);
  assert.equal(
    citationVerdict(preMint),
    "negative",
    `${PRE_MINT_SURFACES[0]} gates before any run record exists, so its citation must read as a declaration that ` +
      `nothing is journalled there — not merely as present`
  );

  // Flip that declaration into the claim its own position rules out. The verdict must flip with
  // it: this is the polarity that CI could previously not see, in either direction.
  const flipped = preMint.replace(/none of them journals one/, "each of them appends `user-correction-at-gate`");
  assert.notEqual(flipped, preMint, `${PRE_MINT_SURFACES[0]}'s negative wording changed — this flip tests nothing`);
  assert.equal(citationVerdict(flipped), "affirmative", "a claim that the gate journals still reads as a negative");

  // A surface that must cite affirmatively is not satisfied by the negative wording, however
  // faithfully that wording names the token and the owner.
  const negativeBlock = citationBlocks(preMint)[0];
  assert.ok(negativeBlock, `${PRE_MINT_SURFACES[0]} carries no citation block to reuse`);
  assert.equal(
    citationVerdict(`Interview via AskUserQuestion.\n\n${negativeBlock}`),
    "negative",
    "a gate that must cite affirmatively is satisfied by a declaration that nothing is journalled"
  );

  // The remaining verdicts: a real affirmative citer, a text that cites nothing, and a mention
  // that takes no position at all.
  assert.equal(citationVerdict(read("commands/cycle.md")), "affirmative");
  assert.equal(citationVerdict("This stage asks the user nothing about journalling."), "none");
  assert.equal(citationVerdict(`A gate here relates to \`${TOKEN}\`, per \`${OWNER_REF}\`.`), "unclear");
});

test("a denial reads negative through wordings other than the one flip above exercises", () => {
  // Same defect the flip above closed, reachable through different wording: the affirmative
  // pattern (`appends \`user-correction-at-gate\``) matches as a substring of each of these
  // denials, so a check that decides polarity by array order — whichever list it tests first —
  // grades a surface declaring it journals nothing as satisfying the requirement to journal.
  assert.equal(
    citationVerdict(`This surface never appends \`${TOKEN}\`, per \`${OWNER_REF}\`.`),
    "negative",
    `a denial worded "never appends" must read negative, not affirmative`
  );
  assert.equal(
    citationVerdict(`This surface does not append \`${TOKEN}\` here, per \`${OWNER_REF}\`.`),
    "negative",
    `a denial worded "does not append" must read negative, not affirmative`
  );
  assert.equal(
    citationVerdict(`At this point, no \`${TOKEN}\` is appended, per \`${OWNER_REF}\`.`),
    "negative",
    `a denial worded "no ... is appended" must read negative, not affirmative`
  );
});

test("every in-cycle surface that gates the user cites the write site with the polarity its position requires", () => {
  const files = surfaceFiles();
  assert.ok(files.length > 0, "no surface file was scanned — every assertion below would run over nothing");
  assert.ok(
    files.some((p) => read(p).includes(`${RUN_RECORD} new`)),
    `no surface mints a run record (\`${RUN_RECORD} new\`) — the whole surface would read as exempt`
  );
  const exempt = runlessSurfaces();
  assert.ok(exempt.size > 0, "no command outside the cycle hands its run to a playbook — the exemption derived nothing");
  const gating = files.filter((p) => p !== OWNER && gatesUser(read(p)));
  assert.ok(gating.length > 0, "no surface gates the user — every assertion below would run over nothing");
  assert.ok(
    gating.length > files.filter((p) => p !== OWNER && read(p).includes("AskUserQuestion")).length,
    "the vocabulary sees no more than the literal AskUserQuestion token — the widening is not live"
  );

  // The subtraction itself, guarded: a playbook both a run-less and a run-bearing command reach
  // can append on the in-cycle entry, so it is never exempt. Drop the subtraction and this fails.
  const dualEntry = [...playbooksReachedFrom(false)].filter((p) => playbooksReachedFrom(true).has(p));
  assert.ok(dualEntry.length > 0, "no playbook is reachable both standalone and in-cycle — the check below would prove nothing");
  assert.deepEqual(
    dualEntry.filter((p) => exempt.has(p)),
    [],
    `these playbooks are reachable inside a cycle run, where a run record exists, yet the exempt set still excuses ` +
      `them from citing the write site: ${dualEntry.filter((p) => exempt.has(p)).join(", ")}`
  );

  // Whether each gating *section* cites is asserted by "every gating section of every in-cycle
  // surface cites the write site" below; this test keeps the properties that are about files and
  // ordering rather than about individual gates.

  // A pre-mint surface is a gate like any other, so the list is trustworthy only while it still
  // gates and its citation still reads negative. (`!exempt.has(path)` used to stand here too, but
  // it could never fail: `exempt` is built from `playbooksReachedFrom`, which only ever collects
  // `playbooks/…` targets, so a `references/…` entry can never appear in it regardless of whether
  // the entry is actually exempt. Dropped rather than kept as an assertion whose only job was
  // looking thorough — the ordering check below tests the real property this one gestured at.)
  for (const path of PRE_MINT_SURFACES) {
    assert.ok(gatesUser(read(path)), `${path} is listed as a pre-mint gate but no longer gates the user`);
    assert.equal(
      citationVerdict(read(path)),
      "negative",
      `${path} gates before the run record is minted, so it must state that nothing is journalled there; ` +
        `its citation reads "${citationVerdict(read(path))}"`
    );
  }

  // The property that actually defines "pre-mint" — that this entry's gate runs before the run
  // record is minted — is a fact about `${PRE_MINT_CITER}`'s own text order: it hands off to each
  // entry, then mints. Nothing above tests that ordering, so a mint moved earlier in that command
  // would leave a now-wrong entry silently in place. Derived from the citer's text rather than
  // listed a second time, so the two lists cannot drift from each other.
  const citer = read(PRE_MINT_CITER);
  assert.ok(
    citer.includes(MINT_CALL),
    `${PRE_MINT_CITER} no longer mints a run record (\`${MINT_CALL}\`) — the pre-mint ordering check has nothing to compare against`
  );
  for (const path of PRE_MINT_SURFACES) {
    const handoff = `\${CLAUDE_PLUGIN_ROOT}/${path}`;
    assert.ok(
      citer.includes(handoff),
      `${PRE_MINT_CITER} no longer hands off to ${path} — the pre-mint listing has nothing to anchor its ordering to`
    );
    assert.ok(
      citer.indexOf(handoff) < citer.indexOf(MINT_CALL),
      `${PRE_MINT_CITER} now mints the run record before handing off to ${path} — that entry no longer runs before ` +
        `any run record exists, so it must either cite affirmatively or be dropped from PRE_MINT_SURFACES`
    );
  }

  const unfollowable = [...exempt].filter((path) => read(path).includes(TOKEN));
  assert.deepEqual(
    unfollowable,
    [],
    `these surfaces are reached from a command that mints no run record, so there is nothing to append to, ` +
      `yet they instruct the append anyway: ${unfollowable.join(", ")}`
  );
});

test("harvested: resume/stage-table — one table maps every stage to its playbook, and both commands cite it", () => {
  const resume = read("references/resume.md");
  const cycle = read("commands/cycle.md");
  const enumMatch = cycle.match(/stage:\s*<([a-z|-]+)>/);
  assert.ok(enumMatch, "commands/cycle.md no longer declares the stage enum this table is checked against");
  const stages = enumMatch[1].split("|");
  assert.ok(stages.length > 5, `the stage enum parsed to ${stages.length} entries — the split changed shape`);

  assert.match(resume, /^## Resuming at the recorded stage$/m);
  for (const stage of stages) {
    if (stage === "done") continue; // a closed cycle resumes at nothing
    assert.match(
      resume,
      new RegExp(`^\\|\\s*\`${stage}\`\\s*\\|`, "m"),
      `references/resume.md's stage table has no row for \`${stage}\` — a stage was added to the enum without a resume route`
    );
  }

  // The duplication this table exists to remove: neither command may carry a second copy.
  for (const [path, text] of [["commands/continue.md", read("commands/continue.md")], ["commands/cycle.md", cycle]]) {
    const rows = stages.filter((s) => new RegExp(`^\\|\\s*\`?${s}\`?\\s*\\|`, "m").test(text));
    assert.deepEqual(
      rows,
      [],
      `${path} restates the stage table (rows: ${rows.join(", ")}) — it must cite references/resume.md instead`
    );
    assert.ok(
      text.includes("${CLAUDE_PLUGIN_ROOT}/references/resume.md"),
      `${path} no longer cites references/resume.md, which now owns the stage table`
    );
  }
});

test("the gate vocabulary reads a denial as no gate, the way the citation check reads a denial as negative", () => {
  // The defect: GATE_PHRASES matched "asks for confirmation" wherever it appeared, so a surface
  // stating it never asks was counted as gating and required to cite a journal entry it never writes.
  assert.equal(gatesUser("This stage never asks the user for confirmation."), false);
  assert.equal(gatesUser("This stage does not ask for confirmation before proceeding."), false);
  assert.equal(gatesUser("No confirmation is asked for here."), false);

  // The positive control: a real gate still reads as one, in the same words the surfaces use.
  assert.equal(gatesUser("Ask the user for confirmation before switching branches."), true);
  assert.equal(gatesUser("Interview via AskUserQuestion."), true);
  assert.equal(gatesUser("Only the user may grant another round."), true);

  // Negation is sentence-scoped, so a denial in one sentence cannot silence a gate in the next.
  assert.equal(
    gatesUser("This stage never asks for confirmation. A later step does ask the user for confirmation."),
    true
  );
});

test("the gate vocabulary recognises gate-shaped prose, not only the three phrasings in use today", () => {
  // The carry-over: every phrase matched exactly one file, so the check recognised today's gates
  // rather than gates. These are phrasings no surface uses yet; each must still read as a gate.
  for (const phrasing of [
    "Ask the user which one before resuming.",
    "Confirm with the user before any edit.",
    "This requires the user's explicit approval.",
    "Present the options and let the user choose.",
    "Stop and ask before overwriting it.",
  ])
    assert.equal(gatesUser(phrasing), true, `gate-shaped prose read as no gate: ${phrasing}`);

  // And the other side: prose that merely mentions users or decisions is not a gate.
  for (const phrasing of [
    "The user's recollection is not evidence.",
    "This stage writes the report and moves on.",
    "The coordinator decides which lens applies.",
  ])
    assert.equal(gatesUser(phrasing), false, `non-gating prose read as a gate: ${phrasing}`);
});

test("a negation governing a different clause does not silence a gate in the same sentence", () => {
  // The carry-over: the negation window ran to the end of the sentence, so a "No" belonging to an
  // unrelated clause silenced a real gate standing after it. The window stops at a clause boundary
  // instead, which is what "the negation governs the ask" means in prose this check can read.
  assert.equal(gatesUser("No prior scaffold exists, so ask ONE AskUserQuestion before continuing."), true);
  assert.equal(gatesUser("Drift findings are not candidates: they keep their own AskUserQuestion batching."), true);

  // The denials the guard exists for are unaffected — there the negation does govern the ask.
  assert.equal(gatesUser("This stage never asks the user for confirmation."), false);
  assert.equal(gatesUser("No confirmation is asked for here."), false);
});

test("citation attribution is per section, and a section inherits its ancestors' citation", () => {
  const cite = `appends \`${TOKEN}\`, whose rule \`${OWNER_REF}\` owns`;

  // One citation in one section does not cover a gate in a sibling section.
  const twoSections = `# Thing\n\n## First\n\nInterview via AskUserQuestion. It ${cite}.\n\n## Second\n\nAsk the user for confirmation before acting.\n`;
  const uncited = gatingSections(twoSections).filter((s) => s.verdict !== "affirmative");
  assert.deepEqual(
    uncited.map((s) => s.heading),
    ["## Second"],
    "a gate in an uncited sibling section was treated as covered by the other section's citation"
  );

  // A subsection inherits the citation of the section it sits under — which is what makes the
  // rule correct rather than merely strict: references/config.md states its polarity once, in the
  // parent of the three subsections that gate.
  const nested = `# Thing\n\n## Parent\n\nThe stage ${cite}.\n\n### Child\n\nAsk the user for confirmation.\n`;
  assert.deepEqual(
    gatingSections(nested).filter((s) => s.verdict !== "affirmative"),
    [],
    "a gating subsection was not covered by its parent section's citation"
  );
});

test("inheritance runs one way: a subsection's citation does not cover a gate in its parent", () => {
  // The fourth attribution direction, and the one that would fail silently: `sectionVerdict` walks
  // upward only, so a citation buried in a subsection must not absolve the gate standing in the
  // parent's own text. Correct today; unpinned until now, so a walk made bidirectional to "be
  // lenient" would have passed CI.
  const cite = `appends \`${TOKEN}\`, whose rule \`${OWNER_REF}\` owns`;
  const text = `# Thing\n\n## Parent\n\nAsk the user for confirmation before acting.\n\n### Child\n\nThe stage ${cite}.\n`;
  assert.deepEqual(
    gatingSections(text).map((s) => `${s.heading} (${s.verdict})`),
    ["## Parent (none)"],
    "a gate was treated as covered by a citation sitting in one of its own subsections"
  );
});

test("a heading-shaped line inside a fenced block does not open a section", () => {
  // The defect this pins: `references/resume.md`'s state-file template contains the literal line
  // `# devcycle state` inside a ```markdown fence. Parsed as a heading, it opened a phantom H1 that
  // swallowed `## The state file`'s own citation and re-parented every later section onto itself —
  // so a gate two sections away inherited a citation that was never about it. That is the
  // cross-section absolution this whole check exists to remove, one level down.
  const cite = `appends \`${TOKEN}\`, whose rule \`${OWNER_REF}\` owns`;
  const fenced = [
    "# Doc",
    "",
    "## Template",
    "",
    "```markdown",
    "# devcycle state",
    "- stage: <a stage>",
    "```",
    "",
    `The stage ${cite}.`,
    "",
    "## Later",
    "",
    "Ask the user for confirmation before acting.",
    "",
  ].join("\n");

  assert.deepEqual(
    sectionTree(fenced).map((s) => s.heading),
    ["(preamble)", "# Doc", "## Template", "## Later"],
    "a heading-shaped line inside a fence was parsed as a real heading"
  );
  assert.deepEqual(
    gatingSections(fenced).map((s) => `${s.heading} (${s.verdict})`),
    ["## Later (none)"],
    "a gating section inherited a citation from a section it does not sit under"
  );
});

test("every gating section of every in-cycle surface cites the write site, or is a named descriptive mention", () => {
  const exempt = runlessSurfaces();
  const offenders = [];
  for (const path of surfaceFiles()) {
    if (path === OWNER || exempt.has(path) || PRE_MINT_SURFACES.includes(path)) continue;
    for (const section of gatingSections(read(path))) {
      const entry = `${path} § ${section.heading}`;
      if (DESCRIBES_NOT_GATES.includes(entry)) continue;
      if (section.verdict !== "affirmative") offenders.push(`${entry} (${section.verdict})`);
    }
  }
  assert.deepEqual(offenders, [], `these sections gate inside a cycle run but cite no write site: ${offenders.join(", ")}`);
});

test("the descriptive-mention allowlist cannot go stale", () => {
  for (const entry of DESCRIBES_NOT_GATES) {
    const [path, heading] = entry.split(" § ");
    const sections = gatingSections(read(path));
    assert.ok(
      sections.some((s) => s.heading === heading),
      `${entry} is allowlisted as a descriptive mention, but that section no longer exists or no longer ` +
        `matches the gate vocabulary — drop the entry rather than leaving it to excuse nothing`
    );
  }
});
