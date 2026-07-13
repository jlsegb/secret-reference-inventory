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
const emptyReconciliation: ReconciliationResult = { records: [], scopeCoverage: [] };

test("workspace scan writes a deterministic versioned report and returns incomplete status on request",
  /**
   * Verifies “workspace scan writes a deterministic versioned report and returns incomplete status on request”.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `scanPort`, `assert.equal`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
     * Projects a report value from the current repository.
     *
     * Inputs: `repository`.
     * Outputs: the `repository.id` result consumed by `report.repositories.map`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (repository) => repository.id), ["api"]);
  assert.equal(stdout.join("").includes(manifestPath), false);
});

test("workspace scan uses the default N3 local port when no test port is injected",
  /**
   * Verifies “workspace scan uses the default N3 local port when no test port is injected”.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `assert.equal`, `stderr.join`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
         * Verifies “workspace UI launches a loopback-only viewer from derived report data”.
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
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
       */
      () => undefined },
  );
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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rm(root, { recursive: true, force: true })`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rm(root, { recursive: true, force: true })`.
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
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
       */
      () => undefined, stderr:
      /**
       * Discards one CLI output fragment.
       *
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
       */
      () => undefined },
  );
  assert.equal(incomplete, 2);
  assert.equal(launched, false);
});

test("workspace UI rejects synthetic-row viewer overflow before starting a listener",
  /**
   * Verifies “workspace UI rejects synthetic-row viewer overflow before starting a listener”.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
   * Side effects: runs `writeManifest`, `t.after`, `runCli`, `createLocalCliHandlers`, `overflowingScanPort`, `assert.equal`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
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
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
         * Verifies “workspace UI closes a started viewer when writing its URL fails”.
         *
         * Inputs: no arguments.
         * Outputs: a promise that settles after its awaited workspace operations and assertions.
         * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
         * Side effects: runs `URL`.
         */
        async () => ({
        address: { host: "127.0.0.1", port: 12345 },
        url: new URL("http://127.0.0.1:12345/"),
        /**
         * Verifies “workspace UI closes a started viewer when writing its URL fails”.
         *
         * Inputs: no arguments.
         * Outputs: a promise that settles after its awaited workspace operations and assertions.
         * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
         * Side effects: runs no helper.
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
   * Verifies “workspace UI collapses adversarial report getters to a fixed error before viewer launch”.
   *
   * Inputs: `t`.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
   * Side effects: runs `writeManifest`, `t.after`, `Object.create`, `Object.defineProperty`, `runCli`, `createLocalCliHandlers`.
   */
  async (t) => {
  const manifestPath = await writeManifest();
  t.after(
    /**
     * Schedules temporary fixture removal.
     *
     * Inputs: no arguments.
     * Outputs: the cleanup promise returned by `rmParent(manifestPath)`, registered with `t.after`.
     * Does not handle: create the temporary path or decide whether the test passes.
     * Side effects: performs the recursive filesystem removal requested by `rmParent(manifestPath)`.
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
         * Verifies “workspace UI collapses adversarial report getters to a fixed error before viewer launch”.
         *
         * Inputs: no arguments.
         * Outputs: a promise that settles after its awaited workspace operations and assertions.
         * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
         * Side effects: runs no helper.
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
       * Inputs: no arguments.
       * Outputs: `undefined`, which `runCli` ignores.
       * Does not handle: inspect, format, retain, or recover emitted text.
       * Side effects: none; the hook intentionally ignores its supplied text.
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
 * Assembles the scanPort test value.
 *
 * Inputs: `status`.
 * Outputs: the fixture value returned by `scanPort`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: none; it allocates only in-memory test data.
 */
function scanPort(
  status: "complete" | "incomplete",
): WorkspaceScanPort<WorkspaceScanReportSource> {
  return {
    /**
     * Assembles the scan test value.
     *
     * Inputs: no arguments.
     * Outputs: the fixture value returned by `scan`.
     * Does not handle: validate unrelated production input or suppress assertion failures.
     * Side effects: invokes `id`, `diagnostic`.
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
 * Assembles the overflowingScanPort test value.
 *
 * Inputs: no arguments.
 * Outputs: the completion result produced by `overflowingScanPort`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `Array.from`.
 */
function overflowingScanPort(): WorkspaceScanPort<WorkspaceScanReportSource> {
  const repositories = Array.from({ length: 100 },
    /**
     * Constructs one generated fixture element.
     *
     * Inputs: `_`, `index`.
     * Outputs: the `({ id: id("repository-" + String(index + 1)), status: "complete" as const, diagnostics: [], reconciliation: emptyReconciliation, references: [], demandEdges: [], dynamicLookupEdges: [], })` result consumed by `Array.from`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
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
     * Assembles the scan test value.
     *
     * Inputs: no arguments.
     * Outputs: the fixture value returned by `scan`.
     * Does not handle: validate unrelated production input or suppress assertion failures.
     * Side effects: invokes `id`, `repositories.map`.
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
             * Projects a report value from the current repository.
             *
             * Inputs: `repository`.
             * Outputs: the `repository.id` result consumed by `repositories.map`.
             * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
             * Side effects: none; it derives the current-item result.
             */
            (repository) => repository.id),
          sharedKeys: [],
          members: repositories.map(
            /**
             * Projects a report value from the current repository.
             *
             * Inputs: `repository`.
             * Outputs: the `({ repositoryId: repository.id, status: repository.status, diagnostics: repository.diagnostics, reconciliation: repository.reconciliation, references: repository.references, demandEdges: rep` result consumed by `repositories.map`.
             * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
             * Side effects: none; it derives the current-item result.
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
 * Assembles the writeManifest test value.
 *
 * Inputs: no arguments.
 * Outputs: the completion result produced by `writeManifest`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: changes test-owned filesystem state through `mkdtemp`, `join`, `tmpdir`, `writeFile`, `[ "{", ' "schemaVersion": "workspace-manifest/v2",', ' "repositories": [{ "id": `.
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
 * Assembles the rmParent test value.
 *
 * Inputs: `file`.
 * Outputs: the completion result produced by `rmParent`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: changes test-owned filesystem state through `rm`, `dirname`.
 */
async function rmParent(file: string): Promise<void> {
  await rm(dirname(file), { recursive: true, force: true });
}

/**
 * Assembles the request test value.
 *
 * Inputs: `url`.
 * Outputs: the fixture value returned by `request`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `Promise`.
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
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
