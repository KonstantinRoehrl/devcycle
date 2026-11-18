#!/usr/bin/env node
// The single review engine's per-lens result files, so a stopped branch-review round re-dispatches
// only the lenses that never finished. workflows/lib/result-store.js owns the files and their keys;
// this script decides which lenses still need a reviewer, so no coordinator judges a directory by
// reading it. playbooks/reviewing-code.md § 3 owns when each command runs.
//
//   save-lenses --dir <resultDir> --ref <base>..<branch> --from <json>  the round's lens set
//   lenses --dir <resultDir>                                         the saved lens set
//   missing --dir <resultDir>                                        lenses with no current result, plus the stored results
//   record --dir <resultDir> --lens <key> --from <json>              one reviewer's findings and strengths
//   record-refutation --dir <resultDir> --from <json>                the refutation reader's verdicts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import resultStore from "../workflows/lib/result-store.js";
import panel from "../workflows/review-panel.js";
import { atomicWrite } from "./atomic-write.mjs";
import { isMain } from "./is-main.mjs";
import { UsageError, runTaskScript, taskFlags } from "./task-ledger.mjs";

const { RESULT_DIR_SHAPE, LENS_SET_FILE, REFUTATION_FILE, contentKey, lensResultFile, refutationKey, readJsonObject, createResultStore } =
  resultStore;
const { SEVERITIES } = panel;

const COMMANDS = {
  "save-lenses": { flags: { "--dir": "value", "--ref": "value", "--from": "value" }, required: ["--dir", "--ref", "--from"] },
  lenses: { flags: { "--dir": "value" }, required: ["--dir"] },
  missing: { flags: { "--dir": "value" }, required: ["--dir"] },
  record: { flags: { "--dir": "value", "--lens": "value", "--from": "value" }, required: ["--dir", "--lens", "--from"] },
  "record-refutation": { flags: { "--dir": "value", "--from": "value" }, required: ["--dir", "--from"] },
};

const nonEmpty = (x) => typeof x === "string" && x.trim() !== "";
const lineOk = (x) => x.line === undefined || x.line === null || (Number.isInteger(x.line) && x.line > 0);

function resultDir(dir) {
  if (!RESULT_DIR_SHAPE.test(resolve(dir).replaceAll("\\", "/"))) {
    throw new UsageError(`--dir must name a directory directly under .devcycle/review/, got "${dir}"`);
  }
  return dir;
}

function readPayload(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`--from must name a readable JSON file: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--from must hold a JSON object");
  return parsed;
}

// A ref beginning with "-" would reach git as an option, so it is refused before any git runs.
function splitRange(ref) {
  const parts = typeof ref === "string" ? ref.split("..") : [];
  if (parts.length !== 2 || !parts.every(nonEmpty) || parts.some((p) => p.startsWith("-"))) {
    throw new UsageError(`--ref must be <base>..<branch> with neither side starting with "-", got "${ref}"`);
  }
  return parts;
}

function commitOf(rev) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`"${rev}" does not resolve to a commit`);
  }
}

function checkLenses(lenses) {
  if (!Array.isArray(lenses) || lenses.length === 0) return "lenses must be a non-empty array";
  const keys = new Set();
  for (const l of lenses) {
    if (!l || !nonEmpty(l.key) || !nonEmpty(l.charter)) return "each lens needs a non-empty key and charter";
    if (keys.has(l.key)) return `lens key "${l.key}" appears twice`;
    keys.add(l.key);
  }
  return null;
}

function loadLensSet(dir) {
  const path = join(dir, LENS_SET_FILE);
  const set = readJsonObject(path);
  if (!set) throw new Error(`no saved lens set at ${path}`);
  const problem = checkLenses(set.lenses);
  if (problem || typeof set.ref !== "string") throw new Error(`the lens set at ${path} is malformed: ${problem ?? "no ref"}`);
  return set;
}

// What a lens result is keyed by: the commits reviewed, the charter, and the spec's text, so a moved
// branch, a changed charter or an edited spec re-runs rather than replays.
function roundInputs(set) {
  const [base, branch] = splitRange(set.ref);
  const commits = [commitOf(base), commitOf(branch)];
  const spec = set.specPath && existsSync(set.specPath) ? readFileSync(set.specPath, "utf8") : null;
  return { reviewedInput: contentKey(...commits), jobKey: (lens) => contentKey("single-lens", ...commits, lens.charter, spec) };
}

function checkFinding(f, at) {
  if (!f || typeof f !== "object") return `${at} is not an object`;
  for (const field of ["file", "claim", "measuredAgainst"]) if (!nonEmpty(f[field])) return `${at}.${field} must be a non-empty string`;
  if (!SEVERITIES.includes(f.severity)) return `${at}.severity must be one of ${SEVERITIES.join(", ")}`;
  if (!lineOk(f)) return `${at}.line must be a positive integer or null`;
  if (f.needsExecution !== undefined && typeof f.needsExecution !== "boolean") return `${at}.needsExecution must be a boolean`;
  return null;
}

function checkStrength(s, at) {
  if (!s || typeof s !== "object") return `${at} is not an object`;
  for (const field of ["file", "claim", "measuredAgainst"]) if (!nonEmpty(s[field])) return `${at}.${field} must be a non-empty string`;
  if (!lineOk(s)) return `${at}.line must be a positive integer or null`;
  return null;
}

// Stored in the shape the panel stores a lens job, so both engines' rounds read alike.
const asFinding = (f, lens) => ({
  file: f.file,
  line: f.line ?? null,
  claim: f.claim,
  severity: f.severity,
  measuredAgainst: f.measuredAgainst,
  needsExecution: f.needsExecution === true,
  lens,
});
const asStrength = (s, lens) => ({ file: s.file, line: s.line ?? null, claim: s.claim, measuredAgainst: s.measuredAgainst, lens });

function storeFor(dir) {
  const notes = [];
  return { store: createResultStore(dir, { atomicWrite, log: (m) => notes.push(m) }), notes };
}

function saveLenses(dir, ref, payload) {
  splitRange(ref);
  const problem = checkLenses(payload.lenses);
  if (problem) throw new UsageError(problem);
  if (payload.specPath != null && !nonEmpty(payload.specPath)) throw new UsageError("specPath, when given, must be a non-empty string");
  const set = {
    ref,
    specPath: payload.specPath ?? null,
    lessons: typeof payload.lessons === "string" ? payload.lessons : "",
    lenses: payload.lenses.map(({ key, charter }) => ({ key, charter })),
  };
  const { store, notes } = storeFor(dir);
  return { saved: store.save(LENS_SET_FILE, set), lenses: set.lenses.map((l) => l.key), notes };
}

function missing(dir) {
  const set = loadLensSet(dir);
  const { jobKey } = roundInputs(set);
  const { store } = storeFor(dir);
  const results = [];
  const absent = [];
  for (const lens of set.lenses) {
    const saved = store.get(lensResultFile(lens.key), jobKey(lens));
    if (saved && Array.isArray(saved.findings)) results.push({ lens: lens.key, findings: saved.findings, strengths: saved.strengths ?? [] });
    else absent.push(lens.key);
  }
  return { missing: absent, results };
}

function record(dir, key, payload) {
  const set = loadLensSet(dir);
  const lens = set.lenses.find((l) => l.key === key);
  if (!lens) throw new UsageError(`--lens "${key}" is not in the saved lens set (${set.lenses.map((l) => l.key).join(", ")})`);
  if (!Array.isArray(payload.findings)) throw new UsageError("findings must be an array");
  if (payload.strengths !== undefined && !Array.isArray(payload.strengths)) throw new UsageError("strengths, when given, must be an array");
  const strengths = payload.strengths ?? [];
  const problem =
    payload.findings.map((f, i) => checkFinding(f, `findings[${i}]`)).find(Boolean) ??
    strengths.map((x, i) => checkStrength(x, `strengths[${i}]`)).find(Boolean);
  if (problem) throw new UsageError(problem);
  const { jobKey } = roundInputs(set);
  const { store, notes } = storeFor(dir);
  const stored = store.put(lensResultFile(key), jobKey(lens), {
    findings: payload.findings.map((f) => asFinding(f, key)),
    strengths: strengths.map((s) => asStrength(s, key)),
  });
  return { recorded: key, stored, findings: payload.findings.length, strengths: strengths.length, notes };
}

function recordRefutation(dir, payload) {
  const set = loadLensSet(dir);
  if (!Array.isArray(payload.verdicts)) throw new UsageError("verdicts must be an array");
  payload.verdicts.forEach((v, i) => {
    const problem = !v || typeof v !== "object" ? `verdicts[${i}] is not an object` : checkFinding(v.finding, `verdicts[${i}].finding`);
    if (problem) throw new UsageError(problem);
    if (!nonEmpty(v.finding.lens)) throw new UsageError(`verdicts[${i}].finding.lens must be a non-empty string`);
    if (typeof v.verified !== "boolean" || !nonEmpty(v.verification)) {
      throw new UsageError(`verdicts[${i}] needs a boolean verified and a non-empty verification`);
    }
  });
  const { reviewedInput } = roundInputs(set);
  const { store, notes } = storeFor(dir);
  let stored = 0;
  for (const v of payload.verdicts) {
    const key = refutationKey(reviewedInput, asFinding(v.finding, v.finding.lens));
    if (store.put(REFUTATION_FILE, key, { verified: v.verified, verification: v.verification })) stored++;
  }
  return { recorded: payload.verdicts.length, stored, notes };
}

function runCommand(command, argv) {
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`the command is ${Object.keys(COMMANDS).join(", ")}, got "${command}"`);
  const flags = taskFlags(argv, spec.flags, spec.required);
  const dir = resultDir(flags["--dir"]);
  if (command === "save-lenses") return saveLenses(dir, flags["--ref"], readPayload(flags["--from"]));
  if (command === "lenses") return loadLensSet(dir);
  if (command === "missing") return missing(dir);
  if (command === "record") return record(dir, flags["--lens"], readPayload(flags["--from"]));
  return recordRefutation(dir, readPayload(flags["--from"]));
}

if (isMain(import.meta.url, process.argv[1])) {
  const [command, ...argv] = process.argv.slice(2);
  runTaskScript("lens-results", () => runCommand(command, argv));
}
