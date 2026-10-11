// scripts/context-report.mjs: per-entry-point closures, and the over-demotion worklist since a ref.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, commitAll, writeInto } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/context-report.mjs", import.meta.url));
const P = "${CLAUDE_PLUGIN_ROOT}";
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

const seed = (dir) => {
  writeInto(dir, "commands/go.md", `Follow \`${P}/playbooks/a.md\`.\n`);
  writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`; \`${P}/references/y.md\` owns the rest.\n`);
  writeInto(dir, "references/x.md", "x words here\n");
  writeInto(dir, "references/y.md", "y words\n");
};

test("--json reports both closures for every command and playbook", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    const r = run(dir, "--json");
    assert.equal(r.status, 0, r.stderr);
    const { entries } = JSON.parse(r.stdout);
    const go = entries.find((e) => e.file === "commands/go.md");
    assert.deepEqual([go.refsOnly.files, go.allHops.files], [1, 4]);
    const a = entries.find((e) => e.file === "playbooks/a.md");
    assert.equal(a.refsOnly.files, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff lists each citation that lost its prefix, with its bare lines, and each file that left a closure", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`.\n\n\`references/y.md\` owns the rest.\n`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    const { diff } = JSON.parse(r.stdout);
    assert.deepEqual(diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/y.md", beforeLine: 1, line: 3 }]);
    const a = diff.dropped.find((d) => d.file === "playbooks/a.md");
    assert.deepEqual(a.refsOnly, ["references/y.md"]);
    assert.deepEqual(a.allHops, ["references/y.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff lists a demotion even when a new prefixed read of the same target offsets the count", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`.\n\nThen \`${P}/references/y.md\` applies.\n`);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Read \`references/x.md\`.\n\nThen \`${P}/references/y.md\` applies.\n\nAlso \`${P}/references/x.md\` here.\n`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/x.md", beforeLine: 1, line: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff lists a demotion on a reworded line even when a new prefixed read of the same target offsets it", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\` first.\n\nThen \`${P}/references/y.md\` applies.\n`);
    commitAll(dir, "seed");
    writeInto(
      dir,
      "playbooks/a.md",
      `Read \`references/x.md\` before anything else.\n\nThen \`${P}/references/y.md\` applies.\n\nAlso \`${P}/references/x.md\` here.\n`
    );
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/x.md", beforeLine: 1, line: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff lists one of two citations of a target losing its prefix, and not a reworded line that kept it", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/a.md", `A \`${P}/references/y.md\`.\n\nB \`${P}/references/y.md\`.\n\nRead \`${P}/references/x.md\` first.\n`);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `A \`${P}/references/y.md\`.\n\nB \`references/y.md\`.\n\nRead \`${P}/references/x.md\` before anything else.\n`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/y.md", beforeLine: 3, line: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff does not list a prefixed read converted to a section read of the same reference", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "references/a.md", "## One\n\na words\n");
    writeInto(dir, "playbooks/a.md", `read \`${P}/references/a.md\` here\n`);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `run \`node "${P}/scripts/read-section.mjs" references/a.md one\` here\n`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff does not list a whole read converted to section reads when a reworded bare mention is the closer match", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "references/a.md", "## One\n\na words\n\n## Two\n\nmore\n");
    writeInto(dir, "playbooks/a.md", `Then read \`${P}/references/a.md\` and produce the class proof.\n`);
    commitAll(dir, "seed");
    writeInto(
      dir,
      "playbooks/a.md",
      `Then run \`node "${P}/scripts/read-section.mjs" references/a.md one\`,\n\n` +
        `then \`node "${P}/scripts/read-section.mjs"\nreferences/a.md two\`.\n\n` +
        "The class proof is what `references/a.md` makes and you produce.\n"
    );
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff never counts a section read's reference as a bare mention a lost citation lands on", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "references/a.md", "## One\n\na words\n");
    const sectionRead = `Run \`node "${P}/scripts/read-section.mjs" references/a.md one\` here.\n`;
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/a.md\` first.\n\n${sectionRead}`);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Nothing to read first.\n\n${sectionRead}`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/a.md", beforeLine: 1, line: null }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a section read wrapped across a line break counts its section in the closure", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "references/a.md", "## One\n\na words\n\n## Two\n\nnot read\n");
    writeInto(dir, "playbooks/b.md", `Run \`node "${P}/scripts/read-section.mjs"\n  references/a.md one\` first.\n`);
    const r = run(dir, "--json");
    assert.equal(r.status, 0, r.stderr);
    const b = JSON.parse(r.stdout).entries.find((e) => e.file === "playbooks/b.md");
    assert.equal(b.refsOnly.files, 2);
    assert.equal(b.refsOnly.bytes, Buffer.byteLength(`Run \`node "${P}/scripts/read-section.mjs"\n  references/a.md one\` first.\n`) + Buffer.byteLength("## One\n\na words\n\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text output names the totals and the diff sections", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`.\n`);
    const r = run(dir, "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /playbooks\/a\.md {2}refs-only: 2 files \/ \d+ words \/ \d+ bytes {3}all-hops: 2 files \/ \d+ words/);
    assert.match(r.stdout, /lost prefixes since HEAD:\n {2}playbooks\/a\.md:1 {2}references\/y\.md {2}removed\n/);
    assert.match(r.stdout, /dropped from closures since HEAD:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff gives each entry point's refs-only byte delta, and null for one new since the ref", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/b.md", `Read \`${P}/references/z.md\`.\n`);
    writeInto(dir, "references/z.md", "z words\n");
    commitAll(dir, "seed");
    writeInto(dir, "references/x.md", "x words here\nand twelve more\n");
    writeInto(dir, "playbooks/c.md", "A new playbook.\n");
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    const { entries, diff } = JSON.parse(r.stdout);
    assert.deepEqual(
      diff.deltas?.map((d) => d.file),
      ["commands/go.md", "playbooks/a.md", "playbooks/b.md", "playbooks/c.md"]
    );
    const byFile = Object.fromEntries(diff.deltas.map((d) => [d.file, d]));
    const after = (file) => entries.find((e) => e.file === file).refsOnly.bytes;
    assert.deepEqual(byFile["playbooks/a.md"], {
      file: "playbooks/a.md",
      before: after("playbooks/a.md") - 16,
      after: after("playbooks/a.md"),
      delta: 16,
    });
    assert.equal(byFile["playbooks/b.md"].delta, 0);
    assert.equal(byFile["commands/go.md"].delta, 0);
    assert.deepEqual(byFile["playbooks/c.md"], { file: "playbooks/c.md", before: null, after: after("playbooks/c.md"), delta: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff --markdown prints a table of only the entry points whose closure changed", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/b.md", `Read \`${P}/references/z.md\`.\n`);
    writeInto(dir, "references/z.md", "z words\n");
    commitAll(dir, "seed");
    const unchanged = run(dir, "--diff", "HEAD", "--markdown");
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, "No entry point's closure changed.\n");
    writeInto(dir, "references/x.md", "x words here\nand twelve more\n");
    const r = run(dir, "--diff", "HEAD", "--markdown");
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], "| entry point | before (B) | after (B) | delta (B) |");
    assert.match(lines[1], /^\|[-:| ]+\|$/);
    assert.equal(lines.length, 3, r.stdout);
    assert.match(lines[2], /^\| playbooks\/a\.md \| \d+ \| \d+ \| \+16 \|$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff gives an entry point deleted since the ref a null after and a negative delta, and --markdown a deleted row", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    writeInto(dir, "playbooks/b.md", `Read \`${P}/references/z.md\`.\n`);
    writeInto(dir, "references/z.md", "z words\n");
    commitAll(dir, "seed");
    rmSync(join(dir, "playbooks/b.md"));
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    const { diff } = JSON.parse(r.stdout);
    assert.deepEqual(diff.deltas.map((d) => d.file), ["commands/go.md", "playbooks/a.md", "playbooks/b.md"]);
    const was = Buffer.byteLength(`Read \`${P}/references/z.md\`.\n`) + Buffer.byteLength("z words\n");
    assert.deepEqual(diff.deltas[2], { file: "playbooks/b.md", before: was, after: null, delta: -was });
    const md = run(dir, "--diff", "HEAD", "--markdown");
    assert.equal(md.status, 0, md.stderr);
    assert.equal(md.stdout.trimEnd().split("\n")[2], `| playbooks/b.md | ${was} | deleted | -${was} |`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--markdown without --diff is a usage error", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    const r = run(dir, "--markdown");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /context-report: --markdown needs --diff <git-ref>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown ref, or --diff with no value, is a usage error", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    const bad = run(dir, "--diff", "no-such-ref");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /context-report: .*no-such-ref/);
    const empty = run(dir, "--diff");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /--diff requires a git ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
