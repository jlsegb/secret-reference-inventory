import {
  bindingResolutionStatusFor,
  effectiveBindingCandidatesFor,
} from "./binding.js";
import { validateDynamicLookupEdge, type DynamicValidationResult } from "./dynamic.js";
import {
  logicalKeyEquals,
  logicalKeySortKey,
  providerResourceEquals,
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
  const demandRecords = demands.map((demand) =>
    reconcileDemand(demand, input, normalizedDynamic, scopeCoverage),
  );
  const inventoryRecords = reconcileInventory(input, demands, normalizedDynamic, scopeCoverage);
  const dynamicRecords = normalizedDynamic.map((dynamic) =>
    reconcileDynamic(dynamic, input, scopeCoverage),
  );

  const records = [...demandRecords, ...inventoryRecords, ...dynamicRecords].sort(compareRecords);
  return { records, scopeCoverage };
}

function collectDemands(
  input: ReconciliationInput,
  dynamic: readonly DynamicValidationResult[],
): readonly InternalDemand[] {
  const referenceById = new Map(input.references.map((reference) => [reference.id, reference]));
  const demands: InternalDemand[] = [];

  for (const edge of input.demandEdges) {
    const reference = referenceById.get(edge.referenceId);
    if (
      reference === undefined ||
      !DIRECT_DEMANDS.has(reference.demand as "direct-read" | "eager-validation") ||
      typeof reference.requested.name !== "string"
    ) {
      continue;
    }

    addDemand(demands, {
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
      addDemand(demands, {
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

function addDemand(target: InternalDemand[], next: InternalDemand): void {
  const existing = target.find(
    (item) => scopesEquivalent(item.scope, next.scope) && logicalKeyEquals(item.key, next.key),
  );
  if (existing === undefined) {
    target.push(next);
    return;
  }

  const mergedDemand = priorityDemand(existing.demand, next.demand);
  const mergedTarget = priorityTarget(existing.targetDiscovery, next.targetDiscovery);
  const mergedReferences = uniqueIdentifiers([...existing.referenceIds, ...next.referenceIds]);
  const index = target.indexOf(existing);
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
): DemandReconciliation {
  const effective = effectiveBindingCandidatesFor(
    demand.scope,
    demand.key,
    input.bindingCandidates,
    input.bindingResolutions,
  );
  const bindingStatus = bindingStatusFor(demand, effective, input.bindingCandidates, input.bindingResolutions);
  const coverage = coverageFor(demand.scope, demand.key, input.coverageGaps ?? [], scopeCoverage);
  const dynamicUncertainty = dynamicUncertaintyFor(demand.scope, demand.key, dynamic);
  const strong = canMakeStrongConclusion(demand.scope, coverage, dynamicUncertainty, input);
  const inventoryMatch = matchingInventory(effective, input.inventorySnapshots);
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
    targetDiscovery: targetForScope(demand.scope, demand.targetDiscovery, input),
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
  demands: readonly InternalDemand[],
  dynamic: readonly DynamicValidationResult[],
  scopeCoverage: readonly ScopeCoverage[],
): readonly InventoryReconciliation[] {
  const records: InventoryReconciliation[] = [];
  const candidateById = new Map(input.bindingCandidates.map((candidate) => [candidate.id, candidate]));
  const effective = effectiveCandidates(input.bindingResolutions, candidateById);
  const representedItems = new Set<string>();

  for (const candidate of effective) {
    if (candidate.providerResourceId === undefined) {
      continue;
    }

    for (const snapshot of input.inventorySnapshots) {
      for (const item of snapshot.items) {
        if (!providerResourceEquals(candidate.providerResourceId, item.providerResourceId)) {
          continue;
        }

        representedItems.add(inventoryItemKey(snapshot, item));
        records.push(
          reconcileBoundInventory(candidate, snapshot, item, demands, dynamic, input, scopeCoverage),
        );
      }
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
  demands: readonly InternalDemand[],
  dynamic: readonly DynamicValidationResult[],
  input: ReconciliationInput,
  scopeCoverage: readonly ScopeCoverage[],
): InventoryReconciliation {
  const matchingDemand = demands.find(
    (demand) =>
      scopeCovers(candidate.scope, demand.scope) && logicalKeyEquals(candidate.destination, demand.key),
  );
  const coverage = coverageFor(
    candidate.scope,
    candidate.destination,
    input.coverageGaps ?? [],
    scopeCoverage,
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
    targetDiscovery: targetForScope(candidate.scope, "deployable", input),
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
  readonly item: InventoryItem;
}

function matchingInventory(
  candidates: readonly BindingCandidate[],
  snapshots: readonly InventorySnapshot[],
): InventoryMatch | undefined {
  if (candidates.length !== 1) {
    return undefined;
  }
  const resource = candidates[0]?.providerResourceId;
  if (resource === undefined) {
    return undefined;
  }

  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      if (providerResourceEquals(resource, item.providerResourceId)) {
        return {
          snapshot: { authorityId: snapshot.authorityId, asOf: snapshot.asOf },
          item,
        };
      }
    }
  }
  return undefined;
}

function effectiveCandidates(
  resolutions: ReconciliationInput["bindingResolutions"],
  candidateById: ReadonlyMap<SafeIdentifier, BindingCandidate>,
): readonly BindingCandidate[] {
  const result: BindingCandidate[] = [];
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
      if (candidate !== undefined && !result.some((item) => item.id === candidate.id)) {
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
  const add = (scope: ExecutionScope): void => {
    if (!scopes.some((existing) => scopesEquivalent(existing, scope))) {
      scopes.push(scope);
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
): CoverageAssessment {
  const matching = gaps.filter(
    (gap) =>
      selectorMayAffectScope(gap.potentiallyAffects, scope) && gapAffectsKey(gap, key),
  );
  const known = scopeCoverage.find((coverage) => scopesEquivalent(coverage.scope, scope));
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
): TargetDiscoveryStatus {
  return (
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
