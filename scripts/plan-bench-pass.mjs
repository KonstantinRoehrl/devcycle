// One benchmark pass (spec §9.9): for each manifest entry and arm, a scratch clone at the entry's
// baseSha, headless `claude -p` legs driven through planning's gates from the entry's answers, the
// optional execution legs, and the run record and transcripts collected for scoring. Headless
// sessions have no AskUserQuestion, so a gate ends the session with its question as result text and
// the answer resumes the same session (docs/platform-notes.md § (r)). Every spawn goes through
// `spawnLeg`, so the tests drive this module without a model.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { field } from "./md-field.mjs";
import { makeTempDir } from "./temp-dir.mjs";

export const LEG_CAP = 8;
export const PLANNING_STAGES = new Set(["scoping", "audit", "diagnosis", "brainstorm", "planning"]);
export const CONTINUE_PROMPT = "/devcycle:continue";

/** The first prompt of a replay: plan the entry's spec, which the corpus records as approved. */
export const planPrompt = (specRel) =>
  `/devcycle:cycle Plan the approved spec at ${specRel}. It is approved: enter planning against it and stop at the planning handoff.`;

const handoffReady = (stateText) => /^ready\b/.test(field(stateText, "handoff") ?? "");

/**
 * What a finished leg means for the replay.
 * @param {{phase: "plan"|"execute", stateText: string, leg: {isError: boolean, text: string|null}}} input
 * @returns {"done"|"next"|"no-go"|"question"|"error"}
 *   done: the phase's target stage was reached; next: a handoff inside execution, so a fresh
 *   `/devcycle:continue` leg follows; no-go: planning handed off without a plan; question: the
 *   session stopped on a gate.
 */
export function classifyLeg({ phase, stateText, leg }) {
  if (leg.isError || leg.text === null) return "error";
  const stage = field(stateText, "stage");
  if (phase === "plan") {
    const plan = field(stateText, "plan");
    if (stage && !PLANNING_STAGES.has(stage) && plan && plan !== "none") return "done";
    return stage === "planning" && handoffReady(stateText) ? "no-go" : "question";
  }
  if (stage && stage !== "execution") return "done";
  return handoffReady(stateText) ? "next" : "question";
}

/** The first answer not yet used whose `match` (case-insensitive) finds the question; -1 when none does. */
export function pickAnswer(answers, used, text) {
  return answers.findIndex((a, i) => !used.has(i) && new RegExp(a.match, "i").test(text));
}

/**
 * The argv of one headless leg — the driver's flags (docs/platform-notes.md § (k)) plus the bench
 * settings and a spend cap.
 */
export function legArgs({ prompt, resume, pluginDir, settings, model, maxBudgetUsd }) {
  return [
    "-p", prompt, ...(resume ? ["--resume", resume] : []),
    "--plugin-dir", pluginDir, "--settings", JSON.stringify(settings),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--model", model, "--max-budget-usd", maxBudgetUsd.toFixed(2),
    "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
  ];
}

/** A leg's stream-json output, reduced to what the replay needs. No result event reads as an error. */
export function parseLeg(stdout) {
  let init = null;
  let result = null;
  for (const line of String(stdout).split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === "system" && e.subtype === "init") init = e;
    if (e?.type === "result") result = e;
  }
  if (!result) return { sessionId: init?.session_id ?? null, costUsd: 0, text: null, isError: true, denials: 0 };
  return {
    sessionId: result.session_id ?? init?.session_id ?? null,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
    text: typeof result.result === "string" ? result.result : null,
    isError: result.is_error === true,
    denials: Array.isArray(result.permission_denials) ? result.permission_denials.length : 0,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Drives one entry × arm to its outcome. Pure apart from `spawnLeg` and `readState`.
 * @param {{execute: boolean, prompt: string, answers: {match: string, reply: string}[], budgetUsd: number,
 *   spawnLeg: (args: {prompt: string, resume: string|null, maxBudgetUsd: number}) => string, readState: () => string}} input
 * @returns {{outcome: "planned"|"executed"|"no-go"|"unanswered"|"error"|"budget-stop"|"leg-cap", usd: number,
 *   legs: {phase: string, sessionId: string|null, costUsd: number, denials: number, verdict: string}[], question: string|null}}
 */
export function runEntryArm({ execute, prompt, answers, budgetUsd, spawnLeg, readState }) {
  const legs = [];
  const used = new Set();
  let phase = "plan";
  let resume = null;
  let next = prompt;
  let spent = 0;
  const end = (outcome, question = null) => ({ outcome, usd: round2(spent), legs, question });
  while (legs.length < LEG_CAP) {
    if (spent >= budgetUsd) return end("budget-stop");
    const leg = parseLeg(spawnLeg({ prompt: next, resume, maxBudgetUsd: budgetUsd - spent }));
    spent += leg.costUsd;
    const verdict = classifyLeg({ phase, stateText: readState(), leg });
    legs.push({ phase, sessionId: leg.sessionId, costUsd: leg.costUsd, denials: leg.denials, verdict });
    if (verdict === "error") return end("error");
    if (verdict === "no-go") return end("no-go");
    if (verdict === "done" && (phase === "execute" || !execute)) return end(phase === "plan" ? "planned" : "executed");
    if (verdict === "done" || verdict === "next") {
      phase = "execute";
      resume = null;
      next = CONTINUE_PROMPT;
      continue;
    }
    const i = pickAnswer(answers, used, leg.text);
    if (i === -1) return end("unanswered", leg.text);
    used.add(i);
    resume = leg.sessionId;
    next = answers[i].reply;
  }
  return end("leg-cap");
}

/**
 * Copies each session's transcript and its subagent directory out of the Claude projects root into
 * `dest/<project dir>/`, the layout doctor's --dir reads. Returns the number of sessions found.
 */
export function collectTranscripts({ projectsRoot, sessionIds, dest }) {
  let found = 0;
  const dirs = existsSync(projectsRoot) ? readdirSync(projectsRoot) : [];
  for (const sid of new Set(sessionIds.filter(Boolean))) {
    const project = dirs.find((d) => existsSync(join(projectsRoot, d, `${sid}.jsonl`)));
    if (!project) continue;
    found += 1;
    mkdirSync(join(dest, project), { recursive: true });
    cpSync(join(projectsRoot, project, `${sid}.jsonl`), join(dest, project, `${sid}.jsonl`));
    if (existsSync(join(projectsRoot, project, sid))) cpSync(join(projectsRoot, project, sid), join(dest, project, sid), { recursive: true });
  }
  return found;
}

/**
 * A scratch clone of `repoPath` detached at `baseSha`, with the entry's spec copied in. A clone, not a
 * worktree: a replay's execution leg cuts branches, which must never land in the source repo.
 * @returns {{dir: string, specRel: string}}
 */
export function cutClone({ repoPath, baseSha, specPath, parent }) {
  const dir = join(parent, "repo");
  const git = (args) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  };
  git(["clone", "--quiet", "--no-checkout", repoPath, dir]);
  git(["-C", dir, "checkout", "--quiet", "--detach", baseSha]);
  const specRel = isAbsolute(specPath) ? join("docs", "superpowers", "specs", basename(specPath)) : specPath;
  const source = isAbsolute(specPath) ? specPath : join(repoPath, specPath);
  mkdirSync(join(dir, specRel, ".."), { recursive: true });
  cpSync(source, join(dir, specRel));
  return { dir, specRel };
}

/**
 * Runs every entry × arm of one pass in order, stopping once the budget is spent, and writes each
 * replay's artifacts under `<passDir>/<id>--<arm>/`: leg-<n>.jsonl, state.md, runs/ (the
 * DEVCYCLE_RUNS_DIR the session wrote), corpus/ (its transcripts) and outcome.json.
 * @param {{entries: object[], arms: string[], answers: {prompt: string|null, answers: object[]}[], budget: number}} common
 * @param {{passDir: string, pluginDir: string, model: string, settingsFor: (arm: string) => object, projectsRoot: string,
 *   spawn: (args: string[], options: {cwd: string, env: object}) => string, env?: object}} opts
 * @returns {object[]} one outcome per replay that ran
 */
export function runPass(common, { passDir, pluginDir, model, settingsFor, projectsRoot, spawn, env = process.env }) {
  const outcomes = [];
  let spent = 0;
  for (const [i, entry] of common.entries.entries())
    for (const arm of common.arms) {
      const budgetUsd = common.budget - spent;
      if (budgetUsd <= 0) return outcomes;
      const out = join(passDir, `${entry.id}--${arm}`);
      mkdirSync(join(out, "runs"), { recursive: true });
      const { dir, specRel } = cutClone({ ...entry, parent: makeTempDir("plan-bench-") });
      const legEnv = { ...env, DEVCYCLE_RUNS_DIR: join(out, "runs"), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };
      const statePath = join(dir, ".devcycle", "state.md");
      let n = 0;
      const result = runEntryArm({
        execute: entry.execute,
        prompt: common.answers[i].prompt ?? planPrompt(specRel),
        answers: common.answers[i].answers,
        budgetUsd,
        readState: () => (existsSync(statePath) ? readFileSync(statePath, "utf8") : ""),
        spawnLeg: ({ prompt, resume, maxBudgetUsd }) => {
          const stdout = spawn(legArgs({ prompt, resume, pluginDir, settings: settingsFor(arm), model, maxBudgetUsd }), { cwd: dir, env: legEnv });
          writeFileSync(join(out, `leg-${++n}.jsonl`), stdout);
          return stdout;
        },
      });
      if (existsSync(statePath)) cpSync(statePath, join(out, "state.md"));
      const sessions = collectTranscripts({ projectsRoot, sessionIds: result.legs.map((l) => l.sessionId), dest: join(out, "corpus") });
      const outcome = { id: entry.id, size: entry.size, arm, ...result, sessions };
      writeFileSync(join(out, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n");
      outcomes.push(outcome);
      spent += result.usd;
      if (result.outcome === "budget-stop") return outcomes;
    }
  return outcomes;
}
