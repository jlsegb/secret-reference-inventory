import {
  bindingResolutionStatusFor,
} from "./binding.js";
import { validateDynamicLookupEdge, type DynamicValidationResult } from "./dynamic.js";
import {
  logicalKeyEquals,
  logicalKeySortKey,
  safeKeyPatternMatches,
  selectorCoversScope,
  selectorMayAffectScope,
  scopeCovers,
  scopesEquivalent,
} from "./equality.js";
import type {
  AggregateResult,
  BindingCandidate,
  BindingStatus,
  ClosedScope,
  CoverageGap,
  CoverageState,
  DemandEdge,
  DemandReconciliation,
  DemandStatus,
  Disposition,
  DynamicLookupEdge,
  DynamicReconciliation,
  ExecutionScope,
  InventoryItem,
  InventoryReconciliation,
  InventorySnapshot,
  InventoryStatus,
  LogicalKey,
  ReconciliationInput,
  ReconciliationOptions,
  ReconciliationReason,
  ReconciliationRecord,
  ReconciliationResult,
  SafeDiagnosticCode,
  SafeIdentifier,
  ScopeCoverage,
  TargetDiscoveryStatus,
} from "./types.js";

interface InternalDemand {
  readonly scope: ExecutionScope;
  readonly key: LogicalKey;
  readonly demand: Extract<DemandStatus, "present" | "finite-dynamic" | "pattern-dynamic">;
  readonly referenceIds: readonly SafeIdentifier[];
  readonly targetDiscovery: TargetDiscoveryStatus;
}

interface CoverageAssessment {
  readonly state: CoverageState;
  readonly gapIds: readonly SafeIdentifier[];
}

/**
 * Invocation-local relation indexes. They deliberately retain insertion order
 * inside each bucket so record ordering remains byte-for-byte compatible with
 * the previous linear scans.
 */
interface ReconciliationIndexes {
  readonly candidateById: ReadonlyMap<SafeIdentifier, BindingCandidate>;
  readonly candidatesByDestination: ReadonlyMap<string, readonly BindingCandidate[]>;
  readonly bindingResolutionsByDestination: ReadonlyMap<
    string,
    readonly ReconciliationInput["bindingResolutions"][number][]
  >;
  readonly bindingResolutionsByScopeDestination: ReadonlyMap<
    string,
    readonly ReconciliationInput["bindingResolutions"][number][]
  >;
  readonly inventoryByResource: ReadonlyMap<string, readonly InventoryMatch[]>;
  readonly demandsByScopeAndKey: ReadonlyMap<string, readonly InternalDemand[]>;
  readonly demandsByKey: ReadonlyMap<string, readonly InternalDemand[]>;
  readonly scopeCoverageByScope: ReadonlyMap<string, ScopeCoverage>;
  readonly targetStatusesByScope: ReadonlyMap<string, TargetDiscoveryStatus>;
}

const DIRECT_DEMANDS = new Set(["direct-read", "eager-validation"] as const);

/**
 * Reconciles typed code demand, declared binding, inventory, coverage, and dynamic-lookup facts into conservative records.
 *
 * Inputs: One complete local fact collection and an optional finite-dynamic-domain limit.
 * Outputs: Deterministically sorted demand, inventory, and dynamic reconciliations plus per-scope coverage.
 * Does not handle: Code execution, runtime injection, provider permissions, external repositories, or inference from inventory alone.
 * Side effects: Allocates invocation-local Maps, Sets, arrays, normalized lookup copies, and output records; input facts remain unchanged.
 */
export function reconcile(
  input: ReconciliationInput,
  options: ReconciliationOptions = {},
): ReconciliationResult {
  const maxFiniteKeyDomain = options.maxFiniteKeyDomain ?? 64;
  const bindingDestinations = input.bindingCandidates.map(
    /**
     * Projects a binding candidate to scope/key evidence for pattern-domain validation.
     *
     * Inputs: One binding candidate.
     * Outputs: Its execution scope and logical destination key.
     * Does not handle: Precedence, provider identity, or candidate exactness.
     * Side effects: Allocates one projection object.
     */
    (candidate) => ({
    scope: candidate.scope,
    key: candidate.destination,
  })
  );
  const normalizedDynamic = (input.dynamicLookupEdges ?? []).map(
    /**
     * Validates one dynamic lookup against current binding and closed-model facts.
     *
     * Inputs: One dynamic lookup edge.
     * Outputs: A retained or conservatively downgraded validation result.
     * Does not handle: Source parsing or dynamic-domain recovery beyond supplied finite evidence.
     * Side effects: Delegates allocation of normalized lookup copies and issue arrays.
     */
    (edge) => validateDynamicLookupEdge(edge, {
      maxFiniteKeyDomain,
      knownBindingDestinations: bindingDestinations,
      finitePatternDomains: input.closedModel?.finitePatternDomains ?? [],
    }),
  );

  const demands = collectDemands(input, normalizedDynamic);
  const knownScopes = collectScopes(input, demands, normalizedDynamic);
  const scopeCoverage = knownScopes.map(
    /**
     * Summarizes every potentially affecting coverage gap for one discovered scope.
     *
     * Inputs: One known execution scope.
     * Outputs: Its broad complete or incomplete coverage record.
     * Does not handle: Key-bounded coverage filtering, which occurs for individual conclusions later.
     * Side effects: Allocates one scope-coverage record and gap-ID array.
     */
    (scope) => buildScopeCoverage(scope, input.coverageGaps ?? [])
  );
  const indexes = buildReconciliationIndexes(input, demands, scopeCoverage);
  const demandRecords = demands.map(
    /**
     * Reconciles one collected code demand against bindings, inventory, coverage, and dynamic uncertainty.
     *
     * Inputs: One internal demand and enclosing invocation facts.
     * Outputs: Its demand reconciliation record.
     * Does not handle: Inventory-only resources, which follow a separate reconciliation path.
     * Side effects: Allocates one output record and reason list.
     */
    (demand) => reconcileDemand(demand, input, normalizedDynamic, scopeCoverage, indexes),
  );
  const inventoryRecords = reconcileInventory(
    input,
    normalizedDynamic,
    scopeCoverage,
    indexes,
  );
  const dynamicRecords = normalizedDynamic.map(
    /**
     * Emits a reconciliation record for one validated dynamic lookup edge.
     *
     * Inputs: One normalized dynamic validation result.
     * Outputs: Its dynamic reconciliation record and validation reasons.
     * Does not handle: Expanding unbounded domains into individual secret keys.
     * Side effects: Allocates one output record and reason list.
     */
    (dynamic) => reconcileDynamic(dynamic, input, scopeCoverage),
  );

  const records = [...demandRecords, ...inventoryRecords, ...dynamicRecords].sort(compareRecords);
  return { records, scopeCoverage };
}

/**
 * Builds ordered lookup indexes that preserve prior linear-scan semantics while avoiding pairwise reconciliation work.
 *
 * Inputs: Reconciliation facts, collected demands, and broad scope-coverage records.
 * Outputs: Read-only index references keyed by concrete logical, scope, and provider-resource identities.
 * Does not handle: Indexing opaque names/scopes as equal or resolving precedence and coverage conclusions.
 * Side effects: Mutates newly allocated Maps and bucket arrays; keeps full inventory snapshots privately in index values.
 */
function buildReconciliationIndexes(
  input: ReconciliationInput,
  demands: readonly InternalDemand[],
  scopeCoverage: readonly ScopeCoverage[],
): ReconciliationIndexes {
  const candidateById = new Map<SafeIdentifier, BindingCandidate>();
  const candidatesByDestination = new Map<string, BindingCandidate[]>();
  for (const candidate of input.bindingCandidates) {
    candidateById.set(candidate.id, candidate);
    const destination = logicalKeyIndexKey(candidate.destination);
    if (destination !== undefined) {
      appendIndex(candidatesByDestination, destination, candidate);
    }
  }

  const bindingResolutionsByDestination = new Map<
    string,
    ReconciliationInput["bindingResolutions"][number][]
  >();
  const bindingResolutionsByScopeDestination = new Map<
    string,
    ReconciliationInput["bindingResolutions"][number][]
  >();
  for (const resolution of input.bindingResolutions) {
    const destination = logicalKeyIndexKey(resolution.destination);
    if (destination === undefined) continue;
    appendIndex(bindingResolutionsByDestination, destination, resolution);
    const scopeDestination = scopeAndLogicalKey(resolution.scope, resolution.destination);
    if (scopeDestination !== undefined) {
      appendIndex(bindingResolutionsByScopeDestination, scopeDestination, resolution);
    }
  }

  const inventoryByResource = new Map<string, InventoryMatch[]>();
  for (const snapshot of input.inventorySnapshots) {
    for (const item of snapshot.items) {
      appendIndex(inventoryByResource, providerResourceKey(item.providerResourceId), {
        snapshot: { authorityId: snapshot.authorityId, asOf: snapshot.asOf },
        sourceSnapshot: snapshot,
        item,
      });
    }
  }

  const demandsByScopeAndKey = new Map<string, InternalDemand[]>();
  const demandsByKey = new Map<string, InternalDemand[]>();
  for (const demand of demands) {
    const key = logicalKeyIndexKey(demand.key);
    if (key !== undefined) {
      appendIndex(demandsByKey, key, demand);
    }
    const scoped = scopeAndLogicalKey(demand.scope, demand.key);
    if (scoped !== undefined) {
      appendIndex(demandsByScopeAndKey, scoped, demand);
    }
  }

  const scopeCoverageByScope = new Map<string, ScopeCoverage>();
  for (const coverage of scopeCoverage) {
    const key = executionScopeIndexKey(coverage.scope);
    if (key !== undefined && !scopeCoverageByScope.has(key)) {
      scopeCoverageByScope.set(key, coverage);
    }
  }

  const targetStatusesByScope = new Map<string, TargetDiscoveryStatus>();
  for (const status of input.targetStatuses ?? []) {
    const key = executionScopeIndexKey(status.scope);
    // `.find(...)` previously selected the first equivalent status.
    if (key !== undefined && !targetStatusesByScope.has(key)) {
      targetStatusesByScope.set(key, status.status);
    }
  }

  return {
    candidateById,
    candidatesByDestination,
    bindingResolutionsByDestination,
    bindingResolutionsByScopeDestination,
    inventoryByResource,
    demandsByScopeAndKey,
    demandsByKey,
    scopeCoverageByScope,
    targetStatusesByScope,
  };
}

/**
 * Appends one value to an ordered index bucket, creating the bucket on first insertion.
 *
 * Inputs: A mutable invocation-local Map, its lookup key, and one value.
 * Outputs: No return value; the Map contains the value at the end of that key's bucket.
 * Does not handle: Deduplication, key validation, or immutable index construction.
 * Side effects: Mutates the supplied Map and, for existing keys, its stored array.
 */
function appendIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, [value]);
  } else {
    values.push(value);
  }
}

/**
 * Encodes a concrete logical key for ordered invocation-local index lookup.
 *
 * Inputs: One logical key.
 * Outputs: A namespace/name JSON key, or undefined when the logical name is opaque.
 * Does not handle: Opaque-name grouping, persistent serialization, or identifier validation.
 * Side effects: Allocates a JSON string for concrete names.
 */
function logicalKeyIndexKey(key: LogicalKey): string | undefined {
  return typeof key.name === "string" ? JSON.stringify([key.namespace, key.name]) : undefined;
}

/**
 * Encodes dimensions used by Core scope equivalence for safe index lookup.
 *
 * Inputs: One execution scope.
 * Outputs: A deterministic JSON key for known phase/channel/stage scopes, or undefined for opaque dimensions.
 * Does not handle: Component identity, unknown-dimension equality, or cross-scope coverage.
 * Side effects: Allocates normalized stage data and a JSON string for indexable scopes.
 */
function executionScopeIndexKey(scope: ExecutionScope): string | undefined {
  if (
    scope.phase === "unknown" ||
    scope.channel === "unknown" ||
    scope.stage.kind === "unknown"
  ) {
    return undefined;
  }
  const stage = scope.stage.kind === "all"
    ? ["all"]
    : ["exact", ...new Set(scope.stage.values)].sort();
  // Component identity intentionally does not participate: Core's
  // `scopeCovers`/`scopesEquivalent` relation is defined by execution ID,
  // phase, channel, and stage coverage only.
  return JSON.stringify([scope.id, scope.phase, scope.channel, stage]);
}

/**
 * Combines safe scope and logical-key index identities into a composite lookup key.
 *
 * Inputs: One execution scope and one logical key.
 * Outputs: A JSON composite key when both inputs are indexable, or undefined otherwise.
 * Does not handle: Coverage, scope containment, or opaque identity matching.
 * Side effects: Allocates a composite JSON string when both component keys exist.
 */
function scopeAndLogicalKey(scope: ExecutionScope, key: LogicalKey): string | undefined {
  const scopeKey = executionScopeIndexKey(scope);
  const logicalKey = logicalKeyIndexKey(key);
  return scopeKey === undefined || logicalKey === undefined
    ? undefined
    : JSON.stringify([scopeKey, logicalKey]);
}

/**
 * Encodes a provider resource using authority and canonical identifiers for inventory indexing.
 *
 * Inputs: A provider-resource-shaped authority/canonical identity.
 * Outputs: A deterministic JSON lookup key.
 * Does not handle: Provider aliases, resource field resolution, or permissions.
 * Side effects: Allocates a JSON string.
 */
function providerResourceKey(resource: {
  readonly authorityId: SafeIdentifier;
  readonly canonicalId: SafeIdentifier;
}): string {
  return JSON.stringify([resource.authorityId, resource.canonicalId]);
}

/**
 * Retrieves candidates that declare the same concrete destination key as a demand.
 *
 * Inputs: One internal demand and the invocation indexes.
 * Outputs: The declaration-ordered destination bucket, or an empty sequence for opaque/unindexed keys.
 * Does not handle: Scope coverage, precedence selection, or exactness.
 * Side effects: None.
 */
function candidatesForDemand(
  demand: InternalDemand,
  indexes: ReconciliationIndexes,
): readonly BindingCandidate[] {
  const key = logicalKeyIndexKey(demand.key);
  return key === undefined ? [] : indexes.candidatesByDestination.get(key) ?? [];
}

/**
 * Retrieves destination-matching binding resolutions, using an exact index only when it is complete.
 *
 * Inputs: One internal demand and the invocation indexes.
 * Outputs: The exact scope/destination bucket when it contains all destination resolutions; otherwise the full ordered destination bucket.
 * Does not handle: Scope containment filtering for broader-stage resolutions, which downstream logic preserves.
 * Side effects: None.
 */
function resolutionsForDemand(
  demand: InternalDemand,
  indexes: ReconciliationIndexes,
): readonly ReconciliationInput["bindingResolutions"][number][] {
  const destination = logicalKeyIndexKey(demand.key);
  if (destination === undefined) return [];
  const all = indexes.bindingResolutionsByDestination.get(destination) ?? [];
  const scoped = scopeAndLogicalKey(demand.scope, demand.key);
  const exact = scoped === undefined
    ? undefined
    : indexes.bindingResolutionsByScopeDestination.get(scoped);
  // The exact bucket can replace the destination bucket only when it contains
  // every possible resolution. Otherwise a broader-stage resolution may still
  // cover the demand and the original declaration order must be retained.
  return exact !== undefined && exact.length === all.length ? exact : all;
}

/**
 * Extracts unique exact candidates selected by complete effective partitions covering one demand.
 *
 * Inputs: One demand and reconciliation indexes.
 * Outputs: First-seen unique exact candidate facts.
 * Does not handle: Conflicting/unresolved partitions, dynamic candidates, or branch-resource collapse.
 * Side effects: Allocates an output array and candidate-ID Set.
 */
function effectiveCandidatesForDemand(
  demand: InternalDemand,
  indexes: ReconciliationIndexes,
): readonly BindingCandidate[] {
  const selected: BindingCandidate[] = [];
  const seen = new Set<SafeIdentifier>();
  for (const resolution of resolutionsForDemand(demand, indexes)) {
    if (
      !scopeCovers(resolution.scope, demand.scope) ||
      !logicalKeyEquals(resolution.destination, demand.key)
    ) {
      continue;
    }
    for (const partition of resolution.partitions) {
      if (partition.outcome !== "effective" || !selectorCoversScope(partition.appliesWhen, demand.scope)) {
        continue;
      }
      const effective = partition.selections.filter(
        /**
         * Retains selections marked effective so a unique winner can be required.
         *
         * Inputs: One partition selection.
         * Outputs: True only for effective status.
         * Does not handle: Scope or destination compatibility.
         * Side effects: None.
         */
        (selection) => selection.status === "effective",
      );
      if (effective.length !== 1 || effective[0] === undefined) {
        continue;
      }
      const candidate = indexes.candidateById.get(effective[0].candidateId);
      if (
        candidate !== undefined &&
        candidate.resolution === "exact" &&
        !seen.has(candidate.id)
      ) {
        seen.add(candidate.id);
        selected.push(candidate);
      }
    }
  }
  return selected;
}

/**
 * Finds the first code demand whose key and scope are covered by one binding candidate.
 *
 * Inputs: One binding candidate and reconciliation indexes.
 * Outputs: The first matching internal demand, or undefined when no static demand matches.
 * Does not handle: Unbounded dynamic uncertainty, partial scope coverage, or multiple-demand aggregation.
 * Side effects: None.
 */
function matchingDemandForCandidate(
  candidate: BindingCandidate,
  indexes: ReconciliationIndexes,
): InternalDemand | undefined {
  const destination = logicalKeyIndexKey(candidate.destination);
  if (destination === undefined) return undefined;
  // Every InternalDemand has a string environment key, so a missing indexed
  // destination proves there is no matching demand; do not rescan all demands
  // for every provisioned-but-unread inventory candidate.
  const all = indexes.demandsByKey.get(destination) ?? [];
  const scoped = scopeAndLogicalKey(candidate.scope, candidate.destination);
  const exact = scoped === undefined
    ? undefined
    : indexes.demandsByScopeAndKey.get(scoped);
  const candidates = exact !== undefined && exact.length === all.length ? exact : all;
  return candidates.find(
    /**
     * Tests one keyed demand against candidate scope coverage and destination equality.
     *
     * Inputs: One demand from the candidate destination bucket.
     * Outputs: True when candidate scope covers it and both logical keys match.
     * Does not handle: Binding selection or precedence.
     * Side effects: None.
     */
    (demand) =>
      scopeCovers(candidate.scope, demand.scope) &&
      logicalKeyEquals(candidate.destination, demand.key),
  );
}

/**
 * Collects direct and finite/pattern dynamic demand facts, merging equal scope/key records conservatively.
 *
 * Inputs: Reconciliation input and validated dynamic lookup results.
 * Outputs: First-seen ordered internal demand records with merged references and strongest demand/target statuses.
 * Does not handle: Opaque reference names, unbounded dynamic lookups, or source parsing.
 * Side effects: Mutates newly allocated demand arrays, Maps, and merged replacement records.
 */
function collectDemands(
  input: ReconciliationInput,
  dynamic: readonly DynamicValidationResult[],
): readonly InternalDemand[] {
  const referenceById = new Map(input.references.map(
    /**
     * Indexes one source reference by its safe reference identifier.
     *
     * Inputs: One source reference fact.
     * Outputs: Its identifier/reference tuple.
     * Does not handle: Duplicate reference-ID conflicts; later entries replace earlier Map values.
     * Side effects: Feeds a newly allocated reference Map.
     */
    (reference) => [reference.id, reference]
  ));
  const demands: InternalDemand[] = [];
  const demandIndexes = new Map<string, number>();

  for (const edge of input.demandEdges) {
    const reference = referenceById.get(edge.referenceId);
    if (
      reference === undefined ||
      !DIRECT_DEMANDS.has(reference.demand as "direct-read" | "eager-validation") ||
      typeof reference.requested.name !== "string"
    ) {
      continue;
    }

    addDemand(demands, demandIndexes, {
      scope: edge.scope,
      key: reference.requested,
      demand: "present",
      referenceIds: [edge.referenceId],
      targetDiscovery: edge.origin === "consumer-derived" ? "consumer-derived" : "deployable",
    });
  }

  for (const result of dynamic) {
    const edge = result.edge;
    if (edge.domain.kind === "unbounded") {
      continue;
    }

    const demand = edge.domain.kind === "finite" ? "finite-dynamic" : "pattern-dynamic";
    const keys =
      result.expandedFiniteKeys.length > 0
        ? result.expandedFiniteKeys
        : edge.likelyKeys;

    for (const key of keys) {
      if (key.namespace !== "env" || typeof key.name !== "string") {
        continue;
      }
      addDemand(demands, demandIndexes, {
        scope: edge.scope,
        key,
        demand,
        referenceIds: [edge.referenceId],
        targetDiscovery: "unknown-target",
      });
    }
  }

  return demands;
}

/**
 * Adds a demand or merges it with a prior comparable scope/key demand using conservative status priority.
 *
 * Inputs: Mutable collected-demand/index structures and one next demand fact.
 * Outputs: No return value; the structures contain a new demand or a replacement with merged reference IDs and strongest statuses.
 * Does not handle: Matching opaque names/scopes, input validation, or generation of demand facts.
 * Side effects: Mutates the supplied demand array and index Map; replaces one existing demand object on a comparable merge.
 */
function addDemand(
  target: InternalDemand[],
  indexes: Map<string, number>,
  next: InternalDemand,
): void {
  const key = scopeAndLogicalKey(next.scope, next.key);
  // The old equality predicates cannot match opaque names or unknown scope
  // dimensions, so treating every one as distinct preserves the conservative
  // behavior while allowing the common comparable case to be O(1).
  const index = key === undefined ? undefined : indexes.get(key);
  const existing = index === undefined ? undefined : target[index];
  if (existing === undefined || index === undefined) {
    target.push(next);
    if (key !== undefined) {
      indexes.set(key, target.length - 1);
    }
    return;
  }

  const mergedDemand = priorityDemand(existing.demand, next.demand);
  const mergedTarget = priorityTarget(existing.targetDiscovery, next.targetDiscovery);
  const mergedReferences = uniqueIdentifiers([...existing.referenceIds, ...next.referenceIds]);
  target[index] = {
    ...existing,
    demand: mergedDemand,
    targetDiscovery: mergedTarget,
    referenceIds: mergedReferences,
  };
}

/**
 * Computes the binding, inventory, coverage, disposition, and reasons for one static or finite dynamic demand.
 *
 * Inputs: One collected demand, full input facts, validated dynamic facts, coverage records, and indexes.
 * Outputs: A demand record that can be exact/bound, missing, declared-model-missing, unresolved, or inconclusive by evidence.
 * Does not handle: Unbounded lookup expansion or inventory-only reconciliation.
 * Side effects: Allocates a demand record, optional inventory snapshot projection, and reason array.
 */
function reconcileDemand(
  demand: InternalDemand,
  input: ReconciliationInput,
  dynamic: readonly DynamicValidationResult[],
  scopeCoverage: readonly ScopeCoverage[],
  indexes: ReconciliationIndexes,
): DemandReconciliation {
  const effective = effectiveCandidatesForDemand(demand, indexes);
  const bindingStatus = bindingStatusFor(
    demand,
    effective,
    candidatesForDemand(demand, indexes),
    resolutionsForDemand(demand, indexes),
  );
  const coverage = coverageFor(
    demand.scope,
    demand.key,
    input.coverageGaps ?? [],
    scopeCoverage,
    indexes.scopeCoverageByScope,
  );
  const dynamicUncertainty = dynamicUncertaintyFor(demand.scope, demand.key, dynamic);
  const strong = canMakeStrongConclusion(demand.scope, coverage, dynamicUncertainty, input);
  const inventoryMatch = matchingInventory(effective, indexes.inventoryByResource);
  const inventory = inventoryStatusForDemand(bindingStatus, effective, inventoryMatch, strong, dynamicUncertainty);
  const disposition = dispositionFor({
    binding: bindingStatus,
    inventory,
    coverage: coverage.state,
    dynamicUncertainty,
  });

  return {
    kind: "demand",
    scope: demand.scope,
    key: demand.key,
    referenceIds: demand.referenceIds,
    targetDiscovery: targetForScope(
      demand.scope,
      demand.targetDiscovery,
      input,
      indexes.targetStatusesByScope,
    ),
    demand: demand.demand,
    binding: bindingStatus,
    inventory,
    ...(inventoryMatch === undefined ? {} : { inventorySnapshot: inventoryMatch.snapshot }),
    coverage: coverage.state,
    constraint: "none",
    disposition,
    reasons: reasonsFor(coverage, dynamicUncertainty, effective),
  };
}

/**
 * Emits reconciliations for inventory resources represented by effective bindings and for every remaining inventory item.
 *
 * Inputs: Full input facts, validated dynamic facts, coverage records, and indexes.
 * Outputs: Ordered inventory records; bound resources are reconciled per effective candidate and leftovers become unbound records.
 * Does not handle: Inferring an effective binding from inventory identity alone or deduplicating distinct declared scopes.
 * Side effects: Mutates newly allocated record arrays and represented-item Set.
 */
function reconcileInventory(
  input: ReconciliationInput,
  dynamic: readonly DynamicValidationResult[],
  scopeCoverage: readonly ScopeCoverage[],
  indexes: ReconciliationIndexes,
): readonly InventoryReconciliation[] {
  const records: InventoryReconciliation[] = [];
  const effective = effectiveCandidates(input.bindingResolutions, indexes.candidateById);
  const representedItems = new Set<string>();

  for (const candidate of effective) {
    const resource = candidate.providerResourceId;
    if (resource === undefined) {
      continue;
    }

    for (const match of indexes.inventoryByResource.get(providerResourceKey(resource)) ?? []) {
      representedItems.add(inventoryItemKey(match.sourceSnapshot, match.item));
      records.push(
        reconcileBoundInventory(
          candidate,
          match.sourceSnapshot,
          match.item,
          dynamic,
          input,
          scopeCoverage,
          indexes,
        ),
      );
    }
  }

  for (const snapshot of input.inventorySnapshots) {
    for (const item of snapshot.items) {
      if (representedItems.has(inventoryItemKey(snapshot, item))) {
        continue;
      }
      const scopes = item.declaredScopes ?? [];
      if (scopes.length === 0) {
        records.push(unboundInventoryRecord(snapshot, item));
      } else {
        for (const scope of scopes) {
          records.push(unboundInventoryRecord(snapshot, item, scope));
        }
      }
    }
  }

  return records;
}

/**
 * Reconciles one inventory item reached through an exact effective binding candidate.
 *
 * Inputs: The candidate, authoritative snapshot/item, dynamic facts, full input, coverage records, and indexes.
 * Outputs: A bound, provisioned-but-unread, or inconclusive inventory record with scoped coverage and reasons.
 * Does not handle: Unbound inventory resources, branch-specific multiple resource attribution, or provider access verification.
 * Side effects: Allocates one output record and reason array.
 */
function reconcileBoundInventory(
  candidate: BindingCandidate,
  snapshot: InventorySnapshot,
  item: InventoryItem,
  dynamic: readonly DynamicValidationResult[],
  input: ReconciliationInput,
  scopeCoverage: readonly ScopeCoverage[],
  indexes: ReconciliationIndexes,
): InventoryReconciliation {
  const matchingDemand = matchingDemandForCandidate(candidate, indexes);
  const coverage = coverageFor(
    candidate.scope,
    candidate.destination,
    input.coverageGaps ?? [],
    scopeCoverage,
    indexes.scopeCoverageByScope,
  );
  const dynamicUncertainty = dynamicUncertaintyFor(candidate.scope, candidate.destination, dynamic);
  const noStaticRead = matchingDemand === undefined;
  const blocked = coverage.state === "incomplete" || dynamicUncertainty;
  const inventory: InventoryStatus =
    noStaticRead && !blocked ? "inventory-listed-no-static-read" : blocked ? "unknown" : "bound";
  const demand = matchingDemand?.demand ?? "absent";
  const disposition: Disposition =
    blocked ? "inconclusive" : noStaticRead ? "review" : demand === "present" ? "informational" : "review";

  return {
    kind: "inventory",
    scope: candidate.scope,
    destination: candidate.destination,
    providerResourceId: item.providerResourceId,
    targetDiscovery: targetForScope(
      candidate.scope,
      "deployable",
      input,
      indexes.targetStatusesByScope,
    ),
    demand,
    binding: "exact-declared",
    inventory,
    inventorySnapshot: { authorityId: snapshot.authorityId, asOf: snapshot.asOf },
    coverage: coverage.state,
    constraint: "none",
    disposition,
    reasons: reasonsFor(coverage, dynamicUncertainty, [candidate]),
  };
}

/**
 * Records an inventory item that no effective binding candidate represented, preserving any declared scope as context.
 *
 * Inputs: One inventory snapshot/item and an optional declared execution scope.
 * Outputs: A review-classified unbound inventory record with absent demand and no static binding evidence.
 * Does not handle: Proving the resource unused outside the supplied local inventory or deriving a missing binding.
 * Side effects: Allocates one record and optional scope projection.
 */
function unboundInventoryRecord(
  snapshot: InventorySnapshot,
  item: InventoryItem,
  scope?: ExecutionScope,
): InventoryReconciliation {
  return {
    kind: "inventory",
    ...(scope === undefined ? {} : { scope }),
    providerResourceId: item.providerResourceId,
    targetDiscovery: scope === undefined ? "unknown-target" : "deployable",
    demand: "absent",
    binding: "no-static-evidence",
    inventory: "unbound",
    inventorySnapshot: { authorityId: snapshot.authorityId, asOf: snapshot.asOf },
    coverage: "complete",
    constraint: "none",
    disposition: "review",
    reasons: [reason("CORE_INVENTORY_UNBOUND")],
  };
}

/**
 * Emits a record for one validated dynamic lookup without turning an unbounded domain into per-key demand.
 *
 * Inputs: One dynamic validation result, full reconciliation input, and broad coverage records.
 * Outputs: A dynamic record marked possible/review for finite facts or dynamic/inconclusive for unbounded or invalid facts.
 * Does not handle: Binding selection, provider inventory matching, or recovery of unsafe finite candidates.
 * Side effects: Allocates a record and maps validation issues to fixed Core reasons.
 */
function reconcileDynamic(
  result: DynamicValidationResult,
  input: ReconciliationInput,
  scopeCoverage: readonly ScopeCoverage[],
): DynamicReconciliation {
  const edge = result.edge;
  const demand: DemandStatus = dynamicDemandStatus(edge);
  const coverage =
    edge.domain.kind === "unbounded"
      ? { state: "incomplete" as const, gapIds: [] }
      : coverageFor(edge.scope, undefined, input.coverageGaps ?? [], scopeCoverage);
  const unbounded = edge.domain.kind === "unbounded";

  return {
    kind: "dynamic",
    lookup: edge,
    targetDiscovery: targetForScope(edge.scope, "unknown-target", input),
    demand,
    binding: unbounded ? "dynamic" : "possible",
    inventory: "unknown",
    coverage: coverage.state,
    constraint: "none",
    disposition: unbounded || result.issues.length > 0 ? "inconclusive" : "review",
    reasons: [
      ...reasonsFor(coverage, unbounded, []),
      ...result.issues.map(
        /**
         * Converts one dynamic-validation issue into a compiler-owned reconciliation reason.
         *
         * Inputs: One validation issue with a fixed issue code.
         * Outputs: One fixed Core diagnostic reason.
         * Does not handle: Rendering diagnostics or exposing source-derived issue content.
         * Side effects: Allocates one reason object.
         */
        (issue) => reason(`CORE_${issue.code}`)
      ),
    ],
  };
}

/**
 * Classifies a demand's binding evidence with resolution partitions taking precedence over legacy pre-resolved facts.
 *
 * Inputs: One demand, exact effective candidates, destination candidates, and binding resolutions.
 * Outputs: Exact-declared, conflicting, unresolved, dynamic, possible, or no-static-evidence status.
 * Does not handle: Provider inventory presence, delivery permissions, or treating multiple unproven candidates as exact.
 * Side effects: Allocates a temporary applicable-candidate array.
 */
function bindingStatusFor(
  demand: InternalDemand,
  effective: readonly BindingCandidate[],
  candidates: readonly BindingCandidate[],
  resolutions: ReconciliationInput["bindingResolutions"],
): BindingStatus {
  const status = bindingResolutionStatusFor(demand.scope, demand.key, resolutions);
  if (status === "effective") {
    return "exact-declared";
  }
  if (status === "conflicting") {
    return "conflicting";
  }
  if (status === "unresolved") {
    return "unresolved";
  }

  // Preserve compatibility with explicitly supplied pre-resolved facts, while
  // treating multiple candidates without a complete partition proof as
  // unresolved.
  if (effective.length === 1) {
    return "exact-declared";
  }
  if (effective.length > 1) {
    return "unresolved";
  }

  const applicable = candidates.filter(
    /**
     * Retains candidates whose scope covers the demand and whose destination key is equal.
     *
     * Inputs: One candidate sharing the demand destination index bucket.
     * Outputs: True when it can apply to the demand.
     * Does not handle: Precedence or condition partition selection.
     * Side effects: None.
     */
    (candidate) =>
      scopeCovers(candidate.scope, demand.scope) &&
      logicalKeyEquals(candidate.destination, demand.key),
  );
  if (applicable.some(
    /**
     * Detects a possibly applicable candidate with dynamic binding resolution.
     *
     * Inputs: One applicable candidate.
     * Outputs: True when its resolution prevents exact static binding status.
     * Does not handle: Exact candidate precedence.
     * Side effects: None.
     */
    (candidate) => candidate.resolution === "dynamic"
  )) {
    return "dynamic";
  }
  return applicable.length > 0 ? "possible" : "no-static-evidence";
}

/**
 * Classifies inventory evidence for a demand after binding resolution and closed-model strength have been assessed.
 *
 * Inputs: Binding status, exact effective candidates, an optional inventory match, strong-model eligibility, and dynamic uncertainty.
 * Outputs: Bound, missing, declared-model-missing, unknown, or unbound inventory status by the conservative branch rules.
 * Does not handle: Provider access, multiple branch-resource attribution, or promotion of incomplete evidence into absence proof.
 * Side effects: None.
 */
function inventoryStatusForDemand(
  binding: BindingStatus,
  effective: readonly BindingCandidate[],
  inventory: InventoryMatch | undefined,
  strong: boolean,
  dynamicUncertainty: boolean,
): InventoryStatus {
  if (dynamicUncertainty) {
    return "unknown";
  }
  // An external/effective declaration without a provider-qualified resource
  // proves a slot mapping, not a relation to this local inventory.
  if (effective.length === 1 && effective[0]?.providerResourceId === undefined) {
    return "unknown";
  }
  if (inventory !== undefined && effective.length === 1) {
    return "bound";
  }
  // Different finite condition branches can each have an exact winner but map
  // to different provider resources. A source-level demand then has no single
  // provider identity to call missing or bound without a branch context.
  if (binding === "exact-declared" && effective.length > 1) {
    return "unknown";
  }
  if (binding === "exact-declared" || binding === "no-static-evidence") {
    return strong ? "missing-under-declared-model" : "missing";
  }
  return binding === "possible" ? "unknown" : "unbound";
}

interface InventoryMatch {
  readonly snapshot: Pick<InventorySnapshot, "authorityId" | "asOf">;
  /** Private lookup context; never attached to a demand reconciliation. */
  readonly sourceSnapshot: InventorySnapshot;
  readonly item: InventoryItem;
}

/**
 * Retrieves the first inventory item for a single effective candidate with a provider-qualified resource identity.
 *
 * Inputs: Exact effective candidates and the provider-resource inventory index.
 * Outputs: The first ordered match, or undefined for zero/multiple candidates, external candidates, or no inventory entry.
 * Does not handle: Resolving duplicate inventory records or choosing between conditional branch candidates.
 * Side effects: None.
 */
function matchingInventory(
  candidates: readonly BindingCandidate[],
  inventoryByResource: ReadonlyMap<string, readonly InventoryMatch[]>,
): InventoryMatch | undefined {
  if (candidates.length !== 1) {
    return undefined;
  }
  const resource = candidates[0]?.providerResourceId;
  if (resource === undefined) {
    return undefined;
  }

  return inventoryByResource.get(providerResourceKey(resource))?.[0];
}

/**
 * Extracts unique candidates selected by all effective binding-resolution partitions for inventory reconciliation.
 *
 * Inputs: Binding resolutions and the candidate-ID index.
 * Outputs: First-seen unique candidate facts with exactly one effective selection per effective partition.
 * Does not handle: Unresolved/conflicting partitions, missing candidates, or demand-scope filtering.
 * Side effects: Allocates an output array and seen-ID Set.
 */
function effectiveCandidates(
  resolutions: ReconciliationInput["bindingResolutions"],
  candidateById: ReadonlyMap<SafeIdentifier, BindingCandidate>,
): readonly BindingCandidate[] {
  const result: BindingCandidate[] = [];
  const seen = new Set<SafeIdentifier>();
  for (const resolution of resolutions) {
    for (const partition of resolution.partitions) {
      if (partition.outcome !== "effective") {
        continue;
      }
      const selected = partition.selections.filter(
        /**
         * Retains selections marked effective to enforce the unique-winner invariant.
         *
         * Inputs: One partition selection.
         * Outputs: True when it has effective status.
         * Does not handle: Candidate-ID lookup or partition outcome.
         * Side effects: None.
         */
        (selection) => selection.status === "effective"
      );
      if (selected.length !== 1 || selected[0] === undefined) {
        continue;
      }
      const candidate = candidateById.get(selected[0].candidateId);
      if (candidate !== undefined && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        result.push(candidate);
      }
    }
  }
  return result;
}

/**
 * Collects every visible scope from demand, dynamic, binding, target, and declared-inventory facts without merging opaque scopes.
 *
 * Inputs: Full input facts, collected demands, and normalized dynamic results.
 * Outputs: First-seen scope records under Core scope-equivalence identity.
 * Does not handle: Scope coverage, cross-component identity, or equality through unknown dimensions.
 * Side effects: Mutates newly allocated scope array and index Set.
 */
function collectScopes(
  input: ReconciliationInput,
  demands: readonly InternalDemand[],
  dynamic: readonly DynamicValidationResult[],
): readonly ExecutionScope[] {
  const scopes: ExecutionScope[] = [];
  const indexes = new Set<string>();
  const add =
    /**
     * Adds one scope unless a concrete Core-equivalent scope was already indexed.
     *
     * Inputs: One execution scope from an input fact.
     * Outputs: No return value; the enclosing scope array gains the scope when it is new or opaque.
     * Does not handle: Equality of scopes containing unknown phase/channel/stage dimensions.
     * Side effects: Mutates the enclosing scope array and index Set.
     */
    (scope: ExecutionScope): void => {
    const key = executionScopeIndexKey(scope);
    // Unknown dimensions are not equivalent under Core's scope relation and
    // therefore remain independently visible exactly as before.
    if (key === undefined || !indexes.has(key)) {
      scopes.push(scope);
      if (key !== undefined) indexes.add(key);
    }
    };
  for (const demand of demands) add(demand.scope);
  for (const result of dynamic) add(result.edge.scope);
  for (const candidate of input.bindingCandidates) add(candidate.scope);
  for (const status of input.targetStatuses ?? []) add(status.scope);
  for (const snapshot of input.inventorySnapshots) {
    for (const item of snapshot.items) {
      for (const scope of item.declaredScopes ?? []) add(scope);
    }
  }
  return scopes;
}

/**
 * Creates broad scope coverage for reporting from every gap that may affect the scope.
 *
 * Inputs: One execution scope and all coverage gaps.
 * Outputs: Complete coverage with no IDs or incomplete coverage with all potentially affecting gap IDs.
 * Does not handle: Per-key gap-domain filtering required for absence conclusions.
 * Side effects: Allocates filtered gap arrays and one coverage record.
 */
function buildScopeCoverage(scope: ExecutionScope, gaps: readonly CoverageGap[]): ScopeCoverage {
  const gapIds = gaps
    .filter(
      /**
       * Keeps a gap that could affect the enclosing execution scope.
       *
       * Inputs: One coverage gap.
       * Outputs: True for possible selector/scope overlap.
       * Does not handle: Key-domain relevance.
       * Side effects: None.
       */
      (gap) => selectorMayAffectScope(gap.potentiallyAffects, scope)
    )
    .map(
      /**
       * Projects an affecting coverage gap to its safe diagnostic identifier.
       *
       * Inputs: One already-selected coverage gap.
       * Outputs: Its gap identifier.
       * Does not handle: Deduplication or key relevance.
       * Side effects: None.
       */
      (gap) => gap.id
    );
  return { scope, state: gapIds.length > 0 ? "incomplete" : "complete", gapIds };
}

/**
 * Assesses coverage for a scope and optional logical key, retaining finite gap domains for per-key absence safety.
 *
 * Inputs: A scope, optional key, all gaps, broad scope records, and an optional scope index.
 * Outputs: Complete or incomplete state with broad gap IDs for scope-only calls or key-relevant unique IDs for keyed calls.
 * Does not handle: Repairing missing scans, resolving selectors, or treating a scoped gap as globally incomplete.
 * Side effects: Allocates filtered gap arrays and, for keyed calls, a deduplicated ID array.
 */
function coverageFor(
  scope: ExecutionScope,
  key: LogicalKey | undefined,
  gaps: readonly CoverageGap[],
  scopeCoverage: readonly ScopeCoverage[],
  scopeCoverageByScope?: ReadonlyMap<string, ScopeCoverage>,
): CoverageAssessment {
  const matching = gaps.filter(
    /**
     * Retains a gap that may affect both the enclosing scope and its requested key.
     *
     * Inputs: One coverage gap.
     * Outputs: True when selector overlap and key-domain relevance both hold.
     * Does not handle: Full selector coverage or scan recovery.
     * Side effects: None.
     */
    (gap) =>
      selectorMayAffectScope(gap.potentiallyAffects, scope) && gapAffectsKey(gap, key),
  );
  const scopeKey = executionScopeIndexKey(scope);
  const known =
    (scopeKey === undefined ? undefined : scopeCoverageByScope?.get(scopeKey)) ??
    scopeCoverage.find(
      /**
       * Finds the first broad coverage record equivalent to the enclosing scope.
       *
       * Inputs: One broad scope-coverage record.
       * Outputs: True when Core scope equivalence matches the requested scope.
       * Does not handle: Key-domain relevance, evaluated separately.
       * Side effects: None.
       */
      (coverage) => scopesEquivalent(coverage.scope, scope)
    );
  // ScopeCoverage is intentionally broad for reporting. Per-key conclusions
  // must retain the gap's key domain so a finite/pattern gap cannot suppress an
  // unrelated legacy candidate in the same execution scope.
  const gapIds =
    key === undefined
      ? known?.gapIds ?? []
      : uniqueIdentifiers(matching.map(
        /**
         * Projects a key-relevant gap to its safe identifier before deduplication.
         *
         * Inputs: One matching coverage gap.
         * Outputs: Its diagnostic identifier.
         * Does not handle: Identifier uniqueness, handled by uniqueIdentifiers.
         * Side effects: None.
         */
        (gap) => gap.id
      ));
  return { state: gapIds.length > 0 ? "incomplete" : "complete", gapIds };
}

/**
 * Tests whether a coverage gap's optional finite/pattern key domain includes the conclusion key.
 *
 * Inputs: One coverage gap and an optional logical key.
 * Outputs: True for scope-only calls or unbounded domains, and otherwise for all-environment, listed-key, or pattern matches.
 * Does not handle: Selector/scope overlap, which callers evaluate before key-domain relevance.
 * Side effects: None.
 */
function gapAffectsKey(gap: CoverageGap, key: LogicalKey | undefined): boolean {
  if (key === undefined || gap.keyDomain === undefined) {
    return true;
  }
  switch (gap.keyDomain.kind) {
    case "all-environment":
      return key.namespace === "env";
    case "keys":
      return gap.keyDomain.keys.some(
        /**
         * Tests one finite gap-domain key against the requested conclusion key.
         *
         * Inputs: One key listed by the coverage gap and the enclosing requested key.
         * Outputs: True when their concrete logical identities match.
         * Does not handle: Pattern domains or selector scope.
         * Side effects: None.
         */
        (candidate) => logicalKeyEquals(candidate, key)
      );
    case "pattern":
      return safeKeyPatternMatches(gap.keyDomain.pattern, key);
  }
}

/**
 * Determines whether an unbounded dynamic lookup covers every environment key in a demand or candidate scope.
 *
 * Inputs: A scope/key conclusion target and normalized dynamic lookup results.
 * Outputs: True only when an unbounded lookup scope covers the target environment key.
 * Does not handle: Finite/pattern dynamic lookup uncertainty, which becomes individual possible demand records instead.
 * Side effects: None.
 */
function dynamicUncertaintyFor(
  scope: ExecutionScope,
  key: LogicalKey,
  dynamic: readonly DynamicValidationResult[],
): boolean {
  return dynamic.some(
    /**
     * Checks one normalized dynamic edge for unbounded uncertainty over the enclosing scope/key.
     *
     * Inputs: One dynamic validation result.
     * Outputs: True when its unbounded edge covers the scope and the key is an environment key.
     * Does not handle: Finite/pattern candidate matching.
     * Side effects: None.
     */
    (result) => {
    const edge = result.edge;
    if (!scopeCovers(edge.scope, scope) || key.namespace !== "env") {
      return false;
    }
    // Finite/pattern candidates become possible demand records. They block a
    // legacy conclusion through that demand, but do not make an otherwise
    // typed binding/inventory relation unknowable. Only an unbounded lookup
    // prevents a conclusion for every environment key in scope.
    return edge.domain.kind === "unbounded";
    }
  );
}

/**
 * Determines whether Core's current gate permits a declared-model missing status for a scope.
 *
 * Inputs: A scope, key-aware coverage assessment, dynamic uncertainty flag, and reconciliation input.
 * Outputs: True only when Core sees nonempty declared root arrays, complete matching coverage inputs, required authority snapshots, scope coverage, and no affecting external mechanism; a matching permitted exclusion is not inspected and can still receive missing-under-declared-model.
 * Does not handle: Validating modelInputId, permitted exclusions, root identity/containment, runtime delivery, provider permissions, or outside-root dependencies; callers cannot rely on this path alone for strong absence until an authorized behavior fix adds scoped gaps or another defense.
 * Side effects: None.
 */
function canMakeStrongConclusion(
  scope: ExecutionScope,
  coverage: CoverageAssessment,
  dynamicUncertainty: boolean,
  input: ReconciliationInput,
): boolean {
  if (coverage.state !== "complete" || dynamicUncertainty || input.closedModel === undefined) {
    return false;
  }

  return input.closedModel.scopes.some(
    /**
     * Validates one declared closed scope against every required strong-absence contract condition.
     *
     * Inputs: One closed-scope declaration and the enclosing target scope/input facts.
     * Outputs: True only when this declaration is closed, covers the scope, and has complete compatible contract evidence.
     * Does not handle: Combining incomplete evidence across different closed-scope declarations.
     * Side effects: Reads supplied model/input arrays without mutating them.
     */
    (closed) => {
    if (!closed.closed || !selectorCoversScope(closed.selector, scope)) {
      return false;
    }

    const contract = closed.coverage;
    if (
      contract === undefined ||
      contract.approvedFirstPartyRoots.length === 0 ||
      contract.bindingRoots.length === 0 ||
      contract.expectedInputs.length === 0 ||
      contract.inventoryAuthorities.length === 0 ||
      contract.outsideRootImports !== "out-of-scope"
    ) {
      return false;
    }

    if (
      contract.allowedExternalMechanisms.some(
        /**
         * Detects an allowed external mechanism that could supply the enclosing scope outside scanned provisioning facts.
         *
         * Inputs: One allowed external-mechanism declaration.
         * Outputs: True when its selector may affect the target scope.
         * Does not handle: Runtime delivery proof for mechanisms outside the closed model.
         * Side effects: None.
         */
        (mechanism) => selectorMayAffectScope(mechanism.selector, scope),
      )
    ) {
      return false;
    }

    const completedInputs = input.coverageInputs ?? [];
    const allExpectedInputsComplete = contract.expectedInputs.every(
      /**
       * Requires one declared expected input to have a complete observed counterpart covering the target scope.
       *
       * Inputs: One closed-model expected input.
       * Outputs: True when some observed input matches its ID/domain, is complete, and covers the scope.
       * Does not handle: Inventing an observation for missing expected input.
       * Side effects: Reads the completed-input facts.
       */
      (expected) =>
        completedInputs.some(
          /**
           * Tests one observed coverage input against the enclosing expected input and target scope.
           *
           * Inputs: One observed coverage input.
           * Outputs: True for exact ID/domain, complete state, and full selector coverage.
           * Does not handle: Partial coverage, which remains insufficient for strong absence.
           * Side effects: None.
           */
          (observed) =>
            observed.inputId === expected.inputId &&
            observed.domain === expected.domain &&
            observed.state === "complete" &&
            selectorCoversScope(observed.selector, scope),
        ),
    );
    if (!allExpectedInputsComplete) {
      return false;
    }

    return contract.inventoryAuthorities.every(
      /**
       * Requires an inventory snapshot for each authority explicitly named by the closed-model contract.
       *
       * Inputs: One authority/input requirement.
       * Outputs: True when an input snapshot has the same authority and expected inventory input identity.
       * Does not handle: Snapshot freshness, provider permissions, or item-level completeness beyond the supplied model.
       * Side effects: Reads input snapshots.
       */
      (authority) =>
        input.inventorySnapshots.some(
          /**
           * Compares one inventory snapshot with the enclosing authority requirement.
           *
           * Inputs: One snapshot.
           * Outputs: True when authority and input identifiers match the contract requirement.
           * Does not handle: Inventory item lookup.
           * Side effects: None.
           */
          (snapshot) =>
            snapshot.authorityId === authority.authorityId &&
            snapshot.inputId === authority.inventoryInputId,
        ),
    );
    }
  );
}

/**
 * Selects an explicit target-discovery status equivalent to a scope, falling back to the caller's derived status.
 *
 * Inputs: A scope, fallback status, input target statuses, and an optional scope-status index.
 * Outputs: The first indexed/equivalent explicit status or the fallback when none exists.
 * Does not handle: Target discovery itself, scope equality through unknown dimensions, or status merging across scopes.
 * Side effects: None.
 */
function targetForScope(
  scope: ExecutionScope,
  fallback: TargetDiscoveryStatus,
  input: ReconciliationInput,
  targetStatusesByScope?: ReadonlyMap<string, TargetDiscoveryStatus>,
): TargetDiscoveryStatus {
  const scopeKey = executionScopeIndexKey(scope);
  return (
    (scopeKey === undefined ? undefined : targetStatusesByScope?.get(scopeKey)) ??
    input.targetStatuses?.find(
      /**
       * Finds the first explicit target status whose scope is Core-equivalent to the target scope.
       *
       * Inputs: One target-status fact.
       * Outputs: True when its scope matches the enclosing scope.
       * Does not handle: Priority merging among multiple statuses.
       * Side effects: None.
       */
      (status) => scopesEquivalent(status.scope, scope)
    )?.status ?? fallback
  );
}

/**
 * Maps a normalized dynamic lookup domain and origin to its public demand-status label.
 *
 * Inputs: One normalized dynamic lookup edge.
 * Outputs: Finite-dynamic, pattern-dynamic, user-controlled-unbounded, or unknown-unbounded demand status.
 * Does not handle: Validation of the lookup domain or individual finite-key demand collection.
 * Side effects: None.
 */
function dynamicDemandStatus(edge: DynamicLookupEdge): DemandStatus {
  if (edge.domain.kind === "finite") {
    return "finite-dynamic";
  }
  if (edge.domain.kind === "pattern") {
    return "pattern-dynamic";
  }
  return edge.origin === "user-controlled" ? "unbounded-user-controlled" : "unbounded-unknown";
}

/**
 * Chooses the user-facing disposition precedence from binding, inventory, coverage, and dynamic uncertainty axes.
 *
 * Inputs: Final binding/inventory statuses, coverage state, and dynamic uncertainty flag.
 * Outputs: Inconclusive for any unresolved evidence, review for missing/no-static-read cases, otherwise informational.
 * Does not handle: Altering the underlying status axes or determining their evidence.
 * Side effects: None.
 */
function dispositionFor(input: {
  readonly binding: BindingStatus;
  readonly inventory: InventoryStatus;
  readonly coverage: CoverageState;
  readonly dynamicUncertainty: boolean;
}): Disposition {
  if (
    input.coverage === "incomplete" ||
    input.dynamicUncertainty ||
    input.binding === "conflicting" ||
    input.binding === "unresolved" ||
    input.binding === "dynamic" ||
    input.inventory === "unknown"
  ) {
    return "inconclusive";
  }
  if (
    input.inventory === "missing" ||
    input.inventory === "missing-under-declared-model" ||
    input.binding === "no-static-evidence" ||
    input.inventory === "inventory-listed-no-static-read"
  ) {
    return "review";
  }
  return "informational";
}

/**
 * Builds fixed reconciliation reasons for coverage gaps, unbounded dynamic uncertainty, and visible binding candidates.
 *
 * Inputs: A coverage assessment, dynamic uncertainty flag, and related binding candidates.
 * Outputs: An ordered reason list containing zero or more fixed Core codes and safe IDs.
 * Does not handle: Binding conflict reasons, provider diagnostics, or user-facing text rendering.
 * Side effects: Mutates a newly allocated reason array.
 */
function reasonsFor(
  coverage: CoverageAssessment,
  dynamicUncertainty: boolean,
  candidates: readonly BindingCandidate[],
): readonly ReconciliationReason[] {
  const reasons: ReconciliationReason[] = [];
  if (coverage.gapIds.length > 0) {
    reasons.push({ code: coreCode("CORE_COVERAGE_INCOMPLETE"), gapIds: coverage.gapIds });
  }
  if (dynamicUncertainty) {
    reasons.push({ code: coreCode("CORE_DYNAMIC_UNCERTAINTY") });
  }
  if (candidates.length > 0) {
    reasons.push({
      code: coreCode("CORE_BINDING_CANDIDATE"),
      candidateIds: candidates.map(
        /**
         * Projects a related binding candidate to its safe identifier for the reason payload.
         *
         * Inputs: One related candidate.
         * Outputs: Its candidate identifier.
         * Does not handle: Candidate deduplication or provenance expansion.
         * Side effects: None.
         */
        (candidate) => candidate.id
      ),
    });
  }
  return reasons;
}

/**
 * Wraps a fixed Core diagnostic code as a reconciliation reason with no optional identifiers.
 *
 * Inputs: A compiler-owned Core code string.
 * Outputs: One reason object containing the safely branded code.
 * Does not handle: Validating arbitrary user strings or attaching gap/candidate IDs.
 * Side effects: Allocates one reason object.
 */
function reason(code: string): ReconciliationReason {
  return { code: coreCode(code) };
}

/**
 * Brands a compiler-owned fixed diagnostic constant for the safe report type.
 *
 * Inputs: A string literal assembled only from Core-controlled constants.
 * Outputs: The same value as a SafeDiagnosticCode.
 * Does not handle: Sanitizing source-derived text or validating caller-provided diagnostic content.
 * Side effects: None.
 */
function coreCode(code: string): SafeDiagnosticCode {
  // These are compiler-owned fixed constants, not source-derived text.
  return code as SafeDiagnosticCode;
}

/**
 * Keeps the more specific demand status when equal scope/key demand facts merge.
 *
 * Inputs: Two present, finite-dynamic, or pattern-dynamic demand statuses.
 * Outputs: Present over finite-dynamic over pattern-dynamic, with left preserved for equal priority.
 * Does not handle: Unbounded lookup statuses or source-reference collection.
 * Side effects: None.
 */
function priorityDemand(left: InternalDemand["demand"], right: InternalDemand["demand"]): InternalDemand["demand"] {
  const priority: Record<InternalDemand["demand"], number> = {
    present: 3,
    "finite-dynamic": 2,
    "pattern-dynamic": 1,
  };
  return priority[left] >= priority[right] ? left : right;
}

/**
 * Keeps the most actionable target-discovery status when equal scope/key demand facts merge.
 *
 * Inputs: Two target-discovery statuses.
 * Outputs: The higher fixed priority, with left preserved for equal priority.
 * Does not handle: Discovering targets or reconciling status across non-equivalent scopes.
 * Side effects: None.
 */
function priorityTarget(left: TargetDiscoveryStatus, right: TargetDiscoveryStatus): TargetDiscoveryStatus {
  const priority: Record<TargetDiscoveryStatus, number> = {
    deployable: 4,
    "consumer-derived": 3,
    "external-consumer-possible": 2,
    "internal-only": 1,
    "unknown-target": 0,
  };
  return priority[left] >= priority[right] ? left : right;
}

/**
 * Deduplicates safe identifiers while preserving their first-seen array order.
 *
 * Inputs: An identifier sequence.
 * Outputs: A newly allocated sequence containing each first occurrence once.
 * Does not handle: Identifier validation, sorting, or semantic alias merging.
 * Side effects: Allocates a Set and output array.
 */
function uniqueIdentifiers(values: readonly SafeIdentifier[]): SafeIdentifier[] {
  return [...new Set(values)];
}

/**
 * Creates a snapshot-qualified key that distinguishes identical resource identities observed in different authorities.
 *
 * Inputs: One inventory snapshot and one item from it.
 * Outputs: A delimiter-separated authority/resource identity string for the represented-item Set.
 * Does not handle: Escaping arbitrary identifiers or persistent storage.
 * Side effects: Allocates a string.
 */
function inventoryItemKey(snapshot: InventorySnapshot, item: InventoryItem): string {
  return `${snapshot.authorityId}\u0000${item.providerResourceId.authorityId}\u0000${item.providerResourceId.canonicalId}`;
}

/**
 * Orders reconciliation records deterministically by kind, scope ID, then their kind-specific identity key.
 *
 * Inputs: Two reconciliation records.
 * Outputs: A locale comparison result suitable for Array.sort.
 * Does not handle: Human-priority ordering, opaque key normalization, or stable tie-breaking beyond equal return zero.
 * Side effects: None.
 */
function compareRecords(left: ReconciliationRecord, right: ReconciliationRecord): number {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) {
    return kind;
  }
  const leftScope = left.kind === "dynamic" ? left.lookup.scope : left.scope;
  const rightScope = right.kind === "dynamic" ? right.lookup.scope : right.scope;
  const scope = (leftScope?.id ?? "").localeCompare(rightScope?.id ?? "");
  if (scope !== 0) {
    return scope;
  }
  const leftKey = recordKey(left);
  const rightKey = recordKey(right);
  return leftKey.localeCompare(rightKey);
}

/**
 * Selects the kind-specific deterministic identity key used after record kind and scope ordering.
 *
 * Inputs: One demand, inventory, or dynamic reconciliation record.
 * Outputs: A concrete logical key, provider identity string, dynamic ID, or empty string for opaque demand keys.
 * Does not handle: Cross-kind identity comparison or escaping for persistent serialization.
 * Side effects: None.
 */
function recordKey(record: ReconciliationRecord): string {
  if (record.kind === "demand") {
    return logicalKeySortKey(record.key) ?? "";
  }
  if (record.kind === "inventory") {
    return `${record.providerResourceId.authorityId}:${record.providerResourceId.canonicalId}`;
  }
  return record.lookup.id;
}
