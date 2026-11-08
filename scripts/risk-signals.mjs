// The built-in risk signals reviewDepth=auto keys on, as data. scripts/review-depth.mjs owns how a
// matcher matches; tests/fixtures/risk-calibration.json records how often these ask on real
// branches, and its signalsSha256 must be regenerated whenever this file changes
// (scripts/risk-calibration.mjs --write). Volume is never a signal.
//
// A signal is { id, label, matchers }; it matches when any matcher hits one changed file.
//   { on: "path", glob, notGlob?, deleted? }  the path matches glob (and not notGlob); deleted: a deletion only
//   { on: "added" | "removed", pattern, glob?, notGlob? }  some added (removed) line matches
//   { on: "gained" | "lost", pattern, glob?, notGlob? }   more added than removed lines match
//     (gained), or more removed than added (lost): a new call site, not an edited one
// Patterns never carry the g or y flag, since RegExp#test is stateful under them.

const CODE = "**/*.{js,mjs,cjs,ts,tsx,jsx,py,rb,go,rs,java,kt,cs,php,swift,sh}";
const TEST_GLOBS = ["**/{test,tests,__tests__,spec,specs}/**", "**/*{.test,.spec,_test}.*", "**/test_*.*"];
const TESTS = `{${TEST_GLOBS.join(",")}}`;
const SHELL = "**/{*.{sh,bash,zsh,yml,yaml,mk,ps1},Makefile,Dockerfile*,Justfile}";
const DOCS = "**/*.{md,mdx,txt,rst}";
const DOCS_OR_TESTS = `{${DOCS},${TESTS}}`;
const MANIFESTS = "**/{package.json,requirements*.txt,Pipfile,pyproject.toml,Gemfile,go.mod,Cargo.toml,composer.json,pom.xml,build.gradle,build.gradle.kts,*.csproj}";
const DEPENDENCY_LINE = /^\s*(?:"(?!version"|name"|description"|main"|type"|license"|private"|node"|npm"|pnpm"|yarn")[^"]+"\s*:\s*"(?:[~^<>=*]|\d|workspace:|npm:|github:|git\+|file:)|[A-Za-z0-9_.-]+\s*(?:==|>=|~=|<=)\s*\d|gem\s+["']|require\s+[\w./-]+\s+v\d|(?!(?:requires-python|rust-version|target-version|edition|version|name|description|license|readme)\s*=)[\w-]+\s*=\s*(?:"[~^<>=*]?\d|\{\s*version))/;

const testMatchers = (fields) => TEST_GLOBS.map((glob) => ({ ...fields, glob, notGlob: DOCS }));

export const BUILTIN_SIGNALS = Object.freeze([
  {
    id: "auth-security",
    label: "authentication and security code",
    matchers: [
      { on: "path", glob: "**/{auth,authn,authz,security,crypto,permissions,policies,session,sessions}/**", notGlob: DOCS_OR_TESTS },
      { on: "path", glob: "**/*{auth,Auth,login,Login,crypto,Crypto,password,Password,permission,Permission}*.{js,mjs,cjs,ts,tsx,jsx,py,rb,go,rs,java,kt,cs,php,swift}", notGlob: TESTS },
    ],
  },
  {
    id: "hooks-guards",
    label: "hooks and guards",
    matchers: [
      { on: "path", glob: "{hooks,.husky,.githooks}/**" },
      { on: "path", glob: ".claude/settings*.json" },
    ],
  },
  {
    id: "ci-release",
    label: "CI, release and deploy definitions",
    matchers: [
      { on: "path", glob: ".github/workflows/**" },
      { on: "path", glob: "{.gitlab-ci.yml,.circleci/**,azure-pipelines.yml,Jenkinsfile,.buildkite/**,bitbucket-pipelines.yml}" },
      { on: "path", glob: "**/{Dockerfile,Dockerfile.*,docker-compose*.yml,compose*.yml,fly.toml,vercel.json,netlify.toml,render.yaml,app.yaml,Procfile}" },
      { on: "path", glob: "**/*{release,deploy,publish}*.{sh,mjs,js,ts,py,yml,yaml}", notGlob: TESTS },
    ],
  },
  {
    id: "data-migrations",
    label: "schema and migration files",
    matchers: [
      { on: "path", glob: "**/{migrations,migrate}/**" },
      { on: "path", glob: "**/*.sql", notGlob: TESTS },
      { on: "path", glob: "**/{schema.prisma,schema.rb,structure.sql}" },
    ],
  },
  {
    id: "secrets-config",
    label: "secrets and credential material",
    matchers: [
      { on: "path", glob: "**/.env*", notGlob: "**/.env*.{example,sample,template,dist}" },
      { on: "path", glob: "**/*.{pem,key,p12,pfx,jks,keystore}" },
      { on: "path", glob: "**/{secrets,credentials}*.{json,yml,yaml,toml}" },
      { on: "added", pattern: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|password)\s*[:=]\s*["'](?!env\(|\$\{)[^"']{8,}/i, notGlob: DOCS },
    ],
  },
  {
    id: "dependencies",
    label: "dependency changes",
    // gained/lost, not added/removed: a version bump removes and adds the same line, so only a new or dropped dependency asks.
    matchers: [
      { on: "gained", glob: MANIFESTS, pattern: DEPENDENCY_LINE },
      { on: "lost", glob: MANIFESTS, pattern: DEPENDENCY_LINE },
    ],
  },
  {
    id: "dangerous-calls",
    label: "process execution, eval, destructive shell and raw HTML sinks",
    // A bare exec( or system( is a call only when no dot or word character precedes it and it is not a definition:
    // re.exec( and menu.exec( are not process execution, nor are filesystem( or foo.system(. exec.Command( is Go's own form.
    matchers: [
      { on: "gained", glob: CODE, notGlob: TESTS, pattern: /^(?!\s*(?:#|\/\/|\*)).*(?:(?<![.\w`])(?<!\b(?:def|function|func)\s+)(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|system|shell_exec)\s*\(|\bexec\.Command(?:Context)?\s*\(|\b(?:child_?process|cp)\.(?:spawn|exec|fork)\w*\s*\(|\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(|\bgetRuntime\(\)\.exec\s*\(|\bsubprocess\.\w+\s*\(|\beval\s*\(|\bnew\s+Function\s*\()/ },
      { on: "gained", glob: SHELL, notGlob: TESTS, pattern: /\brm\s+-[a-zA-Z]*(?:rf|fr)\b|\bgit\s+push\b[^\n]*(?:\s-f\b|--force\b)|\bchmod\s+[0-7]{3,4}\b|\bsudo\s+/ },
      { on: "gained", glob: CODE, notGlob: TESTS, pattern: /\binnerHTML\s*=|\bouterHTML\s*=|dangerouslySetInnerHTML|\bv-html\b|\bdocument\.write\s*\(|\bhtml_safe\b/ },
    ],
  },
  {
    id: "test-weakening",
    label: "weakened tests",
    // Lost assertions count only assertion-API calls: a bare assert or expect( line leaves with every routine test refactor.
    // Calibrated over past branches, a bare assert took one repo to the ask-rate ceiling and expect( took another past it, so pytest and jest removals are a known gap.
    matchers: [
      ...testMatchers({ on: "path", deleted: true }),
      ...testMatchers({ on: "added", pattern: /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|\{\s*(?:skip|todo)\s*:\s*true/ }),
      ...testMatchers({ on: "lost", pattern: /^\s*(?:await\s+)?(?:assert\.\w+\s*\(|self\.assert\w*\()|\.should\b/ }),
    ],
  },
]);
