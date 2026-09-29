import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROSTER, isUnset, resolveKnobs, formatKnobsLine, formatExplicitLine, parseRecordedLine, compareKnobs,
} from "../../scripts/resolve-knobs.mjs";

const SCRIPT = join(process.cwd(), "scripts/resolve-knobs.mjs");
const UNSET = Object.fromEntries(ROSTER.map(({ key }) => [key, "${user_config." + key + "}"]));
const with_ = (overrides) => ({ ...UNSET, ...overrides });
const argv = (raw) => ROSTER.flatMap(({ key }) => [`--${key}`, raw[key]]);
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

const STANDARD_DEFAULTS =
  "knobs: profile=standard gitPolicy=local-commits-only docTrackingPolicy=standard reviewDepth=single " +
  "crossModelReview=false onDeviceGate=human-required implementerModel=auto taskReviewerModel=auto " +
  "branchReviewModel=auto walkthroughModel=auto learnStalenessSessions=5 learnStalenessDays=14 learnSessionCap=100";

test("the roster carries the 13 shipped knobs in config.md's roster order", () => {
  assert.deepEqual(ROSTER.map(({ key }) => key), [
    "profile", "gitPolicy", "docTrackingPolicy", "reviewDepth", "crossModelReview", "onDeviceGate",
    "implementerModel", "taskReviewerModel", "branchReviewModel", "walkthroughModel",
    "learnStalenessSessions", "learnStalenessDays", "learnSessionCap",
  ]);
});

test("empty, a literal placeholder and auto are the three unset forms", () => {
  for (const v of ["", "   ", "${user_config.gitPolicy}", "auto", " auto ", undefined]) assert.equal(isUnset(v), true, String(v));
  assert.equal(isUnset("open-pr"), false);
});

test("an all-unset invocation resolves every knob to its standard fallback, nothing explicit, no warning", () => {
  for (const raw of [UNSET, with_(Object.fromEntries(ROSTER.map(({ key }) => [key, ""]))), with_(Object.fromEntries(ROSTER.map(({ key }) => [key, "auto"])))]) {
    const { knobs, explicit, warnings } = resolveKnobs(raw);
    assert.equal(formatKnobsLine(knobs), STANDARD_DEFAULTS);
    assert.deepEqual(explicit, []);
    assert.deepEqual(warnings, []);
  }
});

test("reviewDepth and onDeviceGate follow each profile column when unset", () => {
  const expected = { lean: ["single", "auto-ok"], standard: ["single", "human-required"], thorough: ["panel", "human-required"] };
  for (const [profile, [reviewDepth, onDeviceGate]] of Object.entries(expected)) {
    const { knobs, explicit } = resolveKnobs(with_({ profile }));
    assert.equal(knobs.reviewDepth, reviewDepth, profile);
    assert.equal(knobs.onDeviceGate, onDeviceGate, profile);
    assert.deepEqual(explicit, ["profile"]);
  }
});

test("an explicit in-set value wins verbatim over the profile row", () => {
  const { knobs, explicit } = resolveKnobs(with_({ profile: "thorough", reviewDepth: "single", gitPolicy: "open-pr" }));
  assert.equal(knobs.reviewDepth, "single");
  assert.equal(knobs.gitPolicy, "open-pr");
  assert.deepEqual(explicit, ["profile", "gitPolicy", "reviewDepth"]);
});

test("an out-of-set value warns naming knob, value, allowed set and fallback, then falls back", () => {
  const { knobs, explicit, warnings } = resolveKnobs(with_({ profile: "thorough", reviewDepth: "deep" }));
  assert.equal(knobs.reviewDepth, "panel");
  assert.deepEqual(explicit, ["profile"]);
  assert.deepEqual(warnings, ["reviewDepth=deep is not one of single | panel; using panel"]);
});

test("an invalid profile falls back to standard with a warning", () => {
  const { knobs, warnings } = resolveKnobs(with_({ profile: "extreme" }));
  assert.equal(knobs.profile, "standard");
  assert.deepEqual(warnings, ["profile=extreme is not one of lean | standard | thorough; using standard"]);
});

test("count knobs: thresholds accept 0, the session cap refuses it, non-integers are refused", () => {
  const ok = resolveKnobs(with_({ learnStalenessSessions: "0", learnStalenessDays: "007" }));
  assert.equal(ok.knobs.learnStalenessSessions, "0");
  assert.equal(ok.knobs.learnStalenessDays, "7");
  assert.deepEqual(ok.explicit, ["learnStalenessSessions", "learnStalenessDays"]);
  const bad = resolveKnobs(with_({ learnSessionCap: "0", learnStalenessDays: "2.5" }));
  assert.equal(bad.knobs.learnSessionCap, "100");
  assert.equal(bad.knobs.learnStalenessDays, "14");
  assert.deepEqual(bad.warnings, [
    "learnStalenessDays=2.5 is not one of a whole number of at least 0; using 14",
    "learnSessionCap=0 is not one of a whole number of at least 1; using 100",
  ]);
});

test("crossModelReview accepts only true and false", () => {
  assert.equal(resolveKnobs(with_({ crossModelReview: "true" })).knobs.crossModelReview, "true");
  const bad = resolveKnobs(with_({ crossModelReview: "yes" }));
  assert.equal(bad.knobs.crossModelReview, "false");
  assert.deepEqual(bad.warnings, ["crossModelReview=yes is not one of true | false; using false"]);
});

test("a *Model knob takes a single id or a pool, normalized; auto stays unset", () => {
  const { knobs, explicit } = resolveKnobs(with_({ implementerModel: "claude-a, claude-b ,", taskReviewerModel: "claude-x", branchReviewModel: "auto" }));
  assert.equal(knobs.implementerModel, "claude-a,claude-b");
  assert.equal(knobs.taskReviewerModel, "claude-x");
  assert.equal(knobs.branchReviewModel, "auto");
  assert.deepEqual(explicit, ["implementerModel", "taskReviewerModel"]);
  const bad = resolveKnobs(with_({ walkthroughModel: " , ," }));
  assert.equal(bad.knobs.walkthroughModel, "auto");
  assert.deepEqual(bad.warnings, ["walkthroughModel=, , is not one of auto, a model id, or a comma-separated pool of ids; using auto"]);
});

test("the explicit line is bare when nothing is explicit", () => {
  assert.equal(formatExplicitLine([]), "explicit:");
  assert.equal(formatExplicitLine(["gitPolicy", "reviewDepth"]), "explicit: gitPolicy reviewDepth");
});

test("a recorded line yields only roster key=value tokens", () => {
  assert.deepEqual(parseRecordedLine("- knobs: profile=lean gitPolicy=open-pr implementerModel=a,b"), { profile: "lean", gitPolicy: "open-pr", implementerModel: "a,b" });
  assert.deepEqual(parseRecordedLine("2026-08-06 gitPolicy=open-pr, reviewDepth=auto · profile-asked"), { gitPolicy: "open-pr", reviewDepth: "auto" });
  assert.deepEqual(parseRecordedLine("defaults"), {});
});

test("compare reports exactly the differing keys, and nothing on agreement", () => {
  const { knobs } = resolveKnobs(with_({ gitPolicy: "open-pr" }));
  assert.deepEqual(compareKnobs(parseRecordedLine(formatKnobsLine(knobs)), knobs), []);
  assert.deepEqual(compareKnobs({ gitPolicy: "local-commits-only", profile: "standard" }, knobs), [{ key: "gitPolicy", old: "local-commits-only", new: "open-pr" }]);
});

test("compare skips a recorded auto on a profile-governed knob but not on a *Model knob", () => {
  const { knobs } = resolveKnobs(with_({ implementerModel: "claude-x" }));
  assert.deepEqual(compareKnobs({ reviewDepth: "auto", implementerModel: "auto" }, knobs), [{ key: "implementerModel", old: "auto", new: "claude-x" }]);
});

test("the resolver's profile rows match config.md's profile matrix", () => {
  const config = readFileSync("references/config.md", "utf8");
  const row = (label) => {
    const line = config.split("\n").find((l) => l.startsWith(`| ${label} |`));
    assert.ok(line, `config.md has no "${label}" row`);
    const [lean, standard, thorough] = line.split("|").slice(2, 5).map((c) => c.trim().replace(/`/g, ""));
    return { lean, standard, thorough };
  };
  const fallback = (key) => ROSTER.find((e) => e.key === key).fallback;
  assert.deepEqual(fallback("reviewDepth"), row("branch review engine (`reviewDepth`)"));
  assert.deepEqual(fallback("onDeviceGate"), row("on-device gate (`onDeviceGate`)"));
});

test("cli: an all-unset invocation prints the knobs and explicit lines and exits 0", () => {
  const r = cli(argv(UNSET));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${STANDARD_DEFAULTS}\nexplicit:\n`);
  assert.equal(r.stderr, "");
});

test("cli: a missing knob flag exits 1 naming it", () => {
  const r = cli(argv(UNSET).slice(2));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^resolve-knobs: missing --profile/);
});

test("cli: an unknown flag exits 1 naming it", () => {
  const r = cli([...argv(UNSET), "--gitpolicy", "open-pr"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resolve-knobs: unrecognised flag --gitpolicy/);
});

test("cli: an out-of-set value warns on stderr and still exits 0", () => {
  const r = cli(argv(with_({ gitPolicy: "yolo" })));
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^resolve-knobs: warning: gitPolicy=yolo is not one of local-commits-only \| push-allowed \| open-pr; using local-commits-only$/m);
});

test("cli: --compare prints only the differing keys, and nothing on agreement", () => {
  const raw = with_({ gitPolicy: "open-pr" });
  const differ = cli([...argv(raw), "--compare", "- knobs: gitPolicy=local-commits-only profile=standard"]);
  assert.equal(differ.status, 0, differ.stderr);
  assert.equal(differ.stdout, "gitPolicy: local-commits-only → open-pr\n");
  const agree = cli([...argv(raw), "--compare", "knobs: gitPolicy=open-pr"]);
  assert.equal(agree.stdout, "");
});

test("cli: --json prints knobs, explicit and warnings", () => {
  const r = cli([...argv(with_({ gitPolicy: "open-pr", reviewDepth: "deep" })), "--json"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.knobs.gitPolicy, "open-pr");
  assert.deepEqual(out.explicit, ["gitPolicy"]);
  assert.equal(out.warnings.length, 1);
});
