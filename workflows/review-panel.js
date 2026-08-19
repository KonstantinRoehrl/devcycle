#!/usr/bin/env node
// review-panel.js — read-only multi-lens branch review panel (devcycle P6).
//
// Invoked by skills as:
//   node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '<json-args>'
// (${CLAUDE_PLUGIN_ROOT} substitutes in skill/command content; it is NOT an
// env var here — everything the script needs arrives via argv. See
// docs/platform-notes.md section (c).)
//
// Args (argv[2], JSON):
//   { scope: {ref: string} | {paths: string[]},   // exactly one of the two
//     specPath?: string,
//     lenses?: (string | {key: string, charter: string})[],
//     crossModel?: boolean }
// Output (stdout, JSON):
//   { findings: [{ file, line: integer|null, claim,
//                  severity: "critical"|"high"|"medium"|"low",
//                  measuredAgainst, lens, verified: boolean, verification: string }],
//     notes: string[],      // coverage reductions and lens failures, verbatim
//     summary: string }     // opens with a COVERAGE WARNING when an input was truncated
// The finding shape is owned by references/findings.md; keep the two in step.
//
// Stages: 1) read-only lens reviewers in parallel — the caller's lenses when
// `lenses` is given, the three built-ins (spec, correctness, simplify)
// otherwise, minus the spec lens when no specPath is given (dropped, and
// disclosed in `notes`); cross-model codex lens only when crossModel ->
// 2) adversarial per-finding verification, its method spliced from
// agents/red-team-reviewer.md (unverified findings are marked, never
// dropped) -> 3) dedup by file+claim -> 4) reconciler ranks confirmed
// findings by severity.
//
// STRICTLY READ-ONLY: the script itself only runs `git diff`/`git rev-parse`;
// every claude subagent is restricted to --tools "Read,Grep,Glob" and the
// codex lens runs with --sandbox read-only. Nothing here mutates files or git.
//
// Optional env: DEVCYCLE_PANEL_MODEL sets --model for the claude subagents
// (unset -> the CLI's configured default model).
//
// Exit codes: 0 = report on stdout; 1 = fatal error (message on stderr).
//
// Smoke-tested (sandbox git repo with a planted spec deviation):
//   node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" \
//     '{"scope":{"ref":"HEAD~1"},"specPath":"docs/spec.md","lenses":["spec","correctness"]}'

"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const { makeLogger, run, claudeStructured: claudeStructuredCli } = require("./lib/agent-cli.js");

const DIFF_CHAR_CAP = 60_000;
const SPEC_CHAR_CAP = 30_000;
const VERIFY_CONCURRENCY = 4;
// Stage 1 fans out lenses x diff-chunks; an oversize diff split into N chunks
// would otherwise spawn lenses*N claude processes at once, plus one codex per
// chunk under crossModel. Same cap as stage 2's verification, same reason.
const LENS_CONCURRENCY = 4;
const SEVERITIES = ["critical", "high", "medium", "low"];
const LENS_CHARTERS = {
  spec:
    "Spec compliance: compare the diff against the spec below. Report every place the " +
    "implementation deviates from, omits, or contradicts a spec requirement.",
  correctness:
    "Correctness and security: bugs, broken edge cases, race conditions, injection or " +
    "unsafe input handling, missing error handling, incorrect logic.",
  simplify:
    "Simplification: needless complexity, duplication, dead code, or a clearly simpler " +
    "alternative that preserves behavior. Only report simplifications worth acting on.",
};

const { log, fatal } = makeLogger("review-panel");

// ---------- generic subprocess helpers ----------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Panel-side binding of the shared structured-agent call: two attempts, so one
// transport or validation failure is retried, and the panel's own error
// vocabulary. Its three call sites are unchanged.
const PANEL_ERRORS = { agent: "claude subagent", output: "claude", cap: 500 };
const claudeStructured = (opts) => claudeStructuredCli({ ...opts, attempts: 2, errors: PANEL_ERRORS });

// ---------- args + repo inputs ----------

function parseArgs() {
  let args;
  try {
    args = JSON.parse(process.argv[2] ?? "");
  } catch {
    fatal("argv[2] must be a JSON object: { scope, specPath?, lenses?, crossModel? }");
  }
  const scope = args.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    fatal("args.scope (object) is required: { ref: string } or { paths: string[] }");
  }
  const hasRef = typeof scope.ref === "string" && scope.ref !== "";
  const hasPaths =
    Array.isArray(scope.paths) &&
    scope.paths.length > 0 &&
    scope.paths.every((p) => typeof p === "string" && p !== "");
  if (hasRef === hasPaths) {
    fatal("args.scope must carry exactly one of ref (non-empty string) or paths (non-empty string[])");
  }
  if (args.specPath !== undefined && (typeof args.specPath !== "string" || !args.specPath)) {
    fatal("args.specPath, when given, must be a non-empty string");
  }
  const defaulted = args.lenses === undefined;
  const requested = defaulted ? Object.keys(LENS_CHARTERS) : args.lenses;
  if (!Array.isArray(requested) || requested.length === 0) {
    fatal("args.lenses must be a non-empty array of built-in keys and/or { key, charter } objects");
  }
  const lenses = requested.map((l) => {
    if (typeof l === "string") {
      if (!(l in LENS_CHARTERS)) {
        fatal(`unknown built-in lens "${l}" (built-ins: ${Object.keys(LENS_CHARTERS).join("|")})`);
      }
      return { key: l, charter: LENS_CHARTERS[l] };
    }
    if (l && typeof l.key === "string" && l.key && typeof l.charter === "string" && l.charter) {
      return { key: l.key, charter: l.charter };
    }
    return fatal("each lens must be a built-in key or { key, charter } with non-empty strings");
  });
  // The spec lens needs a spec. Asking for it without one is an arg error; getting it
  // from the default set without one just drops it, so a spec-less scope still runs.
  // The drop is a coverage reduction, so it is reported back for disclosure in `notes`.
  let selected = lenses;
  let specLensDropped = false;
  if (!args.specPath && lenses.some((l) => l.key === "spec")) {
    if (!defaulted) fatal('the "spec" lens requires args.specPath');
    selected = lenses.filter((l) => l.key !== "spec");
    specLensDropped = true;
  }
  return {
    scope: hasRef ? { ref: scope.ref } : { paths: scope.paths },
    specPath: typeof args.specPath === "string" ? args.specPath : null,
    lenses: selected,
    specLensDropped,
    crossModel: args.crossModel === true,
  };
}

function gitReadOnly(argv) {
  try {
    return execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    fatal(`git ${argv.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

// The cap bounds a single reviewer prompt. An oversize diff is chunked across reviewer passes
// (chunkDiff, at file then hunk boundaries) so the whole diff is reviewed, not a sample; only a
// lone hunk larger than the cap is still truncated, and that case alone carries a coverage note.
function truncate(text, cap, label) {
  if (text.length <= cap) return { text, note: null, truncated: false };
  const pct = ((cap / text.length) * 100).toFixed(1);
  return {
    text: text.slice(0, cap) + `\n[... truncated at ${cap} chars ...]`,
    note: `${label} truncated to ${cap} of ${text.length} chars (${pct}% reached the reviewers)`,
    truncated: true,
  };
}

// Split a unified diff into review chunks each <= cap chars, at file then hunk boundaries.
// Returns { chunks, notes }. notes is non-empty only when a single hunk exceeds cap and had
// to be truncated — the one path that still reduces coverage after chunking.
function chunkDiff(diff, cap) {
  const notes = [];
  if (!diff) return { chunks: [], notes };
  if (diff.length <= cap) return { chunks: [diff], notes };

  const units = [];
  let truncatedHunks = 0;
  for (const fileSeg of splitByPrefix(diff, "diff --git ")) {
    if (fileSeg.length <= cap) {
      units.push(fileSeg);
      continue;
    }
    for (const hunk of splitFileIntoHunks(fileSeg)) {
      if (hunk.length <= cap) {
        units.push(hunk);
      } else {
        const suffix = `\n[... hunk truncated at ${cap} chars ...]`;
        units.push(hunk.slice(0, Math.max(0, cap - suffix.length)) + suffix);
        truncatedHunks++;
      }
    }
  }
  // One consolidated note, not one per hunk: a per-hunk note repeats the same sentence in the
  // COVERAGE WARNING banner and the report's notes array when more than one hunk is truncated.
  if (truncatedHunks === 1) {
    notes.push(`a single diff hunk exceeded ${cap} chars and was truncated`);
  } else if (truncatedHunks > 1) {
    notes.push(`${truncatedHunks} diff hunks exceeded ${cap} chars and were truncated`);
  }

  const chunks = [];
  let cur = "";
  for (const unit of units) {
    if (cur && cur.length + unit.length + 1 > cap) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${unit}` : unit;
  }
  if (cur) chunks.push(cur);
  return { chunks, notes };
}

// Split text into segments each beginning at a line that starts with prefix. Any text before
// the first such line stays attached to the first segment.
function splitByPrefix(text, prefix) {
  const segments = [];
  let cur = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix) && cur.length) {
      segments.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) segments.push(cur.join("\n"));
  return segments;
}

// Split one file's diff segment into hunk-sized pieces, prepending the file header (everything
// before the first "@@ " line) to EVERY hunk so each piece is self-describing with its path — a
// chunk that carries only later hunks must still name its file, or a lens reviewing it cannot
// attribute a finding. A file segment always begins with a "diff --git " header, never a "@@ "
// line, so parts[0] is always that header.
function splitFileIntoHunks(fileSeg) {
  const parts = splitByPrefix(fileSeg, "@@ ");
  if (parts.length <= 1) return parts;
  const [header, ...hunks] = parts;
  return hunks.map((hunk) => `${header}\n${hunk}`);
}

// ---------- stage 1: lens reviewers ----------

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          claim: { type: "string" },
          severity: { enum: SEVERITIES },
          measuredAgainst: { type: "string" },
        },
        required: ["file", "claim", "severity", "measuredAgainst"],
      },
    },
  },
  required: ["findings"],
};

function lensPrompt(charter, ctx) {
  return [
    `You are one lens of a read-only review panel. Your single lens:`,
    charter,
    ``,
    `You review the ${ctx.scopeLabel} in the repository at your working directory. You may`,
    `use Read/Grep/Glob to inspect surrounding code, but you are strictly read-only. Report`,
    `only concrete, evidenced findings for YOUR lens — no restated diff hunks, no style nits`,
    `outside your charter. For each finding give the file path (repo-relative), the line in`,
    `the reviewed version when known, a one-to-two sentence claim in plain language (symptom`,
    `first), a severity, and what the finding is measured against.`,
    ``,
    `Severity: critical (data loss, a security hole, or a broken release path), high (broken`,
    `behavior or a violation of what the spec requires), medium (a likely defect or`,
    `meaningful deviation worth fixing), low (a worthwhile improvement).`,
    ``,
    `"measuredAgainst" names the repo convention (by file path) or the external source the`,
    `finding is measured against. A finding measured against neither is an unsupported`,
    `opinion: do not report it. Return an empty findings array if your lens finds nothing.`,
    ...(ctx.spec ? [``, `## Spec (${ctx.specPath})`, ctx.spec] : []),
    ``,
    ctx.diff === null ? `## Files under review` : `## Changed files`,
    ctx.fileList || "(none)",
    ...(ctx.diff === null ? [] : [``, `## Diff`, ctx.diff || "(empty diff)"]),
  ].join("\n");
}

async function runClaudeLens(lens, ctx, model) {
  log(`lens "${lens.key}" reviewing...`);
  const res = await claudeStructured({
    prompt: lensPrompt(lens.charter, ctx),
    tools: "Read,Grep,Glob",
    schema: FINDINGS_SCHEMA,
    model,
  });
  if (!res.ok) return { lens: lens.key, findings: [], note: `lens "${lens.key}" failed: ${res.error}` };
  const findings = (res.value.findings ?? [])
    .filter((f) => f && typeof f.file === "string" && typeof f.claim === "string")
    .map((f) => ({
      file: f.file,
      line: Number.isInteger(f.line) ? f.line : null,
      claim: f.claim,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
      measuredAgainst:
        typeof f.measuredAgainst === "string" && f.measuredAgainst.trim() ? f.measuredAgainst : "unstated",
      lens: lens.key,
    }));
  log(`lens "${lens.key}": ${findings.length} finding(s)`);
  return { lens: lens.key, findings, note: null };
}

// Cross-model lens via the codex CLI (read-only sandbox). Degrades gracefully:
// if codex is unavailable or its output is unusable, the lens is skipped with
// a note in the summary — the panel itself still succeeds.
async function runCrossModelLens(ctx) {
  log(`lens "cross-model" (codex) reviewing...`);
  const outDir = mkdtempSync(join(os.tmpdir(), "devcycle-panel-"));
  const outFile = join(outDir, "last-message.txt");
  try {
    const prompt = [
      lensPrompt(LENS_CHARTERS.correctness, ctx),
      ``,
      `Cross-model pass: you are a second, independent model auditing this diff for`,
      `anything the primary reviewers may have missed (any lens). Respond with ONLY a`,
      `JSON object: {"findings":[{"file":string,"line":integer|null,"claim":string,`,
      `"severity":"critical"|"high"|"medium"|"low","measuredAgainst":string}]}. No prose`,
      `outside the JSON.`,
    ].join("\n");
    const res = await run("codex", [
      "exec", "--sandbox", "read-only", "--skip-git-repo-check",
      "-o", outFile, prompt,
    ]);
    if (res.spawnError) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: codex CLI not available" };
    if (res.timedOut) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: codex timed out" };
    let message = "";
    try {
      message = readFileSync(outFile, "utf8");
    } catch {
      message = res.stdout;
    }
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: no JSON in codex output" };
    const parsed = JSON.parse(jsonMatch[0]);
    const findings = (parsed.findings ?? [])
      .filter((f) => f && typeof f.file === "string" && typeof f.claim === "string")
      .map((f) => ({
        file: f.file,
        line: Number.isInteger(f.line) ? f.line : null,
        claim: f.claim,
        severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
        measuredAgainst:
          typeof f.measuredAgainst === "string" && f.measuredAgainst.trim() ? f.measuredAgainst : "unstated",
        lens: "cross-model",
      }));
    log(`lens "cross-model": ${findings.length} finding(s)`);
    return { lens: "cross-model", findings, note: null };
  } catch (e) {
    return { lens: "cross-model", findings: [], note: `cross-model lens skipped: ${String(e).slice(0, 200)}` };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ---------- stage 2: adversarial verification ----------

// The verifier's adversarial method is the plugin's red-team-reviewer agent
// definition, spliced into every verifier prompt at runtime (path resolved
// relative to this script — agents/ is a sibling of workflows/ under the
// plugin root). If the file is missing or empty, the verifier degrades to
// its built-in prompt alone; the fallback is logged to stderr, never fatal.
function loadRedTeamCharter() {
  const pluginRoot = join(__dirname, "..");
  const charterPath = join(pluginRoot, "agents", "red-team-reviewer.md");
  try {
    const body = readFileSync(charterPath, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") // strip agent frontmatter
      // The charter points at references/ with ${CLAUDE_PLUGIN_ROOT}, which only substitutes
      // in skill/command text — a verifier reading it verbatim gets unresolvable paths, so
      // the root this script derives from its own location is spliced in here instead.
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", () => pluginRoot)
      .trim();
    if (body) return body;
    log(`red-team charter at ${charterPath} is empty; verifiers use the built-in prompt only`);
  } catch {
    log(`red-team charter not readable at ${charterPath}; verifiers use the built-in prompt only`);
  }
  return null;
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    verification: { type: "string" },
  },
  required: ["verified", "verification"],
};

async function verifyFinding(finding, ctx, model, charter) {
  const prompt = [
    `You are an adversarial verifier on a review panel. A reviewer claims:`,
    ``,
    `  file: ${finding.file}${Number.isInteger(finding.line) ? ` (line ${finding.line})` : ""}`,
    `  severity: ${finding.severity} (lens: ${finding.lens})`,
    `  measured against: ${finding.measuredAgainst}`,
    `  claim: ${finding.claim}`,
    ``,
    `Context: the claim is about the ${ctx.scopeLabel} in the repository at your working`,
    `directory. Inspect the actual code with Read/Grep/Glob (strictly read-only) and try to`,
    `REFUTE the claim. Set verified=true only if the evidence`,
    `you inspected supports it; verified=false if it is wrong, already handled, or`,
    `unsupported by the code. "verification" is 1-2 sentences citing what you`,
    `inspected and why the claim stands or falls.`,
    ...(charter
      ? [
          ``,
          `Your adversarial method is the devcycle red-team charter below. Here your`,
          `subject is the reviewer's claim above (not an implementer's diff), and your`,
          `output is the structured verified/verification fields above (not the`,
          `charter's verdict block).`,
          ``,
          `## Red-team charter`,
          charter,
        ]
      : []),
  ].join("\n");
  const res = await claudeStructured({ prompt, tools: "Read,Grep,Glob", schema: VERIFY_SCHEMA, model });
  if (!res.ok) {
    // Contract: unverified findings are marked, never dropped.
    return { ...finding, verified: false, verification: `verifier unavailable (${res.error}); finding retained unverified` };
  }
  return {
    ...finding,
    verified: res.value.verified === true,
    verification: String(res.value.verification ?? "").slice(0, 600) || "no verification detail returned",
  };
}

// ---------- stage 3: dedup ----------

function dedupFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.file}::${f.claim.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, f);
      continue;
    }
    // Keep the stronger duplicate: verified beats unverified, then higher severity.
    const better =
      (f.verified && !prev.verified) ||
      (f.verified === prev.verified && SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(prev.severity));
    const kept = better ? f : prev;
    const dropped = better ? prev : f;
    if (dropped.lens !== kept.lens && !kept.verification.includes("also reported by")) {
      kept.verification += ` (also reported by the ${dropped.lens} lens)`;
    }
    byKey.set(key, kept);
  }
  return [...byKey.values()];
}

// ---------- stage 4: reconciler ----------

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

function rankFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.file.localeCompare(b.file)
  );
}

function fallbackSummary(findings, notes) {
  const confirmed = findings.filter((f) => f.verified);
  const parts = [
    `Review panel: ${findings.length} finding(s), ${confirmed.length} confirmed ` +
      `(${confirmed.filter((f) => f.severity === "critical").length} critical, ` +
      `${confirmed.filter((f) => f.severity === "high").length} high, ` +
      `${confirmed.filter((f) => f.severity === "medium").length} medium, ` +
      `${confirmed.filter((f) => f.severity === "low").length} low), ` +
      `${findings.length - confirmed.length} unverified (retained, marked).`,
  ];
  if (notes.length) parts.push(`Notes: ${notes.join("; ")}.`);
  return parts.join(" ");
}

async function reconcile(findings, notes, model) {
  if (findings.length === 0) {
    return notes.length
      ? `Review panel found no findings. Notes: ${notes.join("; ")}.`
      : "Review panel found no findings.";
  }
  const prompt = [
    `You are the reconciler of a read-only review panel. Findings are already`,
    `verified, deduplicated, and ranked (confirmed first, by severity). Write a`,
    `short plain-language summary (max ~6 sentences), symptom first: lead with the`,
    `confirmed high-severity findings, mention counts, and state that unverified`,
    `findings are marked but retained. Do not invent findings.`,
    notes.length ? `\nPanel notes to mention: ${notes.join("; ")}` : "",
    ``,
    `## Findings (JSON)`,
    JSON.stringify(findings, null, 2),
  ].join("\n");
  const res = await claudeStructured({ prompt, tools: "", schema: SUMMARY_SCHEMA, model });
  return res.ok && res.value.summary ? res.value.summary : fallbackSummary(findings, notes);
}

// ---------- main ----------

async function main() {
  const args = parseArgs();
  const model = process.env.DEVCYCLE_PANEL_MODEL || undefined;
  const notes = [];
  if (args.specLensDropped) notes.push("spec lens skipped: no specPath given");

  gitReadOnly(["rev-parse", "--git-dir"]); // fail fast outside a git repo

  // Every input the reviewers saw only part of, kept apart from the other notes: these are
  // coverage reductions and are disclosed in the report itself, not just in the prompts.
  const dropped = [];
  const record = (r) => {
    if (r.note) notes.push(r.note);
    if (r.truncated) {
      dropped.push(r.note);
      log(r.note);
    }
    return r;
  };

  let spec = { text: null, note: null };
  if (args.specPath) {
    if (!existsSync(args.specPath)) fatal(`spec not found: ${args.specPath}`);
    spec = record(truncate(readFileSync(args.specPath, "utf8"), SPEC_CHAR_CAP, "spec"));
  }

  let scopeLabel;
  let fileList;
  let diffChunks = [null]; // file-set branch reviews once, with no diff text
  if (args.scope.ref) {
    scopeLabel = `diff for ref ${args.scope.ref}`;
    const { chunks, notes: chunkNotes } = chunkDiff(gitReadOnly(["diff", args.scope.ref]), DIFF_CHAR_CAP);
    diffChunks = chunks.length ? chunks : [""];
    for (const n of chunkNotes) {
      notes.push(n);
      dropped.push(n);
      log(n);
    }
    fileList = gitReadOnly(["diff", "--name-only", args.scope.ref]).trim();
  } else {
    scopeLabel = `file set below (${args.scope.paths.length} file(s))`;
    fileList = record(truncate(args.scope.paths.join("\n"), DIFF_CHAR_CAP, "file list")).text;
  }

  // Verification re-reads the working tree, so it needs the scope label, not the diff text.
  const verifyCtx = { scopeLabel, specPath: args.specPath, spec: spec.text, diff: null, fileList };

  // Stage 1: every lens reviews every diff chunk (jobs = lenses × chunks, + optional cross-model per chunk).
  const lensJobs = [];
  for (const chunk of diffChunks) {
    const ctx = { scopeLabel, specPath: args.specPath, spec: spec.text, diff: chunk, fileList };
    for (const lens of args.lenses) lensJobs.push(() => runClaudeLens(lens, ctx, model));
    if (args.crossModel) lensJobs.push(() => runCrossModelLens(ctx));
  }
  const lensResults = await mapLimit(lensJobs, LENS_CONCURRENCY, (job) => job());

  const rawFindings = lensResults.flatMap((r) => r.findings);
  for (const r of lensResults) if (r.note) notes.push(r.note);
  const failedClaudeLenses = lensResults.filter((r) => r.note && r.lens !== "cross-model").length;
  const totalClaudeLensJobs = args.lenses.length * diffChunks.length;
  if (failedClaudeLenses === totalClaudeLensJobs) fatal(`all lens reviewers failed: ${notes.join("; ")}`);

  // Stage 2: adversarial verification per finding (marked, never dropped).
  log(`verifying ${rawFindings.length} finding(s)...`);
  const charter = rawFindings.length ? loadRedTeamCharter() : null;
  const verified = await mapLimit(rawFindings, VERIFY_CONCURRENCY, (f) => verifyFinding(f, verifyCtx, model, charter));

  // Stage 3: dedup by file+claim.  Stage 4: rank + reconcile.
  const deduped = dedupFindings(verified);
  const ranked = rankFindings(deduped);
  const summary = await reconcile(ranked, notes, model);

  // The reconciler is a model and may drop a note it was handed, so the coverage line is
  // prepended here instead: a panel that reviewed a sample must never read as a full pass.
  const disclosed = dropped.length
    ? `COVERAGE WARNING: ${dropped.join("; ")}. This panel reviewed a sample, not the whole input.\n\n${summary}`
    : summary;

  process.stdout.write(JSON.stringify({ findings: ranked, notes, summary: disclosed }, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((e) => fatal(String(e?.stack ?? e)));
}

// Pure helpers, exported for the deterministic tests in tests/unit/.
module.exports = {
  dedupFindings, rankFindings, truncate, chunkDiff, fallbackSummary, mapLimit, loadRedTeamCharter,
  SEVERITIES, LENS_CONCURRENCY,
};
