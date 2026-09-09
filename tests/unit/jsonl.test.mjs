import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { eachRecord, CHUNK } from "../../scripts/jsonl.mjs";
import { readRecords } from "../../scripts/doctor.mjs";

const write = (name, text) => {
  const dir = makeTempDir("jsonl-test-");
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

test("eachRecord visits every record and reports raw byte length", () => {
  const text = `{"a":1}\n{"a":2}\n{"a":3}\n`;
  const file = write("s.jsonl", text);
  const seen = [];
  const out = eachRecord(file, (r) => { seen.push(r.a); });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(out.records, 3);
  assert.equal(out.bytes, Buffer.byteLength(text));
  assert.equal(out.stopped, false);
});

test("eachRecord stops at the first visit returning false and reports stopped", () => {
  const file = write("s.jsonl", `{"a":1}\n{"a":2}\n{"a":3}\n`);
  const seen = [];
  const out = eachRecord(file, (r) => { seen.push(r.a); return false; });
  assert.deepEqual(seen, [1], "must not parse past the record that stopped the read");
  assert.equal(out.records, 1);
  assert.equal(out.stopped, true);
});

test("eachRecord reassembles a record split across a 64KB chunk boundary", () => {
  const filler = "x".repeat(70000);
  const text = `{"big":"${filler}"}\n{"a":2}\n`;
  const file = write("s.jsonl", text);
  const seen = [];
  eachRecord(file, (r) => { seen.push(r.big ? r.big.length : r.a); });
  assert.deepEqual(seen, [70000, 2], "a record longer than one chunk must survive reassembly");
});

test("eachRecord reassembles a multi-byte character split across a chunk boundary", () => {
  // The character has to START on the last byte of a chunk: one that merely sits somewhere in the
  // second chunk is decoded whole even by a per-chunk buf.toString("utf8"), which is the defect
  // this test exists to catch. So the padding runs to one byte short of a 64KB boundary, leaving
  // the 3-byte "€" split 1 + 2 across it.
  const FIXTURE_CHUNK = 64 * 1024;
  assert.equal(CHUNK, FIXTURE_CHUNK,
    "the reader's chunk size moved: this fixture pads to a 64KB boundary, so at any other size the € " +
    "lands wholly inside one chunk and nothing here decodes across a boundary any more");
  const open = `{"s":"`;
  const pad = "a".repeat(FIXTURE_CHUNK - 1 - Buffer.byteLength(open));
  const file = write("s.jsonl", `${open}${pad}€"}\n`);
  // The straddle measured on the bytes on disk, not restated from the arithmetic that built them:
  // decoding the reader's first chunk alone has to end in a replacement character.
  assert.ok(readFileSync(file).subarray(0, CHUNK).toString("utf8").endsWith("\uFFFD"),
    "the first chunk must end mid-character, or the read below never crosses one");
  let value = null;
  eachRecord(file, (r) => { value = r.s; });
  assert.equal(value, `${pad}€`, "a decoder that splits UTF-8 mid-character corrupts the string");
});

test("eachRecord parses a final line with no trailing newline", () => {
  const file = write("s.jsonl", `{"a":1}\n{"a":2}`);
  const seen = [];
  const out = eachRecord(file, (r) => { seen.push(r.a); });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(out.records, 2);
});

test("eachRecord returns zeros for an empty file and for a missing file", () => {
  const empty = write("s.jsonl", "");
  assert.deepEqual(eachRecord(empty, () => {}), { records: 0, bytes: 0, stopped: false });
  const missing = join(makeTempDir("jsonl-test-"), "nope.jsonl");
  assert.deepEqual(eachRecord(missing, () => {}), { records: 0, bytes: 0, stopped: false });
});

test("eachRecord skips a malformed line instead of throwing, matching readRecords", () => {
  const file = write("s.jsonl", `{"a":1}\nnot json\n{"a":2}\n`);
  const seen = [];
  const out = eachRecord(file, (r) => { seen.push(r.a); });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(out.records, 2);
});

test("onChunk receives decoded text so a caller can hash without holding the file", () => {
  const text = `{"a":1}\n{"a":2}\n`;
  const file = write("s.jsonl", text);
  const chunks = [];
  eachRecord(file, () => {}, { onChunk: (chunk) => chunks.push(chunk) });
  assert.ok(chunks.every((c) => typeof c === "string"),
    "a Buffer view into the reader's reused read buffer would alias and be overwritten");
  assert.equal(chunks.join(""), text, "concatenated chunks must equal the file's decoded text");
});

test("hashing onChunk output matches hashing the whole file, including invalid UTF-8", () => {
  const dir = makeTempDir("jsonl-test-");
  const file = join(dir, "s.jsonl");
  // A lone 0xFF byte is not valid UTF-8: readFileSync(file, "utf8") replaces it with U+FFFD, and
  // the streaming decoder must land on the same text or every sliceId for such a transcript moves.
  writeFileSync(file, Buffer.concat([Buffer.from(`{"a":1}\n`), Buffer.from([0xff]), Buffer.from("\n")]));
  const streamed = createHash("sha256");
  eachRecord(file, () => {}, { onChunk: (chunk) => streamed.update(chunk) });
  assert.equal(
    streamed.digest("hex"),
    createHash("sha256").update(readFileSync(file, "utf8")).digest("hex"),
    "hashing raw bytes instead of decoded text changes the digest, and with it sliceId, for any non-UTF-8 transcript",
  );
});

test("readRecords still returns every record, now through the streaming reader", () => {
  const file = write("s.jsonl", `{"a":1}\nnot json\n{"a":2}`);
  assert.deepEqual(readRecords(file).map((r) => r.a), [1, 2],
    "the delegation must keep readRecords' skip-malformed and no-trailing-newline tolerance");
  assert.deepEqual(readRecords(join(makeTempDir("jsonl-test-"), "nope.jsonl")), [],
    "a missing transcript is an empty session, not a throw");
});
