// Plan pre-flight leg: a repo's own gate rules, declared in its committed
// tests/fixtures/gate-rules.json, say which files a task that touches or creates matching paths must
// also list -- the files a task's own gate later reads or ratchets (#505). The script names no repo's
// paths: a repo without the file has no rules, and a malformed file is a finding, never a silent pass.
// plan-check.mjs runs gateRulesLeg; brief-completeness-check.mjs's standalone CLI runs gateRuleGaps.
// See playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { taskBlocks, taskFileMap, createdFiles, normalizeFileToken } from "./task-files.mjs";

export const GATE_RULES_PATH = "tests/fixtures/gate-rules.json";

const RULE_KEYS = new Set(["id", "when", "require", "requireOneOf", "oncePerTask", "why"]);
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s !== "");

// One rule's shape problem, or null. Strict on purpose: a misspelt key would otherwise drop a rule
// without a word, which is the silent pass a broken rules file must never get.
function ruleError(rule, index) {
  const at = `rules[${index}]`;
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return `${at} is not an object`;
  const unknown = Object.keys(rule).filter((k) => !RULE_KEYS.has(k));
  if (unknown.length) return `${at} has unknown key(s) ${unknown.join(", ")}`;
  if (typeof rule.id !== "string" || rule.id === "") return `${at} needs a non-empty "id"`;
  const { when } = rule;
  if (typeof when !== "object" || when === null || Array.isArray(when)) return `${rule.id}: "when" must be an object`;
  const whenKeys = Object.keys(when);
  if (whenKeys.length === 0 || whenKeys.some((k) => !["touches", "creates"].includes(k) || !isStringList(when[k])))
    return `${rule.id}: "when" takes "touches" and/or "creates", each a non-empty list of globs`;
  if (("require" in rule) === ("requireOneOf" in rule)) return `${rule.id}: needs exactly one of "require" or "requireOneOf"`;
  if ("require" in rule && !isStringList(rule.require)) return `${rule.id}: "require" must be a non-empty list of paths`;
  if ("requireOneOf" in rule && !isStringList(rule.requireOneOf)) return `${rule.id}: "requireOneOf" must be a non-empty list of globs`;
  if ("oncePerTask" in rule && typeof rule.oncePerTask !== "boolean") return `${rule.id}: "oncePerTask" must be true or false`;
  if (typeof rule.why !== "string" || rule.why === "") return `${rule.id}: needs a non-empty "why"`;
  return null;
}

// The repo's rules: `{ rules: null, error: null }` when the file is absent, `{ rules: null, error }`
// when it is unreadable or malformed.
export function loadGateRules(repoRoot) {
  const path = join(repoRoot, GATE_RULES_PATH);
  if (!existsSync(path)) return { rules: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { rules: null, error: `${GATE_RULES_PATH} is not valid JSON — ${e.message}` };
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.rules))
    return { rules: null, error: `${GATE_RULES_PATH} must be {"version": 1, "rules": [...]}` };
  const ids = new Set();
  for (const [index, rule] of parsed.rules.entries()) {
    const problem = ruleError(rule, index) ?? (ids.has(rule.id) ? `duplicate rule id "${rule.id}"` : null);
    if (problem) return { rules: null, error: `${GATE_RULES_PATH}: ${problem}` };
    ids.add(rule.id);
  }
  return { rules: parsed.rules, error: null };
}

// The resolution, keyed on the triggering file, a required file or a rule id:
//   - Gate-rule override: <trigger-file | required-file | rule-id> — <reason>
// "- Budget-fixture override:" is read as the same line for one release and noted as deprecated.
const OVERRIDE_START = /^\s*-\s*(Gate-rule|Budget-fixture) override:/;
const OVERRIDE_RE = /^\s*-\s*(?:Gate-rule|Budget-fixture) override:\s*(\S+)\s*—\s*(.*\S)\s*$/;
export const DEPRECATED_ALIAS_NOTE =
  '"- Budget-fixture override:" is deprecated -- write "- Gate-rule override:", which means the same';

const matchesAny = (file, globs) => globs.some((g) => matchesGlob(file, g));

// The rules a file triggers: every rule whose `touches` matches it, and, for a file the task
// creates, every rule whose `creates` matches it.
function triggered(rules, file, created) {
  return rules.filter((r) => matchesAny(file, r.when.touches ?? []) || (created && matchesAny(file, r.when.creates ?? [])));
}

// Every gap a plan's Files blocks leave unlisted and unoverridden, plus notes. A gap is
// `{ task, file, verb, missing, rule }`, `missing` being the required path, or the requireOneOf glob
// list. Throws on a malformed override line, so both callers report it the same way.
export function gateRuleGaps(planText, rules) {
  const filesByTask = taskFileMap(planText);
  const gaps = [];
  let deprecated = false;
  for (const { num, text: blockText } of taskBlocks(planText)) {
    const files = filesByTask.get(num) ?? new Set();
    const created = new Set(createdFiles(blockText));
    const overridden = new Set();
    for (const line of blockText.split("\n")) {
      const start = line.match(OVERRIDE_START);
      if (!start) continue;
      const m = line.match(OVERRIDE_RE);
      if (!m) throw new Error(`malformed override (needs "<trigger-file | required-file | rule-id> — <reason>"): ${line.trim()}`);
      if (start[1] === "Budget-fixture") deprecated = true;
      overridden.add(normalizeFileToken(m[1]) ?? m[1]);
    }
    // A required file that itself matches a rule's `touches` pulls that rule in, transitively, so
    // an edit requires its fixture and the fixture requires the decisions log. An override on a
    // required file also drops what it would chain to; a oncePerTask rule's file is named once a task.
    const named = new Set();
    for (const file of files) {
      if (overridden.has(file)) continue;
      const pending = triggered(rules, file, created.has(file));
      const direct = pending.length;
      for (let i = 0; i < pending.length; i++) {
        const rule = pending[i];
        if (overridden.has(rule.id)) continue;
        // "creates" only when the file itself fired the rule through `creates`; a chained rule is "edits".
        const verb = i < direct && !matchesAny(file, rule.when.touches ?? []) ? "creates" : "edits";
        if (rule.requireOneOf) {
          if (![...files].some((f) => f !== file && matchesAny(f, rule.requireOneOf)))
            gaps.push({ task: num, file, verb, missing: rule.requireOneOf, rule });
          continue;
        }
        for (const req of rule.require) {
          if (overridden.has(req)) continue;
          for (const next of triggered(rules, req, false)) if (!pending.includes(next)) pending.push(next);
          if (files.has(req) || (rule.oncePerTask && named.has(req))) continue;
          if (rule.oncePerTask) named.add(req);
          gaps.push({ task: num, file, verb, missing: req, rule });
        }
      }
    }
  }
  return { gaps, notes: deprecated ? [DEPRECATED_ALIAS_NOTE] : [] };
}

// What clears one gap, for both gates' messages: keyed on the missing file for a `require` rule (one
// keyed on the edited file would waive every requirement that file raises), on the trigger otherwise.
export function gapRemedy({ file, missing, rule }) {
  if (Array.isArray(missing)) return `add one (${rule.why}) or record a "- Gate-rule override: ${file} — <reason>"`;
  return `add it (${rule.why}) or record a "- Gate-rule override: ${missing} — <reason>"`;
}

export const gapSubject = ({ verb, file, missing }) =>
  Array.isArray(missing)
    ? `${verb} ${file} but its Files name none of ${missing.join(", ")}`
    : `${verb} ${file} but its Files omit ${missing}`;

// One text in, the leg's result out, with no prefix: plan-check adds its own.
export function gateRulesLeg(planText, { planPath, repoRoot }) {
  const ok = "ok -- every Files block meets the repo's gate rules or records an override";
  if (taskBlocks(planText).length === 0) return { findings: [`no "### Task N" blocks found in ${planPath}`], ok, notes: [] };
  const { rules, error } = loadGateRules(repoRoot);
  if (error) return { findings: [error], ok, notes: [] };
  if (rules === null) return { findings: [], ok, notes: [`no ${GATE_RULES_PATH} in this repo -- no gate rules to check`] };
  let result;
  try {
    result = gateRuleGaps(planText, rules);
  } catch (e) {
    return { findings: [e.message], ok, notes: [] };
  }
  const findings = result.gaps.map((gap) => `Task ${gap.task} ${gapSubject(gap)} — ${gapRemedy(gap)}`);
  return { findings, ok, notes: result.notes };
}
