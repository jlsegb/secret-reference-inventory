import assert from "node:assert/strict";
import test from "node:test";

import { parseCli, runCli } from "../src/cli/index.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

test("CLI parses documented scan, reconcile, workspace, and UI command shapes",
  /**
   * Verifies the parser accepts the documented local command forms and retains their key fields.
   *
   * Inputs: Node's test runner and literal command-token fixtures.
   * Outputs: Assertions over successful parse variants.
   * Does not handle: Filesystem execution or handler dispatch.
   * Side effects: Invokes the pure CLI parser and performs assertions.
   */
  () => {
  const scan = parseCli(["scan", ".", "--format", "json", "--require-complete"]);
  assert.equal(scan.ok, true);
  if (scan.ok && scan.command.kind === "scan") {
    assert.equal(scan.command.root, ".");
    assert.equal(scan.command.format, "json");
    assert.equal(scan.command.requireComplete, true);
  }

  const reconcile = parseCli([
    "reconcile",
    "--root",
    ".",
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
  ]);
  assert.equal(reconcile.ok, true);
  if (reconcile.ok && reconcile.command.kind === "reconcile") {
    assert.equal(reconcile.command.root, ".");
    assert.equal(reconcile.command.inventory, "inventory.json");
  }

  const workspace = parseCli([
    "workspace",
    "scan",
    "--manifest",
    "workspace.jsonc",
    "--format",
    "json",
    "--require-complete",
  ]);
  assert.equal(workspace.ok, true);
  if (workspace.ok && workspace.command.kind === "workspace-scan") {
    assert.equal(workspace.command.manifest, "workspace.jsonc");
    assert.equal(workspace.command.format, "json");
    assert.equal(workspace.command.requireComplete, true);
  }

  const ui = parseCli(["ui", "--manifest", "workspace.jsonc", "--port", "0"]);
  assert.equal(ui.ok, true);
  if (ui.ok && ui.command.kind === "ui") {
    assert.equal(ui.command.manifest, "workspace.jsonc");
    assert.equal(ui.command.port, 0);
  }
});

test("CLI rejects conflicting input sources without echoing untrusted input",
  /**
   * Verifies conflicting reconcile sources and unknown commands return fixed, sentinel-free diagnostics.
   *
   * Inputs: Node's async test runner and a secret-shaped sentinel passed only as malformed input.
   * Outputs: Assertions over parse failure, exit status, and captured stderr.
   * Does not handle: Handler execution after a successful parse.
   * Side effects: Invokes the CLI runner and appends output to a local test array.
   */
  async () => {
  const parsed = parseCli([
    "reconcile",
    "--root",
    ".",
    "--scan-report",
    SENTINEL,
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
  ]);
  assert.equal(parsed.ok, false);

  const stderr: string[] = [];
  const status = await runCli(["unknown", SENTINEL], {}, {
    stdout:
      /**
       * Discards unexpected standard output during the invalid-command test.
       *
       * Inputs: One emitted text fragment.
       * Outputs: Undefined.
       * Does not handle: Capturing or asserting output.
       * Side effects: None.
       */
      () => undefined,
    stderr:
      /**
       * Captures fixed standard-error text for sentinel-leak assertions.
       *
       * Inputs: One emitted error fragment.
       * Outputs: The new stderr-array length.
       * Does not handle: Writing to the real terminal or parsing the text.
       * Side effects: Mutates the local stderr array.
       */
      (text) => stderr.push(text),
  });
  assert.equal(status, 64);
  assert.equal(stderr.join("").includes(SENTINEL), false);
});

test("CLI shell delegates only to injected local handlers",
  /**
   * Verifies a parsed scan command reaches only the supplied handler and preserves its status.
   *
   * Inputs: Node's async test runner and a local injected scan handler.
   * Outputs: Assertions over handler observation and returned status.
   * Does not handle: Production application handlers or filesystem scanning.
   * Side effects: Invokes the CLI runner and mutates a local observation flag.
   */
  async () => {
  let seen = false;
  const status = await runCli(
    ["scan", "."],
    {
      scan:
        /**
         * Records the parsed root and returns a test-defined status.
         *
         * Inputs: The parsed scan command; the runner's I/O argument is intentionally unused.
         * Outputs: Numeric status 17.
         * Does not handle: Scanning the root or emitting output.
         * Side effects: Mutates the local seen flag.
         */
        (command) => {
        seen = command.root === ".";
        return 17;
      },
    },
    {
      stdout:
        /**
         * Discards output in the handler-delegation test.
         *
         * Inputs: One emitted text fragment.
         * Outputs: Undefined.
         * Does not handle: Capturing or writing output.
         * Side effects: None.
         */
        () => undefined,
      stderr:
        /**
         * Discards diagnostics in the handler-delegation test.
         *
         * Inputs: One emitted text fragment.
         * Outputs: Undefined.
         * Does not handle: Capturing or writing diagnostics.
        * Side effects: None.
        */
        () => undefined
    },
  );

  assert.equal(seen, true);
  assert.equal(status, 17);
});

test("workspace command rejects unsupported report formats and unsafe UI ports",
  /**
   * Verifies workspace SARIF and an out-of-range UI port are parser failures.
   *
   * Inputs: Node's test runner and invalid command-token fixtures.
   * Outputs: Assertions over unsuccessful parse results.
   * Does not handle: Viewer startup or workspace manifest loading.
   * Side effects: Invokes the pure parser and performs assertions.
   */
  () => {
  const sarif = parseCli([
    "workspace",
    "scan",
    "--manifest",
    "workspace.json",
    "--format",
    "sarif",
  ]);
  assert.equal(sarif.ok, false);

  const ui = parseCli(["ui", "--manifest", "workspace.json", "--port", "65536"]);
  assert.equal(ui.ok, false);
});
