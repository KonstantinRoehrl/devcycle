#!/usr/bin/env node
// The canary's verdict, and the bump PR it opens on a Claude Code break. Which step failed does not say
// why: a flaky mod test or a broken superpowers release fails there too. So a failure on latest is re-run
// on the pin, and only a failure the pin does not share is called a Claude Code break.
// The canary runs from main, so it tests main's code, but its PR goes to dev, where the fix lands. It
// therefore bumps dev's pin, read from the fetched dev branch, and not the pin of the main it tested.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { SEMVER_RE, cmpSemver } from "./semver.mjs";
import { OWNER_FILE, PACKAGE, bumpCurrent, parseVersions } from "./claude-code-versions.mjs";

const LABEL = "canary";
const BASE = "dev";
const DEPENDABOT_BRANCH = "dependabot/npm_and_yarn/";
const CANARY_BRANCH = "canary/claude-code-";
const SUSPECT_STEPS = { validate_marketplace: "the marketplace validator", validate_manifest: "the manifest validator", hooks_tests: "the hooks module's tests", plugin_install: "the real plugin install", load_check: "the installed plugin's load" };
const INFRASTRUCTURE_STEPS = ["install", "marketplace_add"];

// A fetch can fail without Claude Code being at fault. The pin's marketplace outage and an install that
// failed on latest but passes once tried again there both read as infrastructure, never as a break.
export function computeVerdict(steps) {
  const failed = (name) => steps[name]?.outcome === "failure";
  if (INFRASTRUCTURE_STEPS.some(failed)) return { verdict: "infrastructure", step: null };
  const suspects = Object.keys(SUSPECT_STEPS).filter(failed);
  if (!suspects.length) return { verdict: "pass", step: null };
  const pin = steps.pin?.outputs ?? {};
  if (pin.install !== "success" || pin.marketplace_add === "failure") return { verdict: "infrastructure", step: null };
  const confirmed = (name) => name !== "plugin_install" || failed("plugin_install_confirm");
  const breaks = suspects.filter((name) => pin[name] === "success" && confirmed(name));
  if (breaks.length) return { verdict: "break", step: breaks[0] };
  const blamable = suspects.filter((name) => pin[name] !== "success");
  return blamable.length ? { verdict: "repo-side", step: blamable[0] } : { verdict: "infrastructure", step: null };
}

export const bumpSubject = (from, to) => `ci(deps): bump ${PACKAGE} from ${from} to ${to}`;
const OWN_COMMIT_PREFIX = `ci(deps): bump ${PACKAGE} from `;

const atOrPast = (to, version) => to !== null && cmpSemver(to, version) >= 0;

// A Canary PR with a commit besides its own bump (ownOnly false) is one someone pushed a fix to, so it is never closed.
export function decideAction({ verdict, version, step, devPin, prs }) {
  const owned = prs.filter((candidate) => candidate.kind === "canary" && candidate.ownOnly);
  if (verdict === "pass") return { kind: "none", target: null, close: owned.map((candidate) => candidate.number) };
  if (verdict !== "break" || !SEMVER_RE.test(version)) return { kind: "none", target: null, close: [] };
  if (devPin && cmpSemver(devPin, version) >= 0) return { kind: "dev-ahead", target: null, close: [] };
  const canaryPrs = prs.filter((candidate) => candidate.kind === "canary");
  const target =
    prs.find((candidate) => candidate.kind === "dependabot" && atOrPast(candidate.to, version)) ??
    canaryPrs.find((candidate) => atOrPast(candidate.to, version)) ??
    canaryPrs.find((candidate) => !candidate.ownOnly) ??
    null;
  const close = owned.filter((candidate) => candidate !== target).map((candidate) => candidate.number);
  if (!target) return { kind: "open", target: null, close };
  const seen = target.marker?.version === version && target.marker?.step === step;
  return { kind: seen ? "none" : "comment", target: target.number, close };
}

const marker = (version, step) => `<!-- canary version=${version} step=${step} -->`;

function readMarker(item) {
  const texts = [item.body ?? "", ...(item.comments ?? []).map((comment) => comment.body ?? "")];
  const found = texts.flatMap((text) => [...text.matchAll(/<!-- canary version=(\S+) step=(\S+) -->/g)]).at(-1);
  return found ? { version: found[1], step: found[2] } : null;
}

function kindOf(head) {
  if (head.startsWith(DEPENDABOT_BRANCH)) return "dependabot";
  if (head.startsWith(CANARY_BRANCH)) return "canary";
  return null;
}

// The version a PR bumps to comes from the owner file at its head: a grouped Dependabot title names the group.
function versionAtHead(gh, repo, head) {
  try {
    const text = gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo ?? "{owner}/{repo}"}/contents/${OWNER_FILE}?ref=${encodeURIComponent(head)}`]);
    return parseVersions(text, `${OWNER_FILE} at ${head}`).current;
  } catch {
    return null;
  }
}

function listBumpPrs(gh, repo, readTargets) {
  const listed = JSON.parse(gh(["pr", "list", "--base", BASE, "--state", "open", "--limit", "100", "--json", "number,headRefName,body,comments,commits"]) || "[]");
  return listed.flatMap((item) => {
    const kind = kindOf(item.headRefName);
    if (!kind) return [];
    const ownOnly = kind === "canary" && item.commits.length === 1 && item.commits[0].messageHeadline.startsWith(OWN_COMMIT_PREFIX);
    const to = readTargets ? versionAtHead(gh, repo, item.headRefName) : null;
    return [{ number: item.number, kind, to, ownOnly, marker: readMarker(item) }];
  });
}

function openBumpPr({ version, step, text, devPin, devText, gh, git, root }) {
  const branch = `${CANARY_BRANCH}${version}`;
  const subject = bumpSubject(devPin, version);
  git(["checkout", "-B", branch, `origin/${BASE}`]);
  const path = join(root, OWNER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bumpCurrent(devText, version));
  git(["add", OWNER_FILE]);
  git(["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", subject]);
  git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  try {
    gh(["label", "create", LABEL, "--force", "--color", "D93F0B", "--description", "The daily Claude Code canary found a break"]);
  } catch {
    // The label usually exists already, and the job's token may not be allowed to create one.
  }
  const body = [
    text,
    `This PR moves CI's Claude Code version from ${devPin} to ${version}, so the fix for the break lands here.`,
    "Canary dispatched validate.yml on this branch, because a PR opened by a workflow does not start its own checks. If no checks show on this PR, the run linked above is the evidence.",
    "Canary closes this PR once a later Claude Code release passes, unless someone has pushed a fix to it.",
    "No issue",
    marker(version, step),
  ].join("\n\n");
  gh(["pr", "create", "--base", BASE, "--head", branch, "--title", subject, "--label", LABEL, "--body", body]);
  gh(["workflow", "run", "validate.yml", "--ref", branch]);
}

export function report({ verdict, version, step, runUrl, gh, git, root = ".", token, repo }) {
  const isBreak = verdict === "break" && SEMVER_RE.test(version);
  if (verdict !== "pass" && !isBreak) return { kind: "none", target: null, close: [], devPin: null };
  const prs = listBumpPrs(gh, repo, isBreak);
  let devPin = null;
  let devText = "";
  if (isBreak) {
    // The checkout's persist-credentials: false dropped the push credential, so it is set again for the push.
    git(["remote", "set-url", "origin", `https://x-access-token:${token}@github.com/${repo}.git`]);
    git(["fetch", "--no-tags", "--depth=1", "origin", `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`]);
    devText = git(["show", `origin/${BASE}:${OWNER_FILE}`]);
    devPin = parseVersions(devText, `${OWNER_FILE} on ${BASE}`).current;
  }
  const action = decideAction({ verdict, version, step, devPin, prs });
  const text = `Claude Code ${version} fails ${SUSPECT_STEPS[step] ?? step}, and the pinned version passes the same check.\n\nRun: ${runUrl}`;
  const closeText = isBreak
    ? `Claude Code ${version} is the newer break, so this older bump is closed.\n\nRun: ${runUrl}`
    : `The canary passes again on Claude Code ${version}, so this bump is no longer needed. Dependabot brings the new version to CI's pin.\n\nRun: ${runUrl}`;
  for (const number of action.close) gh(["pr", "close", String(number), "--delete-branch", "--comment", closeText]);
  if (action.kind === "comment") gh(["pr", "comment", String(action.target), "--body", `${text}\n\n${marker(version, step)}`]);
  if (action.kind === "open") openBumpPr({ version, step, text, devPin, devText, gh, git, root });
  return { ...action, devPin };
}

function main([command, ...rest]) {
  if (command === "verdict") {
    const { verdict, step } = computeVerdict(JSON.parse(process.env.STEPS));
    appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nstep=${step ?? ""}\n`);
    return console.log(`verdict: ${verdict}${step ? ` (${step})` : ""}`);
  }
  if (command === "report") {
    const { flags } = parseFlags(rest, { "--verdict": "value", "--version": "value", "--step": "value", "--run-url": "value" });
    const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
    const git = (args) => execFileSync("git", args, { encoding: "utf8" });
    const version = requireValue(flags, "--version");
    const action = report({ verdict: requireValue(flags, "--verdict"), version, step: flags["--step"] ?? "", runUrl: requireValue(flags, "--run-url"), gh, git, token: process.env.GH_TOKEN, repo: process.env.GH_REPO });
    if (action.kind === "dev-ahead" && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Claude Code ${version} breaks main's code, but dev already tests ${action.devPin}; dev's own check is the evidence.\n`);
    }
    return console.log(`canary action: ${action.kind}`);
  }
  console.error("canary-report: usage: canary-report.mjs verdict | report --verdict <v> --version <v> [--step <s>] --run-url <url>");
  process.exit(2);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
