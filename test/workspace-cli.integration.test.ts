import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createLocalCliHandlers,
  type WorkspaceScanPort,
  type WorkspaceScanReportSource,
} from "../src/app/index.js";
import {
  type ReconciliationResult,
  type SafeDiagnosticCode,
  type SafeIdentifier,
} from "../src/core/index.js";
import { runCli } from "../src/cli/index.js";
import { startLocalReportViewer, type LocalReportViewer } from "../src/viewer/index.js";

const id =
  /**
   * Brands a fixture repository or deployment identifier for the injected scan port.
   *
   * Inputs: `value`.
   * Outputs: The supplied test string typed as `SafeIdentifier`.
   * Does not handle: Runtime identifier validation or workspace scanning.
   * Side effects: None; the TypeScript assertion is erased at runtime.
   */
  (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic =
  /**
   * Brands a fixture diagnostic code for the injected scan port.
   *
   * Inputs: `value`.
   * Outputs: The supplied test string typed as `SafeDiagnosticCode`.
   * Does not handle: Runtime diagnostic validation or workspace scanning.
   * Side effects: None; the TypeScript assertion is erased at runtime.
   */
  (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const emptyReconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("workspace scan writes a deterministic versioned report and returns incomplete status on request",
  /**
   * Asserts the concrete test outcome “workspace scan writes a deterministic versioned report and returns incomplete status on request” after its declared setup and operation.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture, CLI, or assertion failures; those reject the test callback.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `scanPort`, `assert.equal`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the temporary manifest directory after the deterministic report test.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the directory, removing sibling fixtures, or deciding test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const status = await runCli(
    [
      "workspace",
      "scan",
      "--manifest",
      manifestPath,
      "--format",
      "json",
      "--require-complete",
    ],
    createLocalCliHandlers({ workspaceScan: scanPort("incomplete") }),
    {
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
    },
  );

  assert.equal(status, 2);
  assert.equal(stderr.join(""), "");
  const report = JSON.parse(stdout.join("")) as {
    readonly schemaVersion: string;
    readonly summary: { readonly incomplete: boolean };
    readonly repositories: readonly { readonly id: string; readonly state: string }[];
  };
  assert.equal(report.schemaVersion, "secret-reference-inventory/workspace-report/v2");
  assert.equal(report.summary.incomplete, true);
  assert.deepEqual(report.repositories.map(
    /**
     * Extracts the sole serialized repository ID for the JSON report assertion.
     *
     * Inputs: `repository`.
     * Outputs: The current serialized repository's `id`.
     * Does not handle: Sorting records, inspecting diagnostics, or evaluating the outer assertion.
     * Side effects: Reads the record ID without mutation or I/O.
     */
    (repository) => repository.id), ["api"]);
  assert.equal(stdout.join("").includes(manifestPath), false);
});

test("workspace scan uses the default N3 local port when no test port is injected",
  /**
   * Asserts the concrete test outcome “workspace scan uses the default N3 local port when no test port is injected” after its declared setup and operation.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering manifest, CLI, or assertion failures; the test runner observes them.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `assert.equal`, `stderr.join`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the temporary manifest directory after the default-port scan test.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, deleting unrelated paths, or choosing test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const status = await runCli(
    ["workspace", "scan", "--manifest", manifestPath, "--format", "json"],
    createLocalCliHandlers(),
    {
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
    },
  );

  assert.equal(status, 0);
  assert.equal(stderr.join(""), "");
  const report = JSON.parse(stdout.join("")) as {
    readonly repositories: readonly {
      readonly id: string;
      readonly state: string;
      readonly report?: { readonly schemaVersion: string };
    }[];
  };
  assert.equal(report.repositories[0]?.id, "api");
  assert.equal(report.repositories[0]?.state, "complete");
  assert.equal(
    report.repositories[0]?.report?.schemaVersion,
    "secret-reference-inventory/report/v1",
  );
});

test("workspace UI launches a loopback-only viewer from derived report data",
  /**
   * Exercises the “workspace UI launches a loopback-only viewer from derived report data” scenario through `writeManifest`, `after`, `rmParent`, `runCli`, `createLocalCliHandlers`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace UI launches a loopback-only viewer from derived report data”.
   * Outputs: Normal completion only after the “workspace UI launches a loopback-only viewer from derived report data” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither invokes an installed binary nor exposes an externally reachable listener; it drives injected CLI collaborators against the test-created manifest path.
   * Side effects: Drives the loopback test resource through `writeManifest`, `after`, `rmParent`, `runCli`, `createLocalCliHandlers`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the temporary manifest directory after the loopback UI test.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, deleting other paths, or closing the viewer server.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  const launched: LocalReportViewer[] = [];
  const stdout: string[] = [];
  const status = await runCli(
    ["ui", "--manifest", manifestPath, "--port", "0"],
    createLocalCliHandlers({
      workspaceScan: scanPort("complete"),
      startViewer:
        /**
         * Starts the injected loopback viewer and records its handle for subsequent server shutdown.
         *
         * Inputs: `request`.
         * Outputs: The started `LocalReportViewer` expected by the CLI handler.
         * Does not handle: Validating rendered content, closing the server, or exposing a non-loopback host.
         * Side effects: Starts a local viewer and appends its handle to `launched`.
         */
        async (request) => {
        const viewer = await startLocalReportViewer(request);
        launched.push(viewer);
        return viewer;
      },
    }),
    { stdout:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `stdout`.
       */
      (text) => stdout.push(text), stderr:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stderr text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is intentionally discarded.
       */
      () => undefined },
  );
  t.after(
    /**
     * Closes every viewer server started by the loopback UI test.
     *
     * Inputs: no arguments.
     * Outputs: A promise that resolves after all recorded `LocalReportViewer` servers close.
     * Does not handle: Deleting the manifest directory, creating a viewer, or determining test status.
     * Side effects: Calls each viewer's HTTP-server close method.
     */
    async () => {
    await Promise.all(launched.map(
      /**
       * Starts shutdown of one viewer server during the aggregate cleanup.
       *
       * Inputs: `viewer`.
       * Outputs: This viewer's close promise.
       * Does not handle: Closing another viewer, deleting fixture files, or swallowing close failures.
       * Side effects: Begins closing the current viewer's HTTP server.
       */
      (viewer) => viewer.close()));
  });

  assert.equal(status, 0);
  const url = new URL(stdout.join("").trim());
  assert.equal(url.hostname, "127.0.0.1");
  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(page.body, /aria-label="Repositories"/u);
  assert.match(page.body, /"label":"api"/u);
  assert.equal(page.body.includes(manifestPath), false);
});

test("workspace invalid input and required-complete UI return nonzero without launching",
  /**
   * Exercises the “workspace invalid input and required-complete UI return nonzero without launching” scenario through `mkdtemp`, `join`, `tmpdir`, `after`, `rm`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace invalid input and required-complete UI return nonzero without launching”.
   * Outputs: Normal completion only after the “workspace invalid input and required-complete UI return nonzero without launching” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither invokes an installed binary nor exposes an externally reachable listener; it drives injected CLI collaborators against the test-created manifest path.
   * Side effects: Creates, changes, or removes test-owned fixture files through `mkdtemp`, `join`, `tmpdir`, `after`, `rm`.
   */
  async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-cli-invalid-"));
  t.after(
    /**
     * Removes the invalid-input test's temporary root directory.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rm(root, { recursive: true, force: true })`, registered with `t.after`.
     * Does not handle: Creating the root, deleting outside the test root, or deciding test status.
     * Side effects: Recursively deletes the test-owned root with force enabled.
     */
    () => rm(root, { recursive: true, force: true }));
  const invalidPath = join(root, "missing.json");
  const invalidErr: string[] = [];
  const invalid = await runCli(
    ["workspace", "scan", "--manifest", invalidPath],
    createLocalCliHandlers({ workspaceScan: scanPort("complete") }),
    { stdout:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stdout text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is deliberately discarded.
       */
      () => undefined, stderr:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `invalidErr`.
       */
      (text) => invalidErr.push(text) },
  );
  assert.equal(invalid, 65);
  assert.equal(invalidErr.join(""), "APP_WORKSPACE_MANIFEST_READ_FAILED\n");
  assert.equal(invalidErr.join("").includes(invalidPath), false);

  const manifestPath = await writeManifest();
  t.after(
    /**
     * Removes the manifest fixture created for the require-complete UI case.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, removing an unrelated root, or deciding test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  let launched = false;
  const incomplete = await runCli(
    ["ui", "--manifest", manifestPath, "--require-complete"],
    createLocalCliHandlers({
      workspaceScan: scanPort("incomplete"),
      startViewer:
        /**
         * Fails the test if an incomplete workspace reaches viewer launch.
         *
         * Inputs: No arguments; the injected handler calls it only after its own UI preflight.
         * Outputs: A rejected promise carrying the deliberate viewer-launch error.
         * Does not handle: Starting, closing, or recovering a viewer; the expected CLI path must not invoke this handler.
         * Side effects: Sets `launched` and throws the test error.
         */
        async () => {
        launched = true;
        throw new Error("Viewer should not start");
      },
    }),
    { stdout:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stdout text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is deliberately discarded.
       */
      () => undefined, stderr:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stderr text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is deliberately discarded.
       */
      () => undefined },
  );
  assert.equal(incomplete, 2);
  assert.equal(launched, false);
});

test("workspace UI rejects synthetic-row viewer overflow before starting a listener",
  /**
   * Asserts the concrete test outcome “workspace UI rejects synthetic-row viewer overflow before starting a listener” after its declared setup and operation.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture, CLI, or assertion failures; the test runner observes them.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `overflowingScanPort`, `assert.equal`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the temporary manifest directory after the viewer-overflow test.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, deleting unrelated paths, or deciding test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  let launched = false;
  const stderr: string[] = [];

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: overflowingScanPort(),
      startViewer:
        /**
         * Fails the test if viewer materialization proceeds after row-limit rejection.
         *
         * Inputs: No arguments; the injected handler would receive no viewer request in this test.
         * Outputs: A rejected promise carrying the deliberate preflight-failure error.
         * Does not handle: Starting a listener, normal viewer construction, or error recovery.
         * Side effects: Sets `launched` and throws the test error.
         */
        async () => {
        launched = true;
        throw new Error("viewer must not start after model preflight failure");
      },
    }),
    { stdout:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stdout text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is deliberately discarded.
       */
      () => undefined, stderr:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `stderr`.
       */
      (text) => stderr.push(text) },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_LIMIT_EXCEEDED\n");
  assert.equal(launched, false);
});

test("workspace UI closes a started viewer when writing its URL fails",
  /**
   * Exercises the “workspace UI closes a started viewer when writing its URL fails” scenario through `writeManifest`, `after`, `rmParent`, `runCli`, `createLocalCliHandlers`.
   *
   * Inputs: The Node test context `t` plus the fixture and imports established for “workspace UI closes a started viewer when writing its URL fails”.
   * Outputs: Normal completion only after the “workspace UI closes a started viewer when writing its URL fails” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither invokes an installed binary nor exposes an externally reachable listener; it drives injected CLI collaborators against the test-created manifest path.
   * Side effects: Drives the loopback test resource through `writeManifest`, `after`, `rmParent`, `runCli`, `createLocalCliHandlers`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the temporary manifest directory after the stdout-failure viewer test.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, deleting unrelated paths, or deciding test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  const stderr: string[] = [];
  let closeCalls = 0;

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: scanPort("complete"),
      startViewer:
        /**
         * Supplies a started loopback viewer whose close operation is observable by this test.
         *
         * Inputs: The viewer request, which this synthetic implementation does not inspect.
         * Outputs: A `LocalReportViewer`-shaped object at the fixed loopback URL.
         * Does not handle: Binding a real server, materializing viewer HTML, or closing the viewer.
         * Side effects: Allocates a `URL` object for the synthetic viewer handle.
         */
        async () => ({
        address: { host: "127.0.0.1", port: 12345 },
        url: new URL("http://127.0.0.1:12345/"),
        /**
         * Records that the CLI invoked shutdown on the synthetic viewer after stdout failed.
         *
         * Inputs: no arguments.
         * Outputs: A fulfilled promise after incrementing the close-call counter.
         * Does not handle: Closing a real server, retrying output, or translating the stdout failure.
         * Side effects: Increments the test-local `closeCalls` counter.
         */
        async close(): Promise<void> {
          closeCalls += 1;
        },
      }),
    }),
    {
      stdout:
        /**
         * Simulates a synchronous stdout write failure after viewer startup.
         *
         * Inputs: No declared arguments; the emitted viewer URL text is intentionally ignored.
         * Outputs: Never returns normally because it throws the configured stdout error.
         * Does not handle: Capturing output, closing the viewer, or converting the failure to an exit status.
         * Side effects: Throws `stdout unavailable`, causing the surrounding CLI path to close its started viewer.
         */
        () => {
        throw new Error("stdout unavailable");
      },
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
    },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_FAILED\n");
  assert.equal(closeCalls, 1);
});

test("workspace UI collapses adversarial report getters to a fixed error before viewer launch",
  /**
   * Asserts the concrete test outcome “workspace UI collapses adversarial report getters to a fixed error before viewer launch” after its declared setup and operation.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering setup, getter, CLI, or assertion failures; the test runner observes them.
   * Side effects: runs `writeManifest`, `t.after`, `Object.create`, `Object.defineProperty`, `runCli`, `createLocalCliHandlers`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Deletes the adversarial-getter test's temporary manifest directory.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: Creating the fixture, deleting outside its parent, or deciding test status.
     * Side effects: Recursively removes the test-owned manifest parent directory.
     */
    () => rmParent(manifestPath));
  const sentinel = "/private/sk_live_WORKSPACE_REPORT_TRAP_123456789";
  let getterReads = 0;
  let launched = false;
  const stderr: string[] = [];
  const hostileResult = Object.create(null) as WorkspaceScanReportSource;
  Object.defineProperty(hostileResult, "repositories", {
    /**
     * Implements the hostile `repositories` getter installed on the synthetic workspace result.
     *
     * Inputs: A later property read supplies the receiver; this getter has no positional parameters.
     * Outputs: Never returns: it throws the test sentinel when `repositories` is read.
     * Does not handle: It neither installs the property nor chooses when it runs; property access invokes this test getter, which only throws the deliberate sentinel.
     * Side effects: Increments `getterReads` and throws the deliberate sentinel error.
     */
    get(): never {
      getterReads += 1;
      throw new Error(sentinel);
    },
  });

  const status = await runCli(
    ["ui", "--manifest", manifestPath],
    createLocalCliHandlers({
      workspaceScan: {
        /**
         * Returns the hostile report object so CLI materialization triggers its `repositories` getter.
         *
         * Inputs: no arguments.
         * Outputs: The exact `hostileResult` object, without reading its getter.
         * Does not handle: Materializing viewer data, catching the getter error, or starting a viewer.
         * Side effects: Returns the already allocated hostile object; property access happens only later.
         */
        async scan() {
          return hostileResult;
        },
      },
      startViewer:
        /**
         * Fails the test if hostile report material reaches viewer launch.
         *
         * Inputs: No arguments; valid report material is required before this injected handler runs.
         * Outputs: A rejected promise carrying the deliberate no-launch error.
         * Does not handle: Starting a viewer, converting hostile data, or recovering the rejected launch.
         * Side effects: Sets `launched` and throws the test error.
         */
        async () => {
        launched = true;
        throw new Error("viewer must not launch");
      },
    }),
    { stdout:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: The emitted stdout text, deliberately not bound by this test hook.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: None; the emitted text is deliberately discarded.
       */
      () => undefined, stderr:
      /**
       * Captures one CLI output fragment.
       *
       * Inputs: `text`.
       * Outputs: the numeric `Array#push` length, which `runCli` ignores.
       * Does not handle: format, await, route, or recover emitted text; a synchronous push failure escapes `runCli`.
       * Side effects: appends `text` to `stderr`.
       */
      (text) => stderr.push(text) },
  );

  assert.equal(status, 70);
  assert.equal(stderr.join(""), "APP_WORKSPACE_VIEWER_FAILED\n");
  assert.equal(stderr.join("").includes(sentinel), false);
  assert.equal(getterReads, 1);
  assert.equal(launched, false);
});

/**
 * Builds an injected workspace scan port that returns one repository at the requested status.
 *
 * Inputs: `status`.
 * Outputs: A scan port whose `scan` method returns the deterministic fixture report.
 * Does not handle: Reading a manifest, running static analysis, or emitting CLI output.
 * Side effects: Allocates the port object and closes over the requested status.
 */
function scanPort(
  status: "complete" | "incomplete",
): WorkspaceScanPort<WorkspaceScanReportSource> {
  return {
    /**
     * Returns the one-repository fixture report for this injected scan request.
     *
     * Inputs: No arguments; the port interface supplies no request payload here.
     * Outputs: A fulfilled promise containing the requested complete/incomplete repository report.
     * Does not handle: Inspecting a manifest, creating deployments, or retrying a scan.
     * Side effects: Calls the local fixture-brand helpers and allocates the report object.
     */
    async scan() {
      return {
        repositories: [
          {
            id: id("api"),
            status,
            diagnostics:
              status === "incomplete"
                ? [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")]
                : [],
            reconciliation: emptyReconciliation,
            references: [],
            demandEdges: [],
            dynamicLookupEdges: [],
          },
        ],
        deployments: [],
      };
    },
  };
}

/**
 * Builds an injected scan port with enough synthetic rows to exceed the viewer model's limit.
 *
 * Inputs: no arguments.
 * Outputs: A port whose scan result contains 100 repositories and their synthetic deployment.
 * Does not handle: Materializing a viewer, scanning files, or emitting a CLI response.
 * Side effects: Generates in-memory repository and member fixture arrays.
 */
function overflowingScanPort(): WorkspaceScanPort<WorkspaceScanReportSource> {
  const repositories = Array.from({ length: 100 },
    /**
     * Builds one complete repository fact to force the synthetic viewer-row limit.
     *
     * Inputs: `_`, `index`.
     * Outputs: An in-memory complete scan result with a unique branded repository ID.
     * Does not handle: Building deployments, invoking the scanner, or checking viewer limits.
     * Side effects: Allocates the fixture result object and its empty fact arrays.
     */
    (_, index) => ({
    id: id("repository-" + String(index + 1)),
    status: "complete" as const,
    diagnostics: [],
    reconciliation: emptyReconciliation,
    references: [],
    demandEdges: [],
    dynamicLookupEdges: [],
  }));
  return {
    /**
     * Returns the prebuilt overflowing report to the injected CLI scan handler.
     *
     * Inputs: No arguments; this fixture ignores the scan request.
     * Outputs: A fulfilled promise containing the synthetic repository/deployment report.
     * Does not handle: Scanning a manifest, recomputing rows, or checking the viewer limit.
     * Side effects: Allocates the report wrapper while reusing the prebuilt repositories.
     */
    async scan() {
      return {
        repositories,
        deployments: [{
          id: id("production"),
          status: "complete",
          diagnostics: [],
          repositoryIds: repositories.map(
            /**
             * Extracts every generated repository ID for the synthetic deployment declaration.
             *
             * Inputs: `repository`.
             * Outputs: The current generated repository's branded `id`.
             * Does not handle: Constructing member partitions, mutating repositories, or running a scan.
             * Side effects: Reads the repository ID without mutation or I/O.
             */
            (repository) => repository.id),
          sharedKeys: [],
          members: repositories.map(
            /**
             * Clones one repository's scan facts into the matching deployment-member partition.
             *
             * Inputs: `repository`.
             * Outputs: A member record sharing the current repository's immutable scan fact references.
             * Does not handle: Deep cloning facts, adding shared keys, or changing source repository objects.
             * Side effects: Allocates the member wrapper object.
             */
            (repository) => ({
            repositoryId: repository.id,
            status: repository.status,
            diagnostics: repository.diagnostics,
            reconciliation: repository.reconciliation,
            references: repository.references,
            demandEdges: repository.demandEdges,
            dynamicLookupEdges: repository.dynamicLookupEdges,
          })),
        }],
      };
    },
  };
}

/**
 * Creates a minimal v2 workspace manifest in a new test-owned temporary directory.
 *
 * Inputs: no arguments.
 * Outputs: A path to the written `workspace.jsonc` fixture.
 * Does not handle: Parsing the manifest, registering cleanup, or writing a production workspace.
 * Side effects: Creates a temporary directory and writes a manifest file beneath it.
 */
async function writeManifest(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-cli-"));
  const manifestPath = join(root, "workspace.jsonc");
  await writeFile(
    manifestPath,
    [
      "{",
      '  "schemaVersion": "workspace-manifest/v2",',
      '  "repositories": [{ "id": "api", "root": "." }],',
      '  "deployments": []',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return manifestPath;
}

/**
 * Recursively removes the parent directory of a test-created manifest file.
 *
 * Inputs: `file`.
 * Outputs: A promise fulfilled after forced recursive deletion completes.
 * Does not handle: Checking ownership, deleting an arbitrary sibling, or suppressing deletion failures.
 * Side effects: Deletes the filesystem directory returned by `dirname(file)`.
 */
async function rmParent(file: string): Promise<void> {
  await rm(dirname(file), { recursive: true, force: true });
}

/**
 * Fetches a loopback CLI viewer URL and buffers its status and UTF-8 page body.
 *
 * Inputs: `url`.
 * Outputs: A promise resolving to the HTTP response status and complete page body.
 * Does not handle: Redirects, request timeout policy, response-size limits, or page-content validation.
 * Side effects: Starts a loopback HTTP GET and registers response/error listeners.
 */
async function request(url: URL): Promise<{ readonly status: number; readonly body: string }> {
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
       * Installs listeners that accumulate one CLI viewer HTTP response and settle the enclosing promise.
       *
       * Inputs: `response`.
       * Outputs: `void`; data/end listeners later resolve status and UTF-8 body, while error rejects.
 * Does not handle: Issuing a second request, checking page content, imposing a response-size limit, or retaining chunks after settlement.
       * Side effects: Registers response event handlers and captures received buffers in a local array.
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
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
