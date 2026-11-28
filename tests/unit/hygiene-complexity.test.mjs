import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { HOT_KIND, WATCH_KIND, readThresholds, scoreFiles, stackOf } from "../../scripts/hygiene-complexity.mjs";
import { ADAPTERS } from "../../scripts/hygiene-adapters.mjs";

const METRIC_NAMES = ["ccn", "cognitive", "nesting", "params", "nloc", "fileLines"];
const def = (value, source) => ({ value, source, url: "https://example.test/" });
function testRegistry() {
  const reg = structuredClone(loadRegistry());
  const js = { ccn: def(20, "ESLint complexity"), cognitive: def(15, "SonarJS cognitive-complexity"), nesting: def(4, "ESLint max-depth"),
    params: def(3, "ESLint max-params"), nloc: def(50, "ESLint max-lines-per-function"), fileLines: def(300, "ESLint max-lines") };
  reg.complexity = {
    defaults: { "js-ts": js, python: { ...js, ccn: def(10, "ruff mccabe max-complexity") }, go: { ...js, ccn: def(30, "golangci-lint gocyclo") },
      other: { ...js, ccn: def(15, "lizard CCN") } },
    configKeys: {
      eslint: { stack: "js-ts", files: "eslint-row", keys: { complexity: "ccn", "max-depth": "nesting", "max-params": "params", "max-lines": "fileLines" } },
      python: { stack: "python", files: ["pyproject.toml", "setup.cfg"], keys: { "max-complexity": "ccn" } },
      go: { stack: "go", files: [".golangci.yml", ".golangci.toml"], keys: { "gocyclo.min-complexity": "ccn", "funlen.lines": "nloc" } },
    },
  };
  return reg;
}
const reader = (texts) => (rel) => texts[rel] ?? null;
const run = (invocationId, stdout, status = 0) => ({ invocationId, status, stdout, stderr: "", error: null });

test("stackOf maps a file's extension to its stack", () => {
  assert.deepEqual(["a.mjs", "b.tsx", "c.vue", "d.py", "e.go", "f.rs", "g.cs", "h.rb"].map(stackOf),
    ["js-ts", "js-ts", "js-ts", "python", "go", "rust", "dotnet", "other"]);
});

test("readThresholds starts from the registry defaults and reads root linter config statically", () => {
  const texts = {
    "eslint.config.js": 'export default [{ rules: { complexity: ["error", 12], "max-lines": ["warn", { max: 400, skipComments: true }],\n' +
      '  "max-depth": "off", "max-params": ["error", LIMIT] } }];\n',
    "setup.cfg": "[flake8]\nmax-complexity = 8\n",
  };
  const { byStack, notes } = readThresholds({ files: ["eslint.config.js", "setup.cfg", "pkg/.golangci.yml", "src/a.js"],
    read: reader(texts), registry: testRegistry(), stacks: ["js-ts", "python", "rust"] });
  assert.deepEqual(Object.keys(byStack), ["js-ts", "python", "other"]);
  assert.deepEqual(byStack["js-ts"].ccn, { value: 12, source: "eslint.config.js complexity" });
  assert.deepEqual(byStack["js-ts"].fileLines, { value: 400, source: "eslint.config.js max-lines" });
  assert.deepEqual(byStack["js-ts"].nesting, { value: 4, source: "ESLint max-depth" });
  assert.deepEqual(byStack["js-ts"].params, { value: 3, source: "ESLint max-params" });
  assert.deepEqual(byStack.python.ccn, { value: 8, source: "setup.cfg max-complexity" });
  assert.deepEqual(byStack.other.ccn, { value: 15, source: "lizard CCN" });
  assert.deepEqual(notes.sort(), [
    "eslint.config.js max-depth: off; default kept",
    "eslint.config.js max-params: not read statically; default kept",
  ]);
});

test("readThresholds reads golangci yaml, names a nested config and skips toml", () => {
  const texts = { ".golangci.yml": "linters:\n  settings:\n    gocyclo:\n      min-complexity: 25\n    funlen:\n      lines: 80\n",
    ".golangci.toml": "[linters.settings.gocyclo]\nmin-complexity = 5\n" };
  const { byStack, notes } = readThresholds({ files: [".golangci.yml", ".golangci.toml", "svc/setup.cfg"], read: reader(texts),
    registry: testRegistry(), stacks: ["go", "python"] });
  assert.deepEqual(byStack.go.ccn, { value: 25, source: ".golangci.yml gocyclo.min-complexity" });
  assert.deepEqual(byStack.go.nloc, { value: 80, source: ".golangci.yml funlen.lines" });
  assert.deepEqual(notes.sort(), [".golangci.toml: not read statically (yaml only); defaults kept", "svc/setup.cfg: not read (root only)"]);
});

const T = Object.fromEntries(METRIC_NAMES.map((m) => [m, { value: { ccn: 5, cognitive: 4, nesting: 3, params: 3, nloc: 20, fileLines: 30 }[m], source: `S ${m}` }]));
const fn = (file, name, line, ccn, cognitive, nesting = 0, params = 1, nloc = 5) => ({ file, name, line, ccn, cognitive, nloc, params, nesting });

test("scoreFiles drops excluded files, scores over-threshold functions and long files, and splits hot from watch", () => {
  const rows = [
    fn("src/hot.js", "big", 1, 9, 12, 4), fn("src/hot.js", "ok", 20, 1, 0),
    fn("src/stable.js", "deep", 3, 6, 5),
    fn("src/long.js", "tiny", 1, 1, 0),
    fn("gen/client.js", "huge", 1, 90, 90), fn("vendor/x.js", "v", 1, 90, 90), fn("untracked.js", "u", 1, 90, 90),
    { file: "src/py.py", name: "f", line: 1, ccn: 7, cognitive: null, nloc: null, params: null, nesting: null },
  ];
  const texts = { "src/hot.js": "a\nb\nc\n", "src/stable.js": "a\n", "src/long.js": "line\n".repeat(40), "src/py.py": "x\n",
    "gen/client.js": "// @generated by a tool\nexport const x = 1;\n", "vendor/x.js": "v\n" };
  const { candidates, excluded } = scoreFiles(rows, {
    thresholds: { byStack: { "js-ts": T, other: T } }, churn: new Map([["src/hot.js", 5], ["src/long.js", 3]]),
    lines: new Map([["src/hot.js", 120]]), hotCommits: 3, files: Object.keys(texts), read: reader(texts), attributes: [], stackOf });
  assert.deepEqual(excluded, { lockfile: 0, generated: 1, vendored: 1, "test-fixture": 0 });
  assert.deepEqual(candidates.map((c) => [c.file, c.kind, c.score]), [
    ["src/hot.js", HOT_KIND, 12], ["src/long.js", HOT_KIND, 10], ["src/py.py", WATCH_KIND, 7], ["src/stable.js", WATCH_KIND, 5],
  ]);
  const hot = candidates[0];
  assert.deepEqual({ ...hot, evidence: undefined, detail: undefined },
    { kind: HOT_KIND, file: "src/hot.js", line: null, symbol: null, clusterKey: "src/hot.js", anchor: "src/hot.js", score: 12,
      detail: undefined, evidence: undefined, noisy: false });
  assert.equal(hot.detail, "1 of 2 functions over threshold, 3 lines; score 12");
  assert.deepEqual(hot.evidence, [
    "`big` L1: ccn 9 > 5 (S ccn), cognitive 12 > 4 (S cognitive), nesting 4 > 3 (S nesting)",
    "churn: 5 commits, 120 lines",
  ]);
  assert.deepEqual(candidates[1].evidence, ["file: fileLines 40 > 30 (S fileLines)", "churn: 3 commits, 0 lines"]);
  assert.deepEqual(candidates[2].evidence, ["`f` L1: ccn 7 > 5 (S ccn)", "churn: 0 commits, 0 lines"], "an unmeasured metric is never over");
});

const cxCtx = (over = {}) => ({ tool: { id: over.toolId ?? "lizard", kinds: ["complexity-hotspot", "complexity-watch"] }, mode: "static",
  repoRoot: "/r", files: ["src/a.js", "src/m.py", "src/bad.py"], read: () => "x\n", registry: testRegistry(), stacks: ["js-ts", "python"],
  churn: new Map([["src/a.js", 4]]), lines: new Map([["src/a.js", 90]]), config: { hotCommits: 3 }, scratch: "/s", anchorFiles: [], ...over });
const LIZARD_CSV = [
  '60,25,300,4,70,"hot@1-70@./src/a.js","./src/a.js","hot","hot ( a , b , c , d )",1,70,30,5',
  '1,1,8,1,1,"small@72-72@./src/a.js","./src/a.js","small","small ( x )",72,72,0,0',
  '4,2,14,2,4,"f@1-4@./src/m.py","./src/m.py","f","f( a , b )",1,4,1,1',
].join("\n") + "\n";

test("lizard: CSV rows become one scored candidate per file over its stack's thresholds", () => {
  const result = ADAPTERS.lizard.normalize([run("main", LIZARD_CSV)], cxCtx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map((c) => [c.file, c.kind, c.score]), [["src/a.js", "complexity-hotspot", 30]]);
  assert.equal(result.candidates[0].evidence[0], "`hot` L1: ccn 25 > 20 (ESLint complexity), cognitive 30 > 15 (SonarJS cognitive-complexity), " +
    "nesting 5 > 4 (ESLint max-depth), params 4 > 3 (ESLint max-params), nloc 60 > 50 (ESLint max-lines-per-function)");
  assert.ok(result.coverage.includes("lizard skips a file byte-identical to one it already read (MD5), so a copied file is measured once"));
  assert.deepEqual(ADAPTERS.lizard.normalize([run("main", "")], cxCtx()).candidates, []);
  const bad = ADAPTERS.lizard.normalize([run("main", "Traceback (most recent call last):\n")], cxCtx());
  assert.deepEqual([bad.ok, bad.note], [false, "lizard output held no CSV rows: Traceback (most recent call last):"]);
});

test("radon: methods dedupe by line, CCN is the only metric, and parse errors are named", () => {
  const method = { type: "method", name: "run", classname: "K", lineno: 2, endline: 19, complexity: 13 };
  const stdout = JSON.stringify({
    "src/m.py": [{ type: "class", name: "K", lineno: 1, endline: 20, complexity: 14, methods: [method] }, method,
      { type: "function", name: "f", lineno: 22, endline: 25, complexity: 2 }],
    "src/bad.py": { error: "invalid syntax" },
  });
  const result = ADAPTERS.radon.normalize([run("main", stdout)], cxCtx({ toolId: "radon", stacks: ["python"] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map((c) => [c.file, c.kind, c.score]), [["src/m.py", "complexity-watch", 13]]);
  assert.deepEqual(result.candidates[0].evidence, ["`K.run` L2: ccn 13 > 10 (ruff mccabe max-complexity)", "churn: 0 commits, 0 lines"]);
  assert.ok(result.coverage.includes("radon could not parse src/bad.py: invalid syntax"));
  assert.ok(result.coverage.includes("radon measures CCN only; cognitive, nesting, params and nloc not measured"));
  const bad = ADAPTERS.radon.normalize([run("main", "not json")], cxCtx({ toolId: "radon" }));
  assert.deepEqual([bad.ok, bad.note], [false, "radon output is not JSON: not json"]);
});

test("the complexity adapters count excluded files in their coverage notes", () => {
  const csv = '90,40,9,1,90,"g@1-90@./dist/app.js","./dist/app.js","g","g ( )",1,90,40,1\n';
  const result = ADAPTERS.lizard.normalize([run("main", csv)], cxCtx({ files: ["dist/app.js"] }));
  assert.deepEqual(result.candidates, []);
  assert.ok(result.coverage.includes("excluded before measurement: generated 1"));
});
