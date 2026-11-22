import { test } from "node:test";
import assert from "node:assert/strict";
import { SCANNERS } from "../../scripts/hygiene-scanners.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";

const scan = (id, files) => SCANNERS.find((s) => s.id === id).scan({ files: Object.keys(files), read: (f) => files[f] ?? null });
const brief = (found) => found.map((c) => [c.file, c.line, c.symbol, c.cleared ?? null]);

test("every registry scanner has exactly one implementation, and each candidate kind is the registry's", () => {
  const reg = loadRegistry();
  assert.deepEqual(SCANNERS.map((s) => s.id).sort(), Object.keys(reg.scanners).sort());
  const found = scan("css-custom-properties", { "a.css": ":root { --x: 1px; }\n" });
  assert.deepEqual(found.map((c) => c.kind), reg.scanners["css-custom-properties"].kinds);
});

test("css-custom-properties flags a declared property that var() never reads and code never names", () => {
  const files = {
    "a.css": ":root {\n  --used: 1px;\n  --unused: 2px;\n  --set-from-js: 0;\n}\n.x { margin: var(--used); }\n",
    "b.js": "el.style.setProperty('--set-from-js', '1');\n",
  };
  assert.deepEqual(brief(scan("css-custom-properties", files)), [["a.css", 3, "--unused", null]]);
});

test("css-classes-keyframes flags unused classes and keyframes, ignoring comments, numbers and declarations", () => {
  const files = {
    "s.css": "/* .commented { } */\n.used, .dead { color: red; }\n@media (min-width: 40.5em) {\n  .wide { a: b; }\n}\n"
      + "@keyframes spin { from { a: b; } }\n@keyframes idle { from { a: b; } }\n.anim { animation: spin 1s; }\n",
    "i.html": "<div class=\"used wide anim\"></div>\n",
  };
  assert.deepEqual(brief(scan("css-classes-keyframes", files)), [["s.css", 2, ".dead", null], ["s.css", 7, "@keyframes idle", null]]);
});

test("css-classes-keyframes pre-clears every class under a template-literal prefix", () => {
  const files = { "s.css": ".btn-primary { a: b; }\n.card-dead { a: b; }\n", "c.ts": "const cls = (v) => `btn-${v}`;\n" };
  assert.deepEqual(brief(scan("css-classes-keyframes", files)), [["s.css", 1, ".btn-primary", "dynamic prefix"], ["s.css", 2, ".card-dead", null]]);
});

test("angular-io flags inputs and outputs bound in no template, in decorator and signal forms", () => {
  const files = {
    "a.component.ts": "export class A {\n  @Input() bound = '';\n  @Input('aliased') local = '';\n  @Output() changed = new E();\n"
      + "  @Input() dead = '';\n  sig = input<string>();\n  req = input.required<number>();\n  out = output();\n}\n",
    "b.component.ts": "@Component({ template: `<app-a [sig]=\"x\" (out)=\"y()\"></app-a>` })\nexport class B {}\n",
    "a.html": "<app-a [bound]=\"v\" [aliased]=\"w\" (changed)=\"z()\"></app-a>\n",
  };
  assert.deepEqual(brief(scan("angular-io", files)), [["a.component.ts", 5, "dead", null], ["a.component.ts", 7, "req", null]]);
});

test("angular-io pre-clears the inputs of a component a route config names", () => {
  const files = {
    "r.component.ts": "export class RoutedComponent {\n  @Input() id = '';\n}\n",
    "l.component.ts": "export class LazyComponent {\n  slug = input('');\n}\n",
    "app.routes.ts": "export const routes = [{ path: 'a/:id', component: RoutedComponent },\n"
      + "  { path: 'b', loadComponent: () => import('./l.component').then((m) => m.LazyComponent) }];\n",
  };
  assert.deepEqual(brief(scan("angular-io", files)), [["l.component.ts", 2, "slug", "routed component"], ["r.component.ts", 2, "id", "routed component"]]);
});

test("static-assets flags an asset no tracked file names, file-level, and clears browser-fetched names", () => {
  const files = {
    "public/logo.png": null, "public/old-hero.jpg": null, "public/favicon.ico": null, "src/assets/fonts/x.woff2": null,
    "src/notes.png": null, "src/app.css": "@font-face { src: url(./assets/fonts/x.woff2); }\n", "src/i.html": "<img src=\"/logo.png\">\n",
  };
  assert.deepEqual(brief(scan("static-assets", files)), [["public/favicon.ico", null, null, "browser-fetched by convention"], ["public/old-hero.jpg", null, null, null]]);
});
