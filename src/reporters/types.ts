import type {
  AggregateResult,
  DemandEdge,
  DynamicLookupEdge,
  Evidence,
  LogicalKey,
  ReconciliationReason,
  ReconciliationResult,
  SafeIdentifier,
  SecretReference,
  StagePredicate,
} from "../core/index.js";

/** Stable, deterministic on-disk JSON schema. */
export const REPORT_SCHEMA_VERSION = "secret-reference-inventory/report/v1" as const;
export const SARIF_SCHEMA_VERSION = "2.1.0" as const;

/**
 * Reporter inputs are already materialized, value-free Core facts. Reporters
 * must never accept source text, parser errors, or provider responses.
 */
export interface ReportingInput {
  readonly result: ReconciliationResult;
  readonly references?: readonly SecretReference[];
  readonly demandEdges?: readonly DemandEdge[];
}

export interface JsonPosition {
  readonly line: number;
  readonly column: number;
}

export interface JsonLocation {
  readonly path: string;
  readonly start: JsonPosition;
  readonly end: JsonPosition;
}

export interface JsonLogicalKey {
  readonly namespace: LogicalKey["namespace"];
  readonly name: string;
}

export interface JsonStagePredicate {
  readonly kind: StagePredicate["kind"];
  readonly values?: readonly string[];
}

export interface JsonScope {
  readonly id: string;
  readonly componentId: string;
  readonly phase: string;
  readonly stage: JsonStagePredicate;
  readonly channel: string;
}

export interface JsonEvidence {
  readonly ruleId: string;
  readonly diagnosticCode: string;
  readonly locations: readonly JsonLocation[];
}

export interface JsonSourceOccurrence {
  readonly referenceId: string;
  readonly demand: string;
  readonly operation: string;
  readonly resolution: string;
  readonly confidence: string;
  readonly exposure: string;
  readonly location: JsonLocation;
  readonly evidence: readonly JsonEvidence[];
}

export interface JsonAxes {
  readonly targetDiscovery: AggregateResult["targetDiscovery"];
  readonly demand: AggregateResult["demand"];
  readonly binding: AggregateResult["binding"];
  readonly inventory: AggregateResult["inventory"];
  readonly coverage: AggregateResult["coverage"];
  readonly constraint: AggregateResult["constraint"];
  readonly disposition: AggregateResult["disposition"];
}

export interface JsonReason {
  readonly code: string;
  readonly gapIds: readonly string[];
  readonly candidateIds: readonly string[];
}

export interface JsonUse extends JsonAxes {
  readonly kind: "demand" | "inventory";
  readonly scope?: JsonScope;
  readonly referenceIds: readonly string[];
  readonly providerResource?: {
    readonly authorityId: string;
    readonly canonicalId: string;
  };
  readonly inventorySnapshot?: {
    readonly authorityId: string;
    readonly asOf: string;
  };
  readonly reasons: readonly JsonReason[];
}

export interface JsonReferenceGroup {
  readonly key: JsonLogicalKey;
  readonly shared: boolean;
  readonly consumers: readonly JsonScope[];
  readonly sources: readonly JsonSourceOccurrence[];
  readonly uses: readonly JsonUse[];
}

export interface JsonDynamicDomain {
  readonly kind: "finite" | "pattern" | "unbounded";
  readonly display: string;
  readonly patternId?: string;
  readonly reason?: "user-controlled" | "opaque" | "over-budget";
}

export interface JsonDynamicLookup extends JsonAxes {
  readonly id: string;
  readonly scope: JsonScope;
  readonly origin: DynamicLookupEdge["origin"];
  readonly domain: JsonDynamicDomain;
  readonly likelyKeys: readonly JsonLogicalKey[];
  readonly sources: readonly JsonSourceOccurrence[];
  readonly evidence: readonly JsonEvidence[];
  readonly reasons: readonly JsonReason[];
}

export interface JsonScopeCoverage {
  readonly scope: JsonScope;
  readonly state: "complete" | "incomplete";
  readonly gapIds: readonly string[];
}

export interface JsonReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly groups: readonly JsonReferenceGroup[];
  readonly dynamicLookups: readonly JsonDynamicLookup[];
  readonly scopeCoverage: readonly JsonScopeCoverage[];
}

/** A safe selector supplied by CLI parsing; reporters never echo raw query text. */
export type ExplainSelector =
  | { readonly kind: "key"; readonly key: LogicalKey }
  | { readonly kind: "dynamic"; readonly id: SafeIdentifier };

export interface ExplainEvidence {
  readonly title: string;
  readonly evidence: readonly JsonEvidence[];
}

export interface ExplainReport {
  readonly selector: ExplainSelector["kind"];
  readonly heading: string;
  readonly axes: readonly JsonAxes[];
  readonly sources: readonly JsonSourceOccurrence[];
  readonly evidence: readonly ExplainEvidence[];
  readonly dynamic?: JsonDynamicLookup;
}

export interface SarifLog {
  readonly version: typeof SARIF_SCHEMA_VERSION;
  readonly $schema: "https://json.schemastore.org/sarif-2.1.0.json";
  readonly runs: readonly SarifRun[];
}

export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: "secret-reference-inventory";
      readonly informationUri: "https://github.com/openai/secret-reference-inventory";
      readonly rules: readonly SarifRule[];
    };
  };
  readonly results: readonly SarifResult[];
}

export interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
  readonly defaultConfiguration: { readonly level: "note" | "warning" | "error" };
}

export interface SarifResult {
  readonly ruleId: string;
  readonly level: "note" | "warning" | "error";
  readonly message: { readonly text: string };
  readonly locations?: readonly {
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string };
      readonly region: {
        readonly startLine: number;
        readonly startColumn: number;
        readonly endLine: number;
        readonly endColumn: number;
      };
    };
  }[];
  readonly properties: {
    readonly axes: JsonAxes;
    readonly scope?: JsonScope;
    readonly key?: JsonLogicalKey;
    readonly dynamic?: JsonDynamicDomain;
    readonly inventorySnapshot?: JsonUse["inventorySnapshot"];
    readonly reasons: readonly JsonReason[];
  };
}

export type ReporterRecord = {
  readonly axes: AggregateResult;
  readonly reasons: readonly ReconciliationReason[];
};

