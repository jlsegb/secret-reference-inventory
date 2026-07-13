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
   * Derives the callback result.
   *
   * Inputs: `value`.
   * Outputs: the value of `value as SafeIdentifier`.
   * Does not handle: orchestrate the surrounding operation after this callback returns.
   * Side effects: none; it evaluates the stated expression.
   */
  (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic =
  /**
   * Derives the callback result.
   *
   * Inputs: `value`.
   * Outputs: the value of `value as SafeDiagnosticCode`.
   * Does not handle: orchestrate the surrounding operation after this callback returns.
   * Side effects: none; it evaluates the stated expression.
   */
  (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const reconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("N3 scan reporting adapter accepts only normalized result facts",
  /**
   * Exercises the “N3 scan reporting adapter accepts only normalized result facts” scenario through `id`, `diagnostic`, `workspaceScanToReportingInput`, `equal`, `deepEqual`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “N3 scan reporting adapter accepts only normalized result facts”.
   * Outputs: Normal completion only after the “N3 scan reporting adapter accepts only normalized result facts” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither loads a workspace nor writes a report; it constructs reporting input solely from the provided normalized facts.
   * Side effects: Runs assertions through `id`, `diagnostic`, `workspaceScanToReportingInput`, `equal`, `deepEqual`; assertion failures escape.
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
       * Projects a report value from the current member.
       *
       * Inputs: `member`.
       * Outputs: the `member.repositoryId` result consumed by `input.deployments[0]?.members.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (member) => member.repositoryId),
    ["api"],
  );
  assert.equal("report" in (input.deployments[0] ?? {}), false);
  assert.equal("manifestPath" in input, false);
});
