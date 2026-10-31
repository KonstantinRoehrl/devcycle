#!/usr/bin/env node
// The canary's verdict and its one rolling issue. Which step failed does not say why: a flaky mod test
// or a broken superpowers release fails there too. So a failure on latest is re-run on the pin, and
// only a failure the pin does not share is called a Claude Code break.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";

const LABEL = "canary";
const SUSPECT_STEPS = { validate_marketplace: "the marketplace validator", validate_manifest: "the manifest validator", hooks_tests: "the hooks module's tests", plugin_install: "the real plugin install", load_check: "the installed plugin's load" };
const INFRASTRUCTURE_STEPS = ["install", "marketplace_add"];

export function currentPin(workflowText) {
  const matrix = workflowText.match(/cli:\s*\[([^\]]+)\]/);
  if (!matrix) throw new Error("no cli: matrix in the workflow text");
  return matrix[1].split(",").at(-1).trim().replace(/^["']|["']$/g, "");
}

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

export function decideAction({ verdict, version, step, issue }) {
  if (verdict === "pass") return { kind: issue ? "close" : "none" };
  if (verdict !== "break") return { kind: "none" };
  if (!issue) return { kind: "open" };
  return { kind: issue.marker?.version === version && issue.marker?.step === step ? "none" : "comment" };
}

const marker = (version, step) => `<!-- canary version=${version} step=${step} -->`;

function readMarker(issue) {
  const texts = [issue.body ?? "", ...(issue.comments ?? []).map((comment) => comment.body ?? "")];
  const found = texts.flatMap((text) => [...text.matchAll(/<!-- canary version=(\S+) step=(\S+) -->/g)]).at(-1);
  return found ? { version: found[1], step: found[2] } : null;
}

function findIssue(gh) {
  const [issue] = JSON.parse(gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,body,comments"]) || "[]");
  return issue ? { number: issue.number, marker: readMarker(issue) } : null;
}

export function report({ verdict, version, step, runUrl, gh }) {
  gh(["label", "create", LABEL, "--force", "--color", "D93F0B", "--description", "The daily Claude Code canary found a break"]);
  const issue = findIssue(gh);
  const action = decideAction({ verdict, version, step, issue });
  const what = SUSPECT_STEPS[step] ?? step;
  const text = `Claude Code ${version} fails ${what}, and the pinned version passes the same check.\n\nRun: ${runUrl}\n\n${marker(version, step)}`;
  if (action.kind === "open") gh(["issue", "create", "--label", LABEL, "--title", `Canary: Claude Code ${version} breaks devcycle`, "--body", `${text}\n\nThis issue closes by itself once the canary passes on a later release.`]);
  if (action.kind === "comment") gh(["issue", "comment", String(issue.number), "--body", text]);
  if (action.kind === "close") gh(["issue", "close", String(issue.number), "--comment", `The canary passes again on Claude Code ${version}.\n\nRun: ${runUrl}`]);
  return action;
}

function main([command, ...rest]) {
  if (command === "pin") return console.log(currentPin(readFileSync(".github/workflows/validate.yml", "utf8")));
  if (command === "verdict") {
    const { verdict, step } = computeVerdict(JSON.parse(process.env.STEPS));
    appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nstep=${step ?? ""}\n`);
    return console.log(`verdict: ${verdict}${step ? ` (${step})` : ""}`);
  }
  if (command === "report") {
    const { flags } = parseFlags(rest, { "--verdict": "value", "--version": "value", "--step": "value", "--run-url": "value" });
    const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
    const action = report({ verdict: requireValue(flags, "--verdict"), version: requireValue(flags, "--version"), step: flags["--step"] ?? "", runUrl: requireValue(flags, "--run-url"), gh });
    return console.log(`issue action: ${action.kind}`);
  }
  console.error("canary-report: usage: canary-report.mjs pin | verdict | report --verdict <v> --version <v> [--step <s>] --run-url <url>");
  process.exit(2);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
