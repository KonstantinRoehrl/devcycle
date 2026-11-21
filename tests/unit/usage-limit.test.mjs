import { test } from "node:test";
import assert from "node:assert/strict";
import { RESET_MARGIN_MS, rejectedLimit, resetWaitMs } from "../../scripts/usage-limit.mjs";

test("rejectedLimit reads a rejected rate_limit_event's reset, and no other event", () => {
  const limit = (info) => rejectedLimit({ type: "rate_limit_event", rate_limit_info: info });
  assert.deepEqual(limit({ status: "rejected", resetsAt: 1795273200 }), { resetAt: 1795273200 });
  assert.deepEqual(limit({ status: "rejected" }), { resetAt: null });
  assert.deepEqual(limit({ status: "rejected", resetsAt: "4pm" }), { resetAt: null });
  assert.equal(limit({ status: "allowed", resetsAt: 1795273200 }), null);
  assert.equal(limit({ status: "allowed_warning", resetsAt: 1795273200 }), null);
  assert.equal(rejectedLimit({ type: "result", rate_limit_info: { status: "rejected", resetsAt: 1 } }), null);
  assert.equal(rejectedLimit(null), null);
});

test("resetWaitMs waits to the reset plus a one-minute margin, and only the margin once the reset has passed", () => {
  assert.equal(RESET_MARGIN_MS, 60_000);
  assert.equal(resetWaitMs(1000, 400_000), 660_000);
  assert.equal(resetWaitMs(1000, 2_000_000), 60_000);
});
