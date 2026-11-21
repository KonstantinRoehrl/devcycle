import { test } from "node:test";
import assert from "node:assert/strict";
import { RESET_MARGIN_MS, rejectedLimit, resetWaitMs, textLimit } from "../../scripts/usage-limit.mjs";

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

test("textLimit reads a limit from a result's text, and the reset from its |<epoch seconds> suffix", () => {
  assert.deepEqual(textLimit("Claude usage limit reached ∙ resets 4pm|1766000000"), { resetAt: 1766000000 });
  assert.deepEqual(textLimit("You have hit your limit"), { resetAt: null });
  assert.deepEqual(textLimit("Claude usage limit reached|0"), { resetAt: null });
  assert.deepEqual(textLimit("Rate limit exceeded|12345"), { resetAt: null });
  assert.equal(textLimit("The build failed with exit 1"), null);
  assert.equal(textLimit(""), null);
});

test("resetWaitMs waits to the reset plus a one-minute margin, and only the margin once the reset has passed", () => {
  assert.equal(RESET_MARGIN_MS, 60_000);
  assert.equal(resetWaitMs(1000, 400_000), 660_000);
  assert.equal(resetWaitMs(1000, 2_000_000), 60_000);
});
