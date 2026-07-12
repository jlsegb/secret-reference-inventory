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
 * Correlate only explicit, typed facts. This is deliberately a local analysis:
 * it does not execute code, inspect provider permissions, or infer a binding
 * from an inventory item alone.
 */
export function reconcile(
  input: ReconciliationInput,
  options: ReconciliationOptions = {},
): ReconciliationResult {
  const maxFiniteKeyDomain = options.maxFiniteKeyDomain ?? 64;
  const bindingDestinations = input.bindingCandidates.map((candidate) => ({
    scope: candidate.scope,
    key: candidate.destination,
  }));
  const normalizedDynamic = (input.dynamicLookupEdges ?? []).map((edge) =>
    validateDynamicLookupEdge(edge, {
      maxFiniteKeyDomain,
      knownBindingDestinations: bindingDestinations,
      finitePatternDomains: input.closedModel?.finitePatternDomains ?? [],
    }),
  );

  const demands = collectDemands(input, normalizedDynamic);
  const knownScopes = collectScopes(input, demands, normalizedDynamic);
  const scopeCoverage = knownScopes.map((scope) => buildScopeCoverage(scope, input.coverageGaps ?? []));
  const indexes = buildReconciliationIndexes(input, demands, scopeCoverage);
  const demandRecords = demands.map((demand) =>
    reconcileDemand(demand, input, normalizedDynamic, scopeCoverage, indexes),
  );
  const inventoryRecords = reconcileInventory(
    input,
    normalizedDynamic,
    scopeCoverage,
    indexes,
  );
  const dynamicRecords = normalizedDynamic.map((dynamic) =>
    reconcileDynamic(dynamic, input, scopeCoverage),
  );

  const records = [...demandRecords, ...inventoryRecords, ...dynamicRecords].sort(compareRecords);
  return { records, scopeCoverage };
}

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

function appendIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, [value]);
  } else {
    values.push(value);
  }
}

function logicalKeyIndexKey(key: LogicalKey): string | undefined {
  return typeof key.name === "string" ? JSON.stringify([key.namespace, key.name]) : undefined;
}

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

function scopeAndLogicalKey(scope: ExecutionScope, key: LogicalKey): string | undefined {
  const scopeKey = executionScopeIndexKey(scope);
  const logicalKey = logicalKeyIndexKey(key);
  return scopeKey === undefined || logicalKey === undefined
    ? undefined
    : JSON.stringify([scopeKey, logicalKey]);
}

function providerResourceKey(resource: {
  readonly authorityId: SafeIdentifier;
  readonly canonicalId: SafeIdentifier;
}): string {
  return JSON.stringify([resource.authorityId, resource.canonicalId]);
}

function candidatesForDemand(
  demand: InternalDemand,
  indexes: ReconciliationIndexes,
): readonly BindingCandidate[] {
  const key = logicalKeyIndexKey(demand.key);
  return key === undefined ? [] : indexes.candidatesByDestination.get(key) ?? [];
}

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
    (demand) =>
      scopeCovers(candidate.scope, demand.scope) &&
      logicalKeyEquals(candidate.destination, demand.key),
  );
}

function collectDemands(
  input: ReconciliationInput,
  dynamic: readonly DynamicValidationResult[],
): readonly InternalDemand[] {
  const referenceById = new Map(input.references.map((reference) => [reference.id, reference]));
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
      ...result.issues.map((issue) => reason(`CORE_${issue.code}`)),
    ],
  };
}

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
    (candidate) =>
      scopeCovers(candidate.scope, demand.scope) &&
      logicalKeyEquals(candidate.destination, demand.key),
  );
  if (applicable.some((candidate) => candidate.resolution === "dynamic")) {
    return "dynamic";
  }
  return applicable.length > 0 ? "possible" : "no-static-evidence";
}

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
      const selected = partition.selections.filter((selection) => selection.status === "effective");
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

function collectScopes(
  input: ReconciliationInput,
  demands: readonly InternalDemand[],
  dynamic: readonly DynamicValidationResult[],
): readonly ExecutionScope[] {
  const scopes: ExecutionScope[] = [];
  const indexes = new Set<string>();
  const add = (scope: ExecutionScope): void => {
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

function buildScopeCoverage(scope: ExecutionScope, gaps: readonly CoverageGap[]): ScopeCoverage {
  const gapIds = gaps
    .filter((gap) => selectorMayAffectScope(gap.potentiallyAffects, scope))
    .map((gap) => gap.id);
  return { scope, state: gapIds.length > 0 ? "incomplete" : "complete", gapIds };
}

function coverageFor(
  scope: ExecutionScope,
  key: LogicalKey | undefined,
  gaps: readonly CoverageGap[],
  scopeCoverage: readonly ScopeCoverage[],
  scopeCoverageByScope?: ReadonlyMap<string, ScopeCoverage>,
): CoverageAssessment {
  const matching = gaps.filter(
    (gap) =>
      selectorMayAffectScope(gap.potentiallyAffects, scope) && gapAffectsKey(gap, key),
  );
  const scopeKey = executionScopeIndexKey(scope);
  const known =
    (scopeKey === undefined ? undefined : scopeCoverageByScope?.get(scopeKey)) ??
    scopeCoverage.find((coverage) => scopesEquivalent(coverage.scope, scope));
  // ScopeCoverage is intentionally broad for reporting. Per-key conclusions
  // must retain the gap's key domain so a finite/pattern gap cannot suppress an
  // unrelated legacy candidate in the same execution scope.
  const gapIds =
    key === undefined
      ? known?.gapIds ?? []
      : uniqueIdentifiers(matching.map((gap) => gap.id));
  return { state: gapIds.length > 0 ? "incomplete" : "complete", gapIds };
}

function gapAffectsKey(gap: CoverageGap, key: LogicalKey | undefined): boolean {
  if (key === undefined || gap.keyDomain === undefined) {
    return true;
  }
  switch (gap.keyDomain.kind) {
    case "all-environment":
      return key.namespace === "env";
    case "keys":
      return gap.keyDomain.keys.some((candidate) => logicalKeyEquals(candidate, key));
    case "pattern":
      return safeKeyPatternMatches(gap.keyDomain.pattern, key);
  }
}

function dynamicUncertaintyFor(
  scope: ExecutionScope,
  key: LogicalKey,
  dynamic: readonly DynamicValidationResult[],
): boolean {
  return dynamic.some((result) => {
    const edge = result.edge;
    if (!scopeCovers(edge.scope, scope) || key.namespace !== "env") {
      return false;
    }
    // Finite/pattern candidates become possible demand records. They block a
    // legacy conclusion through that demand, but do not make an otherwise
    // typed binding/inventory relation unknowable. Only an unbounded lookup
    // prevents a conclusion for every environment key in scope.
    return edge.domain.kind === "unbounded";
  });
}

function canMakeStrongConclusion(
  scope: ExecutionScope,
  coverage: CoverageAssessment,
  dynamicUncertainty: boolean,
  input: ReconciliationInput,
): boolean {
  if (coverage.state !== "complete" || dynamicUncertainty || input.closedModel === undefined) {
    return false;
  }

  return input.closedModel.scopes.some((closed) => {
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
      contract.allowedExternalMechanisms.some((mechanism) =>
        selectorMayAffectScope(mechanism.selector, scope),
      )
    ) {
      return false;
    }

    const completedInputs = input.coverageInputs ?? [];
    const allExpectedInputsComplete = contract.expectedInputs.every((expected) =>
      completedInputs.some(
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

    return contract.inventoryAuthorities.every((authority) =>
      input.inventorySnapshots.some(
        (snapshot) =>
          snapshot.authorityId === authority.authorityId &&
          snapshot.inputId === authority.inventoryInputId,
      ),
    );
  });
}

function targetForScope(
  scope: ExecutionScope,
  fallback: TargetDiscoveryStatus,
  input: ReconciliationInput,
  targetStatusesByScope?: ReadonlyMap<string, TargetDiscoveryStatus>,
): TargetDiscoveryStatus {
  const scopeKey = executionScopeIndexKey(scope);
  return (
    (scopeKey === undefined ? undefined : targetStatusesByScope?.get(scopeKey)) ??
    input.targetStatuses?.find((status) => scopesEquivalent(status.scope, scope))?.status ?? fallback
  );
}

function dynamicDemandStatus(edge: DynamicLookupEdge): DemandStatus {
  if (edge.domain.kind === "finite") {
    return "finite-dynamic";
  }
  if (edge.domain.kind === "pattern") {
    return "pattern-dynamic";
  }
  return edge.origin === "user-controlled" ? "unbounded-user-controlled" : "unbounded-unknown";
}

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
      candidateIds: candidates.map((candidate) => candidate.id),
    });
  }
  return reasons;
}

function reason(code: string): ReconciliationReason {
  return { code: coreCode(code) };
}

function coreCode(code: string): SafeDiagnosticCode {
  // These are compiler-owned fixed constants, not source-derived text.
  return code as SafeDiagnosticCode;
}

function priorityDemand(left: InternalDemand["demand"], right: InternalDemand["demand"]): InternalDemand["demand"] {
  const priority: Record<InternalDemand["demand"], number> = {
    present: 3,
    "finite-dynamic": 2,
    "pattern-dynamic": 1,
  };
  return priority[left] >= priority[right] ? left : right;
}

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

function uniqueIdentifiers(values: readonly SafeIdentifier[]): SafeIdentifier[] {
  return [...new Set(values)];
}

function inventoryItemKey(snapshot: InventorySnapshot, item: InventoryItem): string {
  return `${snapshot.authorityId}\u0000${item.providerResourceId.authorityId}\u0000${item.providerResourceId.canonicalId}`;
}

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

function recordKey(record: ReconciliationRecord): string {
  if (record.kind === "demand") {
    return logicalKeySortKey(record.key) ?? "";
  }
  if (record.kind === "inventory") {
    return `${record.providerResourceId.authorityId}:${record.providerResourceId.canonicalId}`;
  }
  return record.lookup.id;
}
