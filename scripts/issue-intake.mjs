#!/usr/bin/env node
// Read-only GitHub-issue intake for /devcycle:maintain (§M10, Phase 3). This is the DETERMINISTIC
// data plane: fetch open issues read-only, route around devcycle's own [culprit:]/[doctor:]-titled
// issues BEFORE anything downstream, redact third-party body text, and emit a normalized JSON the
// maintaining-the-repo playbook then decomposes/classifies/verifies. The judgment steps
// (decompose, classify bug/refactor/feature, verify via lens methodology) are NOT here — they stay
// playbook prose. This script never mutates an issue: no issue-mutating gh subcommand (close,
// comment, edit, label) appears anywhere in it, by design (§M10 HR1), and issue-intake.test.mjs
// greps for exactly that. gh is wrapped like doctor.mjs's defaultGhRunner: short timeout, and any
// throw degrades to { available:false } rather than failing the pass.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Excludes devcycle's own self-filed issues so a /devcycle:maintain pass never re-triages them as
// external bugs. `compliance` was added once doctor began filing [compliance:<slug>] drafts; the
// CULPRIT_BRACKET / isCulpritBracketTitle / counts.excludedCulprit names predate that and stay as
// a documented report-line interface (widening the pattern, not renaming, avoids the ripple).
const CULPRIT_BRACKET = /^\s*\[(?:culprit|doctor|compliance):[^\]]*\]/i;
export const isCulpritBracketTitle = (title) => CULPRIT_BRACKET.test(String(title ?? ""));

export const defaultGhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

export const defaultRedactRunner = (dir) =>
  execFileSync("node", [join(SCRIPT_DIR, "redaction-check.mjs"), "--auto-redact", "--dir", dir], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });

export function intake({
  repo,
  limit = 50,
  scratchDir,
  ghRunner = defaultGhRunner,
  redactRunner = defaultRedactRunner,
} = {}) {
  if (!repo) throw new Error("issue-intake: repo is required");
  const empty = { available: false, target: repo, issues: [], excludedCulprit: [],
    counts: { fetched: 0, screened: 0, excludedCulprit: 0 } };

  let raw;
  try {
    raw = ghRunner(["issue", "list", "--repo", repo, "--state", "open",
      "--limit", String(limit), "--json", "number,title,body,url"]);
  } catch (err) {
    return { ...empty, reason: String(err?.message ?? err) };
  }

  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];

  const excludedCulprit = [];
  const kept = [];
  for (const it of parsed) {
    if (isCulpritBracketTitle(it.title)) {
      excludedCulprit.push({ number: it.number, title: it.title });
      continue;
    }
    kept.push({ number: it.number, title: it.title, url: it.url, body: it.body ?? "" });
  }

  // Redact kept title AND body via a scratch working copy under .devcycle/ run scratch (never
  // committed). Title and body go to SEPARATE files so each is screened and read back cleanly —
  // a home-path/secret in a title is exactly the class this screen exists to catch. Redaction is
  // a safety net, not a gate: a failure leaves the originals rather than dropping the issue.
  if (kept.length && scratchDir) {
    mkdirSync(scratchDir, { recursive: true });
    for (const it of kept) {
      writeFileSync(join(scratchDir, `issue-${it.number}-title.txt`), it.title ?? "");
      writeFileSync(join(scratchDir, `issue-${it.number}-body.md`), it.body ?? "");
    }
    try { redactRunner(scratchDir); } catch { /* keep originals */ }
    for (const it of kept) {
      try { it.title = readFileSync(join(scratchDir, `issue-${it.number}-title.txt`), "utf8").replace(/\n$/, ""); } catch { /* keep original */ }
      try { it.body = readFileSync(join(scratchDir, `issue-${it.number}-body.md`), "utf8"); } catch { /* keep original */ }
    }
  }

  return {
    available: true, target: repo, issues: kept, excludedCulprit,
    counts: { fetched: parsed.length, screened: kept.length, excludedCulprit: excludedCulprit.length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { flags } = parseFlags(process.argv.slice(2), {
      "--repo": "value", "--limit": "value", "--scratch": "value",
    });
    const repo = requireValue(flags, "--repo");
    if (repo === undefined) throw new Error("--repo requires an owner/name argument");
    const limitRaw = requireValue(flags, "--limit", "a number");
    const out = intake({
      repo,
      limit: limitRaw === undefined ? 50 : Number(limitRaw),
      // Default the scratch dir so a CLI invocation always screens third-party text, even when the
      // caller omits --scratch (the playbook always passes it; this guards ad-hoc use).
      scratchDir: requireValue(flags, "--scratch") ?? join(".devcycle", "issue-intake", "adhoc"),
    });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } catch (e) {
    console.error(`issue-intake: ${e.message}`);
    process.exit(1);
  }
}
