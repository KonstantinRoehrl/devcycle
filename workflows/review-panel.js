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
//     strengths: [{ file, line: integer|null, claim, measuredAgainst, lens }],
//                           // unranked, unverified — never mixed into findings
//     notes: string[],      // coverage reductions and lens failures, verbatim
//     summary: string,      // opens with a COVERAGE WARNING when an input was truncated;
//                           // strengths, when any, are appended as their own section
//     costByLens: [{ lens, cost }] }  // per-lens $ rollup (§M7); one entry per distinct
//                           // lens plus a trailing "panel-overhead" entry (verify + reconcile)
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
// the lens reviewers get --tools "Read,Grep,Glob"; the adversarial verifier
// additionally gets Bash so it can re-run and recompute a claim (still read-only
// in intent — no --permission-mode is passed, so nothing grants writes); the
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

// ---------- bounded-concurrency helper ----------

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

// ---------- shared agent CLI binding ----------

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
  if (args.maxChunks !== undefined && (!Number.isInteger(args.maxChunks) || args.maxChunks < 1)) {
    fatal("args.maxChunks, when given, must be a positive integer");
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
      return { key: l, charter: LENS_CHARTERS[l], wantsSpec: l === "spec" };
    }
    if (l && typeof l.key === "string" && l.key && typeof l.charter === "string" && l.charter) {
      // A caller-supplied lens defaults wantsSpec=false regardless of its key: the built-in
      // "spec" lens is the only one the spec text is spliced into, and opting a custom lens in
      // is deliberately out of scope (a spec copied into every lens is what #192 removed).
      return { key: l.key, charter: l.charter, wantsSpec: false };
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
    maxChunks: Number.isInteger(args.maxChunks) ? args.maxChunks : null,
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

// Churn of one chunk: added/removed content lines, excluding the +++/--- file headers.
function chunkChurn(chunk) {
  let n = 0;
  for (const line of chunk.split("\n")) {
    if ((line[0] === "+" && !line.startsWith("+++")) || (line[0] === "-" && !line.startsWith("---"))) n++;
  }
  return n;
}

// Files a chunk touches, from its `diff --git a/… b/<path>` header lines.
function chunkFiles(chunk) {
  const files = [];
  for (const line of chunk.split("\n")) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) files.push(m[1]);
  }
  return files;
}

// Keep the maxChunks highest-churn chunks (original order preserved); name the rest's files.
function selectChunksByChurn(chunks, maxChunks) {
  if (!maxChunks || chunks.length <= maxChunks) return { reviewed: chunks, deferredFiles: [] };
  const ranked = chunks
    .map((chunk, index) => ({ chunk, index, churn: chunkChurn(chunk) }))
    .sort((a, b) => b.churn - a.churn || a.index - b.index);
  const keep = new Set(ranked.slice(0, maxChunks).map((r) => r.index));
  const reviewed = chunks.filter((_, i) => keep.has(i));
  const deferredFiles = [
    ...new Set(chunks.filter((_, i) => !keep.has(i)).flatMap(chunkFiles)),
  ].sort();
  return { reviewed, deferredFiles };
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
          needsExecution: { type: "boolean" },
        },
        required: ["file", "claim", "severity", "measuredAgainst"],
      },
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          claim: { type: "string" },
          measuredAgainst: { type: "string" },
        },
        required: ["file", "claim", "measuredAgainst"],
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
    `first), a severity, and what the finding is measured against. Set "needsExecution" true`,
    `ONLY when refuting the claim requires running code or commands (a benchmark, a metric, a`,
    `computed figure); false for a claim refutable by reading the code.`,
    ``,
    `Severity: critical (data loss, a security hole, or a broken release path), high (broken`,
    `behavior or a violation of what the spec requires), medium (a likely defect or`,
    `meaningful deviation worth fixing), low (a worthwhile improvement).`,
    ``,
    `"measuredAgainst" names the repo convention (by file path) or the external source the`,
    `finding is measured against. A finding measured against neither is an unsupported`,
    `opinion: do not report it. Return an empty findings array if your lens finds nothing.`,
    ``,
    `You MAY additionally report strengths — patterns that concretely and measurably do the`,
    `right thing — in a "strengths" array, to the SAME evidence bar (file, the line when known,`,
    `a one-to-two-sentence claim, and what it is measured against). A strength is additive and`,
    `never a substitute for a defect. Omit the array or leave it empty when you have none.`,
    ...(ctx.spec ? [``, `## Spec (${ctx.specPath})`, ctx.spec] : []),
    ``,
    ctx.diff === null ? `## Files under review` : `## Changed files`,
    ctx.fileList || "(none)",
    ...(ctx.diff === null ? [] : [``, `## Diff`, ctx.diff || "(empty diff)"]),
  ].join("\n");
}

// Shared normalization for the items a lens reports. A raw item is kept only when it
// carries both a file and a claim; line, measuredAgainst and lens are normalized the same
// way for findings and strengths (findings additionally clamp severity to the vocabulary).
const hasFileAndClaim = (x) => x && typeof x.file === "string" && typeof x.claim === "string";
const lineOrNull = (x) => (Number.isInteger(x.line) ? x.line : null);
const measuredAgainstOr = (x) =>
  typeof x.measuredAgainst === "string" && x.measuredAgainst.trim() ? x.measuredAgainst : "unstated";

function normalizeFinding(f, lens) {
  return {
    file: f.file,
    line: lineOrNull(f),
    claim: f.claim,
    severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
    measuredAgainst: measuredAgainstOr(f),
    needsExecution: f.needsExecution === true,
    lens,
  };
}

function normalizeStrength(s, lens) {
  return { file: s.file, line: lineOrNull(s), claim: s.claim, measuredAgainst: measuredAgainstOr(s), lens };
}

async function runClaudeLens(lens, ctx, model) {
  // No per-lens progress line: stage-1 stderr must not scale with fan-out (F6). The stage-1
  // summary log in main() reports the lens/chunk/job counts once; the spec-drop coverage is
  // asserted off the report's own `notes`, not a per-lens stderr line.
  const res = await claudeStructured({
    prompt: lensPrompt(lens.charter, ctx),
    tools: "Read,Grep,Glob",
    schema: FINDINGS_SCHEMA,
    model,
  });
  if (!res.ok) return { lens: lens.key, findings: [], strengths: [], note: `lens "${lens.key}" failed: ${res.error}`, cost: res.cost ?? null };
  const value = res.value;
  if (!value || typeof value !== "object" || !Array.isArray(value.findings)) {
    return { lens: lens.key, findings: [], strengths: [], note: `lens "${lens.key}" returned a malformed envelope; treated as no findings`, cost: res.cost ?? null };
  }
  const findings = value.findings.filter(hasFileAndClaim).map((f) => normalizeFinding(f, lens.key));
  const strengths = (Array.isArray(value.strengths) ? value.strengths : [])
    .filter(hasFileAndClaim)
    .map((s) => normalizeStrength(s, lens.key));
  return { lens: lens.key, findings, strengths, note: null, cost: res.cost ?? null };
}

// Cross-model lens via the codex CLI (read-only sandbox). Degrades gracefully:
// if codex is unavailable or its output is unusable, the lens is skipped with
// a note in the summary — the panel itself still succeeds.
async function runCrossModelLens(ctx) {
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
    if (res.spawnError) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: codex CLI not available", cost: null };
    if (res.timedOut) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: codex timed out", cost: null };
    // Overflow is a transport failure like timedOut/spawnError (agent-cli run() SIGKILLs the
    // child and truncates the buffer): skip the lens rather than parse the truncated output.
    if (res.overflow) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: codex output exceeded the buffer cap", cost: null };
    let message = "";
    try {
      message = readFileSync(outFile, "utf8");
    } catch {
      message = res.stdout;
    }
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { lens: "cross-model", findings: [], note: "cross-model lens skipped: no JSON in codex output", cost: null };
    const parsed = JSON.parse(jsonMatch[0]);
    const findings = (parsed.findings ?? []).filter(hasFileAndClaim).map((f) => normalizeFinding(f, "cross-model"));
    return { lens: "cross-model", findings, note: null, cost: null };
  } catch (e) {
    return { lens: "cross-model", findings: [], note: `cross-model lens skipped: ${String(e).slice(0, 200)}`, cost: null };
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

function verifierTools(f) { return f.needsExecution === true ? "Read,Grep,Glob,Bash" : "Read,Grep,Glob"; }

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
  const res = await claudeStructured({ prompt, tools: verifierTools(finding), schema: VERIFY_SCHEMA, model });
  if (!res.ok) {
    // Contract: unverified findings are marked, never dropped.
    return {
      finding: { ...finding, verified: false, verification: `verifier unavailable (${res.error}); finding retained unverified` },
      cost: 0,
    };
  }
  const v = res.value ?? {};
  return {
    finding: {
      ...finding,
      verified: v.verified === true,
      verification: String(v.verification ?? "").slice(0, 600) || "no verification detail returned",
    },
    cost: res.cost ?? null,
  };
}

// ---------- stage 3: dedup ----------

// Pre-verification dedup: collapse identical file+claim, keep the higher severity, and record
// every lens that reported it. Runs before stage 2 so duplicates are verified once, not N times.
function dedupRaw(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.file}::${f.claim.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...f, mergedLenses: [f.lens] });
      continue;
    }
    const keepNew = SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(prev.severity);
    const kept = keepNew ? { ...f } : prev;
    const lenses = new Set([...(prev.mergedLenses ?? [prev.lens]), f.lens]);
    kept.mergedLenses = [...lenses].sort();
    // Union the execution need across duplicates: if either the kept or the dropped finding
    // needed Bash to refute, the survivor keeps that tier — otherwise a merged-away
    // needsExecution:true would silently downgrade the survivor's verifier to read-only.
    kept.needsExecution = Boolean(prev.needsExecution) || Boolean(f.needsExecution);
    byKey.set(key, kept);
  }
  return [...byKey.values()];
}

function dedupStrengths(strengths) {
  const byKey = new Map();
  for (const s of strengths) {
    const key = `${s.file}::${s.claim.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (!byKey.has(key)) byKey.set(key, s);
  }
  return [...byKey.values()];
}

// ---------- stage 4: reconciler ----------

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

// Per-lens cost rollup (§M7). Stage-1 lens jobs carry a per-call cost (res.cost from
// claudeStructured; null when the CLI omitted total_cost_usd, and for the codex cross-model
// lens which has no claude envelope). Sum by lens.key; verify + reconcile are not per-lens, so
// they fold into one panel-overhead entry. A zero-cost lens is still emitted so the run record
// shows the lens ran.
function aggregateLensCosts({ lensResults, verifyCost = 0, reconcileCost = 0 }) {
  const byLens = new Map();
  for (const r of lensResults) {
    const lens = r.lens ?? "unknown";
    byLens.set(lens, (byLens.get(lens) ?? 0) + (Number(r.cost) || 0));
  }
  const out = [...byLens.entries()].map(([lens, cost]) => ({ lens, cost }));
  out.push({ lens: "panel-overhead", cost: (Number(verifyCost) || 0) + (Number(reconcileCost) || 0) });
  return out;
}

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
    return {
      text: notes.length
        ? `Review panel found no findings. Notes: ${notes.join("; ")}.`
        : "Review panel found no findings.",
      cost: 0,
    };
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
  return {
    text: res.ok && res.value.summary ? res.value.summary : fallbackSummary(findings, notes),
    cost: res.cost ?? 0,
  };
}

// Build the stage-1 job descriptors: the spec lens (wantsSpec) runs once over the whole diff
// (scope "full-diff", no chunk), every other lens runs once per reviewed chunk (scope "chunk",
// carrying its chunk), and — when crossModel — a cross-model job per reviewed chunk.
// Pure and deterministic; main() maps each descriptor to its runGuarded(...) job.
function buildLensJobs({ lenses, reviewedChunks, crossModel }) {
  const descriptors = [];
  for (const lens of lenses) {
    if (lens.wantsSpec) {
      descriptors.push({ lensKey: lens.key, kind: "claude-lens", scope: "full-diff", lens });
    } else {
      for (const chunk of reviewedChunks) {
        descriptors.push({ lensKey: lens.key, kind: "claude-lens", scope: "chunk", chunk, lens });
      }
    }
  }
  if (crossModel) {
    for (const chunk of reviewedChunks) {
      descriptors.push({ lensKey: "cross-model", kind: "cross-model", scope: "chunk", chunk });
    }
  }
  return descriptors;
}

// ---------- main ----------

// Wrap an async job so an unexpected throw degrades to a fallback value instead of
// rejecting the whole batch (mapLimit's Promise.all) — only an all-lens failure is fatal.
// Each caller supplies the degraded shape its stage expects, given the error message.
async function runGuarded(work, degrade) {
  try {
    return await work();
  } catch (e) {
    return degrade(String(e?.message ?? e));
  }
}

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
  let fullDiff = null; // whole-diff source for the single-pass spec lens; null in the file-set branch
  let diffChunks = [null]; // file-set branch reviews once, with no diff text
  if (args.scope.ref) {
    scopeLabel = `diff for ref ${args.scope.ref}`;
    fullDiff = gitReadOnly(["diff", args.scope.ref]);
    const { chunks, notes: chunkNotes } = chunkDiff(fullDiff, DIFF_CHAR_CAP);
    for (const n of chunkNotes) {
      notes.push(n);
      dropped.push(n);
      log(n);
    }
    const { reviewed, deferredFiles } = selectChunksByChurn(chunks, args.maxChunks);
    if (deferredFiles.length) {
      const note = `Frontier: reviewed the ${reviewed.length} highest-churn chunks of ${chunks.length}; deferred chunks touching: ${deferredFiles.join(", ")}`;
      notes.push(note);
      dropped.push(note);
      log(note);
    }
    diffChunks = reviewed.length ? reviewed : [""];
    fileList = gitReadOnly(["diff", "--name-only", args.scope.ref]).trim();
  } else {
    scopeLabel = `file set below (${args.scope.paths.length} file(s))`;
    fileList = record(truncate(args.scope.paths.join("\n"), DIFF_CHAR_CAP, "file list")).text;
  }

  // Verification re-reads the working tree, so it needs the scope label, not the diff text.
  const verifyCtx = { scopeLabel, specPath: args.specPath, spec: spec.text, diff: null, fileList };

  // Stage 1: the spec lens reviews the whole diff once; every other lens reviews each reviewed
  // chunk; cross-model runs per reviewed chunk. buildLensJobs is the pure descriptor builder;
  // here each descriptor becomes its runGuarded(...) job, with the spec lens carrying the whole
  // (truncated) diff + spec text, and per-chunk lenses carrying their chunk with no spec.
  const lensJobs = buildLensJobs({ lenses: args.lenses, reviewedChunks: diffChunks, crossModel: args.crossModel }).map((desc) => {
    if (desc.kind === "cross-model") {
      const cmCtx = { scopeLabel, specPath: args.specPath, diff: desc.chunk, fileList, spec: null };
      return { kind: "cross-model", run: () =>
        runGuarded(
          () => runCrossModelLens(cmCtx),
          (msg) => ({ lens: "cross-model", findings: [], strengths: [], note: `cross-model lens crashed: ${msg}` }),
        ),
      };
    }
    const lens = desc.lens;
    let ctx;
    if (desc.scope === "full-diff") {
      // One spec-lens pass over the whole diff; its truncation (if any) is disclosed once.
      const diff = fullDiff === null ? null : record(truncate(fullDiff, DIFF_CHAR_CAP, "diff (spec lens)")).text;
      ctx = { scopeLabel, specPath: args.specPath, diff, fileList, spec: spec.text };
    } else {
      ctx = { scopeLabel, specPath: args.specPath, diff: desc.chunk, fileList, spec: null };
    }
    return { kind: "claude-lens", run: () =>
      runGuarded(
        () => runClaudeLens(lens, ctx, model),
        (msg) => ({ lens: lens.key, findings: [], strengths: [], note: `lens "${lens.key}" crashed: ${msg}` }),
      ),
    };
  });
  log(`stage 1: ${diffChunks.length} chunk(s) × ${args.lenses.length} lens(es) → ${lensJobs.length} job(s)`);
  const lensResults = await mapLimit(lensJobs, LENS_CONCURRENCY, (job) => job.run());

  const rawFindings = lensResults.flatMap((r) => r.findings);
  const rawStrengths = lensResults.flatMap((r) => r.strengths ?? []);
  for (const r of lensResults) if (r.note) notes.push(r.note);
  const claudeLensJobCount = lensJobs.filter((j) => j.kind === "claude-lens").length;
  const failedClaudeLenses = lensResults.filter((r, i) => r.note && lensJobs[i].kind === "claude-lens").length;
  if (claudeLensJobCount > 0 && failedClaudeLenses === claudeLensJobCount) {
    fatal(`all lens reviewers failed: ${notes.join("; ")}`);
  }

  // Stage 3 (moved up): dedup raw findings by file+claim BEFORE verifying, so duplicates are
  // verified once. Stage 2: verify survivors. Stage 4: rank.
  const distinct = dedupRaw(rawFindings);
  log(`stage 1→2: ${rawFindings.length} raw finding(s) → ${distinct.length} distinct to verify`);
  const charter = distinct.length ? loadRedTeamCharter() : null;
  const verifyRaw = await mapLimit(distinct, VERIFY_CONCURRENCY, (f) =>
    runGuarded(
      () => verifyFinding(f, verifyCtx, model, charter),
      (msg) => ({ finding: { ...f, verified: false, verification: `verifier crashed (${msg}); retained unverified` }, cost: 0 }),
    ),
  );
  const verified = verifyRaw.map((v) => v.finding);
  const verifyCost = verifyRaw.reduce((s, v) => s + (Number(v.cost) || 0), 0);
  // Render the merged-lens disclosure onto verification text (was mutated inside dedup before).
  for (const f of verified) {
    const others = (f.mergedLenses ?? []).filter((l) => l !== f.lens);
    if (others.length) f.verification += ` (also reported by the ${others.join(", ")} lens${others.length > 1 ? "es" : ""})`;
  }
  log(`stage 2: ${verified.filter((f) => f.verified).length} verified`);
  const ranked = rankFindings(verified);
  const strengths = dedupStrengths(rawStrengths);
  const rec = await reconcile(ranked, notes, model);

  // The reconciler is a model and may drop a note it was handed, so the coverage line is
  // prepended here instead: a panel that reviewed a sample must never read as a full pass.
  const strengthsSection = strengths.length
    ? `\n\nStrengths (${strengths.length}, unranked — not defects):\n` +
      strengths
        .map((s) => `- ${s.file}${s.line != null ? ":" + s.line : ""} — ${s.claim} (measured against: ${s.measuredAgainst})`)
        .join("\n")
    : "";
  const disclosed =
    (dropped.length
      ? `COVERAGE WARNING: ${dropped.join("; ")}. This panel reviewed a sample, not the whole input.\n\n${rec.text}`
      : rec.text) + strengthsSection;

  const costByLens = aggregateLensCosts({ lensResults, verifyCost, reconcileCost: rec.cost });
  process.stdout.write(JSON.stringify({ findings: ranked, strengths, notes, summary: disclosed, costByLens }) + "\n");
}

if (require.main === module) {
  main().catch((e) => fatal(String(e?.stack ?? e)));
}

// Pure helpers, exported for the deterministic tests in tests/unit/.
module.exports = {
  dedupRaw, dedupStrengths, rankFindings, truncate, chunkDiff, selectChunksByChurn, buildLensJobs, fallbackSummary, mapLimit, loadRedTeamCharter,
  SEVERITIES, LENS_CONCURRENCY, verifierTools, aggregateLensCosts,
};
