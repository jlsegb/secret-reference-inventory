import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileLocalRoot } from "../src/app/analysis.js";
import { readLocalJson } from "../src/app/local-json.js";
import type { InternalPath } from "../src/discovery/index.js";

test("closed-model root verification uses its explicit workspace base, not process cwd", async (t) => {
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
  t.after(() => rm(parent, { recursive: true, force: true }));

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
        (diagnostic) => String(diagnostic) === "APP_CLOSED_MODEL_ROOT_UNVERIFIED",
      ),
      false,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

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
