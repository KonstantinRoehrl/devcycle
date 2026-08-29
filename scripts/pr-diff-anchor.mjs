// Parses a unified PR-head diff and anchors findings against its new-side (RIGHT) lines.
// Pure Node -- no `gh`, no child_process, no filesystem. Line numbers come only from the
// PR-head diff text passed in by the caller, never the local checkout.

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * @param {string} diffText a unified diff (e.g. `gh pr diff` output)
 * @returns {Map<string, Array<{newStart: number, newLines: number, rightLines: Set<number>}>>}
 *   keyed by new-side path (the `b/<path>` prefix stripped)
 */
export function parsePatch(diffText) {
  const map = new Map();
  let path = null;
  let hunk = null;
  let cursor = 0;

  for (const line of diffText.split("\n")) {
    const gitHeaderMatch = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (gitHeaderMatch) {
      path = gitHeaderMatch[1];
      if (!map.has(path)) map.set(path, []);
      hunk = null;
      continue;
    }

    const newFileMatch = line.match(/^\+\+\+ b\/(.*)$/);
    if (newFileMatch) {
      path = newFileMatch[1];
      if (!map.has(path)) map.set(path, []);
      hunk = null;
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      const newStart = Number(hunkMatch[1]);
      const newLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      hunk = { newStart, newLines, rightLines: new Set() };
      cursor = newStart;
      if (path) map.get(path).push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("\\ No newline at end of file")) continue;

    if (line.startsWith(" ") || line.startsWith("+")) {
      hunk.rightLines.add(cursor);
      cursor += 1;
    } else if (line.startsWith("-")) {
      // removed line: no new-side number, counter does not advance
    }
  }

  return map;
}

/**
 * @param {{path: string, line: number|null}} finding
 * @param {number} index the source finding's ordinal, echoed through unchanged
 * @param {Map<string, Array<{newStart: number, newLines: number, rightLines: Set<number>}>>} map
 *   the result of `parsePatch`
 */
export function anchorFinding({ path, line }, index, map) {
  if (!line) {
    return { anchorable: false, reason: "file-only finding (no line to anchor)", index };
  }

  const hunks = map.get(path);
  if (!hunks) {
    return { anchorable: false, reason: "file not in the PR diff", index };
  }

  const onDiff = hunks.some((hunk) => hunk.rightLines.has(line));
  if (!onDiff) {
    return { anchorable: false, reason: `line ${line} is not on the PR-head diff`, index };
  }

  return { anchorable: true, path, line, side: "RIGHT", index };
}
