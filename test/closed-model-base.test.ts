import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileLocalRoot } from "../src/app/analysis.js";
import { readLocalJson } from "../src/app/local-json.js";
import type { InternalPath } from "../src/discovery/index.js";

test("closed-model root verification uses its explicit workspace base, not process cwd", /**
 * Asserts reconciliation validates closed-model roots against the supplied workspace base after the process CWD changes.
 *
 * Inputs: The Node test context used to register cleanup.
 * Outputs: A fulfilled promise when no root-unverified diagnostic is emitted; assertion failure rejects it.
 * Does not handle: CLI argument validation or invalid verification-base paths.
 * Side effects: Creates/removes temporary files and temporarily changes/restores process CWD.
 */ async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "secret-usage-closed-model-base-"));
  const workspace = join(parent, "workspace");
  const repository = join(workspace, "repository");
  const unrelatedCwd = join(parent, "unrelated");
  const bindingsPath = join(workspace, "bindings.json");
  const inventoryPath = join(workspace, "inventory.json");
  const closedModelPath = join(workspace, "closed-model.json");
  await mkdir(repository, { recursive: true });
  await mkdir(unrelatedCwd, { recursive: true });
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
  t.after(/**
   * Removes the temporary workspace tree registered by this test.
   *
   * Inputs: None.
   * Outputs: A promise for recursive cleanup completion.
   * Does not handle: Restoring process CWD or reporting cleanup errors.
   * Side effects: Deletes the temporary parent directory.
   */ () => rm(parent, { recursive: true, force: true }));

  const [bindings, inventory, closedModel] = await Promise.all([
    readLocalJson(bindingsPath),
    readLocalJson(inventoryPath),
    readLocalJson(closedModelPath),
  ]);
  if (!bindings.ok || !inventory.ok || !closedModel.ok) {
    throw new Error("Expected valid local closed-model documents");
  }

  const originalCwd = process.cwd();
  process.chdir(unrelatedCwd);
  try {
    const analysis = await reconcileLocalRoot(repository, {
      bindings,
      inventory,
      closedModel,
      verificationBase: (await realpath(workspace)) as InternalPath,
    });
    assert.equal(
      analysis.diagnostics.some(
        /**
         * Detects the fixed diagnostic that would show the explicit base was ignored.
         *
         * Inputs: One safe diagnostic code from reconciliation.
         * Outputs: `true` only for `APP_CLOSED_MODEL_ROOT_UNVERIFIED`.
         * Does not handle: Other diagnostic assertions.
         * Side effects: Converts the code to a string for comparison.
         */ (diagnostic) => String(diagnostic) === "APP_CLOSED_MODEL_ROOT_UNVERIFIED",
      ),
      false,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

/**
 * Writes one JSON fixture document with standard UTF-8 serialization.
 *
 * Inputs: Destination path and JSON-serializable fixture value.
 * Outputs: A fulfilled `undefined` promise or a rejected write/serialization promise.
 * Does not handle: Parent-directory creation, parse validation, or secret redaction.
 * Side effects: Writes one local UTF-8 file.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

/**
 * Builds the minimal closed-provisioning fixture that authorizes the temporary repository and documents.
 *
 * Inputs: None.
 * Outputs: A JSON-serializable closed-model object with one production environment scope.
 * Does not handle: Invalid models, multiple adapters, or dynamic conditions.
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
