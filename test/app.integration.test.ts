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

async function withProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-app-"));
  try {
    await Promise.all(
      Object.entries(files).map(async ([relativePath, content]) => {
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
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  );
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("local scan aggregates direct reads from separate files with unique source facts", async () => {
  await withProject(
    {
      "src/api.ts": "export const databaseUrl = process.env.DATABASE_URL;\n",
      "src/worker.ts": "export const databaseUrl = process.env.DATABASE_URL;\n",
    },
    async (root) => {
      const run = await scanJson(root, true);
      assert.equal(run.status, 0);
      assert.equal(run.stderr, "");

      const report = JSON.parse(run.stdout) as JsonReport;
      const group = report.groups.find(
        (candidate) =>
          candidate.key.namespace === "env" && candidate.key.name === "DATABASE_URL",
      );
      assert.equal(group?.sources.length, 2);
      assert.notEqual(group?.sources[0]?.referenceId, group?.sources[1]?.referenceId);
      assert.deepEqual(report.scopeCoverage.map((coverage) => coverage.state), ["complete"]);
    },
  );
});

test("local scan reports an unbounded user-controlled lookup without inventing key names", async () => {
  await withProject(
    {
      "src/handler.ts": [
        "export function handler(query: { key: string }) {",
        "  return process.env[query.key];",
        "}",
        "",
      ].join("\n"),
    },
    async (root) => {
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

test("an ignored first-party path makes require-complete fail instead of implying absence", async () => {
  await withProject(
    {
      ".gitignore": "ignored.ts\n",
      "ignored.ts": "export const oldToken = process.env.OLD_TOKEN;\n",
    },
    async (root) => {
      const run = await scanJson(root, true);
      assert.equal(run.status, 2);
      assert.equal(run.stderr, "");

      const report = JSON.parse(run.stdout) as JsonReport;
      assert.deepEqual(report.scopeCoverage.map((coverage) => coverage.state), ["incomplete"]);
      assert.equal(run.stdout.includes("OLD_TOKEN"), false);
    },
  );
});
