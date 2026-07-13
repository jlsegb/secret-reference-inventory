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

test("workspace reports are deterministic, versioned, and sort independent results",
  /**
   * Exercises the “workspace reports are deterministic, versioned, and sort independent results” scenario through `id`, `diagnostic`, `renderWorkspaceJson`, `equal`, `buildWorkspaceJsonReport`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace reports are deterministic, versioned, and sort independent results”.
   * Outputs: Normal completion only after the “workspace reports are deterministic, versioned, and sort independent results” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither scans a workspace nor writes a report file; it validates pure report construction and serialization from supplied safe facts.
   * Side effects: Runs assertions through `id`, `diagnostic`, `renderWorkspaceJson`, `equal`, `buildWorkspaceJsonReport`; assertion failures escape.
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
     * Projects a report value from the current repository.
     *
     * Inputs: `repository`.
     * Outputs: the `repository.id` result consumed by `report.repositories.map`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (repository) => repository.id), ["api", "worker"]);
  assert.equal(report.summary.incomplete, true);
  assert.deepEqual(report.deployments[0]?.repositoryIds, ["api", "worker"]);
  assert.deepEqual(
    report.deployments[0]?.sharedKeys.map(
      /**
       * Projects a report value from the current key.
       *
       * Inputs: `key`.
       * Outputs: the `key.name` result consumed by `report.deployments[0]?.sharedKeys.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (key) => key.name),
    ["API_KEY", "DATABASE_URL"],
  );
  assert.deepEqual(
    report.deployments[0]?.members.map(
      /**
       * Projects a report value from the current member.
       *
       * Inputs: `member`.
       * Outputs: the `member.repositoryId` result consumed by `report.deployments[0]?.members.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
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
   * Exercises the “workspace reporter rejects contradictory deployment member identities” scenario through `id`, `throws`, `buildWorkspaceJsonReport`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace reporter rejects contradictory deployment member identities”.
   * Outputs: Normal completion only after the “workspace reporter rejects contradictory deployment member identities” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither scans a workspace nor writes a report file; it validates pure report construction and serialization from supplied safe facts.
   * Side effects: Runs assertions through `id`, `throws`, `buildWorkspaceJsonReport`; assertion failures escape.
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
     * Triggers the expected assertion failure.
     *
     * Inputs: no arguments.
     * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
     * Does not handle: decide whether the captured failure matches the assertion.
     * Side effects: executes `buildWorkspaceJsonReport(input)`.
     */
    () => buildWorkspaceJsonReport(input),
    /**
     * Verifies “workspace reporter rejects contradictory deployment member identities”.
     *
     * Inputs: `error`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs no helper.
     */
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER",
  );
});

test("workspace reporter rejects duplicate declared deployment repository identities",
  /**
   * Exercises the “workspace reporter rejects duplicate declared deployment repository identities” scenario through `id`, `throws`, `buildWorkspaceJsonReport`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace reporter rejects duplicate declared deployment repository identities”.
   * Outputs: Normal completion only after the “workspace reporter rejects duplicate declared deployment repository identities” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither scans a workspace nor writes a report file; it validates pure report construction and serialization from supplied safe facts.
   * Side effects: Runs assertions through `id`, `throws`, `buildWorkspaceJsonReport`; assertion failures escape.
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
     * Triggers the expected assertion failure.
     *
     * Inputs: no arguments.
     * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
     * Does not handle: decide whether the captured failure matches the assertion.
     * Side effects: executes `buildWorkspaceJsonReport(input)`.
     */
    () => buildWorkspaceJsonReport(input),
    /**
     * Verifies “workspace reporter rejects duplicate declared deployment repository identities”.
     *
     * Inputs: `error`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs no helper.
     */
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_INVALID_INPUT",
  );
});

test("workspace reporter redacts malformed safe brands instead of serializing a sentinel",
  /**
   * Exercises the “workspace reporter redacts malformed safe brands instead of serializing a sentinel” scenario through `id`, `renderWorkspaceJson`, `equal`, `includes`, `match`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace reporter redacts malformed safe brands instead of serializing a sentinel”.
   * Outputs: Normal completion only after the “workspace reporter redacts malformed safe brands instead of serializing a sentinel” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither scans a workspace nor writes a report file; it validates pure report construction and serialization from supplied safe facts.
   * Side effects: Runs assertions through `id`, `renderWorkspaceJson`, `equal`, `includes`, `match`; assertion failures escape.
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
