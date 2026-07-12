import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKSPACE_DEPLOYMENTS,
  MAX_WORKSPACE_DEPLOYMENT_MEMBERS,
  MAX_WORKSPACE_REPOSITORIES,
  MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  parseWorkspaceManifestText,
} from "../src/workspace/index.js";

type RawMemberStage =
  | { readonly kind: "all" }
  | { readonly kind: "exact"; readonly values: readonly string[] };

interface RawMemberScope {
  readonly repositoryId: string;
  readonly scope: {
    readonly id: string;
    readonly componentId: string;
    readonly phase: "runtime";
    readonly stage: RawMemberStage;
    readonly channel: "environment";
  };
}

function memberScope(
  repositoryId: string,
  executionScopeId = repositoryId,
  stage: RawMemberStage = { kind: "all" },
): RawMemberScope {
  return {
    repositoryId,
    scope: {
      id: executionScopeId,
      componentId: executionScopeId,
      phase: "runtime",
      stage,
      channel: "environment",
    },
  };
}

function validManifest(): object {
  return {
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "worker", root: "repositories/worker" },
      { id: "web", root: "repositories/web" },
    ],
    deployments: [
      {
        id: "production",
        repositories: ["api", "worker"],
        inputs: {
          bindings: "deployments/production/bindings.json",
          inventory: "deployments/production/inventory.json",
          closedModel: "deployments/production/closed-model.json",
          memberScopes: [memberScope("api"), memberScope("worker")],
        },
      },
      {
        id: "preview",
        repositories: ["web"],
      },
    ],
  };
}

function parseManifest(value: object): ReturnType<typeof parseWorkspaceManifestText> {
  return parseWorkspaceManifestText(JSON.stringify(value));
}

function diagnosticCodes(result: ReturnType<typeof parseWorkspaceManifestText>): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/** Models an untyped JavaScript caller crossing the text-only public API. */
const parseUntrustedText = parseWorkspaceManifestText as unknown as (
  input: unknown,
) => ReturnType<typeof parseWorkspaceManifestText>;

test("parses a versioned multi-repository JSONC workspace manifest", () => {
  const text = [
    "{",
    "  // explicit roots are resolved later by N3",
    '  "schemaVersion": "workspace-manifest/v2",',
    '  "repositories": [',
    '    { "id": "api", "root": "./repositories/api" },',
    '    { "id": "worker", "root": "repositories/worker" },',
    "  ],",
    '  "deployments": [',
    "    {",
    '      "id": "production",',
    '      "repositories": ["api", "worker"],',
    '      "inputs": {',
        '        "bindings": "deployments/production/bindings.json",',
        '        "inventory": "deployments/production/inventory.json",',
        '        "closedModel": "deployments/production/closed-model.json",',
        '        "memberScopes": [',
        '          { "repositoryId": "api", "scope": { "id": "api", "componentId": "api", "phase": "runtime", "stage": { "kind": "all" }, "channel": "environment" } },',
        '          { "repositoryId": "worker", "scope": { "id": "worker", "componentId": "worker", "phase": "runtime", "stage": { "kind": "all" }, "channel": "environment" } },',
        "        ],",
    "      },",
    "    },",
    "  ],",
    "}",
  ].join("\n");

  const result = parseWorkspaceManifestText(text);
  if (result.ok === false) {
    assert.fail(JSON.stringify(result.diagnostics));
  }
  assert.equal(result.ok, true);

  assert.equal(result.value.schemaVersion, WORKSPACE_MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(
    result.value.repositories.map((repository) => ({
      id: repository.id,
      root: repository.root,
    })),
    [
      { id: "api", root: { kind: "manifest-relative", path: "repositories/api" } },
      { id: "worker", root: { kind: "manifest-relative", path: "repositories/worker" } },
    ],
  );
  assert.deepEqual(
    result.value.deployments.map((deployment) => ({
      id: deployment.id,
      repositories: deployment.repositories,
      inputs: deployment.inputs,
    })),
    [
      {
        id: "production",
        repositories: ["api", "worker"],
        inputs: {
          bindings: {
            kind: "manifest-relative",
            path: "deployments/production/bindings.json",
          },
          inventory: {
            kind: "manifest-relative",
            path: "deployments/production/inventory.json",
          },
          closedModel: {
            kind: "manifest-relative",
            path: "deployments/production/closed-model.json",
          },
          memberScopes: [
            { repositoryId: "api", scope: memberScope("api").scope },
            { repositoryId: "worker", scope: memberScope("worker").scope },
          ],
        },
      },
    ],
  );
});

test("rejects duplicate repository IDs, equal roots, and overlapping roots", () => {
  const duplicateId = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "api", root: "repositories/worker" },
    ],
    deployments: [],
  });
  const duplicateRoot = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "worker", root: "./repositories/api" },
    ],
    deployments: [],
  });
  const ambiguousRoots = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "parent", root: "repositories" },
      { id: "child", root: "repositories/api" },
    ],
    deployments: [],
  });

  assert.equal(duplicateId.ok, false);
  assert.equal(diagnosticCodes(duplicateId).includes("duplicate-repository-id"), true);
  assert.equal(duplicateRoot.ok, false);
  assert.equal(diagnosticCodes(duplicateRoot).includes("duplicate-repository-root"), true);
  assert.equal(ambiguousRoots.ok, false);
  assert.equal(diagnosticCodes(ambiguousRoots).includes("ambiguous-repository-root"), true);
});

test("rejects undeclared and duplicate deployment membership", () => {
  const undeclared = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [{ id: "production", repositories: ["api", "worker"] }],
  });
  const duplicate = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [{ id: "production", repositories: ["api", "api"] }],
  });

  assert.equal(undeclared.ok, false);
  assert.equal(diagnosticCodes(undeclared).includes("undeclared-deployment-member"), true);
  assert.equal(duplicate.ok, false);
  assert.equal(diagnosticCodes(duplicate).includes("duplicate-deployment-member"), true);
});

test("requires paired deployment bindings and inventory descriptors", () => {
  const result = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [
      {
        id: "production",
        repositories: ["api"],
        inputs: { bindings: "deployments/production/bindings.json" },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(diagnosticCodes(result).includes("invalid-deployment-inputs"), true);

  const closedModelOnly = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [
      {
        id: "production",
        repositories: ["api"],
        inputs: { closedModel: "deployments/production/closed-model.json" },
      },
    ],
  });
  assert.equal(closedModelOnly.ok, false);
  assert.equal(
    diagnosticCodes(closedModelOnly).includes("invalid-deployment-inputs"),
    true,
  );
});

test("v2 provisioning maps repositories to explicit, non-overlapping execution scopes", () => {
  const distinctTargets = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api-repository", root: "repositories/api" },
      { id: "worker-repository", root: "repositories/worker" },
    ],
    deployments: [{
      id: "production",
      repositories: ["api-repository", "worker-repository"],
      inputs: {
        bindings: "deployments/production/bindings.json",
        inventory: "deployments/production/inventory.json",
        memberScopes: [
          memberScope("api-repository", "api-runtime"),
          memberScope("worker-repository", "worker-runtime"),
        ],
      },
    }],
  });
  if (distinctTargets.ok === false) {
    assert.fail(JSON.stringify(distinctTargets.diagnostics));
  }
  assert.deepEqual(
    distinctTargets.value.deployments[0]?.inputs?.memberScopes.map((entry) => ({
      repositoryId: entry.repositoryId,
      executionScopeId: entry.scope.id,
    })),
    [
      { repositoryId: "api-repository", executionScopeId: "api-runtime" },
      { repositoryId: "worker-repository", executionScopeId: "worker-runtime" },
    ],
  );

  const duplicateTarget = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "worker", root: "repositories/worker" },
    ],
    deployments: [{
      id: "production",
      repositories: ["api", "worker"],
      inputs: {
        bindings: "deployments/production/bindings.json",
        inventory: "deployments/production/inventory.json",
        memberScopes: [
          memberScope("api", "shared-runtime"),
          memberScope("worker", "shared-runtime"),
        ],
      },
    }],
  });
  assert.equal(duplicateTarget.ok, false);
  assert.equal(
    diagnosticCodes(duplicateTarget).includes("overlapping-member-scope"),
    true,
  );

  const partialOverlap = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "worker", root: "repositories/worker" },
    ],
    deployments: [{
      id: "production",
      repositories: ["api", "worker"],
      inputs: {
        bindings: "deployments/production/bindings.json",
        inventory: "deployments/production/inventory.json",
        memberScopes: [
          memberScope("api", "shared-runtime", {
            kind: "exact",
            values: ["production"],
          }),
          memberScope("worker", "shared-runtime"),
        ],
      },
    }],
  });
  assert.equal(partialOverlap.ok, false);
  assert.equal(
    diagnosticCodes(partialOverlap).includes("overlapping-member-scope"),
    true,
  );

  const disjointStages = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "repositories/api" },
      { id: "worker", root: "repositories/worker" },
    ],
    deployments: [{
      id: "production",
      repositories: ["api", "worker"],
      inputs: {
        bindings: "deployments/production/bindings.json",
        inventory: "deployments/production/inventory.json",
        memberScopes: [
          memberScope("api", "shared-runtime", {
            kind: "exact",
            values: ["production"],
          }),
          memberScope("worker", "shared-runtime", {
            kind: "exact",
            values: ["preview"],
          }),
        ],
      },
    }],
  });
  assert.equal(disjointStages.ok, true);

  const legacyProvisioning = parseManifest({
    ...validManifest(),
    schemaVersion: "workspace-manifest/v1",
  });
  assert.equal(legacyProvisioning.ok, false);
  assert.equal(
    diagnosticCodes(legacyProvisioning).includes("legacy-provisioning-requires-v2"),
    true,
  );

  const legacyScanOnly = parseManifest({
    schemaVersion: "workspace-manifest/v1",
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [{ id: "scan-only", repositories: ["api"] }],
  });
  assert.equal(legacyScanOnly.ok, true);
  if (legacyScanOnly.ok) {
    assert.equal(legacyScanOnly.value.schemaVersion, WORKSPACE_MANIFEST_SCHEMA_VERSION);
  }

  const unknownDelivery = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [{
      id: "production",
      repositories: ["api"],
      inputs: {
        bindings: "deployments/production/bindings.json",
        inventory: "deployments/production/inventory.json",
        memberScopes: [{
          ...memberScope("api", "api-runtime"),
          scope: {
            ...memberScope("api", "api-runtime").scope,
            channel: "unknown",
          },
        }],
      },
    }],
  });
  assert.equal(unknownDelivery.ok, false);
  assert.equal(
    diagnosticCodes(unknownDelivery).includes("unsafe-member-scope"),
    true,
  );
});

test("never retains unsafe manifest identifiers, paths, unknown fields, or parse text", () => {
  const sentinel = "TEST SENTINEL VALUE";
  const result = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      {
        id: sentinel,
        root: "repositories/" + sentinel,
        [sentinel]: "unknown",
      },
    ],
    deployments: [
      {
        id: "production",
        repositories: [sentinel],
        inputs: {
          bindings: "../" + sentinel + "/bindings.json",
          inventory: "/absolute/" + sentinel + ".json",
          memberScopes: [memberScope("production")],
        },
      },
    ],
  });
  const malformed = parseWorkspaceManifestText(
    '{ "schemaVersion": "workspace-manifest/v2", "repositories": [',
  );

  assert.equal(result.ok, false);
  assert.equal(diagnosticCodes(result).includes("unsafe-repository-id"), true);
  assert.equal(diagnosticCodes(result).includes("unsafe-relative-path"), true);
  assert.equal(diagnosticCodes(result).includes("unknown-field"), true);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.diagnostics, [{ code: "invalid-json", path: [] }]);
});

test("normalizes only manifest-relative descriptors and keeps scan-only deployments valid", () => {
  const result = parseManifest({
    ...validManifest(),
    repositories: [{ id: "api", root: "repositories/../repositories/api" }],
    deployments: [{ id: "scan-only", repositories: ["api"] }],
  });

  if (result.ok === false) {
    assert.fail(JSON.stringify(result.diagnostics));
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.repositories[0]?.root.path, "repositories/api");
  assert.equal(result.value.deployments[0]?.inputs, undefined);
});

test("retains explicit leading-parent descriptors for sibling repositories and infra", () => {
  const result = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "../api" },
      { id: "worker", root: "../worker" },
    ],
    deployments: [
      {
        id: "production",
        repositories: ["api", "worker"],
        inputs: {
          bindings: "../infra/production/bindings.json",
          inventory: "../infra/production/inventory.json",
          memberScopes: [memberScope("api"), memberScope("worker")],
        },
      },
    ],
  });

  if (result.ok === false) {
    assert.fail(JSON.stringify(result.diagnostics));
  }
  assert.equal(result.value.repositories[0]?.root.path, "../api");
  assert.equal(
    result.value.deployments[0]?.inputs?.bindings.path,
    "../infra/production/bindings.json",
  );
});

test("bounds manifest repository, deployment, and membership cardinality before traversal", () => {
  const tooManyRepositories = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: Array.from({ length: MAX_WORKSPACE_REPOSITORIES + 1 }, (_, index) => ({
      id: "repo" + String(index),
      root: "repositories/repo" + String(index),
    })),
    deployments: [],
  });
  assert.equal(tooManyRepositories.ok, false);
  assert.equal(
    diagnosticCodes(tooManyRepositories).includes("too-many-repositories"),
    true,
  );

  const tooManyDeployments = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: Array.from({ length: MAX_WORKSPACE_DEPLOYMENTS + 1 }, (_, index) => ({
      id: "deployment" + String(index),
      repositories: ["api"],
    })),
  });
  assert.equal(tooManyDeployments.ok, false);
  assert.equal(
    diagnosticCodes(tooManyDeployments).includes("too-many-deployments"),
    true,
  );

  const tooManyMembers = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [{ id: "api", root: "repositories/api" }],
    deployments: [
      {
        id: "production",
        repositories: Array.from(
          { length: MAX_WORKSPACE_DEPLOYMENT_MEMBERS + 1 },
          () => "api",
        ),
      },
    ],
  });
  assert.equal(tooManyMembers.ok, false);
  assert.equal(
    diagnosticCodes(tooManyMembers).includes("too-many-deployment-members"),
    true,
  );

  const repositoryDefinitions = Array.from(
    { length: MAX_WORKSPACE_REPOSITORIES },
    (_, index) => ({
      // Keep the serialized manifest below the public text-parser byte cap so
      // this exercises aggregate membership accounting rather than input size.
      id: "r" + String(index),
      root: "r" + String(index),
    }),
  );
  const memberIds = repositoryDefinitions.map((repository) => repository.id);
  const tooManyTotalMembers = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: repositoryDefinitions,
    deployments: Array.from(
      {
        length:
          Math.floor(MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS / memberIds.length) + 1,
      },
      (_, index) => ({
        id: "d" + String(index),
        repositories: memberIds,
      }),
    ),
  });
  assert.equal(tooManyTotalMembers.ok, false);
  assert.equal(
    diagnosticCodes(tooManyTotalMembers).includes("too-many-total-deployment-members"),
    true,
  );
});

test("public parser rejects hostile object manifests before reflection or getter access", () => {
  const sentinel = "TEST SENTINEL VALUE";
  let prototypeTrapInvoked = false;
  let ownKeysTrapInvoked = false;
  let getterInvoked = false;

  const prototypeTrap = new Proxy({}, {
    getPrototypeOf: () => {
      prototypeTrapInvoked = true;
      throw new Error(sentinel);
    },
  });
  const ownKeysTrap = new Proxy({}, {
    ownKeys: () => {
      ownKeysTrapInvoked = true;
      throw new Error(sentinel);
    },
  });
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "manifest", {
    get: () => {
      getterInvoked = true;
      throw new Error(sentinel);
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  for (const hostile of [prototypeTrap, ownKeysTrap, throwingGetter, revoked.proxy]) {
    const result = parseUntrustedText(hostile);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: "invalid-json", path: [] }]);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }

  assert.equal(prototypeTrapInvoked, false);
  assert.equal(ownKeysTrapInvoked, false);
  assert.equal(getterInvoked, false);
});
