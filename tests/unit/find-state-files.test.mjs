import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findStateFiles, describe as describeState } from "../../scripts/find-state-files.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/find-state-files.mjs", import.meta.url));

function writeState(dir, body) {
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  writeFileSync(join(dir, ".devcycle", "state.md"), body);
}

test("finds root and nested state files and prunes node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "fsf-"));
  try {
    writeState(root, "# devcycle state\n- stage: planning\n- branch: dev\n- request: root cycle\n");
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    writeState(sub, "# devcycle state\n- stage: execution\n- branch: feat\n- request: nested cycle\n");
    const nm = join(root, "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    writeState(nm, "# devcycle state\n- stage: done\n- request: vendored\n");

    const found = findStateFiles(root);
    assert.equal(found.length, 2);
    assert.ok(found.includes(join(root, ".devcycle", "state.md")));
    assert.ok(found.includes(join(root, "sub", ".devcycle", "state.md")));
    assert.ok(!found.some((p) => p.includes("node_modules")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("describe parses fields, last ledger event, and age", () => {
  const root = mkdtempSync(join(tmpdir(), "fsf-"));
  try {
    writeState(root, "# devcycle state\n- stage: execution\n- branch: feat-x\n- request: do a thing\n- updated: 2020-01-01T00:00:00Z\n");
    writeFileSync(
      join(root, ".devcycle", "ledger.md"),
      "preamble line\n" +
        "- [2020-01-01T00:00:00Z] task=1 event=dispatched outcome=ok ref=none\n" +
        "- [2020-01-02T00:00:00Z] task=1 event=committed outcome=ok ref=abc123\n"
    );
    const [rec] = findStateFiles(root).map(describeState);
    assert.equal(rec.stage, "execution");
    assert.equal(rec.branch, "feat-x");
    assert.equal(rec.request, "do a thing");
    assert.ok(rec.lastEvent.includes("event=committed"));
    assert.ok(typeof rec.ageSeconds === "number" && rec.ageSeconds > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json prints an array and zero candidates exits 0 with a message", () => {
  const empty = mkdtempSync(join(tmpdir(), "fsf-"));
  try {
    const j = spawnSync("node", [SCRIPT, "--dir", empty, "--json"], { encoding: "utf8" });
    assert.equal(j.status, 0);
    assert.deepEqual(JSON.parse(j.stdout), []);

    const h = spawnSync("node", [SCRIPT, "--dir", empty], { encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /no devcycle state file found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("an unrecognised flag exits non-zero with the script's prefix", () => {
  const r = spawnSync("node", [SCRIPT, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /find-state-files:/);
});

test("a --dir with no value exits non-zero with the script's prefix, not a raw stack trace", () => {
  const r = spawnSync("node", [SCRIPT, "--dir"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /find-state-files:/);
  assert.doesNotMatch(r.stderr, /^\s+at .+:\d+:\d+/m); // no uncaught-exception stack frames
});
