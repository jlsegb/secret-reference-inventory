import assert from "node:assert/strict";
import test from "node:test";

import type {
  SafeDiagnosticCode,
  SafeIdentifier,
} from "../src/core/index.js";
import {
  WORKSPACE_REPORT_SCHEMA_VERSION,
  buildWorkspaceJsonReport,
  renderWorkspaceJson,
  renderWorkspaceTerminal,
  type WorkspaceReportingInput,
} from "../src/reporters/index.js";

const id =
  /**
   * Brands a fixture identifier accepted by the workspace reporter input type.
   *
   * Inputs: `value`.
   * Outputs: The supplied fixture string as `SafeIdentifier`.
   * Does not handle: Runtime identifier validation or report construction.
   * Side effects: None; the TypeScript assertion has no runtime operation.
   */
  (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic =
  /**
   * Brands a fixture diagnostic accepted by the workspace reporter input type.
   *
   * Inputs: `value`.
   * Outputs: The supplied fixture string as `SafeDiagnosticCode`.
   * Does not handle: Runtime diagnostic validation or report construction.
   * Side effects: None; the TypeScript assertion has no runtime operation.
   */
  (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;

test("workspace reports are deterministic, versioned, and sort independent results",
  /**
 * Renders one deliberately unsorted API/worker reporting input twice and compares both JSON and terminal projections.
 * Inputs: No callback arguments; builds incomplete worker/production records with duplicate and unsorted `DATABASE_URL`/`API_KEY` shared keys and member IDs.
 * Outputs: Returns after JSON is byte-stable, v2/versioned, sorted by repository/member/key, omits raw nested reports, and terminal output marks the incomplete worker summary.
 * Does not handle: Scanner execution, serialization of unsafe brands, or recovery from reporter/assertion failures.
 * Side effects: Allocates a local reporting input and rendered strings; thrown reporter errors and failed assertions propagate.
 */
  () => {
  const input: WorkspaceReportingInput = {
    repositories: [
      {
        id: id("worker"),
        state: "incomplete",
        diagnostics: [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")],
      },
      { id: id("api"), state: "complete" },
    ],
    deployments: [
      {
        id: id("production"),
        repositoryIds: [id("worker"), id("api")],
        state: "incomplete",
        sharedKeys: [
          { namespace: "env", name: id("DATABASE_URL") },
          { namespace: "env", name: id("API_KEY") },
          { namespace: "env", name: id("DATABASE_URL") },
        ],
        members: [
          { repositoryId: id("worker"), state: "incomplete" },
          { repositoryId: id("api"), state: "complete" },
        ],
      },
    ],
  };

  const first = renderWorkspaceJson(input);
  const second = renderWorkspaceJson(input);
  assert.equal(first, second);

  const report = buildWorkspaceJsonReport(input);
  assert.equal(report.schemaVersion, WORKSPACE_REPORT_SCHEMA_VERSION);
  assert.deepEqual(report.repositories.map(
    /**
     * Collects emitted repository IDs to assert the reporter's deterministic sort order.
     *
     * Inputs: `repository`.
     * Outputs: The current serialized repository's `id`.
     * Does not handle: Sorting, inspecting sibling records, or updating the outer assertion.
     * Side effects: Reads one report field without mutation or I/O.
     */
    (repository) => repository.id), ["api", "worker"]);
  assert.equal(report.summary.incomplete, true);
  assert.deepEqual(report.deployments[0]?.repositoryIds, ["api", "worker"]);
  assert.deepEqual(
    report.deployments[0]?.sharedKeys.map(
      /**
       * Collects each sorted shared-key name for the deterministic-output assertion.
       *
       * Inputs: `key`.
       * Outputs: The current shared key's `name`.
       * Does not handle: Sorting shared keys, inspecting other keys, or evaluating the assertion.
       * Side effects: Reads one key property without mutation or I/O.
       */
      (key) => key.name),
    ["API_KEY", "DATABASE_URL"],
  );
  assert.deepEqual(
    report.deployments[0]?.members.map(
      /**
       * Collects deployment member IDs to assert the reporter preserves sorted membership.
       *
       * Inputs: `member`.
       * Outputs: The current member's `repositoryId`.
       * Does not handle: Sorting members, inspecting other members, or evaluating the assertion.
       * Side effects: Reads one member property without mutation or I/O.
       */
      (member) => member.repositoryId),
    ["api", "worker"],
  );
  assert.equal("report" in (report.deployments[0] ?? {}), false);
  const terminal = renderWorkspaceTerminal(input);
  assert.match(terminal, /    api  complete  groups=0  dynamic=0/u);
  assert.match(terminal, /    worker  incomplete  groups=0  dynamic=0/u);
  assert.match(terminal, /One or more workspace results are incomplete/u);
});

test("workspace reporter rejects contradictory deployment member identities",
  /**
 * Builds a production deployment whose two member records both identify `api`.
 * Inputs: No callback arguments; supplies an otherwise minimal invalid reporting input with one declared repository ID and duplicate member entries.
 * Outputs: Returns only when `buildWorkspaceJsonReport` throws `WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER`.
 * Does not handle: Repairing duplicate members, rendering a partial report, or catching a mismatched error.
 * Side effects: Allocates the invalid input and invokes the reporter inside `assert.throws`; any unexpected return or error escapes the assertion.
 */
  () => {
  const input: WorkspaceReportingInput = {
    repositories: [],
    deployments: [{
      id: id("production"),
      repositoryIds: [id("api")],
      state: "invalid",
      sharedKeys: [],
      members: [
        { repositoryId: id("api"), state: "invalid" },
        { repositoryId: id("api"), state: "invalid" },
      ],
    }],
  };

  assert.throws(
    /**
     * Invokes the reporter with duplicate deployment-member identities to exercise its duplicate-member rejection.
     *
     * Inputs: no arguments.
     * Outputs: Does not normally return because the reporter rejects the duplicate members; an unexpected report is returned to `assert.throws`.
     * Does not handle: Matching the thrown error, repairing the invalid input, or rendering a report.
     * Side effects: Calls the reporter with the local invalid input; it performs no I/O.
     */
    () => buildWorkspaceJsonReport(input),
    /**
     * Accepts only the reporter's duplicate-member validation error.
     *
     * Inputs: `error`.
     * Outputs: True when the thrown value has the expected duplicate-member message.
     * Does not handle: Throwing the error, testing unrelated failures, or formatting a report.
     * Side effects: Performs an `instanceof` check and reads `message`; it does not mutate input or perform I/O.
     */
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER",
  );
});

test("workspace reporter rejects duplicate declared deployment repository identities",
  /**
 * Builds a deployment whose declared `repositoryIds` repeats `api` while its member list is singular.
 * Inputs: No callback arguments; constructs one invalid production input with no repository report entries and duplicate declared IDs.
 * Outputs: Returns only when `buildWorkspaceJsonReport` throws `WORKSPACE_REPORT_INVALID_INPUT`.
 * Does not handle: Deduplicating declarations, creating a report after validation failure, or handling a different exception.
 * Side effects: Allocates the invalid input and runs the reporter under `assert.throws`; failures propagate.
 */
  () => {
  const input: WorkspaceReportingInput = {
    repositories: [],
    deployments: [{
      id: id("production"),
      repositoryIds: [id("api"), id("api")],
      state: "invalid",
      sharedKeys: [],
      members: [{ repositoryId: id("api"), state: "invalid" }],
    }],
  };

  assert.throws(
    /**
     * Invokes the reporter with duplicate declared repository identities to exercise its invalid-input rejection.
     *
     * Inputs: no arguments.
     * Outputs: Does not normally return because the reporter rejects the duplicate declarations; an unexpected report is returned to `assert.throws`.
     * Does not handle: Matching the thrown error, deduplicating declarations, or rendering a report.
     * Side effects: Calls the reporter with the local invalid input; it performs no I/O.
     */
    () => buildWorkspaceJsonReport(input),
    /**
     * Accepts only the reporter's invalid-input error for duplicate declared repositories.
     *
     * Inputs: `error`.
     * Outputs: True when the thrown value has the expected invalid-input message.
     * Does not handle: Throwing the error, testing unrelated failures, or constructing a report.
     * Side effects: Performs an `instanceof` check and reads `message`; it does not mutate input or perform I/O.
     */
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_INVALID_INPUT",
  );
});

test("workspace reporter redacts malformed safe brands instead of serializing a sentinel",
  /**
 * Attempts to render a repository ID branded from a Stripe-shaped sentinel string.
 * Inputs: No callback arguments; constructs a one-repository reporting input with the malformed branded identifier and no deployments.
 * Outputs: Returns after rendered JSON excludes the sentinel and contains `<opaque>` instead.
 * Does not handle: Validating the forged brand at construction time, redacting external logs, or catching renderer/assertion failure.
 * Side effects: Allocates the sentinel/input/output string and performs leak assertions; failures propagate.
 */
  () => {
  const sentinel = "sk_live_51Jf2QfZxR3AqVbC8NwY";
  const input: WorkspaceReportingInput = {
    repositories: [{ id: id(sentinel), state: "invalid" }],
    deployments: [],
  };

  const output = renderWorkspaceJson(input);
  assert.equal(output.includes(sentinel), false);
  assert.match(output, /<opaque>/u);
});
