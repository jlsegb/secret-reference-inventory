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


/**
 * Reads an isolated fixture manifest and runs the workspace runtime against its issued request.
 *
 * Inputs: `fixture`.
 * Outputs: A promise for the workspace scan result, whose repository/deployment partitions may be complete, incomplete, or invalid.
 * Does not handle: Recovering invalid manifests, modifying fixture files, or configuring adapters.
 * Side effects: Reads the manifest, may fail the test, and invokes the workspace scanner.
 */
async function scanFixture(fixture: WorkspaceFixture) {
  const document = await readLocalWorkspaceManifest(fixture.manifestPath);
  if (document.ok === false) {
    assert.fail(document.code);
  }
  return scanWorkspace(document.request);
}

/*  Test-only lower-layer helper; runtime itself always preflights before input I/O. */
/**
 * Performs the two deployment-attestation phases directly for lower-layer cache and snapshot tests.
 *
 * Inputs: `invocation`, `deploymentId`, `repositoryMembers`.
 * Outputs: An issued preparation token after both phases, or `undefined` when member issuance fails or the delegated input attestation later rejects changed/unverifiable invocation provenance.
 * Does not handle: Source preflight, reconciliation, or retrying a failed local input read.
 * Side effects: May read declared provisioning documents through the attestation functions.
 */
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

/**
 * Finds a named repository scan result and fails the test if the result is absent.
 *
 * Inputs: `result`, `id`.
 * Outputs: The repository result with the requested ID.
 * Does not handle: Normalizing IDs, selecting deployments, or recovering a missing result.
 * Side effects: Searches the result array and throws through `assert.notEqual` if not found.
 */
function repository(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  id: string,
): Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number] {
  const entry = result.repositories.find(
    /**
    * Evaluates predicate candidate_id equals id.
    *
    * Inputs: `candidate`.
    * Outputs: the `candidate.id === id` result consumed by `result.repositories.find`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected repository " + id);
  return entry as Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number];
}

/**
 * Finds a named deployment scan result and fails the test if the result is absent.
 *
 * Inputs: `result`, `id`.
 * Outputs: The deployment result with the requested ID.
 * Does not handle: Normalizing IDs, selecting repository results, or recovering a missing deployment.
 * Side effects: Searches the deployment array and throws through `assert.notEqual` if not found.
 */
function deployment(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  id: string,
): Awaited<ReturnType<typeof scanWorkspace>>["deployments"][number] {
  const entry = result.deployments.find(
    /**
    * Evaluates predicate candidate_id equals id.
    *
    * Inputs: `candidate`.
    * Outputs: the `candidate.id === id` result consumed by `result.deployments.find`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected deployment " + id);
  return entry as Awaited<ReturnType<typeof scanWorkspace>>["deployments"][number];
}

/**
 * Finds one repository member inside a deployment result and fails the test if it is absent.
 *
 * Inputs: `entry`, `repositoryId`.
 * Outputs: The deployment member with the requested repository ID.
 * Does not handle: Cross-deployment search, ID normalization, or recovery from a missing member.
 * Side effects: Searches member entries and throws through `assert.notEqual` if not found.
 */
function deploymentMember(
  entry: ReturnType<typeof deployment>,
  repositoryId: string,
): ReturnType<typeof deployment>["members"][number] {
  const member = entry.members.find(
    /**
    * Evaluates predicate candidate_repositoryId equals repositoryId.
    *
    * Inputs: `candidate`.
    * Outputs: the `candidate.repositoryId === repositoryId` result consumed by `entry.members.find`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (candidate) => candidate.repositoryId === repositoryId);
  assert.notEqual(member, undefined, "expected deployment member " + repositoryId);
  return member as ReturnType<typeof deployment>["members"][number];
}

/**
 * Counts retained reconciliation graph facts to enforce runtime projection-budget bounds.
 *
 * Inputs: `reconciliation`.
 * Outputs: The aggregate number of retained record, reason, reference, dynamic, and coverage facts.
 * Does not handle: Validating reconciliation semantics, modifying records, or scanning sources.
 * Side effects: Reduces in-memory graph arrays only.
 */
function emittedReconciliationGraphFacts(
  reconciliation: Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number]["reconciliation"],
): number {
  const recordFacts = reconciliation.records.reduce(
    /**
    * Counts this record node together with its retained reasons, direct references, and dynamic lookup contribution.
    *
    * Inputs: `total`, `record`.
    * Outputs: the next accumulator value `{ const reasons = record.reasons.reduce( (reasonTotal, reason) => reasonTotal + 1 + (reason.gapIds?.length ?? 0) + (reason.candidateIds?.length ?? 0), 0, ); const references = record.kind ==`.
     * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
     * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
     */
    (total, record) => {
    const reasons = record.reasons.reduce(
      /**
      * Counts one reconciliation reason together with its retained gap and candidate identifiers.
      *
      * Inputs: `reasonTotal`, `reason`.
      * Outputs: the next accumulator value `reasonTotal + 1 + (reason.gapIds?.length ?? 0) + (reason.candidateIds?.length ?? 0)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
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
    /**
    * Counts one scope-coverage node and every retained gap identifier.
    *
    * Inputs: `total`, `coverage`.
    * Outputs: the next accumulator value `total + 1 + coverage.gapIds.length`.
     * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
     * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
     */
    (total, coverage) => total + 1 + coverage.gapIds.length,
    0,
  );
}

/**
 * Counts one evidence node plus its retained locations for graph-budget assertions.
 *
 * Inputs: `evidence`.
 * Outputs: The total evidence-node and location count.
 * Does not handle: Validating evidence provenance, mutating locations, or traversing nested source data.
 * Side effects: Reduces an in-memory evidence array.
 */
function evidenceGraphFacts(
  evidence: readonly { readonly locations: readonly unknown[] }[],
): number {
  return evidence.reduce(
    /**
    * Counts one evidence node and all retained source-location entries.
    *
    * Inputs: `total`, `entry`.
    * Outputs: the next accumulator value `total + 1 + entry.locations.length`.
     * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
     * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
     */
    (total, entry) => total + 1 + entry.locations.length, 0);
}

/**
 * Counts the graph contribution of one retained secret reference.
 *
 * Inputs: `reference`.
 * Outputs: One reference node plus its evidence contribution.
 * Does not handle: Validating references, changing evidence, or querying source files.
 * Side effects: Calls `evidenceGraphFacts` on in-memory data.
 */
function referenceGraphFacts(reference: SecretReference): number {
  return 1 + evidenceGraphFacts(reference.evidenceChain);
}

/**
 * Counts the graph contribution of one retained demand edge.
 *
 * Inputs: `edge`.
 * Outputs: The edge node/endpoint contribution plus its evidence contribution.
 * Does not handle: Validating edge semantics, changing evidence, or source analysis.
 * Side effects: Calls `evidenceGraphFacts` on in-memory data.
 */
function demandEdgeGraphFacts(edge: DemandEdge): number {
  return 2 + evidenceGraphFacts(edge.evidenceChain);
}

/**
 * Counts the graph contribution of one retained dynamic lookup edge.
 *
 * Inputs: `edge`.
 * Outputs: The edge contribution including likely-key and evidence counts.
 * Does not handle: Resolving lookup domains, mutating likely keys, or source analysis.
 * Side effects: Reads the edge and calls `evidenceGraphFacts`.
 */
function dynamicLookupGraphFacts(edge: DynamicLookupEdge): number {
  return 2 + edge.likelyKeys.length + evidenceGraphFacts(edge.evidenceChain);
}

/**
 * Counts every graph fact retained in one repository or deployment-member analysis result.
 *
 * Inputs: `entry`.
 * Outputs: The total diagnostics, reference, demand, dynamic, and reconciliation graph-fact count.
 * Does not handle: Mutating result data, verifying correctness, or producing a report.
 * Side effects: Reduces in-memory result arrays and calls graph-count helpers.
 */
function emittedResultGraphFacts(entry: {
  readonly diagnostics: readonly unknown[];
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly reconciliation: Awaited<ReturnType<typeof scanWorkspace>>["repositories"][number]["reconciliation"];
}): number {
  return (
    entry.diagnostics.length +
    entry.references.reduce(
      /**
      * Adds this secret reference's node and evidence-chain contribution to the result total.
      *
      * Inputs: `total`, `reference`.
      * Outputs: the next accumulator value `total + referenceGraphFacts(reference)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, reference) => total + referenceGraphFacts(reference), 0) +
    entry.demandEdges.reduce(
      /**
      * Adds this demand edge's endpoint and evidence-chain contribution to the result total.
      *
      * Inputs: `total`, `edge`.
      * Outputs: the next accumulator value `total + demandEdgeGraphFacts(edge)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, edge) => total + demandEdgeGraphFacts(edge), 0) +
    entry.dynamicLookupEdges.reduce(
      /**
      * Adds this dynamic lookup's endpoints, likely keys, and evidence-chain contribution to the result total.
      *
      * Inputs: `total`, `edge`.
      * Outputs: the next accumulator value `total + dynamicLookupGraphFacts(edge)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, edge) => total + dynamicLookupGraphFacts(edge), 0) +
    emittedReconciliationGraphFacts(entry.reconciliation)
  );
}

/**
 * Counts all retained graph facts across the workspace's deployment results and members.
 *
 * Inputs: `result`.
 * Outputs: The aggregate deployment shared-key, diagnostic, and member graph-fact count.
 * Does not handle: Counting standalone repositories, modifying results, or scanning input.
 * Side effects: Reduces deployment/member arrays in memory.
 */
function emittedDeploymentGraphFacts(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
): number {
  return result.deployments.reduce(
    /**
    * Adds this deployment's shared-key and diagnostic slots plus all member graph facts to the workspace total.
    *
    * Inputs: `total`, `deployment`.
    * Outputs: the next accumulator value `total + deployment.sharedKeys.length + deployment.diagnostics.length + deployment.members.reduce( (memberTotal, member) => memberTotal + emittedResultGraphFacts(member), 0, )`.
     * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
     * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
     */
    (total, deployment) =>
    total +
    deployment.sharedKeys.length +
    deployment.diagnostics.length +
    deployment.members.reduce(
      /**
      * Adds this deployment member's emitted graph facts to the deployment total.
      *
      * Inputs: `memberTotal`, `member`.
      * Outputs: the next accumulator value `memberTotal + emittedResultGraphFacts(member)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (memberTotal, member) => memberTotal + emittedResultGraphFacts(member),
      0,
    ),
  0);
}

/**
 * Counts all graph facts retained by a complete workspace result for budget-bound assertions.
 *
 * Inputs: `result`.
 * Outputs: The combined repository and deployment graph-fact count.
 * Does not handle: Validating reports, mutating results, or scanning a workspace.
 * Side effects: Reduces repository results and calls `emittedDeploymentGraphFacts`.
 */
function emittedWorkspaceGraphFacts(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
): number {
  return (
    result.repositories.reduce(
      /**
      * Adds this repository's emitted graph facts to the workspace total.
      *
      * Inputs: `total`, `repository`.
      * Outputs: the next accumulator value `total + emittedResultGraphFacts(repository)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, repository) => total + emittedResultGraphFacts(repository),
      0,
    ) + emittedDeploymentGraphFacts(result)
  );
}

/*  A compact fallback is the invocation floor: one empty incomplete status. */
/**
 * Recognizes the compact incomplete result emitted when the graph budget is exhausted.
 *
 * Inputs: `member`.
 * Outputs: True only for the prescribed empty incomplete fallback shape.
 * Does not handle: Explaining the exhaustion cause, validating other result fields, or changing the result.
 * Side effects: Reads member fields without mutation or I/O.
 */
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

/**
 * Applies the compact-fallback shape check to a deployment member result.
 *
 * Inputs: `member`.
 * Outputs: The fallback-shape predicate result for this member.
 * Does not handle: Locating a member, changing member data, or diagnosing budget consumption.
 * Side effects: Calls `isBudgetFallbackResult`.
 */
function isBudgetFallbackMember(member: ReturnType<typeof deploymentMember>): boolean {
  return isBudgetFallbackResult(member);
}

/**
 * Asserts that malformed-manifest results are uniformly invalid and contain no fixture provenance.
 *
 * Inputs: `result`, `fixture`.
 * Outputs: `void` after all invalid-status and redaction assertions pass.
 * Does not handle: Repairing invalid results, validating a happy path, or suppressing assertion errors.
 * Side effects: Reads/serializes the result and throws through strict assertions on violations.
 */
function assertInvalidManifestProvenance(
  result: Awaited<ReturnType<typeof scanWorkspace>>,
  fixture: WorkspaceFixture,
): void {
  assert.equal(result.repositories.every(
    /**
    * Evaluates predicate repository_status equals "invalid".
    *
    * Inputs: `repository`.
    * Outputs: the `repository.status === "invalid"` result consumed by `result.repositories.every`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (repository) => repository.status === "invalid"), true);
  assert.equal(result.deployments.every(
    /**
    * Evaluates predicate deployment_status equals "invalid".
    *
    * Inputs: `deployment`.
    * Outputs: the `deployment.status === "invalid"` result consumed by `result.deployments.every`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (deployment) => deployment.status === "invalid"), true);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.equal(JSON.stringify(result).includes(fixture.privateSourceMarker), false);
}

test("workspace runtime scans an approved sibling repository through a canonical manifest base",
  /**
 * Creates the default sibling-root fixture and delegates one runtime scan to the fixture callback.
 * Inputs: No callback arguments; calls `withWorkspaceFixture` with the default API/worker source layout.
 * Outputs: Resolves after the callback observes a complete API `DATABASE_URL` demand with no fixture root or private marker serialized.
 * Does not handle: Fixture lifecycle, external repositories, or recovery from scan/assertion failure.
 * Side effects: The helper creates and removes the temporary root; callback rejection propagates through this awaited call.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Scans the supplied fixture and inspects the API repository's direct-demand reconciliation record.
 * Inputs: The `WorkspaceFixture` from `withWorkspaceFixture`, including its manifest/root/private marker.
 * Outputs: Resolves after API status is complete, a `DATABASE_URL` demand exists, and serialized scan data excludes the root and marker.
 * Does not handle: Creating or deleting the fixture, changing source files, or recovering failed scans/assertions.
 * Side effects: Reads the manifest through `scanFixture` and local result graph; outer fixture cleanup owns removal and errors propagate.
 */
    async (fixture) => {
    const result = await scanFixture(fixture);
    const api = repository(result, "api");

    assert.equal(api?.status, "complete");
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_key_name equals "DATABASE_URL".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.key.name === "DATABASE_URL"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.key.name === "DATABASE_URL",
      ),
      true,
    );
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
    assert.equal(JSON.stringify(result).includes(fixture.privateSourceMarker), false);
  });
});

test("duplicate keys aggregate only within an explicit shared deployment",
  /**
 * Scans unrelated and then explicitly shared fixture layouts through a temporary fixture callback.
 * Inputs: No callback arguments; requests `withWorkspaceFixture`'s default layout before its callback rewrites that fixture to `shared`.
 * Outputs: Resolves after unrelated API/worker deployments have no shared keys and the shared deployment contains both IDs with only `DATABASE_URL`.
 * Does not handle: Fixture creation/deletion, provider inventories, or recovery from write/scan/assertion errors.
 * Side effects: The inner callback overwrites fixture layout; `withWorkspaceFixture` removes all temporary files in finally.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Compares scans before and after rewriting the supplied fixture manifest to the shared deployment topology.
 * Inputs: The helper-provided fixture; reads its default layout and passes the same fixture to `writeFixtureLayout(..., "shared")`.
 * Outputs: Resolves after independent deployments yield empty arrays, while `shared-production` has `[api, worker]`, one `DATABASE_URL`, and both complete repositories.
 * Does not handle: Fixture cleanup, arbitrary topology generation, or swallowing write/scan/assertion failure.
 * Side effects: Mutates test-owned manifest/provisioning files, starts two local scans, and relies on outer helper cleanup.
 */
    async (fixture) => {
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

test("workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text",
  /**
 * Creates a verified fixture request and delegates hostile capability/clone rejection checks to the fixture callback.
 * Inputs: No callback arguments; uses `withWorkspaceFixture` to supply an issued request and private fixture paths.
 * Outputs: Resolves after all proxy/getter/revoked/clone request forms reject with fixed redacted runtime errors without invoking traps.
 * Does not handle: Constructing a valid replacement capability, fixture cleanup, or catching expected rejection mismatches.
 * Side effects: The callback creates hostile objects and local flags; fixture removal and propagated errors remain owned by the helper.
 */
  async () => {
  await withWorkspaceFixture(
    /**
     * Exercises forged request values, serialized/structural/platform/proxy clones, and a mixed request against one issued fixture request.
     *
     * Inputs: The fixture callback receives the manifest path/root used to issue `document.request`; it builds throwing proxy traps, a throwing getter, and a revoked proxy carrying `TEST SENTINEL VALUE`.
     * Outputs: Resolves after every hostile/clone scan rejects as `WorkspaceRuntimeError` without the sentinel, all trap flags remain false, and the issued request serializes without fixture provenance.
     * Does not handle: Issuing a new request, fixing a rejected capability, fixture deletion, or catching an assertion that finds leaked trap text.
     * Side effects: Creates/revokes proxies, installs a getter, updates three local flags, and invokes rejected scans; `withWorkspaceFixture` later removes the root.
     */
    async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const sentinel = "TEST SENTINEL VALUE";
    let prototypeTrapInvoked = false;
    let ownKeysTrapInvoked = false;
    let getterInvoked = false;

    const prototypeTrap = new Proxy({}, {
      getPrototypeOf:
        /**
         * Implements the hostile proxy's `getPrototypeOf` trap for the forged-request rejection test.
         *
         * Inputs: Reflection supplies the proxy target argument; this zero-argument implementation intentionally ignores it.
         * Outputs: Never returns: it throws the test sentinel if reflection reaches the trap.
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
         * Implements the hostile proxy's `ownKeys` trap for the forged-request rejection test.
         *
         * Inputs: Reflection supplies the proxy target argument; this zero-argument implementation intentionally ignores it.
         * Outputs: Never returns: it throws the test sentinel if reflection reaches the trap.
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
         * Implements the hostile `manifest` getter installed for the forged-request rejection test.
         *
         * Inputs: A later property read supplies the receiver; this zero-argument getter intentionally ignores it.
         * Outputs: Never returns: it throws the test sentinel when `manifest` is read.
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

    const isFixedRuntimeError =
      /**
       * Validates the redacted fixed failure emitted for forged workspace requests.
       *
       * Inputs: The `error` rejected by each `scanWorkspace` call in this fixture loop.
       * Outputs: True after asserting the runtime error type and absence of the trap sentinel in string and JSON views.
       * Does not handle: Invoking the rejected scan, repairing the error, or inspecting successful results.
       * Side effects: Runs assertion checks that throw when the fixed error shape is violated.
       */
      (error: unknown): boolean => {
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
      /**
       * Recognizes the fixed runtime error used by this direct rejection assertion.
       *
       * Inputs: The `error` supplied by `assert.rejects` after `scanWorkspace` rejects.
       * Outputs: True exactly when the error is a `WorkspaceRuntimeError`.
       * Does not handle: Starting the scan, checking sentinel redaction, or recovering the rejection.
       * Side effects: None; it only performs an instance check.
       */
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

test("workspace runtime rejects a request after its verified manifest file is replaced",
  /**
 * Issues a fixture manifest request then delegates replacement-of-that-file provenance failure to its callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` supplies the control directory and manifest path to mutate.
 * Outputs: Resolves after the callback replaces the manifest and `scanWorkspace` returns the fixed invalid-provenance result.
 * Does not handle: Restoring the original manifest, retrying scan provenance, or suppressing filesystem/assertion failures.
 * Side effects: The callback renames and overwrites test files; the fixture helper removes the root afterwards.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Reads an issued request, moves its verified manifest aside, and writes `{}` at the original path before scanning.
 * Inputs: The provided fixture's manifest/control paths; reads the original request through `readLocalWorkspaceManifest`.
 * Outputs: Resolves after `assertInvalidManifestProvenance` confirms the subsequent scan is invalid and redacted.
 * Does not handle: Reissuing the request after the write, restoring files, or handling read/rename/write/assertion errors.
 * Side effects: Renames and overwrites test-owned files; outer `withWorkspaceFixture` owns recursive cleanup.
 */
    async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (!document.ok) {
      assert.fail(document.code);
    }

    await rename(fixture.manifestPath, join(fixture.controlRoot, "workspace-prior.jsonc"));
    await writeFile(fixture.manifestPath, "{}\n", "utf8");

    assertInvalidManifestProvenance(await scanWorkspace(document.request), fixture);
  });
});

test("workspace runtime rejects a request after its manifest path is replaced by a symlink",
  /**
 * Issues a fixture request and delegates a post-verification manifest-path symlink substitution to its callback.
 * Inputs: No callback arguments; obtains fixture control paths through `withWorkspaceFixture`.
 * Outputs: Resolves after the callback replaces the original path by a symlink and the scan reports invalid manifest provenance.
 * Does not handle: Following arbitrary links safely, restoring the original file, or catching I/O/assertion errors.
 * Side effects: The callback writes, removes, and symlinks test-owned files; helper cleanup removes them.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Swaps the issued manifest path for a `replacement.jsonc` symlink after reading its request token.
 * Inputs: The fixture manifest/control paths and an issued request returned by `readLocalWorkspaceManifest`.
 * Outputs: Resolves after the scan result satisfies `assertInvalidManifestProvenance` rather than trusting the replacement target.
 * Does not handle: Symlink target cleanup, regenerating a valid request, or recovery from read/write/remove/link/assertion failures.
 * Side effects: Writes the replacement, deletes the manifest path, creates a file symlink, and relies on fixture cleanup.
 */
    async (fixture) => {
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

test("workspace runtime rejects a request after its verified canonical base is replaced",
  /**
 * Issues a manifest request then delegates replacement of its verified control-directory base to a fixture callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` supplies the root/control paths used by the issued request.
 * Outputs: Resolves after the callback replaces the base directory and scanning returns invalid provenance.
 * Does not handle: Restoring the original control directory, issuing a new request, or masking filesystem/assertion failures.
 * Side effects: The callback renames/recreates directories and writes a manifest; helper finally cleanup removes the fixture.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Moves the fixture control base, recreates it with a new `{}` manifest, then scans the pre-replacement request.
 * Inputs: The helper-provided fixture and the request returned from its original manifest read.
 * Outputs: Resolves after `assertInvalidManifestProvenance` validates the changed-base scan result.
 * Does not handle: Reattesting the new base, restoring the old directory, or handling filesystem/assertion errors.
 * Side effects: Renames and recreates test directories, writes a new manifest, and leaves deletion to `withWorkspaceFixture`.
 */
    async (fixture) => {
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

test("workspace runtime rejects equal and nested canonical root aliases before scanning",
  /**
 * Creates a fixture then delegates equal and descendant root-alias conflict checks to the fixture callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` provides the API root, control manifest, and temporary root needed to install aliases.
 * Outputs: Resolves after all three repository results are invalid with root-conflict diagnostics and no serialized fixture path.
 * Does not handle: Canonicalizing arbitrary user roots, fixture deletion, or recovery from link/write/scan/assertion failure.
 * Side effects: The callback writes manifest content and directory links; helper cleanup recursively removes those artifacts.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Adds symlinks to the API root and its `src` child, writes a three-repository manifest, and scans it.
 * Inputs: The supplied fixture provides API/root/manifest paths; the body constructs `api-alias` and `api-src-alias` descriptors.
 * Outputs: Resolves after statuses are `[invalid, invalid, invalid]`, every result has `WORKSPACE_REPOSITORY_ROOT_CONFLICT`, and JSON excludes the fixture root.
 * Does not handle: Removing aliases individually, producing a valid conflicting scan, or handling link/read/scan/assertion failure.
 * Side effects: Creates directory symlinks and overwrites the fixture manifest; outer fixture cleanup removes them.
 */
    async (fixture) => {
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
      result.repositories.map(
        /**
        * Extracts repository_status for the enclosing assertion.
        *
        * Inputs: `repository`.
        * Outputs: the `repository.status` result consumed by `result.repositories.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (repository) => repository.status),
      ["invalid", "invalid", "invalid"],
    );
    assert.equal(
      result.repositories.every(
        /**
        * Evaluates predicate repository_diagnostics_some( (diagnostic) => diagnostic equals "WORKSPACE_REPOSITORY_ROOT_CONFLICT", ).
        *
        * Inputs: `repository`.
        * Outputs: the `repository.diagnostics.some( (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_CONFLICT", )` result consumed by `result.repositories.every`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (repository) =>
        repository.diagnostics.some(
          /**
          * Evaluates predicate diagnostic equals "WORKSPACE_REPOSITORY_ROOT_CONFLICT".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `diagnostic === "WORKSPACE_REPOSITORY_ROOT_CONFLICT"` result consumed by `repository.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_CONFLICT",
        ),
      ),
      true,
    );
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("canonical root indexing retains ancestor conflicts across prefix-like siblings",
  /**
 * Creates prefix-like and nested fixture roots to exercise segment-aware ancestor conflict handling.
 * Inputs: No callback arguments; uses `withWorkspaceFixture` to allocate the root passed to the directory/link/manifest-writing callback.
 * Outputs: Resolves after the callback observes ancestor and nested roots invalid while the `root-prefix-` sibling remains complete.
 * Does not handle: Filesystem case-folding policy, fixture retention, or recovery from directory/link/scan failures.
 * Side effects: The callback creates directories/a symlink and overwrites the manifest; helper cleanup owns removal.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Builds `root-prefix`, `root-prefix-`, and a symlinked `root-prefix/nested` manifest topology, then scans it.
 * Inputs: The supplied fixture root/control manifest; creates ancestor/sibling/nested paths under that temporary root.
 * Outputs: Resolves after the status projection is exactly `[invalid, complete, invalid]` in manifest order.
 * Does not handle: Repairing conflicts, producing source facts, or catching directory/link/write/read/assertion errors.
 * Side effects: Creates directories and a symlink, rewrites the manifest, starts one local scan, and relies on helper cleanup.
 */
    async (fixture) => {
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
      result.repositories.map(
        /**
        * Extracts repository_status for the enclosing assertion.
        *
        * Inputs: `repository`.
        * Outputs: the `repository.status` result consumed by `result.repositories.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (repository) => repository.status),
      ["invalid", "complete", "invalid"],
    );
  });
});

test("request member attestation indexes 10,000 resolved roots without pairwise conflict scans",
  /**
 * Allocates a temporary fixture and delegates ten-thousand repository-root attestation scale checks to its callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` supplies the root in which the callback creates `scale-0` through `scale-9999`.
 * Outputs: Resolves after member metrics report ten thousand roots and bounded conflict checks, with `scale-9999` issuable.
 * Does not handle: Pairwise performance benchmarking outside the exposed metrics, fixture retention, or I/O/assertion recovery.
 * Side effects: Callback creates directories/manifest; fixture helper removes the full temporary tree.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Materializes ten thousand sibling directories in bounded batches, writes a matching v2 manifest, and attests its members.
 * Inputs: The helper fixture root/manifest path; derives `scale-<index>` IDs and maps them to `../scale/<id>` descriptors.
 * Outputs: Resolves after attestation exists, repository/resolution counts equal 10,000, conflict checks stay at most twice the count, and the last ID has a handle.
 * Does not handle: Source scanning, preserving the generated tree, or handling mkdir/write/read/attestation/assertion failure.
 * Side effects: Creates 10,000 directories and overwrites the manifest; `withWorkspaceFixture` recursively deletes them.
 */
    async (fixture) => {
    const count = 10_000;
    const ids = Array.from({ length: count },
      /**
      * Builds fixture value "scale-" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"scale-" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "scale-" + String(index));
    for (let start = 0; start < ids.length; start += 128) {
      await Promise.all(ids.slice(start, start + 128).map(
        /**
         * Creates the resolved directory for one high-cardinality repository fixture.
         *
         * Inputs: `id`.
         * Outputs: the `mkdir(join(fixture.root, "scale", id), { recursive: true })` result consumed by `ids.slice(start, start + 128).map`.
         * Does not handle: Writing source files, updating the manifest, or handling a sibling ID.
         * Side effects: Starts recursive directory creation under the test-owned fixture root.
         */
        (id) =>
        mkdir(join(fixture.root, "scale", id), { recursive: true }),
      ));
    }
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v2",
      repositories: ids.map(
        /**
        * Extracts ({ id, root: "__/scale/" + id }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, root: "../scale/" + id })` result consumed by `ids.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, root: "../scale/" + id })),
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

test("invocation indexes 10,000 deployment declarations without repeated manifest search",
  /**
 * Allocates a temporary fixture and delegates ten-thousand deployment-index lookup checks to its callback.
 * Inputs: No callback arguments; supplies a fixture whose manifest is replaced with a v1 API deployment list.
 * Outputs: Resolves after every declared ID produces a preparation token and invocation metrics report 10,000 declarations and lookups.
 * Does not handle: Source scans, durable indexes, fixture lifecycle, or recovery from manifest/attestation failures.
 * Side effects: Inner callback writes the large manifest; `withWorkspaceFixture` removes the generated fixture afterwards.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes 10,000 padded deployment IDs into a v1 manifest, creates invocation/member capabilities, and prepares each ID.
 * Inputs: The supplied fixture manifest path; generates IDs `deployment-index-0000` onward, all referencing the existing API root.
 * Outputs: Resolves after every member-preparation call is defined and `workspaceInvocationMetrics` reports the expected declaration and lookup counts.
 * Does not handle: Provisioning inputs, result reconciliation, fixture cleanup, or recovery from write/read/attestation/assertion failure.
 * Side effects: Overwrites the fixture manifest, creates invocation/member handles, increments lookup metrics, and relies on helper cleanup.
 */
    async (fixture) => {
    const count = 10_000;
    const deploymentIds = Array.from(
      { length: count },
      /**
      * Builds fixture value "deployment-index-" + String(index)_padStart(4, "0").
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"deployment-index-" + String(index).padStart(4, "0")` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "deployment-index-" + String(index).padStart(4, "0"),
    );
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: [{ id: "api", root: "../api" }],
      deployments: deploymentIds.map(
        /**
        * Extracts ({ id, repositories: ["api"] }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, repositories: ["api"] })` result consumed by `deploymentIds.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, repositories: ["api"] })),
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

test("workspace shared keys require direct demand rather than finite dynamic possibilities",
  /**
 * Rewrites the worker source to choose between two environment keys and scans the shared fixture layout.
 * Inputs: No callback arguments; obtains a default fixture, then its callback writes finite conditional `process.env[choice]` source and switches layout to `shared`.
 * Outputs: Resolves after worker lookup is `finite` and the shared deployment still has no shared keys because no direct shared demand exists.
 * Does not handle: Dynamic-value execution, fixture cleanup, or recovery from source write/scan/assertion failures.
 * Side effects: Callback overwrites worker source and manifest/provisioning layout; helper removes all test files.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Replaces `worker.ts` with an `enabled ? DATABASE_URL : OTHER_URL` lookup, rewrites layout, and scans the same fixture.
 * Inputs: The fixture's worker source path and shared-layout provisioning paths.
 * Outputs: Resolves after worker's first dynamic domain is `finite` and `shared-production.sharedKeys` is an empty array.
 * Does not handle: Executing `enabled`, retaining the write, or handling I/O/scan/assertion failure.
 * Side effects: Overwrites test source/layout and starts a local scan; `withWorkspaceFixture` owns cleanup.
 */
    async (fixture) => {
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

test("one repository's parser uncertainty stays scoped to that repository and deployment",
  /**
 * Scans the default fixture to compare complete API/worker deployments with broken parser and dynamic-lookup uncertainty.
 * Inputs: No callback arguments; asks `withWorkspaceFixture` for its default complete, broken, and user-controlled repository sources.
 * Outputs: Resolves after API/worker remain complete, broken deployment is incomplete, and dynamic alone has one unbounded user-controlled lookup with no likely keys.
 * Does not handle: Repairing broken source, fixture retention, or scan/assertion error recovery.
 * Side effects: Starts one fixture scan and reads result arrays; helper cleans up the temporary tree.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Runs one local workspace scan and inspects the API, worker, broken, and dynamic partitions.
 * Inputs: The default fixture passed by `withWorkspaceFixture`.
 * Outputs: Resolves after status and lookup assertions show incomplete uncertainty is restricted to broken/dynamic paths rather than API/worker.
 * Does not handle: Editing fixture source, provisioning attribution, or catching scan/assertion failure.
 * Side effects: Reads the manifest/source result through `scanFixture`; outer helper deletes the fixture afterwards.
 */
    async (fixture) => {
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

test("a malformed deployment input is scoped to its deployment, not its code repository",
  /**
 * Corrupts only `api-production/bindings.json` in a temporary fixture and delegates partition assertions to its callback.
 * Inputs: No callback arguments; receives fixture infrastructure paths from `withWorkspaceFixture` for the malformed write.
 * Outputs: Resolves after API code stays complete, API deployment/member becomes incomplete with invalid-JSON coverage, and worker deployment remains complete.
 * Does not handle: Repairing the malformed JSON, retaining the fixture, or masking file/scan/assertion failure.
 * Side effects: Inner callback overwrites one provisioning document; helper finally cleanup deletes it.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes a single `{` bindings document, scans, and compares its code repository with both deployment partitions.
 * Inputs: The fixture's API infrastructure bindings path plus default source/layout data.
 * Outputs: Resolves after API remains complete, API member carries `APP_LOCAL_INPUT_INVALID_JSON` and incomplete coverage, while worker deployment is complete.
 * Does not handle: JSON repair, cross-deployment retry, or write/scan/assertion failure handling.
 * Side effects: Overwrites one fixture document and reads reconciliation diagnostics; helper deletes fixture files later.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "APP_LOCAL_INPUT_INVALID_JSON".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "APP_LOCAL_INPUT_INVALID_JSON"` result consumed by `deploymentMember(apiDeployment, "api")?.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "APP_LOCAL_INPUT_INVALID_JSON",
      ),
      true,
    );
    assert.equal(
      deploymentMember(apiDeployment, "api")?.reconciliation.scopeCoverage.some(
        /**
        * Evaluates predicate coverage_state equals "incomplete".
        *
        * Inputs: `coverage`.
        * Outputs: the `coverage.state === "incomplete"` result consumed by `deploymentMember(apiDeployment, "api")?.reconciliation.scopeCoverage.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (coverage) => coverage.state === "incomplete",
      ),
      true,
    );
    assert.equal(workerDeployment?.status, "complete");
  });
});

test("an oversized provisioning document is scoped incomplete and cannot support absence",
  /**
 * Writes an API bindings manifest with 100,001 candidates and a terminal sentinel into a temporary fixture.
 * Inputs: No callback arguments; fixture callback allocates the oversized candidate array and serializes it to API provisioning input.
 * Outputs: Resolves after API deployment/member are incomplete, report `APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED`, retain incomplete coverage, and never serialize the sentinel.
 * Does not handle: Streaming oversized input, accepting partial entries, fixture cleanup, or failed I/O/scan/assertion recovery.
 * Side effects: Allocates a large array and overwrites bindings JSON; helper removes the temporary tree.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Serializes 100,001 binding candidates, with the last carrying a sentinel, then scans the supplied fixture.
 * Inputs: The fixture API bindings path and local candidates/sentinel array.
 * Outputs: Resolves after the affected deployment/member show entry-limit incompleteness and the serialized scan result does not include the sentinel.
 * Does not handle: Reading entries after the limit, cleaning up the fixture, or handling serialization/write/scan/assertion errors.
 * Side effects: Allocates and writes a large JSON document, then reads diagnostics/coverage; outer helper removes it.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate String(diagnostic) equals "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED"` result consumed by `member.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => String(diagnostic) === "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED",
      ),
      true,
    );
    assert.equal(
      member.reconciliation.scopeCoverage.some(
        /**
        * Evaluates predicate coverage_state equals "incomplete".
        *
        * Inputs: `coverage`.
        * Outputs: the `coverage.state === "incomplete"` result consumed by `member.reconciliation.scopeCoverage.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (coverage) => coverage.state === "incomplete"),
      true,
    );
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  });
});

test("unscoped inventory without a member-scoped provider binding stays unattributed",
  /**
 * Inserts an unscoped `unused-fixture-resource` inventory item without a matching member-scoped provider binding.
 * Inputs: No callback arguments; uses the temporary fixture API inventory path and its default manifest/source layout.
 * Outputs: Resolves after API code stays complete, the item is absent from both record graphs, and API deployment becomes incomplete with `WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY`.
 * Does not handle: Claiming unscoped resources, fixture cleanup, or recovery from write/scan/assertion failure.
 * Side effects: Callback overwrites inventory JSON and starts a local scan; helper removes the fixture.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Replaces API inventory with one authority-qualified but unscoped resource and scans the fixture.
 * Inputs: The helper fixture's API inventory file and default deployment data.
 * Outputs: Resolves after API has no inventory record, its deployment member has no claimed resource, and deployment diagnostics report unattributed inventory.
 * Does not handle: Adding a provider binding, cleanup, or handling write/scan/assertion failures.
 * Side effects: Writes fixture inventory, reads result diagnostics, and relies on outer helper cleanup.
 */
    async (fixture) => {
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
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "inventory"),
      false,
    );
    assert.equal(apiDeployment?.status, "incomplete");
    assert.equal(
      deploymentMember(apiDeployment, "api")?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "unused-fixture-resource".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "unused-fixture-resource"` result consumed by `deploymentMember(apiDeployment, "api")?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "unused-fixture-resource",
      ),
      false,
    );
    assert.equal(
      apiDeployment?.diagnostics.some(
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY"` result consumed by `apiDeployment?.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
  });
});

test("workspace deployment closed-model verification uses the captured manifest base after chdir",
  /**
 * Builds a root-relative closed-model manifest, changes process CWD, and delegates captured-base validation to the fixture callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` provides the root/infra paths where the callback writes model and manifest files.
 * Outputs: Resolves after scanning from an unrelated CWD leaves API deployment complete without `APP_CLOSED_MODEL_ROOT_UNVERIFIED`.
 * Does not handle: Restoring CWD outside the callback's finally, fixture lifecycle, or I/O/scan/assertion recovery.
 * Side effects: Callback creates/writes files and temporarily mutates `process.cwd`; helper deletes the root.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes a root-relative manifest/closed-model pair, switches to an unrelated fixture directory, and scans the issued request.
 * Inputs: Fixture root/infra paths, generated API model JSON, and the process CWD captured for finally restoration.
 * Outputs: Resolves after API deployment is complete and lacks the closed-model-root-unverified diagnostic despite changed CWD.
 * Does not handle: Leaving CWD changed, repairing files, fixture deletion, or read/write/scan/assertion failure handling.
 * Side effects: Creates directory/files and calls `process.chdir` twice; finally restores CWD and outer helper removes the fixture.
 */
    async (fixture) => {
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
          /**
          * Evaluates predicate String(diagnostic) equals "APP_CLOSED_MODEL_ROOT_UNVERIFIED".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `String(diagnostic) === "APP_CLOSED_MODEL_ROOT_UNVERIFIED"` result consumed by `apiDeployment?.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => String(diagnostic) === "APP_CLOSED_MODEL_ROOT_UNVERIFIED",
        ),
        false,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("multi-member closed provisioning remains independently verifiable after chdir",
  /**
 * Creates a shared API/worker deployment with closed-model provisioning and delegates CWD-independent member checks to its fixture callback.
 * Inputs: No callback arguments; `withWorkspaceFixture` provides paths for shared layout, scoped bindings/inventory, closed model, and an unrelated working directory.
 * Outputs: Resolves after both members first remain complete after `chdir`, then both become incomplete without absence records when unscoped/mixed ownership inventory is written.
 * Does not handle: Persisting CWD changes, fixture lifecycle, or write/scan/assertion failure recovery.
 * Side effects: Callback rewrites provisioning documents and CWD; helper cleanup removes files after its callback settles.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes scoped API/worker provisioning and a closed-model manifest, scans from another CWD, then injects unscoped and mixed-ownership inventory snapshots.
 * Inputs: The fixture's shared layout/infra/root paths plus API and worker runtime execution scopes.
 * Outputs: Resolves after initial members are complete, later members show `WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED`, and none report `missing-under-declared-model` demand records.
 * Does not handle: Restoring fixture files, creating a new request after writes, or handling I/O/scan/assertion failure.
 * Side effects: Creates files/directories, overwrites inventory twice, temporarily changes CWD in a finally-protected block, and relies on helper cleanup.
 */
    async (fixture) => {
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
      assert.deepEqual(shared.members.map(
        /**
        * Extracts member_repositoryId for the enclosing assertion.
        *
        * Inputs: `member`.
        * Outputs: the `member.repositoryId` result consumed by `shared.members.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (member) => member.repositoryId), ["api", "worker"]);
      for (const member of shared.members) {
        assert.equal(member.status, "complete");
        assert.equal(
          member.diagnostics.some(
            /**
            * Evaluates predicate diagnostic equals "APP_CLOSED_MODEL_ROOT_UNVERIFIED".
            *
            * Inputs: `diagnostic`.
            * Outputs: the `diagnostic === "APP_CLOSED_MODEL_ROOT_UNVERIFIED"` result consumed by `member.diagnostics.some`.
             * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
             * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
             */
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
            /**
            * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
            *
            * Inputs: `diagnostic`.
            * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `member.diagnostics.some`.
             * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
             * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
             */
            (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
          ),
          true,
        );
        assert.equal(
          member.reconciliation.records.some(
            /**
            * Evaluates predicate record_kind equals "demand" and record_inventory equals "missing-under-declared-model".
            *
            * Inputs: `record`.
            * Outputs: the `record.kind === "demand" && record.inventory === "missing-under-declared-model"` result consumed by `member.reconciliation.records.some`.
             * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
             * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
             */
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
            /**
            * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
            *
            * Inputs: `diagnostic`.
            * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `member.diagnostics.some`.
             * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
             * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
             */
            (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
          ),
          true,
        );
        assert.equal(
          member.reconciliation.records.some(
            /**
            * Evaluates predicate record_kind equals "demand" and record_inventory equals "missing-under-declared-model".
            *
            * Inputs: `record`.
            * Outputs: the `record.kind === "demand" && record.inventory === "missing-under-declared-model"` result consumed by `member.reconciliation.records.some`.
             * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
             * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
             */
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

test("multi-repository deployment keeps exact provisioning in independent repository-qualified partitions",
  /**
 * Builds a shared fixture deployment with member-scoped bindings/inventory and delegates partition-isolation assertions to its callback.
 * Inputs: No callback arguments; callback receives fixture paths to write API/worker scope-specific provisioning and an unscoped inventory item.
 * Outputs: Resolves after exact resources stay in their own repository-qualified member partitions while the unscoped item remains unattributed/incomplete.
 * Does not handle: Cross-member ownership inference, fixture deletion, or write/scan/assertion recovery.
 * Side effects: Callback writes provisioning files and scans the workspace; helper cleanup removes the temporary state.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes shared-layout API/worker scoped candidates/items plus an unscoped inventory item, then scans each member result.
 * Inputs: The fixture, its shared provisioning paths, and per-member execution scope records created in the callback.
 * Outputs: Resolves after exact records are independently attributed to their members and the unscoped resource cannot create a cross-member exact binding.
 * Does not handle: Mutating Core facts after scan, fixture cleanup, or I/O/scan/assertion error handling.
 * Side effects: Overwrites fixture provisioning JSON and reads deployment/member reconciliation; outer helper deletes the tree.
 */
    async (fixture) => {
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
    assert.deepEqual(shared?.members.map(
      /**
      * Extracts member_repositoryId for the enclosing assertion.
      *
      * Inputs: `member`.
      * Outputs: the `member.repositoryId` result consumed by `shared?.members.map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
       */
      (member) => member.repositoryId), ["api", "worker"]);
    assert.deepEqual(shared?.sharedKeys, [
      { namespace: "env", name: "DATABASE_URL" },
    ]);
    const api = deploymentMember(shared, "api");
    const worker = deploymentMember(shared, "worker");
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "exact-declared" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "exact-declared" && record.inventory === "bound"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "exact-declared" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "exact-declared" && record.inventory === "bound"` result consumed by `worker?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "worker-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "worker-database"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "worker-database",
      ),
      false,
    );
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "outsider-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "outsider-database"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "outsider-database",
      ),
      false,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "outsider-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "outsider-database"` result consumed by `worker?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "outsider-database",
      ),
      false,
    );
    assert.equal(
      worker?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "api-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "api-database"` result consumed by `worker?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-database",
      ),
      false,
    );
  });
});

test("an explicitly shared provider resource remains bound in each exact member partition",
  /**
 * Sets up one provider resource explicitly declared in both API and worker member scopes and scans the shared fixture.
 * Inputs: No callback arguments; uses fixture callback paths to write shared-layout binding and inventory manifests with matching execution scopes.
 * Outputs: Resolves after the shared deployment is complete and both member partitions retain the same exact provider resource relation.
 * Does not handle: Implicit sharing, fixture lifecycle, or recovery from provisioning/scan/assertion failures.
 * Side effects: Callback writes fixture provisioning inputs and reads reconciliation output; helper removes temporary files.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes matching API/worker scope candidates and inventory entries for one explicitly shared resource, then scans it.
 * Inputs: The callback fixture and per-member execution scopes used by the binding/inventory builders.
 * Outputs: Resolves after `shared-production` is complete and each member's records preserve the declared shared resource without ambiguity.
 * Does not handle: Creating undeclared sharing, fixture cleanup, or handling write/scan/assertion failure.
 * Side effects: Rewrites shared provisioning files, reads member results, and relies on `withWorkspaceFixture` for deletion.
 */
    async (fixture) => {
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
          /**
          * Evaluates predicate record_kind equals "demand" and record_binding equals "exact-declared" and record_inventory equals "bound".
          *
          * Inputs: `record`.
          * Outputs: the `record.kind === "demand" && record.binding === "exact-declared" && record.inventory === "bound"` result consumed by `member.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) =>
            record.kind === "demand" &&
            record.binding === "exact-declared" &&
            record.inventory === "bound",
        ),
        true,
      );
      assert.equal(
        member.diagnostics.some(
          /**
          * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `member.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
        ),
        false,
      );
    }
  });
});

test("contradictory inventory ownership makes only listed member partitions inconclusive",
  /**
 * Writes a shared deployment whose inventory ownership contradicts the declared API/worker member partitions.
 * Inputs: No callback arguments; fixture callback constructs scoped binding candidates and contradictory inventory item declarations.
 * Outputs: Resolves after only the member partitions named by contradictory ownership become incomplete while unaffected partition facts remain usable.
 * Does not handle: Resolving contradictory inventory automatically, fixture cleanup, or caught scan/assertion failures.
 * Side effects: Callback overwrites provisioning documents and scans; the helper deletes the fixture in finally.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Rewrites shared provisioning with conflicting scope ownership, scans, and reads API/worker deployment member states.
 * Inputs: The helper fixture and scoped candidate/item records generated for its shared deployment.
 * Outputs: Resolves after assertions isolate incomplete diagnostics to the declared conflicting member partitions rather than all members.
 * Does not handle: Repairing ownership, deleting fixture files, or write/scan/assertion failure recovery.
 * Side effects: Writes binding/inventory JSON and observes reconciliation output; outer fixture helper cleans up.
 */
    async (fixture) => {
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
          /**
          * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `member?.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
        ),
        true,
      );
      assert.equal(
        member?.reconciliation.records.some(
          /**
          * Evaluates predicate record_kind equals "demand" and record_disposition equals "inconclusive".
          *
          * Inputs: `record`.
          * Outputs: the `record.kind === "demand" && record.disposition === "inconclusive"` result consumed by `member?.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) => record.kind === "demand" && record.disposition === "inconclusive",
        ),
        true,
      );
      assert.equal(
        member?.reconciliation.records.some(
          /**
          * Evaluates predicate record_kind equals "inventory" and record_inventory equals "inventory-listed-no-static-read".
          *
          * Inputs: `record`.
          * Outputs: the `record.kind === "inventory" && record.inventory === "inventory-listed-no-static-read"` result consumed by `member?.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) => record.kind === "inventory" && record.inventory === "inventory-listed-no-static-read",
        ),
        false,
      );
    }
  });
});

test("a dynamic binding candidate cannot make unscoped inventory shared across members",
  /**
 * Adds a dynamic binding candidate and an unscoped inventory resource to a shared API/worker fixture deployment.
 * Inputs: No callback arguments; the fixture callback writes shared layout, candidate manifest, and unscoped inventory snapshot.
 * Outputs: Resolves after the unscoped resource is not promoted to a shared exact relation and member results remain appropriately inconclusive.
 * Does not handle: Guessing dynamic keys, fixture deletion, or provisioning/scan/assertion error recovery.
 * Side effects: Callback mutates provisioning files and scans the fixture; helper cleanup removes all artifacts.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes a dynamic binding plus unscoped inventory into `shared-production`, scans, and examines both member partitions.
 * Inputs: Fixture paths and the callback's candidate/inventory builder values.
 * Outputs: Resolves after shared-key and member assertions prove a dynamic candidate cannot claim the unscoped resource exactly.
 * Does not handle: Materializing a finite dynamic key, fixture cleanup, or handling write/scan/assertion failure.
 * Side effects: Overwrites fixture provisioning JSON and reads scan output; outer helper owns removal.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "dynamic".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "dynamic"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.binding === "dynamic",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "shared-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "shared-database"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "shared-database",
      ),
      false,
    );
    assert.equal(
      worker.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "exact-declared" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "exact-declared" && record.inventory === "bound"` result consumed by `worker.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" &&
          record.binding === "exact-declared" &&
          record.inventory === "bound",
      ),
      true,
    );
  });
});

test("a dynamic binding competitor prevents an exact candidate from proving a bound member relation",
  /**
 * Introduces both exact and dynamic competing bindings for an unscoped inventory item in a shared deployment.
 * Inputs: No callback arguments; callback creates shared layout and writes the competing candidate/inventory manifests.
 * Outputs: Resolves after the exact candidate cannot prove a bound member relation and affected member output is conservative.
 * Does not handle: Selecting a winner from dynamic ambiguity, fixture lifecycle, or caught I/O/scan/assertion failures.
 * Side effects: Callback rewrites provisioning inputs, invokes scan, and helper cleanup removes the fixture.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes exact and dynamic competitors with an unscoped item, scans `shared-production`, and inspects member reconciliation.
 * Inputs: Fixture shared-layout paths and generated binding/inventory records.
 * Outputs: Resolves after assertions show dynamic competition blocks exact member binding proof rather than assigning the resource.
 * Does not handle: Resolving ambiguity, cleaning up fixture files, or handling writer/scanner/assertion errors.
 * Side effects: Mutates fixture provisioning files, reads scan results, and leaves deletion to `withWorkspaceFixture`.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "dynamic" and record_disposition equals "inconclusive".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "dynamic" && record.disposition === "inconclusive"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" &&
          record.binding === "dynamic" &&
          record.disposition === "inconclusive",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "api-exact-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "api-exact-database"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-exact-database",
      ),
      false,
    );
  });
});

test("an unknown binding scope makes only its potentially affected member inconclusive",
  /**
 * Writes a shared deployment with one binding whose execution scope is unknown and verifies scoped incompleteness.
 * Inputs: No arguments; callback receives fixture paths and constructs shared scoped candidates/items including the unknown scope.
 * Outputs: Resolves after only the potentially affected member is incomplete while the independent sibling remains reconciled.
 * Does not handle: Inferring an unknown target, fixture cleanup, or recovering write/scan/assertion errors.
 * Side effects: Callback overwrites provisioning data and scans; helper removes the temporary tree.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Persists an unknown-scope binding beside exact member data, scans shared production, and reads API/worker member states.
 * Inputs: The fixture paths and callback-built binding/inventory records.
 * Outputs: Resolves after assertions localize uncertainty to the member that could match the unknown scope.
 * Does not handle: Scope repair, fixture deletion, or write/scan/assertion error handling.
 * Side effects: Writes provisioning JSON and reads result records; outer helper cleanup owns deletion.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_BINDING_OWNERSHIP_UNRESOLVED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_MEMBER_BINDING_OWNERSHIP_UNRESOLVED"` result consumed by `api.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_BINDING_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_disposition equals "inconclusive".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.disposition === "inconclusive"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
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
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `worker.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
  });
});

test("a partial binding selector cannot turn unscoped inventory into an exact member binding",
  /**
 * Supplies a partial binding selector with an unscoped inventory resource in a shared API/worker deployment.
 * Inputs: No arguments; callback uses fixture provisioning paths to write the selector, resource, and shared layout.
 * Outputs: Resolves after no member receives an exact claim for the unscoped resource and affected output remains conservative.
 * Does not handle: Completing selector conditions, fixture lifecycle, or handling write/scan/assertion failures.
 * Side effects: Callback mutates test provisioning files and starts a scan; helper performs cleanup.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes partial selector and unscoped inventory documents, scans, and inspects each shared deployment member.
 * Inputs: The fixture and candidate/item builder values produced in this callback.
 * Outputs: Resolves after member assertions confirm partial selection cannot establish exact ownership.
 * Does not handle: Selector expansion, file cleanup, or recovery from write/scan/assertion failures.
 * Side effects: Overwrites provisioning documents and reads reconciliation; helper removes temporary files.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY"` result consumed by `shared.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_binding equals "unresolved".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.binding === "unresolved"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.binding === "unresolved",
      ),
      true,
    );
    assert.equal(worker.status, "incomplete");
    assert.equal(
      worker.diagnostics.some(
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `worker.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
  });
});

test("a shadowed binding cannot claim an otherwise unscoped inventory item",
  /**
 * Writes active and shadowed API binding candidates plus unscoped inventory into a shared fixture deployment.
 * Inputs: No arguments; callback creates shared layout and the ordered candidate/resource manifests.
 * Outputs: Resolves after the shadowed candidate cannot claim its otherwise unscoped inventory item.
 * Does not handle: Reordering candidates, fixture cleanup, or write/scan/assertion failure recovery.
 * Side effects: Callback writes provisioning files and scans them; helper removes the root.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Persists active/shadowed candidates and unscoped items, scans `shared-production`, and inspects API reconciliation.
 * Inputs: The callback fixture plus candidate precedence and inventory builder objects.
 * Outputs: Resolves after the active relation remains eligible while the shadowed candidate has no exact inventory claim.
 * Does not handle: Precedence resolution changes, cleanup, or write/scan/assertion errors.
 * Side effects: Rewrites test provisioning JSON and reads scan result; outer helper deletes the fixture.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY"` result consumed by `shared.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
    assert.equal(
      api.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "api-shadowed-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "api-shadowed-database"` result consumed by `api.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "inventory" &&
          record.providerResourceId.canonicalId === "api-shadowed-database",
      ),
      false,
    );
  });
});

test("mismatched inventory authority cannot become a cross-member bound relation",
  /**
 * Uses a binding and inventory resource with incompatible provider authorities in a shared deployment.
 * Inputs: No arguments; callback writes shared layout plus authority-mismatched candidate/item fixtures.
 * Outputs: Resolves after no cross-member bound relation is emitted and uncertainty stays scoped to the affected member.
 * Does not handle: Authority translation, fixture cleanup, or recovery from provisioning/scan/assertion errors.
 * Side effects: Callback mutates fixture provisioning data and scans it; helper cleanup removes artifacts.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Writes mismatched-authority binding/inventory documents, scans shared production, and examines member reconciliation records.
 * Inputs: Fixture paths and authority-qualified builder values.
 * Outputs: Resolves after assertions show incompatible authority cannot bind a resource across API/worker partitions.
 * Does not handle: Rebinding authority, cleanup, or handling writer/scanner/assertion failures.
 * Side effects: Writes JSON fixtures and reads deployment output; `withWorkspaceFixture` cleans up.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"` result consumed by `api?.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED",
      ),
      true,
    );
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) =>
          record.kind === "demand" &&
          record.inventory === "bound",
      ),
      false,
    );
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "demand" and record_disposition equals "inconclusive".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.disposition === "inconclusive"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.disposition === "inconclusive",
      ),
      true,
    );
    assert.equal(worker?.status, "complete");
  });
});

test("a broken deployment member does not erase an independently reconciled sibling",
  /**
 * Verifies the callback behavior for “a broken deployment member does not erase an independently reconciled sibling”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `inventoryItem`, `writeFile`, `join`, `deployment`.
 * Outputs: A promise that resolves only after 4 equal assertion establish “a broken deployment member does not erase an independently reconciled sibling”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “a broken deployment member does not erase an independently reconciled sibling”.
 * Inputs: Receives `fixture` from its caller. It invokes `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `inventoryItem`, `writeFile`, `join`, `deployment`, `scanFixture`.
 * Outputs: A promise that resolves only after 4 equal assertion establish “a broken deployment member does not erase an independently reconciled sibling”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate record_kind equals "demand" and record_inventory equals "bound".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "demand" && record.inventory === "bound"` result consumed by `api?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "demand" && record.inventory === "bound",
      ),
      true,
    );
  });
});

test("an unresolved deployment root does not erase a valid sibling partition",
  /**
 * Verifies the callback behavior for “an unresolved deployment root does not erase a valid sibling partition”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `mkdir`, `all`, `writeFile`, `stringify`, `bindingManifest`, `inventorySnapshot`, `scanFixture`, `deployment`.
 * Outputs: A promise that resolves only after 5 equal assertion establish “an unresolved deployment root does not erase a valid sibling partition”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “an unresolved deployment root does not erase a valid sibling partition”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `mkdir`, `all`, `writeFile`, `stringify`, `bindingManifest`, `inventorySnapshot`, `scanFixture`, `deployment`, `deploymentMember`.
 * Outputs: A promise that resolves only after 5 equal assertion establish “an unresolved deployment root does not erase a valid sibling partition”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate diagnostic equals "WORKSPACE_REPOSITORY_ROOT_UNAVAILABLE".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `diagnostic === "WORKSPACE_REPOSITORY_ROOT_UNAVAILABLE"` result consumed by `missing.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_UNAVAILABLE",
      ),
      true,
    );
  });
});

test("one repository can participate in separate deployments without provisioning or source-snapshot merge",
  /**
 * Verifies the callback behavior for “one repository can participate in separate deployments without provisioning or source-snapshot merge”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `all`, `mkdir`, `join`, `writeFile`, `stringify`, `deploymentWithMemberScope`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`.
 * Outputs: A promise that resolves only after 5 equal, 2 deepEqual, 2 notStrictEqual assertion groups establish “one repository can participate in separate deployments without provisioning or source-snapshot merge”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “one repository can participate in separate deployments without provisioning or source-snapshot merge”.
 * Inputs: Receives `fixture` from its caller. It invokes `all`, `mkdir`, `join`, `writeFile`, `stringify`, `deploymentWithMemberScope`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 5 equal, 2 deepEqual, 2 notStrictEqual assertion groups establish “one repository can participate in separate deployments without provisioning or source-snapshot merge”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "first-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "first-database"` result consumed by `first?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "first-database",
      ),
      true,
    );
    assert.equal(
      first?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "second-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "second-database"` result consumed by `first?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "second-database",
      ),
      false,
    );
    assert.equal(
      second?.reconciliation.records.some(
        /**
        * Evaluates predicate record_kind equals "inventory" and record_providerResourceId_canonicalId equals "second-database".
        *
        * Inputs: `record`.
        * Outputs: the `record.kind === "inventory" && record.providerResourceId.canonicalId === "second-database"` result consumed by `second?.reconciliation.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
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

test("workspace runtime exposes the exact narrow N5 port shape",
  /**
 * Verifies the callback behavior for “workspace runtime exposes the exact narrow N5 port shape”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `createLocalWorkspaceScanPort`, `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `scan`, `equal`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal assertion groups establish “workspace runtime exposes the exact narrow N5 port shape”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  const port: WorkspaceScanPort<WorkspaceScanReportSource> = createLocalWorkspaceScanPort();
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “workspace runtime exposes the exact narrow N5 port shape”.
 * Inputs: Receives `fixture` from its caller. It invokes `readLocalWorkspaceManifest`, `fail`, `scan`, `equal`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal assertion groups establish “workspace runtime exposes the exact narrow N5 port shape”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) {
      assert.fail(document.code);
    }
    const result = await port.scan(document.request);
    assert.equal(result.repositories.length, 4);
    assert.equal(result.deployments.length, 4);
  });
});

test("runtime deployment preparation bounds broad binding and inventory fanout",
  /**
 * Verifies the callback behavior for “runtime deployment preparation bounds broad binding and inventory fanout”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `from`, `String`, `all`, `map`, `mkdir`, `join`, `writeFile`, `stringify`, `bindingCandidate`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal assertion groups establish “runtime deployment preparation bounds broad binding and inventory fanout”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “runtime deployment preparation bounds broad binding and inventory fanout”.
 * Inputs: Receives `fixture` from its caller. It invokes `from`, `String`, `all`, `map`, `mkdir`, `join`, `writeFile`, `stringify`, `bindingCandidate`, `inventoryItem`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal assertion groups establish “runtime deployment preparation bounds broad binding and inventory fanout”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const memberCount = 100;
    const candidateCount = 1_001;
    const repositoryIds = Array.from({ length: memberCount },
      /**
      * Builds fixture value "fanout-" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"fanout-" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "fanout-" + String(index));
    await Promise.all(repositoryIds.map(
      /**
       * Creates one repository root used by the broad-fanout provisioning fixture.
       *
       * Inputs: `id`.
       * Outputs: the `mkdir(join(fixture.root, id), { recursive: true })` result consumed by `repositoryIds.map`.
       * Does not handle: Writing the repository source, defining scopes, or creating another root.
       * Side effects: Starts recursive directory creation below the test fixture root.
       */
      (id) => mkdir(join(fixture.root, id), { recursive: true })));
    const memberScopes = repositoryIds.map(
      /**
       * Creates one repository-owned runtime/environment scope with an index-specific exact stage for the fanout fixture.
       *
       * Inputs: The current repository ID and its array index.
       * Outputs: A member-scope declaration using the shared fanout component and a unique `fanout-stage-<index>` stage.
       * Does not handle: Creating repository directories, validating cross-member scope overlap, or writing the manifest.
       * Side effects: Allocates one nested fixture object.
       */
      (repositoryId, index) => ({
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
    const deployments = ["binding-fanout", "inventory-fanout"].map(
      /**
      * Extracts ({ id, repositories: repositoryIds, inputs: { bindings: "__/infra/" + id + "/bindings_json", inventory: "__/infra/" + id + "/inventory_json", memberScopes, }, }) for the enclosing assertion.
      *
      * Inputs: `id`.
      * Outputs: the `({ id, repositories: repositoryIds, inputs: { bindings: "../infra/" + id + "/bindings.json", inventory: "../infra/" + id + "/inventory.json", memberScopes, }, })` result consumed by `["binding-fanout", "inventory-fanout"].map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
       */
      (id) => ({
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
        repositories: repositoryIds.map(
          /**
          * Extracts ({ id, root: "__/" + id }) for the enclosing assertion.
          *
          * Inputs: `id`.
          * Outputs: the `({ id, root: "../" + id })` result consumed by `repositoryIds.map`.
           * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
           * Side effects: Reads the current callback input and returns its projected in-memory value.
           */
          (id) => ({ id, root: "../" + id })),
        deployments,
      }),
      "utf8",
    );
    await Promise.all(deployments.map(
      /**
       * Writes the binding or inventory fanout documents for one declared deployment.
       *
       * Inputs: `deployment`.
       * Outputs: the `{ const directory = join(fixture.infraRoot, deployment.id); await mkdir(directory, { recursive: true }); const bindingCandidates = deployment.id === "binding-fanout" ? Array.from({ length: c` result consumed by `deployments.map`.
       * Does not handle: Updating the workspace manifest, scanning the deployment, or writing another deployment's documents.
       * Side effects: Creates the deployment input directory and writes its bounded JSON fixture files.
       */
      async (deployment) => {
      const directory = join(fixture.infraRoot, deployment.id);
      await mkdir(directory, { recursive: true });
      const bindingCandidates = deployment.id === "binding-fanout"
        ? Array.from({ length: candidateCount },
          /**
          * Builds fixture value bindingCandidate( "fanout", "binding-resource-" + String(index), "fixture-authority", broadScope, "exact", { kind: "all" }, String(index), ).
          *
          * Inputs: `_`, `index`.
          * Outputs: the `bindingCandidate( "fanout", "binding-resource-" + String(index), "fixture-authority", broadScope, "exact", { kind: "all" }, String(index), )` result consumed by `Array.from`.
           * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
           * Side effects: Produces only the current in-memory fixture value.
           */
          (_, index) => bindingCandidate(
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
        ? Array.from({ length: candidateCount },
          /**
          * Builds fixture value inventoryItem( "fanout", "inventory-resource-" + String(index), "fixture-authority", broadScope, ).
          *
          * Inputs: `_`, `index`.
          * Outputs: the `inventoryItem( "fanout", "inventory-resource-" + String(index), "fixture-authority", broadScope, )` result consumed by `Array.from`.
           * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
           * Side effects: Produces only the current in-memory fixture value.
           */
          (_, index) => inventoryItem(
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
        /**
        * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_BINDING_FANOUT_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_BINDING_FANOUT_EXCEEDED"` result consumed by `deployment(result, "binding-fanout").diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_BINDING_FANOUT_EXCEEDED",
      ),
      true,
    );
    assert.equal(
      deployment(result, "inventory-fanout").diagnostics.some(
        /**
        * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_INVENTORY_FANOUT_EXCEEDED" or String(diagnostic) equals "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_INVENTORY_FANOUT_EXCEEDED" || String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"` result consumed by `deployment(result, "inventory-fanout").diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) =>
          String(diagnostic) === "WORKSPACE_DEPLOYMENT_INVENTORY_FANOUT_EXCEEDED" ||
          String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",
      ),
      true,
    );
  });
});

test("runtime projection budget bounds source-rich member output deterministically",
  /**
 * Verifies the callback behavior for “runtime projection budget bounds source-rich member output deterministically”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `from`, `String`, `join`, `all`, `map`, `mkdir`, `writeFile`, `stringify`, `bindingManifest`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 3 equal, 3 deepEqual assertion groups establish “runtime projection budget bounds source-rich member output deterministically”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “runtime projection budget bounds source-rich member output deterministically”.
 * Inputs: Receives `fixture` from its caller. It invokes `from`, `String`, `join`, `all`, `map`, `mkdir`, `writeFile`, `stringify`, `bindingManifest`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 3 equal, 3 deepEqual assertion groups establish “runtime projection budget bounds source-rich member output deterministically”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const memberCount = 100;
    const readsPerMember = 1_001;
    const repositoryIds = Array.from(
      { length: memberCount },
      /**
      * Builds fixture value "projection-" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"projection-" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "projection-" + String(index),
    );
    const source = Array.from(
      { length: readsPerMember },
      /**
      * Builds fixture value "export const value" + String(index) + " = process_env_PROJECTION_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const value" + String(index) + " = process.env.PROJECTION_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "export const value" + String(index) + " = process.env.PROJECTION_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all(repositoryIds.map(
      /**
       * Creates one source tree containing the repeated environment reads for projection-budget testing.
       *
       * Inputs: `id`.
       * Outputs: the `{ const root = join(fixture.root, id, "src"); await mkdir(root, { recursive: true }); await writeFile(join(root, "index.ts"), source, "utf8"); }` result consumed by `repositoryIds.map`.
       * Does not handle: Declaring manifest entries, scanning the repository, or creating sibling source trees.
       * Side effects: Recursively creates the source directory and writes its generated TypeScript file.
       */
      async (id) => {
      const root = join(fixture.root, id, "src");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "index.ts"), source, "utf8");
    }));
    const memberScopes = repositoryIds.map(
      /**
       * Creates one all-stage runtime/environment scope that isolates a projection-budget fixture repository.
       *
       * Inputs: The current repository ID.
       * Outputs: A member-scope declaration whose scope and component IDs are derived from that repository ID.
       * Does not handle: Creating source files, checking scope overlap, or updating the workspace manifest.
       * Side effects: Allocates one nested fixture object.
       */
      (repositoryId) => ({
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
      repositories: repositoryIds.map(
        /**
        * Extracts ({ id, root: "__/" + id }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, root: "../" + id })` result consumed by `repositoryIds.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, root: "../" + id })),
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
      .map(
        /**
        * Extracts member_repositoryId for the enclosing assertion.
        *
        * Inputs: `member`.
        * Outputs: the `member.repositoryId` result consumed by `first.members .filter(isBudgetFallbackMember) .map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (member) => member.repositoryId);

    assert.ok(exhausted.length > 0);
    assert.ok(firstWorkspace.repositories.some(isBudgetFallbackResult));
    assert.ok(emittedWorkspaceGraphFacts(firstWorkspace) <= 100_000);
    for (const member of first.members.filter(
      /**
      * Evaluates predicate exhausted_includes(entry_repositoryId).
      *
      * Inputs: `entry`.
      * Outputs: the `exhausted.includes(entry.repositoryId)` result consumed by `first.members.filter`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) => exhausted.includes(entry.repositoryId))) {
      assert.equal(member.status, "incomplete");
      assert.deepEqual(member.references, []);
      assert.deepEqual(member.demandEdges, []);
      assert.equal(
        member.reconciliation.scopeCoverage.some(
          /**
          * Evaluates predicate coverage_state equals "incomplete".
          *
          * Inputs: `coverage`.
          * Outputs: the `coverage.state === "incomplete"` result consumed by `member.reconciliation.scopeCoverage.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (coverage) => coverage.state === "incomplete"),
        true,
      );
      assert.equal(
        member.reconciliation.records.some(
          /**
          * Evaluates predicate record_coverage equals "complete".
          *
          * Inputs: `record`.
          * Outputs: the `record.coverage === "complete"` result consumed by `member.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) => record.coverage === "complete"),
        false,
      );
    }

    const second = deployment(await scanWorkspace(document.request), "projection-budget");
    const exhaustedAgain = second.members
      .filter(isBudgetFallbackMember)
      .map(
        /**
        * Extracts member_repositoryId for the enclosing assertion.
        *
        * Inputs: `member`.
        * Outputs: the `member.repositoryId` result consumed by `second.members .filter(isBudgetFallbackMember) .map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (member) => member.repositoryId);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("repository-only admission shares the invocation graph ledger",
  /**
 * Verifies the callback behavior for “repository-only admission shares the invocation graph ledger”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `from`, `String`, `join`, `all`, `map`, `mkdir`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 1 deepEqual assertion groups establish “repository-only admission shares the invocation graph ledger”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “repository-only admission shares the invocation graph ledger”.
 * Inputs: Receives `fixture` from its caller. It invokes `from`, `String`, `join`, `all`, `map`, `mkdir`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 1 deepEqual assertion groups establish “repository-only admission shares the invocation graph ledger”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const repositoryCount = 40;
    const readsPerRepository = 1_001;
    const repositoryIds = Array.from(
      { length: repositoryCount },
      /**
      * Builds fixture value "repository-budget-" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"repository-budget-" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "repository-budget-" + String(index),
    );
    const source = Array.from(
      { length: readsPerRepository },
      /**
      * Builds fixture value "export const value" + String(index) + " = process_env_REPOSITORY_BUDGET_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const value" + String(index) + " = process.env.REPOSITORY_BUDGET_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) =>
        "export const value" + String(index) +
        " = process.env.REPOSITORY_BUDGET_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all(repositoryIds.map(
      /**
       * Creates one source tree containing the repeated environment reads for repository-budget testing.
       *
       * Inputs: `id`.
       * Outputs: the `{ const root = join(fixture.root, id, "src"); await mkdir(root, { recursive: true }); await writeFile(join(root, "index.ts"), source, "utf8"); }` result consumed by `repositoryIds.map`.
       * Does not handle: Writing the manifest, scanning the repository, or creating sibling source trees.
       * Side effects: Recursively creates the source directory and writes its generated TypeScript file.
       */
      async (id) => {
      const root = join(fixture.root, id, "src");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "index.ts"), source, "utf8");
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: repositoryIds.map(
        /**
        * Extracts ({ id, root: "__/" + id }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, root: "../" + id })` result consumed by `repositoryIds.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, root: "../" + id })),
      deployments: [],
    }), "utf8");

    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);
    const first = await scanWorkspace(document.request);
    const fallback = first.repositories
      .filter(isBudgetFallbackResult)
      .map(
        /**
        * Extracts repository_id for the enclosing assertion.
        *
        * Inputs: `repository`.
        * Outputs: the `repository.id` result consumed by `first.repositories .filter(isBudgetFallbackResult) .map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (repository) => repository.id);
    assert.ok(fallback.length > 0);
    assert.ok(fallback.length < repositoryCount);
    assert.ok(emittedWorkspaceGraphFacts(first) <= 100_000);

    const second = await scanWorkspace(document.request);
    assert.deepEqual(
      second.repositories.filter(isBudgetFallbackResult).map(
        /**
        * Extracts repository_id for the enclosing assertion.
        *
        * Inputs: `repository`.
        * Outputs: the `repository.id` result consumed by `second.repositories.filter(isBudgetFallbackResult).map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (repository) => repository.id),
      fallback,
    );
  });
});

test("nested coverage evidence is admitted before Core record materialization",
  /**
 * Verifies the callback behavior for “nested coverage evidence is admitted before Core record materialization”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`, `mkdir`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal, 1 ok assertion groups establish “nested coverage evidence is admitted before Core record materialization”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “nested coverage evidence is admitted before Core record materialization”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `from`, `String`, `writeFile`, `mkdir`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`, `readLocalWorkspaceManifest`.
 * Outputs: A promise that resolves only after 1 fail, 2 equal, 1 ok assertion groups establish “nested coverage evidence is admitted before Core record materialization”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const demandCount = 1_000;
    const source = Array.from(
      { length: demandCount },
      /**
      * Builds fixture value "export const value" + String(index) + " = process_env_NESTED_EVIDENCE_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const value" + String(index) + " = process.env.NESTED_EVIDENCE_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) =>
        "export const value" + String(index) +
        " = process.env.NESTED_EVIDENCE_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), source, "utf8");
    const inputRoot = join(fixture.infraRoot, "nested-evidence");
    await mkdir(inputRoot, { recursive: true });
    const invalidCandidates = Array.from(
      { length: 1_000 },
      /**
      * Builds fixture value ({ invalid: "not-a-binding-candidate" }).
      *
      * Inputs: no arguments.
      * Outputs: the `({ invalid: "not-a-binding-candidate" })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
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

test("workspace projection budget does not reset for the same source in later deployments",
  /**
 * Verifies the callback behavior for “workspace projection budget does not reset for the same source in later deployments”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`, `mkdir`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 1 fail, 2 ok, 3 equal, 3 deepEqual assertion groups establish “workspace projection budget does not reset for the same source in later deployments”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “workspace projection budget does not reset for the same source in later deployments”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `from`, `String`, `writeFile`, `mkdir`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`, `readLocalWorkspaceManifest`.
 * Outputs: A promise that resolves only after 1 fail, 2 ok, 3 equal, 3 deepEqual assertion groups establish “workspace projection budget does not reset for the same source in later deployments”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const deploymentCount = 51;
    const reads = Array.from(
      { length: 1_001 },
      /**
      * Builds fixture value "export const repeat" + String(index) + " = process_env_REPEAT_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const repeat" + String(index) + " = process.env.REPEAT_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "export const repeat" + String(index) + " = process.env.REPEAT_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8");
    const inputRoot = join(fixture.infraRoot, "workspace-budget-repeat");
    await mkdir(inputRoot, { recursive: true });
    await Promise.all([
      writeFile(join(inputRoot, "bindings.json"), JSON.stringify(bindingManifest([])), "utf8"),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
    ]);
    const deployments = Array.from({ length: deploymentCount },
      /**
       * Builds one API deployment declaration that reuses the workspace-budget provisioning inputs while retaining a unique member scope.
       *
       * Inputs: The unused Array.from value and deployment index.
       * Outputs: A deployment record named `workspace-budget-<index>` with the shared binding/inventory descriptors and an index-specific API scope.
       * Does not handle: Writing provisioning files, running the scan, or validating the manifest.
       * Side effects: Allocates one nested deployment fixture object.
       */
      (_, index) => ({
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
      .filter(
        /**
        * Evaluates predicate isBudgetFallbackMember(deploymentMember(entry, "api")).
        *
        * Inputs: `entry`.
        * Outputs: the `isBudgetFallbackMember(deploymentMember(entry, "api"))` result consumed by `first.deployments .filter`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map(
        /**
         * Collects the IDs of deployments whose API member received the compact budget fallback.
         *
         * Inputs: One filtered deployment entry.
         * Outputs: That deployment's ID for comparison with the repeated scan.
         * Does not handle: Rechecking fallback state, sorting IDs, or mutating the deployment.
         * Side effects: Reads the deployment ID without mutation or I/O.
         */
        (entry) => entry.id);
    assert.ok(exhausted.length > 0);
    assert.ok(exhausted.length < deploymentCount);
    assert.equal(first.deployments[0]?.members[0]?.status, "complete");
    for (const id of exhausted) {
      const member = deploymentMember(deployment(first, id), "api");
      assert.equal(member.status, "incomplete");
      assert.deepEqual(member.references, []);
      assert.deepEqual(member.demandEdges, []);
      assert.equal(
        member.reconciliation.records.some(
          /**
          * Evaluates predicate record_coverage equals "complete".
          *
          * Inputs: `record`.
          * Outputs: the `record.coverage === "complete"` result consumed by `member.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) => record.coverage === "complete"),
        false,
      );
    }

    const second = await scanWorkspace(document.request);
    const exhaustedAgain = second.deployments
      .filter(
        /**
        * Evaluates predicate isBudgetFallbackMember(deploymentMember(entry, "api")).
        *
        * Inputs: `entry`.
        * Outputs: the `isBudgetFallbackMember(deploymentMember(entry, "api"))` result consumed by `second.deployments .filter`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map(
        /**
         * Collects the repeated-scan deployment IDs that again have the API budget fallback.
         *
         * Inputs: One filtered deployment entry from the second scan.
         * Outputs: That deployment's ID for equality with the first scan's fallback IDs.
         * Does not handle: Rechecking fallback state, sorting IDs, or mutating the deployment.
         * Side effects: Reads the deployment ID without mutation or I/O.
         */
        (entry) => entry.id);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("scan-only deployments share one invocation budget and reset on the next scan",
  /**
 * Verifies the callback behavior for “scan-only deployments share one invocation budget and reset on the next scan”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`, `scanWorkspace`, `map`.
 * Outputs: A promise that resolves only after 1 fail, 2 ok, 1 equal, 3 deepEqual assertion groups establish “scan-only deployments share one invocation budget and reset on the next scan”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “scan-only deployments share one invocation budget and reset on the next scan”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `from`, `String`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`, `scanWorkspace`, `map`, `filter`.
 * Outputs: A promise that resolves only after 1 fail, 2 ok, 1 equal, 3 deepEqual assertion groups establish “scan-only deployments share one invocation budget and reset on the next scan”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const reads = Array.from(
      { length: 1_001 },
      /**
      * Builds fixture value "export const scanOnly" + String(index) + " = process_env_SCAN_ONLY_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const scanOnly" + String(index) + " = process.env.SCAN_ONLY_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "export const scanOnly" + String(index) + " = process.env.SCAN_ONLY_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8");
    const deployments = Array.from({ length: 101 },
      /**
      * Builds fixture value ({ id: "scan-only-budget-" + String(index), repositories: ["api"], }).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "scan-only-budget-" + String(index), repositories: ["api"], })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => ({
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
      .filter(
        /**
        * Evaluates predicate isBudgetFallbackMember(deploymentMember(entry, "api")).
        *
        * Inputs: `entry`.
        * Outputs: the `isBudgetFallbackMember(deploymentMember(entry, "api"))` result consumed by `first.deployments .filter`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map(
        /**
         * Collects scan-only deployment IDs whose API member has the first-scan budget fallback.
         *
         * Inputs: One filtered scan-only deployment entry.
         * Outputs: That deployment's ID for the budget-reset assertions.
         * Does not handle: Rechecking fallback state, ordering IDs, or mutating deployment data.
         * Side effects: Reads the deployment ID without mutation or I/O.
         */
        (entry) => entry.id);
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
      .filter(
        /**
        * Evaluates predicate isBudgetFallbackMember(deploymentMember(entry, "api")).
        *
        * Inputs: `entry`.
        * Outputs: the `isBudgetFallbackMember(deploymentMember(entry, "api"))` result consumed by `second.deployments .filter`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (entry) => isBudgetFallbackMember(deploymentMember(entry, "api")))
      .map(
        /**
         * Collects second-scan scan-only deployment IDs whose API member has the budget fallback.
         *
         * Inputs: One filtered scan-only deployment entry from the second scan.
         * Outputs: That deployment's ID for equality with the first scan's fallback IDs.
         * Does not handle: Rechecking fallback state, ordering IDs, or mutating deployment data.
         * Side effects: Reads the deployment ID without mutation or I/O.
         */
        (entry) => entry.id);
    assert.deepEqual(exhaustedAgain, exhausted);
  });
});

test("shared-key output is withheld when source graph budget is exhausted",
  /**
 * Verifies the callback behavior for “shared-key output is withheld when source graph budget is exhausted”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `from`, `String`, `all`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`, `scanWorkspace`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 2 deepEqual, 2 equal assertion groups establish “shared-key output is withheld when source graph budget is exhausted”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “shared-key output is withheld when source graph budget is exhausted”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `from`, `String`, `all`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`, `scanWorkspace`, `filter`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 2 deepEqual, 2 equal assertion groups establish “shared-key output is withheld when source graph budget is exhausted”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const reads = Array.from(
      { length: 900 },
      /**
      * Builds fixture value "export const shared" + String(index) + " = process_env_SHARED_BUDGET_KEY_" + String(index) + ";".
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"export const shared" + String(index) + " = process.env.SHARED_BUDGET_KEY_" + String(index) + ";"` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "export const shared" + String(index) + " = process.env.SHARED_BUDGET_KEY_" + String(index) + ";",
    ).join("\n") + "\n";
    await Promise.all([
      writeFile(join(fixture.repositoryRoots.api, "src", "index.ts"), reads, "utf8"),
      writeFile(join(fixture.repositoryRoots.worker, "src", "worker.ts"), reads, "utf8"),
    ]);
    const deployments = Array.from({ length: 20 },
      /**
      * Builds fixture value ({ id: "shared-key-budget-" + String(index), repositories: ["api", "worker"], }).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "shared-key-budget-" + String(index), repositories: ["api", "worker"], })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => ({
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
    const budgetExhausted = result.deployments.filter(
      /**
      * Evaluates predicate entry_diagnostics_some( (diagnostic) => String(diagnostic) equals "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" or String(diagnostic) equals "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED",.
      *
      * Inputs: `entry`.
      * Outputs: the `entry.diagnostics.some( (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" || String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED", ` result consumed by `result.deployments.filter`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) => entry.diagnostics.some(
      /**
      * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" or String(diagnostic) equals "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED".
      *
      * Inputs: `diagnostic`.
      * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" || String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"` result consumed by `entry.diagnostics.some`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
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

test("provisioning records share the invocation graph budget before Core materializes them",
  /**
 * Verifies the callback behavior for “provisioning records share the invocation graph budget before Core materializes them”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `writeFile`, `join`, `mkdir`, `from`, `String`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 2 equal assertion groups establish “provisioning records share the invocation graph budget before Core materializes them”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “provisioning records share the invocation graph budget before Core materializes them”.
 * Inputs: Receives `fixture` from its caller. It invokes `writeFile`, `join`, `mkdir`, `from`, `String`, `all`, `stringify`, `bindingManifest`, `inventorySnapshot`, `padStart`.
 * Outputs: A promise that resolves only after 1 fail, 3 ok, 2 equal assertion groups establish “provisioning records share the invocation graph budget before Core materializes them”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
    const candidates = Array.from({ length: 1_001 },
      /**
       * Builds one exact secret-manager binding candidate with index-specific destination and provider-resource IDs for the provisioning graph budget.
       *
       * Inputs: The unused Array.from value and candidate index.
       * Outputs: A complete fixture binding candidate using the shared all-stage runtime scope and always-applicable condition.
       * Does not handle: Writing the binding manifest, resolving provider resources, or invoking the provisioning adapter.
       * Side effects: Allocates one nested binding fixture object.
       */
      (_, index) => ({
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
    const items = Array.from({ length: 1_001 },
      /**
      * Builds fixture value ({ providerResourceId: { authorityId: "fixture-authority", canonicalId: "provisioning-resource-" + String(index), }, declaredScopes: [scope], }).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ providerResourceId: { authorityId: "fixture-authority", canonicalId: "provisioning-resource-" + String(index), }, declaredScopes: [scope], })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => ({
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
    const deployments = Array.from({ length: 101 },
      /**
       * Builds one API deployment declaration that points to the shared provisioning-graph binding and inventory documents.
       *
       * Inputs: The unused Array.from value and deployment index.
       * Outputs: A zero-padded `provisioning-graph-<index>` deployment with the shared API member scope.
       * Does not handle: Creating provisioning documents, scanning, or validating the generated manifest.
       * Side effects: Allocates one nested deployment fixture object.
       */
      (_, index) => ({
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
    assert.ok(result.deployments.some(
      /**
      * Evaluates predicate deploymentMember(entry, "api")_reconciliation_records_length is at least 1_001.
      *
      * Inputs: `entry`.
      * Outputs: the `deploymentMember(entry, "api").reconciliation.records.length >= 1_001` result consumed by `result.deployments.some`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) =>
      deploymentMember(entry, "api").reconciliation.records.length >= 1_001,
    ));
    const exhausted = result.deployments.filter(
      /**
      * Evaluates predicate isBudgetFallbackMember(deploymentMember(entry, "api")).
      *
      * Inputs: `entry`.
      * Outputs: the `isBudgetFallbackMember(deploymentMember(entry, "api"))` result consumed by `result.deployments.filter`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) =>
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

test("finite condition partition floods fall back before Core selection materializes",
  /**
 * Verifies the callback behavior for “finite condition partition floods fall back before Core selection materializes”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`, `ok`, `byteLength`, `stringify`, `mkdir`, `all`.
 * Outputs: A promise that resolves only after 1 ok, 1 fail, 4 equal, 4 deepEqual assertion groups establish “finite condition partition floods fall back before Core selection materializes”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “finite condition partition floods fall back before Core selection materializes”.
 * Inputs: Receives `fixture` from its caller. It invokes `writeFile`, `join`, `from`, `String`, `ok`, `byteLength`, `stringify`, `mkdir`, `all`, `inventorySnapshot`.
 * Outputs: A promise that resolves only after 1 ok, 1 fail, 4 equal, 4 deepEqual assertion groups establish “finite condition partition floods fall back before Core selection materializes”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
    const candidates = Array.from({ length: 10_000 },
      /**
       * Builds one externally sourced binding candidate with an index-specific finite condition clause for condition-partition flooding.
       *
       * Inputs: The unused Array.from value and candidate index.
       * Outputs: An exact candidate for destination `F` that shares the fixture scope but differs by condition value.
       * Does not handle: Writing adapter input, resolving bindings, or evaluating the condition.
       * Side effects: Allocates one nested binding fixture object.
       */
      (_, index) => ({
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
        /**
        * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"` result consumed by `entry.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
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

test("inventory projection bounds 10k by 10k resource matches without pairwise work",
  /**
 * Verifies the callback behavior for “inventory projection bounds 10k by 10k resource matches without pairwise work”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`, `ok`, `byteLength`, `stringify`, `mkdir`, `all`.
 * Outputs: A promise that resolves only after 1 ok, 1 fail, 4 equal, 1 deepEqual assertion groups establish “inventory projection bounds 10k by 10k resource matches without pairwise work”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “inventory projection bounds 10k by 10k resource matches without pairwise work”.
 * Inputs: Receives `fixture` from its caller. It invokes `writeFile`, `join`, `from`, `String`, `ok`, `byteLength`, `stringify`, `mkdir`, `all`, `readLocalWorkspaceManifest`.
 * Outputs: A promise that resolves only after 1 ok, 1 fail, 4 equal, 1 deepEqual assertion groups establish “inventory projection bounds 10k by 10k resource matches without pairwise work”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `writeFile`, `mkdir`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
    const candidates = Array.from({ length: 10_000 },
      /**
       * Builds one externally sourced binding candidate with a unique environment destination and matching provider resource for projection fanout.
       *
       * Inputs: The unused Array.from value and candidate index.
       * Outputs: An exact candidate whose `K<index>` destination and `r<index>` resource identity are distinct.
       * Does not handle: Creating inventory items, running reconciliation, or writing adapter input.
       * Side effects: Allocates one nested binding fixture object.
       */
      (_, index) => ({
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
      items: Array.from({ length: 10_000 },
        /**
        * Builds fixture value ({ providerResourceId: { authorityId: "a", canonicalId: "r" + String(index) }, }).
        *
        * Inputs: `_`, `index`.
        * Outputs: the `({ providerResourceId: { authorityId: "a", canonicalId: "r" + String(index) }, })` result consumed by `Array.from`.
         * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
         * Side effects: Produces only the current in-memory fixture value.
         */
        (_, index) => ({
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
        /**
        * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"` result consumed by `entry.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
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

test("maximum legal deployment membership reserves compact fallback and aggregate status capacity",
  /**
 * Verifies the callback behavior for “maximum legal deployment membership reserves compact fallback and aggregate status capacity”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `from`, `String`, `all`, `map`, `mkdir`, `join`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`.
 * Outputs: A promise that resolves only after 1 fail, 4 equal, 2 ok assertion groups establish “maximum legal deployment membership reserves compact fallback and aggregate status capacity”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “maximum legal deployment membership reserves compact fallback and aggregate status capacity”.
 * Inputs: Receives `fixture` from its caller. It invokes `from`, `String`, `all`, `map`, `mkdir`, `join`, `writeFile`, `stringify`, `readLocalWorkspaceManifest`, `fail`.
 * Outputs: A promise that resolves only after 1 fail, 4 equal, 2 ok assertion groups establish “maximum legal deployment membership reserves compact fallback and aggregate status capacity”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const repositoryIds = Array.from({ length: 5 },
      /**
      * Builds fixture value "r" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"r" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "r" + String(index));
    await Promise.all(repositoryIds.map(
      /**
       * Creates the `src` directory for one maximum-membership repository fixture.
       *
       * Inputs: `id`.
       * Outputs: the `mkdir(join(fixture.root, id, "src"), { recursive: true })` result consumed by `repositoryIds.map`.
       * Does not handle: Writing source content, producing deployment declarations, or creating another repository root.
       * Side effects: Starts recursive creation of the test-owned source directory.
       */
      (id) =>
      mkdir(join(fixture.root, id, "src"), { recursive: true }),
    ));
    const deployments = Array.from({ length: 10_000 },
      /**
      * Builds fixture value ({ id: "d" + String(index), repositories: repositoryIds, }).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "d" + String(index), repositories: repositoryIds, })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => ({
      id: "d" + String(index),
      repositories: repositoryIds,
    }));
    await writeFile(fixture.manifestPath, JSON.stringify({
      schemaVersion: "workspace-manifest/v1",
      repositories: repositoryIds.map(
        /**
        * Extracts ({ id, root: "__/" + id }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, root: "../" + id })` result consumed by `repositoryIds.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, root: "../" + id })),
      deployments,
    }), "utf8");
    const document = await readLocalWorkspaceManifest(fixture.manifestPath);
    if (document.ok === false) assert.fail(document.code);

    const result = await scanWorkspace(document.request);
    assert.equal(result.deployments.length, 10_000);
    assert.equal(
      result.deployments.reduce(
        /**
        * Sums the member partitions of each maximum-cardinality deployment for the capacity assertion.
        *
        * Inputs: `count`, `entry`.
        * Outputs: the next accumulator value `count + entry.members.length`.
         * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
         * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
         */
        (count, entry) => count + entry.members.length, 0),
      50_000,
    );
    assert.equal(result.deployments.every(
      /**
      * Evaluates predicate entry_diagnostics_length is at most 1.
      *
      * Inputs: `entry`.
      * Outputs: the `entry.diagnostics.length <= 1` result consumed by `result.deployments.every`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) => entry.diagnostics.length <= 1), true);
    assert.ok(emittedWorkspaceGraphFacts(result) <= 100_000);
    assert.ok(result.deployments.some(
      /**
      * Evaluates predicate entry_members_some(isBudgetFallbackMember).
      *
      * Inputs: `entry`.
      * Outputs: the `entry.members.some(isBudgetFallbackMember)` result consumed by `result.deployments.some`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) =>
      entry.members.some(isBudgetFallbackMember),
    ));
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  });
});

test("invocation document cache reuses verified reads and caps unique input bytes before parse",
  /**
 * Verifies the callback behavior for “invocation document cache reuses verified reads and caps unique input bytes before parse”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `mkdir`, `alloc`, `all`, `writeFile`, `stringify`, `inventorySnapshot`, `from`, `String`.
 * Outputs: A promise that resolves only after 1 fail, 3 equal assertion groups establish “invocation document cache reuses verified reads and caps unique input bytes before parse”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “invocation document cache reuses verified reads and caps unique input bytes before parse”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `mkdir`, `alloc`, `all`, `writeFile`, `stringify`, `inventorySnapshot`, `from`, `String`, `scope`.
 * Outputs: A promise that resolves only after 1 fail, 3 equal assertion groups establish “invocation document cache reuses verified reads and caps unique input bytes before parse”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const inputRoot = join(fixture.infraRoot, "input-budget");
    await mkdir(inputRoot, { recursive: true });
    const invalidBytes = Buffer.alloc(4 * 1024 * 1024, 0x20);
    await Promise.all([
      writeFile(join(inputRoot, "repeat.json"), invalidBytes),
      writeFile(join(inputRoot, "overflow.json"), invalidBytes),
      writeFile(join(inputRoot, "inventory.json"), JSON.stringify(inventorySnapshot([])), "utf8"),
      ...Array.from({ length: 23 },
        /**
         * Writes one distinct oversized invalid provisioning document for the cache-byte-budget test.
         *
         * Inputs: `_`, `index`.
         * Outputs: the `writeFile(join(inputRoot, "unique-" + String(index) + ".json"), invalidBytes)` result consumed by `Array.from`.
         * Does not handle: Writing the repeated or inventory inputs, parsing JSON, or observing cache results.
         * Side effects: Starts an asynchronous write of `invalidBytes` to this unique test-owned file.
         */
        (_, index) =>
        writeFile(join(inputRoot, "unique-" + String(index) + ".json"), invalidBytes),
      ),
    ]);
    const scope =
      /**
       * Constructs a runtime execution scope for one cache-budget deployment input.
       *
       * Inputs: The suffix used to distinguish this scope's IDs.
       * Outputs: A member-scope declaration for the fixture's `api` repository.
       * Does not handle: Validating the execution scope, reading provisioning input, or constructing deployments.
       * Side effects: Allocates one in-memory scope declaration object.
       */
      (id: string) => ({
      repositoryId: "api",
      scope: {
        id: "input-budget-" + id,
        componentId: "input-budget-" + id,
        phase: "runtime" as const,
        stage: { kind: "all" as const },
        channel: "environment" as const,
      },
    });
    const deploymentFor =
      /**
       * Builds one API deployment declaration that selects a binding filename while sharing the cache-budget inventory document.
       *
       * Inputs: A deployment ID and binding-document filename.
       * Outputs: A one-member deployment with descriptors under the input-budget fixture directory and a matching generated scope.
       * Does not handle: Writing input files, parsing the manifest, or invoking the workspace scanner.
       * Side effects: Calls `scope` and allocates one nested deployment object.
       */
      (id: string, binding: string) => ({
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
      ...Array.from({ length: 23 },
        /**
        * Builds fixture value deploymentFor("input-" + String(index)_padStart(2, "0"), "unique-" + String(index) + "_json").
        *
        * Inputs: `_`, `index`.
        * Outputs: the `deploymentFor("input-" + String(index).padStart(2, "0"), "unique-" + String(index) + ".json")` result consumed by `Array.from`.
         * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
         * Side effects: Produces only the current in-memory fixture value.
         */
        (_, index) =>
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
        /**
        * Evaluates predicate String(diagnostic) equals "APP_LOCAL_INPUT_BUDGET_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED"` result consumed by `deploymentMember(cachedSecond, "api").diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED",
      ),
      false,
    );
    assert.equal(
      deploymentMember(overflow, "api").diagnostics.some(
        /**
        * Evaluates predicate String(diagnostic) equals "APP_LOCAL_INPUT_BUDGET_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED"` result consumed by `deploymentMember(overflow, "api").diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_BUDGET_EXCEEDED",
      ),
      true,
    );
    assert.equal(deploymentMember(overflow, "api").status, "incomplete");
  });
});

test("an evicted descriptor payload cannot silently mix a later input snapshot",
  /**
 * Verifies the callback behavior for “an evicted descriptor payload cannot silently mix a later input snapshot”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `join`, `mkdir`, `stringify`, `bindingManifest`, `inventorySnapshot`, `all`, `writeFile`, `ceil`, `from`.
 * Outputs: A promise that resolves only after 8 fail, 5 equal assertion groups establish “an evicted descriptor payload cannot silently mix a later input snapshot”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “an evicted descriptor payload cannot silently mix a later input snapshot”.
 * Inputs: Receives `fixture` from its caller. It invokes `join`, `mkdir`, `stringify`, `bindingManifest`, `inventorySnapshot`, `all`, `writeFile`, `ceil`, `from`, `padStart`.
 * Outputs: A promise that resolves only after 8 fail, 5 equal assertion groups establish “an evicted descriptor payload cannot silently mix a later input snapshot”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
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
    const fillers = Array.from({ length: fillerCount },
      /**
       * Builds one descriptor-cache filler deployment with unique binding and inventory document paths.
       *
       * Inputs: The unused Array.from value and filler index.
       * Outputs: A zero-padded `descriptor-filler-<index>` API deployment using that filler pair and the shared scope.
       * Does not handle: Writing the filler files, invoking cache reads, or reconciling the deployment.
       * Side effects: Allocates one nested deployment fixture object.
       */
      (_, index) => ({
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
        /**
         * Writes one pair of descriptor-filler provisioning documents for the current batch offset.
         *
         * Inputs: `_`, `localIndex`.
         * Outputs: the `{ const index = offset + localIndex; await Promise.all([ writeFile(join(inputRoot, "filler-" + String(index) + "-bindings.json"), bindingsText, "utf8"), writeFile(join(inputRoot, "filler-" +` result consumed by `Array.from`.
         * Does not handle: Updating the workspace manifest, scanning input files, or writing another batch index.
         * Side effects: Starts two asynchronous JSON writes for this filler's bindings and inventory files.
         */
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
          /**
          * Evaluates predicate String(diagnostic) equals "APP_LOCAL_INPUT_SNAPSHOT_CHANGED".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `String(diagnostic) === "APP_LOCAL_INPUT_SNAPSHOT_CHANGED"` result consumed by `analysis.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => String(diagnostic) === "APP_LOCAL_INPUT_SNAPSHOT_CHANGED",
        ),
        true,
      );
      assert.equal(analysis.result.records.some(
        /**
        * Evaluates predicate record_coverage equals "complete".
        *
        * Inputs: `record`.
        * Outputs: the `record.coverage === "complete"` result consumed by `analysis.result.records.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (record) => record.coverage === "complete"), false);
      assert.equal(JSON.stringify(analysis).includes(fixture.root), false);
      assert.equal(JSON.stringify(analysis).includes(mutationMarker), false);
    }
  });
});

test("coverage-gap fanout is budgeted without retaining a partial member gap graph",
  /**
 * Verifies the callback behavior for “coverage-gap fanout is budgeted without retaining a partial member gap graph”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `from`, `String`, `all`, `map`, `join`, `mkdir`, `writeFile`, `repeat`, `stringify`.
 * Outputs: A promise that resolves only after 1 fail, 4 equal assertion groups establish “coverage-gap fanout is budgeted without retaining a partial member gap graph”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “coverage-gap fanout is budgeted without retaining a partial member gap graph”.
 * Inputs: Receives `fixture` from its caller. It invokes `from`, `String`, `all`, `map`, `join`, `mkdir`, `writeFile`, `repeat`, `stringify`, `bindingManifest`.
 * Outputs: A promise that resolves only after 1 fail, 4 equal assertion groups establish “coverage-gap fanout is budgeted without retaining a partial member gap graph”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Mutates only test-controlled state through `mkdir`, `writeFile`; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const repositoryIds = Array.from({ length: 100 },
      /**
      * Builds fixture value "gap-" + String(index).
      *
      * Inputs: `_`, `index`.
      * Outputs: the `"gap-" + String(index)` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      (_, index) => "gap-" + String(index));
    await Promise.all(repositoryIds.map(
      /**
       * Creates one repository source tree that contains the coverage-gap environment read.
       *
       * Inputs: `id`.
       * Outputs: the `{ const sourceRoot = join(fixture.root, id, "src"); await mkdir(sourceRoot, { recursive: true }); await writeFile(join(sourceRoot, "index.ts"), "export const value = process.env.GAP_FANOUT_K` result consumed by `repositoryIds.map`.
       * Does not handle: Declaring the deployment, writing provisioning data, or creating other repository source trees.
       * Side effects: Recursively creates the source directory and writes its TypeScript fixture file.
       */
      async (id) => {
      const sourceRoot = join(fixture.root, id, "src");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, "index.ts"), "export const value = process.env.GAP_FANOUT_KEY;\n", "utf8");
    }));
    const inputRoot = join(fixture.infraRoot, "coverage-fanout");
    await mkdir(inputRoot, { recursive: true });
    const malformedCandidates = Array.from({ length: 1_001 },
      /**
      * Builds fixture value ({ invalid: "x"_repeat(5_000), }).
      *
      * Inputs: no arguments.
      * Outputs: the `({ invalid: "x".repeat(5_000), })` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
       */
      () => ({
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
    const memberScopes = repositoryIds.map(
      /**
      * Extracts ({ repositoryId, scope: { id: "coverage-" + repositoryId, componentId: "coverage-" + repositoryId, phase: "runtime", stage: { kind: "all" }, channel: "environment", }, }) for the enclosing assertion.
      *
      * Inputs: `repositoryId`.
      * Outputs: the `({ repositoryId, scope: { id: "coverage-" + repositoryId, componentId: "coverage-" + repositoryId, phase: "runtime", stage: { kind: "all" }, channel: "environment", }, })` result consumed by `repositoryIds.map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
       */
      (repositoryId) => ({
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
      repositories: repositoryIds.map(
        /**
        * Extracts ({ id, root: "__/" + id }) for the enclosing assertion.
        *
        * Inputs: `id`.
        * Outputs: the `({ id, root: "../" + id })` result consumed by `repositoryIds.map`.
         * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
         * Side effects: Reads the current callback input and returns its projected in-memory value.
         */
        (id) => ({ id, root: "../" + id })),
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
        /**
        * Evaluates predicate String(diagnostic) equals "WORKSPACE_DEPLOYMENT_COVERAGE_GAP_FANOUT_EXCEEDED".
        *
        * Inputs: `diagnostic`.
        * Outputs: the `String(diagnostic) === "WORKSPACE_DEPLOYMENT_COVERAGE_GAP_FANOUT_EXCEEDED"` result consumed by `fanout.diagnostics.some`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_COVERAGE_GAP_FANOUT_EXCEEDED",
      ),
      true,
    );
    for (const member of fanout.members) {
      assert.equal(member.status, "incomplete");
      assert.equal(
        member.diagnostics.some(
          /**
          * Evaluates predicate String(diagnostic) equals "WORKSPACE_MEMBER_COVERAGE_GAP_FANOUT_EXCEEDED".
          *
          * Inputs: `diagnostic`.
          * Outputs: the `String(diagnostic) === "WORKSPACE_MEMBER_COVERAGE_GAP_FANOUT_EXCEEDED"` result consumed by `member.diagnostics.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (diagnostic) => String(diagnostic) === "WORKSPACE_MEMBER_COVERAGE_GAP_FANOUT_EXCEEDED",
        ),
        true,
      );
      assert.equal(
        member.reconciliation.records.some(
          /**
          * Evaluates predicate record_coverage equals "complete".
          *
          * Inputs: `record`.
          * Outputs: the `record.coverage === "complete"` result consumed by `member.reconciliation.records.some`.
           * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
           * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
           */
          (record) => record.coverage === "complete"),
        false,
      );
    }
  });
});

test("runtime deployment attestations bind sources and reject hostile capabilities",
  /**
 * Verifies the callback behavior for “runtime deployment attestations bind sources and reject hostile capabilities”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `beginVerifiedWorkspaceInvocation`, `attestVerifiedWorkspaceRepositoryMembers`, `notEqual`, `issuedWorkspaceRepositoryMember`, `scanAttestedLocalWorkspaceMember`, `attestDeploymentInputSnapshot`, `includes`.
 * Outputs: A promise that resolves only after 11 fail, 12 notEqual, 12 equal, 7 throws, 8 rejects, 3 deepEqual, 1 doesNotReject assertion groups establish “runtime deployment attestations bind sources and reject hostile capabilities”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
     * Exercises “runtime deployment attestations bind sources and reject hostile capabilities” through the `withWorkspaceFixture` callback and invokes `readLocalWorkspaceManifest`, `fail`, `beginVerifiedWorkspaceInvocation`, `attestVerifiedWorkspaceRepositoryMembers`, `notEqual`.
     *
     * Inputs: Receives `fixture` from the `withWorkspaceFixture` callback.
     * Outputs: Throws the deliberate test error or completes as consumed by the `withWorkspaceFixture` callback.
     * Does not handle: It does not create, dispose, or retain the temporary fixture; withWorkspaceFixture owns that lifecycle while this callback uses only its issued paths and test-local assertions.
     * Side effects: Throws the deliberate sentinel or propagates the error expressed in its body.
     */
    async (fixture) => {
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
    const fixedFailure =
      /**
       * Recognizes materialization failure without exposing the hostile capability sentinel.
       *
       * Inputs: The `error` rejected by attestation preparation or reconciliation in this scenario.
       * Outputs: True only for the fixed materialization message whose text omits the proxy sentinel.
       * Does not handle: Invoking the rejected operation, altering a capability, or recovering the error.
       * Side effects: Reads the error message and performs a string containment check.
       */
      (error: unknown): boolean =>
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
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `prepareIssuedLocalDeploymentReconciliation(standaloneAttestation, attestationPreflight)`.
       */
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
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `prepareIssuedLocalDeploymentReconciliation(attestation, standalonePreflight)`.
       */
      () => prepareIssuedLocalDeploymentReconciliation(attestation, standalonePreflight),
      fixedFailure,
    );
    registerDeploymentAttestation(attestation);
    registerDeploymentAttestation(workerAttestation);
    const trapSentinel = "capability-proxy-sentinel";
    const hostileTraps: ProxyHandler<object> = {
      /**
       * Implements the hostile proxy's property-read trap for capability materialization.
       *
       * Inputs: Proxy property access supplies target, property key, and receiver; this trap ignores them.
       * Outputs: Never returns: it throws the capability-proxy sentinel.
       * Does not handle: It neither resolves a capability value nor selects when access occurs; the materializer's attempted property read is the only trigger under test.
       * Side effects: Throws the deliberate sentinel error.
       */
      get() {
        throw new Error(trapSentinel);
      },
      /**
       * Implements the hostile proxy's descriptor-read trap for capability materialization.
       *
       * Inputs: Reflective descriptor lookup supplies target and property key; this trap ignores them.
       * Outputs: Never returns: it throws the capability-proxy sentinel.
       * Does not handle: It neither resolves a descriptor nor controls the surrounding assertion; only hostile descriptor access is represented.
       * Side effects: Throws the deliberate sentinel error.
       */
      getOwnPropertyDescriptor() {
        throw new Error(trapSentinel);
      },
      /**
       * Implements the hostile proxy's key-enumeration trap for capability materialization.
       *
       * Inputs: Reflective enumeration supplies the proxy target; this trap ignores it.
       * Outputs: Never returns: it throws the capability-proxy sentinel.
       * Does not handle: It neither enumerates keys nor controls the surrounding assertion; only hostile enumeration access is represented.
       * Side effects: Throws the deliberate sentinel error.
       */
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
    assert.throws(
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `{ publicReference.requested = new Proxy(Object.create(null), hostileTraps); }`.
       */
      () => {
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
        /**
         * Triggers the expected assertion failure.
         *
         * Inputs: no arguments.
         * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
         * Does not handle: decide whether the captured failure matches the assertion.
         * Side effects: executes `prepareIssuedLocalDeploymentReconciliation(hostile, attestationPreflight)`.
         */
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
    assert.throws(
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `{ candidate.destination = new Proxy(Object.create(null), hostileTraps); }`.
       */
      () => {
      candidate.destination = new Proxy(Object.create(null), hostileTraps);
    });
    const repeated = await reconcilePreparedLocalDeploymentMember(rewrittenPrepared, rewrittenHandle);
    assert.equal(JSON.stringify(repeated), JSON.stringify(rewritten));

    const analysisModule = await import("../src/app/analysis.js");
    assert.equal("issueLocalDeploymentPreparation" in analysisModule, false);
    assert.throws(
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `prepareIssuedLocalDeploymentReconciliation(rawDocumentProxy, attestationPreflight)`.
       */
      () => prepareIssuedLocalDeploymentReconciliation(rawDocumentProxy, attestationPreflight),
      fixedFailure,
    );
    assert.throws(
      /**
       * Triggers the expected assertion failure.
       *
       * Inputs: no arguments.
       * Outputs: the operation result if it unexpectedly succeeds; the assertion receives any failure.
       * Does not handle: decide whether the captured failure matches the assertion.
       * Side effects: executes `prepareIssuedLocalDeploymentReconciliation(rawMemberArrayProxy, attestationPreflight)`.
       */
      () => prepareIssuedLocalDeploymentReconciliation(rawMemberArrayProxy, attestationPreflight),
      fixedFailure,
    );
    await assert.rejects(
      reconcileLocalRoot(fixture.repositoryRoots.api, rawDocumentProxy as never),
      fixedFailure,
    );
  });
});

/**
 * Builds a closed provisioning-model document for the single-repository runtime fixture.
 *
 * Inputs: no arguments.
 * Outputs: A closed production runtime scope that names expected adapter inputs and inventory authority.
 * Does not handle: Parsing, file I/O, or evaluation of permitted exclusions.
 * Side effects: Allocates a nested in-memory closed-model document.
 */
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

/**
 * Builds a closed provisioning-model document with separate production scopes for API and worker.
 *
 * Inputs: no arguments.
 * Outputs: A closed-model document whose two scopes share the fixture provisioning inputs.
 * Does not handle: Parsing, filesystem reads, or source-demand analysis.
 * Side effects: Maps repository IDs to in-memory scope declarations.
 */
function closedModelDocumentForSharedWorkspaceRuntime(): object {
  return {
    schemaVersion: "closed-provisioning-model/v1",
    inputId: "shared-closed-model-input",
    maxFiniteKeyDomain: 8,
    scopes: ["api", "worker"].map(
      /**
       * Creates the closed-model record for one production member of the shared API/worker deployment.
       *
       * Inputs: The member repository ID.
       * Outputs: Its production scope, approved first-party root, expected binding input, inventory authority, and empty exemption/mechanism lists.
       * Does not handle: Reading the closed-model file, validating the model, or sharing data with the other member record.
       * Side effects: Calls `productionMemberExecutionScope` and allocates nested model configuration objects.
       */
      (repositoryId) => ({
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

/**
 * Writes bindings and inventory JSON fixtures for one deployment beneath the fixture infrastructure root.
 *
 * Inputs: `fixture`, `deploymentId`, `bindings`, `inventory`.
 * Outputs: A promise fulfilled after both provisioning documents are persisted.
 * Does not handle: Creating parent directories, validating adapter schemas, or scanning the deployment.
 * Side effects: Serializes and writes two test-owned JSON files concurrently.
 */
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

/**
 * Wraps fixture binding candidates in the adapter input shape expected by the provisioning adapter.
 *
 * Inputs: `candidates`.
 * Outputs: A v1 binding-manifest object retaining the supplied candidates.
 * Does not handle: Candidate validation, file serialization, or provider resolution.
 * Side effects: Allocates an in-memory manifest wrapper.
 */
function bindingManifest(candidates: readonly object[]): object {
  return {
    schemaVersion: "binding-manifest/v1",
    inputId: "shared-production-bindings",
    adapterId: "fixture",
    candidates,
  };
}

/**
 * Wraps fixture inventory items in the snapshot shape consumed by the inventory adapter.
 *
 * Inputs: `items`.
 * Outputs: A v1 inventory snapshot retaining the supplied items under the fixture authority.
 * Does not handle: Inventory validation, timestamp generation, or file serialization.
 * Side effects: Allocates an in-memory snapshot wrapper.
 */
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

/**
 * Builds one fixture binding candidate with provider identity, applicability, scope, and precedence.
 *
 * Inputs: `repositoryId`, `resourceId`, `authorityId`, `scope`, `resolution`, `appliesWhenStage`, `idSuffix`, `precedenceRank`.
 * Outputs: A binding candidate whose destination is `env:DATABASE_URL` and whose defaults model fixture provenance.
 * Does not handle: Resolving provider resources, validating scope overlap, or writing adapter input.
 * Side effects: Allocates an in-memory candidate and nested applicability metadata.
 */
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

/**
 * Builds one scoped fixture inventory item with a canonical provider resource identity.
 *
 * Inputs: `repositoryId`, `resourceId`, `authorityId`, `scope`.
 * Outputs: An inventory item with one declared execution scope.
 * Does not handle: Inventory snapshot wrapping, scope validation, or provider access.
 * Side effects: Allocates an in-memory provider-resource and scope wrapper.
 */
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

/**
 * Builds one fixture inventory item that intentionally omits declared scopes.
 *
 * Inputs: `resourceId`, `authorityId`.
 * Outputs: An inventory item containing only its canonical provider resource identity.
 * Does not handle: Attaching scopes, validating inventory, or calling a provider.
 * Side effects: Allocates an in-memory inventory item.
 */
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

/**
 * Builds a runtime/environment execution scope for one fixture repository member.
 *
 * Inputs: `repositoryId`, `executionScopeId`, `stage`.
 * Outputs: The requested scope ID/component/stage tuple, defaulting to all stages.
 * Does not handle: Scope validation, stage copying, or source scanning.
 * Side effects: Allocates one in-memory scope object.
 */
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

/**
 * Builds an exact-production specialization of the fixture member execution scope.
 *
 * Inputs: `repositoryId`.
 * Outputs: A runtime/environment scope restricted to the `production` stage.
 * Does not handle: Stage validation, provider access, or closed-model construction.
 * Side effects: Calls `memberExecutionScope` and allocates its return object.
 */
function productionMemberExecutionScope(repositoryId: string): FixtureExecutionScope {
  return memberExecutionScope(repositoryId, repositoryId, {
    kind: "exact",
    values: ["production"],
  });
}

/**
 * Builds a deployment fixture whose API member has an explicit runtime execution scope.
 *
 * Inputs: `deploymentId`.
 * Outputs: A v2 deployment declaration with fixture-relative bindings and inventory paths.
 * Does not handle: Writing provisioning files, validating the manifest, or scanning the member.
 * Side effects: Calls `memberExecutionScope` and allocates nested declaration objects.
 */
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
