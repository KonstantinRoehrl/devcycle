// The context a surface file pulls in by citation: the file itself plus every file reachable
// through ${CLAUDE_PLUGIN_ROOT} citations, each counted once — which is also what the reader's
// context pays. `refs` follows reference citations only (what validate.mjs check 15 gates);
// `all` follows playbook and command citations too (reported by context-report.mjs, never gated).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PREFIXED, prefixedPattern } from "./citation-grammar.mjs";

const FOLLOW = { refs: prefixedPattern(["references"]), all: PREFIXED };

export const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

export const diskReader = (root) => (rel) => {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};

export function closure(startRel, { follow = "refs", root, read = diskReader(root) } = {}) {
  const pattern = FOLLOW[follow];
  if (!pattern) throw new Error(`closure: unknown follow mode "${follow}" (refs | all)`);
  const seen = new Set();
  const files = [];
  let bytes = 0;
  let words = 0;
  const queue = [startRel];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = read(rel);
    if (text === null) continue;
    files.push(rel);
    bytes += Buffer.byteLength(text);
    words += countWords(text);
    for (const m of text.matchAll(pattern)) queue.push(m[1]);
  }
  return { files, bytes, words };
}
