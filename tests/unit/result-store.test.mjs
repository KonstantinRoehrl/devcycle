import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { atomicWrite } from "../../scripts/atomic-write.mjs";
import store from "../../workflows/lib/result-store.js";
import panel from "../../workflows/review-panel.js";

const quiet = { atomicWrite, log() {} };

test("the panel re-exports the store's lensResultFile rather than keeping its own", () => {
  assert.equal(panel.lensResultFile, store.lensResultFile);
});

test("the file names both engines share are fixed", () => {
  assert.deepEqual(
    [store.SAVED_ARGS_FILE, store.LENS_SET_FILE, store.REFUTATION_FILE],
    ["_args.json", "_lenses.json", "_refutation.json"],
  );
  assert.ok(store.RESULT_DIR_SHAPE.test("/repo/.devcycle/review/round-1"));
  assert.ok(!store.RESULT_DIR_SHAPE.test("/repo/.devcycle/review/round-1/x"));
});

test("a lens file and the refutation file keep the panel's on-disk bytes", () => {
  const dir = join(makeTempDir("devcycle-result-store-"), ".devcycle", "review", "round-1");
  const s = store.createResultStore(dir, quiet);
  const finding = { file: "src/a.js", line: 1, claim: "wrong value", severity: "high", measuredAgainst: "the spec", needsExecution: false, lens: "alpha" };
  s.put("alpha.json", "k1", { findings: [finding], strengths: [] });
  s.put("_refutation.json", "r1", { verified: true, verification: "read src/a.js" });
  s.save("_args.json", { scope: { ref: "HEAD" } });
  assert.equal(
    readFileSync(join(dir, "alpha.json"), "utf8"),
    '{\n  "k1": {\n    "findings": [\n      {\n        "file": "src/a.js",\n        "line": 1,\n        "claim": "wrong value",\n' +
      '        "severity": "high",\n        "measuredAgainst": "the spec",\n        "needsExecution": false,\n        "lens": "alpha"\n' +
      '      }\n    ],\n    "strengths": []\n  }\n}\n',
  );
  assert.equal(readFileSync(join(dir, "_refutation.json"), "utf8"), '{\n  "r1": {\n    "verified": true,\n    "verification": "read src/a.js"\n  }\n}\n');
  assert.equal(readFileSync(join(dir, "_args.json"), "utf8"), '{\n  "scope": {\n    "ref": "HEAD"\n  }\n}\n');
});

test("a second store over the same directory reads what the first one wrote, and keeps adding to it", () => {
  const dir = join(makeTempDir("devcycle-result-store-"), "round-1");
  store.createResultStore(dir, quiet).put("alpha.json", "k1", { findings: [], strengths: [] });
  const again = store.createResultStore(dir, quiet);
  assert.deepEqual(again.get("alpha.json", "k1"), { findings: [], strengths: [] });
  assert.equal(again.get("alpha.json", "k2"), null);
  again.put("alpha.json", "k2", { findings: [], strengths: [] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "alpha.json"), "utf8"))), ["k1", "k2"]);
});

test("an unreadable or non-object file reads as empty", () => {
  const dir = join(makeTempDir("devcycle-result-store-"), "round-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alpha.json"), "not json");
  writeFileSync(join(dir, "beta.json"), "[1]");
  const s = store.createResultStore(dir, quiet);
  assert.equal(s.get("alpha.json", "k1"), null);
  assert.equal(s.get("beta.json", "k1"), null);
  assert.equal(store.readJsonObject(join(dir, "beta.json")), null);
});

test("a write that fails is logged and returns false, never throws", () => {
  const dir = join(makeTempDir("devcycle-result-store-"), "round-1");
  const logged = [];
  const s = store.createResultStore(dir, { atomicWrite: () => { throw new Error("disk full"); }, log: (m) => logged.push(m) });
  assert.equal(s.put("alpha.json", "k1", { findings: [], strengths: [] }), false);
  assert.equal(s.save("_args.json", {}), false);
  assert.deepEqual(logged, ["result file alpha.json not written: disk full", "result file _args.json not written: disk full"]);
  assert.equal(existsSync(join(dir, "alpha.json")), false);
});

test("the refutation key changes with the reviewed input and with every finding field", () => {
  const f = { file: "a", line: 1, claim: "c", severity: "high", measuredAgainst: "m", needsExecution: false, lens: "x" };
  const base = store.refutationKey("input", f);
  assert.equal(base, store.contentKey("input", "a", 1, "c", "high", "m", false, "x"));
  assert.notEqual(store.refutationKey("other", f), base);
  for (const [field, value] of Object.entries({ file: "b", line: 2, claim: "d", severity: "low", measuredAgainst: "n", needsExecution: true, lens: "y" })) {
    assert.notEqual(store.refutationKey("input", { ...f, [field]: value }), base, field);
  }
});
