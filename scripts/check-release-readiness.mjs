import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

const failures = [];
const fail = (message) => failures.push(message);

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
function inspectConfig(value, trail = "package") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectConfig(item, `${trail}[${index}]`));
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
  packedFiles = pack[0]?.files?.map((file) => file.path) ?? [];
} catch {
  fail("npm pack --dry-run --ignore-scripts did not return a package file list");
}

const expectedFiles = ["package.json", "README.md", "LICENSE", binTarget?.replace(/^\.\//u, "")];
for (const path of expectedFiles) {
  if (path !== undefined && !packedFiles.includes(path)) {
    fail(`required file missing from package: ${path}`);
  }
}
for (const path of packedFiles) {
  const allowed = path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("dist/");
  if (!allowed) {
    fail(`unexpected package file: ${path}`);
  }
  if (
    path.startsWith("src/") ||
    path.startsWith("test/") ||
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
for (const path of packedFiles.filter((item) => item.endsWith(".js"))) {
  const text = readFileSync(resolve(root, path), "utf8");
  if (prohibitedRuntimeSyntax.some((pattern) => pattern.test(text))) {
    fail(`network-capable runtime syntax found in package file: ${path}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`release readiness passed (${packedFiles.length} package files)\n`);
}
