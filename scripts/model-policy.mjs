#!/usr/bin/env node
// Owns which model each devcycle role runs on: the roles, their default tiers, the limits that
// escalate one, and the audit string every resolution records. references/model-policy.json holds
// the data; this file resolves it. scripts/model-pool.mjs keeps the knob arithmetic (pin, pool,
// ladder, ceiling) and is called here for a set `*Model` knob; references/model-routing.md states
// the policy in prose for the reader.
//
// `model: null` is the session tier's interactive form: dispatch with no override and inherit the
// orchestrator. A driven run names the ceiling instead, because there the implicit inherit is not
// reliable. `dispatch` is the family alias the Agent tool's `model` argument accepts; `model` is the
// full id the ledger and `claude -p --model` take.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { sectionText } from "./md-sections.mjs";
import { loadTable, parsePool, rank, resolveModel } from "./model-pool.mjs";
import { PRICING, compareSegments, parseModelId } from "./pricing.mjs";

export const POLICY_PATH = fileURLToPath(new URL("../references/model-policy.json", import.meta.url));

export const ROLES = Object.freeze([
  "starter", "driver", "coordinator", "implementer", "task-reviewer", "branch-review", "walkthrough",
  "planning-session", "research", "spike", "checker", "drafter", "repair",
]);

const DISPATCH_ALIASES = ["sonnet", "opus", "haiku", "fable"];

export function loadPolicy(path = POLICY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function dispatchAlias(id) {
  if (typeof id !== "string") return null;
  const lower = id.toLowerCase();
  return DISPATCH_ALIASES.find((alias) => lower.includes(alias)) ?? null;
}

export function fastTierId(ceiling, { table = loadTable(), pricing = PRICING } = {}) {
  const ceilingRank = rank(ceiling, table);
  if (ceilingRank === null) return null;
  const { fastFamily } = loadPolicy();
  if (ceilingRank < rank(fastFamily, table)) return ceiling;
  let best = null;
  for (const id of Object.keys(pricing.models)) {
    const parsed = parseModelId(id);
    if (parsed?.family !== fastFamily) continue;
    if (!best || compareSegments(parsed.version, best.version) > 0) best = { id, version: parsed.version };
  }
  return best?.id ?? null;
}

export function ceilingFrom({ driveRow = "", orchestrator, transcriptModel } = {}) {
  const driven = /^auto\s/.test(driveRow) ? /\bmodel=(\S+)/.exec(driveRow) : null;
  if (driven) return { ceiling: driven[1], driven: true };
  if (orchestrator) return { ceiling: orchestrator, driven: false };
  let fromTranscript;
  try {
    fromTranscript = transcriptModel?.();
  } catch {
    fromTranscript = undefined;
  }
  return { ceiling: fromTranscript || "unknown", driven: false };
}

export function implementerSignals({ files = 0, deps = "none", stepsUnspecified = false, priorRejected = false } = {}, policy = loadPolicy()) {
  const signals = [];
  if (files > policy.roles.implementer.limits.maxFiles) signals.push(`files=${files}`);
  if (deps !== "none") signals.push(`deps=${deps}`);
  if (stepsUnspecified) signals.push("steps=unspecified");
  if (priorRejected) signals.push("retry=prior-rejection");
  return signals;
}

export function reviewerSignals(stat, policy = loadPolicy()) {
  if (stat === null || stat === undefined) return null;
  const { maxLines, maxFiles } = policy.roles["task-reviewer"].limits;
  const signals = [];
  if (stat.lines > maxLines) signals.push(`lines=${stat.lines}`);
  if (stat.files > maxFiles) signals.push(`files=${stat.files}`);
  return signals;
}

export function resolveRole(role, { ceiling, driven = false, knob, facts = {}, policy = loadPolicy(), table = loadTable() }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role "${role}" — one of ${ROLES.join(", ")}`);
  const entry = policy.roles[role];
  const fast = fastTierId(ceiling, { table });
  const sameTier = fast !== null && dispatchAlias(fast) === dispatchAlias(ceiling);
  // "unknown" is the ceiling's absence, never a model id to hand to a dispatch.
  const named = ceiling === "unknown" ? null : ceiling;

  const result = (model, tier, outcome) => ({
    role, model, dispatch: dispatchAlias(model), effort: entry.effort, tier, outcome,
  });

  // The session tier: no override interactive; the ceiling by name when driven. A `(ceiling: …)`
  // outcome is model-pool's own wording for an unranked ceiling and stays verbatim.
  const sessionTier = (outcome, tier = "session") => {
    if (!driven) return result(null, tier, outcome);
    const recorded = outcome.startsWith("model session (ceiling:") ? outcome : outcome.replace(/^model session/, `model session:${ceiling}`);
    return result(ceiling, tier, recorded);
  };

  // A planning role always names its model, so there is no no-override form to fall back to.
  const planningTier = (label, fastOutcome) => fast !== null
    ? result(fast, "fast", `model fast:${fast} (${label}: ${fastOutcome})`)
    : result(named, "session", `model ${ceiling} (${label}: session tier, no fast tier under ${ceiling})`);
  const sessionNamed = (label, why) => result(named, "session", `model ${ceiling} (${label}: ${why})`);

  switch (role) {
    case "driver":
      return { role, model: null, dispatch: null, effort: null, tier: "none", outcome: "model none (driver: model-free)" };
    case "starter":
      return { role, model: null, dispatch: null, effort: null, tier: "user", outcome: "model user (starter)" };
    case "coordinator": {
      if (fast === null || rank(ceiling, table) <= rank(fast, table))
        return { ...result(ceiling, "session", `model ${ceiling} (coordinator: ceiling)`), dispatch: null };
      return { ...result(fast, "fast", `model ${fast} (coordinator: fast tier under ${ceiling})`), dispatch: null };
    }
    case "planning-session":
      return sessionNamed("planning-session", "session tier");
    case "research": case "spike": case "checker":
      return planningTier(role, "fast tier");
    case "drafter": {
      const { codePinned, newAbstraction, maxFiles = 0, crossPackage } = facts;
      const reasons = [];
      if (codePinned) reasons.push("code-pinned");
      if (newAbstraction) reasons.push("new-abstraction");
      if (maxFiles > entry.limits.maxFiles) reasons.push(`files=${maxFiles}`);
      if (crossPackage) reasons.push("cross-package");
      return reasons.length
        ? sessionNamed("drafter", `session tier on ${reasons.join(", ")}`)
        : planningTier("drafter", "fast tier");
    }
    case "repair":
      return facts.drafterTier === "fast" && fast !== null
        ? result(fast, "fast", `model fast:${fast} (repair: drafter's fast tier)`)
        : sessionNamed("repair", "drafter's session tier");
  }

  const setKnob = entry.knob && parsePool(knob).kind !== "unset";
  if (setKnob) {
    const signalCount = role === "implementer" ? implementerSignals(facts, policy).length
      : role === "task-reviewer" ? reviewerSignals(facts.stat ?? null, policy)?.length ?? Infinity
        : Infinity;
    const pooled = resolveModel({ value: knob, signalCount, orchestratorId: ceiling, table });
    return result(pooled.model ?? (driven ? ceiling : null), "knob", pooled.outcome);
  }

  if (role === "branch-review" || role === "walkthrough") return sessionTier("model session (auto)");

  const signals = role === "implementer" ? implementerSignals(facts, policy) : reviewerSignals(facts.stat ?? null, policy);
  if (signals === null) return sessionTier("model session (auto: no file list)");
  if (fast === null) return sessionTier(`model session (ceiling: ${ceiling} unranked)`);
  if (!signals.length) {
    const basis = role === "implementer"
      ? `files=${facts.files ?? 0}, deps=${facts.deps ?? "none"}, steps=${facts.stepsUnspecified ? "unspecified" : "specified"}`
      : `lines=${facts.stat.lines}, files=${facts.stat.files}`;
    return result(fast, "fast", `model fast:${fast} (auto: ${basis})`);
  }
  if (sameTier)
    return result(fast, "fast", `model fast:${fast} (auto: session tier is the fast tier; signals ${signals.join(", ")})`);
  return sessionTier(`model session (auto: escalated on ${signals.join(", ")})`);
}

// references/model-routing.md § Roles renders this table from the policy; validate check 32 holds
// the two together, so the role table is written once, in references/model-policy.json.
export const ROLES_TABLE_HEAD = "| Role | Layer | Default | Override |\n| --- | --- | --- | --- |";

export function rolesTableRows(policy = loadPolicy()) {
  return Object.entries(policy.roles).map(
    ([role, { layer, default: fallback, knob }]) => `| \`${role}\` | ${layer} | ${fallback} | ${knob ? `\`${knob}\`` : "none"} |`,
  );
}

export function rolesTableErrors(policy, routingText) {
  const section = sectionText(routingText, "roles");
  if (section === null)
    return ["references/model-routing.md: no ## Roles section to render references/model-policy.json's role table into"];
  const present = section.split("\n").filter((line) => line.startsWith("| `"));
  const roleOf = (row) => /^\| `([^`]+)`/.exec(row)?.[1];
  const errors = [];
  for (const row of rolesTableRows(policy)) {
    if (!present.includes(row))
      errors.push(`references/model-routing.md § Roles: the ${roleOf(row)} row differs from references/model-policy.json — expected: ${row}`);
  }
  for (const row of present) {
    if (!Object.hasOwn(policy.roles, roleOf(row)))
      errors.push(`references/model-routing.md § Roles: a row names ${roleOf(row)}, which references/model-policy.json does not hold`);
  }
  return errors;
}

// Every flag this CLI reads; an unrecognised one is an operator error, as in scripts/model-pool.mjs.
const KNOWN_FLAGS = { "--role": "value", "--ceiling": "value", "--driven": "none", "--knob": "value", "--facts": "value" };

function cliResolve(argv) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const role = requireValue(flags, "--role", "a role id");
  if (role === undefined) throw new Error("--role is required");
  const ceiling = requireValue(flags, "--ceiling", "a model id");
  if (ceiling === undefined) throw new Error("--ceiling is required");
  const rawFacts = requireValue(flags, "--facts", "a JSON object");
  let facts = {};
  if (rawFacts !== undefined) {
    try {
      facts = JSON.parse(rawFacts);
    } catch (e) {
      throw new Error(`--facts is not valid JSON: ${e.message}`);
    }
  }
  return resolveRole(role, { ceiling, driven: "--driven" in flags, knob: requireValue(flags, "--knob", "a model id or pool"), facts });
}

if (isMain(import.meta.url, process.argv[1])) {
  try {
    console.log(JSON.stringify(cliResolve(process.argv.slice(2))));
  } catch (e) {
    console.error(`model-policy: ${e.message}`);
    process.exit(2);
  }
}
