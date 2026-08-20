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

// A dropped flag *name* leaves a bare token behind -- `--dir /fixture` typed as `/fixture` --
// and a consumer that destructures only `{ flags }` runs against its default corpus while
// reporting a confident green. That is the same failure as a misspelled flag, so the owner
// refuses it by default rather than leaving each consumer to remember the check.
test("an unconsumed positional throws by default, naming the token", () => {
  assert.throws(() => parseFlags(["/fixture"], KNOWN), /unexpected argument "\/fixture"/);
  assert.throws(() => parseFlags(["--dir", "x", "extra"], KNOWN), /unexpected argument "extra"/);
});

// The one legitimate positional-taking consumer -- lint-plan-code-blocks, which takes a plan
// path alongside --dir -- opts in and still gets every positional, in argv order.
test("a caller that takes positionals opts in and still gets them all", () => {
  const { flags, positionals } = parseFlags(["plan.md", "--dir", "x", "extra"], KNOWN, {
    allowPositionals: true,
  });
  assert.deepEqual(positionals, ["plan.md", "extra"]);
  assert.equal(flags["--dir"], "x");
});

test("the default still returns the documented shape, with no positionals", () => {
  assert.deepEqual(parseFlags(["--dir", "x"], KNOWN), { flags: { "--dir": "x" }, positionals: [] });
});

test("requireValue rejects a present-but-empty value and passes an absent flag through", () => {
  assert.equal(requireValue(parseFlags([], KNOWN).flags, "--dir"), undefined);
  assert.throws(() => requireValue(parseFlags(["--dir"], KNOWN).flags, "--dir"), /--dir requires a path argument/);
  assert.throws(() => requireValue(parseFlags(["--dir="], KNOWN).flags, "--dir"), /--dir requires a path argument/);
  assert.equal(requireValue(parseFlags(["--dir", "x"], KNOWN).flags, "--dir"), "x");
});

// Not every consumer's flags are paths: doctor's --since is a date. A caller can name what its
// flag wants, and a caller that names nothing keeps the path wording every other script relies on.
test("requireValue names what the flag wants, and still says a path by default", () => {
  assert.throws(() => requireValue(parseFlags(["--file"], KNOWN).flags, "--file"), /--file requires a path argument$/);
  assert.throws(() => requireValue(parseFlags(["--file"], KNOWN).flags, "--file", "a date"), /--file requires a date$/);
  assert.throws(() => requireValue(parseFlags(["--file="], KNOWN).flags, "--file", "a value"), /--file requires a value$/);
  assert.equal(requireValue(parseFlags(["--file", "x"], KNOWN).flags, "--file", "a date"), "x");
});
