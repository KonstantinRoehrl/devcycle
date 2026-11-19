import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseRequests, isTurn } from "../../scripts/request-collapse.mjs";

const rec = (over, usage, content) => ({
  type: "assistant",
  message: { model: "claude-sonnet-5-5", usage, content, ...(over.messageId ? { id: over.messageId } : {}) },
  ...(over.requestId ? { requestId: over.requestId } : {}),
  ...(over.isSidechain ? { isSidechain: true } : {}),
});

test("records sharing one requestId collapse to one request: greatest output_tokens usage, all content", () => {
  const records = [
    rec({ requestId: "r1" }, { input_tokens: 10, output_tokens: 5 }, [{ type: "thinking" }]),
    rec({ requestId: "r1" }, { input_tokens: 10, output_tokens: 40 }, [{ type: "text" }]),
    rec({ requestId: "r1" }, { input_tokens: 10, output_tokens: 20 }, [{ type: "tool_use" }]),
  ];
  const requests = collapseRequests(records);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message.usage.output_tokens, 40);
  assert.deepEqual(requests[0].message.content.map((c) => c.type), ["thinking", "text", "tool_use"]);
  assert.equal(records[0].message.usage.output_tokens, 5, "the input records are not mutated");
});

test("a record with neither requestId nor message.id stands alone, and message.id keys when requestId is absent", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  assert.equal(collapseRequests([rec({}, usage, []), rec({}, usage, [])]).length, 2);
  assert.equal(collapseRequests([rec({ messageId: "m1" }, usage, []), rec({ messageId: "m1" }, usage, [])]).length, 1);
});

test("a main-thread and a sidechain record with the same id stay separate requests", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const requests = collapseRequests([rec({ requestId: "r1" }, usage, []), rec({ requestId: "r1", isSidechain: true }, usage, [])]);
  assert.equal(requests.length, 2);
});

test("isTurn: an assistant record with usage counts; synthetic, usage-less and non-assistant records do not", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  assert.ok(isTurn(rec({}, usage, [])));
  assert.ok(!isTurn({ type: "assistant", message: { model: "<synthetic>", usage } }));
  assert.ok(!isTurn({ type: "assistant", message: { model: "x" } }));
  assert.ok(!isTurn({ type: "user", message: { usage } }));
});
