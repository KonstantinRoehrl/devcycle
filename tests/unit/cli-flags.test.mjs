import test from "node:test";
import assert from "node:assert/strict";
import { parseFlags, requireValue } from "../../scripts/cli-flags.mjs";

const KNOWN = ["--dir", "--file"];

test("parses the space form and the equals form alike", () => {
  assert.deepEqual(parseFlags(["--dir", "x"], KNOWN).flags, { "--dir": "x" });
  assert.deepEqual(parseFlags(["--dir=x"], KNOWN).flags, { "--dir": "x" });
});

test("an unrecognised flag throws rather than being ignored", () => {
  assert.throws(() => parseFlags(["--dirr", "x"], KNOWN), /unrecognised flag --dirr/);
  assert.throws(() => parseFlags(["--dirr=x"], KNOWN), /unrecognised flag --dirr/);
});

test("a flag followed by another flag has a missing value, not a borrowed one", () => {
  const { flags } = parseFlags(["--dir", "--file", "f"], KNOWN);
  assert.equal(flags["--dir"], undefined);
  assert.equal(flags["--file"], "f");
});

test("positionals are collected, not discarded", () => {
  const { flags, positionals } = parseFlags(["plan.md", "--dir", "x", "extra"], KNOWN);
  assert.deepEqual(positionals, ["plan.md", "extra"]);
  assert.equal(flags["--dir"], "x");
});

test("requireValue rejects a present-but-empty value and passes an absent flag through", () => {
  assert.equal(requireValue(parseFlags([], KNOWN).flags, "--dir"), undefined);
  assert.throws(() => requireValue(parseFlags(["--dir"], KNOWN).flags, "--dir"), /--dir requires a path argument/);
  assert.throws(() => requireValue(parseFlags(["--dir="], KNOWN).flags, "--dir"), /--dir requires a path argument/);
  assert.equal(requireValue(parseFlags(["--dir", "x"], KNOWN).flags, "--dir"), "x");
});
