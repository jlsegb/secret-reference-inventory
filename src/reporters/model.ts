import { logicalKeyEquals } from "../core/index.js";
import { isSecretLikeToken } from "../safety/index.js";
import type {
  AggregateResult,
  DemandEdge,
  DynamicLookupEdge,
  DynamicReconciliation,
  Evidence,
  ExecutionScope,
  Identifier,
  LogicalKey,
  ReconciliationRecord,
  ReconciliationReason,
  SafeIdentifier,
  SafeKeyPattern,
  Location as SafeLocation,
  ScopeCoverage,
  SecretReference,
  StagePredicate,
} from "../core/index.js";
import type {
  ExplainEvidence,
  ExplainReport,
  ExplainSelector,
  JsonAxes,
  JsonDynamicDomain,
  JsonDynamicLookup,
  JsonEvidence,
  JsonLocation,
  JsonLogicalKey,
  JsonReason,
  JsonReferenceGroup,
  JsonScope,
  JsonScopeCoverage,
  JsonSourceOccurrence,
  JsonUse,
  JsonReport,
  ReportingInput,
} from "./types.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";

const OPAQUE_IDENTIFIER = "<opaque>";
const OPAQUE_PATH = "<opaque-path>";
const UNSCOPED = "<unscoped>";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CREDENTIAL_LIKE = /(?:^|[/._:@-])(?:sk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.)/i;

interface GroupBuilder {
  readonly key: LogicalKey;
  readonly groupId: string;
  readonly uses: JsonUse[];
}

/** Build an entirely derived, safe DTO. Never serialize Core facts directly. */
export function buildJsonReport(input: ReportingInput): JsonReport {
  const references = new Map(
    (input.references ?? []).map((reference) => [reference.id, reference]),
  );
  const demandEdges = input.demandEdges ?? [];
  const groups = buildGroups(input.result.records, references, demandEdges);
  const dynamicLookups = input.result.records
    .filter((record): record is DynamicReconciliation => record.kind === "dynamic")
    .map((record) => toJsonDynamic(record, references, demandEdges))
    .sort(compareDynamic);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    groups: groups.sort(compareGroup),
    dynamicLookups,
    scopeCoverage: input.result.scopeCoverage.map(toJsonScopeCoverage).sort(compareCoverage),
  };
}

export function buildExplainReport(
  input: ReportingInput,
  selector: ExplainSelector,
): ExplainReport | undefined {
  const report = buildJsonReport(input);
  if (selector.kind === "dynamic") {
    const dynamic = report.dynamicLookups.find((lookup) => lookup.id === safeIdentifier(selector.id));
    if (dynamic === undefined) {
      return undefined;
    }
    return {
      selector: "dynamic",
      heading: dynamicHeading(dynamic),
      axes: [axesFromDynamic(dynamic)],
      sources: dynamic.sources,
      evidence: [{ title: "Dynamic lookup evidence", evidence: dynamic.evidence }],
      dynamic,
    };
  }

  const group = report.groups.find((candidate) => keysMatchJson(selector.key, candidate.key));
  if (group === undefined) {
    return undefined;
  }
  return {
    selector: "key",
    heading: `Explain ${formatJsonKey(group.key)}`,
    axes: group.uses.map(axesFromUse),
    sources: group.sources,
    evidence: group.sources.map((source) => ({
      title: `Source ${source.referenceId}`,
      evidence: source.evidence,
    })),
  };
}

function buildGroups(
  records: readonly ReconciliationRecord[],
  references: ReadonlyMap<SafeIdentifier, SecretReference>,
  demandEdges: readonly DemandEdge[],
): JsonReferenceGroup[] {
  const builders: GroupBuilder[] = [];
  let opaqueSequence = 0;

  for (const record of records) {
    if (record.kind === "dynamic") {
      continue;
    }
    const key = recordKey(record);
    if (key === undefined) {
      continue;
    }

    const groupId = groupIdentifier(key, opaqueSequence);
    if (typeof key.name !== "string") {
      opaqueSequence += 1;
    }
    let builder = builders.find((candidate) => candidate.groupId === groupId);
    if (builder === undefined) {
      builder = { key, groupId, uses: [] };
      builders.push(builder);
    }
    builder.uses.push(toJsonUse(record));
  }

  return builders.map((builder) => {
    const sources = sourceOccurrences(builder.key, builder.uses, references, demandEdges);
    const consumers = uniqueScopes(
      builder.uses.flatMap((use) => (use.scope === undefined ? [] : [use.scope])),
    );
    return {
      key: toJsonKey(builder.key),
      shared: consumers.length > 1,
      consumers,
      sources,
      uses: builder.uses.sort(compareUse),
    };
  });
}

function sourceOccurrences(
  key: LogicalKey,
  uses: readonly JsonUse[],
  references: ReadonlyMap<SafeIdentifier, SecretReference>,
  demandEdges: readonly DemandEdge[],
): JsonSourceOccurrence[] {
  const ids = uniqueStrings(uses.flatMap((use) => use.referenceIds));
  const occurrences: JsonSourceOccurrence[] = [];

  for (const id of ids) {
    const reference = references.get(id as SafeIdentifier);
    if (reference === undefined || !logicalKeyEquals(reference.requested, key)) {
      continue;
    }
    occurrences.push(toJsonSource(reference, demandEdges));
  }

  // Inventory-only records can still have a source reference in ReportingInput.
  for (const reference of references.values()) {
    if (
      logicalKeyEquals(reference.requested, key) &&
      !occurrences.some((occurrence) => occurrence.referenceId === safeIdentifier(reference.id))
    ) {
      occurrences.push(toJsonSource(reference, demandEdges));
    }
  }
  return occurrences.sort(compareSource);
}

function toJsonUse(record: Exclude<ReconciliationRecord, DynamicReconciliation>): JsonUse {
  const scope = record.scope === undefined ? undefined : toJsonScope(record.scope);
  const base: JsonUse = {
    kind: record.kind,
    ...(scope === undefined ? {} : { scope }),
    referenceIds: record.kind === "demand" ? record.referenceIds.map(safeIdentifier) : [],
    ...toJsonAxes(record),
    reasons: record.reasons.map(toJsonReason).sort(compareReason),
  };

  if (record.kind === "inventory") {
    return {
      ...base,
      providerResource: {
        authorityId: safeIdentifier(record.providerResourceId.authorityId),
        canonicalId: safeIdentifier(record.providerResourceId.canonicalId),
      },
      ...(record.inventorySnapshot === undefined
        ? {}
        : {
            inventorySnapshot: {
              authorityId: safeIdentifier(record.inventorySnapshot.authorityId),
              asOf: safeIdentifier(record.inventorySnapshot.asOf),
            },
          }),
    };
  }
  return {
    ...base,
    ...(record.inventorySnapshot === undefined
      ? {}
      : {
          inventorySnapshot: {
            authorityId: safeIdentifier(record.inventorySnapshot.authorityId),
            asOf: safeIdentifier(record.inventorySnapshot.asOf),
          },
        }),
  };
}

function toJsonDynamic(
  record: DynamicReconciliation,
  references: ReadonlyMap<SafeIdentifier, SecretReference>,
  demandEdges: readonly DemandEdge[],
): JsonDynamicLookup {
  const reference = references.get(record.lookup.referenceId);
  const sources = reference === undefined ? [] : [toJsonSource(reference, demandEdges)];
  return {
    id: safeIdentifier(record.lookup.id),
    scope: toJsonScope(record.lookup.scope),
    origin: record.lookup.origin,
    domain: toJsonDynamicDomain(record.lookup),
    likelyKeys:
      record.lookup.domain.kind === "unbounded"
        ? []
        : record.lookup.likelyKeys.map(toJsonKey).sort((left, right) =>
            formatJsonKey(left).localeCompare(formatJsonKey(right)),
          ),
    sources,
    evidence: toJsonEvidence(record.lookup.evidenceChain),
    ...toJsonAxes(record),
    reasons: record.reasons.map(toJsonReason).sort(compareReason),
  };
}

function toJsonSource(
  reference: SecretReference,
  demandEdges: readonly DemandEdge[],
): JsonSourceOccurrence {
  const edgeEvidence = demandEdges
    .filter((edge) => edge.referenceId === reference.id)
    .flatMap((edge) => edge.evidenceChain);
  return {
    referenceId: safeIdentifier(reference.id),
    demand: reference.demand,
    operation: reference.operation,
    resolution: reference.resolution,
    confidence: reference.confidence,
    exposure: reference.exposure,
    location: toJsonLocation(reference.location),
    evidence: toJsonEvidence([...reference.evidenceChain, ...edgeEvidence]),
  };
}

function toJsonDynamicDomain(lookup: DynamicLookupEdge): JsonDynamicDomain {
  switch (lookup.domain.kind) {
    case "finite":
      return { kind: "finite", display: "finite environment-key set" };
    case "pattern": {
      const pattern = lookup.domain.pattern;
      return {
        kind: "pattern",
        display: formatPattern(pattern),
        patternId: safeIdentifier(pattern.patternId),
      };
    }
    case "unbounded":
      return {
        kind: "unbounded",
        display: "unbounded environment lookup",
        reason: lookup.domain.reason,
      };
  }
}

function toJsonEvidence(evidence: readonly Evidence[]): JsonEvidence[] {
  const values = evidence.map((item) => ({
    ruleId: safeIdentifier(item.ruleId),
    diagnosticCode: safeIdentifier(item.diagnosticCode),
    locations: item.locations.map(toJsonLocation).sort(compareLocation),
  }));
  return dedupeEvidence(values).sort(compareEvidence);
}

function toJsonLocation(location: SafeLocation): JsonLocation {
  return {
    path: safePath(location.file),
    start: { line: location.start.line, column: location.start.column },
    end: { line: location.end.line, column: location.end.column },
  };
}

function toJsonKey(key: LogicalKey): JsonLogicalKey {
  return { namespace: key.namespace, name: safeIdentifier(key.name) };
}

function toJsonScope(scope: ExecutionScope): JsonScope {
  return {
    id: safeIdentifier(scope.id),
    componentId: safeIdentifier(scope.componentId),
    phase: scope.phase,
    stage: toJsonStage(scope.stage),
    channel: scope.channel,
  };
}

function toJsonStage(stage: StagePredicate): JsonScope["stage"] {
  if (stage.kind !== "exact") {
    return { kind: stage.kind };
  }
  return { kind: "exact", values: stage.values.map(safeIdentifier).sort() };
}

function toJsonAxes(record: AggregateResult): JsonAxes {
  return {
    targetDiscovery: record.targetDiscovery,
    demand: record.demand,
    binding: record.binding,
    inventory: record.inventory,
    coverage: record.coverage,
    constraint: record.constraint,
    disposition: record.disposition,
  };
}

function toJsonReason(reason: ReconciliationReason): JsonReason {
  return {
    code: safeIdentifier(reason.code),
    gapIds: (reason.gapIds ?? []).map(safeIdentifier).sort(),
    candidateIds: (reason.candidateIds ?? []).map(safeIdentifier).sort(),
  };
}

function toJsonScopeCoverage(coverage: ScopeCoverage): JsonScopeCoverage {
  return {
    scope: toJsonScope(coverage.scope),
    state: coverage.state,
    gapIds: coverage.gapIds.map(safeIdentifier).sort(),
  };
}

function recordKey(record: ReconciliationRecord): LogicalKey | undefined {
  if (record.kind === "demand") {
    return record.key;
  }
  if (record.kind === "inventory") {
    return record.destination;
  }
  return undefined;
}

function groupIdentifier(key: LogicalKey, opaqueSequence: number): string {
  if (typeof key.name !== "string") {
    return `${key.namespace}:opaque:${opaqueSequence}`;
  }
  return `${key.namespace}:${key.name}`;
}

function safeIdentifier(value: Identifier | string): string {
  return typeof value === "string" && isReportableText(value) ? value : OPAQUE_IDENTIFIER;
}

function safePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER.test(value)) {
    return OPAQUE_PATH;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && isReportableText(segment),
  )
    ? value
    : OPAQUE_PATH;
}

function isReportableText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !CONTROL_CHARACTER.test(value) &&
    !CREDENTIAL_LIKE.test(value) &&
    !isSecretLikeToken(value)
  );
}

function formatPattern(pattern: SafeKeyPattern): string {
  switch (pattern.kind) {
    case "prefix":
      return `${safeIdentifier(pattern.prefix)}*`;
    case "suffix":
      return `*${safeIdentifier(pattern.suffix)}`;
    case "surrounded":
      return `${safeIdentifier(pattern.prefix)}*${safeIdentifier(pattern.suffix)}`;
  }
}

function keysMatchJson(key: LogicalKey, candidate: JsonLogicalKey): boolean {
  return (
    typeof key.name === "string" &&
    key.namespace === candidate.namespace &&
    safeIdentifier(key.name) === candidate.name
  );
}

function uniqueScopes(scopes: readonly JsonScope[]): JsonScope[] {
  const result: JsonScope[] = [];
  for (const scope of scopes) {
    if (!result.some((candidate) => scopeKey(candidate) === scopeKey(scope))) {
      result.push(scope);
    }
  }
  return result.sort(compareScope);
}

function dedupeEvidence(values: readonly JsonEvidence[]): JsonEvidence[] {
  const result: JsonEvidence[] = [];
  for (const value of values) {
    const identifier = `${value.ruleId}\u0000${value.diagnosticCode}\u0000${JSON.stringify(value.locations)}`;
    if (!result.some((candidate) => `${candidate.ruleId}\u0000${candidate.diagnosticCode}\u0000${JSON.stringify(candidate.locations)}` === identifier)) {
      result.push(value);
    }
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareGroup(left: JsonReferenceGroup, right: JsonReferenceGroup): number {
  return formatJsonKey(left.key).localeCompare(formatJsonKey(right.key));
}

function compareDynamic(left: JsonDynamicLookup, right: JsonDynamicLookup): number {
  return left.id.localeCompare(right.id);
}

function compareCoverage(left: JsonScopeCoverage, right: JsonScopeCoverage): number {
  return compareScope(left.scope, right.scope);
}

function compareScope(left: JsonScope, right: JsonScope): number {
  return scopeKey(left).localeCompare(scopeKey(right));
}

function scopeKey(scope: JsonScope): string {
  return `${scope.id}\u0000${scope.phase}\u0000${scope.channel}\u0000${JSON.stringify(scope.stage)}`;
}

function compareUse(left: JsonUse, right: JsonUse): number {
  const scope = (left.scope?.id ?? UNSCOPED).localeCompare(right.scope?.id ?? UNSCOPED);
  return scope !== 0 ? scope : left.kind.localeCompare(right.kind);
}

function compareSource(left: JsonSourceOccurrence, right: JsonSourceOccurrence): number {
  const path = left.location.path.localeCompare(right.location.path);
  if (path !== 0) return path;
  const line = left.location.start.line - right.location.start.line;
  return line !== 0 ? line : left.referenceId.localeCompare(right.referenceId);
}

function compareLocation(left: JsonLocation, right: JsonLocation): number {
  const path = left.path.localeCompare(right.path);
  if (path !== 0) return path;
  const line = left.start.line - right.start.line;
  return line !== 0 ? line : left.start.column - right.start.column;
}

function compareEvidence(left: JsonEvidence, right: JsonEvidence): number {
  const rule = left.ruleId.localeCompare(right.ruleId);
  return rule !== 0 ? rule : left.diagnosticCode.localeCompare(right.diagnosticCode);
}

function compareReason(left: JsonReason, right: JsonReason): number {
  return left.code.localeCompare(right.code);
}

function formatJsonKey(key: JsonLogicalKey): string {
  return `${key.namespace}:${key.name}`;
}

function dynamicHeading(dynamic: JsonDynamicLookup): string {
  if (dynamic.domain.kind === "unbounded") {
    return "Explain unbounded environment lookup";
  }
  return `Explain dynamic lookup ${dynamic.domain.display}`;
}

function axesFromUse(use: JsonUse): JsonAxes {
  return {
    targetDiscovery: use.targetDiscovery,
    demand: use.demand,
    binding: use.binding,
    inventory: use.inventory,
    coverage: use.coverage,
    constraint: use.constraint,
    disposition: use.disposition,
  };
}

function axesFromDynamic(dynamic: JsonDynamicLookup): JsonAxes {
  return {
    targetDiscovery: dynamic.targetDiscovery,
    demand: dynamic.demand,
    binding: dynamic.binding,
    inventory: dynamic.inventory,
    coverage: dynamic.coverage,
    constraint: dynamic.constraint,
    disposition: dynamic.disposition,
  };
}
