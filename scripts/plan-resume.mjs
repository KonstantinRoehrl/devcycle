#!/usr/bin/env node
// Derives where a planning stage stands from disk alone -- the stage-log rows of the state file's run
// and the work files under .devcycle/plan-work/<run id>/, never a transcript -- so a session cleared
// mid-planning can resume. planPosition() is pure; readPlanPosition() reads the disk for it, and the
// CLI prints the position.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { readStage } from "./stage-log.mjs";
import { field } from "./md-field.mjs";
import { UsageError } from "./task-ledger.mjs";
import { assemblePlan, edgeBatches, readTasks, sha256Hex } from "./plan-assemble.mjs";
import { taskBlocks } from "./task-files.mjs";
import { parseCut } from "./plan-strategy.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { makeTempDir } from "./temp-dir.mjs";
import { parseRecordedLine } from "./resolve-knobs.mjs";

const USAGE = "usage: plan-resume.mjs --state <path>";
const GROUP_KEY = /^plan-group-(\d+)$/;
const DRAFT_KEY = /^plan-draft-(\d+)$/;
const REPAIR_KEY = /^plan-repair-(\d+)$/;
const ROUND_DIR = /^round-(\d+)$/;
const BATCH_FILE = /^batch-\d+\.md$/;
const SECTION_PREFIX = "plan-section-";
// The edge checker's batch size, as references/delegated-planning.md § Edge checker runs it.
const CHECKER_BATCH = 8;
const CHECKER_STRATEGIES = new Set(["delegated", "grouped", "grouped-fork"]);

const ascending = (a, b) => a - b;
const numbersOf = (rows, pattern) => [...new Set(rows.map(({ key }) => key.match(pattern)).filter(Boolean).map((m) => Number(m[1])))].sort(ascending);
const rowOf = (rows, key) => rows.find((row) => row.key === key);
// readStage returns each key's latest line in the order those lines were appended, so a tie on the
// second-resolution `at` stamp falls back to that order.
const loggedAfter = (rows, later, earlier) => later.at > earlier.at || (later.at === earlier.at && rows.indexOf(later) > rows.indexOf(earlier));
const stepStatus = (row, done, ambiguous = false) => (row ? (done ? "done" : "redo") : ambiguous ? "ambiguous" : "pending");

// The post-draft steps in the path's order; references/stage-log.md's planning row names their keys.
function postDraftSteps({ rows, path, assembled, checker, planOnDisk }) {
  const assembly = rowOf(rows, "plan-assembled");
  const steps = [];
  if (path !== "thorough") {
    const edits = rows.filter(({ key }) => DRAFT_KEY.test(key) || REPAIR_KEY.test(key));
    const current = assembly !== undefined && assembled?.matches === true && edits.every((row) => loggedAfter(rows, assembly, row));
    steps.push({ id: "plan-assembled", status: stepStatus(assembly, current, planOnDisk) });
  }
  if (path === "checker") {
    const round = rowOf(rows, "checker-round-1");
    const { expected, filled = 0 } = checker.get(1) ?? {};
    // A round with no edge to check has no batch to dispatch, so it is done whatever its row says.
    const status = expected === 0 ? "done" : stepStatus(round, expected > 0 && filled === expected, filled > 0);
    // The batch counts are additive: they let the recovery inventory say how much of an unlogged round exists.
    steps.push({ id: "checker-round-1", status, ...(expected === undefined ? {} : { expected, filled }) });
    if (round?.data?.findings > 0) {
      const repair = rowOf(rows, "plan-repair-1");
      steps.push({ id: "plan-repair-1", status: stepStatus(repair, assembly !== undefined && repair !== undefined && loggedAfter(rows, assembly, repair)) });
    }
  }
  steps.push({ id: "plan-gate", status: rowOf(rows, "plan-gate") ? "re-verify" : "pending" });
  return steps;
}

function nextStep({ rows, path, cut, missing, steps, planOnDisk }) {
  const status = (id) => steps.find((step) => step.id === id)?.status;
  const gate = rowOf(rows, "plan-gate");
  // The sub-skill writes a thorough plan whole, so only the plan file and the gate say where it stands.
  if (path === "thorough") return !planOnDisk ? "draft" : gate?.data?.exit === 0 ? "present" : "gate";
  if (rowOf(rows, "drafting-plan") === undefined && cut === null) return "draft";
  if (missing.length > 0) return "draft";
  if (status("plan-assembled") !== "done") return "assemble";
  if (path === "checker" && status("checker-round-1") !== "done") return "checker";
  if (status("plan-repair-1") !== undefined && status("plan-repair-1") !== "done") return "repair";
  const assembly = rowOf(rows, "plan-assembled");
  return gate?.data?.exit === 0 && loggedAfter(rows, gate, assembly) ? "present" : "gate";
}

export function planPosition({ rows, taskFiles, cut, pack, refExists = () => true, assembled = null, checker = new Map(), planOnDisk = false, profile = null }) {
  const groupsDone = numbersOf(rows, GROUP_KEY);
  const filed = new Set(taskFiles);
  const drafted = numbersOf(rows, DRAFT_KEY).filter((num) => filed.has(num));
  const done = new Set(drafted);
  const missing = cut === null ? [] : cut.map(({ num }) => num).filter((num) => !done.has(num)).sort(ascending);
  let nextGroup = null;
  if (missing.length > 0) {
    nextGroup = 1;
    while (groupsDone.includes(nextGroup)) nextGroup++;
  }
  const sections = rows
    .filter(({ key, ref }) => key.startsWith(SECTION_PREFIX) && (ref === undefined || refExists(ref)))
    .map(({ key }) => key.slice(SECTION_PREFIX.length))
    .sort();
  const strategy = rowOf(rows, "drafting-plan")?.data?.strategy ?? null;
  const path = profile === "thorough" ? "thorough" : CHECKER_STRATEGIES.has(strategy) ? "checker" : "inline";
  const steps = postDraftSteps({ rows, path, assembled, checker, planOnDisk });
  return { strategy, groupsDone, nextGroup, drafted, missing, sections, pack, next: nextStep({ rows, path, cut, missing, steps, planOnDisk }), steps };
}

const readOrNull = (path) => (existsSync(path) ? readFileSync(path) : null);

// The work directory assembled afresh into a temp file, or null when it no longer assembles.
function freshAssembly(workDir) {
  const header = readOrNull(join(workDir, "plan-header.md"));
  const dispatchMap = readOrNull(join(workDir, "dispatch-map.md"));
  if (header === null || dispatchMap === null || !existsSync(join(workDir, "tasks"))) return null;
  const { plan, errors } = assemblePlan({ header: header.toString("utf8"), tasks: readTasks(workDir), dispatchMap: dispatchMap.toString("utf8") });
  if (errors.length) return null;
  const dir = makeTempDir("plan-resume-assembly-");
  try {
    atomicWrite(join(dir, "plan.md"), plan);
    return readFileSync(join(dir, "plan.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fails open: a plan or work file that is gone or no longer assembles reads as not matching.
function assemblyCheck(row, root, workDir) {
  if (row === undefined) return null;
  try {
    const plan = typeof row.ref === "string" ? readOrNull(resolve(root, row.ref)) : null;
    const fresh = plan === null ? null : freshAssembly(workDir);
    return { matches: plan !== null && row.data?.sha256 === sha256Hex(plan) && fresh !== null && fresh.equals(plan) };
  } catch {
    return { matches: false };
  }
}

// Each checker round directory's expected batch count and its non-empty batch files. Round 1 is always
// there once task files exist, so a work dir with no edge to check reads as a round with nothing to do.
function checkerRounds(workDir) {
  const rounds = new Map();
  if (!existsSync(join(workDir, "tasks"))) return rounds;
  let expected;
  try {
    expected = edgeBatches(workDir, CHECKER_BATCH).length;
  } catch {
    return rounds;
  }
  rounds.set(1, { expected, filled: 0 });
  const dir = join(workDir, "checker");
  if (!existsSync(dir)) return rounds;
  for (const name of readdirSync(dir)) {
    const n = name.match(ROUND_DIR)?.[1];
    if (n === undefined) continue;
    const round = join(dir, name);
    const filled = readdirSync(round).filter((file) => BATCH_FILE.test(file) && statSync(join(round, file)).size > 0).length;
    rounds.set(Number(n), { expected, filled });
  }
  return rounds;
}

// The absolute path `path` names under `root`, or null when it resolves outside root or to root itself.
export function pathInsideRoot(root, path) {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? abs : null;
}

export function readPlanPosition(statePath) {
  if (!existsSync(statePath)) throw new Error(`no state file at ${statePath}`);
  const devcycleDir = dirname(resolve(statePath));
  const root = dirname(devcycleDir);
  const stateText = readFileSync(statePath, "utf8");
  const run = field(stateText, "run");
  let rows;
  try {
    rows = readStage(devcycleDir, { run, stage: "planning" });
  } catch (e) {
    if (e instanceof UsageError) throw new Error(`${statePath} names no run, so there is no planning position to resume`);
    throw e;
  }
  const workDir = join(devcycleDir, "plan-work", run);

  const named = rowOf(rows, "drafting-plan")?.data?.cut;
  const cutPath = named === undefined ? join(workDir, "task-cut.json") : resolve(root, named);
  let cut = null;
  if (existsSync(cutPath)) {
    const parsed = parseCut(readFileSync(cutPath, "utf8"));
    if (parsed.errors.length) throw new Error(parsed.errors.map((error) => `${cutPath}: ${error}`).join("\n"));
    cut = parsed.cut;
  } else if (named !== undefined) throw new Error(`no task cut at ${cutPath}`);

  const taskFiles = existsSync(join(workDir, "tasks")) ? readTasks(workDir).flatMap(({ text }) => taskBlocks(text).map(({ num }) => num)) : [];
  const plan = field(stateText, "plan");
  const planPath = typeof plan === "string" && plan !== "none" ? pathInsideRoot(root, plan) : null;
  return planPosition({
    rows,
    taskFiles,
    cut,
    pack: existsSync(join(workDir, "pack.md")),
    refExists: (ref) => existsSync(resolve(root, ref)),
    assembled: assemblyCheck(rowOf(rows, "plan-assembled"), root, workDir),
    checker: checkerRounds(workDir),
    planOnDisk: planPath !== null && existsSync(planPath),
    profile: parseRecordedLine(field(stateText, "knobs") ?? "").profile ?? null,
  });
}

function usage(message) {
  if (message) console.error(`plan-resume: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function main(argv) {
  let statePath;
  try {
    const { flags } = parseFlags(argv, { "--state": "value" }, { requireValues: "nonEmpty" });
    statePath = requireValue(flags, "--state");
  } catch (e) {
    usage(e.message);
  }
  if (statePath === undefined) usage("--state is required");
  let position;
  try {
    position = readPlanPosition(statePath);
  } catch (e) {
    for (const line of e.message.split("\n")) console.error(`plan-resume: ${line}`);
    process.exit(1);
  }
  console.log(JSON.stringify(position, null, 2));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
