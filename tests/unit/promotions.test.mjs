import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  promoDir, readPromotions, recordPromotion, recordLifecycle, validatePromotion,
  suppressedByCulpritId, legacySimilar, novelSlugs, findPromotionById, consolidatePromotion,
} from "../../scripts/promotions.mjs";
import { verify } from "../../scripts/verification.mjs";

function repo(files = {}) {
  const root = makeTempDir("devcycle-promo-");
  mkdirSync(promoDir(root), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(promoDir(root), name), body);
  return root;
}

const V2 = `# Flaky retry masks a real dependency-order bug
- promotion-type: doc-edit
- cluster-signature: flaky retry masks a dependency-order bug
- files-touched: docs/devcycle/lessons.md
- landed: 2026-08-14
- commit: abc1234
- plugin-version: 0.13.0
- sourced-from-memory: false
- culprit-id: friction:flaky-test-retry
- rung: r2
- audience: repo-devs
- verify: journal-recurrence
- aliases: novel:flaky-retry-hides-order, novel:retry-masks-ordering
`;

const LEGACY = `# Brace-group the chained evidence commands before redirecting
- promotion-type: doc-edit
- cluster-signature: bare chained evidence command redirect drops earlier output
- files-touched: references/evidence.md
- landed: 2026-08-05
- commit: 87dec97
`;

test("a v2 record round-trips every new field", () => {
  const root = repo({ "2026-08-14-flaky.md": V2 });
  const [p] = readPromotions(root);
  assert.equal(p.culpritId, "friction:flaky-test-retry");
  assert.equal(p.rung, "r2");
  assert.equal(p.audience, "repo-devs");
  assert.equal(p.verify, "journal-recurrence");
  assert.deepEqual(p.aliases, ["novel:flaky-retry-hides-order", "novel:retry-masks-ordering"]);
});

test("a legacy record reads null for every v2 field, never an empty string", () => {
  const root = repo({ "2026-08-05-brace.md": LEGACY });
  const [p] = readPromotions(root);
  assert.equal(p.culpritId, null);
  assert.equal(p.rung, null);
  assert.equal(p.audience, null);
  assert.equal(p.verify, null);
  assert.deepEqual(p.aliases, []);
});

test("suppression is id equality, and an alias suppresses too", () => {
  const root = repo({ "2026-08-14-flaky.md": V2 });
  const ps = readPromotions(root);
  assert.equal(suppressedByCulpritId("friction:flaky-test-retry", ps), true);
  assert.equal(suppressedByCulpritId("novel:retry-masks-ordering", ps), true);
  assert.equal(suppressedByCulpritId("friction:something-else", ps), false);
});

test("suppression never fires on a blank or null id", () => {
  const root = repo({ "2026-08-14-flaky.md": V2 });
  const ps = readPromotions(root);
  assert.equal(suppressedByCulpritId("", ps), false);
  assert.equal(suppressedByCulpritId(null, ps), false);
});

test("a legacy record never suppresses, however close its wording", () => {
  const root = repo({ "2026-08-05-brace.md": LEGACY });
  const ps = readPromotions(root);
  assert.equal(
    suppressedByCulpritId("friction:bare-chained-evidence-command-redirect", ps),
    false,
    "a record with no culprit-id can only ever produce a hint, never a suppression",
  );
});

test("legacySimilar hints at close legacy titles and ignores v2 records", () => {
  const root = repo({ "2026-08-05-brace.md": LEGACY, "2026-08-14-flaky.md": V2 });
  const ps = readPromotions(root);
  const hits = legacySimilar("Brace-group chained evidence commands before redirecting", ps);
  assert.equal(hits.length, 1);
  assert.match(hits[0].path, /2026-08-05-brace\.md$/);
  assert.deepEqual(legacySimilar("Flaky retry masks a real dependency-order bug", ps), [],
    "the matching record carries a culprit-id, so it is not a legacy hint");
});

test("legacySimilar returns nothing for an unrelated title", () => {
  const root = repo({ "2026-08-05-brace.md": LEGACY });
  assert.deepEqual(legacySimilar("Pin the model tier in every dispatch", readPromotions(root)), []);
});

test("novelSlugs lists novel ids from both culprit-id and aliases, sorted and unique", () => {
  const root = repo({ "2026-08-14-flaky.md": V2 });
  assert.deepEqual(novelSlugs(readPromotions(root)),
    ["novel:flaky-retry-hides-order", "novel:retry-masks-ordering"]);
});

test("recordPromotion writes the v2 fields in the documented order", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Pin the model tier in every dispatch",
    promotionType: "doc-edit",
    clusterSignature: "dispatch inherits the caller model",
    filesTouched: ["references/delegation.md"],
    landed: "2026-08-14",
    commit: "deadbee",
    pluginVersion: "0.13.0",
    sourcedFromMemory: false,
    culpritId: "friction:model-inherited-not-pinned",
    rung: "r2",
    audience: "repo-devs",
    verify: "journal-recurrence",
    aliases: [],
  });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^- culprit-id: friction:model-inherited-not-pinned$/m);
  assert.match(text, /^- rung: r2$/m);
  assert.match(text, /^- audience: repo-devs$/m);
  assert.match(text, /^- verify: journal-recurrence$/m);
  assert.match(text, /^- aliases: $/m, "an empty aliases list writes the key with no value");
});

test("an r3 verify that does not resolve is rejected at write time", () => {
  const root = repo();
  assert.throws(
    () => recordPromotion(root, {
      title: "Add the ordering check", promotionType: "enforcement-gap",
      clusterSignature: "fixture ordering unchecked", filesTouched: [],
      landed: "2026-08-14", commit: "deadbee", pluginVersion: "0.13.0",
      culpritId: "friction:flaky-test-retry", rung: "r3", audience: "repo-devs",
      verify: "tests/unit/no-such-check.test.mjs",
    }),
    /r3 verify "tests\/unit\/no-such-check\.test\.mjs" resolves to no path under the repo and is not a command/,
  );
});

test("an r3 verify that names a real path is accepted", () => {
  const root = repo();
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  writeFileSync(join(root, "tests", "unit", "ordering.test.mjs"), "");
  const path = recordPromotion(root, {
    title: "Add the ordering check", promotionType: "enforcement-gap",
    clusterSignature: "fixture ordering unchecked", filesTouched: [],
    landed: "2026-08-14", commit: "deadbee", pluginVersion: "0.13.0",
    culpritId: "friction:flaky-test-retry", rung: "r3", audience: "repo-devs",
    verify: "tests/unit/ordering.test.mjs",
  });
  assert.match(readFileSync(path, "utf8"), /^- verify: tests\/unit\/ordering\.test\.mjs$/m);
});

test("an r3 record with no verify at all is rejected", () => {
  const root = repo();
  assert.throws(
    () => validatePromotion({
      promotionType: "doc-edit", landed: "2026-08-14", clusterSignature: "x",
      rung: "r3",
    }, { repoRoot: root }),
    /rung r3 requires a verify: value/,
  );
});

test("an out-of-enum rung is rejected", () => {
  const root = repo();
  assert.throws(
    () => validatePromotion({
      promotionType: "doc-edit", landed: "2026-08-14", clusterSignature: "x", rung: "r9",
    }, { repoRoot: root }),
    /invalid rung "r9" — must be one of: r0, r1, r2, r3/,
  );
});

test("a malformed culprit-id is rejected", () => {
  const root = repo();
  assert.throws(
    () => validatePromotion({
      promotionType: "doc-edit", landed: "2026-08-14", clusterSignature: "x",
      culpritId: "Friction Flaky Retry",
    }, { repoRoot: root }),
    /invalid culprit-id/,
  );
});

test("recordLifecycle writes a retirement record readPromotions tags", () => {
  const root = makeTempDir("life-");
  mkdirSync(join(root, "docs", "devcycle", "promotions"), { recursive: true });
  const path = recordLifecycle(root, {
    title: "Flaky retry masks a real dependency-order bug",
    lifecycle: "retirement", culpritId: "friction:flaky-test-retry", rung: "r2",
    landed: "2026-05-01", at: "2026-08-15", pluginVersion: "0.14.0",
    reason: "held 12 runs over 106 days",
  });
  assert.ok(path.endsWith("-retired.md"));
  const recs = readPromotions(root);
  const life = recs.find((r) => r.lifecycle === "retirement");
  assert.equal(life.culpritId, "friction:flaky-test-retry");
  assert.equal(life.rung, "r2");
  assert.equal(life.at, "2026-08-15");
});

test("recordLifecycle does not overwrite a same-day record for the same culprit", () => {
  const root = repo();
  const rec = {
    title: "Flaky retry masks a real dependency-order bug",
    lifecycle: "retirement", culpritId: "friction:flaky-test-retry", rung: "r2",
    landed: "2026-05-01", at: "2026-08-15", pluginVersion: "0.14.0", reason: "first",
  };
  const p1 = recordLifecycle(root, rec);
  const p2 = recordLifecycle(root, { ...rec, reason: "second" });
  assert.notEqual(p1, p2);
  assert.match(p2, /-2\.md$/);
  assert.match(readFileSync(p1, "utf8"), /first/);
  assert.match(readFileSync(p2, "utf8"), /second/);
});

test("validatePromotion rejects an unknown lifecycle value", () => {
  assert.throws(() => validatePromotion({
    title: "x", lifecycle: "deleted", culpritId: "friction:x", rung: "r2",
    landed: "2026-05-01", at: "2026-08-15",
  }));
});

test("recordPromotion writes affected-files when provided, and readPromotions parses it back", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Pin the model tier in every dispatch",
    promotionType: "doc-edit",
    clusterSignature: "dispatch inherits the caller model",
    filesTouched: ["references/delegation.md"],
    affectedFiles: ["scripts/dispatch.mjs", "references/delegation.md"],
    landed: "2026-08-14",
    commit: "deadbee",
    pluginVersion: "0.13.0",
    culpritId: "friction:model-inherited-not-pinned",
  });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^- affected-files: scripts\/dispatch\.mjs, references\/delegation\.md$/m);
  const [p] = readPromotions(root);
  assert.deepEqual(p.affectedFiles, ["scripts/dispatch.mjs", "references/delegation.md"]);
});

test("affected-files falls back to files-touched when rec.affectedFiles is absent", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Pin the model tier in every dispatch",
    promotionType: "doc-edit",
    clusterSignature: "dispatch inherits the caller model",
    filesTouched: ["references/delegation.md"],
    landed: "2026-08-14",
    commit: "deadbee",
    pluginVersion: "0.13.0",
  });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^- affected-files: references\/delegation\.md$/m);
  const [p] = readPromotions(root);
  assert.deepEqual(p.affectedFiles, ["references/delegation.md"]);
});

test("readPromotions returns an empty affectedFiles array for a legacy record with no affected-files line", () => {
  const root = repo({ "2026-08-05-brace.md": LEGACY });
  const [p] = readPromotions(root);
  assert.deepEqual(p.affectedFiles, []);
});

test("validatePromotion accepts a bare taxonomy culprit-id", () => {
  assert.doesNotThrow(() => validatePromotion({
    promotionType: "doc-edit", clusterSignature: "s", landed: "2026-01-01",
    culpritId: "fix-misses-the-convention",
  }));
});

test("validatePromotion still accepts the colon <kind>:<slug> form", () => {
  for (const ok of ["novel:tautological-test", "correction:foo", "friction:flaky-test-retry"]) {
    assert.doesNotThrow(() => validatePromotion({
      promotionType: "doc-edit", clusterSignature: "s", landed: "2026-01-01", culpritId: ok,
    }), `${ok} must be accepted`);
  }
});

test("validatePromotion still rejects malformed culprit-ids", () => {
  for (const bad of ["", "UPPER", ":leading", "trailing:", "a::b"]) {
    assert.throws(() => validatePromotion({
      promotionType: "doc-edit", clusterSignature: "s", landed: "2026-01-01", culpritId: bad,
    }), new RegExp("culprit-id"), `${JSON.stringify(bad)} must be rejected`);
  }
});

test("a bare culprit-id round-trips through record → read → verify and joins its journal event", () => {
  const root = repo();
  recordPromotion(root, {
    title: "Fix misses the convention",
    promotionType: "doc-edit",
    clusterSignature: "fix misses the convention",
    filesTouched: ["scripts/x.mjs"],
    landed: "2026-01-01",
    culpritId: "fix-misses-the-convention",
    rung: "r2",
  });
  const promotions = readPromotions(root);
  const events = [
    { runId: "a".repeat(16), culprit: "fix-misses-the-convention", ts: "2026-02-01T00:00:00Z" },
  ];
  const { scoreboard } = verify(promotions, events, "0.13.1", { root });
  const row = scoreboard.find((s) => s.culpritId === "fix-misses-the-convention");
  assert.ok(row, "the bare-slug promotion must join its journal event, not be silently dropped");
  assert.equal(row.verdict, "recurred");
});

test("consolidatePromotion: sets the consolidated date and readPromotions reads it back", () => {
  const root = repo();
  recordPromotion(root, { title: "t", promotionType: "doc-edit", clusterSignature: "c",
    filesTouched: ["a"], landed: "2026-09-01", culpritId: "win:x", rung: "r2",
    verify: "journal-reinforcement" });
  assert.equal(readPromotions(root)[0].consolidated, null);
  const p = consolidatePromotion(root, "win:x", "2026-09-11");
  assert.ok(p.endsWith(".md"));
  assert.equal(readPromotions(root)[0].consolidated, "2026-09-11");
  // Idempotent replace, not duplicate:
  consolidatePromotion(root, "win:x", "2026-09-12");
  assert.equal(readPromotions(root)[0].consolidated, "2026-09-12");
});

test("consolidatePromotion: rejects a bad date and an unknown culprit-id", () => {
  const root = repo();
  recordPromotion(root, { title: "t", promotionType: "doc-edit", clusterSignature: "c",
    filesTouched: ["a"], landed: "2026-09-01", culpritId: "win:x", rung: "r2",
    verify: "journal-reinforcement" });
  assert.throws(() => consolidatePromotion(root, "win:x", "nope"), /invalid consolidated date/);
  assert.throws(() => consolidatePromotion(root, "missing", "2026-09-11"), /no promotion record found/);
});

test("consolidatePromotion appends the consolidated line without altering any other byte (QC2, empty trailing field)", () => {
  const root = repo();
  // An empty aliases list makes the record's last field `- aliases: ` with a trailing space —
  // exactly the shape a greedy trailing-whitespace strip would silently rewrite.
  const path = recordPromotion(root, { title: "t", promotionType: "doc-edit", clusterSignature: "c",
    filesTouched: ["a"], landed: "2026-09-01", culpritId: "win:x", rung: "r2",
    verify: "journal-reinforcement", aliases: [] });
  const before = readFileSync(path, "utf8");
  assert.ok(before.endsWith("- aliases: \n"),
    "precondition: an empty aliases list leaves `- aliases: ` (trailing space) as the last field");

  consolidatePromotion(root, "win:x", "2026-09-11");
  const after = readFileSync(path, "utf8");

  const beforeLines = before.split("\n"); // trailing "" element, since the record ends with \n
  const afterLines = after.split("\n");
  // Exactly one line is added.
  assert.equal(afterLines.length, beforeLines.length + 1, "consolidation must add exactly one line");
  const tail = beforeLines.length - 1; // index of the trailing "" element in beforeLines
  // Every pre-existing content line is byte-identical, trailing space and all.
  for (let i = 0; i < tail; i++) {
    assert.equal(afterLines[i], beforeLines[i], `pre-existing line ${i} must be byte-identical`);
  }
  // The only new line is the consolidated line, appended after the last field.
  assert.equal(afterLines[tail], "- consolidated: 2026-09-11");
  assert.equal(afterLines[tail + 1], "");
  // Belt and braces: the previous field kept its trailing space.
  assert.ok(after.includes("- aliases: \n"),
    "the previous field's trailing space must survive consolidation");
});

test("findPromotionById resolves by culprit-id, then alias, then filename slug, and returns null when nothing matches", () => {
  const root = repo({ "2026-08-14-flaky.md": V2, "2026-08-05-brace.md": LEGACY });
  const ps = readPromotions(root);
  const flaky = ps.find((p) => p.culpritId === "friction:flaky-test-retry");
  const legacy = ps.find((p) => p.culpritId === null);
  assert.equal(findPromotionById(ps, "friction:flaky-test-retry"), flaky);
  assert.equal(findPromotionById(ps, "novel:retry-masks-ordering"), flaky);
  assert.equal(findPromotionById(ps, "brace"), legacy);
  assert.equal(findPromotionById(ps, "friction:no-such-id"), null);
});
