// scripts/claude-code-floor.mjs: validate check 31 holds every floor mirror, workflow and decisions line to the owner file.
import test from "node:test";
import assert from "node:assert/strict";
import { FLOOR_LINE, FLOOR_MIRRORS, floorErrors, recordedFloor } from "../../scripts/claude-code-floor.mjs";

const MIRRORS = {
  "hooks/devcycle-mod.mjs": "const MIN_CLAUDE_CODE = [2, 1, 287];\n",
  "README.md": "Requires Claude Code 2.1.287 or later — earlier releases fail.\n",
  "docs/README.md": "| hooks module | Claude Code 2.1.287 or later; it does nothing below 2.1.287 |\n",
  "scripts/doctor.mjs": 'const why = "Claude Code below 2.1.287";\n',
};
const LOG = "# Decision log\n\n## new\n\n```text\nclaude-code-floor: 2.1.287\n```\n\n## old\n\n```text\nclaude-code-floor: 2.1.200\n```\n";
const check = ({ files = {}, workflows = [], decisionsText = LOG, floor = "2.1.287" } = {}) => {
  const tree = { ...MIRRORS, ...files };
  return floorErrors({ floor, read: (p) => tree[p] ?? null, workflows, decisionsText });
};

test("the mirrors are the hooks module's constant, the README line, the hub row and doctor's message", () => {
  assert.deepEqual(FLOOR_MIRRORS.map((m) => m.path), ["hooks/devcycle-mod.mjs", "README.md", "docs/README.md", "scripts/doctor.mjs"]);
  assert.ok(FLOOR_MIRRORS.every((m) => m.pattern.global && m.what.length > 0));
});

test("recordedFloor is the newest claude-code-floor: line, or null when there is none", () => {
  assert.equal(recordedFloor(LOG), "2.1.287");
  assert.equal(recordedFloor("# Decision log\n\nbudget: x.json k 1\n"), null);
  assert.match("claude-code-floor: 2.1.287", FLOOR_LINE);
});

test("a tree whose mirrors, workflows and decisions all agree has no errors", () => {
  assert.deepEqual(check({ workflows: [{ path: ".github/workflows/ci.yml", text: "uses: a/b@0123 # v2.1.0\n" }] }), []);
});

test("a mirror that states another floor fails, naming its path, what it is and both versions", () => {
  const readme = check({ files: { "README.md": "Requires Claude Code 2.1.286 or later.\n" } });
  assert.deepEqual(readme, ["README.md: the README's requirement line says 2.1.286, but the floor in .github/claude-code/package.json is 2.1.287"]);
  const mod = check({ files: { "hooks/devcycle-mod.mjs": "const MIN_CLAUDE_CODE = [2, 1, 290];\n" } });
  assert.deepEqual(mod, ["hooks/devcycle-mod.mjs: the hooks module's MIN_CLAUDE_CODE says 2.1.290, but the floor in .github/claude-code/package.json is 2.1.287"]);
});

test("every statement in a mirror is checked, so a second one that differs fails too", () => {
  const errors = check({ files: { "docs/README.md": "Claude Code 2.1.287 or later; it does nothing below 2.1.280\n" } });
  assert.deepEqual(errors, ["docs/README.md: the hub index's hooks-module row says 2.1.280, but the floor in .github/claude-code/package.json is 2.1.287"]);
});

test("a mirror with no statement, or a missing mirror file, fails naming the path", () => {
  assert.deepEqual(check({ files: { "scripts/doctor.mjs": "// reworded\n" } }), [
    "scripts/doctor.mjs: doctor's mod-inactive message not found — expected it to state the floor 2.1.287",
  ]);
  const missing = floorErrors({ floor: "2.1.287", read: (p) => (p === "README.md" ? null : MIRRORS[p]), workflows: [], decisionsText: LOG });
  assert.deepEqual(missing, [
    "README.md: missing, so the README's requirement line cannot be checked against the floor in .github/claude-code/package.json",
  ]);
});

test("a Claude Code version literal in a workflow fails with its line, and other versions pass", () => {
  const text = "name: CI\n        cli: 2.1.300\nnode: v12.1.5\ngitleaks: 8.30.1\nuses: a/b@0123 # v2.1.0\n";
  assert.deepEqual(check({ workflows: [{ path: ".github/workflows/ci.yml", text }] }), [
    ".github/workflows/ci.yml:2: Claude Code version literal 2.1.300 — CI reads its versions from .github/claude-code/package.json",
  ]);
});

test("the decisions log must record the floor in its newest claude-code-floor: line", () => {
  assert.deepEqual(check({ decisionsText: "# Decision log\n" }), [
    "docs/decisions/README.md: no claude-code-floor: line records the floor 2.1.287 — a floor change needs a decisions entry carrying one",
  ]);
  assert.deepEqual(check({ decisionsText: LOG.replace("claude-code-floor: 2.1.287", "claude-code-floor: 2.1.280") }), [
    "docs/decisions/README.md: the newest claude-code-floor: line says 2.1.280, but the floor in .github/claude-code/package.json is 2.1.287",
  ]);
});
