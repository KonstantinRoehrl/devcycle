import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateConstants, scatteredEnvReads } from "../../scripts/hygiene-scanners-duplication.mjs";

const scan = (scanner, tree) => scanner.scan({ files: Object.keys(tree), read: (f) => tree[f] ?? null });
const brief = (c) => `${c.kind}|${c.file}|${c.line}|${c.symbol}|${c.clusterKey}|${c.cleared ?? null}`;
const of = (found, kind) => found.filter((c) => c.kind === kind).map(brief).sort();

test("one name and value declared in two or more files is one duplicate-constant group", () => {
  const found = scan(duplicateConstants, {
    "src/a.ts": "export const MAX_RETRIES = 12;\n",
    "src/b.ts": "const MAX_RETRIES: number = 12;\n",
    "lib/c.py": "MAX_RETRIES = 12\n",
    "src/d.ts": "export const MAX_RETRIES = 13;\n",
  });
  assert.deepEqual(of(found, "duplicate-constant"), [
    "duplicate-constant|lib/c.py|1|MAX_RETRIES|constant MAX_RETRIES=12|null",
    "duplicate-constant|src/a.ts|1|MAX_RETRIES|constant MAX_RETRIES=12|null",
    "duplicate-constant|src/b.ts|1|MAX_RETRIES|constant MAX_RETRIES=12|null",
  ]);
  assert.ok(found.every((c) => c.anchor === c.clusterKey));
});

test("declarations are read from every parsed stack, and values normalize", () => {
  const found = scan(duplicateConstants, {
    "a.ts": "export const TIMEOUT_MS = 30_000;\nenum Status { Gone = 410 }\n",
    "b.go": "package x\n\nconst (\n\tTIMEOUT_MS = 30000\n)\n",
    "c.rs": "pub const TIMEOUT_MS: u64 = 30000;\n",
    "d.cs": "class C { public const int TIMEOUT_MS = 30000; }\n",
    "e.ts": "export enum Status { Gone = 410 }\n",
    "x.css": ":root { --brand: #3366FF; }\n",
    "y.scss": ".a { --brand: #3366ff; }\n",
  });
  assert.deepEqual(of(found, "duplicate-constant").map((b) => b.split("|").slice(1, 5).join("|")), [
    "a.ts|1|TIMEOUT_MS|constant TIMEOUT_MS=30000",
    "a.ts|2|Status.Gone|constant Status.Gone=410",
    "b.go|4|TIMEOUT_MS|constant TIMEOUT_MS=30000",
    "c.rs|1|TIMEOUT_MS|constant TIMEOUT_MS=30000",
    "d.cs|1|TIMEOUT_MS|constant TIMEOUT_MS=30000",
    "e.ts|1|Status.Gone|constant Status.Gone=410",
    "x.css|1|--brand|constant --brand=#3366ff",
    "y.scss|1|--brand|constant --brand=#3366ff",
  ]);
});

test("trivial values are never candidates of any kind", () => {
  const body = "export const SMALL = 5;\nexport const HALF = 0.5;\nexport const FLAG = true;\nexport const NONE = null;\nexport const SHORT = \"ab\";\n";
  assert.deepEqual(scan(duplicateConstants, { "a.ts": body, "b.ts": body, "c.ts": "f(5, 0.5, true, null, \"ab\");\n" }), []);
});

test("a shared value is a missing owner only when the names share a word token", () => {
  const found = scan(duplicateConstants, {
    "src/a.ts": "const PAGE_SIZE = 25;\n",
    "src/b.ts": "const defaultPageSize = 25;\n",
    "src/c.ts": "const FULL_PERCENT = 100;\n",
    "src/d.ts": "const MAX_PAGE_ITEMS = 100;\n",
  });
  assert.deepEqual(of(found, "missing-owner"), [
    "missing-owner|src/a.ts|1|PAGE_SIZE|value 25|null",
    "missing-owner|src/b.ts|1|defaultPageSize|value 25|null",
  ]);
  assert.deepEqual(found.filter((c) => c.clusterKey === "value 100"), [], "unrelated names with an equal value are no candidate");
});

test("a literal restating an exported owner's value in another file names that owner", () => {
  const found = scan(duplicateConstants, {
    "src/limits.ts": "export const BRAND_TIMEOUT_MS = 30000;\nexport const API_PATH = \"/v2/items\";\nsetTimeout(f, 30000);\n",
    "src/fetcher.ts": "setTimeout(done, 30000);\n// waits 30000 ms\nconst local = 30000;\n",
    "src/route.js": "fetch('/v2/items');\n",
    "src/theme.css": ":root { --brand-color: #3366FF; }\n",
    "src/banner.tsx": "el.style.color = \"#3366ff\";\n",
  });
  assert.deepEqual(of(found, "restated-literal"), [
    "restated-literal|src/banner.tsx|1|--brand-color|src/theme.css#--brand-color|null",
    "restated-literal|src/fetcher.ts|1|BRAND_TIMEOUT_MS|src/limits.ts#BRAND_TIMEOUT_MS|null",
    "restated-literal|src/route.js|1|API_PATH|src/limits.ts#API_PATH|null",
  ]);
});

test("a documented deliberate copy is cleared, and so is the rest of its group once fewer than two remain", () => {
  const owner = "export const PAGE_SIZE = 25;\n";
  const shim = "// deliberate copy: keeps the shim dependency-free (see src/limits.ts)\nexport const PAGE_SIZE = 25;\n";
  const pair = scan(duplicateConstants, { "src/limits.ts": owner, "src/vendor-shim.ts": shim });
  assert.deepEqual(of(pair, "duplicate-constant"), [
    "duplicate-constant|src/limits.ts|1|PAGE_SIZE|constant PAGE_SIZE=25|documented deliberate copy",
    "duplicate-constant|src/vendor-shim.ts|2|PAGE_SIZE|constant PAGE_SIZE=25|documented deliberate copy",
  ]);
  const three = scan(duplicateConstants, { "src/limits.ts": owner, "src/vendor-shim.ts": shim,
    "src/other.ts": "export const PAGE_SIZE = 25; // Keep in sync with limits\n", "src/more.ts": owner });
  assert.deepEqual(of(three, "duplicate-constant").map((b) => b.split("|")[5]), [
    "null", "null", "documented deliberate copy", "documented deliberate copy"]);
});

test("one env var read directly in three or more files is one candidate per read", () => {
  const found = scan(scatteredEnvReads, {
    "src/a.ts": "const u = process.env.API_BASE_URL;\nconst v = process.env.API_BASE_URL;\n",
    "src/b.ts": "const u = process.env['API_BASE_URL'];\n",
    "app/c.py": "u = os.environ.get(\"API_BASE_URL\")\n",
    "svc/d.go": "u := os.Getenv(\"TOKEN\")\n",
    "svc/e.go": "t := os.Getenv(\"TOKEN\")\n",
  });
  assert.deepEqual(found.map(brief), [
    "scattered-env-read|app/c.py|1|API_BASE_URL|env API_BASE_URL|null",
    "scattered-env-read|src/a.ts|1|API_BASE_URL|env API_BASE_URL|null",
    "scattered-env-read|src/a.ts|2|API_BASE_URL|env API_BASE_URL|null",
    "scattered-env-read|src/b.ts|1|API_BASE_URL|env API_BASE_URL|null",
  ]);
  const forms = scan(scatteredEnvReads, {
    "a.py": "x = os.environ[\"KEY\"]\ny = os.getenv('KEY')\n",
    "b.rs": "let k = std::env::var(\"KEY\");\n",
    "c.cs": "var k = Environment.GetEnvironmentVariable(\"KEY\");\n",
  });
  assert.equal(forms.length, 4);
});

test("the restated-literal floor is higher than the declaration floor: a bare number under 100 and a short or plain-word string restate nothing", () => {
  const owners = [
    "export const PAGE_LIMIT = 40;\n",
    "export const PHASE_LABEL = \"pending\";\n",
    "export const SHORT_KEY = \"ab-cd\";\n",
    "export const WIDE_LIMIT = 250;\n",
    "export const LONG_KEY = \"audit-trail\";\n",
  ].join("");
  const sites = "f(40, \"pending\", \"ab-cd\", 250, \"audit-trail\");\n";
  assert.deepEqual(of(scan(duplicateConstants, { "src/owners.ts": owners, "src/site.ts": sites }), "restated-literal"), [
    "restated-literal|src/site.ts|1|LONG_KEY|src/owners.ts#LONG_KEY|null",
    "restated-literal|src/site.ts|1|WIDE_LIMIT|src/owners.ts#WIDE_LIMIT|null",
  ]);
});

test("the declaration floor is unchanged: a two-digit constant is still a duplicate-constant", () => {
  const found = scan(duplicateConstants, { "a.ts": "export const PAGE_LIMIT = 40;\n", "b.ts": "export const PAGE_LIMIT = 40;\n" });
  assert.deepEqual(of(found, "duplicate-constant"), [
    "duplicate-constant|a.ts|1|PAGE_LIMIT|constant PAGE_LIMIT=40|null",
    "duplicate-constant|b.ts|1|PAGE_LIMIT|constant PAGE_LIMIT=40|null",
  ]);
});

test("a CSS custom property holding a pixel length is an owner that a string or template literal restates", () => {
  const found = scan(duplicateConstants, {
    "src/theme.css": ":root { --gap: 16px; --pad: 24.0px; --hair: 2px; --wide: 40rem; --lead: 1.5rem; }\n",
    "src/view.ts": "el.style.gap = \"16px\";\nel.style.padding = `24px`;\nel.style.border = \"2px\";\nel.style.margin = '40rem'; el.style.lineHeight = \"1.5rem\";\n",
    "src/page.html": "<div data-pad=\"24px\"></div>\n",
  });
  assert.deepEqual(of(found, "restated-literal"), [
    "restated-literal|src/page.html|1|--pad|src/theme.css#--pad|null",
    "restated-literal|src/view.ts|1|--gap|src/theme.css#--gap|null",
    "restated-literal|src/view.ts|2|--pad|src/theme.css#--pad|null",
    "restated-literal|src/view.ts|4|--wide|src/theme.css#--wide|null",
  ]);
});

test("a pixel length is not restated by another unit, by a sentence, or when it is a small length", () => {
  const found = scan(duplicateConstants, {
    "src/theme.css": ":root { --gap: 16px; --tick: 8px; }\n",
    "src/view.ts": "a(\"16em\"); b(\"keep a 16px gap between rows\"); c(\"8px\"); d(\"16 px\"); e(16);\n",
  });
  assert.deepEqual(found, []);
});

test("a pixel length declared in two stylesheets under one name is a duplicate-constant", () => {
  const found = scan(duplicateConstants, { "a.css": ":root { --gap: 16px; }\n", "b.css": ":root { --gap: 16px; }\n" });
  assert.deepEqual(of(found, "duplicate-constant"), [
    "duplicate-constant|a.css|1|--gap|constant --gap=16px|null",
    "duplicate-constant|b.css|1|--gap|constant --gap=16px|null",
  ]);
});

test("a scanner reads only the extensions whose declarations it parses, though it still scans markup files for restated literals", () => {
  for (const ext of [".vue", ".svelte", ".html"]) assert.ok(!duplicateConstants.reads.includes(ext), `${ext} is not a declaration-read language`);
  for (const ext of [".ts", ".py", ".css"]) assert.ok(duplicateConstants.reads.includes(ext), `${ext} declarations are parsed`);
  const found = scan(duplicateConstants, {
    "src/limits.ts": "export const BRAND_TIMEOUT_MS = 30000;\n",
    "src/Panel.vue": "<script>\nsetTimeout(done, 30000);\n</script>\n",
  });
  assert.deepEqual(of(found, "restated-literal"), ["restated-literal|src/Panel.vue|2|BRAND_TIMEOUT_MS|src/limits.ts#BRAND_TIMEOUT_MS|null"]);
});
