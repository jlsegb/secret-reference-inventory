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
 * Outputs: A promise for the complete workspace scan result.
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
 * Outputs: An issued preparation token after input attestation, or `undefined` when member issuance fails.
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
    * Tests the current candidate against the requested condition.
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
    * Tests the current candidate against the requested condition.
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
    * Tests the current candidate against the requested condition.
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
    * Accumulates facts for the current record.
    *
    * Inputs: `total`, `record`.
    * Outputs: the next accumulator value `{ const reasons = record.reasons.reduce( (reasonTotal, reason) => reasonTotal + 1 + (reason.gapIds?.length ?? 0) + (reason.candidateIds?.length ?? 0), 0, ); const references = record.kind ==`.
     * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
     * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
     */
    (total, record) => {
    const reasons = record.reasons.reduce(
      /**
      * Accumulates facts for the current reason.
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
    * Accumulates facts for the current coverage.
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
    * Accumulates facts for the current entry.
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
      * Accumulates facts for the current reference.
      *
      * Inputs: `total`, `reference`.
      * Outputs: the next accumulator value `total + referenceGraphFacts(reference)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, reference) => total + referenceGraphFacts(reference), 0) +
    entry.demandEdges.reduce(
      /**
      * Accumulates facts for the current edge.
      *
      * Inputs: `total`, `edge`.
      * Outputs: the next accumulator value `total + demandEdgeGraphFacts(edge)`.
       * Does not handle: Controlling collection traversal, iteration order, or mutation of the source facts.
       * Side effects: Computes an in-memory total from callback inputs without mutating records or performing I/O.
       */
      (total, edge) => total + demandEdgeGraphFacts(edge), 0) +
    entry.dynamicLookupEdges.reduce(
      /**
      * Accumulates facts for the current edge.
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
    * Accumulates facts for the current deployment.
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
      * Accumulates facts for the current member.
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
      * Accumulates facts for the current repository.
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
    * Tests the current repository against the requested condition.
    *
    * Inputs: `repository`.
    * Outputs: the `repository.status === "invalid"` result consumed by `result.repositories.every`.
     * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
     * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
     */
    (repository) => repository.status === "invalid"), true);
  assert.equal(result.deployments.every(
    /**
    * Tests the current deployment against the requested condition.
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
   * Exercises the “workspace runtime scans an approved sibling repository through a canonical manifest base” scenario through `withWorkspaceFixture`, `scanFixture`, `repository`, `equal`, `some`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime scans an approved sibling repository through a canonical manifest base”.
   * Outputs: Normal completion only after the “workspace runtime scans an approved sibling repository through a canonical manifest base” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Runs assertions through `withWorkspaceFixture`, `scanFixture`, `repository`, `equal`, `some`; assertion failures escape.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime scans an approved sibling repository through a canonical manifest base”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `scanFixture`, `repository`, `assert.equal`, `api?.reconciliation.records.some`, `JSON.stringify(result).includes`, `JSON.stringify`.
     */
    async (fixture) => {
    const result = await scanFixture(fixture);
    const api = repository(result, "api");

    assert.equal(api?.status, "complete");
    assert.equal(
      api?.reconciliation.records.some(
        /**
        * Tests the current record against the requested condition.
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
   * Exercises the “duplicate keys aggregate only within an explicit shared deployment” scenario through `withWorkspaceFixture`, `scanFixture`, `deployment`, `deepEqual`, `writeFixtureLayout`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “duplicate keys aggregate only within an explicit shared deployment”.
   * Outputs: Normal completion only after the “duplicate keys aggregate only within an explicit shared deployment” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Runs assertions through `withWorkspaceFixture`, `scanFixture`, `deployment`, `deepEqual`, `writeFixtureLayout`; assertion failures escape.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “duplicate keys aggregate only within an explicit shared deployment”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `scanFixture`, `deployment`, `assert.deepEqual`, `writeFixtureLayout`, `assert.equal`, `repository`.
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
   * Exercises the “workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text” scenario through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `defineProperty`, `revocable`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text”.
   * Outputs: Normal completion only after the “workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Throws the deliberate test value or propagates the error expressed in its body.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Exercises “workspace runtime rejects forged, cloned, and mixed requests without reflecting trap text” through the `withWorkspaceFixture` callback and invokes `readLocalWorkspaceManifest`, `fail`, `defineProperty`, `revocable`, `revoke`.
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
   * Exercises the “workspace runtime rejects a request after its verified manifest file is replaced” scenario through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `rename`, `join`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime rejects a request after its verified manifest file is replaced”.
   * Outputs: Normal completion only after the “workspace runtime rejects a request after its verified manifest file is replaced” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `rename`, `join`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime rejects a request after its verified manifest file is replaced”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `readLocalWorkspaceManifest`, `assert.fail`, `rename`, `join`, `writeFile`, `assertInvalidManifestProvenance`, including the fixture filesystem changes.
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
   * Exercises the “workspace runtime rejects a request after its manifest path is replaced by a symlink” scenario through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `join`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime rejects a request after its manifest path is replaced by a symlink”.
   * Outputs: Normal completion only after the “workspace runtime rejects a request after its manifest path is replaced by a symlink” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `join`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime rejects a request after its manifest path is replaced by a symlink”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `readLocalWorkspaceManifest`, `assert.fail`, `join`, `writeFile`, `rm`, `symlink`.
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
   * Exercises the “workspace runtime rejects a request after its verified canonical base is replaced” scenario through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `rename`, `join`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime rejects a request after its verified canonical base is replaced”.
   * Outputs: Normal completion only after the “workspace runtime rejects a request after its verified canonical base is replaced” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `rename`, `join`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime rejects a request after its verified canonical base is replaced”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `readLocalWorkspaceManifest`, `assert.fail`, `rename`, `join`, `mkdir`, `writeFile`, including the fixture filesystem changes.
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
   * Exercises the “workspace runtime rejects equal and nested canonical root aliases before scanning” scenario through `withWorkspaceFixture`, `symlink`, `join`, `writeFile`, `stringify`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime rejects equal and nested canonical root aliases before scanning”.
   * Outputs: Normal completion only after the “workspace runtime rejects equal and nested canonical root aliases before scanning” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `symlink`, `join`, `writeFile`, `stringify`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime rejects equal and nested canonical root aliases before scanning”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `symlink`, `join`, `writeFile`, `JSON.stringify`, `readLocalWorkspaceManifest`, `assert.fail`.
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
        * Projects a report value from the current repository.
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
        * Tests the current repository against the requested condition.
        *
        * Inputs: `repository`.
        * Outputs: the `repository.diagnostics.some( (diagnostic) => diagnostic === "WORKSPACE_REPOSITORY_ROOT_CONFLICT", )` result consumed by `result.repositories.every`.
         * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
         * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
         */
        (repository) =>
        repository.diagnostics.some(
          /**
          * Tests the current diagnostic against the requested condition.
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
   * Exercises the “canonical root indexing retains ancestor conflicts across prefix-like siblings” scenario through `withWorkspaceFixture`, `join`, `all`, `mkdir`, `symlink`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “canonical root indexing retains ancestor conflicts across prefix-like siblings”.
   * Outputs: Normal completion only after the “canonical root indexing retains ancestor conflicts across prefix-like siblings” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `all`, `mkdir`, `symlink`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “canonical root indexing retains ancestor conflicts across prefix-like siblings”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `join`, `Promise.all`, `mkdir`, `symlink`, `writeFile`, `JSON.stringify`.
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
        * Projects a report value from the current repository.
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
   * Exercises the “request member attestation indexes 10,000 resolved roots without pairwise conflict scans” scenario through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “request member attestation indexes 10,000 resolved roots without pairwise conflict scans”.
   * Outputs: Normal completion only after the “request member attestation indexes 10,000 resolved roots without pairwise conflict scans” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “request member attestation indexes 10,000 resolved roots without pairwise conflict scans”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Promise.all`, `ids.slice(start, start + 128).map`, `ids.slice`, `writeFile`, `JSON.stringify`.
     */
    async (fixture) => {
    const count = 10_000;
    const ids = Array.from({ length: count },
      /**
      * Constructs one generated fixture element.
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
        * Projects a report value from the current id.
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
   * Exercises the “invocation indexes 10,000 deployment declarations without repeated manifest search” scenario through `withWorkspaceFixture`, `from`, `padStart`, `String`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “invocation indexes 10,000 deployment declarations without repeated manifest search”.
   * Outputs: Normal completion only after the “invocation indexes 10,000 deployment declarations without repeated manifest search” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `padStart`, `String`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “invocation indexes 10,000 deployment declarations without repeated manifest search”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `writeFile`, `JSON.stringify`, `deploymentIds.map`, `readLocalWorkspaceManifest`, `assert.fail`, including the fixture filesystem changes.
     */
    async (fixture) => {
    const count = 10_000;
    const deploymentIds = Array.from(
      { length: count },
      /**
      * Constructs one generated fixture element.
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
        * Projects a report value from the current id.
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
   * Exercises the “workspace shared keys require direct demand rather than finite dynamic possibilities” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `writeFixtureLayout`, `scanFixture`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace shared keys require direct demand rather than finite dynamic possibilities”.
   * Outputs: Normal completion only after the “workspace shared keys require direct demand rather than finite dynamic possibilities” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `writeFixtureLayout`, `scanFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace shared keys require direct demand rather than finite dynamic possibilities”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `[ "declare const enabled: boolean;", 'const choice = enabled ? "DATABASE_URL" : `, `writeFixtureLayout`, `scanFixture`, `deployment`, including the fixture filesystem changes.
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
   * Exercises the “one repository's parser uncertainty stays scoped to that repository and deployment” scenario through `withWorkspaceFixture`, `scanFixture`, `equal`, `repository`, `deployment`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “one repository's parser uncertainty stays scoped to that repository and deployment”.
   * Outputs: Normal completion only after the “one repository's parser uncertainty stays scoped to that repository and deployment” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Runs assertions through `withWorkspaceFixture`, `scanFixture`, `equal`, `repository`, `deployment`; assertion failures escape.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “one repository's parser uncertainty stays scoped to that repository and deployment”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `scanFixture`, `assert.equal`, `repository`, `deployment`, `assert.deepEqual`.
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
   * Exercises the “a malformed deployment input is scoped to its deployment, not its code repository” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `scanFixture`, `repository`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “a malformed deployment input is scoped to its deployment, not its code repository”.
   * Outputs: Normal completion only after the “a malformed deployment input is scoped to its deployment, not its code repository” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `scanFixture`, `repository`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a malformed deployment input is scoped to its deployment, not its code repository”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `scanFixture`, `repository`, `deployment`, `assert.equal`, including the fixture filesystem changes.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current coverage against the requested condition.
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
   * Exercises the “an oversized provisioning document is scoped incomplete and cannot support absence” scenario through `withWorkspaceFixture`, `fill`, `writeFile`, `join`, `stringify`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “an oversized provisioning document is scoped incomplete and cannot support absence”.
   * Outputs: Normal completion only after the “an oversized provisioning document is scoped incomplete and cannot support absence” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `fill`, `writeFile`, `join`, `stringify`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “an oversized provisioning document is scoped incomplete and cannot support absence”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `new Array<unknown>(100_001).fill`, `Array`, `writeFile`, `join`, `JSON.stringify`, `scanFixture`, including the fixture filesystem changes.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current coverage against the requested condition.
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
   * Exercises the “unscoped inventory without a member-scoped provider binding stays unattributed” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `stringify`, `scanFixture`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “unscoped inventory without a member-scoped provider binding stays unattributed”.
   * Outputs: Normal completion only after the “unscoped inventory without a member-scoped provider binding stays unattributed” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `stringify`, `scanFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “unscoped inventory without a member-scoped provider binding stays unattributed”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `JSON.stringify`, `scanFixture`, `repository`, `deployment`, including the fixture filesystem changes.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “workspace deployment closed-model verification uses the captured manifest base after chdir” scenario through `withWorkspaceFixture`, `join`, `mkdir`, `writeFile`, `stringify`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace deployment closed-model verification uses the captured manifest base after chdir”.
   * Outputs: Normal completion only after the “workspace deployment closed-model verification uses the captured manifest base after chdir” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `mkdir`, `writeFile`, `stringify`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace deployment closed-model verification uses the captured manifest base after chdir”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `join`, `mkdir`, `writeFile`, `JSON.stringify`, `closedModelDocumentForWorkspaceRuntime`, `readLocalWorkspaceManifest`.
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
          * Tests the current diagnostic against the requested condition.
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
   * Exercises the “multi-member closed provisioning remains independently verifiable after chdir” scenario through `withWorkspaceFixture`, `writeFixtureLayout`, `join`, `mkdir`, `writeDeploymentProvisioning`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “multi-member closed provisioning remains independently verifiable after chdir”.
   * Outputs: Normal completion only after the “multi-member closed provisioning remains independently verifiable after chdir” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFixtureLayout`, `join`, `mkdir`, `writeDeploymentProvisioning`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “multi-member closed provisioning remains independently verifiable after chdir”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `join`, `mkdir`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`.
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
        * Projects a report value from the current member.
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
            * Tests the current diagnostic against the requested condition.
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
            * Tests the current diagnostic against the requested condition.
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
            * Tests the current record against the requested condition.
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
            * Tests the current diagnostic against the requested condition.
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
            * Tests the current record against the requested condition.
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
   * Exercises the “multi-repository deployment keeps exact provisioning in independent repository-qualified partitions” scenario through `withWorkspaceFixture`, `writeFixtureLayout`, `memberExecutionScope`, `writeFile`, `stringify`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “multi-repository deployment keeps exact provisioning in independent repository-qualified partitions”.
   * Outputs: Normal completion only after the “multi-repository deployment keeps exact provisioning in independent repository-qualified partitions” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFixtureLayout`, `memberExecutionScope`, `writeFile`, `stringify`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “multi-repository deployment keeps exact provisioning in independent repository-qualified partitions”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `memberExecutionScope`, `writeFile`, `JSON.stringify`, `writeDeploymentProvisioning`, `bindingManifest`.
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
      * Projects a report value from the current member.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Verifies “an explicitly shared provider resource remains bound in each exact member partition”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “an explicitly shared provider resource remains bound in each exact member partition”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `memberExecutionScope`.
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
          * Tests the current record against the requested condition.
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
          * Tests the current diagnostic against the requested condition.
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
   * Verifies “contradictory inventory ownership makes only listed member partitions inconclusive”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “contradictory inventory ownership makes only listed member partitions inconclusive”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `memberExecutionScope`.
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
          * Tests the current diagnostic against the requested condition.
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
          * Tests the current record against the requested condition.
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
          * Tests the current record against the requested condition.
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
   * Verifies “a dynamic binding candidate cannot make unscoped inventory shared across members”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a dynamic binding candidate cannot make unscoped inventory shared across members”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `unscopedInventoryItem`.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Verifies “a dynamic binding competitor prevents an exact candidate from proving a bound member relation”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a dynamic binding competitor prevents an exact candidate from proving a bound member relation”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `unscopedInventoryItem`.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Verifies “an unknown binding scope makes only its potentially affected member inconclusive”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “an unknown binding scope makes only its potentially affected member inconclusive”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `inventoryItem`.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Verifies “a partial binding selector cannot turn unscoped inventory into an exact member binding”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a partial binding selector cannot turn unscoped inventory into an exact member binding”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `unscopedInventoryItem`.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current diagnostic against the requested condition.
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
   * Verifies “a shadowed binding cannot claim an otherwise unscoped inventory item”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a shadowed binding cannot claim an otherwise unscoped inventory item”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `unscopedInventoryItem`.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Verifies “mismatched inventory authority cannot become a cross-member bound relation”.
   *
  * Inputs: no arguments.
  * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
  * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “mismatched inventory authority cannot become a cross-member bound relation”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `inventoryItem`.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Exercises the “a broken deployment member does not erase an independently reconciled sibling” scenario through `withWorkspaceFixture`, `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “a broken deployment member does not erase an independently reconciled sibling”.
   * Outputs: Normal completion only after the “a broken deployment member does not erase an independently reconciled sibling” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “a broken deployment member does not erase an independently reconciled sibling”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFixtureLayout`, `writeDeploymentProvisioning`, `bindingManifest`, `bindingCandidate`, `inventorySnapshot`, `inventoryItem`.
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
        * Tests the current record against the requested condition.
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
   * Exercises the “an unresolved deployment root does not erase a valid sibling partition” scenario through `withWorkspaceFixture`, `join`, `mkdir`, `all`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “an unresolved deployment root does not erase a valid sibling partition”.
   * Outputs: Normal completion only after the “an unresolved deployment root does not erase a valid sibling partition” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `mkdir`, `all`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “an unresolved deployment root does not erase a valid sibling partition”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `join`, `mkdir`, `Promise.all`, `writeFile`, `JSON.stringify`, `bindingManifest`, including the fixture filesystem changes.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “one repository can participate in separate deployments without provisioning or source-snapshot merge” scenario through `withWorkspaceFixture`, `all`, `mkdir`, `join`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “one repository can participate in separate deployments without provisioning or source-snapshot merge”.
   * Outputs: Normal completion only after the “one repository can participate in separate deployments without provisioning or source-snapshot merge” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `all`, `mkdir`, `join`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “one repository can participate in separate deployments without provisioning or source-snapshot merge”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Promise.all`, `mkdir`, `join`, `writeFile`, `JSON.stringify`, `deploymentWithMemberScope`, including the fixture filesystem changes.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Exercises the “workspace runtime exposes the exact narrow N5 port shape” scenario through `createLocalWorkspaceScanPort`, `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `scan`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace runtime exposes the exact narrow N5 port shape”.
   * Outputs: Normal completion only after the “workspace runtime exposes the exact narrow N5 port shape” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Runs assertions through `createLocalWorkspaceScanPort`, `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `scan`; assertion failures escape.
   */
  async () => {
  const port: WorkspaceScanPort<WorkspaceScanReportSource> = createLocalWorkspaceScanPort();
  await withWorkspaceFixture(
    /**
     * Verifies “workspace runtime exposes the exact narrow N5 port shape”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `readLocalWorkspaceManifest`, `assert.fail`, `port.scan`, `assert.equal`.
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
   * Exercises the “runtime deployment preparation bounds broad binding and inventory fanout” scenario through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “runtime deployment preparation bounds broad binding and inventory fanout”.
   * Outputs: Normal completion only after the “runtime deployment preparation bounds broad binding and inventory fanout” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “runtime deployment preparation bounds broad binding and inventory fanout”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Promise.all`, `repositoryIds.map`, `["binding-fanout", "inventory-fanout"].map`, `writeFile`, `JSON.stringify`.
     */
    async (fixture) => {
    const memberCount = 100;
    const candidateCount = 1_001;
    const repositoryIds = Array.from({ length: memberCount },
      /**
      * Constructs one generated fixture element.
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
      * Projects a report value from the current index.
      *
      * Inputs: `repositoryId`, `index`.
      * Outputs: the `({ repositoryId, scope: { id: "fanout-runtime", componentId: "fanout-runtime", phase: "runtime", stage: { kind: "exact", values: ["fanout-stage-" + String(index)] }, channel: "environment", ` result consumed by `repositoryIds.map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
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
      * Projects a report value from the current id.
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
          * Projects a report value from the current id.
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
          * Constructs one generated fixture element.
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
          * Constructs one generated fixture element.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “runtime projection budget bounds source-rich member output deterministically” scenario through `withWorkspaceFixture`, `from`, `String`, `join`, `all`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “runtime projection budget bounds source-rich member output deterministically”.
   * Outputs: Normal completion only after the “runtime projection budget bounds source-rich member output deterministically” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `join`, `all`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “runtime projection budget bounds source-rich member output deterministically”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Array.from( { length: readsPerMember }, /** * Supplies `_`, `index` to the `from`, `Promise.all`, `repositoryIds.map`, `writeFile`, `JSON.stringify`.
     */
    async (fixture) => {
    const memberCount = 100;
    const readsPerMember = 1_001;
    const repositoryIds = Array.from(
      { length: memberCount },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
      * Projects a report value from the current repositoryId.
      *
      * Inputs: `repositoryId`.
      * Outputs: the `({ repositoryId, scope: { id: "scope-" + repositoryId, componentId: "component-" + repositoryId, phase: "runtime" as const, stage: { kind: "all" as const }, channel: "environment" as const, ` result consumed by `repositoryIds.map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
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
        * Projects a report value from the current id.
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
        * Projects a report value from the current member.
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
      * Tests the current entry against the requested condition.
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
          * Tests the current coverage against the requested condition.
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
          * Tests the current record against the requested condition.
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
        * Projects a report value from the current member.
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
   * Exercises the “repository-only admission shares the invocation graph ledger” scenario through `withWorkspaceFixture`, `from`, `String`, `join`, `all`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “repository-only admission shares the invocation graph ledger”.
   * Outputs: Normal completion only after the “repository-only admission shares the invocation graph ledger” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `join`, `all`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “repository-only admission shares the invocation graph ledger”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Array.from( { length: readsPerRepository }, /** * Supplies `_`, `index` to the ``, `Promise.all`, `repositoryIds.map`, `writeFile`, `JSON.stringify`.
     */
    async (fixture) => {
    const repositoryCount = 40;
    const readsPerRepository = 1_001;
    const repositoryIds = Array.from(
      { length: repositoryCount },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
        * Projects a report value from the current id.
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
        * Projects a report value from the current repository.
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
        * Projects a report value from the current repository.
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
   * Exercises the “nested coverage evidence is admitted before Core record materialization” scenario through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “nested coverage evidence is admitted before Core record materialization”.
   * Outputs: Normal completion only after the “nested coverage evidence is admitted before Core record materialization” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “nested coverage evidence is admitted before Core record materialization”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from( { length: demandCount }, /** * Supplies `_`, `index` to the `from` o`, `Array.from`, `writeFile`, `join`, `mkdir`, `Promise.all`.
     */
    async (fixture) => {
    const demandCount = 1_000;
    const source = Array.from(
      { length: demandCount },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
   * Exercises the “workspace projection budget does not reset for the same source in later deployments” scenario through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “workspace projection budget does not reset for the same source in later deployments”.
   * Outputs: Normal completion only after the “workspace projection budget does not reset for the same source in later deployments” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “workspace projection budget does not reset for the same source in later deployments”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from( { length: 1_001 }, /** * Supplies `_`, `index` to the `from` operati`, `Array.from`, `writeFile`, `join`, `mkdir`, `Promise.all`.
     */
    async (fixture) => {
    const deploymentCount = 51;
    const reads = Array.from(
      { length: 1_001 },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "workspace-budget-" + String(index), repositories: ["api"], inputs: { bindings: "../infra/workspace-budget-repeat/bindings.json", inventory: "../infra/workspace-budget-repeat/inventor` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
        * Tests the current entry against the requested condition.
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
          * Tests the current record against the requested condition.
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
        * Tests the current entry against the requested condition.
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
   * Exercises the “scan-only deployments share one invocation budget and reset on the next scan” scenario through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “scan-only deployments share one invocation budget and reset on the next scan”.
   * Outputs: Normal completion only after the “scan-only deployments share one invocation budget and reset on the next scan” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `from`, `String`, `writeFile`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “scan-only deployments share one invocation budget and reset on the next scan”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from( { length: 1_001 }, /** * Supplies `_`, `index` to the `from` operati`, `Array.from`, `writeFile`, `join`, `JSON.stringify`, `readLocalWorkspaceManifest`.
     */
    async (fixture) => {
    const reads = Array.from(
      { length: 1_001 },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
        * Tests the current entry against the requested condition.
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
        * Tests the current entry against the requested condition.
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
   * Exercises the “shared-key output is withheld when source graph budget is exhausted” scenario through `withWorkspaceFixture`, `join`, `from`, `String`, `all`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “shared-key output is withheld when source graph budget is exhausted”.
   * Outputs: Normal completion only after the “shared-key output is withheld when source graph budget is exhausted” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `from`, `String`, `all`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “shared-key output is withheld when source graph budget is exhausted”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: Generates 900 source reads, writes the oversized fixture source, and invokes the workspace scan.
     */
    async (fixture) => {
    const reads = Array.from(
      { length: 900 },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
      * Tests the current entry against the requested condition.
      *
      * Inputs: `entry`.
      * Outputs: the `entry.diagnostics.some( (diagnostic) => String(diagnostic) === "WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED" || String(diagnostic) === "WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED", ` result consumed by `result.deployments.filter`.
       * Does not handle: Interpreting sibling entries or mutating the result; enclosing collection logic controls iteration.
       * Side effects: Reads the supplied entry only; it does not perform I/O or mutate test state.
       */
      (entry) => entry.diagnostics.some(
      /**
      * Tests the current diagnostic against the requested condition.
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
   * Exercises the “provisioning records share the invocation graph budget before Core materializes them” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `mkdir`, `from`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “provisioning records share the invocation graph budget before Core materializes them”.
   * Outputs: Normal completion only after the “provisioning records share the invocation graph budget before Core materializes them” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `mkdir`, `from`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “provisioning records share the invocation graph budget before Core materializes them”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `mkdir`, `Array.from`, `Promise.all`, `JSON.stringify`, including the fixture filesystem changes.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "provisioning-binding-" + String(index), adapterId: "fixture", scope, destination: { namespace: "env", name: "PROVISIONING_KEY_" + String(index) }, sourceKind: "secret-manager", provi` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "provisioning-graph-" + String(index).padStart(3, "0"), repositories: ["api"], inputs: { bindings: "../infra/provisioning-graph-budget/bindings.json", inventory: "../infra/provisionin` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
      * Tests the current entry against the requested condition.
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
      * Tests the current entry against the requested condition.
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
   * Exercises the “finite condition partition floods fall back before Core selection materializes” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “finite condition partition floods fall back before Core selection materializes”.
   * Outputs: Normal completion only after the “finite condition partition floods fall back before Core selection materializes” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “finite condition partition floods fall back before Core selection materializes”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `Array.from`, `assert.ok`, `Buffer.byteLength`, `JSON.stringify`, including the fixture filesystem changes.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "c" + String(index), adapterId: "a", scope, destination: { namespace: "env", name: "F" }, sourceKind: "external", appliesWhen: { executionUnitIds: [scope.id], phases: ["runtime"], sta` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “inventory projection bounds 10k by 10k resource matches without pairwise work” scenario through `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “inventory projection bounds 10k by 10k resource matches without pairwise work”.
   * Outputs: Normal completion only after the “inventory projection bounds 10k by 10k resource matches without pairwise work” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `writeFile`, `join`, `from`, `String`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “inventory projection bounds 10k by 10k resource matches without pairwise work”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `writeFile`, `join`, `Array.from`, `assert.ok`, `Buffer.byteLength`, `JSON.stringify`, including the fixture filesystem changes.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "c" + String(index), adapterId: "a", scope, destination: { namespace: "env", name: "K" + String(index) }, sourceKind: "external", providerResourceId: { authorityId: "a", canonicalId: ` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
        * Constructs one generated fixture element.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “maximum legal deployment membership reserves compact fallback and aggregate status capacity” scenario through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “maximum legal deployment membership reserves compact fallback and aggregate status capacity”.
   * Outputs: Normal completion only after the “maximum legal deployment membership reserves compact fallback and aggregate status capacity” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “maximum legal deployment membership reserves compact fallback and aggregate status capacity”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Promise.all`, `repositoryIds.map`, `writeFile`, `JSON.stringify`, `readLocalWorkspaceManifest`, including the fixture filesystem changes.
     */
    async (fixture) => {
    const repositoryIds = Array.from({ length: 5 },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
        * Projects a report value from the current id.
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
        * Accumulates facts for the current entry.
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
      * Tests the current entry against the requested condition.
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
      * Tests the current entry against the requested condition.
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
   * Exercises the “invocation document cache reuses verified reads and caps unique input bytes before parse” scenario through `withWorkspaceFixture`, `join`, `mkdir`, `alloc`, `all`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “invocation document cache reuses verified reads and caps unique input bytes before parse”.
   * Outputs: Normal completion only after the “invocation document cache reuses verified reads and caps unique input bytes before parse” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `mkdir`, `alloc`, `all`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “invocation document cache reuses verified reads and caps unique input bytes before parse”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `join`, `mkdir`, `Buffer.alloc`, `Promise.all`, `writeFile`, `JSON.stringify`, including the fixture filesystem changes.
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
       * Verifies “invocation document cache reuses verified reads and caps unique input bytes before parse”.
       *
      * Inputs: `id`, `binding`.
      * Outputs: a promise that settles after its awaited workspace operations and assertions.
       * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
      * Side effects: runs `scope`.
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
        * Constructs one generated fixture element.
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
        * Tests the current diagnostic against the requested condition.
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
        * Tests the current diagnostic against the requested condition.
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
   * Exercises the “an evicted descriptor payload cannot silently mix a later input snapshot” scenario through `withWorkspaceFixture`, `join`, `mkdir`, `stringify`, `bindingManifest`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “an evicted descriptor payload cannot silently mix a later input snapshot”.
   * Outputs: Normal completion only after the “an evicted descriptor payload cannot silently mix a later input snapshot” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `join`, `mkdir`, `stringify`, `bindingManifest`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “an evicted descriptor payload cannot silently mix a later input snapshot”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `join`, `mkdir`, `JSON.stringify`, `bindingManifest`, `inventorySnapshot`, `Promise.all`, including the fixture filesystem changes.
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
      * Constructs one generated fixture element.
      *
      * Inputs: `_`, `index`.
      * Outputs: the `({ id: "descriptor-filler-" + String(index).padStart(4, "0"), repositories: ["api"], inputs: { bindings: "../infra/descriptor-snapshot/filler-" + String(index) + "-bindings.json", inventory:` result consumed by `Array.from`.
       * Does not handle: Inserting this value into a collection, executing a scan, or performing I/O.
       * Side effects: Produces only the current in-memory fixture value.
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
          * Tests the current diagnostic against the requested condition.
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
        * Tests the current record against the requested condition.
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
   * Exercises the “coverage-gap fanout is budgeted without retaining a partial member gap graph” scenario through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “coverage-gap fanout is budgeted without retaining a partial member gap graph”.
   * Outputs: Normal completion only after the “coverage-gap fanout is budgeted without retaining a partial member gap graph” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Creates, changes, or removes test-owned fixture files through `withWorkspaceFixture`, `from`, `String`, `all`, `map`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “coverage-gap fanout is budgeted without retaining a partial member gap graph”.
     *
    * Inputs: `fixture`.
    * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: Recovering fixture setup, runtime-operation, or assertion failures; the test runner observes them.
    * Side effects: runs `Array.from`, `Promise.all`, `repositoryIds.map`, `join`, `mkdir`, `writeFile`.
     */
    async (fixture) => {
    const repositoryIds = Array.from({ length: 100 },
      /**
      * Constructs one generated fixture element.
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
      * Constructs one generated fixture element.
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
      * Projects a report value from the current repositoryId.
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
        * Projects a report value from the current id.
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
        * Tests the current diagnostic against the requested condition.
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
          * Tests the current diagnostic against the requested condition.
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
          * Tests the current record against the requested condition.
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
   * Exercises the “runtime deployment attestations bind sources and reject hostile capabilities” scenario through `withWorkspaceFixture`, `readLocalWorkspaceManifest`, `fail`, `beginVerifiedWorkspaceInvocation`, `attestVerifiedWorkspaceRepositoryMembers`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “runtime deployment attestations bind sources and reject hostile capabilities”.
   * Outputs: Normal completion only after the “runtime deployment attestations bind sources and reject hostile capabilities” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither touches a user workspace nor retains the `withWorkspaceFixture` layout after its callback; it limits the check to the constructed fixture, named operation, and assertions.
   * Side effects: Throws the deliberate test value or propagates the error expressed in its body.
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
      * Projects a report value from the current repositoryId.
      *
      * Inputs: `repositoryId`.
      * Outputs: the `({ scope: productionMemberExecutionScope(repositoryId), declaredStages: ["production"], closed: true, approvedFirstPartyRoots: [repositoryId], bindingRoots: ["infra/shared-production/binding` result consumed by `["api", "worker"].map`.
       * Does not handle: Iterating the surrounding collection, validating sibling entries, or mutating source inputs.
       * Side effects: Reads the current callback input and returns its projected in-memory value.
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
