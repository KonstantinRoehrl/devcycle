// M10: a budget fixture never exceeds what the decisions log records. Each decision that sets a
// budget carries one machine line per key, `budget: <fixture-basename> <key> <value>`; the log is
// newest first, so the first line for a key is its recorded value. A key with no line counts as 0,
// so a raise cannot land without a decision naming its exact figure — and no git history is needed,
// so a shallow clone or a tarball checks the same way. `retired` closes a key whose fixture entry
// was removed, because older entries are history and are never rewritten.
import { DECISIONS_DOC } from "./doc-paths.mjs";

export const BUDGET_LINE = /^budget:\s+(\S+)\s+(\S+)\s+(\d+|retired)\s*$/;
// An indented, list-item or capitalised near-miss is judged, not skipped: an ignored newer line
// that lowers a figure would leave the older, higher one as the ceiling.
const BUDGET_LIKE = /^\s*[-*]?\s*budget:/i;

export function recordedBudgets(logText) {
  const recorded = new Map();
  const errors = [];
  logText.split("\n").forEach((line, i) => {
    if (!BUDGET_LIKE.test(line)) return;
    const m = BUDGET_LINE.exec(line);
    if (!m) {
      errors.push({ line: i + 1, message: `malformed budget line "${line}" — expected budget: <fixture-basename> <key> <value> at the start of the line` });
      return;
    }
    const key = `${m[1]} ${m[2]}`;
    if (!recorded.has(key))
      recorded.set(key, { value: m[3] === "retired" ? "retired" : Number(m[3]), line: i + 1, fixture: m[1], name: m[2] });
  });
  return { recorded, errors };
}

export function budgetDecisionErrors({ fixtures, logText, logPath = DECISIONS_DOC }) {
  const { recorded, errors } = recordedBudgets(logText);
  const out = errors.map((e) => `${logPath}:${e.line}: ${e.message}`);
  for (const { value, line, fixture, name } of recorded.values()) {
    if (value === "retired") continue;
    if (!Object.hasOwn(fixtures, fixture))
      out.push(`${logPath}:${line}: budget line names fixture "${fixture}", which is not one of ${Object.keys(fixtures).join(", ")}`);
    else if (!Object.hasOwn(fixtures[fixture], name))
      out.push(
        `${logPath}:${line}: budget line names key "${name}", which ${fixture} does not have — ` +
          `a stale line cannot shadow a real key; retire it with a newer "budget: ${fixture} ${name} retired" line`
      );
  }
  for (const [fixture, values] of Object.entries(fixtures))
    for (const [name, value] of Object.entries(values)) {
      if (!Number.isInteger(value)) continue;
      const r = recorded.get(`${fixture} ${name}`);
      const allowed = r && r.value !== "retired" ? r.value : 0;
      if (value > allowed)
        out.push(
          `tests/fixtures/${fixture}: ${name} is ${value}, above the ` +
            `${r && r.value !== "retired" ? `newest recorded figure ${allowed} (${logPath}:${r.line})` : "unrecorded 0"} — ` +
            `a raise needs a decision line "budget: ${fixture} ${name} ${value}" in ${logPath}`
        );
    }
  return out;
}
