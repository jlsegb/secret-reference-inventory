import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = await mkdtemp(join(tmpdir(), "secret-reference-inventory-install-"));

function runNpm(argumentsList, cwd, environment, failureCode) {
  try {
    return execFileSync(npmCommand, argumentsList, {
      cwd,
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(failureCode);
  }
}

function runInstalledCli(binary, argumentsList, cwd, failureCode) {
  try {
    return execFileSync(binary, argumentsList, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
  } catch {
    throw new Error(failureCode);
  }
}

try {
  const packDirectory = join(temporaryRoot, "pack");
  const installDirectory = join(temporaryRoot, "install");
  const cacheDirectory = join(temporaryRoot, "empty-cache");
  const userNpmrc = join(temporaryRoot, "isolated-user.npmrc");
  const globalNpmrc = join(temporaryRoot, "isolated-global.npmrc");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    writeFile(userNpmrc, "", "utf8"),
    writeFile(globalNpmrc, "", "utf8"),
    writeFile(
      join(installDirectory, "package.json"),
      '{"name":"local-package-install-smoke","version":"0.0.0","private":true}\n',
      "utf8",
    ),
  ]);

  const isolatedEnvironment = {
    ...process.env,
    npm_config_update_notifier: "false",
  };
  const isolationOptions = [
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--cache",
    cacheDirectory,
    "--userconfig",
    userNpmrc,
    "--globalconfig",
    globalNpmrc,
  ];
  const packed = JSON.parse(
    runNpm(
      ["pack", root, "--json", "--pack-destination", packDirectory, ...isolationOptions],
      temporaryRoot,
      isolatedEnvironment,
      "LOCAL_PACKAGE_PACK_FAILED",
    ),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("LOCAL_PACKAGE_ARCHIVE_MISSING");
  }
  const archive = join(packDirectory, filename);
  if (!existsSync(archive)) {
    throw new Error("LOCAL_PACKAGE_ARCHIVE_MISSING");
  }

  runNpm(
    [
      "install",
      ...isolationOptions,
      "--omit=dev",
      "--no-package-lock",
      "--no-save",
      archive,
    ],
    installDirectory,
    isolatedEnvironment,
    "LOCAL_PACKAGE_INSTALL_FAILED",
  );

  const binary = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "secret-usage.cmd" : "secret-usage",
  );
  if (!existsSync(binary)) {
    throw new Error("PACKAGED_CLI_BIN_MISSING");
  }
  const output = runInstalledCli(
    binary,
    ["--help"],
    installDirectory,
    "PACKAGED_CLI_SMOKE_FAILED",
  );
  if (!output.includes("secret-usage") || !output.includes("Usage:")) {
    throw new Error("PACKAGED_CLI_HELP_INVALID");
  }

  const workspaceDirectory = join(installDirectory, "workspace-fixture");
  const workspaceManifest = join(workspaceDirectory, "workspace.json");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    workspaceManifest,
    JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: [{ id: "fixture", root: "." }],
      deployments: [],
    }) + "\n",
    "utf8",
  );
  const workspaceOutput = runInstalledCli(
    binary,
    ["workspace", "scan", "--manifest", workspaceManifest, "--format", "json"],
    installDirectory,
    "PACKAGED_WORKSPACE_SMOKE_FAILED",
  );
  let workspaceReport;
  try {
    workspaceReport = JSON.parse(workspaceOutput);
  } catch {
    throw new Error("PACKAGED_WORKSPACE_REPORT_INVALID");
  }
  if (
    workspaceReport?.schemaVersion !== "secret-reference-inventory/workspace-report/v1" ||
    workspaceReport?.repositories?.[0]?.id !== "fixture" ||
    workspaceOutput.includes(workspaceDirectory)
  ) {
    throw new Error("PACKAGED_WORKSPACE_REPORT_INVALID");
  }

  process.stdout.write("local package install smoke passed\n");
} catch (error) {
  const code = error instanceof Error ? error.message : "LOCAL_PACKAGE_INSTALL_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
