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

const SCHEMA_PATH = new URL("../tests/fixtures/run-record.schema.json", import.meta.url).pathname;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function repoSlug(toplevel) {
  return `${basename(toplevel)}-${sha256(toplevel).slice(0, 8)}`;
}

export function hashSession(sessionId) {
  return sha256(sessionId);
}

export function recordPath(toplevel, runId) {
  const base = process.env.DEVCYCLE_RUNS_DIR ?? join(homedir(), ".claude", "devcycle", "runs");
  return join(base, repoSlug(toplevel), `${runId}.jsonl`);
}

function schemaFor(kind) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return (schema.oneOf ?? []).find((s) => s.properties?.kind?.const === kind) ?? null;
}

// Validates at write time so a malformed line never reaches the file. CI's check 13 guards the
// declared shape; this guards every real append.
function validate(obj, sub) {
  const errors = [];
  for (const req of sub.required ?? [])
    if (!(req in obj) || obj[req] === undefined) errors.push(`missing required field "${req}"`);
  for (const [key, value] of Object.entries(obj)) {
    const prop = sub.properties?.[key];
    if (!prop) {
      errors.push(`field "${key}" is not declared for kind "${obj.kind}"`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(value))
      errors.push(`"${key}" value "${value}" is not one of ${prop.enum.join(" | ")}`);
    if (prop.const !== undefined && value !== prop.const)
      errors.push(`"${key}" must be ${JSON.stringify(prop.const)}`);
    if (prop.pattern && !new RegExp(prop.pattern).test(String(value)))
      errors.push(`"${key}" does not match ${prop.pattern}`);
    if (prop.type === "integer" && !Number.isInteger(value))
      errors.push(`"${key}" must be an integer`);
  }
  return errors;
}

function writeLine(toplevel, runId, obj) {
  const sub = schemaFor(obj.kind);
  if (!sub) die(`unknown kind "${obj.kind}"`);
  const errors = validate(obj, sub);
  if (errors.length) die(errors.join("; "));
  const p = recordPath(toplevel, runId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(obj) + "\n");
}

function die(msg) {
  process.stderr.write(`run-record: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {}, knobs = {}, objects = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2), value = argv[i + 1];
    if (name === "knob" || name === "json") {
      const eq = value?.indexOf("=") ?? -1;
      if (eq < 1) die(`--${name} requires KEY=VALUE, got "${value ?? ""}"`);
      const key = value.slice(0, eq), raw = value.slice(eq + 1);
      if (name === "knob") knobs[key] = raw;
      else objects[key] = JSON.parse(raw);
    } else {
      flags[name] = value;
    }
    i++;
  }
  return { flags, knobs, objects };
}

function gitToplevel(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const { flags, knobs, objects } = parseArgs(rest);
  const toplevel = flags.repo ?? gitToplevel(process.cwd());
  const intFields = new Set(["round", "blockingCount", "reviewRound", "retryIndex"]);

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
      startedAt: flags.startedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    process.stdout.write(runId + "\n");
  } else if (sub === "append") {
    const runId = flags.run;
    if (!runId) die("append requires --run <runId>");
    const obj = { kind: flags.kind, runId };
    for (const [k, v] of Object.entries(flags)) {
      if (k === "run" || k === "kind" || k === "repo") continue;
      if (k === "sessionId") obj.sessionHash = hashSession(v);
      else obj[k] = intFields.has(k) ? Number(v) : v;
    }
    for (const [k, v] of Object.entries(objects)) obj[k] = v;
    if (Object.keys(knobs).length) obj.knobs = knobs;
    writeLine(toplevel, runId, obj);
  } else {
    die("usage: run-record.mjs <new|append> [flags]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
