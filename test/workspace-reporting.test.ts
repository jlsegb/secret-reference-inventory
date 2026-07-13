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

const id =
  /**
   * Brands a fixture identifier for reporting-adapter input.
   *
   * Inputs: `value`.
   * Outputs: The supplied string typed as `SafeIdentifier` for this test's trusted fixture input.
   * Does not handle: Validating identifier grammar or producing a runtime-safe brand.
   * Side effects: None; TypeScript erases the assertion at runtime.
   */
  (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic =
  /**
   * Brands a fixture diagnostic code for reporting-adapter input.
   *
   * Inputs: `value`.
   * Outputs: The supplied string typed as `SafeDiagnosticCode` for this test's trusted fixture input.
   * Does not handle: Validating diagnostic-code grammar or producing a runtime-safe brand.
   * Side effects: None; TypeScript erases the assertion at runtime.
   */
  (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const reconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("N3 scan reporting adapter accepts only normalized result facts",
  /**
 * Verifies the callback behavior for “N3 scan reporting adapter accepts only normalized result facts”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `id`, `diagnostic`, `workspaceScanToReportingInput`, `equal`, `deepEqual`, `map`.
 * Outputs: It returns normally only after 5 equal, 1 deepEqual assertion groups establish “N3 scan reporting adapter accepts only normalized result facts”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Node’s test runner owns registration, timeout policy, and any test-context cleanup hooks.
 * Side effects: Runs assertions and reads test-local state. Failures are not caught.
 */
  () => {
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
    input.deployments[0]?.members.map(
      /**
       * Extracts the normalized member identifier to verify the reporting adapter preserves it.
       *
       * Inputs: `member`.
       * Outputs: This member's `repositoryId`, in source order for the deep-equality assertion.
       * Does not handle: Inspecting other members, validating the report, or changing the assertion target.
       * Side effects: Reads one member property without mutating it or performing I/O.
       */
      (member) => member.repositoryId),
    ["api"],
  );
  assert.equal("report" in (input.deployments[0] ?? {}), false);
  assert.equal("manifestPath" in input, false);
});
