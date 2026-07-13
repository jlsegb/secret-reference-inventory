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
 * Builds one raw manifest member-scope declaration for parser tests.
 *
 * Inputs: `repositoryId`, `executionScopeId`, `stage`.
 * Outputs: A runtime/environment scope attached to the requested repository ID.
 * Does not handle: Parser validation, stage normalization, or descriptor resolution.
 * Side effects: Allocates an in-memory raw scope object.
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
 * Builds a valid v2 workspace manifest used as the baseline parser fixture.
 *
 * Inputs: no arguments.
 * Outputs: A manifest object with three repositories and both provisioned and scan-only deployments.
 * Does not handle: JSON serialization, parser invocation, or filesystem resolution.
 * Side effects: Calls `memberScope` and allocates nested fixture objects.
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
 * Serializes an object fixture and submits it to the public workspace-manifest text parser.
 *
 * Inputs: `value`.
 * Outputs: The parser's success/failure result for the serialized fixture.
 * Does not handle: Reading a manifest file, JSONC comments, or error recovery.
 * Side effects: Serializes with `JSON.stringify` and invokes the parser.
 */
function parseManifest(value: object): ReturnType<typeof parseWorkspaceManifestText> {
  return parseWorkspaceManifestText(JSON.stringify(value));
}

/**
 * Extracts parser diagnostic codes for concise invalid-manifest assertions.
 *
 * Inputs: `result`.
 * Outputs: The diagnostic `code` strings in parser-emitted order.
 * Does not handle: Deduplicating diagnostics, asserting expected values, or parsing input.
 * Side effects: Maps the parser's in-memory diagnostic array.
 */
function diagnosticCodes(result: ReturnType<typeof parseWorkspaceManifestText>): string[] {
  return result.diagnostics.map(
    /**
     * Extracts parser diagnostic codes so cardinality tests can assert fixed failure classes.
     *
     * Inputs: `diagnostic`.
     * Outputs: The current parser diagnostic's `code` string.
     * Does not handle: Deduplicating diagnostics, evaluating test assertions, or parsing input.
     * Side effects: Reads one diagnostic property without mutation or I/O.
     */
    (diagnostic) => diagnostic.code);
}

/** Models an untyped JavaScript caller crossing the text-only public API. */
const parseUntrustedText = parseWorkspaceManifestText as unknown as (
  input: unknown,
) => ReturnType<typeof parseWorkspaceManifestText>;

test("parses a versioned multi-repository JSONC workspace manifest",
  /**
 * Parses a hand-built JSONC v2 manifest with `api`/`worker` roots and one production deployment.
 * Inputs: No callback arguments; the body constructs JSONC containing normalized root spellings, binding/inventory/closed-model descriptors, and two runtime/environment member scopes.
 * Outputs: Returns after `parseWorkspaceManifestText` yields the v2 schema version, normalized root/descriptors, and the expected deployment projection.
 * Does not handle: Filesystem root resolution, provisioning reads, or recovery from parser/assertion failures.
 * Side effects: Allocates local JSONC text and assertion projections; an unexpected parse failure calls `assert.fail` and escapes.
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
       * Reduces each parsed repository to the root fields relevant to JSONC root-normalization assertions.
       *
       * Inputs: `repository`.
       * Outputs: A new object containing the parsed repository ID and normalized root descriptor.
       * Does not handle: Parsing another repository, modifying parsed output, or resolving filesystem paths.
       * Side effects: Allocates one assertion projection object.
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
       * Reduces each parsed deployment to the fields that verify v2 input descriptor normalization.
       *
       * Inputs: `deployment`.
       * Outputs: A new object retaining the deployment ID, member IDs, and normalized inputs.
       * Does not handle: Resolving descriptors, changing parsed state, or evaluating the assertion.
       * Side effects: Allocates one assertion projection object.
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
 * Builds three invalid repository lists and checks the parser's distinct identity/root diagnostics.
 * Inputs: No callback arguments; local manifests contain duplicate `api` IDs, equivalent `repositories/api` roots, and an ancestor `repositories` root with a child.
 * Outputs: Returns after `parseManifest` rejects each manifest with `duplicate-repository-id`, `duplicate-repository-root`, or `ambiguous-repository-root` respectively.
 * Does not handle: Resolving real directories, repairing the manifests, or accepting partial parser output.
 * Side effects: Allocates local manifest objects and performs strict assertions; parser or assertion failures propagate to the test runner.
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
 * Exercises deployment-member validation with an undeclared `worker` and a repeated `api` member.
 * Inputs: No callback arguments; constructs two one-repository manifests whose production member arrays are deliberately invalid.
 * Outputs: Returns after both `parseManifest` results are failures carrying `undeclared-deployment-member` and `duplicate-deployment-member`.
 * Does not handle: Repository-root parsing, provisioned-input validation, or recovery from a failed assertion.
 * Side effects: Allocates two manifests and reads diagnostic codes; assertion failures propagate.
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
 * Supplies provisioning deployments with only a bindings descriptor and only a closed-model descriptor.
 * Inputs: No callback arguments; each local manifest declares `api` and a production deployment with an intentionally incomplete `inputs` object.
 * Outputs: Returns after both parser results are rejected with `invalid-deployment-inputs`.
 * Does not handle: Reading descriptor files, synthesizing the missing inventory/bindings pair, or retaining invalid deployments.
 * Side effects: Allocates manifest objects and checks diagnostics; failures from parsing or assertions are not caught.
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
 * Compares accepted distinct/disjoint execution scopes with rejected overlapping, legacy-provisioning, and unknown-channel declarations.
 * Inputs: No callback arguments; constructs v2 manifests for separate API/worker scope IDs, shared IDs with overlapping stages, disjoint exact stages, v1 scan-only/provisioning, and an invalid delivery channel.
 * Outputs: Returns after the valid manifest preserves the two scope IDs, disjoint stages remain valid, v1 scan-only normalizes to v2, and each invalid case exposes its specific diagnostic.
 * Does not handle: Delivery at runtime, adapter parsing, or automatic correction of overlapping scopes.
 * Side effects: Allocates several local manifests/projections; `assert.fail`, parser errors, and assertion failures propagate.
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
       * Retains each repository/scope identity pair to prove the declared execution targets differ.
       *
       * Inputs: `entry`.
       * Outputs: A projection with the member's repository ID and exact execution-scope ID.
       * Does not handle: Validating overlap, inspecting other scope fields, or changing the parsed manifest.
       * Side effects: Allocates one projection object.
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
 * Feeds unsafe identifiers, relative/absolute descriptor paths, an unknown field, and malformed JSON carrying a sentinel into the public parser.
 * Inputs: No callback arguments; constructs one hostile object manifest and one truncated JSON string with `TEST SENTINEL VALUE`.
 * Outputs: Returns after unsafe-ID/path/field diagnostics appear, neither serialized result contains the sentinel, and malformed text produces only `invalid-json` at the root.
 * Does not handle: Redacting external logs, parsing a valid manifest, or recovering from a parser/assertion failure.
 * Side effects: Allocates sentinel-bearing local inputs and serializes safe result objects for assertions; failures propagate.
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
 * Parses a scan-only manifest whose API root contains an internal parent-directory segment.
 * Inputs: No callback arguments; derives a valid base manifest, replaces its repository root with `repositories/../repositories/api`, and omits deployment inputs.
 * Outputs: Returns after parsing succeeds with root path `repositories/api` and `inputs === undefined` for the scan-only deployment.
 * Does not handle: Realpath resolution, provisioning document reads, or recovery from `assert.fail` on parse failure.
 * Side effects: Allocates the derived manifest and checks parsed fields; assertion failures propagate.
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
 * Parses sibling repository and infrastructure descriptors that intentionally begin with a parent-directory segment.
 * Inputs: No callback arguments; constructs API/worker roots and paired provisioning descriptors under a parent infrastructure directory.
 * Outputs: Returns after successful parsing preserves `../api` and `../infra/production/bindings.json` rather than collapsing the leading-parent relationship.
 * Does not handle: Containment enforcement at the filesystem boundary, document I/O, or parse-failure recovery.
 * Side effects: Allocates a manifest and reads normalized descriptors; `assert.fail` and assertion failures propagate.
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
 * Constructs arrays just over each public repository, deployment, per-deployment-member, and total-member cardinality limit.
 * Inputs: No callback arguments; creates indexed repository/deployment records and repeated `api`/shared member arrays sized from the exported maximum constants.
 * Outputs: Returns after each `parseManifest` result reports its matching `too-many-*` diagnostic before traversal can accept the oversized structure.
 * Does not handle: Benchmarking allocation cost, truncating arrays, or testing provisioning adapter limits.
 * Side effects: Allocates large in-memory fixture arrays and local projections; parser/assertion failures propagate.
 */
  () => {
  const tooManyRepositories = parseManifest({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: Array.from({ length: MAX_WORKSPACE_REPOSITORIES + 1 },
      /**
       * Creates one distinct repository declaration beyond the parser's repository cardinality limit.
       *
       * Inputs: `_`, `index`.
       * Outputs: A repository ID/root pair derived from the current index.
       * Does not handle: Building deployments, parsing the manifest, or writing a filesystem fixture.
       * Side effects: Allocates one repository declaration.
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
       * Creates one deployment declaration beyond the parser's deployment cardinality limit.
       *
       * Inputs: `_`, `index`.
       * Outputs: A deployment with a unique ID and the existing `api` member.
       * Does not handle: Adding repositories, parsing the manifest, or inspecting sibling deployments.
       * Side effects: Allocates one deployment declaration.
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
           * Supplies the repeated `api` member that intentionally exceeds the per-deployment member limit.
           *
           * Inputs: no arguments.
           * Outputs: The literal repository ID `api` for this array slot.
           * Does not handle: Creating repository definitions, reading the index, or deduplicating members.
           * Side effects: None; returns an interned literal without I/O or mutation.
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
     * Creates a short repository declaration used to exercise total-membership accounting rather than input-size limits.
     *
     * Inputs: `_`, `index`.
     * Outputs: A compact ID/root pair for the current index.
     * Does not handle: Extending the member list, parsing the manifest, or allocating a large payload.
     * Side effects: Allocates one compact repository declaration.
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
     * Extracts all compact repository IDs to reuse them as every deployment's members.
     *
     * Inputs: `repository`.
     * Outputs: The current compact repository's ID.
     * Does not handle: Copying root values, parsing the manifest, or modifying the repository definition.
     * Side effects: Reads one ID field without mutation or I/O.
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
       * Creates one deployment that reuses all compact members to exceed total membership accounting.
       *
       * Inputs: `_`, `index`.
       * Outputs: A uniquely named deployment that references the shared `memberIds` array.
       * Does not handle: Cloning members, inspecting other deployments, or invoking parser validation.
       * Side effects: Allocates one deployment object while retaining the shared member array.
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
 * Passes proxy reflection traps, a throwing property getter, and a revoked proxy through the public untyped parser boundary.
 * Inputs: No callback arguments; creates four hostile values whose traps set local flags and throw `TEST SENTINEL VALUE` if reflection occurs.
 * Outputs: Returns after each input produces root `invalid-json` without the sentinel, and all three trap-invocation flags remain false.
 * Does not handle: Trusting arbitrary JavaScript objects, recovering a triggered trap, or sanitizing external exception logs.
 * Side effects: Creates proxies/getter state, revokes one proxy, and reads mutation flags; assertion failures propagate.
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
