// Scores a benchmark pass: each replay's collected transcripts and run record go through doctor's own
// summarizer and doctor-planning.mjs's P1-P12 rubric, so the benchmark and `/devcycle:doctor` can
// never disagree about a run. Spends nothing; `plan-bench.mjs score` re-runs it on any pass.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTranscriptFiles, parseArgs, readRunRecords, summarizeCorpus } from "./doctor.mjs";
import { planningBreakdowns } from "./doctor-planning.mjs";
import { field } from "./md-field.mjs";

export const RUBRIC_IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"];

/** Doctor's planning breakdowns for one replay's corpus/ and runs/ directories. */
export function replayBreakdowns(replayDir) {
  const corpus = join(replayDir, "corpus");
  const files = findTranscriptFiles(corpus) ?? [];
  // --all: every session in a replay corpus is the replay's own, whatever it was tagged.
  const { sessions } = summarizeCorpus(files, parseArgs(["--dir", corpus, "--all"]), readRunRecords(join(replayDir, "runs")));
  return planningBreakdowns(sessions);
}

/**
 * Whether the replay ran the arm it was meant to: the planningStrategy its state file's `knobs:` line
 * resolved, compared with the arm. The run record does not carry that knob (commands/cycle.md's
 * `--knob` list omits it), so the state file is the one place the session's own value is kept; a replay
 * with no state file or no planningStrategy on the line cannot be checked and is `arm-unverified`.
 * @param {string} replayDir a `<passDir>/<id>--<arm>` directory
 * @param {string} arm the arm the replay was started as
 * @returns {{armCheck: "verified"|"arm-mismatch"|"arm-unverified", armSeen: string|null}}
 */
export function armCheck(replayDir, arm) {
  const statePath = join(replayDir, "state.md");
  const knobs = existsSync(statePath) ? field(readFileSync(statePath, "utf8"), "knobs") ?? "" : "";
  const seen = /(?:^|\s)planningStrategy=(\S+)/.exec(knobs)?.[1] ?? null;
  if (seen === null) return { armCheck: "arm-unverified", armSeen: null };
  return { armCheck: seen === arm ? "verified" : "arm-mismatch", armSeen: seen };
}

/**
 * One replay's score: its outcome.json beside the breakdown of the run it planned. A replay whose
 * session left no planning breakdown scores with `rubric: null`, never with zeros.
 * @param {string} replayDir a `<passDir>/<id>--<arm>` directory
 * @param {(dir: string) => {runId: string, breakdown: object}[]} [breakdownsOf]
 */
export function scoreReplay(replayDir, breakdownsOf = replayBreakdowns) {
  const outcome = JSON.parse(readFileSync(join(replayDir, "outcome.json"), "utf8"));
  const found = breakdownsOf(replayDir);
  const b = found.at(-1)?.breakdown ?? null;
  return {
    id: outcome.id, size: outcome.size, arm: outcome.arm, outcome: outcome.outcome, usd: outcome.usd,
    legs: outcome.legs.length, denials: outcome.legs.reduce((n, l) => n + l.denials, 0),
    ...armCheck(replayDir, outcome.arm),
    runId: found.at(-1)?.runId ?? null,
    rubric: b ? b.rubric : null, byRole: b ? b.byRole : null, planDefects: b ? b.planDefects : null, raw: b ? b.raw : null,
    projection: b ? b.projection : null,
  };
}

export const cell = (row) => {
  if (!row) return "—";
  const v = row.value;
  const text = v === null || v === undefined ? "—"
    : typeof v === "object" ? Object.values(v).map((n) => (n === null || n === undefined ? "—" : +Number(n).toFixed(3))).join("/")
      : typeof v === "number" ? String(+v.toFixed(3)) : String(v);
  return `${text} ${row.status}`;
};

// An arm that was not confirmed is named beside the outcome, so a table never reads as a clean comparison it is not.
const outcomeCell = (r) => (r.armCheck === "arm-mismatch" ? `${r.outcome} (arm-mismatch: saw ${r.armSeen})`
  : r.armCheck === "arm-unverified" ? `${r.outcome} (arm-unverified)` : r.outcome);

/** The pass table: one row per replay, P1-P12 as `<value> <pass|fail|n/a>`; an unconfirmed arm is flagged in its Outcome cell. */
export function resultsMarkdown(results) {
  const head = ["Entry", "Arm", "Outcome", "$", ...RUBRIC_IDS];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of results) {
    const byId = new Map((r.rubric ?? []).map((row) => [row.id, row]));
    lines.push(`| ${[r.id, r.arm, outcomeCell(r), r.usd.toFixed(2), ...RUBRIC_IDS.map((id) => cell(byId.get(id)))].join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * Scores the replays of a pass directory, in name order, and writes results.json and results.md beside
 * them. The replays are the ones `pass.json` names, so an outcome left by an earlier run of the same pass
 * id is not counted; a pass directory with no `pass.json` is scored by every outcome it holds.
 * @returns {object[]} the results
 */
export function scorePass(passDir, breakdownsOf = replayBreakdowns) {
  const started = existsSync(join(passDir, "pass.json")) ? new Set(JSON.parse(readFileSync(join(passDir, "pass.json"), "utf8")).replays) : null;
  const replays = existsSync(passDir)
    ? readdirSync(passDir).filter((d) => (!started || started.has(d)) && existsSync(join(passDir, d, "outcome.json"))).sort()
    : [];
  const results = replays.map((d) => scoreReplay(join(passDir, d), breakdownsOf));
  writeFileSync(join(passDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(passDir, "results.md"), resultsMarkdown(results) + "\n");
  return results;
}
