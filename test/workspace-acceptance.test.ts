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
 * Assembles the parseWorkspaceReport test value.
 *
 * Inputs: `run`.
 * Outputs: the fixture value returned by `parseWorkspaceReport`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `JSON.parse`.
 */
function parseWorkspaceReport(run: CliRun): WorkspaceJsonReport {
  return JSON.parse(run.stdout) as WorkspaceJsonReport;
}

/**
 * Assembles the findRepository test value.
 *
 * Inputs: `report`, `id`.
 * Outputs: the fixture value returned by `findRepository`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `report.repositories.find`, `assert.notEqual`.
 */
function findRepository(report: WorkspaceJsonReport, id: string) {
  const entry = report.repositories.find(
    /**
     * Tests the current candidate against the requested condition.
     *
     * Inputs: `candidate`.
     * Outputs: the `candidate.id === id` result consumed by `report.repositories.find`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected repository " + id);
  return entry;
}

/**
 * Assembles the findDeployment test value.
 *
 * Inputs: `report`, `id`.
 * Outputs: the fixture value returned by `findDeployment`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `report.deployments.find`, `assert.notEqual`.
 */
function findDeployment(report: WorkspaceJsonReport, id: string) {
  const entry = report.deployments.find(
    /**
     * Tests the current candidate against the requested condition.
     *
     * Inputs: `candidate`.
     * Outputs: the `candidate.id === id` result consumed by `report.deployments.find`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected deployment " + id);
  return entry;
}

/**
 * Assembles the assertNoFixtureLeak test value.
 *
 * Inputs: `text`, `fixture`.
 * Outputs: the completion result produced by `assertNoFixtureLeak`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `assert.equal`, `text.includes`.
 */
function assertNoFixtureLeak(text: string, fixture: WorkspaceFixture): void {
  assert.equal(text.includes(fixture.root), false);
  assert.equal(text.includes(fixture.manifestPath), false);
  assert.equal(text.includes(fixture.privateSourceMarker), false);
}

test("workspace CLI keeps duplicate keys separate until deployment sharing is explicit",
  /**
   * Exercises the “workspace CLI keeps duplicate keys separate until deployment sharing is explicit” scenario through `withWorkspaceFixture`, `runWorkspaceCli`, `equal`, `assertNoFixtureLeak`, `parseWorkspaceReport`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace CLI keeps duplicate keys separate until deployment sharing is explicit”.
   * Outputs: Normal completion only after the “workspace CLI keeps duplicate keys separate until deployment sharing is explicit” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither accesses a user workspace nor leaves a viewer alive; it confines the check to `withWorkspaceFixture`, injected CLI collaborators, and registered cleanup.
   * Side effects: Runs assertions through `withWorkspaceFixture`, `runWorkspaceCli`, `equal`, `assertNoFixtureLeak`, `parseWorkspaceReport`; assertion failures escape.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace CLI keeps duplicate keys separate until deployment sharing is explicit”.
     *
     * Inputs: `fixture`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs `runWorkspaceCli`, `assert.equal`, `assertNoFixtureLeak`, `parseWorkspaceReport`, `findRepository`, `findDeployment`.
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
         * Projects a report value from the current member.
         *
         * Inputs: `member`.
         * Outputs: the `member.repositoryId` result consumed by `sharedDeployment?.members.map`.
         * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
         * Side effects: none; it derives the current-item result.
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
   * Exercises the “workspace UI serves only derived fixture data over loopback” scenario through `withWorkspaceFixture`, `after`, `all`, `map`, `close`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace UI serves only derived fixture data over loopback”.
   * Outputs: Normal completion only after the “workspace UI serves only derived fixture data over loopback” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither accesses a user workspace nor leaves a viewer alive; it confines the check to `withWorkspaceFixture`, injected CLI collaborators, and registered cleanup.
   * Side effects: Drives the loopback test resource through `withWorkspaceFixture`, `after`, `all`, `map`, `close`.
   */
  async (t) => {
  await withWorkspaceFixture(
    /**
     * Exercises “workspace UI serves only derived fixture data over loopback” through the `withWorkspaceFixture` callback and invokes `after`, `all`, `map`, `close`, `runWorkspaceCli`.
     *
     * Inputs: Receives `fixture` from the `withWorkspaceFixture` callback.
     * Outputs: Returns the pushed-array length to the `withWorkspaceFixture` callback.
     * Does not handle: It does not create, dispose, or retain the temporary fixture; withWorkspaceFixture owns that lifecycle while this callback uses only its issued paths and test-local assertions.
     * Side effects: Starts, observes, or closes the loopback test resource through `after`, `all`, `map`, `close`, `runWorkspaceCli`.
     */
    async (fixture) => {
    const launched: LocalReportViewer[] = [];
    t.after(
      /**
       * Schedules temporary fixture removal.
       *
       * Inputs: no arguments.
       * Outputs: the cleanup promise returned by `{ await Promise.all(launched.map( (viewer) => viewer.close())); }`, registered with `t.after`.
       * Does not handle: create the temporary path or decide whether the test passes.
       * Side effects: performs the recursive filesystem removal requested by `{ await Promise.all(launched.map( (viewer) => viewer.close())); }`.
       */
      async () => {
      await Promise.all(launched.map(
        /**
         * Projects a report value from the current viewer.
         *
         * Inputs: `viewer`.
         * Outputs: the `viewer.close()` result consumed by `launched.map`.
         * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
         * Side effects: none; it derives the current-item result.
         */
        (viewer) => viewer.close()));
    });

    const run = await runWorkspaceCli(
      ["ui", "--manifest", fixture.manifestPath, "--port", "0"],
      {
        startViewer:
          /**
           * Verifies “workspace UI serves only derived fixture data over loopback”.
           *
           * Inputs: `request`.
           * Outputs: a promise that settles after its awaited workspace operations and assertions.
           * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
           * Side effects: runs `startLocalReportViewer`, `launched.push`.
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
 * Assembles the request test value.
 *
 * Inputs: `url`.
 * Outputs: the fixture value returned by `request`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `Promise`.
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
       * Derives the callback result.
       *
       * Inputs: `response`.
       * Outputs: the value of `{ const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("error", reject); response.on("end", () => { resolve({ status: response.statusCode ?? 0`.
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
