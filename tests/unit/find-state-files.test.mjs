import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { findStateFiles, describe as describeState } from "../../scripts/find-state-files.mjs";
import { makeRepo, sh } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/find-state-files.mjs", import.meta.url));

function writeState(dir, body) {
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  writeFileSync(join(dir, ".devcycle", "state.md"), body);
}

test("finds root and nested state files and prunes node_modules", () => {
  const root = makeTempDir("fsf-");
  try {
    writeState(root, "# devcycle state\n- stage: planning\n- branch: dev\n- request: root cycle\n");
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    writeState(sub, "# devcycle state\n- stage: execution\n- branch: feat\n- request: nested cycle\n");
    const nm = join(root, "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    writeState(nm, "# devcycle state\n- stage: done\n- request: vendored\n");

    const found = findStateFiles(root);
    assert.equal(found.length, 2);
    assert.ok(found.includes(join(root, ".devcycle", "state.md")));
    assert.ok(found.includes(join(root, "sub", ".devcycle", "state.md")));
    assert.ok(!found.some((p) => p.includes("node_modules")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("describe parses fields, last ledger event, and age", () => {
  const root = makeTempDir("fsf-");
  try {
    writeState(root, "# devcycle state\n- stage: execution\n- branch: feat-x\n- request: do a thing\n- updated: 2020-01-01T00:00:00Z\n");
    writeFileSync(
      join(root, ".devcycle", "ledger.md"),
      "preamble line\n" +
        "- [2020-01-01T00:00:00Z] task=1 event=dispatched outcome=ok ref=none\n" +
        "- [2020-01-02T00:00:00Z] task=1 event=committed outcome=ok ref=abc123\n"
    );
    const [rec] = findStateFiles(root).map(describeState);
    assert.equal(rec.stage, "execution");
    assert.equal(rec.branch, "feat-x");
    assert.equal(rec.request, "do a thing");
    assert.ok(rec.lastEvent.includes("event=committed"));
    assert.ok(typeof rec.ageSeconds === "number" && rec.ageSeconds > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json prints an array and zero candidates exits 0 with a message", () => {
  const empty = makeTempDir("fsf-");
  try {
    const j = spawnSync("node", [SCRIPT, "--dir", empty, "--json"], { encoding: "utf8" });
    assert.equal(j.status, 0);
    assert.deepEqual(JSON.parse(j.stdout), []);

    const h = spawnSync("node", [SCRIPT, "--dir", empty], { encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /no devcycle state file found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("an unrecognised flag exits non-zero with the script's prefix", () => {
  const r = spawnSync("node", [SCRIPT, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /find-state-files:/);
});

test("a --dir with no value exits non-zero with the script's prefix, not a raw stack trace", () => {
  const r = spawnSync("node", [SCRIPT, "--dir"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /find-state-files:/);
  assert.doesNotMatch(r.stderr, /^\s+at .+:\d+:\d+/m); // no uncaught-exception stack frames
});

test("each candidate carries the entry and note it would resume through, in text and in --json", () => {
  const dir = makeTempDir("fsf-");
  try {
    writeState(dir, "# devcycle state\n- stage: execution\n- request: demo\n");
    const h = spawnSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /^ {3}entry: .*playbooks\/executing-waves\.md$/m);
    assert.match(h.stdout, /^ {3}note: resume each task from its last ledger event/m);
    const j = spawnSync("node", [SCRIPT, "--dir", dir, "--json"], { encoding: "utf8" });
    const [rec] = JSON.parse(j.stdout);
    assert.ok(rec.entry.endsWith("playbooks/executing-waves.md"), rec.entry);
    assert.match(rec.note, /last ledger event/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a done cycle says it is closed rather than printing an entry or a fault", () => {
  const dir = makeTempDir("fsf-");
  try {
    writeState(dir, "# devcycle state\n- stage: done\n- request: demo\n");
    const h = spawnSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.match(h.stdout, /^ {3}closed: this cycle is done — nothing to resume/m);
    assert.doesNotMatch(h.stdout, /^ {3}entry:|no entry/m);
    const [rec] = JSON.parse(spawnSync("node", [SCRIPT, "--dir", dir, "--json"], { encoding: "utf8" }).stdout);
    assert.equal(rec.closed, true);
    assert.equal(rec.entryError, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const listIn = (cwd, ...args) => spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });

test("a ledger left by another cycle gives no last event (R4)", () => {
  const root = makeTempDir("fsf-");
  try {
    writeState(root, "# devcycle state\n- stage: planning\n- plan: none\n- run: 00000000000000b2\n- request: fresh cycle\n");
    writeFileSync(join(root, ".devcycle", "ledger.md"),
      "Plan: `docs/old-plan.md`\nRun: `00000000000000a1`\n\n- [2020-01-02T00:00:00Z] task=1 event=committed outcome=ok ref=abc123\n");
    const [rec] = findStateFiles(root).map(describeState);
    assert.deepEqual([rec.ledgerSlot, rec.lastEvent], ["stale", null]);
    const r = listIn(root, "--dir", root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /last event: none for this cycle \(ledger holds a previous cycle's rows\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ledger of this cycle still gives its last event", () => {
  const root = makeTempDir("fsf-");
  try {
    writeState(root, "# devcycle state\n- stage: execution\n- plan: docs/plan.md\n- run: 00000000000000b2\n");
    writeFileSync(join(root, ".devcycle", "ledger.md"),
      "Plan: `docs/plan.md`\nRun: `00000000000000b2`\n\n- [2020-01-02T00:00:00Z] task=1 event=committed outcome=ok ref=abc123\n");
    const [rec] = findStateFiles(root).map(describeState);
    assert.equal(rec.ledgerSlot, "fresh");
    assert.ok(rec.lastEvent.includes("event=committed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("from a sibling worktree, the main checkout's state file is listed with its checkout (R2')", () => {
  const repo = realpathSync(makeRepo());
  const parent = makeTempDir("fsf-wt-");
  try {
    const wt = join(parent, "wt");
    sh("git", ["worktree", "add", "-q", "-b", "feat/b", wt], { cwd: repo });
    writeState(repo, "# devcycle state\n- stage: execution\n- branch: feat/b\n- request: main checkout cycle\n");
    const r = listIn(wt);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(join(repo, ".devcycle", "state.md")), r.stdout);
    assert.ok(r.stdout.includes(`checkout: ${repo}`), r.stdout);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a nested worktree's state file is listed once, with its checkout; the caller's own has no label (R3)", () => {
  const repo = realpathSync(makeRepo());
  try {
    const nested = join(repo, ".worktrees", "n");
    sh("git", ["worktree", "add", "-q", "-b", "feat/n", nested], { cwd: repo });
    writeState(repo, "# devcycle state\n- stage: planning\n- branch: dev\n- request: main cycle\n");
    writeState(nested, "# devcycle state\n- stage: execution\n- branch: feat/n\n- request: nested cycle\n");
    const r = listIn(repo);
    assert.equal(r.status, 0, r.stderr);
    const nestedState = join(realpathSync(nested), ".devcycle", "state.md");
    assert.equal(r.stdout.split(nestedState).length - 1, 1, r.stdout);
    assert.equal(r.stdout.match(/checkout: /g)?.length, 1, r.stdout);
    assert.ok(r.stdout.includes(`checkout: ${realpathSync(nested)}`), r.stdout);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
