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

/**
 * Assembles the memberScope test value.
 *
 * Inputs: `repositoryId`, `executionScopeId`, `stage`.
 * Outputs: the fixture value returned by `memberScope`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: none; it allocates only in-memory test data.
 */
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

/**
 * Assembles the validManifest test value.
 *
 * Inputs: no arguments.
 * Outputs: the fixture value returned by `validManifest`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `memberScope`.
 */
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

/**
 * Assembles the parseManifest test value.
 *
 * Inputs: `value`.
 * Outputs: the fixture value returned by `parseManifest`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `parseWorkspaceManifestText`, `JSON.stringify`.
 */
function parseManifest(value: object): ReturnType<typeof parseWorkspaceManifestText> {
  return parseWorkspaceManifestText(JSON.stringify(value));
}

/**
 * Assembles the diagnosticCodes test value.
 *
 * Inputs: `result`.
 * Outputs: the fixture value returned by `diagnosticCodes`.
 * Does not handle: validate unrelated production input or suppress assertion failures.
 * Side effects: invokes `result.diagnostics.map`.
 */
function diagnosticCodes(result: ReturnType<typeof parseWorkspaceManifestText>): string[] {
  return result.diagnostics.map(
    /**
     * Projects a report value from the current diagnostic.
     *
     * Inputs: `diagnostic`.
     * Outputs: the `diagnostic.code` result consumed by `result.diagnostics.map`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (diagnostic) => diagnostic.code);
}

/** Models an untyped JavaScript caller crossing the text-only public API. */
const parseUntrustedText = parseWorkspaceManifestText as unknown as (
  input: unknown,
) => ReturnType<typeof parseWorkspaceManifestText>;

test("parses a versioned multi-repository JSONC workspace manifest",
  /**
   * Exercises the “parses a versioned multi-repository JSONC workspace manifest” scenario through `join`, `parseWorkspaceManifestText`, `fail`, `stringify`, `equal`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “parses a versioned multi-repository JSONC workspace manifest”.
   * Outputs: Normal completion only after the “parses a versioned multi-repository JSONC workspace manifest” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `join`, `parseWorkspaceManifestText`, `fail`, `stringify`, `equal`; assertion failures escape.
   */
  () => {
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
    result.value.repositories.map(
      /**
       * Projects a report value from the current repository.
       *
       * Inputs: `repository`.
       * Outputs: the `({ id: repository.id, root: repository.root, })` result consumed by `result.value.repositories.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (repository) => ({
      id: repository.id,
      root: repository.root,
    })),
    [
      { id: "api", root: { kind: "manifest-relative", path: "repositories/api" } },
      { id: "worker", root: { kind: "manifest-relative", path: "repositories/worker" } },
    ],
  );
  assert.deepEqual(
    result.value.deployments.map(
      /**
       * Projects a report value from the current deployment.
       *
       * Inputs: `deployment`.
       * Outputs: the `({ id: deployment.id, repositories: deployment.repositories, inputs: deployment.inputs, })` result consumed by `result.value.deployments.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (deployment) => ({
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

test("rejects duplicate repository IDs, equal roots, and overlapping roots",
  /**
   * Exercises the “rejects duplicate repository IDs, equal roots, and overlapping roots” scenario through `parseManifest`, `equal`, `includes`, `diagnosticCodes`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “rejects duplicate repository IDs, equal roots, and overlapping roots”.
   * Outputs: Normal completion only after the “rejects duplicate repository IDs, equal roots, and overlapping roots” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `equal`, `includes`, `diagnosticCodes`; assertion failures escape.
   */
  () => {
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

test("rejects undeclared and duplicate deployment membership",
  /**
   * Exercises the “rejects undeclared and duplicate deployment membership” scenario through `parseManifest`, `equal`, `includes`, `diagnosticCodes`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “rejects undeclared and duplicate deployment membership”.
   * Outputs: Normal completion only after the “rejects undeclared and duplicate deployment membership” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `equal`, `includes`, `diagnosticCodes`; assertion failures escape.
   */
  () => {
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

test("requires paired deployment bindings and inventory descriptors",
  /**
   * Exercises the “requires paired deployment bindings and inventory descriptors” scenario through `parseManifest`, `equal`, `includes`, `diagnosticCodes`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “requires paired deployment bindings and inventory descriptors”.
   * Outputs: Normal completion only after the “requires paired deployment bindings and inventory descriptors” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `equal`, `includes`, `diagnosticCodes`; assertion failures escape.
   */
  () => {
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

test("v2 provisioning maps repositories to explicit, non-overlapping execution scopes",
  /**
   * Exercises the “v2 provisioning maps repositories to explicit, non-overlapping execution scopes” scenario through `parseManifest`, `memberScope`, `fail`, `stringify`, `deepEqual`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “v2 provisioning maps repositories to explicit, non-overlapping execution scopes”.
   * Outputs: Normal completion only after the “v2 provisioning maps repositories to explicit, non-overlapping execution scopes” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `memberScope`, `fail`, `stringify`, `deepEqual`; assertion failures escape.
   */
  () => {
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
    distinctTargets.value.deployments[0]?.inputs?.memberScopes.map(
      /**
       * Projects a report value from the current entry.
       *
       * Inputs: `entry`.
       * Outputs: the `({ repositoryId: entry.repositoryId, executionScopeId: entry.scope.id, })` result consumed by `distinctTargets.value.deployments[0]?.inputs?.memberScopes.map`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (entry) => ({
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

test("never retains unsafe manifest identifiers, paths, unknown fields, or parse text",
  /**
   * Exercises the “never retains unsafe manifest identifiers, paths, unknown fields, or parse text” scenario through `parseManifest`, `memberScope`, `parseWorkspaceManifestText`, `equal`, `includes`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “never retains unsafe manifest identifiers, paths, unknown fields, or parse text”.
   * Outputs: Normal completion only after the “never retains unsafe manifest identifiers, paths, unknown fields, or parse text” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `memberScope`, `parseWorkspaceManifestText`, `equal`, `includes`; assertion failures escape.
   */
  () => {
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

test("normalizes only manifest-relative descriptors and keeps scan-only deployments valid",
  /**
   * Exercises the “normalizes only manifest-relative descriptors and keeps scan-only deployments valid” scenario through `parseManifest`, `validManifest`, `fail`, `stringify`, `equal`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “normalizes only manifest-relative descriptors and keeps scan-only deployments valid”.
   * Outputs: Normal completion only after the “normalizes only manifest-relative descriptors and keeps scan-only deployments valid” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `validManifest`, `fail`, `stringify`, `equal`; assertion failures escape.
   */
  () => {
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

test("retains explicit leading-parent descriptors for sibling repositories and infra",
  /**
   * Exercises the “retains explicit leading-parent descriptors for sibling repositories and infra” scenario through `parseManifest`, `memberScope`, `fail`, `stringify`, `equal`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “retains explicit leading-parent descriptors for sibling repositories and infra”.
   * Outputs: Normal completion only after the “retains explicit leading-parent descriptors for sibling repositories and infra” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `memberScope`, `fail`, `stringify`, `equal`; assertion failures escape.
   */
  () => {
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

test("bounds manifest repository, deployment, and membership cardinality before traversal",
  /**
   * Exercises the “bounds manifest repository, deployment, and membership cardinality before traversal” scenario through `parseManifest`, `from`, `String`, `equal`, `includes`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “bounds manifest repository, deployment, and membership cardinality before traversal”.
   * Outputs: Normal completion only after the “bounds manifest repository, deployment, and membership cardinality before traversal” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Runs assertions through `parseManifest`, `from`, `String`, `equal`, `includes`; assertion failures escape.
   */
  () => {
  const tooManyRepositories = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: Array.from({ length: MAX_WORKSPACE_REPOSITORIES + 1 },
      /**
       * Constructs one generated fixture element.
       *
       * Inputs: `_`, `index`.
       * Outputs: the `({ id: "repo" + String(index), root: "repositories/repo" + String(index), })` result consumed by `Array.from`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (_, index) => ({
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
    deployments: Array.from({ length: MAX_WORKSPACE_DEPLOYMENTS + 1 },
      /**
       * Constructs one generated fixture element.
       *
       * Inputs: `_`, `index`.
       * Outputs: the `({ id: "deployment" + String(index), repositories: ["api"], })` result consumed by `Array.from`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
      (_, index) => ({
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
          /**
           * Constructs one generated fixture element.
           *
           * Inputs: no arguments.
           * Outputs: the `"api"` result consumed by `Array.from`.
           * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
           * Side effects: none; it derives the current-item result.
           */
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
    /**
     * Constructs one generated fixture element.
     *
     * Inputs: `_`, `index`.
     * Outputs: the `({ // Keep the serialized manifest below the public text-parser byte cap so // this exercises aggregate membership accounting rather than input size. id: "r" + String(index), root: "r" + Str` result consumed by `Array.from`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (_, index) => ({
      // Keep the serialized manifest below the public text-parser byte cap so
      // this exercises aggregate membership accounting rather than input size.
      id: "r" + String(index),
      root: "r" + String(index),
    }),
  );
  const memberIds = repositoryDefinitions.map(
    /**
     * Projects a report value from the current repository.
     *
     * Inputs: `repository`.
     * Outputs: the `repository.id` result consumed by `repositoryDefinitions.map`.
     * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
     * Side effects: none; it derives the current-item result.
     */
    (repository) => repository.id);
  const tooManyTotalMembers = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: repositoryDefinitions,
    deployments: Array.from(
      {
        length:
          Math.floor(MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS / memberIds.length) + 1,
      },
      /**
       * Constructs one generated fixture element.
       *
       * Inputs: `_`, `index`.
       * Outputs: the `({ id: "d" + String(index), repositories: memberIds, })` result consumed by `Array.from`.
       * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
       * Side effects: none; it derives the current-item result.
       */
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

test("public parser rejects hostile object manifests before reflection or getter access",
  /**
   * Exercises the “public parser rejects hostile object manifests before reflection or getter access” scenario through `defineProperty`, `revocable`, `revoke`, `parseUntrustedText`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “public parser rejects hostile object manifests before reflection or getter access”.
   * Outputs: Normal completion only after the “public parser rejects hostile object manifests before reflection or getter access” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither reads a manifest path nor initiates a workspace scan; it parses or validates only the constructed in-memory input used by this test.
   * Side effects: Installs and revokes hostile test objects, then passes them to the in-memory parser.
   */
  () => {
  const sentinel = "TEST SENTINEL VALUE";
  let prototypeTrapInvoked = false;
  let ownKeysTrapInvoked = false;
  let getterInvoked = false;

  const prototypeTrap = new Proxy({}, {
    getPrototypeOf:
      /**
       * Implements the hostile proxy's `getPrototypeOf` trap for the parser-rejection test.
       *
       * Inputs: Reflection supplies the proxy target argument; this zero-argument implementation intentionally ignores it.
       * Outputs: Never returns: it throws the test sentinel when reflection reaches the trap.
       * Does not handle: It neither performs reflection nor decides parser rejection; a reflective prototype lookup supplies the proxy target and this trap only marks the test sentinel before throwing.
       * Side effects: Sets `prototypeTrapInvoked` and throws the deliberate sentinel error.
       */
      () => {
      prototypeTrapInvoked = true;
      throw new Error(sentinel);
    },
  });
  const ownKeysTrap = new Proxy({}, {
    ownKeys:
      /**
       * Implements the hostile proxy's `ownKeys` trap for the parser-rejection test.
       *
       * Inputs: Reflection supplies the proxy target argument; this zero-argument implementation intentionally ignores it.
       * Outputs: Never returns: it throws the test sentinel when reflection reaches the trap.
       * Does not handle: It neither enumerates properties nor decides parser rejection; reflective key enumeration supplies the proxy target and this trap only marks the test sentinel before throwing.
       * Side effects: Sets `ownKeysTrapInvoked` and throws the deliberate sentinel error.
       */
      () => {
      ownKeysTrapInvoked = true;
      throw new Error(sentinel);
    },
  });
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "manifest", {
    get:
      /**
       * Implements the hostile `manifest` getter installed for the parser-rejection test.
       *
       * Inputs: A later read of `throwingGetter.manifest` supplies the property receiver; this zero-argument getter intentionally ignores it.
       * Outputs: Never returns: it throws the test sentinel when that property is read.
       * Does not handle: It neither installs the property nor chooses when it runs; property access invokes this test getter, which only throws the deliberate sentinel.
       * Side effects: Sets `getterInvoked` and throws the deliberate sentinel error.
       */
      () => {
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
