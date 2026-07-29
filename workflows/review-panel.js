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
//     summary: string }
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

const { spawn, execFileSync } = require("node:child_process");
const { readFileSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const DIFF_CHAR_CAP = 60_000;
const SPEC_CHAR_CAP = 30_000;
const VERIFY_CONCURRENCY = 4;
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

const log = (msg) => process.stderr.write(`[review-panel] ${msg}\n`);
const fatal = (msg) => {
  process.stderr.write(`[review-panel] ERROR: ${msg}\n`);
  process.exit(1);
};

// ---------- generic subprocess helpers ----------

function run(cmd, args, { cwd, timeoutMs, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs ?? AGENT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

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

// Run a claude print-mode subagent with a schema-validated structured output.
// Retries once on transport/validation failure. Returns { ok, value | error }.
async function claudeStructured({ prompt, tools, schema, model }) {
  // --tools is a VARIADIC option in the claude CLI: in the space-separated
  // form ("--tools", value) it greedily consumes following positionals, so if
  // its value is the last thing before the prompt, the prompt is swallowed
  // into the tools list and the call fails. The equals-form pins exactly one
  // value to the flag — never change this back to the two-element form.
  const argv = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--json-schema", JSON.stringify(schema),
    `--tools=${tools}`,
  ];
  if (model) argv.push("--model", model);
  argv.push(prompt);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await run("claude", argv);
    if (res.spawnError) return { ok: false, error: `claude CLI not runnable: ${res.stderr}` };
    if (res.timedOut) {
      if (attempt === 2) return { ok: false, error: "claude subagent timed out" };
      continue;
    }
    try {
      const envelope = JSON.parse(res.stdout);
      if (!envelope.is_error && envelope.structured_output !== undefined) {
        return { ok: true, value: envelope.structured_output };
      }
      if (attempt === 2) {
        return { ok: false, error: `claude subagent error: ${envelope.result ?? res.stderr}`.slice(0, 500) };
      }
    } catch {
      if (attempt === 2) {
        return { ok: false, error: `unparseable claude output: ${(res.stderr || res.stdout).slice(0, 300)}` };
      }
    }
  }
  return { ok: false, error: "unreachable" };
}

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

function truncate(text, cap, label) {
  if (text.length <= cap) return { text, note: null };
  return {
    text: text.slice(0, cap) + `\n[... truncated at ${cap} chars ...]`,
    note: `${label} truncated to ${cap} chars for reviewer prompts`,
  };
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
  const charterPath = join(__dirname, "..", "agents", "red-team-reviewer.md");
  try {
    const body = readFileSync(charterPath, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") // strip agent frontmatter
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

  let spec = { text: null, note: null };
  if (args.specPath) {
    if (!existsSync(args.specPath)) fatal(`spec not found: ${args.specPath}`);
    spec = truncate(readFileSync(args.specPath, "utf8"), SPEC_CHAR_CAP, "spec");
    if (spec.note) notes.push(spec.note);
  }

  let scopeLabel;
  let fileList;
  let diff = { text: null, note: null };
  if (args.scope.ref) {
    scopeLabel = `diff for ref ${args.scope.ref}`;
    diff = truncate(gitReadOnly(["diff", args.scope.ref]), DIFF_CHAR_CAP, "diff");
    if (diff.note) notes.push(diff.note);
    fileList = gitReadOnly(["diff", "--name-only", args.scope.ref]).trim();
  } else {
    scopeLabel = `file set below (${args.scope.paths.length} file(s))`;
    const list = truncate(args.scope.paths.join("\n"), DIFF_CHAR_CAP, "file list");
    if (list.note) notes.push(list.note);
    fileList = list.text;
  }

  const ctx = { scopeLabel, specPath: args.specPath, spec: spec.text, diff: diff.text, fileList };

  // Stage 1: lens reviewers in parallel (claude lenses + optional codex lens).
  const lensJobs = args.lenses.map((lens) => () => runClaudeLens(lens, ctx, model));
  if (args.crossModel) lensJobs.push(() => runCrossModelLens(ctx));
  const lensResults = await mapLimit(lensJobs, lensJobs.length, (job) => job());

  const rawFindings = lensResults.flatMap((r) => r.findings);
  for (const r of lensResults) if (r.note) notes.push(r.note);
  const failedClaudeLenses = lensResults.filter((r) => r.note && r.lens !== "cross-model").length;
  if (failedClaudeLenses === args.lenses.length) fatal(`all lens reviewers failed: ${notes.join("; ")}`);

  // Stage 2: adversarial verification per finding (marked, never dropped).
  log(`verifying ${rawFindings.length} finding(s)...`);
  const charter = rawFindings.length ? loadRedTeamCharter() : null;
  const verified = await mapLimit(rawFindings, VERIFY_CONCURRENCY, (f) => verifyFinding(f, ctx, model, charter));

  // Stage 3: dedup by file+claim.  Stage 4: rank + reconcile.
  const deduped = dedupFindings(verified);
  const ranked = rankFindings(deduped);
  const summary = await reconcile(ranked, notes, model);

  process.stdout.write(JSON.stringify({ findings: ranked, summary }, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((e) => fatal(String(e?.stack ?? e)));
}

// Pure helpers, exported for the deterministic tests in tests/unit/.
module.exports = { dedupFindings, rankFindings, truncate, fallbackSummary, mapLimit, SEVERITIES };
