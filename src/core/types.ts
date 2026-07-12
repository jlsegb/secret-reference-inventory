/**
 * Normalized, value-free facts exchanged by scanners, binding adapters, and
 * reporters.  This module deliberately imports only the core-independent
 * safety brands; SafetyFactory may depend on these contracts, but Core never
 * imports SafetyFactory, avoiding a dependency cycle.
 */

export type {
  Identifier,
  OpaqueIdentifier,
  SafeDiagnosticCode,
  SafeIdentifier,
  SafeLocation as Location,
  SafePath,
  SafePosition as Position,
  SafeTimestamp,
  SanitizedDiagnostic,
} from "../safety/types.js";

import type {
  Identifier,
  SafeDiagnosticCode,
  SafeIdentifier,
  SafeLocation,
  SafePath,
  SafeTimestamp,
} from "../safety/types.js";

export type ReferenceResolution =
  | "literal"
  | "constant-folded"
  | "wrapper-resolved"
  | "dynamic";

export type Phase = "runtime" | "build" | "test" | "dev" | "ci" | "unknown";

export type StagePredicate =
  | { readonly kind: "exact"; readonly values: readonly SafeIdentifier[] }
  | { readonly kind: "all" }
  | { readonly kind: "unknown" };

export type DeliveryChannel =
  | "environment"
  | "build-substitution"
  | "mounted-file"
  | "provider-sdk"
  | "unknown";

export type LogicalNamespace = "env" | "config" | "secret-manager";

/** A logical destination key, never a secret value. */
export interface LogicalKey {
  readonly namespace: LogicalNamespace;
  readonly name: Identifier;
}

/** A deployable target plus its execution semantics. */
export interface ExecutionScope {
  readonly id: SafeIdentifier;
  readonly componentId: SafeIdentifier;
  readonly phase: Phase;
  readonly stage: StagePredicate;
  readonly channel: DeliveryChannel;
}

export interface ConditionClause {
  readonly key: SafeIdentifier;
  readonly operator: "equals" | "not-equals";
  readonly value: SafeIdentifier;
}

export type ConditionPredicate =
  | { readonly kind: "always" }
  | { readonly kind: "all"; readonly clauses: readonly ConditionClause[] }
  | { readonly kind: "unknown" };

/** A selector may cover more than one concrete execution scope. */
export interface ScopeSelector {
  readonly executionUnitIds?: readonly SafeIdentifier[];
  readonly phases?: readonly Phase[];
  readonly stage: StagePredicate;
  readonly channels?: readonly DeliveryChannel[];
  readonly condition: ConditionPredicate;
}

export type DemandKind =
  | "direct-read"
  | "eager-validation"
  | "declaration-only"
  | "wrapper-definition"
  | "literal-indicator";

export interface Evidence {
  readonly ruleId: SafeIdentifier;
  readonly diagnosticCode: SafeDiagnosticCode;
  readonly locations: readonly SafeLocation[];
}

/** Provider-qualified identity; both fields must exactly match for a join. */
export interface ProviderResourceId {
  readonly authorityId: SafeIdentifier;
  readonly canonicalId: SafeIdentifier;
}

export interface SecretReference {
  readonly id: SafeIdentifier;
  readonly requested: LogicalKey;
  readonly demand: DemandKind;
  readonly operation: "read" | "validate" | "wrapper" | "literal";
  readonly resolution: ReferenceResolution;
  readonly confidence: "high" | "medium" | "review";
  readonly location: SafeLocation;
  readonly exposure: "server" | "client" | "worker" | "tooling" | "unknown";
  readonly evidenceChain: readonly Evidence[];
}

/** One source reference can reach many first-party execution scopes. */
export interface DemandEdge {
  readonly id: SafeIdentifier;
  readonly referenceId: SafeIdentifier;
  readonly scope: ExecutionScope;
  readonly origin: "direct" | "consumer-derived";
  readonly evidenceChain: readonly Evidence[];
}

/** A safe glob with exactly one wildcard and at least one fixed segment. */
export type SafeKeyPattern =
  | {
      readonly kind: "prefix";
      readonly patternId: SafeIdentifier;
      readonly prefix: SafeIdentifier;
    }
  | {
      readonly kind: "suffix";
      readonly patternId: SafeIdentifier;
      readonly suffix: SafeIdentifier;
    }
  | {
      readonly kind: "surrounded";
      readonly patternId: SafeIdentifier;
      readonly prefix: SafeIdentifier;
      readonly suffix: SafeIdentifier;
    };

export type DynamicKeyDomain =
  | { readonly kind: "finite"; readonly keys: readonly SafeIdentifier[] }
  | { readonly kind: "pattern"; readonly pattern: SafeKeyPattern }
  | {
      readonly kind: "unbounded";
      readonly reason: "user-controlled" | "opaque" | "over-budget";
    };

export type DynamicKeyOrigin = "lexical" | "user-controlled" | "opaque";

/**
 * A non-exact environment-key lookup. `likelyKeys` is derived, never a source
 * of truth: finite = exact finite set, pattern = matching known destinations,
 * and unbounded = empty.
 */
export interface DynamicLookupEdge {
  readonly id: SafeIdentifier;
  readonly referenceId: SafeIdentifier;
  readonly scope: ExecutionScope;
  readonly domain: DynamicKeyDomain;
  readonly origin: DynamicKeyOrigin;
  readonly patternConstraint?: "adapter-proven" | "not-proven";
  readonly likelyKeys: readonly LogicalKey[];
  readonly evidenceChain: readonly Evidence[];
}

export interface BindingCandidate {
  readonly id: SafeIdentifier;
  readonly adapterId: SafeIdentifier;
  readonly scope: ExecutionScope;
  readonly destination: LogicalKey;
  readonly sourceKind: "manifest" | "secret-manager" | "external";
  readonly providerResourceId?: ProviderResourceId;
  readonly appliesWhen: ScopeSelector;
  readonly precedence: {
    readonly source: SafeIdentifier;
    readonly rank?: number;
    readonly comparable: boolean;
  };
  readonly resolution: "exact" | "dynamic";
  readonly location?: SafeLocation;
}

export type BindingPartitionOutcome = "effective" | "conflicting" | "unresolved";
export type BindingCandidateSelectionStatus =
  | "effective"
  | "shadowed"
  | "inapplicable"
  | "conflicting"
  | "unresolved";

export interface BindingCandidateSelection {
  readonly candidateId: SafeIdentifier;
  readonly status: BindingCandidateSelectionStatus;
}

/** Candidate selection is resolved independently of code demand. */
export interface BindingResolution {
  readonly scope: ExecutionScope;
  readonly destination: LogicalKey;
  readonly partitions: readonly {
    readonly appliesWhen: ScopeSelector;
    readonly outcome: BindingPartitionOutcome;
    readonly selections: readonly BindingCandidateSelection[];
  }[];
  readonly accessEvidence: "not-evaluated";
}

export interface InventoryItem {
  readonly providerResourceId: ProviderResourceId;
  readonly declaredScopes?: readonly ExecutionScope[];
}

export interface InventorySnapshot {
  /** Safe local-export identity; required for strong closed-model conclusions. */
  readonly inputId?: SafeIdentifier;
  readonly authorityId: SafeIdentifier;
  readonly asOf: SafeTimestamp;
  readonly items: readonly InventoryItem[];
}

export type CoverageDomain = "demand" | "binding" | "inventory";

export type KeyDomainSelector =
  | { readonly kind: "all-environment" }
  | { readonly kind: "keys"; readonly keys: readonly LogicalKey[] }
  | { readonly kind: "pattern"; readonly pattern: SafeKeyPattern };

/** A conservative coverage or opaque-binding uncertainty. */
export interface CoverageGap {
  readonly id: SafeIdentifier;
  readonly domain: CoverageDomain;
  readonly inputId: SafeIdentifier;
  readonly pathOrAdapterId: SafePath | SafeIdentifier;
  readonly potentiallyAffects: ScopeSelector;
  readonly keyDomain?: KeyDomainSelector;
  readonly reason: SafeDiagnosticCode;
}

export interface ScopeCoverage {
  readonly scope: ExecutionScope;
  readonly state: "complete" | "incomplete";
  readonly gapIds: readonly SafeIdentifier[];
}

/** Completion evidence is supplied by discovery/adapters; Core never assumes it. */
export interface CoverageInputStatus {
  readonly inputId: SafeIdentifier;
  readonly domain: CoverageDomain;
  readonly state: CoverageState;
  readonly selector: ScopeSelector;
}

export type TargetDiscoveryStatus =
  | "deployable"
  | "consumer-derived"
  | "internal-only"
  | "external-consumer-possible"
  | "unknown-target";

export type BindingStatus =
  | "exact-declared"
  | "possible"
  | "indirect"
  | "conflicting"
  | "unresolved"
  | "no-static-evidence"
  | "external-unknown"
  | "static-constrained"
  | "dynamic"
  | "not-applicable";

export type InventoryStatus =
  | "bound"
  | "inventory-listed-no-static-read"
  | "missing"
  | "missing-under-declared-model"
  | "unbound"
  | "unknown";

export type DemandStatus =
  | "present"
  | "declaration-only"
  | "finite-dynamic"
  | "pattern-dynamic"
  | "unbounded-user-controlled"
  | "unbounded-unknown"
  | "absent";

export type ConstraintStatus = "none" | "client-exposure" | "out-of-scope" | "other";
export type CoverageState = "complete" | "incomplete";
export type Disposition = "informational" | "review" | "inconclusive";

export interface ScopedTargetStatus {
  readonly scope: ExecutionScope;
  readonly status: TargetDiscoveryStatus;
}

/** Explicit user assertion needed before a strong absence conclusion. */
export interface ClosedScope {
  readonly selector: ScopeSelector;
  readonly closed: boolean;
  readonly coverage?: ClosedModelCoverageContract;
}

export interface ExpectedCoverageInput {
  readonly inputId: SafeIdentifier;
  readonly domain: CoverageDomain;
  readonly adapterId?: SafeIdentifier;
  readonly extensions?: readonly SafeIdentifier[];
}

export interface PermittedExclusion {
  readonly selector: ScopeSelector;
  readonly rationaleCode: SafeDiagnosticCode;
}

export interface InventoryAuthority {
  readonly authorityId: SafeIdentifier;
  readonly inventoryInputId: SafeIdentifier;
}

export interface AllowedExternalMechanism {
  readonly selector: ScopeSelector;
  readonly mechanismId: SafeIdentifier;
}

/**
 * Metadata required to call a user-declared scope closed. Keeping it in Core
 * prevents adapters from silently dropping roots, expected inputs, or external
 * mechanisms before reconciliation.
 */
export interface ClosedModelCoverageContract {
  readonly modelInputId: SafeIdentifier;
  readonly maxFiniteKeyDomain: number;
  readonly approvedFirstPartyRoots: readonly SafePath[];
  readonly bindingRoots: readonly SafePath[];
  readonly expectedInputs: readonly ExpectedCoverageInput[];
  readonly permittedExclusions: readonly PermittedExclusion[];
  readonly inventoryAuthorities: readonly InventoryAuthority[];
  readonly allowedExternalMechanisms: readonly AllowedExternalMechanism[];
  readonly outsideRootImports: "out-of-scope" | "included";
}

/** A finite model expansion is safe only with an adapter-proven selector. */
export interface FinitePatternDomain {
  readonly patternId: SafeIdentifier;
  readonly scope: ScopeSelector;
  readonly keys: readonly LogicalKey[];
  readonly constraint: "adapter-proven";
}

export interface ClosedProvisioningModel {
  readonly schemaVersion: SafeIdentifier;
  readonly scopes: readonly ClosedScope[];
  readonly finitePatternDomains?: readonly FinitePatternDomain[];
}

export interface ReconciliationInput {
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges?: readonly DynamicLookupEdge[];
  readonly targetStatuses?: readonly ScopedTargetStatus[];
  readonly bindingCandidates: readonly BindingCandidate[];
  readonly bindingResolutions: readonly BindingResolution[];
  readonly inventorySnapshots: readonly InventorySnapshot[];
  readonly coverageGaps?: readonly CoverageGap[];
  readonly coverageInputs?: readonly CoverageInputStatus[];
  readonly closedModel?: ClosedProvisioningModel;
}

export interface ReconciliationOptions {
  readonly requireComplete?: boolean;
  readonly maxFiniteKeyDomain?: number;
}

export interface ReconciliationReason {
  readonly code: SafeDiagnosticCode;
  readonly gapIds?: readonly SafeIdentifier[];
  readonly candidateIds?: readonly SafeIdentifier[];
}

export interface AggregateResult {
  readonly targetDiscovery: TargetDiscoveryStatus;
  readonly demand: DemandStatus;
  readonly binding: BindingStatus;
  readonly inventory: InventoryStatus;
  readonly inventorySnapshot?: Pick<InventorySnapshot, "authorityId" | "asOf">;
  readonly coverage: CoverageState;
  readonly constraint: ConstraintStatus;
  readonly disposition: Disposition;
}

export interface DemandReconciliation extends AggregateResult {
  readonly kind: "demand";
  readonly scope: ExecutionScope;
  readonly key: LogicalKey;
  readonly referenceIds: readonly SafeIdentifier[];
  readonly reasons: readonly ReconciliationReason[];
}

export interface InventoryReconciliation extends AggregateResult {
  readonly kind: "inventory";
  /** Absent only when an inventory item is not mapped to any known scope. */
  readonly scope?: ExecutionScope;
  readonly destination?: LogicalKey;
  readonly providerResourceId: ProviderResourceId;
  readonly reasons: readonly ReconciliationReason[];
}

export interface DynamicReconciliation extends AggregateResult {
  readonly kind: "dynamic";
  readonly lookup: DynamicLookupEdge;
  readonly reasons: readonly ReconciliationReason[];
}

export type ReconciliationRecord =
  | DemandReconciliation
  | InventoryReconciliation
  | DynamicReconciliation;

export interface ReconciliationResult {
  readonly records: readonly ReconciliationRecord[];
  readonly scopeCoverage: readonly ScopeCoverage[];
}

/** Value-free diagnostic returned by validation/materialization boundaries. */
export interface CoreDiagnostic {
  readonly code: SafeDiagnosticCode;
  readonly scope?: ExecutionScope;
}

export type FactMaterialization<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: CoreDiagnostic };

/**
 * Port implemented by src/safety/factory.ts. Core depends only on this
 * structural boundary, never on a concrete safety implementation.
 */
export interface CoreFactBuilder {
  materializeBindingCandidate(input: unknown): FactMaterialization<BindingCandidate>;
  materializeInventorySnapshot(input: unknown): FactMaterialization<InventorySnapshot>;
  materializeCoverageGap(input: unknown): FactMaterialization<CoverageGap>;
  materializeClosedModel(input: unknown): FactMaterialization<ClosedProvisioningModel>;
}

/**
 * Source adapters use this port before AST-derived text can enter Core. Raw
 * parser shapes intentionally remain `unknown` here: only SafetyFactory owns
 * their conversion to safe normalized facts.
 */
export interface CoreSourceFactBuilder {
  materializeSecretReference(input: unknown): FactMaterialization<SecretReference>;
  materializeDemandEdge(input: unknown): FactMaterialization<DemandEdge>;
  materializeDynamicLookupEdge(input: unknown): FactMaterialization<DynamicLookupEdge>;
}

/** Composition roots may provide one implementation for all fact families. */
export interface FullCoreFactBuilder extends CoreFactBuilder, CoreSourceFactBuilder {}
