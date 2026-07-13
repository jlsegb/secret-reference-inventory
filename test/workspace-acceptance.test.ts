import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import { createLocalCliHandlers } from "../src/app/index.js";
import { runCli } from "../src/cli/index.js";
import type { WorkspaceJsonReport } from "../src/reporters/index.js";
import {
  startLocalReportViewer,
  type LocalReportViewer,
} from "../src/viewer/index.js";

import {
  withWorkspaceFixture,
  writeFixtureLayout,
  type WorkspaceFixture,
} from "./helpers/workspace-fixture.js";

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one workspace CLI request while capturing both output streams.
 *
 * Inputs: CLI `args` and optional handler overrides forwarded to `createLocalCliHandlers`.
 * Outputs: A promise resolving to the CLI exit status and joined stdout and stderr text.
 * Does not handle: Writing to process streams, launching a browser, or converting the captured text to a workspace report.
 * Side effects: Calls `runCli`; its synchronous stdout and stderr hooks append chunks to private arrays before joining them.
 */
async function runWorkspaceCli(
  args: readonly string[],
  options: Parameters<typeof createLocalCliHandlers>[0] = {},
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runCli(args, createLocalCliHandlers(options), {
    stdout:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `stdout`.
       */
      (text) => stdout.push(text),
    stderr:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `stderr`.
       */
      (text) => stderr.push(text),
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

/**
 * Parses JSON-mode CLI output into the workspace report shape used by acceptance assertions.
 *
 * Inputs: `run`.
 * Outputs: The parsed `WorkspaceJsonReport` represented by captured stdout.
 * Does not handle: Schema validation, malformed JSON recovery, or redaction checks.
 * Side effects: Invokes `JSON.parse`, which may throw a syntax error.
 */
function parseWorkspaceReport(run: CliRun): WorkspaceJsonReport {
  return JSON.parse(run.stdout) as WorkspaceJsonReport;
}

/**
 * Locates a named repository record and fails the acceptance test if it is absent.
 *
 * Inputs: `report`, `id`.
 * Outputs: The repository record whose ID matches `id`.
 * Does not handle: Normalizing IDs, selecting deployments, or recovering a missing record.
 * Side effects: Searches the report and throws through `assert.notEqual` when no match exists.
 */
function findRepository(report: WorkspaceJsonReport, id: string) {
  const entry = report.repositories.find(
    /**
     * Selects the repository record whose serialized ID matches the requested fixture ID.
     *
     * Inputs: `candidate`.
     * Outputs: True only for the matching repository candidate.
     * Does not handle: Asserting that a match exists, searching another collection, or normalizing IDs.
     * Side effects: Reads the candidate ID without mutation or I/O.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected repository " + id);
  return entry;
}

/**
 * Locates a named deployment record and fails the acceptance test if it is absent.
 *
 * Inputs: `report`, `id`.
 * Outputs: The deployment record whose ID matches `id`.
 * Does not handle: Normalizing IDs, selecting repositories, or recovering a missing record.
 * Side effects: Searches the report and throws through `assert.notEqual` when no match exists.
 */
function findDeployment(report: WorkspaceJsonReport, id: string) {
  const entry = report.deployments.find(
    /**
     * Selects the deployment record whose serialized ID matches the requested fixture ID.
     *
     * Inputs: `candidate`.
     * Outputs: True only for the matching deployment candidate.
     * Does not handle: Asserting that a match exists, searching repositories, or normalizing IDs.
     * Side effects: Reads the candidate ID without mutation or I/O.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected deployment " + id);
  return entry;
}

/**
 * Asserts that a CLI/UI text result contains none of this fixture's private path markers.
 *
 * Inputs: `text`, `fixture`.
 * Outputs: `void` if the output leaks neither root, manifest path, nor private source marker.
 * Does not handle: Redacting the text, checking unrelated secrets, or recovering failed assertions.
 * Side effects: Reads substrings and throws through strict assertions on a leak.
 */
function assertNoFixtureLeak(text: string, fixture: WorkspaceFixture): void {
  assert.equal(text.includes(fixture.root), false);
  assert.equal(text.includes(fixture.manifestPath), false);
  assert.equal(text.includes(fixture.privateSourceMarker), false);
}

test("workspace CLI keeps duplicate keys separate until deployment sharing is explicit",
  /**
 * Runs the fixture through unrelated, shared, and terminal workspace CLI scans using its inner fixture callback.
 * Inputs: No callback arguments; creates the default multi-repository fixture through `withWorkspaceFixture`.
 * Outputs: Resolves after the callback proves require-complete returns status 2 for broken/dynamic data, the shared rewrite yields only `DATABASE_URL`, and terminal output remains leak-free.
 * Does not handle: Fixture creation internals, external CLI processes, or recovery from CLI/parser/assertion failures.
 * Side effects: `withWorkspaceFixture` creates and finally removes the temporary tree; callback file writes and failures propagate.
 */
  async () => {
  await withWorkspaceFixture(
    /**
     * Drives the isolated manifest through CLI scans and asserts deployment-sharing boundaries.
     *
     * Inputs: `fixture`.
     * Outputs: Resolves after the JSON and terminal assertions establish the intended CLI sharing boundaries.
     * Does not handle: Creating or disposing the fixture, reading an external repository, or suppressing failures.
     * Side effects: Invokes the injected CLI handlers and test assertions; assertion failures reject this callback.
     */
    async (fixture) => {
    const unrelated = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "json",
      "--require-complete",
    ]);
    assert.equal(unrelated.status, 2);
    assert.equal(unrelated.stderr, "");
    assertNoFixtureLeak(unrelated.stdout, fixture);

    const unrelatedReport = parseWorkspaceReport(unrelated);
    assert.equal(findRepository(unrelatedReport, "api")?.state, "complete");
    assert.equal(findRepository(unrelatedReport, "worker")?.state, "complete");
    assert.equal(findRepository(unrelatedReport, "broken")?.state, "incomplete");
    assert.equal(findDeployment(unrelatedReport, "api-production")?.state, "complete");
    assert.equal(findDeployment(unrelatedReport, "broken-production")?.state, "incomplete");
    assert.deepEqual(findDeployment(unrelatedReport, "api-production")?.sharedKeys, []);
    assert.deepEqual(findDeployment(unrelatedReport, "worker-production")?.sharedKeys, []);

    const dynamic = findRepository(unrelatedReport, "dynamic");
    assert.equal(dynamic?.state, "incomplete");
    assert.equal(dynamic?.report?.dynamicLookups.length, 1);
    assert.equal(dynamic?.report?.dynamicLookups[0]?.domain.kind, "unbounded");
    assert.equal(dynamic?.report?.dynamicLookups[0]?.domain.reason, "user-controlled");
    assert.deepEqual(dynamic?.report?.dynamicLookups[0]?.likelyKeys, []);
    assert.equal(unrelated.stdout.includes("query.key"), false);

    await writeFixtureLayout(fixture, "shared");
    const shared = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "json",
    ]);
    assert.equal(shared.status, 0);
    assert.equal(shared.stderr, "");
    assertNoFixtureLeak(shared.stdout, fixture);

    const sharedDeployment = findDeployment(parseWorkspaceReport(shared), "shared-production");
    assert.deepEqual(sharedDeployment?.repositoryIds, ["api", "worker"]);
    assert.deepEqual(
      sharedDeployment?.members.map(
        /**
         * Extracts each shared deployment member ID for the explicit-sharing assertion.
         *
         * Inputs: `member`.
         * Outputs: The current shared member's `repositoryId`.
         * Does not handle: Adding members, sorting them, or evaluating the enclosing assertion.
         * Side effects: Reads one member field without mutation or I/O.
         */
        (member) => member.repositoryId),
      ["api", "worker"],
    );
    assert.equal("report" in (sharedDeployment ?? {}), false);
    assert.deepEqual(sharedDeployment?.sharedKeys, [
      { namespace: "env", name: "DATABASE_URL" },
    ]);

    const terminal = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "terminal",
    ]);
    assert.equal(terminal.status, 0);
    assert.match(terminal.stdout, /Workspace secret reference inventory/u);
    assertNoFixtureLeak(terminal.stdout, fixture);
  });
});

test("workspace UI serves only derived fixture data over loopback",
  /**
 * Starts the fixture-backed UI with an injected loopback viewer and delegates response checks to its fixture callback.
 * Inputs: The Node test context for registering viewer shutdown; invokes `withWorkspaceFixture` and keeps started viewers in a local array.
 * Outputs: Resolves after the callback confirms a 127.0.0.1 URL, restrictive response headers, derived repository HTML, no remote URL, and no fixture-private data.
 * Does not handle: Fixture deletion, browser navigation beyond one request, or swallowing CLI/viewer/assertion failures.
 * Side effects: Registers `Promise.all(viewer.close())` with `t.after`, starts viewer servers, mutates `launched`, and lets fixture cleanup remove the root.
 */
  async (t) => {
  await withWorkspaceFixture(
    /**
     * Starts the fixture UI, records its server handle, and asserts its loopback response is derived-only.
     *
     * Inputs: Receives `fixture` from the `withWorkspaceFixture` callback.
     * Outputs: A promise that resolves after the CLI/UI assertions; its resolved value is ignored by `withWorkspaceFixture`.
     * Does not handle: Owning fixture deletion, binding non-loopback listeners, or suppressing assertion failures.
     * Side effects: Registers server cleanup, starts an injected local viewer, performs one HTTP request, and appends its handle to `launched`.
     */
    async (fixture) => {
    const launched: LocalReportViewer[] = [];
    t.after(
      /**
       * Closes every loopback viewer server recorded during this test after it completes.
       *
       * Inputs: no arguments.
       * Outputs: A cleanup promise that resolves after all recorded viewer servers close.
       * Does not handle: Deleting the temporary fixture directory, creating viewers, or changing test assertions.
       * Side effects: Invokes each viewer's server-close operation; failures reject the registered cleanup.
       */
      async () => {
      await Promise.all(launched.map(
        /**
         * Requests shutdown of one viewer server during the test cleanup sweep.
         *
         * Inputs: `viewer`.
         * Outputs: The promise returned by this viewer's `close` method.
         * Does not handle: Closing other viewers, deleting fixture files, or deciding cleanup order.
         * Side effects: Begins closure of the viewer's HTTP server.
         */
        (viewer) => viewer.close()));
    });

    const run = await runWorkspaceCli(
      ["ui", "--manifest", fixture.manifestPath, "--port", "0"],
      {
        startViewer:
          /**
           * Starts the injected loopback viewer and retains its close handle for test cleanup.
           *
           * Inputs: `request`.
           * Outputs: The newly started `LocalReportViewer` returned to the CLI handler.
           * Does not handle: Validating viewer HTML, closing the server, or exposing a non-loopback listener.
           * Side effects: Calls `startLocalReportViewer` and appends the server handle to `launched`.
           */
          async (request) => {
          const viewer = await startLocalReportViewer(request);
          launched.push(viewer);
          return viewer;
        },
      },
    );

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assertNoFixtureLeak(run.stdout, fixture);
    const url = new URL(run.stdout.trim());
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.notEqual(url.port, "");

    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(typeof response.headers["content-security-policy"], "string");
    assert.match(String(response.headers["content-security-policy"]), /connect-src 'none'/u);
    assert.match(response.body, /aria-label="Repositories"/u);
    assert.match(response.body, /"label":"api"/u);
    assert.doesNotMatch(response.body, /https?:\/\//u);
    assertNoFixtureLeak(response.body, fixture);
  });
});

/**
 * Fetches one loopback viewer page and buffers its status, headers, and UTF-8 response body.
 *
 * Inputs: `url`.
 * Outputs: A promise for the completed HTTP status, headers, and response body.
 * Does not handle: Redirects, request timeout policy, response-size limits, or response-content validation.
 * Side effects: Starts an HTTP GET and registers response/error listeners.
 */
async function request(url: URL): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}> {
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
    const request = get(url,
      /**
       * Attaches body/error/end listeners to one HTTP response and settles the enclosing request promise.
       *
       * Inputs: `response`.
       * Outputs: `void`; later response events resolve with status, headers, and UTF-8 body or reject on error.
 * Does not handle: Starting another request, validating headers, imposing a response-size limit, or retaining chunks after settlement.
       * Side effects: Registers three response listeners, buffers data chunks, and gives event handlers access to `resolve` and `reject`.
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
        () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
