import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { METRICS, REGISTRY_PATH, kindIndex, loadRegistry, validateRegistry } from "../../scripts/hygiene-registry.mjs";

const fresh = () => structuredClone(loadRegistry());
const tool = (reg, id) => reg.tools.find((t) => t.id === id);
const expectError = (mutate, pattern) => {
  const reg = fresh();
  mutate(reg);
  const errors = validateRegistry(reg);
  assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern}, got: ${errors.join(" | ") || "no errors"}`);
};

test("the shipped registry validates and REGISTRY_PATH names it", () => {
  assert.match(REGISTRY_PATH, /references[\\/]hygiene-sweeps\.json$/);
  assert.deepEqual(validateRegistry(loadRegistry()), []);
});

test("the dead-code sweep carries exactly the slice's kinds and default severities", () => {
  const kinds = loadRegistry().sweeps["dead-code"].kinds;
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.severity])), {
    "dead-code": "medium", "test-only-code": "medium", "over-exported": "low", "test-coverage-gap": "low",
    "commented-out-code": "low", "stale-todo": "low", "unused-env-var": "low",
  });
  assert.equal(loadRegistry().sweeps["dead-code"].notCovered.length, 4);
});

test("knip static mode disables all 202 plugins of the 6.44.2 pin, and only those", () => {
  const knip = tool(loadRegistry(), "knip");
  assert.equal(knip.version, "6.44.2");
  const cfg = knip.modes.static.files["knip.json"];
  const plugins = Object.keys(cfg).filter((k) => k !== "entry");
  assert.equal(plugins.length, 202);
  assert.ok(plugins.every((k) => cfg[k] === false));
  assert.deepEqual(plugins, [...plugins].sort());
  assert.ok(plugins.includes("vite") && plugins.includes("jest") && plugins.includes("eslint"));
});

test("every executing-capable tool keeps a read-only invocation", () => {
  for (const t of loadRegistry().tools)
    for (const mode of Object.values(t.modes))
      for (const inv of mode.invocations)
        assert.ok(!inv.args.some((a) => ["--fix", "--write", "--with-metadata", "--output-file"].includes(a)), `${t.id}/${inv.id}`);
});

test("validateRegistry names each violation by path", () => {
  expectError((r) => { tool(r, "knip").stacks = ["cobol"]; }, /^tools\[knip\]\.stacks: /);
  expectError((r) => { tool(r, "tsc").kinds = ["no-such-kind"]; }, /^tools\[tsc\]\.kinds: /);
  expectError((r) => { tool(r, "vulture").adapter = "magic"; }, /^tools\[vulture\]\.adapter: /);
  expectError((r) => { tool(r, "knip").version = "latest"; }, /^tools\[knip\]\.version: /);
  expectError((r) => { tool(r, "knip").command.fetch = ["npx", "-y", "knip"]; }, /^tools\[knip\]\.command\.fetch: /);
  expectError((r) => { tool(r, "tsc").modes.dynamic = tool(r, "tsc").modes.static; }, /^tools\[tsc\]\.modes: /);
  expectError((r) => { tool(r, "knip").modes.executing.invocations[0].args.push("--fix"); },
    /^tools\[knip\]\.modes\.executing\.invocations\[default\]\.args: /);
  expectError((r) => { tool(r, "eslint").modes.executing.invocations[0].args = ["-f", "unix", "--cache", "."]; },
    /^tools\[eslint\]\.modes\.executing\.invocations\[main\]\.args: /);
  expectError((r) => { tool(r, "vulture").modes.static.invocations[0].args = ["{repo}"]; },
    /^tools\[vulture\]\.modes\.static\.invocations\[main\]\.args: /);
  expectError((r) => { tool(r, "knip").modes.static.files["knip.json"].vite = true; }, /^tools\[knip\]\.modes\.static\.files: /);
  expectError((r) => { r.sweeps["dead-code"].kinds["dead-code"].severity = "urgent"; }, /^sweeps\.dead-code\.kinds\.dead-code\.severity: /);
  expectError((r) => { r.scanners["stale-todo"].kinds = ["nope"]; }, /^scanners\.stale-todo\.kinds: /);
  expectError((r) => { r.tools.push(structuredClone(tool(r, "knip"))); }, /^tools\[knip\]: duplicate id/);
});

test("loadRegistry refuses an invalid file and an unreadable one", () => {
  const dir = makeTempDir("hyg-reg-");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: 2, stacks: {}, sweeps: {}, scanners: {}, config: {}, tools: [] }));
  assert.throws(() => loadRegistry(bad), /^Error: invalid hygiene registry: .*version/);
  assert.throws(() => loadRegistry(join(dir, "missing.json")), /cannot read /);
});

test("the registry owns tsc's per-project expansion and the raw tools' output formats", () => {
  const reg = loadRegistry();
  assert.deepEqual(tool(reg, "tsc").projects, { config: "tsconfig.json", cap: 20 });
  assert.ok(tool(reg, "tsc").modes.static.invocations[0].args.includes("{project}"));
  assert.equal(tool(reg, "cargo-machete").outputFormat, "cargo-machete");
  assert.equal(tool(reg, "purgecss").outputFormat, "purgecss-json");
});

test("validateRegistry checks the project expansion fields and the raw output formats", () => {
  expectError((r) => { tool(r, "tsc").projects = { config: "tsconfig.json", cap: 0 }; }, /^tools\[tsc\]\.projects: /);
  expectError((r) => { tool(r, "tsc").projects = { config: "/etc/tsconfig.json", cap: 5 }; }, /^tools\[tsc\]\.projects: /);
  expectError((r) => { delete tool(r, "tsc").projects; }, /^tools\[tsc\]\.modes\.static\.invocations\[main\]\.args: .*\{project\}/);
  expectError((r) => { tool(r, "vulture").modes.static.invocations[0].args = ["{project}"]; },
    /^tools\[vulture\]\.modes\.static\.invocations\[main\]\.args: .*\{project\}/);
  expectError((r) => { tool(r, "purgecss").outputFormat = "yaml"; }, /^tools\[purgecss\]\.outputFormat: /);
  expectError((r) => { tool(r, "tsc").outputFormat = "cargo-machete"; }, /^tools\[tsc\]\.outputFormat: .*raw/);
});

test("each sweep names its section title and its coverage noun", () => {
  const dead = loadRegistry().sweeps["dead-code"];
  assert.equal(dead.title, "Dead code");
  assert.equal(dead.noun, "dead-code");
  expectError((r) => { delete r.sweeps["dead-code"].title; }, /sweeps\.dead-code\.title: must be a non-empty string/);
  expectError((r) => { r.sweeps["dead-code"].noun = "Dead Code"; }, /sweeps\.dead-code\.noun: must be a lowercase slug/);
});

test("a kind declared under two sweeps is rejected", () => {
  expectError((r) => {
    r.sweeps.other = { title: "Other", noun: "other", kinds: { "stale-todo": { severity: "low" } }, notCovered: [] };
  }, /sweeps\.other\.kinds\.stale-todo: already declared under sweeps\.dead-code/);
});

test("a kind may cap its severity raise and name the reasons that pass the cap", () => {
  const ok = fresh();
  ok.sweeps["dead-code"].kinds["stale-todo"] = { severity: "low", maxSeverity: "medium", raiseBeyondCapWhen: ["undocumented non-obvious invariant"] };
  assert.deepEqual(validateRegistry(ok), []);
  expectError((r) => { r.sweeps["dead-code"].kinds["stale-todo"].maxSeverity = "urgent"; }, /kinds\.stale-todo\.maxSeverity: must be one of critical, high, medium, low/);
  expectError((r) => { r.sweeps["dead-code"].kinds["dead-code"].maxSeverity = "low"; }, /kinds\.dead-code\.maxSeverity: must not be below its severity medium/);
  expectError((r) => { r.sweeps["dead-code"].kinds["stale-todo"].raiseBeyondCapWhen = ["x"]; }, /kinds\.stale-todo\.raiseBeyondCapWhen: needs a maxSeverity/);
  expectError((r) => { Object.assign(r.sweeps["dead-code"].kinds["stale-todo"], { maxSeverity: "medium", raiseBeyondCapWhen: [] }); },
    /kinds\.stale-todo\.raiseBeyondCapWhen: must be a non-empty array of strings/);
});

test("a kind routes to verification by default or to judgment, and kindIndex lists every kind once", () => {
  const ok = fresh();
  ok.sweeps["dead-code"].kinds["stale-todo"].route = "judgment";
  assert.deepEqual(validateRegistry(ok), []);
  expectError((r) => { r.sweeps["dead-code"].kinds["stale-todo"].route = "lens"; }, /kinds\.stale-todo\.route: must be one of verification, judgment, watch/);
  assert.deepEqual(kindIndex(ok).get("stale-todo"),
    { sweep: "dead-code", severity: "low", maxSeverity: null, raiseBeyondCapWhen: [], route: "judgment", history: false });
  const shipped = loadRegistry();
  assert.equal(kindIndex(shipped).get("dead-code").route, "verification");
  assert.deepEqual([...kindIndex(shipped).keys()], Object.keys(shipped.sweeps["dead-code"].kinds));
});

test("a scanner may be scoped to the hotspot files, and the hotspot cap is configured", () => {
  assert.equal(loadRegistry().config.hotspotCap, 30);
  const ok = fresh();
  ok.scanners["stale-todo"].scope = "hotspots";
  assert.deepEqual(validateRegistry(ok), []);
  expectError((r) => { r.scanners["stale-todo"].scope = "everywhere"; }, /scanners\.stale-todo\.scope: must be "hotspots" when set/);
  expectError((r) => { r.config.hotspotCap = 0; }, /config\.hotspotCap: must be a positive integer/);
});

test("a tool may be gated on a repo-root package.json dependency", () => {
  const ok = fresh();
  tool(ok, "eslint").when.packageDependency = ["eslint-plugin-jsdoc"];
  assert.deepEqual(validateRegistry(ok), []);
  expectError((r) => { tool(r, "eslint").when.packageDependency = []; }, /tools\[eslint\]\.when\.packageDependency: must be a non-empty array of strings/);
  expectError((r) => { tool(r, "eslint").when.anyFiles = ["x"]; }, /tools\[eslint\]\.when: unknown key anyFiles/);
});

test("write flags are forbidden and every output location sits under {scratch}/", () => {
  const args = (r) => tool(r, "vulture").modes.static.invocations[0].args;
  expectError((r) => { args(r).push("--generate-badge"); }, /forbidden arg --generate-badge/);
  expectError((r) => { args(r).push("--output", "report"); }, /--output: an output location must start with \{scratch\}\//);
  expectError((r) => { args(r).push("--output-dir=out"); }, /--output-dir: an output location must start with \{scratch\}\//);
  const ok = fresh();
  args(ok).push("--output", "{scratch}/report", "--report-dir={scratch}/r");
  assert.deepEqual(validateRegistry(ok), []);
});

const METRIC_DEFAULT = (value) => ({ value, source: "ESLint", url: "https://eslint.org/docs/latest/rules/complexity" });
const fullDefaults = () => Object.fromEntries(["ccn", "cognitive", "nesting", "params", "nloc", "fileLines"].map((m) => [m, METRIC_DEFAULT(10)]));
const withComplexity = (reg) => {
  reg.complexity = {
    defaults: { "js-ts": fullDefaults(), other: fullDefaults() },
    configKeys: {
      eslint: { stack: "js-ts", files: "eslint-row", keys: { complexity: "ccn", "max-depth": "nesting" } },
      python: { stack: "other", files: ["setup.cfg"], keys: { "max-complexity": "ccn" } },
    },
  };
  return reg;
};

test("the watch route, history kinds and kindIndex's history field", () => {
  assert.deepEqual(METRICS, ["ccn", "cognitive", "nesting", "params", "nloc", "fileLines"]);
  const ok = fresh();
  Object.assign(ok.sweeps["dead-code"].kinds["stale-todo"], { route: "watch", history: true });
  assert.deepEqual(validateRegistry(ok), []);
  assert.deepEqual(kindIndex(ok).get("stale-todo"),
    { sweep: "dead-code", severity: "low", maxSeverity: null, raiseBeyondCapWhen: [], route: "watch", history: true });
  assert.equal(kindIndex(loadRegistry()).get("dead-code").history, false);
  expectError((r) => { r.sweeps["dead-code"].kinds["stale-todo"].history = "yes"; }, /kinds\.stale-todo\.history: must be a boolean/);
});

test("a fallback tool names another tool of its sweep that shares a stack", () => {
  const ok = fresh();
  tool(ok, "tsc").fallbackFor = "knip";
  assert.deepEqual(validateRegistry(ok), []);
  const bad = /tools\[tsc\]\.fallbackFor: must name another tool of sweep dead-code that shares a stack/;
  expectError((r) => { tool(r, "tsc").fallbackFor = "tsc"; }, bad);
  expectError((r) => { tool(r, "tsc").fallbackFor = "vulture"; }, bad);
  expectError((r) => { tool(r, "tsc").fallbackFor = "nope"; }, bad);
});

test("lizard's write flags are forbidden, and the adapter list comes from the adapters module", () => {
  const args = (r) => tool(r, "vulture").modes.static.invocations[0].args;
  expectError((r) => { args(r).push("-o", "report.csv"); }, /forbidden arg -o/);
  expectError((r) => { args(r).push("--output_file"); }, /forbidden arg --output_file/);
  expectError((r) => { tool(r, "vulture").adapter = "magic"; }, /tools\[vulture\]\.adapter: must be one of raw, knip, tsc/);
});

test("config.hotCommits ships as 3 and must be a positive integer", () => {
  assert.equal(loadRegistry().config.hotCommits, 3);
  expectError((r) => { r.config.hotCommits = 0; }, /config\.hotCommits: must be a positive integer/);
  expectError((r) => { delete r.config.hotCommits; }, /config\.hotCommits: must be a positive integer/);
});

test("the complexity block validates its defaults and config key map", () => {
  assert.deepEqual(validateRegistry(withComplexity(fresh())), []);
  const expectComplexity = (mutate, pattern) => expectError((r) => mutate(withComplexity(r)), pattern);
  expectComplexity((r) => { r.complexity = []; }, /complexity: must be an object/);
  expectComplexity((r) => { delete r.complexity.defaults.other; }, /complexity\.defaults: must be an object with an "other" entry/);
  expectComplexity((r) => { r.complexity.defaults.cobol = fullDefaults(); }, /complexity\.defaults\.cobol: not a stack/);
  expectComplexity((r) => { r.complexity.defaults.other.depth = METRIC_DEFAULT(3); }, /complexity\.defaults\.other\.depth: not a metric/);
  expectComplexity((r) => { delete r.complexity.defaults["js-ts"].nloc; }, /complexity\.defaults\.js-ts\.nloc: must be \{ value: a positive integer/);
  expectComplexity((r) => { r.complexity.defaults.other.ccn.value = 1.5; }, /complexity\.defaults\.other\.ccn: must be/);
  expectComplexity((r) => { r.complexity.defaults.other.ccn.url = "http://x"; }, /complexity\.defaults\.other\.ccn: must be/);
  expectComplexity((r) => { r.complexity.configKeys.eslint.stack = "go"; }, /complexity\.configKeys\.eslint\.stack: must be a stack with defaults/);
  expectComplexity((r) => { r.complexity.configKeys.python.files = []; }, /complexity\.configKeys\.python\.files: must be a non-empty array/);
  expectComplexity((r) => { delete tool(r, "eslint").when; }, /complexity\.configKeys\.eslint\.files: "eslint-row" needs an eslint tool with when\.anyFile/);
  expectComplexity((r) => { r.complexity.configKeys.python.keys = { "max-complexity": "depth" }; }, /complexity\.configKeys\.python\.keys: must map config keys to metrics/);
});
