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
 * Serves a report containing an internal source path through the local viewer and checks the derived navigation page.
 * Inputs: The Node test context for cleanup; constructs API/worker repository rows, a production deployment, and an API source location containing `privatePathMarker`.
 * Outputs: Resolves after the fetched page omits the internal path while exposing API, worker, deployment, member, and `env:DATABASE_URL` navigation labels.
 * Does not handle: Viewer HTML implementation, remote networking, response-size limits, or recovery from startup/request/assertion failure.
 * Side effects: Starts one loopback server, registers `viewer.close` with `t.after`, performs an HTTP request, and leaves cleanup to that hook.
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
 * Creates one hundred repository rows plus a deployment so the viewer's synthetic Deployments row crosses its repository cap.
 * Inputs: No callback arguments; builds indexed complete repository objects and one otherwise empty production deployment.
 * Outputs: Returns only when `workspaceReportToViewerRequest` throws `VIEWER_REPOSITORY_LIMIT_EXCEEDED`.
 * Does not handle: Starting a viewer, trimming the input, or accepting a report above the cap.
 * Side effects: Allocates one hundred local report rows and invokes the view-model converter inside `assert.throws`; failures propagate.
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
     * Converts the over-cap repository report so the view-model builder rejects its synthetic repository row.
     *
     * Inputs: no arguments.
     * Outputs: Does not normally return because conversion exceeds the repository limit; an unexpected viewer request is returned to `assert.throws`.
     * Does not handle: Matching the thrown error, starting a viewer, or reducing the report.
     * Side effects: Calls the in-memory view-model converter; it performs no I/O.
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
 * Builds one API report with one thousand empty key groups, whose overview row contributes to the viewer result cap.
 * Inputs: No callback arguments; constructs indexed `env:KEY_<n>` groups with no sources, uses, or consumers.
 * Outputs: Returns only when conversion rejects the report with `VIEWER_RESULT_LIMIT_EXCEEDED`.
 * Does not handle: Rendering HTML, streaming groups, or recovering from the expected converter exception.
 * Side effects: Allocates one thousand in-memory groups and calls the converter under `assert.throws`; failures propagate.
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
     * Converts the over-cap key-group report so the view-model builder rejects its synthetic overview rows.
     *
     * Inputs: no arguments.
     * Outputs: Does not normally return because conversion exceeds the result limit; an unexpected viewer request is returned to `assert.throws`.
     * Does not handle: Matching the thrown error, rendering HTML, or reducing the report.
     * Side effects: Calls the in-memory view-model converter; it performs no I/O.
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
 * Builds a production deployment containing one thousand complete member partitions to test the result-row cap.
 * Inputs: No callback arguments; derives `member-1` through `member-1000` IDs and maps each to a matching member record.
 * Outputs: Returns only when `workspaceReportToViewerRequest` throws `VIEWER_RESULT_LIMIT_EXCEEDED` for the synthetic partition rows.
 * Does not handle: Starting a server, reducing member cardinality, or accepting partial viewer input.
 * Side effects: Allocates the ID/member arrays and invokes the converter inside `assert.throws`; failures propagate.
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
     * Converts the over-cap deployment-member report so the view-model builder rejects its synthetic member rows.
     *
     * Inputs: no arguments.
     * Outputs: Does not normally return because conversion exceeds the result limit; an unexpected viewer request is returned to `assert.throws`.
     * Does not handle: Matching the thrown error, starting a viewer, or reducing member cardinality.
     * Side effects: Calls the in-memory view-model converter; it performs no I/O.
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
 * Converts path-like and credential-like report labels into a loopback viewer request and checks the served redaction result.
 * Inputs: The Node test context for cleanup; builds a report using `env:sk_live_short` as repository ID and `/private/deployment-config` as deployment ID.
 * Outputs: Resolves after the fetched page excludes both unsafe labels and substitutes `repository-1` and `deployment-1`.
 * Does not handle: Validating upstream report construction, remote HTTP, response-size caps, or retrying viewer failures.
 * Side effects: Starts a loopback viewer, registers `viewer.close` with `t.after`, fetches its page, and relies on the hook for shutdown.
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
 * Does not handle: Redirect policy, HTTP status validation, response-size limits, or page-content assertions.
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
 * Does not handle: Starting an additional request, checking redaction, imposing a response-size limit, or retaining buffers after resolution.
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
