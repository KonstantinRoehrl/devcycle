#!/usr/bin/env node
// Writes devcycle's run record: append-only JSONL, one object per line, under
// ~/.claude/devcycle/runs/<repo-slug>/<run-id>.jsonl. Ids, counts and enum values only —
// never code, never prose excerpts, never host paths. Session ids are stored hashed so the
// redaction screener's session-id pattern needs no exemption.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { now } from "./stamp.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { parseFlags } from "./cli-flags.mjs";

export { gitToplevel };

const SCHEMA_PATH = new URL("../tests/fixtures/run-record.schema.json", import.meta.url).pathname;
const CULPRITS_PATH = new URL("../references/culprits.json", import.meta.url).pathname;
const NOVEL_RE = /^novel:[a-z0-9]+(-[a-z0-9]+){0,5}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Read lazily: the vocabulary file is only touched when a line actually carries a culprit, so
// the common append path does no extra I/O. Phase 1 writes null here, Phase 3 populates it.
export function validateCulprit(value, culpritsPath = CULPRITS_PATH) {
  if (value === null || value === undefined) return [];
  if (NOVEL_RE.test(value)) return [];
  let vocab;
  try {
    vocab = JSON.parse(readFileSync(culpritsPath, "utf8"));
  } catch (err) {
    return [`culprit "${value}" cannot be checked — references/culprits.json unreadable: ${err.message}`];
  }
  if (!Array.isArray(vocab))
    return [`culprit "${value}" cannot be checked — references/culprits.json must be an array`];
  return vocab.some((e) => e && typeof e === "object" && typeof e.slug === "string" && e.slug === value)
    ? []
    : [`culprit "${value}" is neither a culprits.json slug nor a novel: slug`];
}

export function repoSlug(toplevel) {
  const sanitized = basename(toplevel)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${sanitized || "repo"}-${sha256(toplevel).slice(0, 8)}`;
}

export function hashSession(sessionId) {
  return sha256(sessionId);
}

export function runsDirForRepo(toplevel) {
  const base = process.env.DEVCYCLE_RUNS_DIR ?? join(homedir(), ".claude", "devcycle", "runs");
  return join(base, repoSlug(toplevel));
}
export function recordPath(toplevel, runId) {
  return join(runsDirForRepo(toplevel), `${runId}.jsonl`);
}

export function subSchemaFor(schema, kind) {
  return (schema.oneOf ?? []).find((s) => s.properties?.kind?.const === kind) ?? null;
}

function schemaFor(kind) {
  return subSchemaFor(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")), kind);
}

const typesOf = (prop) => [prop.type ?? []].flat();
// Explicit null is a value only where the schema says so: a nullable type, or null in the enum.
export const admitsNull = (prop) => typesOf(prop).includes("null") || (prop.enum ?? []).includes(null);

// Validates at write time so a malformed line never reaches the file. CI's check 13 guards the
// declared shape; this guards every real append.
export function validate(obj, sub) {
  const errors = [];
  for (const req of sub.required ?? [])
    if (!(req in obj) || obj[req] === undefined) errors.push(`missing required field "${req}"`);
  for (const [key, value] of Object.entries(obj)) {
    const prop = sub.properties?.[key];
    if (!prop) {
      errors.push(`field "${key}" is not declared for kind "${obj.kind}"`);
      continue;
    }
    if (value === null && admitsNull(prop)) continue;
    if (prop.enum && !prop.enum.includes(value))
      errors.push(`"${key}" value "${value}" is not one of ${prop.enum.join(" | ")}`);
    if (prop.const !== undefined && value !== prop.const)
      errors.push(`"${key}" must be ${JSON.stringify(prop.const)}`);
    if (prop.pattern && !new RegExp(prop.pattern).test(String(value)))
      errors.push(`"${key}" does not match ${prop.pattern}`);
    if (typesOf(prop).includes("integer") && !Number.isInteger(value))
      errors.push(`"${key}" must be an integer`);
    if (typesOf(prop).includes("boolean") && typeof value !== "boolean")
      errors.push(`"${key}" must be a boolean`);
    if (prop.minimum !== undefined && Number(value) < prop.minimum)
      errors.push(`"${key}" must be >= ${prop.minimum}, got ${value}`);
  }
  return errors;
}

export function writeLine(toplevel, runId, obj) {
  const sub = schemaFor(obj.kind);
  if (!sub) die(`unknown kind "${obj.kind}"`);
  const errors = [...validate(obj, sub), ...validateCulprit(obj.culprit)];
  if (errors.length) die(errors.join("; "));
  const p = recordPath(toplevel, runId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(obj) + "\n");
}

function die(msg) {
  process.stderr.write(`run-record: ${msg}\n`);
  process.exit(1);
}

// One flag map per subcommand, so a flag the subcommand never reads is refused rather than dropped.
// `append` declares every field any kind's schema declares, not just the chosen kind's: the kind is
// itself an argv value, so the parse cannot know it yet. A typo fails here as unrecognised; a real
// field of another kind still reaches validate() and its "not declared for kind" message.
const NEW_FLAGS = {
  "--plugin-version": "value", "--plugin-sha": "value", "--profile": "value", "--startedAt": "value",
  "--repo": "value", "--knob": "repeat",
};
const WORKLOAD_FLAGS = {
  "--run": "value", "--base": "value", "--requestKind": "value", "--planned-task-count": "value",
  "--wave-count": "value", "--repo": "value",
};
function appendFlags() {
  const fields = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")).oneOf
    .flatMap((s) => Object.keys(s.properties ?? {}));
  return {
    ...Object.fromEntries(fields.map((f) => [`--${f}`, "value"])),
    "--run": "value", "--kind": "value", "--repo": "value", "--sessionId": "value",
    "--knob": "repeat", "--json": "repeat",
  };
}

// "present", not "nonEmpty": an empty value is a value here, so a cycle start whose
// CLAUDE_CODE_SESSION_ID is unset still records its session, as it always has.
function parseArgs(argv, knownFlags) {
  let parsed;
  try {
    parsed = parseFlags(argv, knownFlags, { requireValues: "present" });
  } catch (e) {
    die(e.message);
  }
  const flags = {}, knobs = {}, objects = {};
  for (const [flag, value] of Object.entries(parsed.flags)) {
    const name = flag.slice(2);
    if (name !== "knob" && name !== "json") {
      flags[name] = value;
      continue;
    }
    for (const pair of value) {
      const eq = pair.indexOf("=");
      if (eq < 1) die(`--${name} requires KEY=VALUE, got "${pair}"`);
      const key = pair.slice(0, eq), raw = pair.slice(eq + 1);
      if (name === "knob") knobs[key] = raw;
      else objects[key] = JSON.parse(raw);
    }
  }
  return { flags, knobs, objects };
}

// Derives workload counts from git itself rather than the caller, so a workload line always
// reflects what actually landed between base and HEAD — never a self-reported count.
export function diffStats(base, cwd = process.cwd()) {
  // A failed git call is a failed measurement, never zero work: throw with git's own message so
  // the finish-stage call fails loudly, while the hook's non-zero-status guard keeps it a no-op.
  const git = (args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      const why = r.error?.message ?? ((r.stderr ?? "").trim() || `exit ${r.status}`);
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${why}`);
    }
    return r.stdout ?? "";
  };
  const num = git(["diff", "--numstat", `${base}...HEAD`]);
  const status = git(["diff", "--name-status", `${base}...HEAD`]);
  let insertions = 0, deletions = 0, filesChanged = 0;
  for (const line of num.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    filesChanged++;
    if (add !== "-") insertions += Number(add);   // "-" marks a binary file
    if (del !== "-") deletions += Number(del);
  }
  let filesCreated = 0, filesDeleted = 0;
  for (const line of status.split("\n").filter(Boolean)) {
    const code = line[0];
    if (code === "A") filesCreated++;
    else if (code === "D") filesDeleted++;
  }
  return { filesChanged, filesCreated, filesDeleted, insertions, deletions };
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const knownFlags = { new: NEW_FLAGS, append: appendFlags(), workload: WORKLOAD_FLAGS }[sub];
  if (!knownFlags) die("usage: run-record.mjs <new|append|workload> [flags]");
  const { flags, knobs, objects } = parseArgs(rest, knownFlags);
  const toplevel = flags.repo ?? gitToplevel(process.cwd());
  const intFields = new Set(["round", "blockingCount", "reviewRound", "retryIndex",
    "filesChanged", "filesCreated", "filesDeleted", "insertions", "deletions",
    "plannedTaskCount", "waveCount", "filed", "degraded", "tokens", "toolUses", "durationMs",
    "steps", "peakDepth", "window", "toolResultChars", "warned", "refused"]);
  const floatFields = new Set(["cost"]);
  const boolFields = new Set(["background", "fork", "windowAssumed", "isAborted"]);

  if (sub === "new") {
    const runId = randomBytes(8).toString("hex");
    writeLine(toplevel, runId, {
      kind: "run",
      runId,
      schemaVersion: 1,
      pluginVersion: flags["plugin-version"],
      pluginSha: flags["plugin-sha"],
      repoSlug: repoSlug(toplevel),
      profile: flags.profile,
      knobs,
      startedAt: flags.startedAt ?? now(),
    });
    process.stdout.write(runId + "\n");
  } else if (sub === "append") {
    const runId = flags.run;
    if (!runId) die("append requires --run <runId>");
    const obj = { kind: flags.kind, runId };
    const sub = schemaFor(flags.kind);
    for (const [k, v] of Object.entries(flags)) {
      if (k === "run" || k === "kind" || k === "repo") continue;
      if (k === "sessionId") obj.sessionHash = hashSession(v);
      else if (v === "null" && sub?.properties?.[k] && admitsNull(sub.properties[k])) obj[k] = null;
      else if (boolFields.has(k)) obj[k] = v === "true" ? true : v === "false" ? false : v;
      else obj[k] = intFields.has(k) || floatFields.has(k) ? Number(v) : v;
    }
    for (const [k, v] of Object.entries(objects)) obj[k] = v;
    if (Object.keys(knobs).length) obj.knobs = knobs;
    if (["event", "agent-depth", "agent-trace"].includes(obj.kind) && obj.ts === undefined)
      obj.ts = now();
    writeLine(toplevel, runId, obj);
  } else if (sub === "workload") {
    const runId = flags.run;
    if (!runId) die("workload requires --run <runId>");
    if (!flags.base) die("workload requires --base <sha>");
    let stats;
    try { stats = diffStats(flags.base, toplevel); } catch (e) { die(e.message); }
    const obj = {
      kind: "workload", runId,
      requestKind: flags.requestKind ?? die("workload requires --requestKind"),
      ...stats,
      plannedTaskCount: Number(flags["planned-task-count"] ?? 0),
      waveCount: Number(flags["wave-count"] ?? 0),
    };
    writeLine(toplevel, runId, obj);
  } else {
    die("usage: run-record.mjs <new|append|workload> [flags]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
