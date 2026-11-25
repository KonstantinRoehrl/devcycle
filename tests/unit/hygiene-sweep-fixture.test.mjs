import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSweep } from "../../scripts/hygiene-sweep.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

// The fixture repo is a path → content map, written out per test, so devcycle's own tree carries
// no angular.json, .css or .html that would make its own sweep detect those stacks. Its one
// package.json, .github/claude-code/package.json, is CI tooling, which detectStacks ignores.
const FIXTURES = fileURLToPath(new URL("../fixtures/maintain/", import.meta.url));
const TREE = JSON.parse(readFileSync(join(FIXTURES, "dead-code-repo.json"), "utf8"));
const recorded = (name) => readFileSync(join(FIXTURES, "sweep-tool-outputs", name), "utf8");

// Replays the committed knip and tsc outputs, so the suite stays offline; any other tool reports nothing.
function replay({ argv }) {
  const out = (stdout, status = 0) => ({ status, stdout, stderr: "", error: null });
  if (argv.includes("--version")) return out("0.0.0\n");
  if (argv.includes("--noEmit")) return out(recorded("tsc.txt"), 2);
  if (argv.some((a) => a.startsWith("knip@"))) {
    return out(recorded(argv.includes("--production") ? "knip-production.json" : "knip-default.json"));
  }
  return out("");
}

function sweep(tree) {
  const root = makeTempDir("sweep-fixture-");
  const repo = join(root, "repo");
  for (const [rel, body] of Object.entries(tree)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  return runSweep({ repoRoot: repo, outDir: join(root, "out"), runTool: replay, files: Object.keys(tree),
    churn: new Map(), now: Date.parse("2026-11-22T00:00:00Z"), onPath: () => true });
}

const find = ({ candidates }, file, symbol) => candidates.find((c) => c.file === file && c.symbol === symbol);
const clustered = (result, c) => result.clusters.some((k) => k.candidates.includes(c.id));

const KNOWN = [
  ["unused export", "dead-code", "src/util.ts", "unusedExport"],
  ["unused private member", "dead-code", "src/widget.ts", "neverRead"],
  ["unused CSS token", "dead-code", "src/styles.css", "--unused-token"],
  ["unbound input", "dead-code", "src/app/hero.component.ts", "unboundInput"],
  ["symbol used only by specs", "test-only-code", "src/util.ts", "specOnly"],
];
const DECOYS = {
  dynamicClass: ["src/styles.css", ".btn-primary", "dynamic prefix"],
  routedInput: ["src/app/routed.component.ts", "id", "routed component"],
};

test("every known dead-code case in the fixture is an uncleared, clustered candidate", () => {
  const result = sweep(TREE);
  for (const [label, kind, file, symbol] of KNOWN) {
    const c = find(result, file, symbol);
    assert.ok(c, `${label}: no candidate for ${file} ${symbol}`);
    assert.equal(c.kind, kind, label);
    assert.equal(c.cleared, null, label);
    assert.ok(clustered(result, c), `${label}: candidate joins no cluster`);
  }
});

test("both decoys are pre-cleared by their consumer and join no cluster", () => {
  const result = sweep(TREE);
  for (const [file, symbol, reason] of Object.values(DECOYS)) {
    const c = find(result, file, symbol);
    assert.ok(c, `no candidate for decoy ${symbol}`);
    assert.equal(c.cleared, reason);
    assert.ok(!clustered(result, c), `decoy ${symbol} joined a cluster`);
  }
});

test("mutation: without the dynamic-prefix template the class decoy is flagged", () => {
  const index = TREE["src/index.ts"];
  assert.ok(index, "the fixture has no src/index.ts");
  const mutated = index.split("\n").filter((l) => !l.includes("btn-${variant}")).join("\n");
  assert.notEqual(mutated, index, "the mutation removed nothing");
  const [file, symbol] = DECOYS.dynamicClass;
  const c = find(sweep({ ...TREE, "src/index.ts": mutated }), file, symbol);
  assert.ok(c, "decoy is no candidate at all after the mutation");
  assert.equal(c.cleared, null);
});

test("mutation: without the route entry the routed component's input is flagged", () => {
  const routes = TREE["src/app/app.routes.ts"];
  assert.ok(routes, "the fixture has no src/app/app.routes.ts");
  const mutated = routes.replace(/\[\{.*\}\]/, "[]");
  assert.notEqual(mutated, routes, "the mutation removed nothing");
  const [file, symbol] = DECOYS.routedInput;
  const c = find(sweep({ ...TREE, "src/app/app.routes.ts": mutated }), file, symbol);
  assert.ok(c, "decoy is no candidate at all after the mutation");
  assert.equal(c.cleared, null);
});

test("the recorded tool outputs are listed with the registry's pins, so a pin bump forces a re-recording", () => {
  const registry = JSON.parse(readFileSync(new URL("../../references/hygiene-sweeps.json", import.meta.url), "utf8"));
  const rows = readFileSync(join(FIXTURES, "README.md"), "utf8").split("\n")
    .filter((line) => /^\| `[^`]+` \|/.test(line)).map((line) => line.split("|").map((cell) => cell.trim()));
  assert.deepEqual(rows.map((r) => r[1].replaceAll("`", "")).sort(), readdirSync(join(FIXTURES, "sweep-tool-outputs")).filter((f) => f !== ".gitkeep").sort(),
    "every recording has a provenance row, and every row names a recording");
  for (const [, file, tool, version, command] of rows) {
    const pinned = registry.tools.find((t) => t.id === tool)?.version;
    assert.equal(version, pinned, `${file}: recorded from ${tool} ${version}, registry pins ${pinned}: re-record and update the row`);
    assert.ok(command.includes(`@${pinned}`) || command.startsWith("the command above"), `${file}: command does not cite the pin`);
  }
});

test("the contributor guide lists the maintain fixtures", () => {
  assert.match(readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8"), /tests\/fixtures\/maintain\/README\.md/);
});
