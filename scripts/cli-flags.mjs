// One owner for command-line flag parsing across the scripts, extracted from redaction-check.mjs
// where the hardened version was written. Callers pass their own argument vector and their own
// KNOWN_FLAGS list, so an unrecognised flag is an error rather than a silent no-op: a caller whose
// flag was never read still gets a green against the wrong corpus.
//
// These functions throw rather than exiting, so each CLI keeps its own message prefix and exit
// code, and a test can assert on them without spawning a process.

// Parses both calling conventions the scripts use -- the space form (`--file x`) and the equals
// form (`--file=x`) -- and returns non-flag tokens separately so a caller taking a positional path
// still sees it.
export function parseFlags(argv, knownFlags) {
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
    if (!knownFlags.includes(name)) throw new Error(`unrecognised flag ${name}`);
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
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
  return { flags, positionals };
}

// A flag's value must be an explicit, non-empty path: a missing value (the flag was the last token,
// or is immediately followed by another flag) and an empty or whitespace-only value are the same
// operator mistake in two guises -- e.g. `--file "$draft"` for an unset shell variable -- and both
// must fail loudly, naming the flag, rather than silently widening the scan to the whole corpus.
export function requireValue(flags, name) {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (v == null || v.trim() === "") throw new Error(`${name} requires a path argument`);
  return v;
}
