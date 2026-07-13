import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

const failures = [];
const fail =
  /**
   * Records one release-policy violation for aggregated terminal reporting.
   *
   * Inputs: A release-check failure message, which callers may form by interpolating local package metadata or package paths.
   * Outputs: The new numeric length of the failures array.
   * Does not handle: Throwing immediately, escaping or redacting interpolated text, or emitting output.
   * Side effects: Mutates the module-local failures array; the accumulated messages are written to standard error at module completion.
   */
  (message) => failures.push(message);

if (packageJson.private === true) {
  fail("package must not be private");
}
if (packageJson.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (packageJson.type !== "module") {
  fail("package must declare ESM module type");
}
if (packageJson.license !== "MIT" || !existsSync(resolve(root, "LICENSE"))) {
  fail("MIT license metadata and LICENSE file are required");
}
if (!existsSync(resolve(root, "README.md"))) {
  fail("README.md is required");
}
const requiredBundledDependencies = ["ignore", "typescript"];
if (
  !Array.isArray(packageJson.bundledDependencies) ||
  packageJson.bundledDependencies.length !== requiredBundledDependencies.length ||
  requiredBundledDependencies.some(
    /**
     * Detects a mandatory runtime dependency omitted from package bundling.
     *
     * Inputs: One required dependency name.
     * Outputs: True when the package's bundled-dependencies list does not include it.
     * Does not handle: Checking transitive dependency contents or package installation.
     * Side effects: None.
     */
    (dependency) => !packageJson.bundledDependencies.includes(dependency),
  )
) {
  fail("all local-only runtime dependencies must be bundled");
}

const directDependencies = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.optionalDependencies ?? {}),
  ...(packageJson.peerDependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};
const prohibitedDependency = /(?:telemetry|analytics|sentry|posthog|segment|amplitude|datadog|newrelic|opentelemetry|axios|node-fetch|superagent|websocket|socket\.io|\bundici\b|\bgot\b|\brequest\b)/iu;
for (const name of Object.keys(directDependencies)) {
  if (prohibitedDependency.test(name)) {
    fail(`prohibited direct runtime dependency: ${name}`);
  }
}

const prohibitedConfigKey = /(?:telemetry|analytics|sentry|posthog|segment|amplitude|datadog|newrelic|opentelemetry|proxy|registry)/iu;
/**
 * Recursively finds prohibited package configuration keys without executing configuration.
 *
 * Inputs: A JSON-derived value and a display trail rooted at package metadata.
 * Outputs: Nothing; violations are appended to the module-local failure collection.
 * Does not handle: Schema validation, circular object graphs, or non-enumerable properties.
 * Side effects: Recurses through JSON-like objects and mutates the failures array.
 */
function inspectConfig(value, trail = "package") {
  if (Array.isArray(value)) {
    value.forEach(
      /**
       * Inspects one array member while retaining its index in the diagnostic trail.
       *
       * Inputs: A JSON-like array member and its numeric index.
       * Outputs: Nothing after delegating inspection.
       * Does not handle: Array traversal outside the provided member.
       * Side effects: May append a failure through the recursive inspector.
       */
      (item, index) => inspectConfig(item, `${trail}[${index}]`)
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (prohibitedConfigKey.test(key)) {
      fail(`prohibited package configuration key: ${trail}.${key}`);
    }
    inspectConfig(nested, `${trail}.${key}`);
  }
}
inspectConfig(packageJson);

const binTarget = typeof packageJson.bin?.["secret-usage"] === "string"
  ? packageJson.bin["secret-usage"]
  : undefined;
if (binTarget === undefined || !existsSync(resolve(root, binTarget))) {
  fail("secret-usage bin target is missing");
} else if (!readFileSync(resolve(root, binTarget), "utf8").startsWith("#!/usr/bin/env node\n")) {
  fail("secret-usage bin target must retain a Node shebang");
}

for (const [subpath, entry] of Object.entries(packageJson.exports ?? {})) {
  if (entry === null || typeof entry !== "object") {
    fail(`export ${subpath} must provide import/types targets`);
    continue;
  }
  for (const condition of ["import", "types"]) {
    const target = entry[condition];
    if (typeof target !== "string" || !existsSync(resolve(root, target))) {
      fail(`export ${subpath} has no local ${condition} target`);
    }
  }
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let packedFiles = [];
try {
  const output = execFileSync(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const pack = JSON.parse(output);
  packedFiles = pack[0]?.files?.map(
    /**
     * Extracts one dry-run package path from npm's reported file descriptor.
     *
     * Inputs: An npm pack file entry.
     * Outputs: Its path field without validating the field's shape.
     * Does not handle: Package policy validation or malformed npm output.
     * Side effects: None.
     */
    (file) => file.path
  ) ?? [];
} catch {
  fail("npm pack --dry-run --ignore-scripts did not return a package file list");
}

const expectedFiles = ["package.json", "README.md", "LICENSE", binTarget?.replace(/^\.\//u, "")];
for (const path of expectedFiles) {
  if (path !== undefined && !packedFiles.includes(path)) {
    fail(`required file missing from package: ${path}`);
  }
}
for (const dependency of requiredBundledDependencies) {
  if (!packedFiles.includes(`node_modules/${dependency}/package.json`)) {
    fail("a bundled runtime dependency is missing from the package");
  }
}
const packagedDocumentationPath = /^docs\/(?:[a-z0-9][a-z0-9.-]*\/)*[a-z0-9][a-z0-9.-]*\.md$/u;
for (const path of packedFiles) {
  const allowed =
    path === "package.json" ||
    path === "README.md" ||
    path === "LICENSE" ||
    packagedDocumentationPath.test(path) ||
    path.startsWith("dist/") ||
    requiredBundledDependencies.some(
      /**
       * Recognizes a file belonging to one required bundled dependency.
       *
       * Inputs: A required dependency name closed over with the current package path.
       * Outputs: True when the current path lies beneath that dependency directory.
       * Does not handle: Validating package archives or matching similarly named dependencies.
       * Side effects: None.
       */
      (dependency) => path.startsWith(`node_modules/${dependency}/`),
    );
  if (!allowed) {
    fail(`unexpected package file: ${path}`);
  }
  if (
    path.startsWith("src/") ||
    path.startsWith("test/") ||
    path.includes("/test/") ||
    path.includes("fixture") ||
    path.includes("cache") ||
    path.endsWith(".map")
  ) {
    fail(`unsafe or non-release package file: ${path}`);
  }
}

const prohibitedRuntimeSyntax = [
  /from\s*["']node:(?:http|https|net|tls|dgram)["']/u,
  /\brequire\(\s*["']node:(?:http|https|net|tls|dgram)["']\s*\)/u,
  /\bimport\(\s*["']node:(?:http|https|net|tls|dgram)["']\s*\)/u,
  /\bhttps?\.request\s*\(/u,
  /\bfetch\s*\(/u,
];
for (const path of packedFiles.filter(
  /**
   * Selects JavaScript artifacts for static runtime-syntax inspection.
   *
   * Inputs: One package-relative packed-file path.
   * Outputs: True for paths ending in the JavaScript extension.
   * Does not handle: Reading the file or recognizing other executable extensions.
   * Side effects: None.
   */
  (item) => item.endsWith(".js")
)) {
  const text = readFileSync(resolve(root, path), "utf8");
  const isConstrainedLocalViewer =
    path === "dist/viewer/server.js" &&
    text.includes('const LOOPBACK_HOST = "127.0.0.1";') &&
    text.includes("server.listen({ host: LOOPBACK_HOST, port });");
  const applicableSyntax = isConstrainedLocalViewer
    ? prohibitedRuntimeSyntax.filter(
      /**
       * Retains every prohibited network pattern except the explicitly loopback-reviewed HTTP import.
       *
       * Inputs: One runtime-syntax regular expression.
       * Outputs: True when the pattern remains prohibited for the constrained viewer artifact.
       * Does not handle: Proving that the viewer code remains loopback-only.
       * Side effects: Advances mutable regular-expression state only if a future pattern becomes stateful.
       */
      (pattern) => !pattern.test('from "node:http"')
    )
    : prohibitedRuntimeSyntax;
  if (applicableSyntax.some(
    /**
     * Detects a prohibited network-capable syntax pattern in one packaged script.
     *
     * Inputs: One regular expression closed over with the file text.
     * Outputs: True when the expression matches that text.
     * Does not handle: Dynamic code execution or semantic reachability analysis.
     * Side effects: Advances mutable regular-expression state only if a future pattern becomes stateful.
     */
    (pattern) => pattern.test(text)
  )) {
    fail(`network-capable runtime syntax found in package file: ${path}`);
  }
  if (path === "dist/viewer/server.js" && !isConstrainedLocalViewer) {
    fail("local viewer must bind its HTTP server to fixed IPv4 loopback");
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`release readiness passed (${packedFiles.length} package files)\n`);
}
