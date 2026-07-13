import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalCliHandlers } from "../src/app/index.js";
import { parseCli, runCli } from "../src/cli/index.js";

test("standalone reconcile requires an explicit closed-model verification base", /**
 * Asserts CLI parsing requires a base with a closed model, rejects a lone base, and preserves an explicit valid base.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled synchronous test when all parse-result assertions pass.
 * Does not handle: Filesystem canonicalization or reconciliation execution.
 * Side effects: Parses only in-memory argument arrays.
 */ () => {
  const missing = parseCli([
    "reconcile",
    "--root",
    ".",
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
    "--closed-model",
    "closed-model.json",
  ]);
  assert.deepEqual(missing, { ok: false, error: { code: "CLI_MISSING_ARGUMENT" } });

  const unrelatedBase = parseCli([
    "reconcile",
    "--root",
    ".",
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
    "--verification-base",
    "/workspace",
  ]);
  assert.deepEqual(unrelatedBase, { ok: false, error: { code: "CLI_CONFLICTING_INPUTS" } });

  const valid = parseCli([
    "reconcile",
    "--root",
    ".",
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
    "--closed-model",
    "closed-model.json",
    "--verification-base",
    "/workspace",
  ]);
  assert.equal(valid.ok, true);
  if (valid.ok && valid.command.kind === "reconcile") {
    assert.equal(valid.command.verificationBase, "/workspace");
  }
});

test("standalone reconcile canonicalizes only an explicit valid base and never uses cwd", /**
 * Asserts runtime reconcile accepts only an explicit absolute existing base and does not leak base paths after a CWD change.
 *
 * Inputs: The Node test context used to register fixture cleanup.
 * Outputs: A fulfilled promise when all status/output assertions pass; assertion failure rejects it.
 * Does not handle: Closed-model schema validation beyond the fixture or direct analysis API behavior.
 * Side effects: Creates/removes temporary files and temporarily changes/restores process CWD while invoking local handlers.
 */ async (t) => {
  const fixture = await createFixture();
  t.after(/**
   * Removes the complete temporary reconciliation fixture after the test ends.
   *
   * Inputs: None.
   * Outputs: A promise for recursive deletion.
   * Does not handle: Process CWD restoration.
   * Side effects: Deletes the fixture parent tree.
   */ () => rm(fixture.parent, { recursive: true, force: true }));
  const handlers = createLocalCliHandlers();

  const missingStderr: string[] = [];
  const missingStatus = await runCli(
    reconcileArguments(fixture, undefined),
    handlers,
    { stdout: /**
      * Ignores stdout for the missing-base usage-error assertion.
      *
      * Inputs: An emitted stdout chunk.
      * Outputs: `undefined`.
      * Does not handle: Capturing or validating stdout.
      * Side effects: None.
      */ () => undefined, stderr: /**
      * Captures missing-base stderr for exact usage diagnostic comparison.
      *
      * Inputs: An emitted stderr chunk.
      * Outputs: The enclosing array length returned by `push`.
      * Does not handle: Printing or parsing the diagnostic.
      * Side effects: Mutates the enclosing missing-stderr array.
      */ (text) => missingStderr.push(text) },
  );
  assert.equal(missingStatus, 64);
  assert.equal(missingStderr.join(""), "CLI_MISSING_ARGUMENT\n");

  const originalCwd = process.cwd();
  const stdout: string[] = [];
  const validStderr: string[] = [];
  process.chdir(fixture.unrelatedCwd);
  try {
    const validStatus = await runCli(
      reconcileArguments(fixture, fixture.workspace),
      handlers,
      {
        stdout: /**
         * Captures valid reconcile output to confirm it contains no workspace path.
         *
         * Inputs: An emitted stdout chunk.
         * Outputs: The enclosing array length returned by `push`.
         * Does not handle: Parsing JSON output.
         * Side effects: Mutates the enclosing stdout array.
         */ (text) => stdout.push(text),
        stderr: /**
         * Captures valid reconcile stderr to assert it remains empty.
         *
         * Inputs: An emitted stderr chunk.
         * Outputs: The enclosing array length returned by `push`.
         * Does not handle: Printing or parsing diagnostics.
         * Side effects: Mutates the enclosing valid-stderr array.
         */ (text) => validStderr.push(text),
      },
    );
    assert.equal(validStatus, 0);
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(validStderr.join(""), "");
  assert.equal(stdout.join("").includes(fixture.workspace), false);

  const relativeStderr: string[] = [];
  const relativeStatus = await runCli(
    reconcileArguments(fixture, "workspace"),
    handlers,
    { stdout: /**
      * Ignores stdout for the invalid-relative-base case.
      *
      * Inputs: An emitted stdout chunk.
      * Outputs: `undefined`.
      * Does not handle: Output assertions.
      * Side effects: None.
      */ () => undefined, stderr: /**
      * Captures the relative-base diagnostic for exact comparison.
      *
      * Inputs: An emitted stderr chunk.
      * Outputs: The enclosing array length returned by `push`.
      * Does not handle: Printing or parsing the diagnostic.
      * Side effects: Mutates the enclosing relative-stderr array.
      */ (text) => relativeStderr.push(text) },
  );
  assert.equal(relativeStatus, 65);
  assert.equal(relativeStderr.join(""), "APP_CLOSED_MODEL_VERIFICATION_BASE_INVALID\n");

  const invalidBase = join(fixture.parent, "does-not-exist");
  const invalidStderr: string[] = [];
  const invalidStatus = await runCli(
    reconcileArguments(fixture, invalidBase),
    handlers,
    { stdout: /**
      * Ignores stdout for the nonexistent-base case.
      *
      * Inputs: An emitted stdout chunk.
      * Outputs: `undefined`.
      * Does not handle: Output assertions.
      * Side effects: None.
      */ () => undefined, stderr: /**
      * Captures the nonexistent-base diagnostic to verify the supplied path is not leaked.
      *
      * Inputs: An emitted stderr chunk.
      * Outputs: The enclosing array length returned by `push`.
      * Does not handle: Printing or parsing the diagnostic.
      * Side effects: Mutates the enclosing invalid-stderr array.
      */ (text) => invalidStderr.push(text) },
  );
  assert.equal(invalidStatus, 65);
  assert.equal(invalidStderr.join(""), "APP_CLOSED_MODEL_VERIFICATION_BASE_INVALID\n");
  assert.equal(invalidStderr.join("").includes(invalidBase), false);
});

interface ReconcileFixture {
  readonly parent: string;
  readonly workspace: string;
  readonly repository: string;
  readonly unrelatedCwd: string;
  readonly bindingsPath: string;
  readonly inventoryPath: string;
  readonly closedModelPath: string;
}

/**
 * Creates the workspace, repository, provisioning documents, and unrelated CWD used by reconcile base tests.
 *
 * Inputs: None.
 * Outputs: A promise for paths describing a fully written temporary reconcile fixture.
 * Does not handle: Fixture cleanup, invalid JSON, or external provisioning services.
 * Side effects: Creates directories and writes source/JSON files below a new OS temporary parent.
 */
async function createFixture(): Promise<ReconcileFixture> {
  const parent = await mkdtemp(join(tmpdir(), "secret-usage-reconcile-base-"));
  const workspace = join(parent, "workspace");
  const repository = join(workspace, "repository");
  const unrelatedCwd = join(parent, "unrelated");
  const bindingsPath = join(workspace, "bindings.json");
  const inventoryPath = join(workspace, "inventory.json");
  const closedModelPath = join(workspace, "closed-model.json");
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(unrelatedCwd, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repository, "index.ts"),
      "export const databaseUrl = process.env.DATABASE_URL;\n",
      "utf8",
    ),
    writeJson(bindingsPath, {
      schemaVersion: "binding-manifest/v1",
      inputId: "bindings-input",
      adapterId: "local-adapter",
      candidates: [],
    }),
    writeJson(inventoryPath, {
      schemaVersion: "inventory-snapshot/v1",
      inputId: "inventory-input",
      authorityId: "local-authority",
      asOf: "2026-07-12T00:00:00Z",
      items: [],
    }),
    writeJson(closedModelPath, closedModelDocument()),
  ]);
  return {
    parent,
    workspace,
    repository,
    unrelatedCwd,
    bindingsPath,
    inventoryPath,
    closedModelPath,
  };
}

/**
 * Builds the parsed-CLI argument list for a fixture reconcile invocation with an optional verification base.
 *
 * Inputs: A reconcile fixture and optional base path.
 * Outputs: An immutable-looking argument array for the JSON require-complete command.
 * Does not handle: Argument parsing, absolute-path validation, or command execution.
 * Side effects: Allocates a new string array.
 */
function reconcileArguments(
  fixture: ReconcileFixture,
  verificationBase: string | undefined,
): readonly string[] {
  return [
    "reconcile",
    "--root",
    fixture.repository,
    "--inventory",
    fixture.inventoryPath,
    "--bindings",
    fixture.bindingsPath,
    "--closed-model",
    fixture.closedModelPath,
    ...(verificationBase === undefined ? [] : ["--verification-base", verificationBase]),
    "--format",
    "json",
    "--require-complete",
  ];
}

/**
 * Serializes and writes one JSON provisioning fixture document.
 *
 * Inputs: Destination path and JSON-serializable fixture value.
 * Outputs: A fulfilled `undefined` promise or a rejected serialization/write promise.
 * Does not handle: Parent-directory creation, parse validation, or secret redaction.
 * Side effects: Writes one local UTF-8 file.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

/**
 * Builds the explicit closed-model fixture that covers the fixture repository and provisioning inputs.
 *
 * Inputs: None.
 * Outputs: A JSON-serializable single-scope closed-provisioning model.
 * Does not handle: Multiple environments, adapter failures, or malformed schema variants.
 * Side effects: Allocates nested fixture objects and arrays.
 */
function closedModelDocument(): object {
  return {
    schemaVersion: "closed-provisioning-model/v1",
    inputId: "closed-model-input",
    maxFiniteKeyDomain: 8,
    scopes: [{
      scope: {
        id: "local-default-runtime",
        componentId: "local-default",
        phase: "runtime",
        stage: { kind: "exact", values: ["production"] },
        channel: "environment",
      },
      declaredStages: ["production"],
      closed: true,
      approvedFirstPartyRoots: ["repository"],
      bindingRoots: ["bindings.json"],
      expectedAdapterInputs: [{
        inputId: "bindings-input",
        domain: "binding",
        adapterId: "local-adapter",
      }],
      permittedExclusions: [],
      inventoryAuthorities: [{
        authorityId: "local-authority",
        inventoryInputId: "inventory-input",
      }],
      allowedExternalMechanisms: [],
      outsideRootImports: "out-of-scope",
    }],
  };
}
