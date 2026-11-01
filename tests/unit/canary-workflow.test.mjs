// .github/workflows/canary.yml: the pin step's shell script, run for real with stubbed commands.
// canary-report.test.mjs feeds computeVerdict hand-built `steps` JSON, so it cannot see whether the
// workflow's own shell writes the outputs computeVerdict reads. These tests extract the real script
// from the workflow text, run it under bash with `claude`, `npm`, `node` and `sleep` stubbed on PATH,
// and read back the file GitHub would parse as the step's outputs.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const PIN_STEP = "Re-run what failed on the pinned Claude Code";

// The `run: |` block of the named step: every following line indented deeper than `run:`.
function stepScript(workflowText, name) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no step named "${name}"`);
  const next = lines.findIndex((line, i) => i > start && /^\s*- (name|uses):/.test(line));
  const stepEnd = next === -1 ? lines.length : next;
  const runAt = lines.findIndex((line, i) => i > start && i < stepEnd && /^\s+run: \|$/.test(line));
  assert.notEqual(runAt, -1, `step "${name}" has no run: | block`);
  const indent = lines[runAt].match(/^\s*/)[0].length + 2;
  const body = [];
  for (const line of lines.slice(runAt + 1, stepEnd)) {
    if (line.trim() && !line.startsWith(" ".repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// One shell stub for every command the pin step runs: noisy stdout like the real CLIs, and a failure
// plan in STUB_FAIL, ";"-separated "<command-line prefix>=<n>" entries. The first n calls of a command
// starting with that prefix fail; "=all" fails every call. Calls are counted per prefix.
const STUB = `#!/bin/sh
name=$(basename "$0")
line="$name $*"
echo "noise from $line"
echo "Installing plugin devcycle@devcycle"
if [ "$line" = "node scripts/canary-report.mjs pin" ]; then echo 2.1.292; exit 0; fi
IFS=';'
for plan in $STUB_FAIL; do
  prefix=\${plan%=*}
  limit=\${plan##*=}
  case "$line" in
    "$prefix"*)
      counter="$STUB_DIR/count-$(printf '%s' "$prefix" | tr -c 'a-zA-Z0-9' _)"
      calls=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
      echo "$calls" > "$counter"
      if [ "$limit" = all ] || [ "$calls" -le "$limit" ]; then exit 1; fi;;
  esac
done
exit 0
`;

// Runs the real pin step with the given step outcomes (names in `failed` are "failure", the rest
// "success") and failure plan. `calls(prefix)` reports how often a planned command ran.
function runPinStep(failed, stubFail = "") {
  const dir = makeTempDir("canary-pin-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "npm", "node"]) {
    writeFileSync(join(bin, name), STUB);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "");
  const script = stepScript(readFileSync(".github/workflows/canary.yml", "utf8"), PIN_STEP);
  const outcome = (name) => (failed.includes(name) ? "failure" : "success");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: outputFile,
      STUB_DIR: dir,
      STUB_FAIL: stubFail,
      VALIDATE_MARKETPLACE: outcome("validate_marketplace"),
      VALIDATE_MANIFEST: outcome("validate_manifest"),
      HOOKS_TESTS: outcome("hooks_tests"),
      PLUGIN_INSTALL: outcome("plugin_install"),
      LOAD_CHECK: outcome("load_check"),
    },
  });
  const outputs = readFileSync(outputFile, "utf8").split("\n").filter(Boolean);
  const calls = (prefix) => {
    try {
      return Number(readFileSync(join(dir, `count-${prefix.replace(/[^a-zA-Z0-9]/g, "_")}`), "utf8"));
    } catch {
      return 0;
    }
  };
  return { ...result, outputs, calls };
}

const WELL_FORMED = /^[a-z_]+=(success|failure)$/;

test("the pin step writes only name=success|failure lines to $GITHUB_OUTPUT, however noisy the commands are", () => {
  const run = runPinStep(["validate_marketplace", "validate_manifest", "hooks_tests", "plugin_install", "load_check"]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.outputs.length >= 6, `expected the install line and one line per re-run, got ${JSON.stringify(run.outputs)}`);
  for (const line of run.outputs) assert.match(line, WELL_FORMED);
  for (const line of ["install=success", "marketplace_add=success", "validate_marketplace=success", "validate_manifest=success", "hooks_tests=success", "plugin_install=success", "load_check=success"]) {
    assert.ok(run.outputs.includes(line), `${line} missing from ${JSON.stringify(run.outputs)}`);
  }
});

test("a re-run that fails is recorded as failure and the step itself still exits 0", () => {
  const run = runPinStep(["hooks_tests"], "claude plugin test .=all");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.outputs, ["install=success", "hooks_tests=failure"]);
});

test("the pin retries its npm install three times, so one blip does not lose the pin", () => {
  const blip = runPinStep(["hooks_tests"], "npm install=2");
  assert.equal(blip.status, 0, blip.stderr);
  assert.deepEqual(blip.outputs, ["install=success", "hooks_tests=success"]);
  assert.equal(blip.calls("npm install"), 3);
  const down = runPinStep(["hooks_tests"], "npm install=all");
  assert.equal(down.status, 0, down.stderr);
  assert.deepEqual(down.outputs, ["install=failure"], "after the retries the pin honestly failed to install");
  assert.equal(down.calls("npm install"), 3);
});

test("the pin re-runs a failed plugin install, retrying it, and reports failure only once the retries are spent", () => {
  const blip = runPinStep(["plugin_install"], "claude plugin install devcycle@devcycle=2");
  assert.deepEqual(blip.outputs, ["install=success", "marketplace_add=success", "plugin_install=success"]);
  assert.equal(blip.calls("claude plugin install devcycle@devcycle"), 3);
  const broken = runPinStep(["plugin_install"], "claude plugin install devcycle@devcycle=all");
  assert.deepEqual(broken.outputs, ["install=success", "marketplace_add=success", "plugin_install=failure"]);
  assert.equal(broken.calls("claude plugin install devcycle@devcycle"), 3);
});

test("the pin's load check retries its marketplace adds", () => {
  const run = runPinStep(["load_check"], "claude plugin marketplace add ./=1;claude plugin marketplace add anthropics/claude-plugins-official=2");
  assert.deepEqual(run.outputs, ["install=success", "marketplace_add=success", "load_check=success"]);
  assert.equal(run.calls("claude plugin marketplace add anthropics/claude-plugins-official"), 3);
  const down = runPinStep(["load_check"], "claude plugin marketplace add ./=all");
  assert.deepEqual(down.outputs, ["install=success", "marketplace_add=failure"]);
});

test("the pin records its marketplace adds as their own output and judges neither re-run when they fail", () => {
  const installOnly = runPinStep(["plugin_install"]);
  assert.deepEqual(installOnly.outputs, ["install=success", "marketplace_add=success", "plugin_install=success"]);
  for (const line of installOnly.outputs) assert.match(line, WELL_FORMED);
  const loadOnly = runPinStep(["load_check"]);
  assert.deepEqual(loadOnly.outputs, ["install=success", "marketplace_add=success", "load_check=success"]);
  const down = runPinStep(["plugin_install"], "claude plugin marketplace add ./=all");
  assert.equal(down.status, 0, down.stderr);
  assert.deepEqual(down.outputs, ["install=success", "marketplace_add=failure"], "a failed marketplace add is not an install verdict");
  assert.equal(down.calls("claude plugin install devcycle@devcycle"), 0);
  const blip = runPinStep(["load_check"], "claude plugin marketplace add anthropics/claude-plugins-official=2");
  assert.deepEqual(blip.outputs, ["install=success", "marketplace_add=success", "load_check=success"]);
  const noMarketplaceNeeded = runPinStep(["hooks_tests"]);
  assert.deepEqual(noMarketplaceNeeded.outputs, ["install=success", "hooks_tests=success"], "validators and hooks tests need no marketplace");
});

test("the confirmation step retries the install on latest in the clean latest config", () => {
  const text = readFileSync(".github/workflows/canary.yml", "utf8");
  const script = stepScript(text, "Confirm the install failure on latest");
  assert.match(script, /for attempt in 1 2 3/);
  assert.match(script, /claude plugin install devcycle@devcycle/);
  const block = text.slice(text.indexOf("id: plugin_install_confirm"));
  assert.match(block.slice(0, block.indexOf("run:")), /CLAUDE_CONFIG_DIR: \$\{\{ runner\.temp \}\}\/canary-config/);
});
