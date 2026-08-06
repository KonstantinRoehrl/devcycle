import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/redaction-check.mjs");

// Every leaky fixture below is assembled from fragments so this file — which is itself
// tracked and scanned by the real run — never carries a literal a pattern would match.
const SLASH = "/";
const MAC_HOME = `${SLASH}Users${SLASH}someone`;
const LINUX_HOME = `${SLASH}home${SLASH}someone`;
const WINDOWS_HOME = "C:\\Users\\someone";
const SESSION_ID = ["0f9a1b2c", "3d4e", "5f60", "7a8b", "9c0d1e2f3a4b"].join("-");
const TRANSCRIPT_SLUG = `projects${SLASH}-Users-someone-Programming-thing`;

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "redaction-check-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content, "utf8");
  return dir;
}

function run(dir, extra = []) {
  return execFileSync("node", [SCRIPT, "--dir", dir, ...extra], { encoding: "utf8" });
}

function assertFlags(files, expected, extra = []) {
  const dir = makeFixture(files);
  try {
    let stderr = "";
    assert.throws(
      () => run(dir, extra),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertPasses(files, extra = []) {
  const dir = makeFixture(files);
  try {
    assert.match(run(dir, extra), /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("flags an absolute macOS home path", () => {
  assertFlags({ "a.md": `See ${MAC_HOME}/Programming/thing for details.\n` }, /home-directory path/);
});

test("flags an absolute Linux home path", () => {
  assertFlags({ "a.md": `Ran from ${LINUX_HOME}/work/thing last night.\n` }, /home-directory path/);
});

test("flags an absolute Windows home path", () => {
  assertFlags({ "a.md": `Ran from ${WINDOWS_HOME}\\work\\thing last night.\n` }, /home-directory path/);
});

test("flags a session id", () => {
  assertFlags({ "a.md": `Session ${SESSION_ID} carried the run.\n` }, /session id/);
});

test("flags a transcript path carrying an escaped project directory", () => {
  assertFlags({ "a.md": `Mined .claude/${TRANSCRIPT_SLUG}/x.jsonl\n` }, /local project directory/);
});

test("names the file and the class but never echoes the matched text", () => {
  const dir = makeFixture({ "leaky.md": `Session ${SESSION_ID}\n` });
  try {
    let stderr = "";
    assert.throws(
      () => run(dir),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, /leaky\.md/);
    assert.ok(!stderr.includes(SESSION_ID), "the failure message must not reprint the leaked value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes placeholder forms that carry no machine identity", () => {
  assertPasses({
    "a.md": "Run it from ~/.claude/plugins and set $HOME/.config as the target.\n",
    "b.md": "The transcript lives under .claude/projects/<escaped-cwd>/<session-id>.jsonl\n",
  });
});

test("passes hex strings that are not session ids", () => {
  assertPasses({
    "a.md": "Pinned to 3d3c42e5aac5ba805825da76410c181273ba90b1 (v7.0.1), released 2026-08-06.\n",
    "b.md": "Version 0.11.1 shipped; the tag is devcycle--v0.11.1.\n",
  });
});

test("still flags a deny-listed term, read from the hashes file", () => {
  const term = "forbiddenword";
  const dir = makeFixture({
    "a.md": `This mentions ${term} once.\n`,
    "hashes.txt": `${createHash("sha256").update(term).digest("hex")}\n`,
  });
  try {
    let stderr = "";
    assert.throws(
      () => execFileSync("node", [SCRIPT, "--dir", dir, "--hashes", join(dir, "hashes.txt")], {
        encoding: "utf8",
      }),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, /deny-listed term/);
    assert.ok(!stderr.includes(term), "the failure message must not reprint the deny-listed term");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
