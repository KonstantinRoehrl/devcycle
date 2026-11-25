// Validate check 31: the Claude Code floor is declared once, in .github/claude-code/package.json,
// and everything that restates it is held to that declaration. Four files restate the floor because
// none can read a CI file at run time (the hooks module's guard, the README, the hub index, doctor's
// message); a workflow may not carry a Claude Code version at all. The newest `claude-code-floor:`
// line in the decisions log, newest first, makes every floor change a recorded decision, the way
// check 28's `budget:` lines do for a budget.
import { OWNER_FILE } from "./claude-code-versions.mjs";
import { DECISIONS_DOC } from "./doc-paths.mjs";

export const FLOOR_LINE = /^claude-code-floor:\s+(\d+\.\d+\.\d+)\s*$/;

export const FLOOR_MIRRORS = [
  { path: "hooks/devcycle-mod.mjs", pattern: /const MIN_CLAUDE_CODE = \[(\d+), (\d+), (\d+)\];/g, what: "the hooks module's MIN_CLAUDE_CODE" },
  { path: "README.md", pattern: /Requires Claude Code (\d+\.\d+\.\d+) or later/g, what: "the README's requirement line" },
  {
    path: "docs/README.md",
    pattern: /Claude Code (\d+\.\d+\.\d+) or later|does nothing below (\d+\.\d+\.\d+)/g,
    what: "the hub index's hooks-module row",
  },
  { path: "scripts/doctor.mjs", pattern: /Claude Code below (\d+\.\d+\.\d+)/g, what: "doctor's mod-inactive message" },
];

// The lookbehind spares an action's `# v2.1.0` comment and a longer version such as 12.1.5.
const WORKFLOW_LITERAL = /(?<![\dv.])2\.1\.\d+/g;

export function recordedFloor(logText) {
  for (const line of logText.split("\n")) {
    const m = FLOOR_LINE.exec(line);
    if (m) return m[1];
  }
  return null;
}

const statedVersion = (match) => match.slice(1).filter(Boolean).join(".");

export function floorErrors({ floor, read, workflows, decisionsText }) {
  const errors = [];
  for (const { path, pattern, what } of FLOOR_MIRRORS) {
    const text = read(path);
    if (text === null) {
      errors.push(`${path}: missing, so ${what} cannot be checked against the floor in ${OWNER_FILE}`);
      continue;
    }
    const statements = [...text.matchAll(pattern)];
    if (!statements.length) {
      errors.push(`${path}: ${what} not found — expected it to state the floor ${floor}`);
      continue;
    }
    for (const statement of statements) {
      const stated = statedVersion(statement);
      if (stated !== floor) errors.push(`${path}: ${what} says ${stated}, but the floor in ${OWNER_FILE} is ${floor}`);
    }
  }
  for (const { path, text } of workflows)
    text.split("\n").forEach((line, i) => {
      for (const [literal] of line.matchAll(WORKFLOW_LITERAL))
        errors.push(`${path}:${i + 1}: Claude Code version literal ${literal} — CI reads its versions from ${OWNER_FILE}`);
    });
  const recorded = recordedFloor(decisionsText);
  if (recorded === null)
    errors.push(`${DECISIONS_DOC}: no claude-code-floor: line records the floor ${floor} — a floor change needs a decisions entry carrying one`);
  else if (recorded !== floor)
    errors.push(`${DECISIONS_DOC}: the newest claude-code-floor: line says ${recorded}, but the floor in ${OWNER_FILE} is ${floor}`);
  return errors;
}
