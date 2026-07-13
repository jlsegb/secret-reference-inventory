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

/**
 * Builds the versioned, value-free JSON DTO from reconciliation facts and optional source evidence.
 *
 * Inputs: A reconciliation result with optional static references and demand edges.
 * Outputs: Report groups, dynamic lookups, and scope coverage ordered by the current runtime's default locale where their comparators use localeCompare; collation ties preserve prior input order under stable Array.sort rather than forming a total cross-runtime order.
 * Does not handle: JSON serialization, raw Core-fact exposure, validation of branded input values, or stable opaque-group identities when record input order changes.
 * Side effects: None.
 */
export function buildJsonReport(input: ReportingInput): JsonReport {
  const references = new Map(
    (input.references ?? []).map(
      /**
       * Converts one source reference into the lookup entry keyed by its safe identifier.
       *
       * Inputs: One SecretReference from the optional report input.
       * Outputs: The identifier/reference tuple accepted by Map construction.
       * Does not handle: Sanitizing the reference or reporting duplicates; Map construction keeps the last reference for a repeated identifier.
       * Side effects: None.
       */
      (reference) => [reference.id, reference],
    ),
  );
  const demandEdges = input.demandEdges ?? [];
  const groups = buildGroups(input.result.records, references, demandEdges);
  const dynamicLookups = input.result.records
    .filter(
      /**
       * Narrows reconciliation records to dynamic lookup records for the dedicated report section.
       *
       * Inputs: One reconciliation record.
       * Outputs: A type-guard result true only for dynamic records.
       * Does not handle: Dynamic-domain validation or report transformation.
       * Side effects: None.
       */
      (record): record is DynamicReconciliation => record.kind === "dynamic",
    )
    .map(
      /**
       * Converts one dynamic reconciliation record into its report-safe representation.
       *
       * Inputs: One narrowed dynamic record plus the enclosing reference and demand-edge closures.
       * Outputs: A JsonDynamicLookup.
       * Does not handle: Ordering the resulting collection or source-reference lookup failures.
       * Side effects: None.
       */
      (record) => toJsonDynamic(record, references, demandEdges),
    )
    .sort(compareDynamic);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    groups: groups.sort(compareGroup),
    dynamicLookups,
    scopeCoverage: input.result.scopeCoverage.map(toJsonScopeCoverage).sort(compareCoverage),
  };
}

/**
 * Selects one sanitized report entity and expands its safe provenance for human explanation.
 *
 * Inputs: Normal reporting input and a pre-sanitized key or dynamic selector.
 * Outputs: An ExplainReport for a matching safe entity, or undefined when no match exists.
 * Does not handle: Parsing command-line selectors, echoing raw selector text, or generating terminal output.
 * Side effects: Rebuilds a derived JSON report in memory.
 */
export function buildExplainReport(
  input: ReportingInput,
  selector: ExplainSelector,
): ExplainReport | undefined {
  const report = buildJsonReport(input);
  if (selector.kind === "dynamic") {
    const dynamic = report.dynamicLookups.find(
      /**
       * Locates the dynamic report item whose safe identifier matches the selected identifier.
       *
       * Inputs: One already-sanitized dynamic lookup from the derived report.
       * Outputs: True for the selected lookup.
       * Does not handle: Resolving raw or unsafe selector values.
       * Side effects: None.
       */
      (lookup) => lookup.id === safeIdentifier(selector.id),
    );
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

  const group = report.groups.find(
    /**
     * Identifies the JSON group that safely represents the selected logical key.
     *
     * Inputs: One derived JSON reference group.
     * Outputs: True when the group's JSON key matches the selector's safe key.
     * Does not handle: Reparsing key namespaces or exposing unsafe key names.
     * Side effects: None.
     */
    (candidate) => keysMatchJson(selector.key, candidate.key),
  );
  if (group === undefined) {
    return undefined;
  }
  return {
    selector: "key",
    heading: `Explain ${formatJsonKey(group.key)}`,
    axes: group.uses.map(axesFromUse),
    sources: group.sources,
    evidence: group.sources.map(
      /**
       * Labels one safe source occurrence with its attached evidence for explain output.
       *
       * Inputs: One JSON source occurrence from the selected group.
       * Outputs: An ExplainEvidence section titled with its safe reference identifier.
       * Does not handle: Evidence filtering, source formatting, or raw identifier recovery.
       * Side effects: None.
       */
      (source) => ({
        title: `Source ${source.referenceId}`,
        evidence: source.evidence,
      }),
    ),
  };
}

/**
 * Groups non-dynamic reconciliation records by logical key and enriches each group with safe source evidence.
 *
 * Inputs: Reconciliation records, a reference lookup, and demand-edge evidence.
 * Outputs: One JSON group per named or opaque record key with uses and sources sorted by the report comparators; locale-comparison ties retain prior record order, and opaque sequence labels depend on input record order.
 * Does not handle: Dynamic records, reconciliation itself, or preservation of raw identifiers.
 * Side effects: Mutates local builder arrays only.
 */
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
    let builder = builders.find(
      /**
       * Finds the existing mutable group whose identifier matches the current record key.
       *
       * Inputs: One previously allocated group builder.
       * Outputs: True when it belongs to the requested group identifier.
       * Does not handle: Creating a missing builder or comparing logical keys.
       * Side effects: None.
       */
      (candidate) => candidate.groupId === groupId,
    );
    if (builder === undefined) {
      builder = { key, groupId, uses: [] };
      builders.push(builder);
    }
    builder.uses.push(toJsonUse(record));
  }

  return builders.map(
    /**
     * Finalizes a mutable key-group builder into its immutable report projection.
     *
     * Inputs: One builder holding a logical key and its converted uses.
     * Outputs: A JsonReferenceGroup with safe sources, consumer scopes, shared flag, and uses ordered by compareUse; comparator ties retain the builder's record order.
     * Does not handle: Cross-group deduplication or validation of source evidence.
     * Side effects: Sorts the builder's uses array in place.
     */
    (builder) => {
    const sources = sourceOccurrences(builder.key, builder.uses, references, demandEdges);
    const consumers = uniqueScopes(
      builder.uses.flatMap(
        /**
         * Extracts the optional consumer scope from one converted use.
         *
         * Inputs: One JSON use record.
         * Outputs: A singleton scope array when scoped, otherwise an empty array.
         * Does not handle: Scope normalization or duplicate removal.
         * Side effects: None.
         */
        (use) => (use.scope === undefined ? [] : [use.scope]),
      ),
    );
    return {
      key: toJsonKey(builder.key),
      shared: consumers.length > 1,
      consumers,
      sources,
      uses: builder.uses.sort(compareUse),
    };
    },
  );
}

/**
 * Collects source occurrences related to one logical key from explicit use ids and inventory-only references.
 *
 * Inputs: A logical key, its JSON uses, source-reference lookup, and demand edges.
 * Outputs: Deduplicated source occurrences ordered by the source comparator; locale-comparison ties retain their earlier occurrence order.
 * Does not handle: Creating references for absent code reads or retaining raw source paths.
 * Side effects: Mutates a local occurrence array only.
 */
function sourceOccurrences(
  key: LogicalKey,
  uses: readonly JsonUse[],
  references: ReadonlyMap<SafeIdentifier, SecretReference>,
  demandEdges: readonly DemandEdge[],
): JsonSourceOccurrence[] {
  const ids = uniqueStrings(
    uses.flatMap(
      /**
       * Extracts all source-reference identifiers from one grouped use.
       *
       * Inputs: One JSON use record.
       * Outputs: Its reference-id array.
       * Does not handle: Identifier validation or deduplication across uses.
       * Side effects: None.
       */
      (use) => use.referenceIds,
    ),
  );
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
      !occurrences.some(
        /**
         * Checks whether a candidate source reference has already produced an occurrence.
         *
         * Inputs: One previously converted source occurrence.
         * Outputs: True when it uses the candidate reference's safe identifier.
         * Does not handle: Logical-key equality or evidence comparison.
         * Side effects: None.
         */
        (occurrence) => occurrence.referenceId === safeIdentifier(reference.id),
      )
    ) {
      occurrences.push(toJsonSource(reference, demandEdges));
    }
  }
  return occurrences.sort(compareSource);
}

/**
 * Projects a non-dynamic reconciliation record into a safe report use entry.
 *
 * Inputs: One demand or inventory reconciliation record.
 * Outputs: A JsonUse with sanitized identifiers, optional scope/snapshot data, axes, and reasons sorted by the current runtime's default locale; equal reason codes retain input order.
 * Does not handle: Dynamic records, source-occurrence enrichment, or reconciliation semantics.
 * Side effects: None.
 */
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

/**
 * Projects a dynamic reconciliation record into a safe dynamic lookup report entry.
 *
 * Inputs: One dynamic record plus source-reference and demand-edge evidence lookups.
 * Outputs: A JsonDynamicLookup with safe identity, domain, likely keys, evidence, and axes.
 * Does not handle: Inferring missing key names, resolving dynamic expressions, or reconciling bindings.
 * Side effects: None.
 */
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
        : record.lookup.likelyKeys.map(toJsonKey).sort(
            /**
             * Orders converted likely keys by their displayed namespace/name form.
             *
             * Inputs: Two JSON logical keys.
             * Outputs: Their display-key comparator result.
             * Does not handle: Deduplicating keys, sanitizing the already converted values, or a total ordering; default-locale collation ties retain input order under stable Array.sort.
             * Side effects: None.
             */
            (left, right) => formatJsonKey(left).localeCompare(formatJsonKey(right)),
          ),
    sources,
    evidence: toJsonEvidence(record.lookup.evidenceChain),
    ...toJsonAxes(record),
    reasons: record.reasons.map(toJsonReason).sort(compareReason),
  };
}

/**
 * Converts one source reference and all matching demand-edge evidence into a safe occurrence.
 *
 * Inputs: A SecretReference and the report input's demand edges.
 * Outputs: A JsonSourceOccurrence with sanitized identity, location, and deduplicated evidence.
 * Does not handle: Validating whether the reference belongs to a particular key or resolving source text.
 * Side effects: None.
 */
function toJsonSource(
  reference: SecretReference,
  demandEdges: readonly DemandEdge[],
): JsonSourceOccurrence {
  const edgeEvidence = demandEdges
    .filter(
      /**
       * Retains demand edges attached to the reference being serialized.
       *
       * Inputs: One demand edge from reporting input.
       * Outputs: True when its reference id equals the current reference id.
       * Does not handle: Evidence deduplication or reference lookup.
       * Side effects: None.
       */
      (edge) => edge.referenceId === reference.id,
    )
    .flatMap(
      /**
       * Exposes the evidence chain carried by one matching demand edge.
       *
       * Inputs: One demand edge linked to the current reference.
       * Outputs: Its evidence entries.
       * Does not handle: Sanitizing or sorting evidence.
       * Side effects: None.
       */
      (edge) => edge.evidenceChain,
    );
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

/**
 * Renders a dynamic lookup's domain without exposing raw expression data.
 *
 * Inputs: One typed dynamic lookup edge.
 * Outputs: A finite, pattern, or unbounded JsonDynamicDomain with safe display fields.
 * Does not handle: Key inference, domain validation, or expression evaluation.
 * Side effects: None.
 */
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

/**
 * Sanitizes, deduplicates, and orders evidence chains for report output.
 *
 * Inputs: Typed evidence entries from references or demand edges.
 * Outputs: Unique JsonEvidence entries ordered by rule and diagnostic code.
 * Does not handle: Preserving raw snippets, validating location coordinates, or merging semantic duplicates with distinct locations.
 * Side effects: None.
 */
function toJsonEvidence(evidence: readonly Evidence[]): JsonEvidence[] {
  const values = evidence.map(
    /**
     * Converts one typed evidence fact into a report-safe evidence DTO.
     *
     * Inputs: One Evidence record.
     * Outputs: Safe rule and diagnostic identifiers with sorted converted locations.
     * Does not handle: Evidence deduplication or source-text extraction.
     * Side effects: Sorts the newly created locations array.
     */
    (item) => ({
    ruleId: safeIdentifier(item.ruleId),
    diagnosticCode: safeIdentifier(item.diagnosticCode),
    locations: item.locations.map(toJsonLocation).sort(compareLocation),
    }),
  );
  return dedupeEvidence(values).sort(compareEvidence);
}

/**
 * Copies a typed safe location into the JSON report location shape.
 *
 * Inputs: One SafeLocation with branded file path and zero-based coordinates.
 * Outputs: A JsonLocation with a rechecked safe path and unchanged coordinates.
 * Does not handle: Coordinate normalization, filesystem access, or source snippet retrieval.
 * Side effects: None.
 */
function toJsonLocation(location: SafeLocation): JsonLocation {
  return {
    path: safePath(location.file),
    start: { line: location.start.line, column: location.start.column },
    end: { line: location.end.line, column: location.end.column },
  };
}

/**
 * Projects a logical key into a JSON-safe namespace/name pair.
 *
 * Inputs: One typed logical key.
 * Outputs: A JsonLogicalKey preserving namespace and sanitizing the name.
 * Does not handle: Namespace validation, key equality, or raw-name recovery.
 * Side effects: None.
 */
function toJsonKey(key: LogicalKey): JsonLogicalKey {
  return { namespace: key.namespace, name: safeIdentifier(key.name) };
}

/**
 * Projects one execution scope into its sanitized report representation.
 *
 * Inputs: A typed execution scope.
 * Outputs: A JsonScope with safe identifiers and a report-shaped stage predicate.
 * Does not handle: Scope coverage matching, stage inference, or binding resolution.
 * Side effects: None.
 */
function toJsonScope(scope: ExecutionScope): JsonScope {
  return {
    id: safeIdentifier(scope.id),
    componentId: safeIdentifier(scope.componentId),
    phase: scope.phase,
    stage: toJsonStage(scope.stage),
    channel: scope.channel,
  };
}

/**
 * Converts a typed stage predicate into the schema's fixed-shape stage DTO.
 *
 * Inputs: One exact, any, or absent stage predicate.
 * Outputs: Its kind and, for exact predicates, values sorted with JavaScript's default string ordering.
 * Does not handle: Evaluating stage conditions or validating stage availability.
 * Side effects: Sorts a newly created exact-stage values array.
 */
function toJsonStage(stage: StagePredicate): JsonScope["stage"] {
  if (stage.kind !== "exact") {
    return { kind: stage.kind };
  }
  return { kind: "exact", values: stage.values.map(safeIdentifier).sort() };
}

/**
 * Copies a reconciliation record's independent status axes into report form.
 *
 * Inputs: One aggregate reconciliation result.
 * Outputs: The target, demand, binding, inventory, coverage, constraint, and disposition axes.
 * Does not handle: Deriving statuses, applying precedence, or explaining reasons.
 * Side effects: None.
 */
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

/**
 * Converts one reconciliation reason into a safe reason DTO with independently sorted identifier arrays.
 *
 * Inputs: A typed reason with optional gap and candidate identifiers.
 * Outputs: A JsonReason with sanitized code and sorted safe identifier arrays.
 * Does not handle: Resolving identifiers or inferring omitted reasons.
 * Side effects: Sorts newly created identifier arrays.
 */
function toJsonReason(reason: ReconciliationReason): JsonReason {
  return {
    code: safeIdentifier(reason.code),
    gapIds: (reason.gapIds ?? []).map(safeIdentifier).sort(),
    candidateIds: (reason.candidateIds ?? []).map(safeIdentifier).sort(),
  };
}

/**
 * Projects one scope-coverage fact into the report schema.
 *
 * Inputs: A typed scope coverage state and its gap identifiers.
 * Outputs: A JsonScopeCoverage with safe scope and sorted sanitized gaps.
 * Does not handle: Computing coverage or expanding gap details.
 * Side effects: Sorts a newly created gap-id array.
 */
function toJsonScopeCoverage(coverage: ScopeCoverage): JsonScopeCoverage {
  return {
    scope: toJsonScope(coverage.scope),
    state: coverage.state,
    gapIds: coverage.gapIds.map(safeIdentifier).sort(),
  };
}

/**
 * Obtains the logical key represented by a non-dynamic reconciliation record.
 *
 * Inputs: One reconciliation record of any kind.
 * Outputs: Its demand key or inventory destination, or undefined for a dynamic record.
 * Does not handle: Dynamic-domain keys, identifier sanitization, or key equality.
 * Side effects: None.
 */
function recordKey(record: ReconciliationRecord): LogicalKey | undefined {
  if (record.kind === "demand") {
    return record.key;
  }
  if (record.kind === "inventory") {
    return record.destination;
  }
  return undefined;
}

/**
 * Builds a local grouping identifier that keeps unsafe key names from colliding.
 *
 * Inputs: One logical key and the next opaque-key sequence number.
 * Outputs: A namespace/name identifier or a namespace/opaque-sequence identifier.
 * Does not handle: Producing a report-safe identifier or stable identity across runs for opaque values.
 * Side effects: None.
 */
function groupIdentifier(key: LogicalKey, opaqueSequence: number): string {
  if (typeof key.name !== "string") {
    return `${key.namespace}:opaque:${opaqueSequence}`;
  }
  return `${key.namespace}:${key.name}`;
}

/**
 * Rechecks a supposed identifier before it reaches any report renderer.
 *
 * Inputs: A branded identifier or arbitrary string.
 * Outputs: The value when reportable, otherwise the opaque identifier marker.
 * Does not handle: Validation-error diagnostics or recovery of redacted text.
 * Side effects: None.
 */
function safeIdentifier(value: Identifier | string): string {
  return typeof value === "string" && isReportableText(value) ? value : OPAQUE_IDENTIFIER;
}

/**
 * Rechecks a path-like value and replaces unsafe paths with one opaque marker.
 *
 * Inputs: A candidate slash-delimited path string.
 * Outputs: The path when every segment is reportable, otherwise the opaque-path marker.
 * Does not handle: Filesystem normalization, existence checks, or raw-path recovery.
 * Side effects: None.
 */
function safePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER.test(value)) {
    return OPAQUE_PATH;
  }
  const segments = value.split("/");
  return segments.every(
    /**
     * Checks that one path segment is nontraversal and safe for public reporting.
     *
     * Inputs: One slash-separated path segment.
     * Outputs: True when the segment is nonempty, non-dot, and reportable text.
     * Does not handle: Filesystem containment or multi-segment path normalization.
     * Side effects: None.
     */
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && isReportableText(segment),
  )
    ? value
    : OPAQUE_PATH;
}

/**
 * Rejects control characters, overlong strings, credential-shaped text, and secret-like tokens from report fields.
 *
 * Inputs: One arbitrary candidate string.
 * Outputs: True only for bounded noncredential-like display text.
 * Does not handle: Semantic identifier validation or a guarantee that harmless text is non-sensitive.
 * Side effects: None.
 */
function isReportableText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !CONTROL_CHARACTER.test(value) &&
    !CREDENTIAL_LIKE.test(value) &&
    !isSecretLikeToken(value)
  );
}

/**
 * Formats a safe dynamic-key pattern for display while preserving wildcard placement.
 *
 * Inputs: A typed prefix, suffix, or surrounded key pattern.
 * Outputs: A display string whose variable components are sanitized identifiers.
 * Does not handle: Regex generation, pattern matching, or recovery of unsafe portions.
 * Side effects: None.
 */
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

/**
 * Compares a typed logical key to its sanitized JSON representation.
 *
 * Inputs: One logical key and one report key candidate.
 * Outputs: True when namespace and safe converted name are equal.
 * Does not handle: Matching non-string names or equivalence across namespaces.
 * Side effects: None.
 */
function keysMatchJson(key: LogicalKey, candidate: JsonLogicalKey): boolean {
  return (
    typeof key.name === "string" &&
    key.namespace === candidate.namespace &&
    safeIdentifier(key.name) === candidate.name
  );
}

/**
 * Removes duplicate report scopes using the renderer's full scope key and sorts survivors.
 *
 * Inputs: JSON scopes from grouped uses.
 * Outputs: Unique scopes ordered by current-runtime default-locale comparison of their serialized scope keys; equal comparator results preserve prior input order.
 * Does not handle: Merging semantically similar but structurally distinct stages.
 * Side effects: Mutates a local result array only.
 */
function uniqueScopes(scopes: readonly JsonScope[]): JsonScope[] {
  const result: JsonScope[] = [];
  for (const scope of scopes) {
    if (!result.some(
      /**
       * Checks whether a retained scope has the same complete serialized scope key.
       *
       * Inputs: One previously retained JSON scope.
       * Outputs: True when it is equivalent to the scope currently being considered.
       * Does not handle: Partial-scope matching or stage-predicate inference.
       * Side effects: None.
       */
      (candidate) => scopeKey(candidate) === scopeKey(scope),
    )) {
      result.push(scope);
    }
  }
  return result.sort(compareScope);
}

/**
 * Removes report evidence entries with identical identifiers and serialized location arrays.
 *
 * Inputs: Already-sanitized JSON evidence entries.
 * Outputs: The first entry for each exact evidence identity.
 * Does not handle: Deep semantic equivalence beyond matching rule, code, and location JSON.
 * Side effects: Mutates a local result array only.
 */
function dedupeEvidence(values: readonly JsonEvidence[]): JsonEvidence[] {
  const result: JsonEvidence[] = [];
  for (const value of values) {
    const identifier = `${value.ruleId}\u0000${value.diagnosticCode}\u0000${JSON.stringify(value.locations)}`;
    if (!result.some(
      /**
       * Tests whether a retained evidence item has the current serialized identity.
       *
       * Inputs: One previously retained JSON evidence item.
       * Outputs: True when its rule, diagnostic, and locations equal the current identity.
       * Does not handle: Source-order comparison or semantic evidence merging.
       * Side effects: Serializes the candidate's safe locations for comparison.
       */
      (candidate) => `${candidate.ruleId}\u0000${candidate.diagnosticCode}\u0000${JSON.stringify(candidate.locations)}` === identifier,
    )) {
      result.push(value);
    }
  }
  return result;
}

/**
 * Returns the first occurrence of each string without applying an order.
 *
 * Inputs: A readonly string collection.
 * Outputs: A new array with duplicate strings removed.
 * Does not handle: Sorting, normalization, or safety validation.
 * Side effects: None.
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Orders report groups by their displayed logical-key text.
 *
 * Inputs: Two JSON reference groups.
 * Outputs: A current-runtime default-locale comparator result for namespace/name display keys.
 * Does not handle: Stable tie breaking beyond equal formatted keys; callers' stable sorts retain prior input order on a zero result.
 * Side effects: None.
 */
function compareGroup(left: JsonReferenceGroup, right: JsonReferenceGroup): number {
  return formatJsonKey(left.key).localeCompare(formatJsonKey(right.key));
}

/**
 * Orders dynamic lookup entries by safe identifier.
 *
 * Inputs: Two JSON dynamic lookups.
 * Outputs: Their current-runtime default-locale identifier comparator result.
 * Does not handle: Domain or source-location tie breaking; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareDynamic(left: JsonDynamicLookup, right: JsonDynamicLookup): number {
  return left.id.localeCompare(right.id);
}

/**
 * Orders scope coverage entries using their full normalized scope ordering.
 *
 * Inputs: Two JSON scope-coverage entries.
 * Outputs: The delegated current-runtime default-locale scope comparator result.
 * Does not handle: Coverage-state tie breaking; a zero delegated result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareCoverage(left: JsonScopeCoverage, right: JsonScopeCoverage): number {
  return compareScope(left.scope, right.scope);
}

/**
 * Orders JSON scopes by a stable serialization of identity, phase, channel, and stage.
 *
 * Inputs: Two JSON scopes.
 * Outputs: A current-runtime default-locale comparator result for their complete scope keys.
 * Does not handle: Interpreting stage semantics, resolving scope aliases, or tie breaking; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareScope(left: JsonScope, right: JsonScope): number {
  return scopeKey(left).localeCompare(scopeKey(right));
}

/**
 * Constructs the internal serialized key used for scope equality and sorting.
 *
 * Inputs: One JSON scope.
 * Outputs: A NUL-separated string including safe id, phase, channel, and serialized stage.
 * Does not handle: Human-readable formatting or a collision-resistant external identifier.
 * Side effects: Serializes the scope's stage object.
 */
function scopeKey(scope: JsonScope): string {
  return `${scope.id}\u0000${scope.phase}\u0000${scope.channel}\u0000${JSON.stringify(scope.stage)}`;
}

/**
 * Orders grouped uses first by optional scope id and then by record kind.
 *
 * Inputs: Two JSON use records.
 * Outputs: A current-runtime default-locale comparator result with unscoped uses represented by a fixed marker.
 * Does not handle: Ordering by source location, disposition, reasons, or a full tie break; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareUse(left: JsonUse, right: JsonUse): number {
  const scope = (left.scope?.id ?? UNSCOPED).localeCompare(right.scope?.id ?? UNSCOPED);
  return scope !== 0 ? scope : left.kind.localeCompare(right.kind);
}

/**
 * Orders source occurrences by safe path, start line, and reference identifier.
 *
 * Inputs: Two JSON source occurrences.
 * Outputs: A comparator result using current-runtime default-locale path/reference comparisons and numeric start lines.
 * Does not handle: End-coordinate ordering or a full tie break when listed fields tie; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareSource(left: JsonSourceOccurrence, right: JsonSourceOccurrence): number {
  const path = left.location.path.localeCompare(right.location.path);
  if (path !== 0) return path;
  const line = left.location.start.line - right.location.start.line;
  return line !== 0 ? line : left.referenceId.localeCompare(right.referenceId);
}

/**
 * Orders safe locations by path, start line, and start column.
 *
 * Inputs: Two JSON locations.
 * Outputs: A comparator result using current-runtime default-locale paths and numeric start coordinates.
 * Does not handle: End-coordinate tie breaking, filesystem canonicalization, or a full tie break; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareLocation(left: JsonLocation, right: JsonLocation): number {
  const path = left.path.localeCompare(right.path);
  if (path !== 0) return path;
  const line = left.start.line - right.start.line;
  return line !== 0 ? line : left.start.column - right.start.column;
}

/**
 * Orders safe evidence items by rule identifier then diagnostic code.
 *
 * Inputs: Two JSON evidence entries.
 * Outputs: A current-runtime default-locale comparator result.
 * Does not handle: Location ordering when rule and diagnostic match; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareEvidence(left: JsonEvidence, right: JsonEvidence): number {
  const rule = left.ruleId.localeCompare(right.ruleId);
  return rule !== 0 ? rule : left.diagnosticCode.localeCompare(right.diagnosticCode);
}

/**
 * Orders reason entries by their safe code.
 *
 * Inputs: Two JSON reasons.
 * Outputs: A current-runtime default-locale code comparator result.
 * Does not handle: Gap or candidate identifier tie breaking; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareReason(left: JsonReason, right: JsonReason): number {
  return left.code.localeCompare(right.code);
}

/**
 * Formats a JSON logical key for report ordering and user-facing headings.
 *
 * Inputs: One already-sanitized JSON logical key.
 * Outputs: Its namespace:name display string.
 * Does not handle: Sanitization, escaping, or namespace validation.
 * Side effects: None.
 */
function formatJsonKey(key: JsonLogicalKey): string {
  return `${key.namespace}:${key.name}`;
}

/**
 * Produces the safe explain-report heading for one dynamic lookup.
 *
 * Inputs: A JSON dynamic lookup.
 * Outputs: A fixed unbounded heading or a heading containing the safe domain display text.
 * Does not handle: Raw expression display or likely-key listing.
 * Side effects: None.
 */
function dynamicHeading(dynamic: JsonDynamicLookup): string {
  if (dynamic.domain.kind === "unbounded") {
    return "Explain unbounded environment lookup";
  }
  return `Explain dynamic lookup ${dynamic.domain.display}`;
}

/**
 * Extracts the independent reconciliation axes from one use report entry.
 *
 * Inputs: A JSON use record.
 * Outputs: Its status-axis object.
 * Does not handle: Reasons, scope, source evidence, or status computation.
 * Side effects: None.
 */
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

/**
 * Extracts the independent reconciliation axes from one dynamic lookup report entry.
 *
 * Inputs: A JSON dynamic lookup.
 * Outputs: Its status-axis object.
 * Does not handle: Dynamic domain, source evidence, or status computation.
 * Side effects: None.
 */
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
