import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReconciliationResult,
  SafeDiagnosticCode,
  SafeIdentifier,
} from "../src/core/index.js";
import {
  workspaceScanToReportingInput,
  type WorkspaceScanReportSource,
} from "../src/app/index.js";

const id = (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic = (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const reconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("N3 scan reporting adapter accepts only normalized result facts", () => {
  const scan: WorkspaceScanReportSource = {
    repositories: [
      {
        id: id("api"),
        status: "complete",
        diagnostics: [],
        reconciliation,
        references: [],
        demandEdges: [],
        dynamicLookupEdges: [],
      },
    ],
    deployments: [
      {
        id: id("production"),
        status: "incomplete",
        diagnostics: [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")],
        repositoryIds: [id("api")],
        sharedKeys: [{ namespace: "env", name: id("DATABASE_URL") }],
        members: [{
          repositoryId: id("api"),
          status: "incomplete",
          diagnostics: [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")],
          reconciliation,
          references: [],
          demandEdges: [],
          dynamicLookupEdges: [],
        }],
      },
    ],
  };

  const input = workspaceScanToReportingInput(scan);
  assert.equal(input.repositories[0]?.id, "api");
  assert.equal(input.deployments[0]?.id, "production");
  assert.equal(input.deployments[0]?.sharedKeys[0]?.name, "DATABASE_URL");
  assert.deepEqual(
    input.deployments[0]?.members.map((member) => member.repositoryId),
    ["api"],
  );
  assert.equal("report" in (input.deployments[0] ?? {}), false);
  assert.equal("manifestPath" in input, false);
});
