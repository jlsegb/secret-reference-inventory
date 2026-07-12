/**
 * Wire-level contracts for local, data-only provisioning inputs.
 *
 * These deliberately are not Core facts.  They carry strings only for the
 * duration of parsing and are handed immediately to a caller-provided
 * FactBuilder.  The builder is the only boundary allowed to turn input text
 * into safe, reportable Core identifiers, paths, locations, or facts.
 */

export const BINDING_MANIFEST_SCHEMA_VERSION = "binding-manifest/v1" as const;
export const INVENTORY_SNAPSHOT_SCHEMA_VERSION = "inventory-snapshot/v1" as const;
export const CLOSED_MODEL_SCHEMA_VERSION = "closed-provisioning-model/v1" as const;

export type BindingAdapterDiagnosticCode =
  | "invalid-input-shape"
  | "invalid-schema-version"
  | "unknown-field"
  | "missing-field"
  | "invalid-string"
  | "invalid-enum"
  | "invalid-array"
  | "invalid-stage-predicate"
  | "invalid-condition-predicate"
  | "invalid-scope-selector"
  | "invalid-provider-resource"
  | "invalid-precedence"
  | "invalid-timestamp"
  | "duplicate-candidate"
  | "invalid-closed-model"
  | "model-domain-over-budget"
  | "unproven-dynamic-domain"
  | "unsafe-identifier"
  | "input-entry-limit-exceeded";

/**
 * Paths intentionally contain only parser-authored field names and numeric
 * array indices.  Unknown input property names are never copied into them.
 */
export type BindingAdapterPath = readonly (string | number)[];

export interface BindingAdapterDiagnostic {
  readonly code: BindingAdapterDiagnosticCode;
  readonly path: BindingAdapterPath;
}

export type RawPhase = "runtime" | "build" | "test" | "dev" | "ci" | "unknown";

export type RawDeliveryChannel =
  | "environment"
  | "build-substitution"
  | "mounted-file"
  | "provider-sdk"
  | "unknown";

export type RawLogicalNamespace = "env" | "config" | "secret-manager";

export type RawStagePredicate =
  | { readonly kind: "exact"; readonly values: readonly string[] }
  | { readonly kind: "all" }
  | { readonly kind: "unknown" };

export interface RawExecutionScope {
  readonly id: string;
  readonly componentId: string;
  readonly phase: RawPhase;
  readonly stage: RawStagePredicate;
  readonly channel: RawDeliveryChannel;
}

export interface RawConditionClause {
  readonly key: string;
  readonly operator: "equals" | "not-equals";
  readonly value: string;
}

export type RawConditionPredicate =
  | { readonly kind: "always" }
  | { readonly kind: "all"; readonly clauses: readonly RawConditionClause[] }
  | { readonly kind: "unknown" };

export interface RawScopeSelector {
  readonly executionUnitIds?: readonly string[];
  readonly phases?: readonly RawPhase[];
  readonly stage: RawStagePredicate;
  readonly channels?: readonly RawDeliveryChannel[];
  readonly condition: RawConditionPredicate;
}

export interface RawLogicalKey {
  readonly namespace: RawLogicalNamespace;
  readonly name: string;
}

export interface RawProviderResourceId {
  readonly authorityId: string;
  readonly canonicalId: string;
}

export interface RawBindingCandidate {
  readonly id: string;
  readonly adapterId: string;
  readonly scope: RawExecutionScope;
  readonly destination: RawLogicalKey;
  readonly sourceKind: "manifest" | "secret-manager" | "external";
  readonly providerResourceId?: RawProviderResourceId;
  readonly appliesWhen: RawScopeSelector;
  readonly precedence: {
    readonly source: string;
    readonly rank?: number;
    readonly comparable: boolean;
  };
  readonly resolution: "exact" | "dynamic";
}

export interface RawBindingManifest {
  readonly schemaVersion: typeof BINDING_MANIFEST_SCHEMA_VERSION;
  readonly inputId: string;
  readonly adapterId: string;
  readonly candidates: readonly RawBindingCandidate[];
}

export interface RawInventoryItem {
  readonly providerResourceId: RawProviderResourceId;
  readonly declaredScopes?: readonly RawExecutionScope[];
}

export interface RawInventorySnapshot {
  readonly schemaVersion: typeof INVENTORY_SNAPSHOT_SCHEMA_VERSION;
  readonly inputId: string;
  readonly authorityId: string;
  readonly asOf: string;
  readonly items: readonly RawInventoryItem[];
}

export interface RawCoverageGap {
  readonly idHint: string;
  /** Closed-model failures are binding coverage gaps in the Core contract. */
  readonly domain: "binding" | "inventory";
  readonly inputId: string;
  readonly pathOrAdapterId: string;
  readonly potentiallyAffects: RawScopeSelector;
  readonly reason: BindingAdapterDiagnosticCode;
}

export interface RawExpectedAdapterInput {
  /**
   * Explicit local coverage-input identity. It is never inferred from an
   * adapter name because two independent manifests can use the same adapter.
   */
  readonly inputId: string;
  readonly domain: "demand" | "binding" | "inventory";
  readonly adapterId?: string;
  readonly extensions?: readonly string[];
}

export interface RawPermittedExclusion {
  readonly selector: RawScopeSelector;
  readonly rationaleCode: string;
}

export interface RawInventoryAuthority {
  readonly authorityId: string;
  readonly inventoryInputId: string;
}

export interface RawExternalMechanism {
  readonly selector: RawScopeSelector;
  readonly mechanismId: string;
}

export interface RawClosedModelScope {
  readonly scope: RawExecutionScope;
  readonly declaredStages: readonly string[];
  readonly closed: boolean;
  readonly approvedFirstPartyRoots: readonly string[];
  readonly bindingRoots: readonly string[];
  readonly expectedAdapterInputs: readonly RawExpectedAdapterInput[];
  readonly permittedExclusions: readonly RawPermittedExclusion[];
  readonly inventoryAuthorities: readonly RawInventoryAuthority[];
  readonly allowedExternalMechanisms: readonly RawExternalMechanism[];
  readonly outsideRootImports: "out-of-scope" | "included";
}

export interface RawClosedModelDomain {
  readonly patternId: string;
  readonly selector: RawScopeSelector;
  readonly keys: readonly string[];
}

export interface RawClosedProvisioningModel {
  readonly schemaVersion: typeof CLOSED_MODEL_SCHEMA_VERSION;
  readonly inputId: string;
  readonly maxFiniteKeyDomain: number;
  readonly scopes: readonly RawClosedModelScope[];
  /**
   * Parsed declarative domains. They are intentionally omitted before Core
   * materialization unless a trusted code adapter separately proves a selector
   * constraint; see `parseClosedProvisioningModel`.
   */
  readonly dynamicDomains: readonly RawClosedModelDomain[];
}

export type FactBuilderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BindingAdapterDiagnosticCode };

/**
 * The sole adapter-to-Core/safety boundary.
 *
 * Implementations validate and materialize safe facts.  They must not retain
 * raw input strings on failure.  Keeping this interface generic prevents the
 * adapter from importing Core or safety brands before their public contracts
 * are settled.
 */
export interface BindingAdapterFactBuilder<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
> {
  readonly bindingCandidate: (
    input: RawBindingCandidate,
  ) => FactBuilderResult<TBindingCandidate>;
  readonly inventorySnapshot: (
    input: RawInventorySnapshot,
  ) => FactBuilderResult<TInventorySnapshot>;
  readonly closedModel: (
    input: RawClosedProvisioningModel,
  ) => FactBuilderResult<TClosedModel>;
  readonly coverageGap: (input: RawCoverageGap) => FactBuilderResult<TCoverageGap>;
}

/**
 * Core owns actual binding selection.  The adapter preserves candidates,
 * conditions, stage predicates, and precedence verbatim for this port.
 */
export interface BindingResolutionPort<TBindingCandidate, TBindingResolution> {
  readonly resolve: (
    candidates: readonly TBindingCandidate[],
  ) => readonly TBindingResolution[];
}

export interface BindingManifestParseResult<TBindingCandidate, TCoverageGap> {
  readonly candidates: readonly TBindingCandidate[];
  readonly coverageGaps: readonly TCoverageGap[];
  readonly diagnostics: readonly BindingAdapterDiagnostic[];
}

export interface InventorySnapshotParseResult<TInventorySnapshot, TCoverageGap> {
  readonly snapshot?: TInventorySnapshot;
  readonly coverageGaps: readonly TCoverageGap[];
  readonly diagnostics: readonly BindingAdapterDiagnostic[];
}

export interface ClosedModelParseResult<TClosedModel, TCoverageGap> {
  readonly model?: TClosedModel;
  readonly coverageGaps: readonly TCoverageGap[];
  readonly diagnostics: readonly BindingAdapterDiagnostic[];
}
