#!/usr/bin/env node
// Parses a unified PR-head diff and anchors findings against its new-side (RIGHT) lines.
// The library core (parsePatch/anchorFinding) is pure Node -- no `gh`, no child_process, no
// filesystem; line numbers come only from the PR-head diff text passed in by the caller, never
// the local checkout. The CLI wrapper reads the diff and the findings from files the caller
// resolved (`gh pr diff …` output and the run's ranked findings), and stays just as offline.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    flags[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return flags;
}

function die(msg) {
  process.stderr.write(`pr-diff-anchor: ${msg}\n`);
  process.exit(1);
}

// CLI entry: partition the run's findings against the PR-head diff. `anchored` findings pin to a
// RIGHT-side line the reviewer can post inline; `degraded` ones (file-only, or a line off every
// hunk) fall through to the review summary body — printed, never dropped.
function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags["diff-file"]) die("--diff-file <path> is required");
  if (!flags["findings-file"]) die("--findings-file <path> is required");

  const diffText = readFileSync(flags["diff-file"], "utf8");
  const findings = JSON.parse(readFileSync(flags["findings-file"], "utf8"));
  if (!Array.isArray(findings)) die("--findings-file must contain a JSON array of findings");

  const map = parsePatch(diffText);
  const anchored = [];
  const degraded = [];
  findings.forEach((finding, index) => {
    const result = anchorFinding({ path: finding.path, line: finding.line ?? null }, index, map);
    if (result.anchorable) {
      anchored.push({ index, path: result.path, line: result.line, side: result.side });
    } else {
      degraded.push({ index, path: finding.path, line: finding.line ?? null, reason: result.reason });
    }
  });

  process.stdout.write(JSON.stringify({ anchored, degraded }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
