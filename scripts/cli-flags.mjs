// One owner for command-line flag parsing across the scripts, extracted from redaction-check.mjs
// where the hardened version was written. Callers pass their own argument vector and their own
// KNOWN_FLAGS declaration, so an unrecognised flag is an error rather than a silent no-op: a
// caller whose flag was never read still gets a green against the wrong corpus.
//
// These functions throw rather than exiting, so each CLI keeps its own message prefix and exit
// code, and a test can assert on them without spawning a process.

// A flag's arity: whether it takes the token after it, or whether its presence is the whole
// meaning. Every declared flag names one of these, because the alternative -- a default -- is what
// this module got wrong: a flat list of names had no room to say "takes no value", so every flag
// was treated as value-taking and a valueless one swallowed the bare path meant for --dir.
const ARITIES = new Set(["value", "none"]);

// Parses both calling conventions the scripts use -- the space form (`--file x`) and the equals
// form (`--file=x`) -- and returns non-flag tokens separately so a caller taking a positional path
// still sees it.
//
// `knownFlags` is a map from flag name to arity -- `{ "--dir": "value", "--json": "none" }` -- and
// never a bare list. The map shape is the point: an object literal cannot carry a name without
// carrying its arity too, so a consumer added later cannot inherit a silently wrong default the
// way six of them did. The old list shape is refused outright rather than assumed value-taking.
//
// A bare token is refused by default, because dropping a flag *name* is the same false green as
// misspelling one and has nothing misspelled to notice: `doctor.mjs /fixture` is the natural slip
// for `--dir /fixture`, and a caller that destructured only `{ flags }` profiled its default corpus
// -- the operator's real ~/.claude/projects -- and printed a confident, clean report about it. The
// rule therefore lives here rather than in each consumer's memory. `allowPositionals` opts in the
// one script that genuinely takes one, lint-plan-code-blocks, which takes a plan path alongside
// --dir; every other consumer inherits the safe default.
export function parseFlags(argv, knownFlags, { allowPositionals = false } = {}) {
  if (knownFlags === null || typeof knownFlags !== "object" || Array.isArray(knownFlags))
    throw new Error('knownFlags must map each flag to its arity: { "--dir": "value", "--json": "none" }');
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!Object.hasOwn(knownFlags, name)) throw new Error(`unrecognised flag ${name}`);
    const arity = knownFlags[name];
    // A mistyped arity would otherwise pick whichever branch the comparison happened to miss, so
    // the declaration itself is checked rather than trusted.
    if (!ARITIES.has(arity))
      throw new Error(`${name} declares an unknown arity ${JSON.stringify(arity)}`);
    if (eq !== -1) {
      // `--json=true` is an operator who believes the flag takes a value. Accepting it silently
      // teaches the wrong shape, and that same operator writes `--json true` next time -- which
      // is indistinguishable from a bare path.
      if (arity === "none") throw new Error(`${name} takes no value`);
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    // Presence is the whole meaning, so the following token is left alone. That is what lets
    // `doctor.mjs --json /fixture` reach the positional refusal below instead of profiling the
    // operator's real home corpus under a flag that quietly ate the path.
    if (arity === "none") {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    // A value that is itself another flag means this flag's value is missing, not that the next
    // flag's token belongs to this one.
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = undefined;
    }
  }
  // Checked after the whole vector is walked, so an unrecognised flag later in argv still reports
  // the more specific message. Only the first offending token is named: it is the one the operator
  // has to fix, and listing the rest buries it.
  if (!allowPositionals && positionals.length)
    throw new Error(`unexpected argument "${positionals[0]}"`);
  return { flags, positionals };
}

// A flag's value must be explicit and non-empty: a missing value (the flag was the last token, or
// is immediately followed by another flag) and an empty or whitespace-only value are the same
// operator mistake in two guises -- e.g. `--file "$draft"` for an unset shell variable -- and both
// must fail loudly, naming the flag, rather than silently widening the scan to the whole corpus.
//
// `noun` completes the sentence `<flag> requires <noun>`, so a caller whose flag takes something
// other than a path -- doctor's `--since` takes a date -- says so instead of sending the operator
// looking for a file that was never involved. Most flags here are paths, so that stays the default.
export function requireValue(flags, name, noun = "a path argument") {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (v == null || v.trim() === "") throw new Error(`${name} requires ${noun}`);
  return v;
}
