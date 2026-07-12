import assert from "node:assert/strict";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readLocalWorkspaceManifest } from "../src/app/index.js";
import {
  preflightIssuedWorkspaceDeployment,
  reconcileLocalRoot,
  prepareIssuedLocalDeploymentReconciliation,
  registerDeploymentAttestation,
  reconcilePreparedLocalDeploymentMember,
  scanAttestedLocalWorkspaceMember,
  scanLocalRoot,
} from "../src/app/analysis.js";
import type {
  WorkspaceScanPort,
  WorkspaceScanReportSource,
} from "../src/app/workspace-port.js";
import {
  createLocalWorkspaceScanPort,
  scanWorkspace,
  WorkspaceRuntimeError,
} from "../src/workspace/index.js";
import {
  issueDeploymentPreparation as issueIdentityOnlyDeployment,
  issuedDeploymentMember,
} from "../src/workspace/deployment-capability.js";
import {
  attestVerifiedWorkspaceDeploymentInputs,
  attestVerifiedWorkspaceDeploymentMembers,
} from "../src/workspace/deployment-attestation.js";
import {
  attestVerifiedWorkspaceRepositoryMembers,
  issuedWorkspaceRepositoryMember,
  workspaceRepositoryMemberAttestationMetrics,
} from "../src/workspace/workspace-member-attestation.js";
import {
  beginVerifiedWorkspaceInvocation,
  MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES,
  workspaceInvocationMetrics,
} from "../src/workspace/workspace-invocation.js";
import type {
  DemandEdge,
  DynamicLookupEdge,
  SecretReference,
} from "../src/core/index.js";

import {
  withWorkspaceFixture,
  writeFixtureLayout,
  type WorkspaceFixture,
} from "./helpers/workspace-fixture.js";


async function scanFixture(fixture: WorkspaceFixture) {
  const document = await readLocalWorkspaceManifest(fixture.manifestPath);
  if (document.ok === false) {
    assert.fail(document.code);
  }
  return scanWorkspace(document.request);
}

/** Test-only lower-layer helper; runtime itself always preflights before input I/O. */
async function attestDeploymentInputSnapshot(
  invocation: unknown,
  deploymentId: unknown,
  repositoryMembers: unknown,
) {
  const issuance = await attestVerifiedWorkspaceDeploymentMembers(
    invocation,
    deploymentId,
    repositoryMembers,
  );
  return issuance === undefined
    ? undefined
    : attestVerifiedWorkspaceDeploymentInputs(issuance);
}

function repository(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  id: string,
): Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number] {
  const entry = result.repositories.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected repository " + id);
  return entry as Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number];
}

function deployment(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  id: string,
): Awaited<ReturnType<typeof scanWorkspace>>["deployments"][number] {
  const entry = result.deployments.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected deployment " + id);
  return entry as Awaited<ReturnType<typeof scanWorkspace>>["deployments"][number];
}

function deploymentMember(
  entry: ReturnType<typeof deployment>,
  repositoryId: string,
): ReturnType<typeof deployment>["members"][number] {
  const member = entry.members.find((candidate) => candidate.repositoryId === repositoryId);
  assert.notEqual(member, undefined, "expected deployment member " + repositoryId);
  return member as ReturnType<typeof deployment>["members"][number];
}

function emittedReconciliationGraphFacts(
  reconciliation: Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number]["reconciliation"],
): number {
  const recordFacts = reconciliation.records.reduce((total, record) => {
    const reasons = record.reasons.reduce(
      (reasonTotal, reason) =>
        reasonTotal +
        1 +
        (reason.gapIds?.length ?? 0) +
        (reason.candidateIds?.length ?? 0),
      0,
    );
    const references = record.kind === "demand" ? record.referenceIds.length : 0;
    const repeatedDynamic = record.kind === "dynamic" ? dynamicLookupGraphFacts(record.lookup) : 0;
    return total + 1 + references + repeatedDynamic + reasons;
  }, 0);
  return recordFacts + reconciliation.scopeCoverage.reduce(
    (total, coverage) => total + 1 + coverage.gapIds.length,
    0,
  );
}

function evidenceGraphFacts(
  evidence: readonly { readonly locations: readonly unknown[] }[],
): number {
  return evidence.reduce((total, entry) => total + 1 + entry.locations.length, 0);
}

function referenceGraphFacts(reference: SecretReference): number {
  return 1 + evidenceGraphFacts(reference.evidenceChain);
}

function demandEdgeGraphFacts(edge: DemandEdge): number {
  return 2 + evidenceGraphFacts(edge.evidenceChain);
}

function dynamicLookupGraphFacts(edge: DynamicLookupEdge): number {
  return 2 + edge.likelyKeys.length + evidenceGraphFacts(edge.evidenceChain);
}

function emittedResultGraphFacts(entry: {
  readonly diagnostics: readonly unknown[];
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly reconciliation: Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number]["reconciliation"];
}): number {
  return (
    entry.diagnostics.length +
    entry.references.reduce((total, reference) => total + referenceGraphFacts(reference), 0) +
    entry.demandEdges.reduce((total, edge) => total + demandEdgeGraphFacts(edge), 0) +
    entry.dynamicLookupEdges.reduce((total, edge) => total + dynamicLookupGraphFacts(edge), 0) +
    emittedReconciliationGraphFacts(entry.reconciliation)
  );
}

function emittedDeploymentGraphFacts(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
): number {
  return result.deployments.reduce((total, deployment) =>
    total +
    deployment.sharedKeys.length +
    deployment.diagnostics.length +
    deployment.members.reduce(
      (memberTotal, member) => memberTotal + emittedResultGraphFacts(member),
      0,
    ),
  0);
}

function emittedWorkspaceGraphFacts(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
): number {
  return (
    result.repositories.reduce(
      (total, repository) => total + emittedResultGraphFacts(repository),
      0,
    ) + emittedDeploymentGraphFacts(result)
  );
}

/** A compact fallback is the invocation floor: one empty incomplete status. */
function isBudgetFallbackResult(
  member: {
    readonly status: string;
    readonly diagnostics: readonly unknown[];
    readonly references: readonly unknown[];
    readonly demandEdges: readonly unknown[];
    readonly dynamicLookupEdges: readonly unknown[];
    readonly reconciliation: {
      readonly records: readonly unknown[];
      readonly scopeCoverage: readonly {
        readonly state: string;
        readonly gapIds: readonly unknown[];
      }[];
    };
  },
): boolean {
  return (
    member.status === "incomplete" &&
    member.references.length === 0 &&
    member.demandEdges.length === 0 &&
    member.dynamicLookupEdges.length === 0 &&
    member.diagnostics.length === 0 &&
    member.reconciliation.records.length === 0 &&
    member.reconciliation.scopeCoverage.length === 1 &&
    member.reconciliation.scopeCoverage[0]?.state === "incomplete" &&
    member.reconciliation.scopeCoverage[0]?.gapIds.length === 0
  );
}

function isBudgetFallbackMember(member: ReturnType<typeof deploymentMember>): boolean {
  return isBudgetFallbackResult(member);
}

function assertInvalidManifestProvenance(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  fixture: WorkspaceFixture,
): void {
  assert.equal(result.repositories.every((repository) => repository.status === "invalid"), true);
  assert.equal(result.deployments.every((deployment) => deployment.status === "invalid"), true);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.equal(JSON.stringify(result).includes(fixture.privateSourceMarker), false);
}

test("workspace runtime scans an approved sibling repository through a canonical manifest base", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const result = await scanFixture(fixture);
    const api = repository(result, "api");

    assert.equal(api?.status, "complete");
    assert.equal(
      api?.reconciliation.records.some(
        (record) => record.kind === "demand" && record.key.name === "DATABASE_URL",
      ),
      true,
    );
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
    assert.equal(JSON.stringify(result).includes(fixture.privateSourceMarker), false);
  });
});

test("duplicate keys aggregate only within an explicit shared deployment", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const unrelated = await scanFixture(fixture);
    const apiDeployment = deployment(unrelated, "api-production");
    const workerDeployment = deployment(unrelated, "worker-production");
    assert.deepEqual(apiDeployment?.sharedKeys, []);
    assert.deepEqual(workerDeployment?.sharedKeys, []);

    await writeFixtureLayout(fixture, "shared");
    const shared = await scanFixture(fixture);
    const sharedDeployment = deployment(shared, "shared-production");
    assert.deepEqual(sharedDeployment?.repositoryIds, ["api", "worker"]);
    assert.deepEqual(sharedDeployment?.sharedKeys, [
      { namespace: "env", name: "DATABASE_URL" },
    ]);
    assert.equal(repository(shared, "api")?.status, "complete");
    assert.equal(repository(shared, "worker")?.status, "complete");
  });
});

test("workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
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

    const isFixedRuntimeError = (error: unknown): boolean => {
      assert.equal(error instanceof WorkspaceRuntimeError, true);
      assert.equal(error instanceof TypeError, false);
      assert.equal(String(error).includes(sentinel), false);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    };

    for (const hostile of [prototypeTrap, ownKeysTrap, throwingGetter, revoked.proxy]) {
      await assert.rejects(scanWorkspace(hostile), isFixedRuntimeError);
      await assert.rejects(
        scanWorkspace({
          manifest: hostile,
          manifestPath: sentinel,
        }),
        isFixedRuntimeError,
      );
    }

    assert.equal(prototypeTrapInvoked, false);
    assert.equal(ownKeysTrapInvoked, false);
    assert.equal(getterInvoked, false);

    await assert.rejects(
      scanWorkspace({
        manifest: document.manifest,
        manifestPath: sentinel,
      }),
      (error: unknown) => error instanceof WorkspaceRuntimeError,
    );

    const jsonClone = JSON.parse(JSON.stringify(document.request)) as unknown;
    const structuralClone = Object.assign({}, document.request) as unknown;
    const platformClone = structuredClone(document.request) as unknown;
    const proxyClone = new Proxy(document.request as object, {});
    for (const clone of [jsonClone, structuralClone, platformClone, proxyClone]) {
      await assert.rejects(scanWorkspace(clone), isFixedRuntimeError);
    }
    assert.equal(JSON.stringify(document.request).includes(fixture.manifestPath), false);
    assert.equal(JSON.stringify(document.request).includes(fixture.root), false);
    assert.equal(JSON.stringify(document.request).includes(sentinel), false);
  });
});

test("workspace runtime rejects a request after its verified manifest file is replaced", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    await rename(fixture.manifestPath, join(fixture.controlRoot, "workspace-prior.jsonc"));
    await writeFile(fixture.manifestPath, "{}\n", "utf8");

    assertInvalidManifestProvenance(await scanWorkspace(document.request), fixture);
  });
});

test("workspace runtime rejects a request after its manifest path is replaced by a symlink", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    const replacement = join(fixture.controlRoot, "replacement.jsonc");
    await writeFile(replacement, "{}\n", "utf8");
    await rm(fixture.manifestPath);
    await symlink(replacement, fixture.manifestPath, "file");

    assertInvalidManifestProvenance(await scanWorkspace(document.request), fixture);
  });
});

test("workspace runtime rejects a request after its verified canonical base is replaced", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    await rename(fixture.controlRoot, join(fixture.root, "control-prior"));
    await mkdir(fixture.controlRoot);
    await writeFile(fixture.manifestPath, "{}\n", "utf8");

    assertInvalidManifestProvenance(await scanWorkspace(document.request), fixture);
  });
});

test("workspace runtime rejects equal and nested canonical root aliases before scanning", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await symlink(fixture.repositoryRoots.api, join(fixture.root, "api-alias"), "dir");
    await symlink(
      join(fixture.repositoryRoots.api, "src"),
      join(fixture.root, "api-src-alias"),
      "dir",
    );

    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [
        { id: "api", root: "../api" },
        { id: "api-alias", root: "../api-alias" },
        { id: "api-src-alias", root: "../api-src-alias" },
      ],
      deployments: [],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }

    const result = await scanWorkspace(document.request);

    assert.deepEqual(
      result.repositories.map((repository) => repository.status),
      ["invalid", "invalid", "invalid"],
    );
    assert.equal(
      result.repositories.every((repository) =>
        repository.diagnostics.some(
          (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_CONFLICT",
        ),
      ),
      true,
    );
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("canonical root indexing retains ancestor conflicts across prefix-like siblings", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const ancestor = join(fixture.root, "root-prefix");
    const sibling = join(fixture.root, "root-prefix-");
    const nestedAlias = join(fixture.root, "nested-prefix-alias");
    await Promise.all([
      mkdir(join(ancestor, "nested"), { recursive: true }),
      mkdir(sibling, { recursive: true }),
    ]);
    await symlink(join(ancestor, "nested"), nestedAlias, "dir");
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [
        { id: "ancestor", root: "../root-prefix" },
        { id: "sibling", root: "../root-prefix-" },
        { id: "nested", root: "../nested-prefix-alias" },
      ],
      deployments: [],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }

    const result = await scanWorkspace(document.request);
    assert.deepEqual(
      result.repositories.map((repository) => repository.status),
      ["invalid", "complete", "invalid"],
    );
  });
});

test("request member attestation indexes 10,000 resolved roots without pairwise conflict scans", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const count = 10_000;
    const ids = Array.from({ length: count }, (_, index) => "scale-" + String(index));
    for (let start = 0; start < ids.length; start += 128) {
      await Promise.all(ids.slice(start, start + 128).map((id) =>
        mkdir(join(fixture.root, "scale", id), { recursive: true }),
      ));
    }
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: ids.map((id) => ({ id, root: "../scale/" + id })),
      deployments: [],
    }), "utf8");

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const members = await attestVerifiedWorkspaceRepositoryMembers(document.request);
    const metrics = workspaceRepositoryMemberAttestationMetrics(members);

    assert.notEqual(members, undefined);
    assert.notEqual(metrics, undefined);
    assert.equal(metrics?.repositoryCount, count);
    assert.equal(metrics?.rootResolutionCount, count);
    // Each sorted sibling evicts at most one stack entry. Pairwise checking
    // would perform almost fifty million relations for this input.
    assert.ok((metrics?.rootConflictChecks ?? Number.POSITIVE_INFINITY) <= count * 2);
    assert.notEqual(issuedWorkspaceRepositoryMember(members, "scale-9999"), undefined);
  });
});

test("invocation indexes 10,000 deployment declarations without repeated manifest search", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const count = 10_000;
    const deploymentIds = Array.from(
      { length: count },
      (_, index) => "deployment-index-" + String(index).padStart(4, "0"),
    );
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: [{ id: "api", root: "../api" }],
      deployments: deploymentIds.map((id) => ({ id, repositories: ["api"] })),
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const invocation = await beginVerifiedWorkspaceInvocation(document.request);
    const repositoryMembers = await attestVerifiedWorkspaceRepositoryMembers(document.request);
    if (invocation === undefined || repositoryMembers === undefined) {
      assert.fail("expected indexed invocation and repository members");
    }
    for (const deploymentId of deploymentIds) {
      assert.notEqual(
        await attestVerifiedWorkspaceDeploymentMembers(
          invocation,
          deploymentId,
          repositoryMembers,
        ),
        undefined,
      );
    }
    const metrics = workspaceInvocationMetrics(invocation);
    assert.equal(metrics?.deploymentDeclarationCount, count);
    assert.equal(metrics?.deploymentLookupCount, count);
  });
});

test("workspace shared keys require direct demand rather than finite dynamic possibilities", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.repositoryRoots.worker, "src", "worker.ts"),
      [
        "declare const enabled: boolean;",
        'const choice = enabled ? "DATABASE_URL" : "OTHER_URL";',
        "export const databaseUrl = process.env[choice];",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFixtureLayout(fixture, "shared");

    const result = await scanFixture(fixture);
    const shared = deployment(result, "shared-production");
    const worker = repository(result, "worker");

    assert.equal(worker?.dynamicLookupEdges[0]?.domain.kind, "finite");
    assert.deepEqual(shared?.sharedKeys, []);
  });
});

test("one repository's parser uncertainty stays scoped to that repository and deployment", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const result = await scanFixture(fixture);

    assert.equal(repository(result, "api")?.status, "complete");
    assert.equal(repository(result, "worker")?.status, "complete");
    assert.equal(repository(result, "broken")?.status, "incomplete");
    assert.equal(deployment(result, "api-production")?.status, "complete");
    assert.equal(deployment(result, "broken-production")?.status, "incomplete");

    const dynamic = repository(result, "dynamic");
    assert.equal(dynamic?.status, "incomplete");
    assert.equal(dynamic?.dynamicLookupEdges.length, 1);
    assert.equal(dynamic?.dynamicLookupEdges[0]?.domain.kind, "unbounded");
    assert.equal(
      dynamic?.dynamicLookupEdges[0]?.domain.kind === "unbounded" &&
        dynamic.dynamicLookupEdges[0].domain.reason,
      "user-controlled",
    );
    assert.deepEqual(dynamic?.dynamicLookupEdges[0]?.likelyKeys, []);
  });
});

test("a malformed deployment input is scoped to its deployment, not its code repository", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.infraRoot, "api-production", "bindings.json"),
      "{",
      "utf8",
    );

    const result = await scanFixture(fixture);
    const api = repository(result, "api");
    const apiDeployment = deployment(result, "api-production");
    const workerDeployment = deployment(result, "worker-production");

    assert.equal(api?.status, "complete");
    assert.equal(apiDeployment?.status, "incomplete");
    assert.equal(
      deploymentMember(apiDeployment, "api")?.diagnostics.some(
        (diagnostic) => diagnostic === "APP_LOCAL_INPUT_INVALID_JSON",
      ),
      true,
    );
    assert.equal(
      deploymentMember(apiDeployment, "api")?.reconciliation.scopeCoverage.some(
        (coverage) => coverage.state === "incomplete",
      ),
      true,
    );
    assert.equal(workerDeployment?.status, "complete");
  });
});

test("an oversized provisioning document is scoped incomplete and cannot support absence", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const sentinel = "TEST SENTINEL VALUE";
    const candidates = new Array<unknown>(100_001).fill(null);
    candidates[candidates.length - 1] = sentinel;
    await writeFile(
      join(fixture.infraRoot, "api-production", "bindings.json"),
      JSON.stringify({
        schemaVersion: "binding-manifest/v1",
        inputId: "api-production-bindings",
        adapterId: "fixture-adapter",
        candidates,
      }),
      "utf8",
    );

    const result = await scanFixture(fixture);
    const apiDeployment = deployment(result, "api-production");
    const member = deploymentMember(apiDeployment, "api");

    assert.equal(apiDeployment.status, "incomplete");
    assert.equal(member.status, "incomplete");
    assert.equal(
      member.diagnostics.some(
        (diagnostic) => String(diagnostic) === "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED",
      ),
      true,
    );
    assert.equal(
      member.reconciliation.scopeCoverage.some((coverage) => coverage.state === "incomplete"),
      true,
    );
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  });
});

test("unscoped inventory without a member-scoped provider binding stays unattributed", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.infraRoot, "api-production", "inventory.json"),
      JSON.stringify({
        schemaVersion: "inventory-snapshot/v1",
        inputId: "api-production-inventory",
        authorityId: "fixture-authority",
        asOf: "2026-07-12T00:00:00Z",
        items: [
          {
            providerResourceId: {
              authorityId: "fixture-authority",
              canonicalId: "unused-fixture-resource",
            },
          },
        ],
      }),
      "utf8",
    );

    const result = await scanFixture(fixture);
    const api = repository(result, "api");
    const apiDeployment = deployment(result, "api-production");

    assert.equal(api?.status, "complete");
    assert.equal(
      api?.reconciliation.records.some((record) => record.kind === "inventory"),
      false,
    );
    assert.equal(apiDeployment?.status, "incomplete");
    assert.equal(
      deploymentMember(apiDeployment, "api")?.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "unused-fixture-resource",
      ),
      false,
    );
    assert.equal(
      apiDeployment?.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
  });
});

test("workspace deployment closed-model verification uses the captured manifest base after chdir", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const manifestPath = join(fixture.root, "workspace.jsonc");
    const closedModelPath = join(fixture.infraRoot, "api-production", "closed-model.json");
    const unrelatedCwd = join(fixture.root, "unrelated");
    await mkdir(unrelatedCwd);
    await writeFile(
      closedModelPath,
      JSON.stringify(closedModelDocumentForWorkspaceRuntime()),
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "workspace-manifest/v2",
        repositories: [{ id: "api", root: "api" }],
        deployments: [{
          id: "api-production",
          repositories: ["api"],
          inputs: {
            bindings: "infra/api-production/bindings.json",
            inventory: "infra/api-production/inventory.json",
            closedModel: "infra/api-production/closed-model.json",
            memberScopes: [{
              repositoryId: "api",
              scope: {
                id: "api",
                componentId: "api",
                phase: "runtime",
                stage: { kind: "all" },
                channel: "environment",
              },
            }],
          },
        }],
      }),
      "utf8",
    );
    const document = await readLocalWorkspaceManifest(manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    const originalCwd = process.cwd();
    process.chdir(unrelatedCwd);
    try {
      const result = await scanWorkspace(document.request);
      const apiDeployment = deployment(result, "api-production");
      assert.equal(apiDeployment?.status, "complete");
      assert.equal(
        apiDeployment?.diagnostics.some(
          (diagnostic) => String(diagnostic) === "APP_CLOSED_MODEL_ROOT_UNVERIFIED",
        ),
        false,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("multi-member closed provisioning remains independently verifiable after chdir", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    const manifestPath = join(fixture.root, "workspace-multi-closed.jsonc");
    const closedModelPath = join(fixture.infraRoot, "shared-production", "closed-model.json");
    const unrelatedCwd = join(fixture.root, "unrelated-multi");
    await mkdir(unrelatedCwd);
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate(
          "api",
          "api-database",
          undefined,
          productionMemberExecutionScope("api"),
        ),
        bindingCandidate(
          "worker",
          "worker-database",
          undefined,
          productionMemberExecutionScope("worker"),
        ),
      ]),
      inventorySnapshot([
        inventoryItem(
          "api",
          "api-database",
          undefined,
          productionMemberExecutionScope("api"),
        ),
        inventoryItem(
          "worker",
          "worker-database",
          undefined,
          productionMemberExecutionScope("worker"),
        ),
      ]),
    );
    await writeFile(
      closedModelPath,
      JSON.stringify(closedModelDocumentForSharedWorkspaceRuntime()),
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "workspace-manifest/v2",
        repositories: [
          { id: "api", root: "api" },
          { id: "worker", root: "worker" },
        ],
        deployments: [{
          id: "shared-production",
          repositories: ["api", "worker"],
          inputs: {
            bindings: "infra/shared-production/bindings.json",
            inventory: "infra/shared-production/inventory.json",
            closedModel: "infra/shared-production/closed-model.json",
            memberScopes: [
              {
                repositoryId: "api",
                scope: productionMemberExecutionScope("api"),
              },
              {
                repositoryId: "worker",
                scope: productionMemberExecutionScope("worker"),
              },
            ],
          },
        }],
      }),
      "utf8",
    );
    const document = await readLocalWorkspaceManifest(manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    const originalCwd = process.cwd();
    process.chdir(unrelatedCwd);
    try {
      const shared = deployment(await scanWorkspace(document.request), "shared-production");
      assert.equal(shared.status, "complete");
      assert.deepEqual(shared.members.map((member) => member.repositoryId), ["api", "worker"]);
      for (const member of shared.members) {
        assert.equal(member.status, "complete");
        assert.equal(
          member.diagnostics.some(
            (diagnostic) => diagnostic === "APP_CLOSED_MODEL_ROOT_UNVERIFIED",
          ),
          false,
        );
      }

      await writeFile(
        join(fixture.infraRoot, "shared-production", "inventory.json"),
        JSON.stringify(inventorySnapshot([unscopedInventoryItem("unattributed-resource")])),
        "utf8",
      );
      const withUnattributedInventory = deployment(
        await scanWorkspace(document.request),
        "shared-production",
      );
      assert.equal(withUnattributedInventory.status, "incomplete");
      for (const member of withUnattributedInventory.members) {
        assert.equal(
          member.diagnostics.some(
            (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
          ),
          true,
        );
        assert.equal(
          member.reconciliation.records.some(
            (record) =>
              record.kind === "demand" &&
              record.inventory === "missing-under-declared-model",
          ),
          false,
        );
      }

      await writeFile(
        join(fixture.infraRoot, "shared-production", "inventory.json"),
        JSON.stringify(inventorySnapshot([{
          providerResourceId: {
            authorityId: "fixture-authority",
            canonicalId: "mixed-ownership-resource",
          },
          declaredScopes: [
            productionMemberExecutionScope("api"),
            {
              id: "unknown-target",
              componentId: "unknown-target",
              phase: "runtime",
              stage: { kind: "all" },
              channel: "environment",
            },
          ],
        }])),
        "utf8",
      );
      const withMixedUnknownOwnership = deployment(
        await scanWorkspace(document.request),
        "shared-production",
      );
      assert.equal(withMixedUnknownOwnership.status, "incomplete");
      for (const member of withMixedUnknownOwnership.members) {
        assert.equal(
          member.diagnostics.some(
            (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
          ),
          true,
        );
        assert.equal(
          member.reconciliation.records.some(
            (record) =>
              record.kind === "demand" &&
              record.inventory === "missing-under-declared-model",
          ),
          false,
        );
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("multi-repository deployment keeps exact provisioning in independent repository-qualified partitions", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    const apiScope = memberExecutionScope("api", "api-runtime-target");
    const workerScope = memberExecutionScope("worker", "worker-runtime-target");
    const outsiderScope = memberExecutionScope(
      "outsider",
      "outsider-runtime-target",
      { kind: "exact", values: ["production"] },
    );
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        schemaVersion: "workspace-manifest/v2",
        repositories: [
          { id: "api", root: "../api" },
          { id: "worker", root: "../worker" },
        ],
        deployments: [{
          id: "shared-production",
          repositories: ["api", "worker"],
          inputs: {
            bindings: "../infra/shared-production/bindings.json",
            inventory: "../infra/shared-production/inventory.json",
            memberScopes: [
              { repositoryId: "api", scope: apiScope },
              { repositoryId: "worker", scope: workerScope },
            ],
          },
        }],
      }),
      "utf8",
    );
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "api-database", undefined, apiScope),
        bindingCandidate("worker", "worker-database", undefined, workerScope),
        bindingCandidate("outsider", "outsider-database", undefined, outsiderScope),
      ]),
      inventorySnapshot([
        unscopedInventoryItem("api-database"),
        unscopedInventoryItem("worker-database"),
        inventoryItem("outsider", "outsider-database", undefined, outsiderScope),
      ]),
    );
    const result = await scanFixture(fixture);
    const shared = deployment(result, "shared-production");

    assert.equal(shared?.status, "complete");
    assert.deepEqual(shared?.members.map((member) => member.repositoryId), ["api", "worker"]);
    assert.deepEqual(shared?.sharedKeys, [
      { namespace: "env", name: "DATABASE_URL" },
    ]);
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(
      api?.reconciliation.records.some(
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      api?.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "worker-database",
      ),
      false,
    );
    assert.equal(
      api?.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "outsider-database",
      ),
      false,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "outsider-database",
      ),
      false,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-database",
      ),
      false,
    );
  });
});

test("an explicitly shared provider resource remains bound in each exact member partition", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "shared-database"),
        bindingCandidate("worker", "shared-database"),
      ]),
      inventorySnapshot([{
        providerResourceId: {
          authorityId: "fixture-authority",
          canonicalId: "shared-database",
        },
        declaredScopes: [memberExecutionScope("api"), memberExecutionScope("worker")],
      }]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    assert.equal(shared.status, "complete");
    assert.deepEqual(shared.sharedKeys, [{ namespace: "env", name: "DATABASE_URL" }]);
    for (const repositoryId of ["api", "worker"]) {
      const member = deploymentMember(shared, repositoryId);
      assert.equal(
        member.reconciliation.records.some(
          (record) =>
            record.kind === "demand" &&
            record.binding === "exact-declared" &&
            record.inventory === "bound",
        ),
        true,
      );
      assert.equal(
        member.diagnostics.some(
          (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
        ),
        false,
      );
    }
  });
});

test("contradictory inventory ownership makes only listed member partitions inconclusive", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "api-database"),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        {
          providerResourceId: {
            authorityId: "fixture-authority",
            canonicalId: "api-database",
          },
          declaredScopes: [memberExecutionScope("api"), memberExecutionScope("worker")],
        },
        inventoryItem("worker", "worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(shared?.status, "incomplete");
    for (const member of [api, worker]) {
      assert.equal(
        member?.diagnostics.some(
          (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
        ),
        true,
      );
      assert.equal(
        member?.reconciliation.records.some(
          (record) => record.kind === "demand" && record.disposition === "inconclusive",
        ),
        true,
      );
      assert.equal(
        member?.reconciliation.records.some(
          (record) => record.kind === "inventory" && record.inventory === "inventory-listed-no-static-read",
        ),
        false,
      );
    }
  });
});

test("a dynamic binding candidate cannot make unscoped inventory shared across members", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "shared-database", undefined, undefined, "dynamic"),
        bindingCandidate("worker", "shared-database"),
      ]),
      inventorySnapshot([unscopedInventoryItem("shared-database")]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.deepEqual(shared.sharedKeys, [{ namespace: "env", name: "DATABASE_URL" }]);
    assert.equal(
      api.reconciliation.records.some(
        (record) => record.kind === "demand" && record.binding === "dynamic",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "shared-database",
      ),
      false,
    );
    assert.equal(
      worker.reconciliation.records.some(
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
  });
});

test("a dynamic binding competitor prevents an exact candidate from proving a bound member relation", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate(
          "api",
          "api-exact-database",
          undefined,
          undefined,
          "exact",
          undefined,
          "exact",
          1,
        ),
        bindingCandidate(
          "api",
          "api-dynamic-database",
          undefined,
          undefined,
          "dynamic",
          undefined,
          "dynamic",
          2,
        ),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        unscopedInventoryItem("api-exact-database"),
        unscopedInventoryItem("worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    assert.equal(shared.status, "incomplete");
    assert.equal(
      api.reconciliation.records.some(
        (record) =>
          record.kind === "demand" &&
          record.binding === "dynamic" &&
          record.disposition === "inconclusive",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-exact-database",
      ),
      false,
    );
  });
});

test("an unknown binding scope makes only its potentially affected member inconclusive", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        {
          id: "unknown-target-binding",
          adapterId: "fixture",
          scope: {
            id: "unknown-target",
            componentId: "unknown-target",
            phase: "unknown",
            stage: { kind: "unknown" },
            channel: "unknown",
          },
          destination: { namespace: "env", name: "DATABASE_URL" },
          sourceKind: "secret-manager",
          providerResourceId: {
            authorityId: "fixture-authority",
            canonicalId: "api-database",
          },
          appliesWhen: {
            executionUnitIds: ["api"],
            phases: ["runtime"],
            stage: { kind: "all" },
            channels: ["environment"],
            condition: { kind: "always" },
          },
          precedence: { source: "fixture", rank: 1, comparable: true },
          resolution: "exact",
        },
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        inventoryItem("api", "api-database"),
        inventoryItem("worker", "worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(shared.status, "incomplete");
    assert.equal(
      api.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_BINDING_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) => record.kind === "demand" && record.disposition === "inconclusive",
      ),
      true,
    );
    assert.equal(
      worker.status,
      "complete",
    );
    assert.equal(
      worker.reconciliation.records.some(
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
  });
});

test("a partial binding selector cannot turn unscoped inventory into an exact member binding", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate(
          "api",
          "api-database",
          undefined,
          undefined,
          "exact",
          { kind: "exact", values: ["production"] },
        ),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        unscopedInventoryItem("api-database"),
        unscopedInventoryItem("worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(shared.status, "incomplete");
    assert.equal(
      shared.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) => record.kind === "demand" && record.binding === "unresolved",
      ),
      true,
    );
    assert.equal(worker.status, "incomplete");
    assert.equal(
      worker.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
  });
});

test("a shadowed binding cannot claim an otherwise unscoped inventory item", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate(
          "api",
          "api-active-database",
          undefined,
          undefined,
          "exact",
          undefined,
          "active",
          2,
        ),
        bindingCandidate(
          "api",
          "api-shadowed-database",
          undefined,
          undefined,
          "exact",
          undefined,
          "shadowed",
          1,
        ),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        unscopedInventoryItem("api-active-database"),
        unscopedInventoryItem("api-shadowed-database"),
        unscopedInventoryItem("worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    assert.equal(shared.status, "incomplete");
    assert.equal(
      shared.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) =>
          record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-shadowed-database",
      ),
      false,
    );
  });
});

test("mismatched inventory authority cannot become a cross-member bound relation", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "api-database", "other-authority"),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        inventoryItem("api", "api-database"),
        inventoryItem("worker", "worker-database"),
      ]),
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(shared?.status, "incomplete");
    assert.equal(
      api?.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
    assert.equal(
      api?.reconciliation.records.some(
        (record) =>
          record.kind === "demand" &&
          record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api?.reconciliation.records.some(
        (record) => record.kind === "demand" && record.disposition === "inconclusive",
      ),
      true,
    );
    assert.equal(worker?.status, "complete");
  });
});

test("a broken deployment member does not erase an independently reconciled sibling", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFixtureLayout(fixture, "shared");
    await writeDeploymentProvisioning(
      fixture,
      "shared-production",
      bindingManifest([
        bindingCandidate("api", "api-database"),
        bindingCandidate("worker", "worker-database"),
      ]),
      inventorySnapshot([
        inventoryItem("api", "api-database"),
        inventoryItem("worker", "worker-database"),
      ]),
    );
    await writeFile(
      join(fixture.repositoryRoots.worker, "src", "worker.ts"),
      "export const = ;\n",
      "utf8",
    );

    const shared = deployment(await scanFixture(fixture), "shared-production");
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(shared?.status, "incomplete");
    assert.equal(api?.status, "complete");
    assert.equal(worker?.status, "incomplete");
    assert.equal(
      api?.reconciliation.records.some(
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
  });
});

test("an unresolved deployment root does not erase a valid sibling partition", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const inputRoot = join(fixture.infraRoot, "root-isolation");
    await mkdir(inputRoot, { recursive: true });
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindingManifest([])), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [
        { id: "api", root: "../api" },
        { id: "missing", root: "../missing-root" },
      ],
      deployments: [{
        id: "root-isolation",
        repositories: ["api", "missing"],
        inputs: {
          bindings: "../infra/root-isolation/bindings.json",
          inventory: "../infra/root-isolation/inventory.json",
          memberScopes: [
            {
              repositoryId: "api",
              scope: {
                id: "api-root-isolation",
                componentId: "api-root-isolation",
                phase: "runtime",
                stage: { kind: "all" },
                channel: "environment",
              },
            },
            {
              repositoryId: "missing",
              scope: {
                id: "missing-root-isolation",
                componentId: "missing-root-isolation",
                phase: "runtime",
                stage: { kind: "all" },
                channel: "environment",
              },
            },
          ],
        },
      }],
    }), "utf8");

    const result = await scanFixture(fixture);
    const rootIsolation = deployment(result, "root-isolation");
    const api = deploymentMember(rootIsolation, "api");
    const missing = deploymentMember(rootIsolation, "missing");
    assert.equal(rootIsolation.status, "invalid");
    assert.equal(api.status, "complete");
    assert.equal(api.references.length > 0, true);
    assert.equal(missing.status, "invalid");
    assert.equal(
      missing.diagnostics.some(
        (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_UNAVAILABLE",
      ),
      true,
    );
  });
});

test("one repository can participate in separate deployments without provisioning or source-snapshot merge", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await Promise.all([
      mkdir(join(fixture.infraRoot, "first-production"), { recursive: true }),
      mkdir(join(fixture.infraRoot, "second-production"), { recursive: true }),
    ]);
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        schemaVersion: "workspace-manifest/v2",
        repositories: [{ id: "api", root: "../api" }],
        deployments: [
          deploymentWithMemberScope("first-production"),
          deploymentWithMemberScope("second-production"),
        ],
      }),
      "utf8",
    );
    await writeDeploymentProvisioning(
      fixture,
      "first-production",
      bindingManifest([bindingCandidate("api", "first-database")]),
      inventorySnapshot([inventoryItem("api", "first-database")]),
    );
    await writeDeploymentProvisioning(
      fixture,
      "second-production",
      bindingManifest([bindingCandidate("api", "second-database")]),
      inventorySnapshot([inventoryItem("api", "second-database")]),
    );

    const result = await scanFixture(fixture);
    const first = deploymentMember(deployment(result, "first-production"), "api");
    const second = deploymentMember(deployment(result, "second-production"), "api");
    assert.equal(first?.status, "complete");
    assert.equal(second?.status, "complete");
    assert.equal(
      first?.reconciliation.records.some(
        (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "first-database",
      ),
      true,
    );
    assert.equal(
      first?.reconciliation.records.some(
        (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "second-database",
      ),
      false,
    );
    assert.equal(
      second?.reconciliation.records.some(
        (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "second-database",
      ),
      true,
    );
    assert.deepEqual(first?.references, second?.references);
    assert.deepEqual(first?.demandEdges, second?.demandEdges);
    assert.notStrictEqual(first?.references, second?.references);
    assert.notStrictEqual(first?.demandEdges, second?.demandEdges);
  });
});

test("workspace runtime exposes the exact narrow N5 port shape", async () => {
  const port: WorkspaceScanPort<WorkspaceScanReportSource> = createLocalWorkspaceScanPort();
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const result = await port.scan(document.request);
    assert.equal(result.repositories.length, 4);
    assert.equal(result.deployments.length, 4);
  });
});

test("runtime deployment preparation bounds broad binding and inventory fanout", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const memberCount = 100;
    const candidateCount = 1_001;
    const repositoryIds = Array.from({ length: memberCount }, (_, index) => "fanout-" + String(index));
    await Promise.all(repositoryIds.map((id) => mkdir(join(fixture.root, id), { recursive: true })));
    const memberScopes = repositoryIds.map((repositoryId, index) => ({
      repositoryId,
      scope: {
        id: "fanout-runtime",
        componentId: "fanout-runtime",
        phase: "runtime",
        stage: { kind: "exact", values: ["fanout-stage-" + String(index)] },
        channel: "environment",
      },
    }));
    const broadScope = {
      id: "fanout-runtime",
      componentId: "fanout-runtime",
      phase: "runtime" as const,
      stage: { kind: "all" as const },
      channel: "environment" as const,
    };
    const deployments = ["binding-fanout", "inventory-fanout"].map((id) => ({
      id,
      repositories: repositoryIds,
      inputs: {
        bindings: "../infra/" + id + "/bindings.json",
        inventory: "../infra/" + id + "/inventory.json",
        memberScopes,
      },
    }));
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        schemaVersion: "workspace-manifest/v2",
        repositories: repositoryIds.map((id) => ({ id, root: "../" + id })),
        deployments,
      }),
      "utf8",
    );
    await Promise.all(deployments.map(async (deployment) => {
      const directory = join(fixture.infraRoot, deployment.id);
      await mkdir(directory, { recursive: true });
      const bindingCandidates = deployment.id === "binding-fanout"
        ? Array.from({ length: candidateCount }, (_, index) => bindingCandidate(
            "fanout",
            "binding-resource-" + String(index),
            "fixture-authority",
            broadScope,
            "exact",
            { kind: "all" },
            String(index),
          ))
        : [];
      const inventoryItems = deployment.id === "inventory-fanout"
        ? Array.from({ length: candidateCount }, (_, index) => inventoryItem(
            "fanout",
            "inventory-resource-" + String(index),
            "fixture-authority",
            broadScope,
          ))
        : [];
      await Promise.all([
        writeFile(join(directory, "bindings.json"), JSON.stringify(bindingManifest(bindingCandidates)), "utf8"),
        writeFile(join(directory, "inventory.json"), JSON.stringify(inventorySnapshot(inventoryItems)), "utf8"),
      ]);
    }));

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const result = await scanWorkspace(document.request);
    assert.equal(
      deployment(result, "binding-fanout").diagnostics.some(
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_BINDING_FANOUT_EXCEEDED",
      ),
      true,
    );
    assert.equal(
      deployment(result, "inventory-fanout").diagnostics.some(
        (diagnostic) =>
          String(diagnostic) === "WORKSPACE_DEPLOYMENT_INVENTORY_FANOUT_EXCEEDED" ||
          String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",
      ),
      true,
    );
  });
});

test("runtime projection budget bounds source-rich member output deterministically", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const memberCount = 100;
    const readsPerMember = 1_001;
    const repositoryIds = Array.from(
      { length: memberCount },
      (_, index) => "projection-" + String(index),
    );
    const source = Array.from(
      { length: readsPerMember },
      (_, index) => "export const value" + String(index) + " = process.env.PROJECTION_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all(repositoryIds.map(async (id) => {
      const root = join(fixture.root, id, "src");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "index.ts"), source, "utf8");
    }));
    const memberScopes = repositoryIds.map((repositoryId) => ({
      repositoryId,
      scope: {
        id: "scope-" + repositoryId,
        componentId: "component-" + repositoryId,
        phase: "runtime" as const,
        stage: { kind: "all" as const },
        channel: "environment" as const,
      },
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: repositoryIds.map((id) => ({ id, root: "../" + id })),
      deployments: [{
        id: "projection-budget",
        repositories: repositoryIds,
        inputs: {
          bindings: "../infra/projection-budget/bindings.json",
          inventory: "../infra/projection-budget/inventory.json",
          memberScopes,
        },
      }],
    }), "utf8");
    const provisioningRoot = join(fixture.infraRoot, "projection-budget");
    await mkdir(provisioningRoot, { recursive: true });
    await Promise.all([
      writeFile(join(provisioningRoot, "bindings.json"), JSON.stringify(bindingManifest([])), "utf8"),
      writeFile(join(provisioningRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const firstWorkspace = await scanWorkspace(document.request);
    const first = deployment(firstWorkspace, "projection-budget");
    const exhausted = first.members
      .filter(isBudgetFallbackMember)
      .map((member) => member.repositoryId);

    assert.ok(exhausted.length > 0);
    assert.ok(firstWorkspace.repositories.some(isBudgetFallbackResult));
    assert.ok(emittedWorkspaceGraphFacts(firstWorkspace) <= 100_000);
    for (const member of first.members.filter((entry) => exhausted.includes(entry.repositoryId))) {
      assert.equal(member.status, "incomplete");
      assert.deepEqual(member.references, []);
      assert.deepEqual(member.demandEdges, []);
      assert.equal(
        member.reconciliation.scopeCoverage.some((coverage) => coverage.state === "incomplete"),
        true,
      );
      assert.equal(
        member.reconciliation.records.some((record) => record.coverage === "complete"),
        false,
      );
    }

    const second = deployment(await scanWorkspace(document.request), "projection-budget");
    const exhaustedAgain = second.members
      .filter(isBudgetFallbackMember)
      .map((member) => member.repositoryId);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("repository-only admission shares the invocation graph ledger", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const repositoryCount = 40;
    const readsPerRepository = 1_001;
    const repositoryIds = Array.from(
      { length: repositoryCount },
      (_, index) => "repository-budget-" + String(index),
    );
    const source = Array.from(
      { length: readsPerRepository },
      (_, index) =>
        "export const value" + String(index) +
        " = process.env.REPOSITORY_BUDGET_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all(repositoryIds.map(async (id) => {
      const root = join(fixture.root, id, "src");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "index.ts"), source, "utf8");
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: repositoryIds.map((id) => ({ id, root: "../" + id })),
      deployments: [],
    }), "utf8");

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const first = await scanWorkspace(document.request);
    const fallback = first.repositories
      .filter(isBudgetFallbackResult)
      .map((repository) => repository.id);
    assert.ok(fallback.length > 0);
    assert.ok(fallback.length < repositoryCount);
    assert.ok(emittedWorkspaceGraphFacts(first) <= 100_000);

    const second = await scanWorkspace(document.request);
    assert.deepEqual(
      second.repositories.filter(isBudgetFallbackResult).map((repository) => repository.id),
      fallback,
    );
  });
});

test("nested coverage evidence is admitted before Core record materialization", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const demandCount = 1_000;
    const source = Array.from(
      { length: demandCount },
      (_, index) =>
        "export const value" + String(index) +
        " = process.env.NESTED_EVIDENCE_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), source, "utf8");
    const inputRoot = join(fixture.infraRoot, "nested-evidence");
    await mkdir(inputRoot, { recursive: true });
    const invalidCandidates = Array.from(
      { length: 1_000 },
      () => ({ invalid: "not-a-binding-candidate" }),
    );
    await Promise.all([
      writeFile(
        join(inputRoot, "bindings.json"),
        JSON.stringify(bindingManifest(invalidCandidates)),
        "utf8",
      ),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    const apiScope = {
      id: "nested-evidence-api",
      componentId: "nested-evidence-api",
      phase: "runtime",
      stage: { kind: "all" },
      channel: "environment",
    };
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments: [{
        id: "nested-evidence",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/nested-evidence/bindings.json",
          inventory: "../infra/nested-evidence/inventory.json",
          memberScopes: [{ repositoryId: "api", scope: apiScope }],
        },
      }],
    }), "utf8");

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const result = await scanWorkspace(document.request);
    const member = deploymentMember(deployment(result, "nested-evidence"), "api");
    assert.equal(isBudgetFallbackMember(member), true);
    assert.equal(member.reconciliation.scopeCoverage[0]?.gapIds.length, 0);
    assert.ok(emittedWorkspaceGraphFacts(result) <= 100_000);
  });
});

test("workspace projection budget does not reset for the same source in later deployments", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const deploymentCount = 51;
    const reads = Array.from(
      { length: 1_001 },
      (_, index) => "export const repeat" + String(index) + " = process.env.REPEAT_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8");
    const inputRoot = join(fixture.infraRoot, "workspace-budget-repeat");
    await mkdir(inputRoot, { recursive: true });
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindingManifest([])), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    const deployments = Array.from({ length: deploymentCount }, (_, index) => ({
      id: "workspace-budget-" + String(index),
      repositories: ["api"],
      inputs: {
        bindings: "../infra/workspace-budget-repeat/bindings.json",
        inventory: "../infra/workspace-budget-repeat/inventory.json",
        memberScopes: [{
          repositoryId: "api",
          scope: {
            id: "workspace-budget-scope-" + String(index),
            componentId: "workspace-budget-component-" + String(index),
            phase: "runtime",
            stage: { kind: "all" },
            channel: "environment",
          },
        }],
      },
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments,
    }), "utf8");

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const first = await scanWorkspace(document.request);
    const exhausted = first.deployments
      .filter((entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map((entry) => entry.id);
    assert.ok(exhausted.length > 0);
    assert.ok(exhausted.length < deploymentCount);
    assert.equal(first.deployments[0]?.members[0]?.status, "complete");
    for (const id of exhausted) {
      const member = deploymentMember(deployment(first, id), "api");
      assert.equal(member.status, "incomplete");
      assert.deepEqual(member.references, []);
      assert.deepEqual(member.demandEdges, []);
      assert.equal(
        member.reconciliation.records.some((record) => record.coverage === "complete"),
        false,
      );
    }

    const second = await scanWorkspace(document.request);
    const exhaustedAgain = second.deployments
      .filter((entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map((entry) => entry.id);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("scan-only deployments share one invocation budget and reset on the next scan", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const reads = Array.from(
      { length: 1_001 },
      (_, index) => "export const scanOnly" + String(index) + " = process.env.SCAN_ONLY_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8");
    const deployments = Array.from({ length: 101 }, (_, index) => ({
      id: "scan-only-budget-" + String(index),
      repositories: ["api"],
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: [{ id: "api", root: "../api" }],
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const first = await scanWorkspace(document.request);
    const exhausted = first.deployments
      .filter((entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map((entry) => entry.id);
    assert.ok(emittedDeploymentGraphFacts(first) <= 100_000);
    assert.ok(exhausted.length > 0);
    for (const id of exhausted) {
      const member = deploymentMember(deployment(first, id), "api");
      assert.equal(member.status, "incomplete");
      assert.deepEqual(member.references, []);
      assert.deepEqual(member.demandEdges, []);
    }

    const second = await scanWorkspace(document.request);
    const exhaustedAgain = second.deployments
      .filter((entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map((entry) => entry.id);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("shared-key output is withheld when source graph budget is exhausted", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const reads = Array.from(
      { length: 900 },
      (_, index) => "export const shared" + String(index) + " = process.env.SHARED_BUDGET_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all([
      writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8"),
      writeFile(join(fixture.repositoryRoots.worker, "src", "worker.ts"), reads, "utf8"),
    ]);
    const deployments = Array.from({ length: 20 }, (_, index) => ({
      id: "shared-key-budget-" + String(index),
      repositories: ["api", "worker"],
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: [
        { id: "api", root: "../api" },
        { id: "worker", root: "../worker" },
      ],
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    const budgetExhausted = result.deployments.filter((entry) => entry.diagnostics.some(
      (diagnostic) =>
        String(diagnostic) === "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" ||
        String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",
    ));
    assert.ok(budgetExhausted.length > 0);
    assert.ok(emittedWorkspaceGraphFacts(result) <= 100_000);
    for (const entry of budgetExhausted) {
      assert.deepEqual(entry.sharedKeys, []);
      const fallbacks = entry.members.filter(isBudgetFallbackMember);
      // Projection admission is per member. A late deployment may retain an
      // already-admitted sibling while withholding the aggregate shared-key
      // result, but it must expose at least one compact fallback rather than
      // a partial graph for the rejected member.
      assert.ok(fallbacks.length > 0);
      for (const member of fallbacks) {
        assert.equal(member.status, "incomplete");
        assert.deepEqual(member.references, []);
        assert.equal(isBudgetFallbackMember(member), true);
      }
    }
  });
});

test("provisioning records share the invocation graph budget before Core materializes them", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.repositoryRoots.api, "src", "index.ts"),
      "export const noStaticSecrets = true;\n",
      "utf8",
    );
    const inputRoot = join(fixture.infraRoot, "provisioning-graph-budget");
    await mkdir(inputRoot, { recursive: true });
    const scope = {
      id: "provisioning-graph-api",
      componentId: "provisioning-graph-api",
      phase: "runtime",
      stage: { kind: "all" },
      channel: "environment",
    };
    const candidates = Array.from({ length: 1_001 }, (_, index) => ({
      id: "provisioning-binding-" + String(index),
      adapterId: "fixture",
      scope,
      destination: { namespace: "env", name: "PROVISIONING_KEY_" + String(index) },
      sourceKind: "secret-manager",
      providerResourceId: {
        authorityId: "fixture-authority",
        canonicalId: "provisioning-resource-" + String(index),
      },
      appliesWhen: {
        executionUnitIds: [scope.id],
        phases: ["runtime"],
        stage: { kind: "all" },
        channels: ["environment"],
        condition: { kind: "always" },
      },
      precedence: { source: "fixture", rank: 1, comparable: true },
      resolution: "exact",
    }));
    const items = Array.from({ length: 1_001 }, (_, index) => ({
      providerResourceId: {
        authorityId: "fixture-authority",
        canonicalId: "provisioning-resource-" + String(index),
      },
      declaredScopes: [scope],
    }));
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindingManifest(candidates)), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot(items)), "utf8"),
    ]);
    const deployments = Array.from({ length: 101 }, (_, index) => ({
      id: "provisioning-graph-" + String(index).padStart(3, "0"),
      repositories: ["api"],
      inputs: {
        bindings: "../infra/provisioning-graph-budget/bindings.json",
        inventory: "../infra/provisioning-graph-budget/inventory.json",
        memberScopes: [{ repositoryId: "api", scope }],
      },
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    assert.ok(emittedWorkspaceGraphFacts(result) <= 100_000);
    assert.ok(result.deployments.some((entry) =>
      deploymentMember(entry, "api").reconciliation.records.length >= 1_001,
    ));
    const exhausted = result.deployments.filter((entry) =>
      isBudgetFallbackMember(deploymentMember(entry, "api")),
    );
    assert.ok(exhausted.length > 0);
    for (const entry of exhausted) {
      const member = deploymentMember(entry, "api");
      assert.equal(member.status, "incomplete");
      assert.equal(member.reconciliation.records.length, 0);
    }
  });
});

test("finite condition partition floods fall back before Core selection materializes", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.repositoryRoots.api, "src", "index.ts"),
      "export const noStaticSecrets = true;\n",
      "utf8",
    );
    const scope = {
      id: "s",
      componentId: "s",
      phase: "runtime",
      stage: { kind: "all" },
      channel: "environment",
    };
    // 10,000 candidates in one slot × 256 finite assignments would force
    // Core to allocate roughly 2.56M selection entries if admission happened
    // after resolution. This deliberately stays under the 5 MiB input gate.
    const candidates = Array.from({ length: 10_000 }, (_, index) => ({
      id: "c" + String(index),
      adapterId: "a",
      scope,
      destination: { namespace: "env", name: "F" },
      sourceKind: "external",
      appliesWhen: {
        executionUnitIds: [scope.id],
        phases: ["runtime"],
        stage: { kind: "all" },
        channels: ["environment"],
        condition: {
          kind: "all",
          clauses: [{
            key: "B",
            operator: "equals",
            value: "v" + String(index % 255),
          }],
        },
      },
      precedence: { source: "a", rank: 1, comparable: true },
      resolution: "exact",
    }));
    const bindings = {
      schemaVersion: "binding-manifest/v1",
      inputId: "finite-flood-bindings",
      adapterId: "a",
      candidates,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(bindings)) < 5 * 1024 * 1024);
    const inputRoot = join(fixture.infraRoot, "finite-flood");
    await mkdir(inputRoot, { recursive: true });
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindings), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments: [{
        id: "finite-flood",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/finite-flood/bindings.json",
          inventory: "../infra/finite-flood/inventory.json",
          memberScopes: [{ repositoryId: "api", scope }],
        },
      }],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    const entry = deployment(result, "finite-flood");
    const member = deploymentMember(entry, "api");
    assert.equal(
      entry.diagnostics.some(
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",
      ),
      true,
    );
    assert.equal(isBudgetFallbackMember(member), true);
    assert.deepEqual(member.references, []);
    assert.deepEqual(member.demandEdges, []);
    assert.deepEqual(member.dynamicLookupEdges, []);
    assert.deepEqual(member.reconciliation.records, []);
    assert.equal(member.reconciliation.scopeCoverage.length, 1);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("inventory projection bounds 10k by 10k resource matches without pairwise work", async () => {
  await withWorkspaceFixture(async (fixture) => {
    await writeFile(
      join(fixture.repositoryRoots.api, "src", "index.ts"),
      "export const noStaticSecrets = true;\n",
      "utf8",
    );
    const scope = {
      id: "s",
      componentId: "s",
      phase: "runtime",
      stage: { kind: "all" },
      channel: "environment",
    };
    // Distinct destinations keep the slot set linear. Each unique inventory
    // resource has one candidate match, but a naive upper bound still compares
    // every one of 10,000 candidates to every one of 10,000 inventory items.
    // Two finite branches per slot make the complete projected graph just
    // exceed the invocation cap, so Core must never receive these candidates.
    const candidates = Array.from({ length: 10_000 }, (_, index) => ({
      id: "c" + String(index),
      adapterId: "a",
      scope,
      destination: { namespace: "env", name: "K" + String(index) },
      sourceKind: "external",
      providerResourceId: { authorityId: "a", canonicalId: "r" + String(index) },
      appliesWhen: {
        stage: { kind: "all" },
        condition: {
          kind: "all",
          clauses: [{ key: "B", operator: "equals", value: "v" }],
        },
      },
      precedence: { source: "a", comparable: false },
      resolution: "exact",
    }));
    const bindings = {
      schemaVersion: "binding-manifest/v1",
      inputId: "inventory-frequency-bindings",
      adapterId: "a",
      candidates,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(bindings)) < 5 * 1024 * 1024);
    const inventory = {
      schemaVersion: "inventory-snapshot/v1",
      inputId: "inventory-frequency-inventory",
      authorityId: "a",
      asOf: "2026-07-12T00:00:00Z",
      items: Array.from({ length: 10_000 }, (_, index) => ({
        providerResourceId: { authorityId: "a", canonicalId: "r" + String(index) },
      })),
    };
    const inputRoot = join(fixture.infraRoot, "inventory-frequency");
    await mkdir(inputRoot, { recursive: true });
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindings), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventory), "utf8"),
    ]);
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments: [{
        id: "inventory-frequency",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/inventory-frequency/bindings.json",
          inventory: "../infra/inventory-frequency/inventory.json",
          memberScopes: [{ repositoryId: "api", scope }],
        },
      }],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    const entry = deployment(result, "inventory-frequency");
    const member = deploymentMember(entry, "api");
    assert.equal(
      entry.diagnostics.some(
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",
      ),
      true,
    );
    assert.equal(isBudgetFallbackMember(member), true);
    assert.deepEqual(member.reconciliation.records, []);
    assert.equal(member.reconciliation.scopeCoverage.length, 1);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("maximum legal deployment membership reserves compact fallback and aggregate status capacity", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const repositoryIds = Array.from({ length: 5 }, (_, index) => "r" + String(index));
    await Promise.all(repositoryIds.map((id) =>
      mkdir(join(fixture.root, id, "src"), { recursive: true }),
    ));
    const deployments = Array.from({ length: 10_000 }, (_, index) => ({
      id: "d" + String(index),
      repositories: repositoryIds,
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: repositoryIds.map((id) => ({ id, root: "../" + id })),
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    assert.equal(result.deployments.length, 10_000);
    assert.equal(
      result.deployments.reduce((count, entry) => count + entry.members.length, 0),
      50_000,
    );
    assert.equal(result.deployments.every((entry) => entry.diagnostics.length <= 1), true);
    assert.ok(emittedWorkspaceGraphFacts(result) <= 100_000);
    assert.ok(result.deployments.some((entry) =>
      entry.members.some(isBudgetFallbackMember),
    ));
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("invocation document cache reuses verified reads and caps unique input bytes before parse", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const inputRoot = join(fixture.infraRoot, "input-budget");
    await mkdir(inputRoot, { recursive: true });
    const invalidBytes = Buffer.alloc(4 * 1024 * 1024, 0x20);
    await Promise.all([
      writeFile(join(inputRoot, "repeat.json"), invalidBytes),
      writeFile(join(inputRoot, "overflow.json"), invalidBytes),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
      ...Array.from({ length: 23 }, (_, index) =>
        writeFile(join(inputRoot, "unique-" + String(index) + ".json"), invalidBytes),
      ),
    ]);
    const scope = (id: string) => ({
      repositoryId: "api",
      scope: {
        id: "input-budget-" + id,
        componentId: "input-budget-" + id,
        phase: "runtime" as const,
        stage: { kind: "all" as const },
        channel: "environment" as const,
      },
    });
    const deploymentFor = (id: string, binding: string) => ({
      id,
      repositories: ["api"],
      inputs: {
        bindings: "../infra/input-budget/" + binding,
        inventory: "../infra/input-budget/inventory.json",
        memberScopes: [scope(id)],
      },
    });
    const deployments = [
      deploymentFor("cache-00", "repeat.json"),
      deploymentFor("cache-01", "repeat.json"),
      ...Array.from({ length: 23 }, (_, index) =>
        deploymentFor("input-" + String(index).padStart(2, "0"), "unique-" + String(index) + ".json"),
      ),
      deploymentFor("input-z", "overflow.json"),
    ];
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const result = await scanWorkspace(document.request);
    const cachedSecond = deployment(result, "cache-01");
    const overflow = deployment(result, "input-z");
    assert.equal(
      deploymentMember(cachedSecond, "api").diagnostics.some(
        (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED",
      ),
      false,
    );
    assert.equal(
      deploymentMember(overflow, "api").diagnostics.some(
        (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED",
      ),
      true,
    );
    assert.equal(deploymentMember(overflow, "api").status, "incomplete");
  });
});

test("an evicted descriptor payload cannot silently mix a later input snapshot", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const inputRoot = join(fixture.infraRoot, "descriptor-snapshot");
    await mkdir(inputRoot, { recursive: true });
    const targetBindings = join(inputRoot, "target-bindings.json");
    const targetInventory = join(inputRoot, "target-inventory.json");
    const bindingsText = JSON.stringify(bindingManifest([]));
    const inventoryText = JSON.stringify(inventorySnapshot([]));
    await Promise.all([
      writeFile(targetBindings, bindingsText, "utf8"),
      writeFile(targetInventory, inventoryText, "utf8"),
    ]);

    const scope = {
      repositoryId: "api",
      scope: {
        id: "descriptor-snapshot-api",
        componentId: "descriptor-snapshot-api",
        phase: "runtime",
        stage: { kind: "all" },
        channel: "environment",
      },
    };
    const fillerCount = Math.ceil(MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES / 2);
    const fillers = Array.from({ length: fillerCount }, (_, index) => ({
      id: "descriptor-filler-" + String(index).padStart(4, "0"),
      repositories: ["api"],
      inputs: {
        bindings: "../infra/descriptor-snapshot/filler-" + String(index) + "-bindings.json",
        inventory: "../infra/descriptor-snapshot/filler-" + String(index) + "-inventory.json",
        memberScopes: [scope],
      },
    }));
    for (let offset = 0; offset < fillerCount; offset += 64) {
      await Promise.all(Array.from(
        { length: Math.min(64, fillerCount - offset) },
        async (_, localIndex) => {
          const index = offset + localIndex;
          await Promise.all([
            writeFile(join(inputRoot, "filler-" + String(index) + "-bindings.json"), bindingsText, "utf8"),
            writeFile(join(inputRoot, "filler-" + String(index) + "-inventory.json"), inventoryText, "utf8"),
          ]);
        },
      ));
    }
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: [{ id: "api", root: "../api" }],
      deployments: [{
        id: "descriptor-target",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/descriptor-snapshot/target-bindings.json",
          inventory: "../infra/descriptor-snapshot/target-inventory.json",
          memberScopes: [scope],
        },
      }, {
        id: "descriptor-same-path",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/descriptor-snapshot/target-bindings.json",
          inventory: "../infra/descriptor-snapshot/target-inventory.json",
          memberScopes: [scope],
        },
      }, {
        id: "descriptor-normalized-alias",
        repositories: ["api"],
        inputs: {
          bindings: "../infra/descriptor-snapshot/aliases/../target-bindings.json",
          inventory: "../infra/descriptor-snapshot/aliases/../target-inventory.json",
          memberScopes: [scope],
        },
      }, ...fillers],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const invocation = await beginVerifiedWorkspaceInvocation(document.request);
    const repositoryMembers = await attestVerifiedWorkspaceRepositoryMembers(document.request);
    if (invocation === undefined || repositoryMembers === undefined) {
      assert.fail("expected invocation and repository members");
    }
    const apiMember = issuedWorkspaceRepositoryMember(repositoryMembers, "api");
    if (apiMember === undefined) assert.fail("expected api member");
    await scanAttestedLocalWorkspaceMember(apiMember);

    const initialIssuance = await attestVerifiedWorkspaceDeploymentMembers(
      invocation,
      "descriptor-target",
      repositoryMembers,
    );
    if (initialIssuance === undefined) assert.fail("expected target member attestation");
    const initialPreflight = preflightIssuedWorkspaceDeployment(initialIssuance, invocation);
    const initial = await attestVerifiedWorkspaceDeploymentInputs(initialIssuance);
    if (initial === undefined) assert.fail("expected target input attestation");
    registerDeploymentAttestation(initial);
    const initialPrepared = prepareIssuedLocalDeploymentReconciliation(initial, initialPreflight);
    for (const filler of fillers) {
      const attested = await attestDeploymentInputSnapshot(
        invocation,
        filler.id,
        repositoryMembers,
      );
      if (attested === undefined) assert.fail("expected filler input attestation");
    }

    // The two target payloads and descriptor aliases are older than the
    // 2,048 later reads. Distinct declarations of the same semantic file,
    // including parser-normalized aliases, must fail closed after mutation.
    const mutationMarker = "descriptor-snapshot-private-marker";
    await writeFile(targetBindings, bindingsText + "\n" + mutationMarker, "utf8");
    const initialAnalysis = await reconcilePreparedLocalDeploymentMember(
      initialPrepared,
      issuedDeploymentMember(initial, "api"),
    );
    assert.equal(initialAnalysis.reconciliationInput.bindingCandidates.length, 0);

    for (const deploymentId of ["descriptor-same-path", "descriptor-normalized-alias"]) {
      const issuance = await attestVerifiedWorkspaceDeploymentMembers(
        invocation,
        deploymentId,
        repositoryMembers,
      );
      if (issuance === undefined) assert.fail("expected changed member attestation");
      const preflight = preflightIssuedWorkspaceDeployment(issuance, invocation);
      const changed = await attestVerifiedWorkspaceDeploymentInputs(issuance);
      if (changed === undefined) assert.fail("expected changed input attestation");
      registerDeploymentAttestation(changed);
      const prepared = prepareIssuedLocalDeploymentReconciliation(changed, preflight);
      const analysis = await reconcilePreparedLocalDeploymentMember(
        prepared,
        issuedDeploymentMember(changed, "api"),
      );
      assert.equal(
        analysis.diagnostics.some(
          (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_SNAPSHOT_CHANGED",
        ),
        true,
      );
      assert.equal(analysis.result.records.some((record) => record.coverage === "complete"), false);
      assert.equal(JSON.stringify(analysis).includes(fixture.root), false);
      assert.equal(JSON.stringify(analysis).includes(mutationMarker), false);
    }
  });
});

test("coverage-gap fanout is budgeted without retaining a partial member gap graph", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const repositoryIds = Array.from({ length: 100 }, (_, index) => "gap-" + String(index));
    await Promise.all(repositoryIds.map(async (id) => {
      const sourceRoot = join(fixture.root, id, "src");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, "index.ts"), "export const value = process.env.GAP_FANOUT_KEY;\n", "utf8");
    }));
    const inputRoot = join(fixture.infraRoot, "coverage-fanout");
    await mkdir(inputRoot, { recursive: true });
    const malformedCandidates = Array.from({ length: 1_001 }, () => ({
      invalid: "x".repeat(5_000),
    }));
    await Promise.all([
      writeFile(
        join(inputRoot, "bindings.json"),
        JSON.stringify(bindingManifest(malformedCandidates)),
        "utf8",
      ),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    const memberScopes = repositoryIds.map((repositoryId) => ({
      repositoryId,
      scope: {
        id: "coverage-" + repositoryId,
        componentId: "coverage-" + repositoryId,
        phase: "runtime",
        stage: { kind: "all" },
        channel: "environment",
      },
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: repositoryIds.map((id) => ({ id, root: "../" + id })),
      deployments: [{
        id: "coverage-fanout",
        repositories: repositoryIds,
        inputs: {
          bindings: "../infra/coverage-fanout/bindings.json",
          inventory: "../infra/coverage-fanout/inventory.json",
          memberScopes,
        },
      }],
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const result = await scanWorkspace(document.request);
    const fanout = deployment(result, "coverage-fanout");
    assert.equal(
      fanout.diagnostics.some(
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_COVERAGE_GAP_FANOUT_EXCEEDED",
      ),
      true,
    );
    for (const member of fanout.members) {
      assert.equal(member.status, "incomplete");
      assert.equal(
        member.diagnostics.some(
          (diagnostic) => String(diagnostic) === "WORKSPACE_MEMBER_COVERAGE_GAP_FANOUT_EXCEEDED",
        ),
        true,
      );
      assert.equal(
        member.reconciliation.records.some((record) => record.coverage === "complete"),
        false,
      );
    }
  });
});

test("runtime deployment attestations bind sources and reject hostile capabilities", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const invocation = await beginVerifiedWorkspaceInvocation(document.request);
    if (invocation === undefined) {
      assert.fail("expected workspace invocation");
    }
    const repositoryMembers = await attestVerifiedWorkspaceRepositoryMembers(document.request);
    assert.notEqual(repositoryMembers, undefined);
    if (repositoryMembers === undefined) {
      assert.fail("expected request-scoped repository members");
    }
    const apiWorkspaceMember = issuedWorkspaceRepositoryMember(repositoryMembers, "api");
    const workerWorkspaceMember = issuedWorkspaceRepositoryMember(repositoryMembers, "worker");
    assert.notEqual(apiWorkspaceMember, undefined);
    assert.notEqual(workerWorkspaceMember, undefined);
    if (apiWorkspaceMember === undefined || workerWorkspaceMember === undefined) {
      assert.fail("expected request-scoped member handles");
    }
    const apiAnalysis = await scanAttestedLocalWorkspaceMember(apiWorkspaceMember);
    const attestation = await attestDeploymentInputSnapshot(
      invocation,
      "api-production",
      repositoryMembers,
    );
    const workerAttestation = await attestDeploymentInputSnapshot(
      invocation,
      "worker-production",
      repositoryMembers,
    );
    assert.notEqual(attestation, undefined);
    assert.notEqual(workerAttestation, undefined);
    if (attestation === undefined || workerAttestation === undefined) {
      assert.fail("expected runtime attestations");
    }
    const fixedFailure = (error: unknown): boolean =>
      error instanceof Error &&
      error.message === "APP_SAFETY_MATERIALIZATION_FAILED" &&
      !error.message.includes("capability-proxy-sentinel");
    const attestationPreflight = preflightIssuedWorkspaceDeployment(attestation, invocation);
    const workerPreflight = preflightIssuedWorkspaceDeployment(workerAttestation, invocation);
    assert.equal(
      await attestDeploymentInputSnapshot(
        invocation,
        "worker-production",
        apiWorkspaceMember,
      ),
      undefined,
    );
    const independentlyRead = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (independentlyRead.ok === false) {
      assert.fail(independentlyRead.code);
    }
    const independentlyIssuedMembers = await attestVerifiedWorkspaceRepositoryMembers(
      independentlyRead.request,
    );
    const independentInvocation = await beginVerifiedWorkspaceInvocation(independentlyRead.request);
    assert.notEqual(independentlyIssuedMembers, undefined);
    assert.notEqual(independentInvocation, undefined);
    if (independentInvocation === undefined) {
      assert.fail("expected independent workspace invocation");
    }
    assert.equal(
      await attestDeploymentInputSnapshot(
        invocation,
        "api-production",
        independentlyIssuedMembers,
      ),
      undefined,
    );
    // A standalone scan has no request/member attachment, even when its root
    // happens to match a separately issued request.
    await scanLocalRoot(fixture.repositoryRoots.api);
    const standaloneAttestation = await attestDeploymentInputSnapshot(
      independentInvocation,
      "api-production",
      independentlyIssuedMembers,
    );
    assert.notEqual(standaloneAttestation, undefined);
    if (standaloneAttestation === undefined) {
      assert.fail("expected standalone-attached deployment attestation");
    }
    registerDeploymentAttestation(standaloneAttestation);
    const standalonePreflight = preflightIssuedWorkspaceDeployment(
      standaloneAttestation,
      independentInvocation,
    );
    assert.throws(
      () => prepareIssuedLocalDeploymentReconciliation(standaloneAttestation, attestationPreflight),
      fixedFailure,
    );
    const standalonePrepared = prepareIssuedLocalDeploymentReconciliation(
      standaloneAttestation,
      standalonePreflight,
    );
    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(
        standalonePrepared,
        issuedDeploymentMember(standaloneAttestation, "api"),
      ),
      fixedFailure,
    );
    assert.throws(
      () => prepareIssuedLocalDeploymentReconciliation(attestation, standalonePreflight),
      fixedFailure,
    );
    registerDeploymentAttestation(attestation);
    registerDeploymentAttestation(workerAttestation);
    const trapSentinel = "capability-proxy-sentinel";
    const hostileTraps: ProxyHandler<object> = {
      get() {
        throw new Error(trapSentinel);
      },
      getOwnPropertyDescriptor() {
        throw new Error(trapSentinel);
      },
      ownKeys() {
        throw new Error(trapSentinel);
      },
    };
    const rawDocumentProxy = new Proxy(Object.create(null), hostileTraps);
    const rawMemberArrayProxy = new Proxy([], hostileTraps);

    // The worker attestation owns an exact request-scoped handle. An API scan
    // cannot be relabelled into it; a scan through that worker handle later
    // succeeds only for a newly issued deployment preparation.
    const workerPreparedBeforeScan = prepareIssuedLocalDeploymentReconciliation(
      workerAttestation,
      workerPreflight,
    );
    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(
        workerPreparedBeforeScan,
        issuedDeploymentMember(workerAttestation, "worker"),
      ),
      fixedFailure,
    );

    // Attested reads are captured before preparation. Replacing the local JSON
    // inputs afterwards must not change this attestation's private documents.
    await writeDeploymentProvisioning(
      fixture,
      "api-production",
      bindingManifest([bindingCandidate("api", "new-database")]),
      inventorySnapshot([inventoryItem("api", "new-database")]),
    );

    // Public analysis is a detached frozen view. A proxy mutation attempt must
    // fail locally and cannot reach the private source snapshot used below.
    const publicReference = apiAnalysis.reconciliationInput.references[0] as { requested: unknown };
    assert.throws(() => {
      publicReference.requested = new Proxy(Object.create(null), hostileTraps);
    });
    assert.equal(Object.isFrozen(apiAnalysis.reconciliationInput.references), true);
    assert.equal(Object.isFrozen(publicReference), true);
    assert.equal(Object.isFrozen(apiAnalysis.result.records), true);

    const prepared = prepareIssuedLocalDeploymentReconciliation(attestation, attestationPreflight);
    const apiHandle = issuedDeploymentMember(attestation, "api");
    assert.notEqual(apiHandle, undefined);
    assert.equal(JSON.stringify(attestation), "{}");
    assert.equal(JSON.stringify(prepared), "{}");
    assert.equal(JSON.stringify(apiHandle), "{}");
    assert.deepEqual(Reflect.ownKeys(attestation), []);
    assert.deepEqual(Reflect.ownKeys(prepared), []);
    assert.deepEqual(Reflect.ownKeys(apiHandle as object), []);
    const capturedRead = await reconcilePreparedLocalDeploymentMember(prepared, apiHandle);
    assert.equal(capturedRead.reconciliationInput.bindingCandidates.length, 0);

    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(prepared, issuedDeploymentMember(attestation, "worker")),
      fixedFailure,
    );
    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(
        prepared,
        issuedDeploymentMember(attestation, "undeclared"),
      ),
      fixedFailure,
    );

    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(prepared, issuedDeploymentMember(workerAttestation, "worker")),
      fixedFailure,
    );
    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(prepared, new Proxy(Object.create(null), hostileTraps)),
      fixedFailure,
    );

    const workerAnalysis = await scanAttestedLocalWorkspaceMember(workerWorkspaceMember);
    const workerAttestationAfterScan = await attestDeploymentInputSnapshot(
      invocation,
      "worker-production",
      repositoryMembers,
    );
    assert.notEqual(workerAttestationAfterScan, undefined);
    if (workerAttestationAfterScan === undefined) {
      assert.fail("expected worker analysis attestation");
    }
    registerDeploymentAttestation(workerAttestationAfterScan);
    const workerPreflightAfterScan = preflightIssuedWorkspaceDeployment(
      workerAttestationAfterScan,
      invocation,
    );
    const workerPreparedAfterScan = prepareIssuedLocalDeploymentReconciliation(
      workerAttestationAfterScan,
      workerPreflightAfterScan,
    );
    await assert.doesNotReject(
      reconcilePreparedLocalDeploymentMember(
        workerPreparedAfterScan,
        issuedDeploymentMember(workerAttestationAfterScan, "worker"),
      ),
    );

    const identityOnly = issueIdentityOnlyDeployment(["api"]);
    assert.notEqual(identityOnly, undefined);
    const revocable = Proxy.revocable(Object.create(null), hostileTraps);
    revocable.revoke();
    for (const hostile of [
      null,
      1,
      {},
      JSON.parse(JSON.stringify(attestation)),
      Object.assign({}, attestation),
      structuredClone(attestation),
      JSON.parse(JSON.stringify(prepared)),
      Object.assign({}, prepared),
      structuredClone(prepared),
      new Proxy(Object.create(null), hostileTraps),
      revocable.proxy,
      rawDocumentProxy,
      rawMemberArrayProxy,
      identityOnly,
      independentInvocation,
      structuredClone(attestationPreflight),
    ]) {
      assert.throws(
        () => prepareIssuedLocalDeploymentReconciliation(hostile, attestationPreflight),
        fixedFailure,
      );
    }
    await assert.rejects(
      reconcilePreparedLocalDeploymentMember(prepared, structuredClone(apiHandle as object)),
      fixedFailure,
    );

    // A newer attestation sees the rewritten files, but the public candidate
    // graph is separately frozen and cannot corrupt its reusable private facts.
    const rewrittenInvocation = await beginVerifiedWorkspaceInvocation(document.request);
    if (rewrittenInvocation === undefined) {
      assert.fail("expected rewritten workspace invocation");
    }
    const rewrittenAttestation = await attestDeploymentInputSnapshot(
      rewrittenInvocation,
      "api-production",
      repositoryMembers,
    );
    assert.notEqual(rewrittenAttestation, undefined);
    if (rewrittenAttestation === undefined) {
      assert.fail("expected rewritten attestation");
    }
    registerDeploymentAttestation(rewrittenAttestation);
    const rewrittenPreflight = preflightIssuedWorkspaceDeployment(
      rewrittenAttestation,
      rewrittenInvocation,
    );
    const rewrittenPrepared = prepareIssuedLocalDeploymentReconciliation(
      rewrittenAttestation,
      rewrittenPreflight,
    );
    const rewrittenHandle = issuedDeploymentMember(rewrittenAttestation, "api");
    const rewritten = await reconcilePreparedLocalDeploymentMember(rewrittenPrepared, rewrittenHandle);
    assert.equal(rewritten.reconciliationInput.bindingCandidates.length, 1);
    const candidate = rewritten.reconciliationInput.bindingCandidates[0] as { destination: unknown };
    assert.throws(() => {
      candidate.destination = new Proxy(Object.create(null), hostileTraps);
    });
    const repeated = await reconcilePreparedLocalDeploymentMember(rewrittenPrepared, rewrittenHandle);
    assert.equal(JSON.stringify(repeated), JSON.stringify(rewritten));

    const analysisModule = await import("../src/app/analysis.js");
    assert.equal("issueLocalDeploymentPreparation" in analysisModule, false);
    assert.throws(
      () => prepareIssuedLocalDeploymentReconciliation(rawDocumentProxy, attestationPreflight),
      fixedFailure,
    );
    assert.throws(
      () => prepareIssuedLocalDeploymentReconciliation(rawMemberArrayProxy, attestationPreflight),
      fixedFailure,
    );
    await assert.rejects(
      reconcileLocalRoot(fixture.repositoryRoots.api, rawDocumentProxy as never),
      fixedFailure,
    );
  });
});

function closedModelDocumentForWorkspaceRuntime(): object {
  return {
    schemaVersion: "closed-provisioning-model/v1",
    inputId: "closed-model-input",
    maxFiniteKeyDomain: 8,
    scopes: [{
      scope: {
        id: "api",
        componentId: "api",
        phase: "runtime",
        stage: { kind: "exact", values: ["production"] },
        channel: "environment",
      },
      declaredStages: ["production"],
      closed: true,
      approvedFirstPartyRoots: ["api"],
      bindingRoots: ["infra/api-production/bindings.json"],
      expectedAdapterInputs: [{
        inputId: "api-production-bindings",
        domain: "binding",
        adapterId: "fixture",
      }],
      permittedExclusions: [],
      inventoryAuthorities: [{
        authorityId: "fixture-authority",
        inventoryInputId: "api-production-inventory",
      }],
      allowedExternalMechanisms: [],
      outsideRootImports: "out-of-scope",
    }],
  };
}

function closedModelDocumentForSharedWorkspaceRuntime(): object {
  return {
    schemaVersion: "closed-provisioning-model/v1",
    inputId: "shared-closed-model-input",
    maxFiniteKeyDomain: 8,
    scopes: ["api", "worker"].map((repositoryId) => ({
      scope: productionMemberExecutionScope(repositoryId),
      declaredStages: ["production"],
      closed: true,
      approvedFirstPartyRoots: [repositoryId],
      bindingRoots: ["infra/shared-production/bindings.json"],
      expectedAdapterInputs: [{
        inputId: "shared-production-bindings",
        domain: "binding",
        adapterId: "fixture",
      }],
      permittedExclusions: [],
      inventoryAuthorities: [{
        authorityId: "fixture-authority",
        inventoryInputId: "shared-production-inventory",
      }],
      allowedExternalMechanisms: [],
      outsideRootImports: "out-of-scope",
    })),
  };
}

async function writeDeploymentProvisioning(
  fixture: WorkspaceFixture,
  deploymentId: string,
  bindings: object,
  inventory: object,
): Promise<void> {
  await Promise.all([
    writeFile(
      join(fixture.infraRoot, deploymentId, "bindings.json"),
      JSON.stringify(bindings),
      "utf8",
    ),
    writeFile(
      join(fixture.infraRoot, deploymentId, "inventory.json"),
      JSON.stringify(inventory),
      "utf8",
    ),
  ]);
}

function bindingManifest(candidates: readonly object[]): object {
  return {
    schemaVersion: "binding-manifest/v1",
    inputId: "shared-production-bindings",
    adapterId: "fixture",
    candidates,
  };
}

function inventorySnapshot(items: readonly object[]): object {
  return {
    schemaVersion: "inventory-snapshot/v1",
    inputId: "shared-production-inventory",
    authorityId: "fixture-authority",
    asOf: "2026-07-12T00:00:00Z",
    items,
  };
}

type FixtureStage =
  | { readonly kind: "all" }
  | { readonly kind: "exact"; readonly values: readonly string[] };

interface FixtureExecutionScope {
  readonly id: string;
  readonly componentId: string;
  readonly phase: "runtime" | "unknown";
  readonly stage: FixtureStage;
  readonly channel: "environment";
}

function bindingCandidate(
  repositoryId: string,
  resourceId: string,
  authorityId = "fixture-authority",
  scope: FixtureExecutionScope = memberExecutionScope(repositoryId),
  resolution: "exact" | "dynamic" = "exact",
  appliesWhenStage: FixtureStage = scope.stage,
  idSuffix = "",
  precedenceRank = 1,
): object {
  return {
    id: repositoryId + "-binding" + (idSuffix.length === 0 ? "" : "-" + idSuffix),
    adapterId: "fixture",
    scope,
    destination: { namespace: "env", name: "DATABASE_URL" },
    sourceKind: "secret-manager",
    providerResourceId: {
      authorityId,
      canonicalId: resourceId,
    },
    appliesWhen: {
      executionUnitIds: [scope.id],
      phases: ["runtime"],
      stage: appliesWhenStage,
      channels: ["environment"],
      condition: { kind: "always" },
    },
    precedence: { source: "fixture", rank: precedenceRank, comparable: true },
    resolution,
  };
}

function inventoryItem(
  repositoryId: string,
  resourceId: string,
  authorityId = "fixture-authority",
  scope: FixtureExecutionScope = memberExecutionScope(repositoryId),
): object {
  return {
    providerResourceId: {
      authorityId,
      canonicalId: resourceId,
    },
    declaredScopes: [scope],
  };
}

function unscopedInventoryItem(
  resourceId: string,
  authorityId = "fixture-authority",
): object {
  return {
    providerResourceId: {
      authorityId,
      canonicalId: resourceId,
    },
  };
}

function memberExecutionScope(
  repositoryId: string,
  executionScopeId = repositoryId,
  stage: FixtureStage = { kind: "all" },
): FixtureExecutionScope {
  return {
    id: executionScopeId,
    componentId: executionScopeId,
    phase: "runtime",
    stage,
    channel: "environment",
  };
}

function productionMemberExecutionScope(repositoryId: string): FixtureExecutionScope {
  return memberExecutionScope(repositoryId, repositoryId, {
    kind: "exact",
    values: ["production"],
  });
}

function deploymentWithMemberScope(deploymentId: string): object {
  return {
    id: deploymentId,
    repositories: ["api"],
    inputs: {
      bindings: "../infra/" + deploymentId + "/bindings.json",
      inventory: "../infra/" + deploymentId + "/inventory.json",
      memberScopes: [{
        repositoryId: "api",
        scope: memberExecutionScope("api"),
      }],
    },
  };
}
