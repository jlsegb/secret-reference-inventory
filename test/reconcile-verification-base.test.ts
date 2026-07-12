import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalCliHandlers } from "../src/app/index.js";
import { parseCli, runCli } from "../src/cli/index.js";

test("standalone reconcile requires an explicit closed-model verification base", () => {
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

test("standalone reconcile canonicalizes only an explicit valid base and never uses cwd", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const handlers = createLocalCliHandlers();

  const missingStderr: string[] = [];
  const missingStatus = await runCli(
    reconcileArguments(fixture, undefined),
    handlers,
    { stdout: () => undefined, stderr: (text) => missingStderr.push(text) },
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
        stdout: (text) => stdout.push(text),
        stderr: (text) => validStderr.push(text),
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
    { stdout: () => undefined, stderr: (text) => relativeStderr.push(text) },
  );
  assert.equal(relativeStatus, 65);
  assert.equal(relativeStderr.join(""), "APP_CLOSED_MODEL_VERIFICATION_BASE_INVALID\n");

  const invalidBase = join(fixture.parent, "does-not-exist");
  const invalidStderr: string[] = [];
  const invalidStatus = await runCli(
    reconcileArguments(fixture, invalidBase),
    handlers,
    { stdout: () => undefined, stderr: (text) => invalidStderr.push(text) },
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
