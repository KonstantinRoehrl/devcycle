// The context a surface file pulls in by citation: the file itself plus every file reachable
// through ${CLAUDE_PLUGIN_ROOT} citations, each counted once — which is also what the reader's
// context pays. A section read counts that section, not the file. `refs` follows reference
// citations only (what validate.mjs check 15 gates); `all` follows playbook and command citations
// too (reported by context-report.mjs, never gated).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PREFIXED, SECTION_READ, prefixedPattern } from "./citation-grammar.mjs";
import { sectionText } from "./md-sections.mjs";

const FOLLOW = { refs: prefixedPattern(["references"]), all: PREFIXED };

export const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

export const diskReader = (root) => (rel) => {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};

// A section read (references/README.md § Citation grammar) loads only that `##` section: it counts
// that section's bytes and follows only the citations inside it. A file read whole anywhere in the
// closure counts once, whole, and its section reads add nothing.
export function closure(startRel, { follow = "refs", root, read = diskReader(root) } = {}) {
  const pattern = FOLLOW[follow];
  if (!pattern) throw new Error(`closure: unknown follow mode "${follow}" (refs | all)`);
  const seen = new Set();
  const files = [];
  const whole = new Map();
  const parts = new Map();
  const queue = [{ rel: startRel, slug: null }];
  while (queue.length) {
    const { rel, slug } = queue.shift();
    const key = `${rel}#${slug ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = read(rel);
    const text = file === null || slug === null ? file : sectionText(file, slug);
    if (text === null) continue;
    if (!files.includes(rel)) files.push(rel);
    if (slug === null) whole.set(rel, text);
    else {
      if (!parts.has(rel)) parts.set(rel, new Map());
      parts.get(rel).set(slug, text);
    }
    for (const m of text.matchAll(pattern)) queue.push({ rel: m[1], slug: null });
    for (const m of text.matchAll(SECTION_READ)) queue.push({ rel: m[1], slug: m[2] });
  }
  const sections = {};
  let bytes = 0;
  let words = 0;
  for (const rel of files) {
    const texts = whole.has(rel) ? [whole.get(rel)] : [...parts.get(rel).values()];
    if (!whole.has(rel)) sections[rel] = [...parts.get(rel).keys()];
    for (const t of texts) {
      bytes += Buffer.byteLength(t);
      words += countWords(t);
    }
  }
  return { files, sections, bytes, words };
}
