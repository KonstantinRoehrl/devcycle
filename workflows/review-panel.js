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
//   { ref: string, specPath: string,
//     lenses?: ("spec"|"correctness"|"simplify")[], crossModel?: boolean }
// Output (stdout, JSON):
//   { findings: [{ file, line?, claim, severity: "high"|"medium"|"low",
//                  lens, verified: boolean, verification: string }],
//     summary: string }
//
// Stages: 1) 2-3 read-only lens reviewers in parallel (default all three;
// cross-model codex lens only when crossModel) -> 2) adversarial per-finding
// verification (unverified findings are marked, never dropped) -> 3) dedup by
// file+claim -> 4) reconciler ranks confirmed findings by severity.
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
//     '{"ref":"HEAD~1","specPath":"docs/spec.md","lenses":["spec","correctness"]}'

"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { readFileSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const DIFF_CHAR_CAP = 60_000;
const SPEC_CHAR_CAP = 30_000;
const VERIFY_CONCURRENCY = 4;
const SEVERITIES = ["high", "medium", "low"];
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
    fatal("argv[2] must be a JSON object: { ref, specPath, lenses?, crossModel? }");
  }
  if (typeof args.ref !== "string" || !args.ref) fatal("args.ref (string) is required");
  if (typeof args.specPath !== "string" || !args.specPath) fatal("args.specPath (string) is required");
  const lenses = args.lenses ?? Object.keys(LENS_CHARTERS);
  if (!Array.isArray(lenses) || lenses.length === 0 || lenses.some((l) => !(l in LENS_CHARTERS))) {
    fatal(`args.lenses must be a non-empty subset of ${Object.keys(LENS_CHARTERS).join("|")}`);
  }
  return { ref: args.ref, specPath: args.specPath, lenses, crossModel: args.crossModel === true };
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
        },
        required: ["file", "claim", "severity"],
      },
    },
  },
  required: ["findings"],
};

function lensPrompt(lens, ctx) {
  return [
    `You are one lens of a read-only review panel. Your single lens:`,
    LENS_CHARTERS[lens],
    ``,
    `You review the diff below (ref: ${ctx.ref}) in the repository at your working`,
    `directory. You may use Read/Grep/Glob to inspect surrounding code, but you are`,
    `strictly read-only. Report only concrete, evidenced findings for YOUR lens —`,
    `no restated diff hunks, no style nits outside your charter. For each finding`,
    `give the file path (repo-relative), the line in the new version when known,`,
    `a one-to-two sentence claim in plain language (symptom first), and a severity:`,
    `high (broken behavior / spec violation / security), medium (likely defect or`,
    `meaningful deviation), low (worthwhile improvement). Return an empty findings`,
    `array if your lens finds nothing.`,
    ``,
    `## Spec (${ctx.specPath})`,
    ctx.spec,
    ``,
    `## Changed files`,
    ctx.fileList || "(none reported by git)",
    ``,
    `## Diff`,
    ctx.diff || "(empty diff)",
  ].join("\n");
}

async function runClaudeLens(lens, ctx, model) {
  log(`lens "${lens}" reviewing...`);
  const res = await claudeStructured({
    prompt: lensPrompt(lens, ctx),
    tools: "Read,Grep,Glob",
    schema: FINDINGS_SCHEMA,
    model,
  });
  if (!res.ok) return { lens, findings: [], note: `lens "${lens}" failed: ${res.error}` };
  const findings = (res.value.findings ?? [])
    .filter((f) => f && typeof f.file === "string" && typeof f.claim === "string")
    .map((f) => ({
      file: f.file,
      ...(Number.isInteger(f.line) ? { line: f.line } : {}),
      claim: f.claim,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
      lens,
    }));
  log(`lens "${lens}": ${findings.length} finding(s)`);
  return { lens, findings, note: null };
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
      lensPrompt("correctness", ctx),
      ``,
      `Cross-model pass: you are a second, independent model auditing this diff for`,
      `anything the primary reviewers may have missed (any lens). Respond with ONLY a`,
      `JSON object: {"findings":[{"file":string,"line":integer|null,"claim":string,`,
      `"severity":"high"|"medium"|"low"}]}. No prose outside the JSON.`,
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
        ...(Number.isInteger(f.line) ? { line: f.line } : {}),
        claim: f.claim,
        severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
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

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    verification: { type: "string" },
  },
  required: ["verified", "verification"],
};

async function verifyFinding(finding, ctx, model) {
  const prompt = [
    `You are an adversarial verifier on a review panel. A reviewer claims:`,
    ``,
    `  file: ${finding.file}${finding.line !== undefined ? ` (line ${finding.line})` : ""}`,
    `  severity: ${finding.severity} (lens: ${finding.lens})`,
    `  claim: ${finding.claim}`,
    ``,
    `Context: the claim is about the diff for ref ${ctx.ref} in the repository at your`,
    `working directory. Inspect the actual code with Read/Grep/Glob (strictly`,
    `read-only) and try to REFUTE the claim. Set verified=true only if the evidence`,
    `you inspected supports it; verified=false if it is wrong, already handled, or`,
    `unsupported by the code. "verification" is 1-2 sentences citing what you`,
    `inspected and why the claim stands or falls.`,
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
      `(${confirmed.filter((f) => f.severity === "high").length} high, ` +
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

  gitReadOnly(["rev-parse", "--git-dir"]); // fail fast outside a git repo
  if (!existsSync(args.specPath)) fatal(`spec not found: ${args.specPath}`);
  const spec = truncate(readFileSync(args.specPath, "utf8"), SPEC_CHAR_CAP, "spec");
  const diff = truncate(gitReadOnly(["diff", args.ref]), DIFF_CHAR_CAP, "diff");
  if (spec.note) notes.push(spec.note);
  if (diff.note) notes.push(diff.note);
  const fileList = gitReadOnly(["diff", "--name-only", args.ref]).trim();
  const ctx = { ref: args.ref, specPath: args.specPath, spec: spec.text, diff: diff.text, fileList };

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
  const verified = await mapLimit(rawFindings, VERIFY_CONCURRENCY, (f) => verifyFinding(f, ctx, model));

  // Stage 3: dedup by file+claim.  Stage 4: rank + reconcile.
  const deduped = dedupFindings(verified);
  const ranked = rankFindings(deduped);
  const summary = await reconcile(ranked, notes, model);

  process.stdout.write(JSON.stringify({ findings: ranked, summary }, null, 2) + "\n");
}

main().catch((e) => fatal(String(e?.stack ?? e)));
