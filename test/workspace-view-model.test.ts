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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `viewer.close()`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `viewer.close()`.
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
       * Constructs one generated fixture element.
       *
       * Inputs: `_`, `index`.
       * Outputs: the `({ id: "repository-" + String(index + 1), state: "complete" as const, diagnostics: [], })` result consumed by `Array.from`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
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
     * Verifies “viewer repository limit includes the synthetic deployments repository”.
     *
     * Inputs: `error`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs no helper.
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
           * Constructs one generated fixture element.
           *
           * Inputs: `_`, `index`.
           * Outputs: the `({ key: { namespace: "env" as const, name: "KEY_" + String(index + 1) }, shared: false, consumers: [], sources: [], uses: [], })` result consumed by `Array.from`.
           * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
           * Side effects: none; it derives the current-item result.
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
     * Verifies “viewer result limit includes each synthetic repository Overview row”.
     *
     * Inputs: `error`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs no helper.
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
     * Constructs one generated fixture element.
     *
     * Inputs: `_`, `index`.
     * Outputs: the `"member-" + String(index + 1)` result consumed by `Array.from`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
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
         * Projects a report value from the current repositoryId.
         *
         * Inputs: `repositoryId`.
         * Outputs: the `({ repositoryId, state: "complete" as const, diagnostics: [], })` result consumed by `memberIds.map`.
         * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
         * Side effects: none; it derives the current-item result.
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
     * Verifies “viewer result limit includes each deployment member partition row”.
     *
     * Inputs: `error`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs no helper.
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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `viewer.close()`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `viewer.close()`.
     */
    () => viewer.close());
  const page = await request(viewer);
  assert.equal(page.includes(credentialLike), false);
  assert.equal(page.includes(pathLike), false);
  assert.match(page, /"label":"repository-1"/u);
  assert.match(page, /"label":"deployment-1"/u);
});

/**
 * Assembles the request test value.
 *
 * Inputs: `viewer`.
 * Outputs: the fixture value returned by `request`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `Promise`.
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
       * Derives the callback result.
       *
       * Inputs: `response`.
       * Outputs: the value of `{ const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("error", reject); response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8`.
       * Does not handle: orchestrate the surrounding operation after this callback returns.
       * Side effects: none; it evaluates the stated expression.
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
