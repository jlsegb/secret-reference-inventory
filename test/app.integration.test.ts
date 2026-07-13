import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLocalCliHandlers } from "../src/app/index.js";
import { runCli } from "../src/cli/index.js";

interface JsonReport {
  readonly groups: Array<{
    readonly key: { readonly namespace: string; readonly name: string };
    readonly sources: Array<{ readonly referenceId: string }>;
  }>;
  readonly dynamicLookups: Array<{
    readonly domain: { readonly kind: string; readonly reason?: string };
    readonly origin: string;
    readonly likelyKeys: unknown[];
  }>;
  readonly scopeCoverage: Array<{ readonly state: string }>;
}

/**
 * Creates an isolated temporary project, writes each fixture file, runs one assertion callback, and removes the project.
 *
 * Inputs: A repository-relative file-content map and an async callback receiving the temporary root path.
 * Outputs: A fulfilled `undefined` promise, or rejects with fixture write/assertion failure after cleanup is attempted.
 * Does not handle: Persisting fixtures, Git initialization, or swallowing callback failures.
 * Side effects: Creates directories/files below the OS temp directory and recursively removes the root in `finally`.
 */
async function withProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-app-"));
  try {
    await Promise.all(
      Object.entries(files).map(/**
       * Writes one requested fixture entry beneath the temporary project root.
       *
       * Inputs: A relative path and its UTF-8 content from the fixture map.
       * Outputs: A fulfilled promise after the parent directory and file exist.
       * Does not handle: Path traversal validation or cleanup.
       * Side effects: Creates local directories and writes one local UTF-8 file.
       */ async ([relativePath, content]) => {
        const destination = join(root, relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Runs the real local scan CLI against a fixture root and collects both output streams.
 *
 * Inputs: A temporary project root and optional completeness requirement.
 * Outputs: Exit status plus concatenated stdout/stderr strings.
 * Does not handle: Parsing output JSON, fixture creation, or process spawning.
 * Side effects: Invokes local CLI handlers that traverse fixture source and appends emitted stream chunks to arrays.
 */
async function scanJson(root: string, requireComplete = false): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runCli(
    [
      "scan",
      root,
      "--format",
      "json",
      ...(requireComplete ? ["--require-complete"] : []),
    ],
    createLocalCliHandlers(),
    {
      stdout: /**
       * Captures one scan stdout chunk for later JSON parsing assertions.
       *
       * Inputs: A rendered stdout text chunk.
       * Outputs: The array length returned by `push`.
       * Does not handle: Printing or parsing the chunk.
       * Side effects: Mutates the enclosing stdout collection.
       */ (text) => stdout.push(text),
      stderr: /**
       * Captures one scan stderr chunk for later diagnostic assertions.
       *
       * Inputs: A rendered stderr text chunk.
       * Outputs: The array length returned by `push`.
       * Does not handle: Printing or parsing the chunk.
       * Side effects: Mutates the enclosing stderr collection.
       */ (text) => stderr.push(text),
    },
  );
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("local scan aggregates direct reads from separate files with unique source facts", /**
 * Asserts that two fixture files reading the same direct key retain two distinct source identities.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when the scan is complete and grouped evidence is distinct; assertion failure rejects it.
 * Does not handle: Dynamic lookup behavior or ignored-file coverage.
 * Side effects: Builds and removes a temporary fixture project and runs the local CLI scanner.
 */ async () => {
  await withProject(
    {
      "src/api.ts": "export const databaseUrl = process.env.DATABASE_URL;\n",
      "src/worker.ts": "export const databaseUrl = process.env.DATABASE_URL;\n",
    },
    /**
     * Scans the two-file fixture and verifies grouped direct-demand evidence.
     *
     * Inputs: The temporary project root prepared by `withProject`.
     * Outputs: A fulfilled promise after all direct-read assertions pass.
     * Does not handle: Fixture cleanup or CLI stream collection mechanics.
     * Side effects: Invokes the local scan CLI against temporary source files.
     */ async (root) => {
      const run = await scanJson(root, true);
      assert.equal(run.status, 0);
      assert.equal(run.stderr, "");

      const report = JSON.parse(run.stdout) as JsonReport;
      const group = report.groups.find(
        /**
         * Selects the grouped fact for the fixture's database URL environment key.
         *
         * Inputs: One parsed JSON report group.
         * Outputs: `true` only for namespace `env` and name `DATABASE_URL`.
         * Does not handle: Source-count assertions.
         * Side effects: None.
         */ (candidate) =>
          candidate.key.namespace === "env" && candidate.key.name === "DATABASE_URL",
      );
      assert.equal(group?.sources.length, 2);
      assert.notEqual(group?.sources[0]?.referenceId, group?.sources[1]?.referenceId);
      assert.deepEqual(report.scopeCoverage.map(/**
       * Projects one scope coverage entry to its state for the completeness assertion.
       *
       * Inputs: One parsed report coverage entry.
       * Outputs: Its state string.
       * Does not handle: Validation or mutation of coverage data.
       * Side effects: None.
       */ (coverage) => coverage.state), ["complete"]);
    },
  );
});

test("local scan reports an unbounded user-controlled lookup without inventing key names", /**
 * Asserts that a user-controlled bracket lookup remains incomplete without invented key names.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when all dynamic-lookup assertions pass; assertion failure rejects it.
 * Does not handle: Direct-read grouping or ignored-path behavior.
 * Side effects: Builds/removes a temporary fixture project and executes the local scanner.
 */ async () => {
  await withProject(
    {
      "src/handler.ts": [
        "export function handler(query: { key: string }) {",
        "  return process.env[query.key];",
        "}",
        "",
      ].join("\n"),
    },
    /**
     * Runs the bracket-lookup fixture and asserts its opaque dynamic evidence.
     *
     * Inputs: The temporary project root prepared by `withProject`.
     * Outputs: A fulfilled promise after incompleteness/no-key-leak assertions pass.
     * Does not handle: Fixture lifecycle or JSON report serialization.
     * Side effects: Invokes the local scan CLI against temporary source.
     */ async (root) => {
      const run = await scanJson(root, true);
      // An unbounded lookup is an explicit scoped incompleteness condition:
      // it can execute with any key even though traversal itself completed.
      assert.equal(run.status, 2);
      assert.equal(run.stderr, "");

      const report = JSON.parse(run.stdout) as JsonReport;
      assert.equal(report.dynamicLookups.length, 1);
      assert.equal(report.dynamicLookups[0]?.domain.kind, "unbounded");
      assert.equal(report.dynamicLookups[0]?.domain.reason, "user-controlled");
      assert.equal(report.dynamicLookups[0]?.origin, "user-controlled");
      assert.deepEqual(report.dynamicLookups[0]?.likelyKeys, []);
      assert.equal(run.stdout.includes("query.key"), false);
    },
  );
});

test("an ignored first-party path makes require-complete fail instead of implying absence", /**
 * Asserts that an ignored first-party source creates incomplete coverage instead of an absence claim.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when status, coverage, and no-key-leak assertions pass.
 * Does not handle: Dynamic lookup behavior or direct-read multiplicity.
 * Side effects: Builds/removes a temporary ignored-file fixture project and executes the local scanner.
 */ async () => {
  await withProject(
    {
      ".gitignore": "ignored.ts\n",
      "ignored.ts": "export const oldToken = process.env.OLD_TOKEN;\n",
    },
    /**
     * Scans the ignored-file fixture and verifies the incomplete report outcome.
     *
     * Inputs: The temporary project root prepared by `withProject`.
     * Outputs: A fulfilled promise after the status and report assertions pass.
     * Does not handle: Fixture cleanup or command argument construction.
     * Side effects: Invokes the local scan CLI against temporary files.
     */ async (root) => {
      const run = await scanJson(root, true);
      assert.equal(run.status, 2);
      assert.equal(run.stderr, "");

      const report = JSON.parse(run.stdout) as JsonReport;
      assert.deepEqual(report.scopeCoverage.map(/**
       * Projects one scope coverage entry to its state for the incomplete assertion.
       *
       * Inputs: One parsed report coverage entry.
       * Outputs: Its state string.
       * Does not handle: Validation or mutation of coverage data.
       * Side effects: None.
       */ (coverage) => coverage.state), ["incomplete"]);
      assert.equal(run.stdout.includes("OLD_TOKEN"), false);
    },
  );
});
