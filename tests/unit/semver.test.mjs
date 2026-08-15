import test from "node:test";
import assert from "node:assert/strict";
import { cmpSemver, SEMVER_RE } from "../../scripts/semver.mjs";

test("cmpSemver orders by major, minor, patch", () => {
  assert.ok(cmpSemver("0.13.0", "0.12.9") > 0);
  assert.ok(cmpSemver("0.12.0", "0.12.1") < 0);
  assert.equal(cmpSemver("1.2.3", "1.2.3"), 0);
  assert.ok(cmpSemver("1.0.0", "0.99.99") > 0);
});

test("SEMVER_RE accepts x.y.z and rejects others", () => {
  assert.ok(SEMVER_RE.test("0.13.0"));
  assert.ok(!SEMVER_RE.test("v0.13.0"));
  assert.ok(!SEMVER_RE.test("0.13"));
});
