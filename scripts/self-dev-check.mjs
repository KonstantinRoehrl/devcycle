#!/usr/bin/env node
// #237: when devcycle's own repo is the repo under work, the pipeline runs from the INSTALLED copy
// while the deliverable belongs in the repo — and nothing could tell the two trees apart, so work
// written into the installed cache (or never written to the repo at all) read as a green cycle.
// This guard closes both directions, and is inert in every other repo.
//
// Detection is by plugin name rather than by path, so a worktree of the same repo still counts.
// Equal roots mean no separate installed copy exists — developing devcycle without having it
// installed is legitimate, and there is then nothing to diverge from.
//
// Why content hashes and not the two obvious signals: a version string is equal across a stale
// cache and the repo (that is the reported bug), mtime moves for every file on a legitimate plugin
// update, and the installed cache is not a git checkout at all — `git -C <cache>` walks up and
// answers about an unrelated enclosing repository.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashTree, digest40, compareManifests } from "./tree-hash.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { field } from "./md-field.mjs";

const MANIFEST_REL = ".devcycle/plugin-manifest.json";
const STATE_REL = ".devcycle/state.md";
const MODES = ["--preflight", "--assert", "--plugin-digest"];
// The script's own location, which is the installed copy whenever the pipeline invokes it by its
// plugin path.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// An advisory list is for reading: past this many paths the count carries the signal and the tail
// is noise.
const LIST_CAP = 20;

const say = (message) => `self-dev-check: ${message}`;
const norm = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function readPluginManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

// Inert unless the repo under work IS this plugin's own source. A manifest with no `name` at all
// is never a match: two nameless manifests would otherwise compare equal and turn every plugin
// repo into devcycle's source tree.
function isSelfDevelopment(pluginRoot, repoRoot) {
  if (norm(pluginRoot) === norm(repoRoot)) return false;
  const mine = readPluginManifest(pluginRoot)?.name;
  return typeof mine === "string" && mine === readPluginManifest(repoRoot)?.name;
}

// #237 review: Claude Code writes one `.in_use/<pid>` lock file into the installed plugin root per
// live `claude` process and removes it when that process exits, so the set of them moves with
// unrelated session churn. Hashing it made a second session opening mid-cycle read as "the
// installed plugin was modified" — a hard stop on a clean run — and made the run record's plugin
// identifier depend on how many sessions happened to be open. It is the plugin host's runtime
// state, not bits the plugin ships.
const HOST_RUNTIME_DIRS = [".in_use"];
const isHostRuntime = (path) => HOST_RUNTIME_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));

// What the plugin ships, hashed. tree-hash.mjs owns the one tree walk; this drops the host's
// runtime state from its result and rolls the digest over what is left by tree-hash.mjs's own rule
// — with no runtime state present the two digests are equal, which a test pins so this roll cannot
// drift away from the rule it follows.
function shippedTree(root) {
  const walked = hashTree(root).files;
  const files = {};
  const roll = createHash("sha256");
  for (const path of Object.keys(walked).sort()) {
    if (isHostRuntime(path)) continue;
    files[path] = walked[path];
    roll.update(`${path}\0${walked[path]}\0`);
  }
  return { files, digest: roll.digest("hex") };
}

// The manifest shape `--assert` compares against. shippedTree returns `{ files, digest }` only, so
// the version the mid-cycle-update check reads is taken separately and merged in.
function snapshot(pluginRoot) {
  return { pluginVersion: readPluginManifest(pluginRoot)?.version ?? null, ...shippedTree(pluginRoot) };
}

const fileDigest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The repo side of the preflight comparison, restricted to the top-level entries the plugin
// actually ships. Hashing the whole repo instead would walk `.git` and every local artifact
// directory — paths no install ever contained, reported as divergence, at minutes of I/O.
// Symlinks are skipped rather than followed, exactly as tree-hash.mjs walks the plugin side.
function repoCounterpart(pluginRoot, repoRoot) {
  const files = {};
  for (const name of readdirSync(pluginRoot).sort()) {
    if (isHostRuntime(name)) continue; // the host's runtime state, which no repo is expected to carry
    const abs = join(repoRoot, name);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue; // absent from the repo: the comparison reports it as installed-copy-only
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory())
      for (const [path, digest] of Object.entries(hashTree(abs).files)) files[`${name}/${path}`] = digest;
    else if (stat.isFile()) files[name] = fileDigest(abs);
  }
  return files;
}

// Which repo-only paths mean "the installed copy is behind": the ones git tracks, because those are
// the ones a release installs. An untracked path — a gitignored artifact directory, a local report,
// an editor's droppings — is not release content, so claiming the install is behind on it says more
// than was measured. A git that cannot answer (not a checkout, no git, a path list too long to
// pass) keeps every path and states in the label that it could not tell them apart, rather than
// silently dropping paths or making the stronger claim for them.
const BEHIND = "only in the repo and tracked by git, so the installed copy is behind";
const UNTOLD = "only in the repo; git could not say which of these a release would install";

function repoOnly(repoRoot, paths) {
  if (!paths.length) return { label: BEHIND, paths };
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", ...paths], { encoding: "utf8" });
  if (result.status !== 0) return { label: UNTOLD, paths };
  // -z, so a path with a space or a non-ASCII byte comes back verbatim rather than git-quoted.
  const tracked = new Set(result.stdout.split("\0").filter(Boolean));
  return { label: BEHIND, paths: paths.filter((path) => tracked.has(path)) };
}

const group = (label, paths) =>
  say(
    `${label} (${paths.length}): ${paths.slice(0, LIST_CAP).join(", ")}` +
      (paths.length > LIST_CAP ? `, … and ${paths.length - LIST_CAP} more` : ""),
  );

// Records what the installed plugin looks like right now and reports how far it has drifted from
// the repo. Advisory: a self-development cycle against a stale cache is normal and often
// unavoidable — the defect is not knowing — so every outcome here exits 0, including a baseline
// that could not be written, which `--assert` then reports as the missing baseline it is.
export function preflight({ pluginRoot, repoRoot }) {
  if (!isSelfDevelopment(pluginRoot, repoRoot)) return { inert: true, lines: [] };

  const current = snapshot(pluginRoot);
  const manifestPath = join(repoRoot, MANIFEST_REL);
  const lines = [];
  try {
    mkdirSync(dirname(manifestPath), { recursive: true });
    atomicWrite(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
    lines.push(
      say(
        `baseline written to ${MANIFEST_REL} — ${Object.keys(current.files).length} installed files, plugin ${current.pluginVersion}`,
      ),
    );
  } catch (err) {
    lines.push(say(`baseline could not be written to ${MANIFEST_REL}: ${err.message}`));
  }

  const { changed, added, removed } = compareManifests(current.files, repoCounterpart(pluginRoot, repoRoot));
  const behind = repoOnly(repoRoot, added);
  if (changed.length + behind.paths.length + removed.length === 0) {
    lines.push(say("the installed copy matches the repo"));
  } else {
    if (changed.length) lines.push(group("differing from the repo's copy", changed));
    if (behind.paths.length) lines.push(group(behind.label, behind.paths));
    if (removed.length) lines.push(group("only in the installed copy, removed from the repo", removed));
  }
  return { inert: false, manifestPath, lines };
}

// `references/resume.md` owns the state file's `branch: <name> (cut from <base> at <sha>)` shape;
// this is the runtime read of its base sha, the same annotation hooks/workload-sensor.mjs measures
// a cycle's diff from. Null when there is no state file or no annotation in it.
function recordedBase(repoRoot) {
  let text;
  try {
    text = readFileSync(join(repoRoot, STATE_REL), "utf8");
  } catch {
    return null;
  }
  const match = (field(text, "branch") ?? "").match(/\(cut from .+ at ([0-9a-f]{7,40})\)/);
  return match ? match[1] : null;
}

// Returns `{ manifest }`, or `{ problem }` when the baseline cannot be used — absent because
// `--preflight` never ran, or present but not a manifest. Neither may read as a pass: a cache
// comparison that could not run is not a clean cache.
function readBaseline(repoRoot) {
  const path = join(repoRoot, MANIFEST_REL);
  if (!existsSync(path))
    return {
      problem: `no baseline — ${MANIFEST_REL} is absent, so nothing recorded what the installed plugin looked like when this run started; --preflight never ran`,
    };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest && typeof manifest === "object" && manifest.files && typeof manifest.files === "object")
      return { manifest };
  } catch {
    // Falls through to the same unusable-baseline verdict as a well-formed file of the wrong shape.
  }
  return { problem: `the baseline at ${MANIFEST_REL} is not a readable plugin manifest; re-run --preflight` };
}

// The gate. Fails when a deliverable never reached the repo, or when the installed copy was written
// to during the run. Both conditions are reported in one pass rather than the first stopping the
// second — they are opposite ends of the same mistake and an operator needs to see both.
export function assertLanding({ pluginRoot, repoRoot, expect }) {
  if (!isSelfDevelopment(pluginRoot, repoRoot)) return { ok: true, lines: [] };

  const lines = [];
  let ok = true;
  const fail = (message) => {
    ok = false;
    lines.push(say(message));
  };

  // Condition 1 — did the deliverable land in the repo? A git diff path is always repo-relative by
  // construction, so "no path escaped the repo root" could never fire; naming the expected paths is
  // what makes the check able to fail at all.
  const base = recordedBase(repoRoot);
  if (base === null) {
    fail(
      `no branch base — ${STATE_REL} carries no "(cut from <base> at <sha>)" annotation, so which paths this branch landed cannot be derived`,
    );
  } else {
    const diff = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
    });
    if (diff.status !== 0) {
      fail(`the branch diff against ${base} could not be read: ${(diff.stderr || "").trim()}`);
    } else {
      const changedPaths = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      const missing = expect.filter((path) => !changedPaths.includes(path));
      if (missing.length)
        fail(`deliverable did not land in the repo: ${missing.join(", ")} absent from the branch diff`);
    }
  }

  // Condition 2 — was the installed copy written to? The version check runs first so a legitimate
  // plugin update mid-cycle, which moves every file, is advisory rather than a wall of failures.
  const baseline = readBaseline(repoRoot);
  if (baseline.problem) {
    fail(baseline.problem);
  } else {
    const current = snapshot(pluginRoot);
    if (baseline.manifest.pluginVersion !== current.pluginVersion) {
      lines.push(
        say(
          `plugin updated mid-cycle (${baseline.manifest.pluginVersion} → ${current.pluginVersion}); cache comparison skipped`,
        ),
      );
    } else {
      const { changed, added, removed } = compareManifests(baseline.manifest.files, current.files);
      const touched = [...changed, ...added, ...removed];
      if (touched.length)
        fail(
          `the installed plugin was modified during this run — deliverables belong in the repo, not the cache: ${touched.join(", ")}`,
        );
    }
  }
  return { ok, lines };
}

// The run record's plugin identifier: which bits produced this run, independent of any version
// string, of a VCS state the installed copy does not have, and of how many `claude` processes are
// live — two runs of the same plugin must mint the same value or the id correlates nothing.
export const pluginDigest = (pluginRoot) => digest40(shippedTree(pluginRoot).digest);

function main(argv) {
  const { flags } = parseFlags(argv, {
    "--preflight": "none",
    "--assert": "none",
    "--plugin-digest": "none",
    "--expect": "value",
    "--repo": "value",
  });
  const modes = MODES.filter((mode) => flags[mode]);
  if (modes.length !== 1) throw new Error(`name exactly one mode: ${MODES.join(", ")}`);
  const repoRoot = requireValue(flags, "--repo") ?? process.cwd();

  if (modes[0] === "--plugin-digest") return { ok: true, lines: [pluginDigest(PLUGIN_ROOT)] };
  if (modes[0] === "--preflight")
    return { ok: true, lines: preflight({ pluginRoot: PLUGIN_ROOT, repoRoot }).lines };

  const expect = (requireValue(flags, "--expect", "a comma-separated list of repo-relative paths") ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  // An empty expectation set is a gate with nothing to look for: it would pass every branch,
  // including one where nothing landed.
  if (!expect.length) throw new Error("--assert requires --expect <path>[,<path>…]");
  return assertLanding({ pluginRoot: PLUGIN_ROOT, repoRoot, expect });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (err) {
    console.error(say(err.message));
    process.exit(1);
  }
  for (const line of result.lines) {
    if (result.ok) console.log(line);
    else console.error(line);
  }
  process.exit(result.ok ? 0 : 1);
}
