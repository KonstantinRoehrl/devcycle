import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLER_NAMES, selectSubcommand } from "../../scripts/dream.mjs";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const read = (p) => readFileSync(join(REPO_ROOT, p), "utf8");

// Parsed from source, the way golden-path's C3 leg 1 reads it: the literal list is what the
// mutual-exclusion guard and that check consume, so it is the side the table must match.
const SUBCOMMANDS = [...read("scripts/dream.mjs").match(/const SUBCOMMANDS = \[([\s\S]*?)\];/)[1]
  .matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);

// The subcommands whose own token takes a value. Every other subcommand's token is a bare switch.
const TAKES_VALUE = new Set([
  "--extract", "--commit-checkpoint", "--record-promotion", "--record-lifecycle", "--consolidate",
  "--check-suppressed", "--check-observations", "--legacy-similar", "--lessons", "--lesson",
  "--render-report",
]);

test("the handler table and the SUBCOMMANDS list name the same subcommands", () => {
  assert.equal(SUBCOMMANDS.length, 20);
  assert.deepEqual([...HANDLER_NAMES].sort(), [...SUBCOMMANDS].sort());
});

test("no subcommand selects nothing, and two are refused in SUBCOMMANDS order", () => {
  assert.equal(selectSubcommand([]), null);
  assert.equal(selectSubcommand(["--since", "x"]), null);
  assert.throws(() => selectSubcommand(["--staleness", "--plan"]), /^Error: --plan and --staleness cannot be combined$/);
});

test("a subcommand token takes a value exactly when it is declared to", () => {
  for (const name of SUBCOMMANDS) {
    if (TAKES_VALUE.has(name)) {
      assert.throws(() => selectSubcommand([name]), new RegExp(`^Error: ${name} requires a value$`), name);
      assert.equal(selectSubcommand([name, "v"]).flags[name], "v", name);
    } else {
      assert.equal(selectSubcommand([name]).flags[name], true, name);
    }
  }
});

test("every subcommand refuses a flag it does not read", () => {
  for (const name of SUBCOMMANDS) {
    const argv = TAKES_VALUE.has(name) ? [name, "v", "--bogus"] : [name, "--bogus"];
    assert.throws(() => selectSubcommand(argv), /^Error: unrecognised flag --bogus$/, name);
  }
});

test("every subcommand refuses a bare token, except --check-suppressed, which names the mistake", () => {
  for (const name of SUBCOMMANDS.filter((n) => n !== "--check-suppressed")) {
    const argv = TAKES_VALUE.has(name) ? [name, "v", "stray"] : [name, "stray"];
    assert.throws(() => selectSubcommand(argv), /^Error: unexpected argument "stray"$/, name);
  }
  assert.deepEqual(selectSubcommand(["--check-suppressed", "id", "extra"]).positionals, ["extra"]);
});

test("each subcommand's modifiers are the ones its handler reads", () => {
  const accepts = {
    "--plan": ["--cap", "3", "--include-oversized", "--run-checks"],
    "--extract": ["--include-oversized"],
    "--check-recurrence": ["--run-checks", "--profile", "lean"],
    "--journal-events": ["--since", "2026-10-01T00:00:00Z"],
    "--match": ["--stage", "execution", "--files", "a.mjs", "--culprits", "c", "--keywords", "k"],
    "--render-report": ["--outcome", "--profile", "lean"],
    "--plan-landing": ["--stage", "execution", "--line", "- t [c]", "--store", "repo"],
    "--staleness": ["--max-sessions", "0", "--max-days", "0", "--cap", "5"],
  };
  for (const [name, modifiers] of Object.entries(accepts)) {
    const argv = [name, ...(TAKES_VALUE.has(name) ? ["v"] : []), ...modifiers];
    assert.doesNotThrow(() => selectSubcommand(argv), name);
  }
  // --profile belongs to two subcommands only.
  assert.throws(() => selectSubcommand(["--lessons", "audit", "--profile", "lean"]), /unrecognised flag --profile/);
  assert.throws(() => selectSubcommand(["--plan", "--profile", "lean"]), /unrecognised flag --profile/);
});

test("value flags must be non-empty, except --match's lists, which may be empty", () => {
  assert.throws(() => selectSubcommand(["--check-recurrence", "--profile", ""]), /^Error: --profile requires a value$/);
  assert.throws(() => selectSubcommand(["--lessons", " "]), /^Error: --lessons requires a value$/);
  assert.deepEqual(selectSubcommand(["--match", "--stage", "execution", "--files", ""]).flags,
    { "--match": true, "--stage": "execution", "--files": "" });
  assert.throws(() => selectSubcommand(["--match", "--stage", "execution", "--files"]), /^Error: --files requires a value$/);
});

// Every dream.mjs invocation the shipped prose documents, replayed through the parse: a flag map
// that drifted from what the playbooks tell the model to type would refuse a real call. Inline code
// spans and fenced lines are both read. A placeholder (`<stage>`) becomes a value, an optional group
// (`[--store repo|user-repo]`) its first form, and `"$(cat <file>)"` a JSON stand-in.
function documentedInvocations() {
  const files = ["playbooks", "references", "commands", "agents"].flatMap((d) =>
    readdirSync(join(REPO_ROOT, d)).filter((f) => f.endsWith(".md")).map((f) => join(d, f)));
  const found = [];
  for (const file of files) {
    const fenced = [];
    const prose = read(file).replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_, body) => {
      fenced.push(...body.replace(/\\\n\s*/g, " ").split("\n"));
      return "";
    });
    for (const raw of [...fenced, ...[...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1])]) {
      const span = raw.replace(/\s+/g, " ").trim();
      // An elided call (`--match … --files`) is prose about a call, not one.
      if (span.includes("…")) continue;
      const at = span.search(/dream\.mjs"? --/);
      const cmd = at !== -1 ? span.slice(span.indexOf("--", at))
        : SUBCOMMANDS.includes(span.split(" ")[0]) ? span : null;
      if (!cmd) continue;
      const argv = [...cmd
        .replace(/"\$\(cat <[^>]*>\)"/g, "{}")
        .replace(/<[^>]*>/g, "x")
        .replace(/\[([^\]]*)\]/g, "$1")
        .split(/ (?:>|&&|\|\||;) /)[0]
        .matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2].split("|")[0]);
      // A lone value-taking subcommand (`--check-observations` named in a sentence) is a mention
      // by name; its calls appear elsewhere with their argument.
      if (argv.length === 1 && TAKES_VALUE.has(argv[0])) continue;
      found.push({ file, span, argv });
    }
  }
  return found;
}

test("every documented dream.mjs invocation parses", () => {
  const found = documentedInvocations();
  for (const { file, span, argv } of found)
    assert.doesNotThrow(() => assert.ok(selectSubcommand(argv)), `${file}: \`${span}\``);
  // Not vacuous: the prose documents every subcommand, including --check-recurrence's --profile,
  // which the usage string used to omit.
  assert.deepEqual([...new Set(found.map((f) => selectSubcommand(f.argv).name))].sort(), [...SUBCOMMANDS].sort());
  assert.ok(found.some(({ argv }) => argv[0] === "--check-recurrence" && argv.includes("--profile")));
  assert.ok(found.length >= 38, `expected the full set of documented calls, got ${found.length}`);
});
