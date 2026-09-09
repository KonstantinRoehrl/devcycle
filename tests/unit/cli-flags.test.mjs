import test from "node:test";
import assert from "node:assert/strict";
import { parseFlags, requireValue, requireCount } from "../../scripts/cli-flags.mjs";

// Every consumer declares each flag's arity beside its name: "value" for a flag that takes the
// next token, "none" for one whose presence is the whole meaning. There is no default, so a
// seventh consumer cannot add a flag without saying which kind it is.
const KNOWN = { "--dir": "value", "--file": "value" };
const WITH_VALUELESS = { "--dir": "value", "--json": "none" };

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

// --- requireCount: the floor belongs to the caller, not to the owner ---
//
// requireCount is requireValue's numeric sibling and is pinned here for the same reason: its
// edge semantics were otherwise exercised only through spawned dream.mjs runs, which never reach
// the equals form. The floor is a parameter because the flags sharing this owner do not share
// one -- `--cap 0` asks for the do-nothing run the coercion bug produced silently, while
// `--max-sessions 0` is a user asking to be nudged every cycle.
const COUNTS = { "--cap": "value", "--max-sessions": "value" };

test("requireCount passes an absent flag through and reads a whole number in either form", () => {
  assert.equal(requireCount(parseFlags([], COUNTS).flags, "--cap"), undefined);
  assert.equal(requireCount(parseFlags(["--cap", "5"], COUNTS).flags, "--cap"), 5);
  assert.equal(requireCount(parseFlags(["--cap=5"], COUNTS).flags, "--cap"), 5);
});

test("requireCount rejects an empty, missing or non-integer value, naming the flag", () => {
  assert.throws(() => requireCount(parseFlags(["--cap"], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number$/);
  assert.throws(() => requireCount(parseFlags(["--cap="], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number$/);
  assert.throws(() => requireCount(parseFlags(["--cap=abc"], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number, got "abc"/);
  assert.throws(() => requireCount(parseFlags(["--cap=2.5"], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number, got "2.5"/);
  assert.throws(() => requireCount(parseFlags(["--cap=-1"], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number, got "-1"/);
});

// A floor of one is the safe default every count flag inherits; a caller whose zero is meaningful
// says so, and says it once, rather than re-implementing the empty and non-integer rejections.
test("requireCount floors at one by default and a caller can lower the floor to zero", () => {
  assert.throws(() => requireCount(parseFlags(["--cap=0"], COUNTS).flags, "--cap"),
    /--cap requires a positive whole number, got "0"/);
  assert.equal(requireCount(parseFlags(["--max-sessions=0"], COUNTS).flags, "--max-sessions", { min: 0 }), 0);
  assert.equal(requireCount(parseFlags(["--max-sessions", "0"], COUNTS).flags, "--max-sessions", { min: 0 }), 0);
});

// Lowering the floor must not cost the operator the message: a rejected value still names the
// flag to fix, the constraint it broke, and what was actually passed.
test("a floor-zero flag still names itself and its constraint when the value is refused", () => {
  const zero = { min: 0 };
  assert.throws(() => requireCount(parseFlags(["--max-sessions=-1"], COUNTS).flags, "--max-sessions", zero),
    /--max-sessions requires a whole number of at least 0, got "-1"/);
  assert.throws(() => requireCount(parseFlags(["--max-sessions=abc"], COUNTS).flags, "--max-sessions", zero),
    /--max-sessions requires a whole number of at least 0, got "abc"/);
  assert.throws(() => requireCount(parseFlags(["--max-sessions=2.5"], COUNTS).flags, "--max-sessions", zero),
    /--max-sessions requires a whole number of at least 0, got "2.5"/);
  assert.throws(() => requireCount(parseFlags(["--max-sessions="], COUNTS).flags, "--max-sessions", zero),
    /--max-sessions requires a whole number of at least 0$/);
  assert.throws(() => requireCount(parseFlags(["--max-sessions"], COUNTS).flags, "--max-sessions", zero),
    /--max-sessions requires a whole number of at least 0$/);
});

// --- arity: a valueless flag must not eat the next token ---
//
// The whole point of the refusal above is defeated when a valueless flag swallows the bare token
// that was supposed to trigger it: `doctor.mjs --json /fixture` then profiles the operator's real
// ~/.claude/projects and prints a confident report about the wrong sessions. A flag that takes no
// value records its presence and leaves the following token alone.
test("a valueless flag leaves the next token to the positional path, which refuses it", () => {
  assert.throws(
    () => parseFlags(["--json", "/fixture"], WITH_VALUELESS),
    /unexpected argument "\/fixture"/,
  );
});

test("a valueless flag on its own is present and is not an error", () => {
  const { flags } = parseFlags(["--json"], WITH_VALUELESS);
  assert.equal("--json" in flags, true);
});

test("a valueless flag does not disturb a value-taking flag on either side of it", () => {
  const before = parseFlags(["--json", "--dir", "/fixture"], WITH_VALUELESS).flags;
  assert.equal("--json" in before, true);
  assert.equal(before["--dir"], "/fixture");

  const after = parseFlags(["--dir", "/fixture", "--json"], WITH_VALUELESS).flags;
  assert.equal(after["--dir"], "/fixture");
  assert.equal("--json" in after, true);
});

// `--json=true` is an operator who believes the flag takes a value. Accepting it silently teaches
// the wrong shape, and the same operator writes `--json true` next time — which the parser cannot
// distinguish from a bare path.
test("a valueless flag given a value in the equals form is a usage error", () => {
  assert.throws(() => parseFlags(["--json=true"], WITH_VALUELESS), /--json takes no value/);
  assert.throws(() => parseFlags(["--json="], WITH_VALUELESS), /--json takes no value/);
});

// The unknown-flag message is the more specific one -- it names something the operator can only
// have mistyped -- so it must survive a preceding valueless flag rather than being pre-empted by
// the positional refusal that the unknown flag's own value would otherwise trigger.
test("an unrecognised flag after a valueless one still wins over the positional refusal", () => {
  assert.throws(() => parseFlags(["--json", "--dirr", "x"], WITH_VALUELESS), /unrecognised flag --dirr/);
});

// A flat list of names has no room to say which flags take a value, so every consumer that passed
// one inherited the swallowing default. Rejecting the old shape outright is what keeps a seventh
// consumer from re-introducing it.
test("a bare list of flag names is refused, because it cannot declare arity", () => {
  assert.throws(() => parseFlags(["--dir", "x"], ["--dir"]), /arity/);
});

test("a flag declared with an arity that is neither kind is refused", () => {
  assert.throws(() => parseFlags(["--dir", "x"], { "--dir": "path" }), /--dir declares an unknown arity/);
});
