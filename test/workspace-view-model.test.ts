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

test("workspace viewer model supports repository/result navigation without source data",
  /**
   * Exercises the “workspace viewer model supports repository/result navigation without source data” scenario through `startLocalReportViewer`, `workspaceReportToViewerRequest`, `after`, `close`, `request`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace viewer model supports repository/result navigation without source data”.
   * Outputs: Normal completion only after the “workspace viewer model supports repository/result navigation without source data” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads code/provisioning sources nor serves an externally reachable address; it converts supplied report data and controls only the test-local viewer.
   * Side effects: Drives the loopback test resource through `startLocalReportViewer`, `workspaceReportToViewerRequest`, `after`, `close`, `request`.
   */
  async (t) => {
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
  t.after(
    /**
     * Registers loopback viewer-server shutdown after the navigation test finishes.
     *
     * Inputs: no arguments.
     * Outputs: The promise returned by `viewer.close`, consumed by the Node test cleanup hook.
     * Does not handle: Deleting files, creating another viewer, or altering assertion results.
     * Side effects: Initiates closure of this viewer's HTTP server.
     */
    () => viewer.close());
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

test("viewer repository limit includes the synthetic deployments repository",
  /**
   * Exercises the “viewer repository limit includes the synthetic deployments repository” scenario through `from`, `String`, `throws`, `workspaceReportToViewerRequest`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “viewer repository limit includes the synthetic deployments repository”.
   * Outputs: Normal completion only after the “viewer repository limit includes the synthetic deployments repository” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads code/provisioning sources nor starts a listener; it converts supplied test report data only into a viewer request.
   * Side effects: Runs assertions through `from`, `String`, `throws`, `workspaceReportToViewerRequest`; assertion failures escape.
   */
  () => {
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 100, deployments: 1, incomplete: false },
    repositories: Array.from({ length: 100 },
      /**
       * Builds one complete repository report entry used to cross the viewer repository cap.
       *
       * Inputs: `_`, `index`.
       * Outputs: A distinct complete repository object named from the zero-based `index`.
       * Does not handle: Adding deployments, checking the cap, or mutating the input array.
       * Side effects: Allocates the one in-memory fixture object.
       */
      (_, index) => ({
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
    /**
     * Triggers the expected assertion failure.
     *
     * Inputs: no arguments.
     * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
     * Does not handle: decide whether the captured failure matches the assertion.
     * Side effects: executes `workspaceReportToViewerRequest(report, undefined)`.
     */
    () => workspaceReportToViewerRequest(report, undefined),
    /**
     * Matches the exact viewer error emitted when the synthetic deployments row exceeds the repository cap.
     *
     * Inputs: `error`.
     * Outputs: True only for `VIEWER_REPOSITORY_LIMIT_EXCEEDED` viewer request errors.
     * Does not handle: Throwing the error, matching unrelated failures, or starting a viewer.
     * Side effects: Uses `instanceof` and reads the error code without mutation or I/O.
     */
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED",
  );
});

test("viewer result limit includes each synthetic repository Overview row",
  /**
   * Exercises the “viewer result limit includes each synthetic repository Overview row” scenario through `from`, `String`, `throws`, `workspaceReportToViewerRequest`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “viewer result limit includes each synthetic repository Overview row”.
   * Outputs: Normal completion only after the “viewer result limit includes each synthetic repository Overview row” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads code/provisioning sources nor starts a listener; it converts supplied test report data only into a viewer request.
   * Side effects: Runs assertions through `from`, `String`, `throws`, `workspaceReportToViewerRequest`; assertion failures escape.
   */
  () => {
  const report: WorkspaceJsonReport = {
    schemaVersion: "secret-reference-inventory/workspace-report/v2",
    summary: { repositories: 1, deployments: 0, incomplete: false },
    repositories: [{
      id: "api",
      state: "complete",
      diagnostics: [],
      report: {
        schemaVersion: "secret-reference-inventory/report/v1",
        groups: Array.from({ length: 1_000 },
          /**
           * Builds one empty secret-result group so the test reaches the viewer result-row cap.
           *
           * Inputs: `_`, `index`.
           * Outputs: A single nonshared empty group with a unique `env:KEY_<n>` key.
           * Does not handle: Validating report brands, adding references, or checking result limits.
           * Side effects: Allocates an in-memory group and key object.
           */
          (_, index) => ({
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
    /**
     * Triggers the expected assertion failure.
     *
     * Inputs: no arguments.
     * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
     * Does not handle: decide whether the captured failure matches the assertion.
     * Side effects: executes `workspaceReportToViewerRequest(report, undefined)`.
     */
    () => workspaceReportToViewerRequest(report, undefined),
    /**
     * Matches the viewer error raised when synthetic repository overview rows exceed the result cap.
     *
     * Inputs: `error`.
     * Outputs: True only for `VIEWER_RESULT_LIMIT_EXCEEDED` viewer request errors.
     * Does not handle: Throwing the error, matching another failure, or materializing HTML.
     * Side effects: Uses `instanceof` and reads the error code without mutation or I/O.
     */
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_RESULT_LIMIT_EXCEEDED",
  );
});

test("viewer result limit includes each deployment member partition row",
  /**
   * Exercises the “viewer result limit includes each deployment member partition row” scenario through `from`, `String`, `map`, `throws`, `workspaceReportToViewerRequest`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “viewer result limit includes each deployment member partition row”.
   * Outputs: Normal completion only after the “viewer result limit includes each deployment member partition row” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads code/provisioning sources nor starts a listener; it converts supplied test report data only into a viewer request.
   * Side effects: Runs assertions through `from`, `String`, `map`, `throws`, `workspaceReportToViewerRequest`; assertion failures escape.
   */
  () => {
  const memberIds = Array.from({ length: 1_000 },
    /**
     * Produces a unique member ID used to create one thousand deployment partitions.
     *
     * Inputs: `_`, `index`.
     * Outputs: The deterministic `member-<n>` identifier for the supplied index.
     * Does not handle: Building member objects, checking viewer limits, or accessing other indices.
     * Side effects: Allocates the identifier string.
     */
    (_, index) => "member-" + String(index + 1));
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
      members: memberIds.map(
        /**
         * Converts one generated member ID into the matching complete deployment-member record.
         *
         * Inputs: `repositoryId`.
         * Outputs: An in-memory complete member record retaining `repositoryId`.
         * Does not handle: Creating repository rows, adding diagnostics, or checking the viewer cap.
         * Side effects: Allocates the member record.
         */
        (repositoryId) => ({
        repositoryId,
        state: "complete" as const,
        diagnostics: [],
      })),
    }],
  };

  assert.throws(
    /**
     * Triggers the expected assertion failure.
     *
     * Inputs: no arguments.
     * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
     * Does not handle: decide whether the captured failure matches the assertion.
     * Side effects: executes `workspaceReportToViewerRequest(report, undefined)`.
     */
    () => workspaceReportToViewerRequest(report, undefined),
    /**
     * Matches the viewer error raised when deployment-member partitions exceed the result cap.
     *
     * Inputs: `error`.
     * Outputs: True only for `VIEWER_RESULT_LIMIT_EXCEEDED` viewer request errors.
     * Does not handle: Throwing the error, matching a different failure, or starting a server.
     * Side effects: Uses `instanceof` and reads the error code without mutation or I/O.
     */
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_RESULT_LIMIT_EXCEEDED",
  );
});

test("workspace request construction never forwards path-like or structured short credential labels",
  /**
   * Exercises the “workspace request construction never forwards path-like or structured short credential labels” scenario through `startLocalReportViewer`, `workspaceReportToViewerRequest`, `after`, `close`, `request`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace request construction never forwards path-like or structured short credential labels”.
   * Outputs: Normal completion only after the “workspace request construction never forwards path-like or structured short credential labels” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads code/provisioning sources nor serves an externally reachable address; it converts supplied report data and controls only the test-local viewer.
   * Side effects: Drives the loopback test resource through `startLocalReportViewer`, `workspaceReportToViewerRequest`, `after`, `close`, `request`.
   */
  async (t) => {
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
  t.after(
    /**
     * Registers closure of the label-redaction test's loopback viewer server.
     *
     * Inputs: no arguments.
     * Outputs: The `viewer.close` promise, owned by the Node test cleanup hook.
     * Does not handle: Deleting fixture paths, generating another request, or determining test status.
     * Side effects: Begins HTTP-server shutdown for the local viewer.
     */
    () => viewer.close());
  const page = await request(viewer);
  assert.equal(page.includes(credentialLike), false);
  assert.equal(page.includes(pathLike), false);
  assert.match(page, /"label":"repository-1"/u);
  assert.match(page, /"label":"deployment-1"/u);
});

/**
 * Fetches and buffers the local viewer page used for navigation and redaction assertions.
 *
 * Inputs: `viewer`.
 * Outputs: A promise resolving to the complete viewer response decoded as UTF-8.
 * Does not handle: Redirect policy, HTTP status validation, or page-content assertions.
 * Side effects: Starts a loopback HTTP GET and installs response/error listeners.
 */
async function request(viewer: LocalReportViewer): Promise<string> {
  return new Promise(
    /**
     * Connects one local HTTP request to a promise.
     *
     * Inputs: `resolve`, `reject`.
     * Outputs: `void`; the enclosing promise settles only through its supplied `resolve` or `reject`.
     * Does not handle: return a response value itself or decode response chunks.
     * Side effects: starts the request, installs listeners, and invokes the promise settlement functions.
     */
    (resolve, reject) => {
    const request = get(viewer.url,
      /**
       * Installs listeners that buffer one viewer HTTP response and settle the enclosing request promise.
       *
       * Inputs: `response`.
       * Outputs: `void`; the registered event handlers later resolve a UTF-8 page or reject on response error.
       * Does not handle: Starting an additional request, checking redaction, or retaining buffers after resolution.
       * Side effects: Adds data/error/end listeners and captures received buffers in `chunks`.
       */
      (response) => {
      const chunks: Buffer[] = [];
      response.on("data",
        /**
         * Stores one response chunk.
         *
         * Inputs: `chunk`.
         * Outputs: the numeric `Array#push` length, ignored by EventEmitter listener dispatch.
         * Does not handle: decode the chunk, concatenate the body, or settle the request promise.
         * Side effects: appends the received chunk to `chunks`.
         */
        (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end",
        /**
         * Completes one local HTTP response.
         *
         * Inputs: no arguments.
         * Outputs: `void`; `resolve` settles the request promise with the assembled response.
         * Does not handle: open another request or retain the response beyond this assembly.
         * Side effects: concatenates captured chunks and invokes `resolve`.
         */
        () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}
