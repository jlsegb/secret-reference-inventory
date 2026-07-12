import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import { workspaceReportToViewerRequest } from "../src/app/workspace-view-model.js";
import type { WorkspaceJsonReport } from "../src/reporters/index.js";
import {
  type LocalReportViewer,
  startLocalReportViewer,
} from "../src/viewer/index.js";
import { ViewerRequestError } from "../src/viewer/internal.js";

const privatePathMarker = "source/private-config-value.ts";

test("workspace viewer model supports repository/result navigation without source data", async (t) => {
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 2, deployments: 1, incomplete: true },
    repositories: [
      {
        id: "api",
        state: "complete",
        diagnostics: [],
        report: {
          schemaVersion: "secret-reference-inventory/report/v1",
          groups: [
            {
              key: { namespace: "env", name: "DATABASE_URL" },
              shared: false,
              consumers: [],
              sources: [
                {
                  referenceId: "ref-api",
                  demand: "direct-read",
                  operation: "read",
                  resolution: "literal",
                  confidence: "high",
                  exposure: "server",
                  location: {
                    path: privatePathMarker,
                    start: { line: 0, column: 0 },
                    end: { line: 0, column: 1 },
                  },
                  evidence: [],
                },
              ],
              uses: [],
            },
          ],
          dynamicLookups: [],
          scopeCoverage: [],
        },
      },
      { id: "worker", state: "incomplete", diagnostics: [] },
    ],
    deployments: [
      {
        id: "production",
        repositoryIds: ["api", "worker"],
        state: "incomplete",
        sharedKeys: [{ namespace: "env", name: "DATABASE_URL" }],
        diagnostics: [],
        members: [
          { repositoryId: "api", state: "complete", diagnostics: [] },
          { repositoryId: "worker", state: "incomplete", diagnostics: [] },
        ],
      },
    ],
  };

  const viewer = await startLocalReportViewer(
    workspaceReportToViewerRequest(report, undefined),
  );
  t.after(() => viewer.close());
  const page = await request(viewer);
  assert.equal(page.includes(privatePathMarker), false);
  assert.match(page, /"label":"api"/u);
  assert.match(page, /"label":"worker"/u);
  assert.match(page, /"label":"Deployments"/u);
  assert.match(page, /env:DATABASE_URL/u);
  assert.match(page, /"label":"production"/u);
  assert.match(page, /"label":"member-api"/u);
  assert.match(page, /"label":"member-worker"/u);
});

test("viewer repository limit includes the synthetic deployments repository", () => {
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 100, deployments: 1, incomplete: false },
    repositories: Array.from({ length: 100 }, (_, index) => ({
      id: "repository-" + String(index + 1),
      state: "complete" as const,
      diagnostics: [],
    })),
    deployments: [{
      id: "production",
      repositoryIds: [],
      state: "complete",
      sharedKeys: [],
      diagnostics: [],
      members: [],
    }],
  };

  assert.throws(
    () => workspaceReportToViewerRequest(report, undefined),
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED",
  );
});

test("viewer result limit includes each synthetic repository Overview row", () => {
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 1, deployments: 0, incomplete: false },
    repositories: [{
      id: "api",
      state: "complete",
      diagnostics: [],
      report: {
        schemaVersion: "secret-reference-inventory/report/v1",
        groups: Array.from({ length: 1_000 }, (_, index) => ({
          key: { namespace: "env" as const, name: "KEY_" + String(index + 1) },
          shared: false,
          consumers: [],
          sources: [],
          uses: [],
        })),
        dynamicLookups: [],
        scopeCoverage: [],
      },
    }],
    deployments: [],
  };

  assert.throws(
    () => workspaceReportToViewerRequest(report, undefined),
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_RESULT_LIMIT_EXCEEDED",
  );
});

test("viewer result limit includes each deployment member partition row", () => {
  const memberIds = Array.from({ length: 1_000 }, (_, index) => "member-" + String(index + 1));
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 0, deployments: 1, incomplete: false },
    repositories: [],
    deployments: [{
      id: "production",
      repositoryIds: memberIds,
      state: "complete",
      sharedKeys: [],
      diagnostics: [],
      members: memberIds.map((repositoryId) => ({
        repositoryId,
        state: "complete" as const,
        diagnostics: [],
      })),
    }],
  };

  assert.throws(
    () => workspaceReportToViewerRequest(report, undefined),
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_RESULT_LIMIT_EXCEEDED",
  );
});

test("workspace request construction never forwards path-like or structured short credential labels", async (t) => {
  const credentialLike = "env:sk_live_short";
  const pathLike = "/private/deployment-config";
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 1, deployments: 1, incomplete: false },
    repositories: [{
      id: credentialLike,
      state: "complete",
      diagnostics: [],
    }],
    deployments: [{
      id: pathLike,
      repositoryIds: [],
      state: "complete",
      sharedKeys: [],
      diagnostics: [],
      members: [],
    }],
  };

  const viewer = await startLocalReportViewer(
    workspaceReportToViewerRequest(report, undefined),
  );
  t.after(() => viewer.close());
  const page = await request(viewer);
  assert.equal(page.includes(credentialLike), false);
  assert.equal(page.includes(pathLike), false);
  assert.match(page, /"label":"repository-1"/u);
  assert.match(page, /"label":"deployment-1"/u);
});

async function request(viewer: LocalReportViewer): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(viewer.url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}
