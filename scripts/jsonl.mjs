// A chunked, synchronous JSONL reader. Every other JSONL consumer in this repo reads the whole
// file with readFileSync and splits on "\n", which makes peak memory track the largest file
// rather than the work being done. This reads fixed-size chunks and hands each record to a
// visitor, so a caller that only needs the first matching record pays for the first chunk.
//
// StringDecoder rather than buf.toString(): a 64KB read can land mid-character in UTF-8, and
// decoding each chunk independently would corrupt every multi-byte character on a boundary.
//
// `onChunk` receives the DECODED text, not the read buffer. Two reasons, both load-bearing: the
// buffer is reused on every readSync, so any Buffer handed out would be overwritten under a
// caller that kept it; and concatenated decoder output is exactly readFileSync(file, "utf8"), so
// a caller hashing these chunks gets the digest the previous whole-file hash.update(raw) produced
// — including for a transcript that is not well-formed UTF-8, where the raw bytes and the decoded
// text differ. `bytes` is the raw on-disk count, unaffected by decoding.
import { openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 64 * 1024;

export function eachRecord(file, visit, { onChunk } = {}) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    // Mirrors readRecords (scripts/doctor.mjs): a file that is simply not there is an empty
    // corpus, not a fault. Anything else is a real failure and must surface.
    if (err.code === "ENOENT") return { records: 0, bytes: 0, stopped: false };
    throw err;
  }

  const buf = Buffer.allocUnsafe(CHUNK);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let bytes = 0;
  let records = 0;
  let stopped = false;

  const offer = (line) => {
    if (!line.trim()) return true;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return true; // skip a partial or malformed line, as readRecords does
    }
    records += 1;
    return visit(record) !== false;
  };

  try {
    outer: for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      bytes += n;
      const text = decoder.write(buf.subarray(0, n));
      if (onChunk && text) onChunk(text);
      carry += text;
      let nl;
      while ((nl = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (!offer(line)) {
          stopped = true;
          break outer;
        }
      }
    }
    if (!stopped) {
      // decoder.end() flushes a trailing incomplete sequence as U+FFFD, which readFileSync's utf8
      // decode also does — so it must reach onChunk too or the digest diverges on the last bytes.
      const tail = decoder.end();
      if (onChunk && tail) onChunk(tail);
      carry += tail;
      if (!offer(carry)) stopped = true;
    }
  } finally {
    closeSync(fd);
  }

  return { records, bytes, stopped };
}
