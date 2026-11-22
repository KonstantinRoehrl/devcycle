import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { REGISTRY_PATH, loadRegistry, validateRegistry } from "../../scripts/hygiene-registry.mjs";

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
