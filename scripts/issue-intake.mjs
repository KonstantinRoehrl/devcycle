#!/usr/bin/env node
// Read-only GitHub-issue intake, shared by /devcycle:maintain (§M10, Phase 3) and the issue triager
// (through the shared issue-folding owner). This is the DETERMINISTIC data plane: fetch EVERY open
// issue read-only, route around devcycle's own [culprit:]/[doctor:]/[compliance:]-titled issues
// BEFORE anything downstream (or keep them, tagged `tracked`, under --include-tracked), redact
// third-party body text, and emit a normalized JSON the consuming playbook then decomposes,
// classifies and verifies. The fetch is complete and count-checked: the list is requested with
// --limit equal to GitHub's own open-issue total, and a fetched length that differs fails with a
// named reason rather than returning a truncated backlog. The judgment steps (decompose, classify
// bug/refactor/feature, verify via lens methodology) are NOT here — they stay playbook prose. This
// script never mutates an issue: no issue-mutating gh subcommand (close, comment, edit, label)
// appears anywhere in it, by design (§M10 HR1), and issue-intake.test.mjs greps for exactly that.
// gh is wrapped like doctor.mjs's defaultGhRunner, and any throw degrades to { available:false }
// rather than failing the pass.
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

export const GH_TIMEOUT_MS = 30000;
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

export function openIssueTotalArgs(repo) {
  const slash = repo.indexOf("/");
  const owner = slash === -1 ? repo : repo.slice(0, slash);
  const name = slash === -1 ? "" : repo.slice(slash + 1);
  return ["api", "graphql",
    "-f", "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount}}}",
    "-f", `owner=${owner}`, "-f", `name=${name}`,
    "--jq", ".data.repository.issues.totalCount"];
}

export const defaultGhRunner = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
  });

export const defaultRedactRunner = (dir) =>
  execFileSync("node", [join(SCRIPT_DIR, "redaction-check.mjs"), "--auto-redact", "--dir", dir], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });

export function intake({
  repo,
  scratchDir,
  includeTracked = false,
  ghRunner = defaultGhRunner,
  redactRunner = defaultRedactRunner,
} = {}) {
  if (!repo) throw new Error("issue-intake: repo is required");
  const empty = { available: false, target: repo, issues: [], excludedCulprit: [],
    counts: { total: 0, fetched: 0, screened: 0, excludedCulprit: 0, tracked: 0 } };

  let totalRaw;
  try {
    totalRaw = String(ghRunner(openIssueTotalArgs(repo))).trim();
  } catch (err) {
    return { ...empty, reason: `count-unavailable: ${String(err?.message ?? err)}` };
  }
  if (!/^\d+$/.test(totalRaw)) return { ...empty, reason: `count-unavailable: ${totalRaw}` };
  const total = Number(totalRaw);
  if (total === 0) return { ...empty, available: true };

  let raw;
  try {
    raw = ghRunner(["issue", "list", "--repo", repo, "--state", "open",
      "--limit", String(total), "--json", "number,title,body,url"]);
  } catch (err) {
    return { ...empty, reason: String(err?.message ?? err) };
  }

  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  if (parsed.length !== total) {
    return { ...empty, reason: `count-mismatch: fetched ${parsed.length} of ${total} open issues` };
  }

  const excludedCulprit = [];
  const kept = [];
  for (const it of parsed) {
    const tracked = isCulpritBracketTitle(it.title);
    if (tracked && !includeTracked) {
      excludedCulprit.push({ number: it.number, title: it.title });
      continue;
    }
    kept.push({ number: it.number, title: it.title, url: it.url, body: it.body ?? "", tracked });
  }

  // Redact kept title AND body via a scratch working copy under .devcycle/ run scratch (never
  // committed). Title and body go to SEPARATE files so each is screened and read back cleanly —
  // a home-path/secret in a title is exactly the class this screen exists to catch. Redaction is
  // a safety net, not a gate: a failure leaves the originals rather than dropping the issue.
  if (kept.length && scratchDir) {
    let scratchReady = true;
    try { mkdirSync(scratchDir, { recursive: true }); } catch { scratchReady = false; }
    if (scratchReady) {
      for (const it of kept) {
        try { writeFileSync(join(scratchDir, `issue-${it.number}-title.txt`), it.title ?? ""); } catch { /* keep original */ }
        try { writeFileSync(join(scratchDir, `issue-${it.number}-body.md`), it.body ?? ""); } catch { /* keep original */ }
      }
      try { redactRunner(scratchDir); } catch { /* keep originals */ }
      for (const it of kept) {
        try { it.title = readFileSync(join(scratchDir, `issue-${it.number}-title.txt`), "utf8").replace(/\n$/, ""); } catch { /* keep original */ }
        try { it.body = readFileSync(join(scratchDir, `issue-${it.number}-body.md`), "utf8"); } catch { /* keep original */ }
      }
    }
  }

  return {
    available: true, target: repo, issues: kept, excludedCulprit,
    counts: {
      total, fetched: parsed.length, screened: kept.length, excludedCulprit: excludedCulprit.length,
      tracked: kept.filter((it) => it.tracked).length,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { flags } = parseFlags(process.argv.slice(2), {
      "--repo": "value", "--scratch": "value", "--include-tracked": "none",
    });
    const repo = requireValue(flags, "--repo");
    if (repo === undefined) throw new Error("--repo requires an owner/name argument");
    const out = intake({
      repo,
      // Default the scratch dir so a CLI invocation always screens third-party text, even when the
      // caller omits --scratch (the playbook always passes it; this guards ad-hoc use).
      scratchDir: requireValue(flags, "--scratch") ?? join(".devcycle", "issue-intake", "adhoc"),
      includeTracked: flags["--include-tracked"] === true,
    });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } catch (e) {
    console.error(`issue-intake: ${e.message}`);
    process.exit(1);
  }
}
