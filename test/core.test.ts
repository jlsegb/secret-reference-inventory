import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcile,
  resolveBindingCandidates,
  type BindingCandidate,
  type ClosedProvisioningModel,
  type CoverageGap,
  type CoverageInputStatus,
  type DemandEdge,
  type DynamicLookupEdge,
  type ExecutionScope,
  type InventorySnapshot,
  type LogicalKey,
  type SafeIdentifier,
  type SafeDiagnosticCode,
  type SafePath,
  type SafeTimestamp,
  type SecretReference,
} from "../src/core/index.js";

const id =
  /**
   * Brands a fixture-controlled identifier for Core test facts.
   *
   * Inputs: A literal fixture identifier.
   * Outputs: The same string as a SafeIdentifier.
   * Does not handle: Production identifier validation or source-derived text.
   * Side effects: None.
   */
  (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnosticCode =
  /**
   * Brands a fixed fixture diagnostic code for coverage-gap facts.
   *
   * Inputs: A literal test diagnostic code.
   * Outputs: The same string as a SafeDiagnosticCode.
   * Does not handle: Runtime code validation or report rendering.
   * Side effects: None.
   */
  (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const path =
  /**
   * Brands a fixture-relative path used only in synthetic Core facts.
   *
   * Inputs: A literal test path.
   * Outputs: The same string as a SafePath.
   * Does not handle: Filesystem access, normalization, or containment checks.
   * Side effects: None.
   */
  (value: string): SafePath => value as SafePath;
const timestamp =
  /**
   * Brands a fixed inventory observation timestamp for deterministic fixtures.
   *
   * Inputs: A literal ISO-like test timestamp.
   * Outputs: The same string as a SafeTimestamp.
   * Does not handle: Timestamp parsing, clock access, or freshness validation.
   * Side effects: None.
   */
  (value: string): SafeTimestamp => value as SafeTimestamp;

/**
 * Creates a concrete environment logical key for a Core test scenario.
 *
 * Inputs: A fixture environment-key name.
 * Outputs: An environment-namespace logical key with a branded concrete name.
 * Does not handle: Opaque keys, non-environment namespaces, or production input validation.
 * Side effects: Allocates one logical-key object.
 */
function key(name: string): LogicalKey {
  return { namespace: "env", name: id(name) };
}

/**
 * Creates a production runtime/environment execution scope for a fixture component.
 *
 * Inputs: An optional component/execution-unit fixture name.
 * Outputs: A scope with matching ID/component ID and exact production runtime environment dimensions.
 * Does not handle: Unknown stages, build channels, or distinct component/execution IDs.
 * Side effects: Allocates a scope object and stage/value arrays.
 */
function scope(name = "api"): ExecutionScope {
  return {
    id: id(name),
    componentId: id(name),
    phase: "runtime",
    stage: { kind: "exact", values: [id("production")] },
    channel: "environment",
  };
}

/**
 * Creates an unconditional selector that exactly names every fixed dimension of a fixture scope.
 *
 * Inputs: One fixture execution scope.
 * Outputs: A selector with the scope's unit, phase, stage, channel, and always condition.
 * Does not handle: Conditional, partial-stage, or wildcard selector scenarios.
 * Side effects: Allocates selector arrays and an object.
 */
function selector(target: ExecutionScope): BindingCandidate["appliesWhen"] {
  return {
    executionUnitIds: [target.id],
    phases: [target.phase],
    stage: target.stage,
    channels: [target.channel],
    condition: { kind: "always" },
  };
}

/**
 * Creates an exact comparable secret-manager binding candidate for fixture reconciliation.
 *
 * Inputs: A scope, logical destination, optional provider resource suffix, and optional precedence rank.
 * Outputs: A binding with the fixture authority, exact selector, and comparable precedence metadata.
 * Does not handle: Dynamic/external bindings, missing resources, or conflicting precedence facts.
 * Side effects: Allocates binding, resource, precedence, and selector objects.
 */
function candidate(
  target: ExecutionScope,
  destination: LogicalKey,
  resource = String(destination.name),
  rank = 1,
): BindingCandidate {
  return {
    id: id(`binding-${target.id}-${String(destination.name)}-${rank}`),
    adapterId: id("fixture"),
    scope: target,
    destination,
    sourceKind: "secret-manager",
    providerResourceId: {
      authorityId: id("authority-a"),
      canonicalId: id(resource),
    },
    appliesWhen: selector(target),
    precedence: { source: id("fixture"), rank, comparable: true },
    resolution: "exact",
  };
}

/**
 * Creates a literal direct-read server reference for a fixture environment key.
 *
 * Inputs: A key name and optional reference identifier.
 * Outputs: A high-confidence literal SecretReference with a fixed source location.
 * Does not handle: Dynamic reads, client exposure, or parser provenance variation.
 * Side effects: Allocates reference, key, location, and position objects.
 */
function reference(name: string, referenceId = `reference-${name}`): SecretReference {
  return {
    id: id(referenceId),
    requested: key(name),
    demand: "direct-read",
    operation: "read",
    resolution: "literal",
    confidence: "high",
    location: {
      file: path("src/app.ts"),
      start: { line: 1, column: 0 },
      end: { line: 1, column: 10 },
    },
    exposure: "server",
    evidenceChain: [],
  };
}

/**
 * Creates a direct demand edge from a fixture reference into a fixture execution scope.
 *
 * Inputs: A target scope and source reference identifier.
 * Outputs: A direct-origin DemandEdge with deterministic test ID.
 * Does not handle: Consumer-derived demand, evidence chains, or target inference.
 * Side effects: Allocates one demand-edge object.
 */
function demand(target: ExecutionScope, referenceId: string): DemandEdge {
  return {
    id: id(`demand-${target.id}-${referenceId}`),
    referenceId: id(referenceId),
    scope: target,
    origin: "direct",
    evidenceChain: [],
  };
}

/**
 * Projects provider-qualified fixture candidates into one authoritative inventory snapshot.
 *
 * Inputs: Any number of fixture binding candidates.
 * Outputs: An authority-A snapshot containing an item for each candidate with a provider resource.
 * Does not handle: External/missing-resource candidates, multiple authorities, or inventory metadata beyond declared scope.
 * Side effects: Allocates snapshot/items and flattening arrays.
 */
function inventory(...candidates: readonly BindingCandidate[]): InventorySnapshot {
  return {
    authorityId: id("authority-a"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: candidates.flatMap(
      /**
       * Emits one inventory item for a candidate with a provider resource and skips external candidates.
       *
       * Inputs: One fixture binding candidate.
       * Outputs: An empty array without provider identity or a single item scoped to that candidate.
       * Does not handle: Provider inventory deduplication or authorities other than the fixture authority.
       * Side effects: Allocates a one-item array and item object for provider-backed candidates.
       */
      (item) =>
        item.providerResourceId === undefined
          ? []
          : [{ providerResourceId: item.providerResourceId, declaredScopes: [item.scope] }],
    ),
  };
}

/**
 * Converts concise test-fixture fields into the full Core reconciliation input and resolves bindings first.
 *
 * Inputs: Optional fixture references, demand/dynamic/coverage/model facts plus required candidates and optional snapshots.
 * Outputs: The exact reconcile result generated from normalized empty defaults and resolved candidate partitions.
 * Does not handle: Adapter parsing, raw safety validation, or fixture input beyond the listed Core shapes.
 * Side effects: Allocates default arrays/objects and binding-resolution records; does not mutate supplied facts.
 */
function reconcileFacts(input: {
  readonly references?: readonly SecretReference[];
  readonly demandEdges?: readonly DemandEdge[];
  readonly dynamicLookupEdges?: readonly DynamicLookupEdge[];
  readonly candidates: readonly BindingCandidate[];
  readonly snapshots?: readonly InventorySnapshot[];
  readonly coverageGaps?: readonly CoverageGap[];
  readonly coverageInputs?: readonly CoverageInputStatus[];
  readonly closedModel?: ClosedProvisioningModel;
}) {
  return reconcile({
    references: input.references ?? [],
    demandEdges: input.demandEdges ?? [],
    ...(input.dynamicLookupEdges === undefined
      ? {}
      : { dynamicLookupEdges: input.dynamicLookupEdges }),
    bindingCandidates: input.candidates,
    bindingResolutions: resolveBindingCandidates(input.candidates),
    inventorySnapshots: input.snapshots ?? [],
    ...(input.coverageGaps === undefined ? {} : { coverageGaps: input.coverageGaps }),
    ...(input.coverageInputs === undefined ? {} : { coverageInputs: input.coverageInputs }),
    ...(input.closedModel === undefined ? {} : { closedModel: input.closedModel }),
  });
}

test("typed demand/binding/inventory joins preserve provisioned-but-unread resources", /**
 * Verifies a read resource stays bound while a separately provisioned resource is reported as no-static-read.
 *
 * Inputs: Two exact fixture bindings, one direct reference/demand, and matching inventory.
 * Outputs: Assertions for bound demand evidence and review-classified provisioned-but-unread inventory.
 * Does not handle: Closed-model absence or dynamic lookup behavior.
 * Side effects: Allocates test fixtures and invokes the pure Core reconciler.
 */ () => {
  const api = scope();
  const database = candidate(api, key("DATABASE_URL"));
  const legacy = candidate(api, key("LEGACY_API_KEY"));
  const databaseReference = reference("DATABASE_URL");

  const result = reconcileFacts({
    references: [databaseReference],
    demandEdges: [demand(api, "reference-DATABASE_URL")],
    candidates: [database, legacy],
    snapshots: [inventory(database, legacy)],
  });

  const databaseDemand = result.records.find(
    /**
     * Locates the database demand record among mixed reconciliation records.
     *
     * Inputs: One reconciliation record.
     * Outputs: True only for the DATABASE_URL demand record.
     * Does not handle: Inventory records or opaque demand keys.
     * Side effects: None.
     */
    (record) => record.kind === "demand" && record.key.name === "DATABASE_URL",
  );
  assert.equal(databaseDemand?.binding, "exact-declared");
  assert.equal(databaseDemand?.inventory, "bound");
  assert.equal(
    databaseDemand?.kind === "demand" && "items" in databaseDemand.inventorySnapshot!,
    false,
  );

  const legacyInventory = result.records.find(
    /**
     * Locates the inventory record for the intentionally unread legacy resource.
     *
     * Inputs: One reconciliation record.
     * Outputs: True only for the legacy provider resource inventory record.
     * Does not handle: Demand records or same-name resources from another authority.
     * Side effects: None.
     */
    (record) =>
      record.kind === "inventory" &&
      record.providerResourceId.canonicalId === "LEGACY_API_KEY",
  );
  assert.equal(legacyInventory?.inventory, "inventory-listed-no-static-read");
  assert.equal(legacyInventory?.disposition, "review");
});

test("Core indexes 10k distinct slots and matching/nonmatching inventory without pairwise scans", /**
 * Verifies indexed reconciliation preserves outcomes at a 10k matching-and-legacy scale.
 *
 * Inputs: Five thousand demanded candidates, five thousand legacy candidates, and their inventory snapshot.
 * Outputs: Assertions for record cardinality, representative statuses, and a bounded non-quadratic elapsed time.
 * Does not handle: Benchmark-grade timing guarantees or adapter/parser performance.
 * Side effects: Allocates large fixture arrays and measures local elapsed time.
 */ () => {
  const api = scope();
  const count = 10_000;
  const matching = Array.from({ length: count / 2 }, /**
   * Creates one provider-backed candidate that will also have a direct code demand.
   *
   * Inputs: Ignored array value and the fixture sequence index.
   * Outputs: One uniquely keyed matching candidate.
   * Does not handle: Legacy candidate generation or demand creation.
   * Side effects: Allocates candidate/key fixture objects.
   */ (_, index) =>
    candidate(api, key("MATCHING_KEY_" + String(index)), "matching-resource-" + String(index)),
  );
  const legacy = Array.from({ length: count / 2 }, /**
   * Creates one provider-backed candidate intentionally absent from code demand.
   *
   * Inputs: Ignored array value and the fixture sequence index.
   * Outputs: One uniquely keyed legacy candidate.
   * Does not handle: Demand generation or inventory projection.
   * Side effects: Allocates candidate/key fixture objects.
   */ (_, index) =>
    candidate(api, key("LEGACY_KEY_" + String(index)), "legacy-resource-" + String(index)),
  );
  const references = matching.map(/**
   * Creates a direct reference for one matching candidate with a unique reference ID.
   *
   * Inputs: One matching candidate and its ordered index.
   * Outputs: A reference targeting the candidate destination name.
   * Does not handle: Legacy candidate references.
   * Side effects: Allocates one fixture reference.
   */ (entry, index) =>
    reference(String(entry.destination.name), "reference-matching-" + String(index)),
  );
  const demandEdges = references.map(/**
   * Creates the matching direct demand edge for one fixture reference.
   *
   * Inputs: One reference.
   * Outputs: A direct demand edge in the shared API scope.
   * Does not handle: Consumer-derived demand origins.
   * Side effects: Allocates one fixture edge.
   */ (entry) => demand(api, String(entry.id)));
  const started = Date.now();
  const result = reconcileFacts({
    references,
    demandEdges,
    candidates: [...matching, ...legacy],
    snapshots: [inventory(...matching, ...legacy)],
  });
  const elapsed = Date.now() - started;

  assert.equal(
    result.records.filter(/**
     * Counts only demand records for the 5k matching candidates.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for demand records.
     * Does not handle: Demand correctness, asserted separately.
     * Side effects: None.
     */ (record) => record.kind === "demand").length,
    matching.length,
  );
  assert.equal(
    result.records.filter(/**
     * Counts inventory records for all 10k provider-backed candidates.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for inventory records.
     * Does not handle: Inventory status semantics.
     * Side effects: None.
     */ (record) => record.kind === "inventory").length,
    count,
  );
  const firstMatchingDemand = result.records.find(
    /**
     * Finds a representative demanded record from the large matching set.
     *
     * Inputs: One reconciliation record.
     * Outputs: True only for the first matching demand key.
     * Does not handle: Legacy inventory records.
     * Side effects: None.
     */
    (record) => record.kind === "demand" && record.key.name === "MATCHING_KEY_0",
  );
  assert.equal(firstMatchingDemand?.binding, "exact-declared");
  assert.equal(firstMatchingDemand?.inventory, "bound");
  const firstLegacyInventory = result.records.find(
    /**
     * Finds a representative unread inventory record from the large legacy set.
     *
     * Inputs: One reconciliation record.
     * Outputs: True only for the first legacy provider resource.
     * Does not handle: Demand-record selection.
     * Side effects: None.
     */
    (record) =>
      record.kind === "inventory" &&
      record.providerResourceId.canonicalId === "legacy-resource-0",
  );
  assert.equal(firstLegacyInventory?.inventory, "inventory-listed-no-static-read");
  // This catches a regression to the former 10k × 10k candidate/item walk
  // without making timing the source of correctness.
  assert.ok(elapsed < 5_000, "expected indexed reconciliation, received " + String(elapsed) + "ms");
});

test("finite dynamic keys block only their own inventory candidates", /**
 * Verifies finite dynamic evidence becomes demand only for listed keys without tainting unrelated inventory.
 *
 * Inputs: Two finite dynamic keys, one unrelated legacy candidate, and matching inventory.
 * Outputs: Assertions for finite demand/bound status and retained legacy no-static-read status.
 * Does not handle: Pattern or unbounded lookup behavior.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const first = candidate(api, key("FIRST_KEY"));
  const second = candidate(api, key("SECOND_KEY"));
  const legacy = candidate(api, key("LEGACY_KEY"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-finite"),
    referenceId: id("reference-dynamic-finite"),
    scope: api,
    domain: { kind: "finite", keys: [id("FIRST_KEY"), id("SECOND_KEY")] },
    origin: "lexical",
    likelyKeys: [key("FIRST_KEY"), key("SECOND_KEY")],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [first, second, legacy],
    snapshots: [inventory(first, second, legacy)],
  });

  const firstDemand = result.records.find(
    /**
     * Finds the first finite dynamic demand record.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for the FIRST_KEY demand.
     * Does not handle: Inventory record selection.
     * Side effects: None.
     */
    (record) => record.kind === "demand" && record.key.name === "FIRST_KEY",
  );
  assert.equal(firstDemand?.demand, "finite-dynamic");
  assert.equal(firstDemand?.inventory, "bound");

  const legacyInventory = result.records.find(
    /**
     * Finds the unrelated legacy inventory record.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for the LEGACY_KEY provider resource.
     * Does not handle: Dynamic-demand selection.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "LEGACY_KEY",
  );
  assert.equal(legacyInventory?.inventory, "inventory-listed-no-static-read");
});

test("pattern dynamic keys only affect matching binding destinations", /**
 * Verifies an unproven pattern lookup does not suppress an unrelated static inventory finding.
 *
 * Inputs: A SERVICE_ pattern lookup, matching service candidate, unrelated database candidate, and inventory.
 * Outputs: Assertions that service remains bound and database remains provisioned-but-unread.
 * Does not handle: Adapter-proven finite pattern expansion.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const worker = scope("worker");
  const service = candidate(worker, key("SERVICE_US"));
  const unrelated = candidate(worker, key("DATABASE_URL"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-service"),
    referenceId: id("reference-dynamic-service"),
    scope: worker,
    domain: {
      kind: "pattern",
      pattern: { kind: "prefix", patternId: id("pattern-service"), prefix: id("SERVICE_") },
    },
    origin: "user-controlled",
    patternConstraint: "not-proven",
    likelyKeys: [],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [service, unrelated],
    snapshots: [inventory(service, unrelated)],
  });

  const serviceInventory = result.records.find(
    /**
     * Finds the service resource inventory record affected by the pattern fixture.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for SERVICE_US inventory.
     * Does not handle: Database inventory selection.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "SERVICE_US",
  );
  assert.equal(serviceInventory?.inventory, "bound");

  const unrelatedInventory = result.records.find(
    /**
     * Finds the database inventory record outside the SERVICE_ pattern.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for DATABASE_URL inventory.
     * Does not handle: Pattern matching itself.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "DATABASE_URL",
  );
  assert.equal(unrelatedInventory?.inventory, "inventory-listed-no-static-read");
});

test("unbounded user-controlled lookup is scoped and never turns every key into demand", /**
 * Verifies unbounded uncertainty applies only inside its lookup scope and does not fabricate key demands.
 *
 * Inputs: API-scoped unbounded user-controlled lookup and API/worker legacy candidates.
 * Outputs: Assertions for API inconclusive inventory and worker provisioned-but-unread inventory.
 * Does not handle: Finite dynamic candidate attribution.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope("api");
  const worker = scope("worker");
  const apiLegacy = candidate(api, key("API_LEGACY"));
  const workerLegacy = candidate(worker, key("WORKER_LEGACY"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-unbounded"),
    referenceId: id("reference-dynamic-unbounded"),
    scope: api,
    domain: { kind: "unbounded", reason: "user-controlled" },
    origin: "user-controlled",
    likelyKeys: [],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [apiLegacy, workerLegacy],
    snapshots: [inventory(apiLegacy, workerLegacy)],
  });

  const apiInventory = result.records.find(
    /**
     * Finds the API legacy inventory record covered by unbounded uncertainty.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for API_LEGACY inventory.
     * Does not handle: Worker record selection.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "API_LEGACY",
  );
  assert.equal(apiInventory?.inventory, "unknown");
  assert.equal(apiInventory?.disposition, "inconclusive");

  const workerInventory = result.records.find(
    /**
     * Finds the worker legacy inventory record outside the uncertain API scope.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for WORKER_LEGACY inventory.
     * Does not handle: Scope coverage computation.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "WORKER_LEGACY",
  );
  assert.equal(workerInventory?.inventory, "inventory-listed-no-static-read");
});

test("coverage gaps are scoped and prevent only affected absence conclusions", /**
 * Verifies a parse coverage gap blocks legacy classification only in its potentially affected scope.
 *
 * Inputs: API-scoped all-environment gap and API/worker legacy candidates.
 * Outputs: Assertions for API unknown/inconclusive inventory and unaffected worker no-static-read inventory.
 * Does not handle: Key-bounded gap behavior, covered separately.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope("api");
  const worker = scope("worker");
  const apiLegacy = candidate(api, key("API_LEGACY"));
  const workerLegacy = candidate(worker, key("WORKER_LEGACY"));
  const apiGap: CoverageGap = {
    id: id("gap-api-source"),
    domain: "demand",
    inputId: id("source-root"),
    pathOrAdapterId: path("apps/api/broken.ts"),
    potentiallyAffects: selector(api),
    keyDomain: { kind: "all-environment" },
    reason: diagnosticCode("CORE_PARSE_FAILURE"),
  };

  const result = reconcileFacts({
    candidates: [apiLegacy, workerLegacy],
    snapshots: [inventory(apiLegacy, workerLegacy)],
    coverageGaps: [apiGap],
  });

  const apiInventory = result.records.find(
    /**
     * Finds the API inventory record whose absence conclusion is blocked by the coverage gap.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for API_LEGACY inventory.
     * Does not handle: Worker inventory selection.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "API_LEGACY",
  );
  assert.equal(apiInventory?.inventory, "unknown");
  assert.equal(apiInventory?.disposition, "inconclusive");

  const workerInventory = result.records.find(
    /**
     * Finds the unaffected worker inventory record.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for WORKER_LEGACY inventory.
     * Does not handle: Gap selector evaluation.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "WORKER_LEGACY",
  );
  assert.equal(workerInventory?.inventory, "inventory-listed-no-static-read");
});

test("key-bounded coverage uncertainty does not suppress unrelated legacy candidates", /**
 * Verifies finite key-domain uncertainty remains narrow within one scope.
 *
 * Inputs: A one-key dynamic coverage gap and affected/unrelated legacy candidates in one scope.
 * Outputs: Assertions for affected unknown inventory and unrelated no-static-read inventory.
 * Does not handle: Pattern or all-environment gap domains.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const affected = candidate(api, key("AFFECTED_KEY"));
  const unrelated = candidate(api, key("UNRELATED_KEY"));
  const gap: CoverageGap = {
    id: id("gap-one-key"),
    domain: "demand",
    inputId: id("source-root"),
    pathOrAdapterId: path("apps/api/dynamic.ts"),
    potentiallyAffects: selector(api),
    keyDomain: { kind: "keys", keys: [key("AFFECTED_KEY")] },
    reason: diagnosticCode("CORE_DYNAMIC_KEY"),
  };

  const result = reconcileFacts({
    candidates: [affected, unrelated],
    snapshots: [inventory(affected, unrelated)],
    coverageGaps: [gap],
  });
  const affectedRecord = result.records.find(
    /**
     * Finds inventory for the key named by the finite coverage gap.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for AFFECTED_KEY inventory.
     * Does not handle: Unrelated-key selection.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "AFFECTED_KEY",
  );
  assert.equal(affectedRecord?.inventory, "unknown");

  const unrelatedRecord = result.records.find(
    /**
     * Finds inventory for a key absent from the finite coverage gap domain.
     *
     * Inputs: One reconciliation record.
     * Outputs: True for UNRELATED_KEY inventory.
     * Does not handle: Gap-domain matching.
     * Side effects: None.
     */
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "UNRELATED_KEY",
  );
  assert.equal(unrelatedRecord?.inventory, "inventory-listed-no-static-read");
});

test("typed provider identity prevents same-name cross-authority inventory joins", /**
 * Verifies equal canonical names from another authority do not satisfy a typed binding/inventory relation.
 *
 * Inputs: Authority-A binding/demand and an Authority-B same-name inventory item.
 * Outputs: Assertions for exact binding but missing inventory status.
 * Does not handle: Closed-model strong absence or provider access checks.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const database = candidate(api, key("DATABASE_URL"));
  const databaseReference = reference("DATABASE_URL");
  const differentAuthority: InventorySnapshot = {
    authorityId: id("authority-b"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: [
      {
        providerResourceId: {
          authorityId: id("authority-b"),
          canonicalId: id("DATABASE_URL"),
        },
      },
    ],
  };

  const result = reconcileFacts({
    references: [databaseReference],
    demandEdges: [demand(api, "reference-DATABASE_URL")],
    candidates: [database],
    snapshots: [differentAuthority],
  });

  const record = result.records.find(/**
   * Selects the sole demand record under the cross-authority fixture.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for demand kind.
   * Does not handle: Inventory record selection.
   * Side effects: None.
   */ (item) => item.kind === "demand");
  assert.equal(record?.binding, "exact-declared");
  assert.equal(record?.inventory, "missing");
});

test("an external binding without a provider identity stays inventory-unknown", /**
 * Verifies an exact external slot declaration without provider identity never becomes a local inventory claim.
 *
 * Inputs: One external exact binding with resource identity removed and one direct reference/demand.
 * Outputs: Assertions for exact-declared binding, unknown inventory, and inconclusive disposition.
 * Does not handle: External-system delivery verification.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const mapped = candidate(api, key("EXTERNAL_TOKEN"));
  const { providerResourceId: _providerResourceId, ...withoutResource } = mapped;
  const external: BindingCandidate = {
    ...withoutResource,
    sourceKind: "external",
  };
  const externalReference = reference("EXTERNAL_TOKEN");

  const result = reconcileFacts({
    references: [externalReference],
    demandEdges: [demand(api, "reference-EXTERNAL_TOKEN")],
    candidates: [external],
  });
  const record = result.records.find(/**
   * Selects the sole demand record for the external-binding scenario.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for demand kind.
   * Does not handle: External inventory discovery.
   * Side effects: None.
   */ (item) => item.kind === "demand");
  assert.equal(record?.binding, "exact-declared");
  assert.equal(record?.inventory, "unknown");
  assert.equal(record?.disposition, "inconclusive");
});

test("missing-under-declared-model requires explicit completed closed-model evidence", /**
 * Verifies explicit closed-model contract inputs and authority inventory permit the stronger missing classification.
 *
 * Inputs: One missing direct demand, a closed scope contract, complete demand/binding/inventory inputs, and empty authority inventory.
 * Outputs: Assertion for missing-under-declared-model inventory status.
 * Does not handle: Incomplete-model fallback behavior or runtime delivery.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const missingReference = reference("MISSING_KEY");
  const sourceInput = id("source-input");
  const bindingInput = id("binding-input");
  const inventoryInput = id("inventory-input");
  const complete =
    /**
     * Creates one complete observed coverage input covering the fixture API scope.
     *
     * Inputs: An expected input identifier and its demand/binding/inventory domain.
     * Outputs: A complete CoverageInputStatus with an exact API selector.
     * Does not handle: Incomplete input evidence, partial scopes, or input discovery.
     * Side effects: Allocates one coverage-input object.
     */
    (inputId: SafeIdentifier, domain: CoverageInputStatus["domain"]): CoverageInputStatus => ({
    inputId,
    domain,
    state: "complete",
    selector: selector(api),
    });
  const closedModel: ClosedProvisioningModel = {
    schemaVersion: id("closed-model-v1"),
    scopes: [
      {
        selector: selector(api),
        closed: true,
        coverage: {
          modelInputId: id("model-input"),
          maxFiniteKeyDomain: 32,
          approvedFirstPartyRoots: [path("apps/api")],
          bindingRoots: [path("deploy")],
          expectedInputs: [
            { inputId: sourceInput, domain: "demand" },
            { inputId: bindingInput, domain: "binding" },
            { inputId: inventoryInput, domain: "inventory" },
          ],
          permittedExclusions: [],
          inventoryAuthorities: [
            { authorityId: id("authority-a"), inventoryInputId: inventoryInput },
          ],
          allowedExternalMechanisms: [],
          outsideRootImports: "out-of-scope",
        },
      },
    ],
  };
  const authoritativeEmptyInventory: InventorySnapshot = {
    inputId: inventoryInput,
    authorityId: id("authority-a"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: [],
  };

  const result = reconcileFacts({
    references: [missingReference],
    demandEdges: [demand(api, "reference-MISSING_KEY")],
    candidates: [],
    snapshots: [authoritativeEmptyInventory],
    coverageInputs: [
      complete(sourceInput, "demand"),
      complete(bindingInput, "binding"),
      complete(inventoryInput, "inventory"),
    ],
    closedModel,
  });
  const record = result.records.find(/**
   * Selects the missing-key demand record produced under the closed model.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for demand kind.
   * Does not handle: Inventory record selection.
   * Side effects: None.
   */ (item) => item.kind === "demand");
  assert.equal(record?.inventory, "missing-under-declared-model");
});

test("precedence resolves a winner and keeps the lower-ranked source shadowed", /**
 * Verifies comparable distinct ranks select exactly one winner and label the lower source shadowed.
 *
 * Inputs: Two otherwise equal exact candidates with ranks one and two.
 * Outputs: Assertions for effective partition outcome and winner/shadowed selection statuses.
 * Does not handle: Equal-rank conflict or conditional branch precedence.
 * Side effects: Allocates fixtures and invokes the binding resolver.
 */ () => {
  const api = scope();
  const lower = candidate(api, key("API_KEY"), "low-resource", 1);
  const higher = candidate(api, key("API_KEY"), "high-resource", 2);

  const [resolution] = resolveBindingCandidates([lower, higher]);
  assert.equal(resolution?.partitions[0]?.outcome, "effective");
  const selections = resolution?.partitions[0]?.selections ?? [];
  assert.equal(selections.find(/**
   * Finds the higher-ranked selection in the partition.
   *
   * Inputs: One candidate selection.
   * Outputs: True for the higher candidate ID.
   * Does not handle: Status evaluation.
   * Side effects: None.
   */ (item) => item.candidateId === higher.id)?.status, "effective");
  assert.equal(selections.find(/**
   * Finds the lower-ranked selection in the partition.
   *
   * Inputs: One candidate selection.
   * Outputs: True for the lower candidate ID.
   * Does not handle: Status evaluation.
   * Side effects: None.
   */ (item) => item.candidateId === lower.id)?.status, "shadowed");
});

test("finite conditional branches resolve their own precedence winners", /**
 * Verifies finite BRANCH partitions select distinct winners and do not collapse branch-specific provider identities for a source read.
 *
 * Inputs: An unconditional fallback and a higher-ranked BRANCH=main override with matching inventory.
 * Outputs: Assertions for main/other partition selections, exact declaration, and unknown single inventory attribution.
 * Does not handle: Unknown-condition or unbounded partition behavior.
 * Side effects: Allocates fixtures and invokes binding and Core reconciliation.
 */ () => {
  const api = scope();
  const fallback = candidate(api, key("API_KEY"), "fallback-resource", 10);
  const mainOverride: BindingCandidate = {
    ...candidate(api, key("API_KEY"), "main-resource", 20),
    appliesWhen: {
      ...selector(api),
      condition: {
        kind: "all",
        clauses: [{ key: id("BRANCH"), operator: "equals", value: id("main") }],
      },
    },
  };

  const [resolution] = resolveBindingCandidates([fallback, mainOverride]);
  const mainPartition = resolution?.partitions.find(
    /**
     * Locates the finite partition selected for BRANCH=main.
     *
     * Inputs: One binding partition.
     * Outputs: True when it has an equals-main clause.
     * Does not handle: Selection-status assertions.
     * Side effects: None.
     */
    (partition) =>
      partition.appliesWhen.condition.kind === "all" &&
      partition.appliesWhen.condition.clauses.some(
        /**
         * Identifies the equals-main clause inside a finite branch predicate.
         *
         * Inputs: One condition clause.
         * Outputs: True for BRANCH equals main.
         * Does not handle: Other branch clauses.
         * Side effects: None.
         */
        (clause) => clause.operator === "equals" && clause.key === "BRANCH" && clause.value === "main",
      ),
  );
  const otherPartition = resolution?.partitions.find(
    /**
     * Locates the finite partition selected for all BRANCH values other than main.
     *
     * Inputs: One binding partition.
     * Outputs: True when it has a not-equals-main clause.
     * Does not handle: Main branch selection.
     * Side effects: None.
     */
    (partition) =>
      partition.appliesWhen.condition.kind === "all" &&
      partition.appliesWhen.condition.clauses.some(
        /**
         * Identifies the not-equals-main clause inside an other-branch predicate.
         *
         * Inputs: One condition clause.
         * Outputs: True for BRANCH not-equals main.
         * Does not handle: Clause satisfiability beyond this literal check.
         * Side effects: None.
         */
        (clause) => clause.operator === "not-equals" && clause.key === "BRANCH" && clause.value === "main",
      ),
  );

  assert.equal(mainPartition?.outcome, "effective");
  assert.equal(
    mainPartition?.selections.find(/**
     * Finds the override selection in the main partition.
     *
     * Inputs: One candidate selection.
     * Outputs: True for the main override ID.
     * Does not handle: Fallback selection.
     * Side effects: None.
     */ (selection) => selection.candidateId === mainOverride.id)?.status,
    "effective",
  );
  assert.equal(
    mainPartition?.selections.find(/**
     * Finds the fallback selection in the main partition.
     *
     * Inputs: One candidate selection.
     * Outputs: True for the fallback ID.
     * Does not handle: Main override selection.
     * Side effects: None.
     */ (selection) => selection.candidateId === fallback.id)?.status,
    "shadowed",
  );
  assert.equal(otherPartition?.outcome, "effective");
  assert.equal(
    otherPartition?.selections.find(/**
     * Finds the fallback selection in the non-main partition.
     *
     * Inputs: One candidate selection.
     * Outputs: True for the fallback ID.
     * Does not handle: Override selection.
     * Side effects: None.
     */ (selection) => selection.candidateId === fallback.id)?.status,
    "effective",
  );
  assert.equal(
    otherPartition?.selections.find(/**
     * Finds the main-only override selection in the non-main partition.
     *
     * Inputs: One candidate selection.
     * Outputs: True for the main override ID.
     * Does not handle: Candidate applicability calculation.
     * Side effects: None.
     */ (selection) => selection.candidateId === mainOverride.id)?.status,
    "inapplicable",
  );

  const apiKeyReference = reference("API_KEY");
  const result = reconcileFacts({
    references: [apiKeyReference],
    demandEdges: [demand(api, "reference-API_KEY")],
    candidates: [fallback, mainOverride],
    snapshots: [inventory(fallback, mainOverride)],
  });
  const demandRecord = result.records.find(/**
   * Selects the single code-demand reconciliation record for API_KEY.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for demand kind.
   * Does not handle: Branch-specific inventory record selection.
   * Side effects: None.
   */ (record) => record.kind === "demand");
  assert.equal(demandRecord?.binding, "exact-declared");
  // The code read has no branch context, so two provider identities must not
  // collapse into a single claimed inventory relation.
  assert.equal(demandRecord?.inventory, "unknown");
});

test("malformed dynamic facts become conservative scoped uncertainty", /**
 * Verifies mismatched finite likely keys downgrade to scoped uncertainty rather than a false inventory conclusion.
 *
 * Inputs: A finite lookup whose likely key differs from its finite domain and one provider candidate.
 * Outputs: Assertions for unknown inventory and inconclusive disposition.
 * Does not handle: Valid finite dynamic reconciliation.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const candidateOne = candidate(api, key("A_KEY"));
  const invalid: DynamicLookupEdge = {
    id: id("dynamic-invalid"),
    referenceId: id("reference-dynamic-invalid"),
    scope: api,
    domain: { kind: "finite", keys: [id("A_KEY")] },
    origin: "lexical",
    likelyKeys: [key("OTHER_KEY")],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [invalid],
    candidates: [candidateOne],
    snapshots: [inventory(candidateOne)],
  });
  const inventoryRecord = result.records.find(/**
   * Selects the sole inventory record affected by malformed dynamic uncertainty.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for inventory kind.
   * Does not handle: Dynamic record selection.
   * Side effects: None.
   */ (record) => record.kind === "inventory");
  assert.equal(inventoryRecord?.inventory, "unknown");
  assert.equal(inventoryRecord?.disposition, "inconclusive");
});

test("conflicting adapter-proven pattern domains downgrade to unbounded uncertainty", /**
 * Verifies incompatible finite adapter domains do not select one expansion and instead become opaque unbounded uncertainty.
 *
 * Inputs: One adapter-proven pattern lookup and two covering domains with different key sets.
 * Outputs: Assertions for opaque unbounded lookup and the fixed conflict reason.
 * Does not handle: A unique adapter-proven finite domain.
 * Side effects: Allocates fixtures and invokes Core reconciliation.
 */ () => {
  const api = scope();
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-pattern-conflict"),
    referenceId: id("reference-pattern-conflict"),
    scope: api,
    domain: {
      kind: "pattern",
      pattern: { kind: "prefix", patternId: id("service-pattern"), prefix: id("SERVICE_") },
    },
    origin: "lexical",
    patternConstraint: "adapter-proven",
    likelyKeys: [key("SERVICE_BLUE")],
    evidenceChain: [],
  };
  const model: ClosedProvisioningModel = {
    schemaVersion: id("closed-model-v1"),
    scopes: [],
    finitePatternDomains: [
      {
        patternId: id("service-pattern"),
        scope: selector(api),
        keys: [key("SERVICE_BLUE")],
        constraint: "adapter-proven",
      },
      {
        patternId: id("service-pattern"),
        scope: selector(api),
        keys: [key("SERVICE_GREEN")],
        constraint: "adapter-proven",
      },
    ],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [],
    closedModel: model,
  });
  const record = result.records.find(/**
   * Selects the dynamic reconciliation record that carries pattern-domain conflict evidence.
   *
   * Inputs: One reconciliation record.
   * Outputs: True for dynamic kind.
   * Does not handle: Inventory record selection.
   * Side effects: None.
   */ (candidate) => candidate.kind === "dynamic");
  assert.equal(record?.lookup.domain.kind, "unbounded");
  if (record?.lookup.domain.kind === "unbounded") {
    assert.equal(record.lookup.domain.reason, "opaque");
  }
  assert.equal(
    record?.reasons.some(/**
     * Finds the fixed Core reason emitted for conflicting finite pattern domains.
     *
     * Inputs: One reconciliation reason.
     * Outputs: True for the conflict code.
     * Does not handle: Other validation reason codes.
     * Side effects: None.
     */ (reason) => reason.code === "CORE_DYNAMIC_PATTERN_DOMAIN_CONFLICT"),
    true,
  );
});
