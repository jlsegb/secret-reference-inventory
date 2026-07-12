import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createLocalCliHandlers,
  type WorkspaceScanPort,
  type WorkspaceScanReportSource,
} from "../src/app/index.js";
import {
  type ReconciliationResult,
  type SafeDiagnosticCode,
  type SafeIdentifier,
} from "../src/core/index.js";
import { runCli } from "../src/cli/index.js";
import { startLocalReportViewer, type LocalReportViewer } from "../src/viewer/index.js";

const id = (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic = (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const emptyReconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("workspace scan writes a deterministic versioned report and returns incomplete status on request", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const status = await runCli(
    [
      "workspace",
      "scan",
      "--manifest",
      manifestPath,
      "--format",
      "json",
      "--require-complete",
    ],
    createLocalCliHandlers({ workspaceScan: scanPort("incomplete") }),
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  );

  assert.equal(status, 2);
  assert.equal(stderr.join(""), "");
  const report = JSON.parse(stdout.join("")) as {
    readonly schemaVersion: string;
    readonly summary: { readonly incomplete: boolean };
    readonly repositories: readonly { readonly id: string; readonly state: string }[];
  };
  assert.equal(report.schemaVersion, "secret-reference-inventory/workspace-report/v2");
  assert.equal(report.summary.incomplete, true);
  assert.deepEqual(report.repositories.map((repository) => repository.id), ["api"]);
  assert.equal(stdout.join("").includes(manifestPath), false);
});

test("workspace scan uses the default N3 local port when no test port is injected", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const status = await runCli(
    ["workspace", "scan", "--manifest", manifestPath, "--format", "json"],
    createLocalCliHandlers(),
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  );

  assert.equal(status, 0);
  assert.equal(stderr.join(""), "");
  const report = JSON.parse(stdout.join("")) as {
    readonly repositories: readonly {
      readonly id: string;
      readonly state: string;
      readonly report?: { readonly schemaVersion: string };
    }[];
  };
  assert.equal(report.repositories[0]?.id, "api");
  assert.equal(report.repositories[0]?.state, "complete");
  assert.equal(
    report.repositories[0]?.report?.schemaVersion,
    "secret-reference-inventory/report/v1",
  );
});

test("workspace UI launches a loopback-only viewer from derived report data", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  const launched: LocalReportViewer[] = [];
  const stdout: string[] = [];
  const status = await runCli(
    ["ui", "--manifest", manifestPath, "--port", "0"],
    createLocalCliHandlers({
      workspaceScan: scanPort("complete"),
      startViewer: async (request) => {
        const viewer = await startLocalReportViewer(request);
        launched.push(viewer);
        return viewer;
      },
    }),
    { stdout: (text) => stdout.push(text), stderr: () => undefined },
  );
  t.after(async () => {
    await Promise.all(launched.map((viewer) => viewer.close()));
  });

  assert.equal(status, 0);
  const url = new URL(stdout.join("").trim());
  assert.equal(url.hostname, "127.0.0.1");
  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(page.body, /aria-label="Repositories"/u);
  assert.match(page.body, /"label":"api"/u);
  assert.equal(page.body.includes(manifestPath), false);
});

test("workspace invalid input and required-complete UI return nonzero without launching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-cli-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidPath = join(root, "missing.json");
  const invalidErr: string[] = [];
  const invalid = await runCli(
    ["workspace", "scan", "--manifest", invalidPath],
    createLocalCliHandlers({ workspaceScan: scanPort("complete") }),
    { stdout: () => undefined, stderr: (text) => invalidErr.push(text) },
  );
  assert.equal(invalid, 65);
  assert.equal(invalidErr.join(""), "APP_WORKSPACE_MANIFEST_READ_FAILED\n");
  assert.equal(invalidErr.join("").includes(invalidPath), false);

  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  let launched = false;
  const incomplete = await runCli(
    ["ui", "--manifest", manifestPath, "--require-complete"],
    createLocalCliHandlers({
      workspaceScan: scanPort("incomplete"),
      startViewer: async () => {
        launched = true;
        throw new Error("Viewer should not start");
      },
    }),
    { stdout: () => undefined, stderr: () => undefined },
  );
  assert.equal(incomplete, 2);
  assert.equal(launched, false);
});

test("workspace UI rejects synthetic-row viewer overflow before starting a listener", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  let launched = false;
  const stderr: string[] = [];

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: overflowingScanPort(),
      startViewer: async () => {
        launched = true;
        throw new Error("viewer must not start after model preflight failure");
      },
    }),
    { stdout: () => undefined, stderr: (text) => stderr.push(text) },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_LIMIT_EXCEEDED\n");
  assert.equal(launched, false);
});

test("workspace UI closes a started viewer when writing its URL fails", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  const stderr: string[] = [];
  let closeCalls = 0;

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: scanPort("complete"),
      startViewer: async () => ({
        address: { host: "127.0.0.1", port: 12345 },
        url: new URL("http://127.0.0.1:12345/"),
        async close(): Promise<void> {
          closeCalls += 1;
        },
      }),
    }),
    {
      stdout: () => {
        throw new Error("stdout unavailable");
      },
      stderr: (text) => stderr.push(text),
    },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_FAILED\n");
  assert.equal(closeCalls, 1);
});

test("workspace UI collapses adversarial report getters to a fixed error before viewer launch", async (t) => {
  const manifestPath = await writeManifest();
  t.after(() => rmParent(manifestPath));
  const sentinel = "/private/sk_live_WORKSPACE_REPORT_TRAP_123456789";
  let getterReads = 0;
  let launched = false;
  const stderr: string[] = [];
  const hostileResult = Object.create(null) as WorkspaceScanReportSource;
  Object.defineProperty(hostileResult, "repositories", {
    get(): never {
      getterReads += 1;
      throw new Error(sentinel);
    },
  });

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: {
        async scan() {
          return hostileResult;
        },
      },
      startViewer: async () => {
        launched = true;
        throw new Error("viewer must not launch");
      },
    }),
    { stdout: () => undefined, stderr: (text) => stderr.push(text) },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_FAILED\n");
  assert.equal(stderr.join("").includes(sentinel), false);
  assert.equal(getterReads, 1);
  assert.equal(launched, false);
});

function scanPort(
  status: "complete" | "incomplete",
): WorkspaceScanPort<WorkspaceScanReportSource> {
  return {
    async scan() {
      return {
        repositories: [
          {
            id: id("api"),
            status,
            diagnostics:
              status === "incomplete"
                ? [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")]
                : [],
            reconciliation: emptyReconciliation,
            references: [],
            demandEdges: [],
            dynamicLookupEdges: [],
          },
        ],
        deployments: [],
      };
    },
  };
}

function overflowingScanPort(): WorkspaceScanPort<WorkspaceScanReportSource> {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    id: id("repository-" + String(index + 1)),
    status: "complete" as const,
    diagnostics: [],
    reconciliation: emptyReconciliation,
    references: [],
    demandEdges: [],
    dynamicLookupEdges: [],
  }));
  return {
    async scan() {
      return {
        repositories,
        deployments: [{
          id: id("production"),
          status: "complete",
          diagnostics: [],
          repositoryIds: repositories.map((repository) => repository.id),
          sharedKeys: [],
          members: repositories.map((repository) => ({
            repositoryId: repository.id,
            status: repository.status,
            diagnostics: repository.diagnostics,
            reconciliation: repository.reconciliation,
            references: repository.references,
            demandEdges: repository.demandEdges,
            dynamicLookupEdges: repository.dynamicLookupEdges,
          })),
        }],
      };
    },
  };
}

async function writeManifest(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-cli-"));
  const manifestPath = join(root, "workspace.jsonc");
  await writeFile(
    manifestPath,
    [
      "{",
      '  "schemaVersion": "workspace-manifest/v2",',
      '  "repositories": [{ "id": "api", "root": "." }],',
      '  "deployments": []',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return manifestPath;
}

async function rmParent(file: string): Promise<void> {
  await rm(dirname(file), { recursive: true, force: true });
}

async function request(url: URL): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
