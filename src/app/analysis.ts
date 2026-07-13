import { open, realpath } from "node:fs/promises";

import {
  adaptCoreFactBuilder,
  coreBindingResolutionPort,
  parseBindingManifest,
  parseClosedProvisioningModel,
  parseInventorySnapshot,
} from "../binding-adapters/index.js";
import {
  MAX_CONDITION_PARTITIONS,
  bindingResolutionStatusFor,
  effectiveBindingCandidatesFor,
  reconcile,
  selectorMayAffectScope,
  scopeCovers,
  stagesMayOverlap,
  type BindingCandidate,
  type ClosedProvisioningModel,
  type ConditionPredicate,
  type CoverageGap,
  type CoverageInputStatus,
  type DemandEdge,
  type DynamicLookupEdge,
  type ExecutionScope,
  type InventoryItem,
  type InventorySnapshot,
  type LogicalKey,
  type ReconciliationInput,
  type SafeDiagnosticCode,
  type SafeIdentifier,
  type ScopeSelector,
  type SecretReference,
} from "../core/index.js";
import {
  discoverSources,
  isSegmentDescendant,
  type DiscoveryResult,
  type DiscoveredSourceFile,
  type InternalPath,
} from "../discovery/index.js";
import type { ReportingInput } from "../reporters/index.js";
import { OPAQUE_PATH, SafeFactFactory, type SafePath } from "../safety/index.js";
import {
  extractTypeScriptSource,
  type SourceExtractionResult,
} from "../ts-adapter/index.js";

import type { LocalJsonReadResult } from "./local-json.js";
import { AppError, type LocalAnalysis } from "./types.js";
import {
  issuedDeploymentMember,
  type IssuedDeploymentMember,
} from "../workspace/deployment-capability.js";
import {
  deploymentAttestationContext,
  deploymentMemberAttestationContext,
  type AttestedDeploymentMember,
  type AttestedJsonReadResult,
} from "../workspace/deployment-attestation.js";
import { workspaceRepositoryMemberContext } from "../workspace/workspace-member-attestation.js";
import {
  WORKSPACE_REPOSITORY_FALLBACK_FACTS,
  WORKSPACE_DEPLOYMENT_MEMBER_FALLBACK_FACTS,
  workspaceInvocationContext,
  type WorkspaceInvocationContext,
} from "../workspace/workspace-invocation.js";

const DEFAULT_SOURCE_INPUT_ID = "source-discovery";
const DEFAULT_SCOPE_ID = "local-default-runtime";
const DEFAULT_COMPONENT_ID = "local-default";
const MAX_READ_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_DEPLOYMENT_BINDING_MEMBER_ASSIGNMENTS = 100_000;
const MAX_SHARED_DIRECT_KEY_SUMMARY = 10_000;
const MAX_SHARED_DIRECT_KEY_SUMMARY_WORK = 20_000;
/** One incomplete scope-coverage status is reserved for every member fallback. */
const DEPLOYMENT_MEMBER_GRAPH_FLOOR = WORKSPACE_DEPLOYMENT_MEMBER_FALLBACK_FACTS;
/** Fixed headroom for normalized record fields not materialized during planning. */
const PREPARED_MEMBER_ESTIMATOR_MARGIN = 64;

export interface ReconcileDocuments {
  readonly bindings: LocalJsonReadResult;
  readonly inventory: LocalJsonReadResult;
  readonly closedModel?: LocalJsonReadResult;
  /**
   * The canonical manifest/workspace base selected by the caller. Closed-model
   * coverage is not verifiable without this explicit local authority.
   */
  readonly verificationBase?: InternalPath;
}

interface SourceFacts {
  readonly factory: SafeFactFactory;
  readonly discovery: DiscoveryResult;
  readonly canonicalRoot: InternalPath;
  readonly scope: ExecutionScope;
  readonly selector: ScopeSelector;
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly directDemandSummary: DirectDemandSummary;
  readonly coverageGaps: readonly CoverageGap[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

interface DirectDemandSummary {
  readonly keys: readonly LogicalKey[];
  readonly complete: boolean;
}

interface ParsedProvisioning {
  readonly bindingCandidates: readonly BindingCandidate[];
  readonly bindingResolutions: ReconciliationInput["bindingResolutions"];
  readonly inventorySnapshots: readonly InventorySnapshot[];
  readonly closedModel?: ClosedProvisioningModel;
  readonly coverageGaps: readonly CoverageGap[];
  readonly coverageInputs: readonly CoverageInputStatus[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

interface DeploymentMemberScope {
  readonly repositoryId: SafeIdentifier;
  readonly scope: ExecutionScope;
}

/**
 * Identity-only capability for parsed, membership-filtered deployment inputs.
 * Raw JSON, canonical input paths, and adapter parse state stay in private
 * WeakMaps; callers can only ask to reconcile one declared member.
 */
declare const preparedDeploymentReconciliationBrand: unique symbol;
export type PreparedLocalDeploymentReconciliation = {
  readonly [preparedDeploymentReconciliationBrand]: true;
};

declare const preparedWorkspaceDeploymentPreflightBrand: unique symbol;
export type PreparedWorkspaceDeploymentPreflight = {
  readonly [preparedWorkspaceDeploymentPreflightBrand]: true;
};

type LocalInputFailureCode =
  | "APP_LOCAL_INPUT_READ_FAILED"
  | "APP_LOCAL_INPUT_TOO_LARGE"
  | "APP_LOCAL_INPUT_INVALID_JSON"
  | "APP_LOCAL_INPUT_BUDGET_EXCEEDED"
  | "APP_LOCAL_INPUT_SNAPSHOT_CHANGED"
  | "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED";

type PreparedDeploymentReadResult = LocalJsonReadResult | AttestedJsonReadResult;

interface DeploymentDocumentsForPreparation {
  readonly bindings: PreparedDeploymentReadResult;
  readonly inventory: PreparedDeploymentReadResult;
  readonly closedModel?: PreparedDeploymentReadResult;
  readonly verificationBase?: InternalPath;
}

type PreparedBindingDocument =
  | { readonly ok: true; readonly canonicalPath: InternalPath }
  | { readonly ok: false; readonly code: LocalInputFailureCode };

interface PreparedBindings {
  readonly candidates: readonly BindingCandidate[];
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly failure?: LocalInputFailureCode;
}

interface PreparedInventory {
  readonly snapshot?: InventorySnapshot;
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly failure?: LocalInputFailureCode;
}

interface PreparedClosedModel {
  readonly model?: ClosedProvisioningModel;
  readonly coverageGaps: readonly CoverageGap[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly failure?: LocalInputFailureCode;
}

interface PreparedDeploymentDocuments {
  readonly bindings: PreparedBindings;
  readonly inventory: PreparedInventory;
  readonly closed: PreparedClosedModel;
  readonly bindingDocument: PreparedBindingDocument;
  readonly verificationBase?: InternalPath;
}

interface MemberProvisioningSelection {
  readonly scope: ExecutionScope;
  readonly bindingCandidates: readonly BindingCandidate[];
  readonly bindingResolutions: ReconciliationInput["bindingResolutions"];
  readonly unscopedInventoryOwnerCandidateIds: ReadonlySet<SafeIdentifier>;
  readonly closedCoverageGaps: readonly CoverageGap[];
  readonly bindingCoverageGaps: readonly CoverageGap[];
  readonly inventorySnapshot?: InventorySnapshot;
  readonly inventoryCoverageGaps: readonly CoverageGap[];
  readonly bindingOwnershipUncertain: boolean;
  readonly inventoryOwnershipUncertain: boolean;
  readonly coverageGapFanoutUncertain: boolean;
}

interface MutableMemberProvisioningSelection {
  readonly scope: ExecutionScope;
  readonly bindingCandidates: BindingCandidate[];
  bindingResolutions: ReconciliationInput["bindingResolutions"];
  readonly unscopedInventoryOwnerCandidateIds: Set<SafeIdentifier>;
  /** Core-selected exact bindings retained only for admitted members. */
  readonly effectiveExactBindings: BindingCandidate[];
  /** Indexed exact provider resources avoid candidate-by-item matching. */
  readonly effectiveProviderResourceKeys: Set<string>;
  readonly closedCoverageGaps: CoverageGap[];
  readonly bindingCoverageGaps: CoverageGap[];
  readonly inventoryItems: InventoryItem[];
  readonly inventoryCoverageGaps: CoverageGap[];
  bindingOwnershipUncertain: boolean;
  inventoryOwnershipUncertain: boolean;
  coverageGapFanoutUncertain: boolean;
}

type PreparedDeploymentMember =
  | { readonly kind: "scan-only" }
  | { readonly kind: "fallback"; readonly scope: ExecutionScope }
  | { readonly kind: "provisioning"; readonly provisioning: MemberProvisioningSelection };

interface DeploymentPreflightContext {
  readonly issuance: object;
  readonly request: object;
  readonly invocation: WorkspaceInvocationContext;
  readonly mode: "scan-only" | "provisioning";
  readonly members: readonly AttestedDeploymentMember[];
  readonly memberScopes: ReadonlyMap<IssuedDeploymentMember, ExecutionScope | undefined>;
  readonly sources: ReadonlyMap<IssuedDeploymentMember, SourceFacts>;
  readonly projectionBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly sharedKeyBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  /** Total (floor-inclusive) graph reservation for each accepted member. */
  readonly reservedGraphCosts: Map<IssuedDeploymentMember, number>;
  /** Additional provisioning/Core graph reservation failed after document parse. */
  readonly fullGraphBudgetExhausted: Set<IssuedDeploymentMember>;
  readonly sharedKeys: readonly LogicalKey[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
  /** Fixed incomplete outputs are cached so replay cannot mint new graphs. */
  readonly exhaustedResults: Map<IssuedDeploymentMember, LocalAnalysis>;
}

interface PreparedDeploymentContext {
  readonly mode: "scan-only" | "provisioning";
  readonly documents?: PreparedDeploymentDocuments;
  readonly members: ReadonlyMap<IssuedDeploymentMember, PreparedDeploymentMember>;
  readonly sources: ReadonlyMap<IssuedDeploymentMember, SourceFacts>;
  readonly projectionBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly sharedKeyBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly fullGraphBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly reservedGraphCosts: ReadonlyMap<IssuedDeploymentMember, number>;
  /** Bounded by the same fact budget as materialization; never module-global. */
  readonly results: Map<IssuedDeploymentMember, LocalAnalysis>;
  readonly inFlight: Map<IssuedDeploymentMember, Promise<LocalAnalysis>>;
  readonly diagnostics: readonly SafeDiagnosticCode[];
}
interface BuiltDeploymentContext {
  readonly documents: PreparedDeploymentDocuments;
  readonly members: ReadonlyMap<SafeIdentifier, MemberProvisioningSelection>;
  /** Gap copies charged before member arrays were materialized. */
  readonly coverageReservedFacts: ReadonlyMap<SafeIdentifier, number>;
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

/**
 * Candidate ownership and coverage are planned before any Core resolver call.
 * The mutable arrays are invocation-private and are discarded for rejected
 * members before a prepared reconciliation capability is minted.
 */
interface PreparedDeploymentPlan {
  readonly documents: PreparedDeploymentDocuments;
  readonly members: ReadonlyMap<SafeIdentifier, MutableMemberProvisioningSelection>;
  /** Gap copies charged before candidate arrays become a public analysis. */
  readonly coverageReservedFacts: ReadonlyMap<SafeIdentifier, number>;
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

const SOURCES_BY_WORKSPACE_MEMBER = new WeakMap<object, SourceFacts>();
const BUDGETED_REPOSITORY_ANALYSES = new WeakMap<
  object,
  { readonly invocation: object; readonly result: LocalAnalysis }
>();
const ATTESTED_DEPLOYMENT_CONTEXTS = new WeakMap<object, ReturnType<typeof deploymentAttestationContext>>();
const PREPARED_DEPLOYMENT_RECONCILIATIONS = new WeakMap<object, PreparedDeploymentContext>();
const DEPLOYMENT_PREFLIGHTS = new WeakMap<object, DeploymentPreflightContext>();
const PREFLIGHTS_BY_ISSUANCE = new WeakMap<object, PreparedWorkspaceDeploymentPreflight>();
const PREPARED_BY_ATTESTATION = new WeakMap<object, PreparedLocalDeploymentReconciliation>();

/**
 * Scans first-party source below one root and reconciles it without provisioning inputs.
 *
 * Inputs: A local source-root path.
 * Outputs: A promise for `LocalAnalysis`, or rejects with `AppError(APP_DISCOVERY_FAILED)`/materialization failure.
 * Does not handle: Executing repository code, reading process environment values, provisioning documents, or network access.
 * Side effects: Traverses and reads bounded local source files, parses source text, and allocates private fact snapshots.
 */
export async function scanLocalRoot(root: string): Promise<LocalAnalysis> {
  const source = await collectSourceFacts(root);
  return reconcileCollected(source, emptyProvisioning(source));
}

/**
 * Scans a local root and reconciles its facts against previously bounded local provisioning documents.
 *
 * Inputs: A local root and read results for bindings, inventory, optional closed model, and optional verification base.
 * Outputs: A promise for `LocalAnalysis`; unexpected work failures reject as `AppError(APP_SAFETY_MATERIALIZATION_FAILED)`.
 * Does not handle: Document I/O, remote provider access, implicit verification bases, or raw parser error exposure.
 * Side effects: Traverses/reads source through `collectSourceFacts`, parses in-memory provisioning data, and allocates fact graphs.
 */
export async function reconcileLocalRoot(
  root: string,
  documents: ReconcileDocuments,
): Promise<LocalAnalysis> {
  try {
    const source = await collectSourceFacts(root);
    const provisioning = await collectProvisioning(source, documents);
    return reconcileCollected(source, provisioning);
  } catch {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
}

/**
 * Scans one opaque attested workspace member using its cached/private source provenance.
 *
 * Inputs: An unknown member handle minted by workspace attestation.
 * Outputs: A promise for its `LocalAnalysis`, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for an unissued, invalid, or mismatched member capability.
 * Does not handle: Structural member objects, cross-request capability use, provisioning reconciliation, or source fact export.
 * Side effects: Reads/writes the private source cache; a cache miss may discover/read/parse source and allocates a reconciliation graph. Concurrent cache misses are not coalesced.
 */
export async function scanAttestedLocalWorkspaceMember(
  memberHandle: unknown,
): Promise<LocalAnalysis> {
  const source = await collectAttestedLocalWorkspaceMemberSourceFacts(memberHandle);
  return reconcileCollected(source, emptyProvisioning(source));
}

/**
 * Collects one attested member's private source snapshot for later deployment preflight without producing a report.
 *
 * Inputs: An unknown opaque workspace member handle.
 * Outputs: A fulfilled `undefined` promise, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for an unissued, invalid, or mismatched member capability.
 * Does not handle: Core reconciliation, public source facts, deployment document reads, cross-request capability use, or graph-budget report admission.
 * Side effects: Reads/writes the private source cache; a miss traverses/reads/parses local member source. Concurrent misses are not coalesced.
 */
export async function collectAttestedLocalWorkspaceMemberSource(
  memberHandle: unknown,
): Promise<void> {
  await collectAttestedLocalWorkspaceMemberSourceFacts(memberHandle);
}

/**
 * Materializes one attested repository report under the invocation-wide graph budget.
 *
 * Inputs: An opaque member handle and its matching opaque invocation token.
 * Outputs: A cached or new `LocalAnalysis`, including a fixed incomplete fallback when the full projection cannot fit; rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for invalid, cross-request, or mismatched member/invocation capabilities.
 * Does not handle: Cross-invocation reuse, provisioning documents, or structural callers without attested member/invocation identity.
 * Side effects: Reads/writes the source and per-member analysis caches, may consume `factBudgetRemaining`, and writes the member/invocation result cache. Concurrent cache misses are not coalesced.
 */
export async function scanBudgetedAttestedLocalWorkspaceMember(
  memberHandle: unknown,
  invocation: unknown,
): Promise<LocalAnalysis> {
  const member = workspaceRepositoryMemberContext(memberHandle);
  const budget = workspaceInvocationContext(invocation);
  if (
    member === undefined ||
    !member.resolution.ok ||
    budget === undefined ||
    member.request !== budget.request
  ) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = BUDGETED_REPOSITORY_ANALYSES.get(memberHandle as object);
  if (existing !== undefined) {
    if (existing.invocation !== invocation) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    return existing.result;
  }
  const source = await collectAttestedLocalWorkspaceMemberSourceFacts(memberHandle);
  const totalCost = scanOnlyProjectionGraphCost(
    source,
    saturatedFactLimit(
      WORKSPACE_REPOSITORY_FALLBACK_FACTS,
      budget.factBudgetRemaining,
    ),
  );
  const additionalCost = Math.max(
    0,
    totalCost - WORKSPACE_REPOSITORY_FALLBACK_FACTS,
  );
  const result = additionalCost > budget.factBudgetRemaining
    ? budgetExhaustedAnalysis(source.scope)
    : reconcileBudgetedRepositorySource(source, budget, totalCost);
  BUDGETED_REPOSITORY_ANALYSES.set(
    memberHandle as object,
    Object.freeze({ invocation: invocation as object, result }),
  );
  return result;
}

/**
 * Resolves and caches private source facts for one attested workspace member.
 *
 * Inputs: An unknown opaque member handle.
 * Outputs: A promise for the member's `SourceFacts`, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for invalid, failed-resolution, or canonical-root-mismatched member provenance.
 * Does not handle: Report projection, deployment scope rebinding, cross-request capability recovery, or structural handle recovery.
 * Side effects: Reads/writes `SOURCES_BY_WORKSPACE_MEMBER`; a cache miss reads local source before storing it. Concurrent misses are not coalesced.
 */
async function collectAttestedLocalWorkspaceMemberSourceFacts(
  memberHandle: unknown,
): Promise<SourceFacts> {
  const member = workspaceRepositoryMemberContext(memberHandle);
  if (member === undefined || !member.resolution.ok) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = SOURCES_BY_WORKSPACE_MEMBER.get(memberHandle as object);
  if (existing !== undefined) {
    return existing;
  }
  const source = await collectSourceFacts(member.resolution.canonicalRoot);
  if (source.canonicalRoot !== member.resolution.canonicalRoot) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  SOURCES_BY_WORKSPACE_MEMBER.set(memberHandle as object, source);
  return source;
}

/**
 * Reconciles a source snapshot after debiting its previously computed report cost from an invocation budget.
 *
 * Inputs: Private source facts, invocation budget context, and total projected graph cost including fallback floor.
 * Outputs: A local analysis or fixed budget-exhausted analysis if the actual graph exceeds its estimate; a downstream materialization error propagates as its existing `AppError`.
 * Does not handle: Admission checks, source collection, or provisioning reconciliation.
 * Side effects: Decrements `budget.factBudgetRemaining` before reconciliation and allocates reconciliation output; it does not cache or restore budget on later failure.
 */
function reconcileBudgetedRepositorySource(
  source: SourceFacts,
  budget: WorkspaceInvocationContext,
  totalCost: number,
): LocalAnalysis {
  const additionalCost = Math.max(
    0,
    totalCost - WORKSPACE_REPOSITORY_FALLBACK_FACTS,
  );
  budget.factBudgetRemaining -= additionalCost;
  const analysis = reconcileCollected(source, emptyProvisioning(source));
  return localAnalysisGraphCost(analysis) <= totalCost
    ? analysis
    : budgetExhaustedAnalysis(source.scope);
}

/**
 * Registers the private context for one opaque deployment attestation capability.
 *
 * Inputs: An unknown value expected to be an issued deployment attestation.
 * Outputs: `undefined`, or throws fixed safety materialization failure when no private context exists.
 * Does not handle: Structural attestations, document reads, preflight planning, or public context exposure.
 * Side effects: Inserts the verified lower-layer context into `ATTESTED_DEPLOYMENT_CONTEXTS`.
 */
export function registerDeploymentAttestation(attestation: unknown): void {
  const context = deploymentAttestationContext(attestation);
  if (context === undefined) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  ATTESTED_DEPLOYMENT_CONTEXTS.set(attestation as object, context);
}

/**
 * Reserves source and shared-key graph capacity for an issued deployment before document preparation.
 *
 * Inputs: Opaque issued-deployment and invocation tokens from the same request.
 * Outputs: A cached/new opaque preflight token, or throws `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for unissued, cross-request, or mismatched private inputs.
 * Does not handle: Provisioning document reads, structural scope input, report materialization, or concurrent preflight miss coalescing.
 * Side effects: Reads cached source facts, may debit invocation budget, allocates/mutates bounded maps/sets, and writes both preflight WeakMaps.
 */
export function preflightIssuedWorkspaceDeployment(
  issuance: unknown,
  invocation: unknown,
): PreparedWorkspaceDeploymentPreflight {
  const attested = deploymentMemberAttestationContext(issuance);
  if (attested === undefined) throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  const budget = workspaceInvocationContext(invocation);
  if (
    budget === undefined ||
    budget.request !== attested.request ||
    attested.invocation !== invocation
  ) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = PREFLIGHTS_BY_ISSUANCE.get(issuance as object);
  if (existing !== undefined) {
    const existingContext = DEPLOYMENT_PREFLIGHTS.get(existing as unknown as object);
    if (
      existingContext === undefined ||
      existingContext.request !== attested.request ||
      existingContext.invocation !== budget
    ) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    return existing;
  }
  try {
    const sources = sourceFactsForAttestedMembers(attested.members, issuance);
    const memberScopes = new Map<IssuedDeploymentMember, ExecutionScope | undefined>();
    for (const member of attested.members) {
      const handle = issuedDeploymentMember(issuance, member.repositoryId);
      if (handle !== undefined) {
        memberScopes.set(handle, member.scope);
      }
    }
    const reserved = reserveDeploymentPreflight(
      sources,
      attested.members,
      issuance,
      budget,
    );
    const token = Object.freeze(Object.create(null)) as unknown as PreparedWorkspaceDeploymentPreflight;
    DEPLOYMENT_PREFLIGHTS.set(token as unknown as object, Object.freeze({
      issuance: issuance as object,
      request: attested.request,
      invocation: budget,
      mode: attested.mode,
      members: attested.members,
      memberScopes,
      sources,
      ...reserved,
      fullGraphBudgetExhausted: new Set<IssuedDeploymentMember>(),
      exhaustedResults: new Map<IssuedDeploymentMember, LocalAnalysis>(),
    }));
    PREFLIGHTS_BY_ISSUANCE.set(issuance as object, token);
    return token;
  } catch {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
}

/**
 * Tests whether an opaque preflight retained at least one member eligible for document-backed reconciliation.
 *
 * Inputs: An unknown possible preflight capability.
 * Outputs: `true` when a cached source handle avoided both projection and shared-key exhaustion; otherwise `false`.
 * Does not handle: Full graph reservation, document parsing, or structural preflight objects.
 * Side effects: Iterates private in-memory source handles.
 */
export function preflightHasMaterializableMembers(preflight: unknown): boolean {
  const context = DEPLOYMENT_PREFLIGHTS.get(preflight as object);
  if (context === undefined) return false;
  for (const handle of context.sources.keys()) {
    if (
      !context.projectionBudgetExhausted.has(handle) &&
      !context.sharedKeyBudgetExhausted.has(handle)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the bounded direct-demand key intersection reserved by a valid deployment preflight.
 *
 * Inputs: An unknown possible preflight capability.
 * Outputs: The cached readonly shared-key list, or an empty list for an unissued token.
 * Does not handle: Recomputing intersections, reconciliation-record inspection, or structural capability input.
 * Side effects: Reads a private WeakMap.
 */
export function preflightDeploymentSharedKeys(
  preflight: unknown,
): readonly LogicalKey[] {
  return DEPLOYMENT_PREFLIGHTS.get(preflight as object)?.sharedKeys ?? [];
}

/**
 * Returns fixed diagnostics recorded while preflighting source and shared-key reservations.
 *
 * Inputs: An unknown possible preflight capability.
 * Outputs: The cached readonly diagnostics list, or an empty list for an unissued token.
 * Does not handle: Diagnostic recomputation, raw errors, or structural capability input.
 * Side effects: Reads a private WeakMap.
 */
export function preflightDeploymentDiagnostics(
  preflight: unknown,
): readonly SafeDiagnosticCode[] {
  return DEPLOYMENT_PREFLIGHTS.get(preflight as object)?.diagnostics ?? [];
}

/**
 * Returns and caches the fixed incomplete report for a member rejected during preflight.
 *
 * Inputs: Opaque preflight and issued-member handle tokens.
 * Outputs: A promise for a fixed budget-exhausted `LocalAnalysis`, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for unissued, mismatched, or nonexhausted tokens.
 * Does not handle: Provisioning I/O, ordinary member reconciliation, or raw budget diagnostics.
 * Side effects: Reads and writes the preflight's `exhaustedResults` map; concurrent misses are not coalesced.
 */
export async function reconcilePreflightBudgetExhaustedMember(
  preflight: unknown,
  handle: unknown,
): Promise<LocalAnalysis> {
  const context = DEPLOYMENT_PREFLIGHTS.get(preflight as object);
  const source = context?.sources.get(handle as IssuedDeploymentMember);
  const exhausted = context !== undefined && (
    context.projectionBudgetExhausted.has(handle as IssuedDeploymentMember) ||
    context.sharedKeyBudgetExhausted.has(handle as IssuedDeploymentMember)
  );
  if (context === undefined || source === undefined || !exhausted) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = context.exhaustedResults.get(handle as IssuedDeploymentMember);
  if (existing !== undefined) {
    return existing;
  }
  const result = budgetExhaustedAnalysis(
    context.memberScopes.get(handle as IssuedDeploymentMember) ?? source.scope,
  );
  context.exhaustedResults.set(handle as IssuedDeploymentMember, result);
  return result;
}

/**
 * Combines matching deployment attestation and preflight capabilities into a member-only reconciliation capability.
 *
 * Inputs: Opaque full deployment attestation and its opaque preflight token.
 * Outputs: A cached/new `PreparedLocalDeploymentReconciliation`, or throws `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` on unissued, cross-request, mismatched attestation/preflight, or preparation failure.
 * Does not handle: Caller-supplied member scopes, unbounded document parsing, public disclosure of parsed inputs, or concurrent preparation miss coalescing.
 * Side effects: Parses already-attested local documents, reserves graph budget, mutates preflight maps/sets, and writes prepared-context WeakMaps.
 */
export function prepareIssuedLocalDeploymentReconciliation(
  attestation: unknown,
  preflight: unknown,
): PreparedLocalDeploymentReconciliation {
  const attested = ATTESTED_DEPLOYMENT_CONTEXTS.get(attestation as object);
  if (attested === undefined) throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  const planned = DEPLOYMENT_PREFLIGHTS.get(preflight as object);
  if (
    planned === undefined ||
    planned.issuance !== attestation ||
    planned.request !== attested.request ||
    planned.mode !== attested.mode
  ) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = PREPARED_BY_ATTESTATION.get(attestation as object);
  if (existing !== undefined) {
    return existing;
  }
  try {
    const members = new Map<IssuedDeploymentMember, PreparedDeploymentMember>();
    let documents: PreparedDeploymentDocuments | undefined;
    let diagnostics: readonly SafeDiagnosticCode[] = planned.diagnostics;
    if (attested.mode === "provisioning") {
      const declaredMemberScopes: DeploymentMemberScope[] = attested.members.map(/**
       * Converts one attested member with a required scope into a planner input.
       *
       * Inputs: One parser-attested deployment member.
       * Outputs: Its repository ID/scope pair, or throws fixed safety error when scope is absent.
       * Does not handle: Member handle issuance or source lookup.
       * Side effects: None.
       */ (member) => {
        if (member.scope === undefined) {
          throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
        }
        return { repositoryId: member.repositoryId, scope: member.scope };
      });
      if (attested.documents === undefined) {
        throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
      }
      documents = prepareDeploymentDocuments(attested.documents);
      // Only source/shared-key-admitted members are permitted to enter
      // provisioning planning. Preflight fallbacks retain no binding,
      // inventory, resolution, or coverage selection arrays.
      const materializableMemberScopes = declaredMemberScopes.filter(/**
       * Retains only members whose source reservation survived the preflight budget gates.
       *
       * Inputs: One repository ID/scope planning pair.
       * Outputs: `true` for a member with an issued handle, cached source, and no preflight exhaustion marker.
       * Does not handle: Full provisioning graph admission or document ownership selection.
       * Side effects: Reads private preflight maps and sets.
       */ (member) => {
        const handle = issuedDeploymentMember(attestation, member.repositoryId);
        return (
          handle !== undefined &&
          planned.sources.has(handle) &&
          !planned.projectionBudgetExhausted.has(handle) &&
          !planned.sharedKeyBudgetExhausted.has(handle)
        );
      });
      const plan = planPreparedDeploymentContext(
        documents,
        materializableMemberScopes,
        planned.invocation,
      );
      diagnostics = uniqueDiagnostics([...planned.diagnostics, ...plan.diagnostics]);
      const fullGraphBudgetExhaustedBefore = planned.fullGraphBudgetExhausted.size;
      const admittedRepositoryIds = new Set<SafeIdentifier>();
      for (const member of [...attested.members].sort(/**
       * Orders attested members by safe repository ID before deterministic graph admission.
       *
       * Inputs: Two attested deployment members.
       * Outputs: Their locale comparison result by repository ID.
       * Does not handle: Scope comparison or deduplication.
       * Side effects: None.
       */ (left, right) =>
        left.repositoryId.localeCompare(right.repositoryId),
      )) {
        const handle = issuedDeploymentMember(attestation, member.repositoryId);
        const selection = plan.members.get(member.repositoryId);
        const source = handle === undefined ? undefined : planned.sources.get(handle);
        if (
          handle === undefined ||
          selection === undefined ||
          source === undefined ||
          planned.projectionBudgetExhausted.has(handle) ||
          planned.sharedKeyBudgetExhausted.has(handle)
        ) {
          continue;
        }
        const sourceReservation = planned.reservedGraphCosts.get(handle);
        if (sourceReservation === undefined) {
          throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
        }
        const alreadyReserved = sourceReservation +
          (plan.coverageReservedFacts.get(member.repositoryId) ?? 0);
        // The limit is one fact above this member's remaining admissible
        // total. Estimators saturate there, proving rejection without doing
        // work proportional to an impossible output graph.
        const admissionLimit = saturatedFactLimit(
          alreadyReserved,
          planned.invocation.factBudgetRemaining,
        );
        const totalReservation = preparedMemberProjectionUpperBound(
          source,
          documents,
          selection,
          admissionLimit,
        );
        const additionalReservation = Math.max(0, totalReservation - alreadyReserved);
        if (additionalReservation > planned.invocation.factBudgetRemaining) {
          planned.fullGraphBudgetExhausted.add(handle);
          continue;
        }
        planned.invocation.factBudgetRemaining -= additionalReservation;
        planned.reservedGraphCosts.set(handle, totalReservation);
        admittedRepositoryIds.add(member.repositoryId);
      }
      // Core precedence selection and inventory ownership assignment happen
      // only after every admitted member owns its full conservative graph
      // reservation. Rejected members never reach these materializers.
      const built = materializePreparedDeploymentContext(plan, admittedRepositoryIds);
      diagnostics = uniqueDiagnostics([...diagnostics, ...built.diagnostics]);
      if (planned.fullGraphBudgetExhausted.size > fullGraphBudgetExhaustedBefore) {
        diagnostics = uniqueDiagnostics([
          ...diagnostics,
          memberDiagnostic("WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"),
        ]);
      }
      for (const member of attested.members) {
        const handle = issuedDeploymentMember(attestation, member.repositoryId);
        const provisioning = handle === undefined ? undefined : built.members.get(member.repositoryId);
        if (handle === undefined || member.scope === undefined) {
          throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
        }
        members.set(
          handle,
          provisioning === undefined
            ? Object.freeze({ kind: "fallback", scope: member.scope })
            : Object.freeze({ kind: "provisioning", provisioning }),
        );
      }
    } else {
      for (const member of attested.members) {
        const handle = issuedDeploymentMember(attestation, member.repositoryId);
        if (handle === undefined) throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
        members.set(handle, Object.freeze({ kind: "scan-only" }));
      }
    }
    const token = Object.freeze(Object.create(null)) as unknown as PreparedLocalDeploymentReconciliation;
    PREPARED_DEPLOYMENT_RECONCILIATIONS.set(token as unknown as object, Object.freeze({
      mode: attested.mode,
      ...(documents === undefined ? {} : { documents }),
      members,
      sources: planned.sources,
      projectionBudgetExhausted: planned.projectionBudgetExhausted,
      sharedKeyBudgetExhausted: planned.sharedKeyBudgetExhausted,
      fullGraphBudgetExhausted: planned.fullGraphBudgetExhausted,
      reservedGraphCosts: planned.reservedGraphCosts,
      results: new Map(),
      inFlight: new Map(),
      diagnostics,
    }));
    PREPARED_BY_ATTESTATION.set(attestation as object, token);
    return token;
  } catch {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
}

/**
 * Reconciles one member from a prepared deployment capability while coalescing duplicate concurrent requests.
 *
 * Inputs: An opaque prepared deployment token and issued member handle.
 * Outputs: A cached/in-flight/new `LocalAnalysis` promise, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` for unissued/mismatched prepared/member capabilities or failed work.
 * Does not handle: Source rediscovery, caller-provided scopes/documents, or cross-prepared-token cache reuse.
 * Side effects: Reads/writes private result/in-flight maps; concurrent misses for the same valid prepared/member pair are coalesced and may allocate reconciliation output.
 */
export async function reconcilePreparedLocalDeploymentMember(
  prepared: unknown,
  handle: unknown,
): Promise<LocalAnalysis> {
  const context = PREPARED_DEPLOYMENT_RECONCILIATIONS.get(prepared as object);
  const source = context?.sources.get(handle as IssuedDeploymentMember);
  const member = context?.members.get(handle as IssuedDeploymentMember);
  if (source === undefined || context === undefined || member === undefined) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const existing = context.results.get(handle as IssuedDeploymentMember);
  if (existing !== undefined) {
    return existing;
  }
  const active = context.inFlight.get(handle as IssuedDeploymentMember);
  if (active !== undefined) {
    return active;
  }
  const work = reconcilePreparedDeploymentMember(
    context,
    handle as IssuedDeploymentMember,
    source,
    member,
  );
  context.inFlight.set(handle as IssuedDeploymentMember, work);
  try {
    const result = await work;
    context.results.set(handle as IssuedDeploymentMember, result);
    return result;
  } catch {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  } finally {
    context.inFlight.delete(handle as IssuedDeploymentMember);
  }
}

/**
 * Chooses scan-only, fallback, or provisioned member reconciliation after all private budget gates.
 *
 * Inputs: Prepared context, issued member handle, cached source facts, and prepared member selection.
 * Outputs: A promise for local analysis, or rejects with `AppError(APP_SAFETY_MATERIALIZATION_FAILED)` when required prepared documents are unexpectedly absent.
 * Does not handle: Source discovery, document attestation, handle validation, or cache bookkeeping.
 * Side effects: Combines already-parsed prepared provisioning facts with the member scope, projects scope-bound source facts, invokes reconciliation/reservation enforcement without debiting new admission budget, and allocates outputs.
 */
async function reconcilePreparedDeploymentMember(
  context: PreparedDeploymentContext,
  handle: IssuedDeploymentMember,
  source: SourceFacts,
  member: PreparedDeploymentMember,
): Promise<LocalAnalysis> {
  if (
    context.projectionBudgetExhausted.has(handle) ||
    context.sharedKeyBudgetExhausted.has(handle) ||
    context.fullGraphBudgetExhausted.has(handle)
  ) {
    return budgetExhaustedAnalysis(
      member.kind === "provisioning"
        ? member.provisioning.scope
        : member.kind === "fallback"
          ? member.scope
          : source.scope,
    );
  }
  if (member.kind === "scan-only") {
    return enforceReservedMemberGraph(
      context,
      handle,
      source,
      source.scope,
      reconcileCollected(source, emptyProvisioning(source)),
    );
  }
  if (member.kind === "fallback") {
    return budgetExhaustedAnalysis(member.scope);
  }
  if (context.documents === undefined) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  const memberSource = sourceForExecutionScope(source, member.provisioning.scope);
  const provisioning = await collectPreparedMemberProvisioning(
    memberSource,
    context.documents,
    member.provisioning,
  );
  return enforceReservedMemberGraph(
    context,
    handle,
    memberSource,
    member.provisioning.scope,
    reconcileCollected(memberSource, provisioning),
  );
}

/**
 * Returns fixed deployment-level diagnostics with no individually safe member owner.
 *
 * Inputs: An unknown possible prepared deployment capability.
 * Outputs: Cached readonly diagnostics or an empty list for an unissued token.
 * Does not handle: Member diagnostics, recomputation, or structural prepared contexts.
 * Side effects: Reads a private WeakMap.
 */
export function preparedDeploymentDiagnostics(
  prepared: unknown,
): readonly SafeDiagnosticCode[] {
  return PREPARED_DEPLOYMENT_RECONCILIATIONS.get(prepared as object)?.diagnostics ?? [];
}

/**
 * Discovers supported source files under one root and extracts value-free reference/demand facts with scoped uncertainty.
 *
 * Inputs: A local root directory string.
 * Outputs: A promise for a private `SourceFacts` snapshot, or rejects with `APP_DISCOVERY_FAILED` on discovery failure.
 * Does not handle: Executing code, outside-root runtime dependencies, source writeback, or raw source/error reporting.
 * Side effects: Traverses, stats, opens, reads, and closes local source files; parses text and allocates private facts/coverage gaps.
 */
async function collectSourceFacts(root: string): Promise<SourceFacts> {
  const factory = new SafeFactFactory();
  let discovery: DiscoveryResult;
  try {
    discovery = await discoverSources({ roots: [root] }, factory);
  } catch {
    throw new AppError("APP_DISCOVERY_FAILED");
  }

  const scope = defaultScope(factory);
  const selector = selectorForScope(scope);
  const gaps = new AppGapBuilder(factory, selector);
  const diagnostics: SafeDiagnosticCode[] = [];
  const references: SecretReference[] = [];
  const demandEdges: DemandEdge[] = [];
  const dynamicLookupEdges: DynamicLookupEdge[] = [];

  for (const skip of discovery.skips) {
    if (!isRelevantDiscoverySkip(skip.code)) {
      continue;
    }
    gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
    diagnostics.push(factory.diagnosticCode("APP_DISCOVERY_INCOMPLETE"));
  }

  for (const [fileIndex, file] of discovery.files.entries()) {
    const sourceText = await readDiscoveredSource(file);
    if (sourceText === undefined) {
      gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
      diagnostics.push(factory.diagnosticCode("APP_SOURCE_READ_FAILED"));
      continue;
    }

    const extraction = extractTypeScriptSource(
      {
        sourceText,
        file: file.displayPath,
        sourceId: requiredIdentifier(factory, `source-file-${fileIndex + 1}`),
        language: file.language,
        scope,
        exposure: "unknown",
      },
      factory,
    );

    const namespaced = namespaceExtraction(extraction, fileIndex + 1, factory);
    references.push(...namespaced.references);
    demandEdges.push(...namespaced.demandEdges);
    dynamicLookupEdges.push(...namespaced.dynamicLookupEdges);

    if (extraction.diagnostics.length > 0 || namespaced.incomplete) {
      gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
      diagnostics.push(factory.diagnosticCode("APP_SOURCE_EXTRACTION_INCOMPLETE"));
    }
  }

  return privateSourceSnapshot({
    factory,
    discovery,
    canonicalRoot: sourceRootForDiscovery(discovery),
    scope,
    selector,
    references: Object.freeze(references),
    demandEdges: Object.freeze(demandEdges),
    dynamicLookupEdges: Object.freeze(dynamicLookupEdges),
    directDemandSummary: directDemandSummary(references, demandEdges),
    coverageGaps: gaps.values,
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Extracts the sole canonical source root from a successful discovery snapshot.
 *
 * Inputs: A source discovery result expected to contain the requested root.
 * Outputs: The first canonical root path, or throws `APP_DISCOVERY_FAILED` when absent.
 * Does not handle: Multiple-root selection, path normalization, or filesystem validation.
 * Side effects: Reads in-memory discovery fields.
 */
function sourceRootForDiscovery(discovery: DiscoveryResult): InternalPath {
  const root = discovery.roots[0]?.canonicalPath;
  if (root === undefined) {
    throw new AppError("APP_DISCOVERY_FAILED");
  }
  return root;
}

/**
 * Builds a capped sorted summary of direct/eager environment demands for deployment-wide intersection.
 *
 * Inputs: Extracted source references and demand edges from one repository.
 * Outputs: Frozen unique logical keys with `complete: true`, or an empty incomplete summary once work/key caps are exceeded.
 * Does not handle: Dynamic/pattern demand, reconciliation records, or unbounded key retention.
 * Side effects: Allocates temporary maps and sorted arrays.
 */
function directDemandSummary(
  references: readonly SecretReference[],
  demandEdges: readonly DemandEdge[],
): DirectDemandSummary {
  const referencesById = new Map(references.map(/**
   * Indexes one reference by its safe ID for later demand-edge resolution.
   *
   * Inputs: One extracted secret reference.
   * Outputs: A key/value pair of reference ID and the same reference.
   * Does not handle: Duplicate resolution or edge filtering.
   * Side effects: Feeds a newly allocated `Map` constructor.
   */ (reference) => [reference.id, reference]));
  const keys = new Map<string, LogicalKey>();
  let inspected = 0;
  for (const edge of demandEdges) {
    inspected += 1;
    if (inspected > MAX_SHARED_DIRECT_KEY_SUMMARY_WORK) {
      return Object.freeze({ keys: Object.freeze([]), complete: false });
    }
    const reference = referencesById.get(edge.referenceId);
    if (
      reference === undefined ||
      (reference.demand !== "direct-read" && reference.demand !== "eager-validation") ||
      typeof reference.requested.name !== "string"
    ) {
      continue;
    }
    const key = reference.requested.namespace + "\u0000" + reference.requested.name;
    keys.set(key, reference.requested);
    if (keys.size > MAX_SHARED_DIRECT_KEY_SUMMARY) {
      return Object.freeze({ keys: Object.freeze([]), complete: false });
    }
  }
  return Object.freeze({
    keys: Object.freeze(
      [...keys.values()].sort(/**
       * Orders unique logical keys by namespace/name for deterministic deployment reporting.
       *
       * Inputs: Two logical key facts.
       * Outputs: Their locale comparison result on synthesized namespace/name labels.
       * Does not handle: Namespace validation or deduplication.
       * Side effects: None.
       */ (left, right) =>
        (left.namespace + ":" + String(left.name)).localeCompare(
          right.namespace + ":" + String(right.name),
        ),
      ),
    ),
    complete: true,
  });
}

/**
 * Converts already-attested deployment document read results into private normalized parsing inputs.
 *
 * Inputs: Attested bindings, inventory, optional closed-model documents, and optional verification base.
 * Outputs: A detached `PreparedDeploymentDocuments` snapshot with parser gaps/failures retained as safe diagnostics.
 * Does not handle: File reading, attestation validation, report materialization, or raw document exposure.
 * Side effects: Allocates factories, parser output arrays, and frozen detached snapshots.
 */
function prepareDeploymentDocuments(
  documents: DeploymentDocumentsForPreparation,
): PreparedDeploymentDocuments {
  const factory = new SafeFactFactory();
  const builder = adaptCoreFactBuilder(factory);
  return detachedFactSnapshot({
    bindings: prepareBindings(documents.bindings, builder, factory),
    inventory: prepareInventory(documents.inventory, builder, factory),
    closed: prepareClosedModel(documents.closedModel, builder),
    bindingDocument: preparedBindingDocument(documents.bindings),
    ...(documents.verificationBase === undefined
      ? {}
      : { verificationBase: documents.verificationBase }),
  });
}

/**
 * Parses one binding document result into candidates, coverage gaps, and fixed failure diagnostics.
 *
 * Inputs: An attested binding read result, Core builder adapter, and safe fact factory.
 * Outputs: A frozen prepared-binding structure, marked incomplete for read/parse/input-ID failures.
 * Does not handle: File I/O, reconciliation, or recovery of invalid raw binding entries.
 * Side effects: Invokes the adapter parser and allocates frozen candidate/gap arrays.
 */
function prepareBindings(
  document: PreparedDeploymentReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
): PreparedBindings {
  if (!document.ok) {
    return Object.freeze({
      candidates: Object.freeze([]),
      coverageGaps: Object.freeze([]),
      complete: false,
      diagnostics: Object.freeze([codeForDocumentFailure(document.code)]),
      failure: document.code,
    });
  }
  const parsed = parseBindingManifest(document.value, builder);
  const inputId = localInputId(document.value, factory);
  const diagnostics = parserLimitExceeded(parsed)
    ? Object.freeze([provisioningInputLimitDiagnostic(factory)])
    : inputId === undefined
      ? Object.freeze([codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON")])
      : Object.freeze([]);
  return Object.freeze({
    candidates: Object.freeze([...parsed.candidates]),
    coverageGaps: Object.freeze([...parsed.coverageGaps]),
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined,
    diagnostics,
  });
}

/**
 * Parses one inventory document result into a snapshot, coverage gaps, and fixed failure diagnostics.
 *
 * Inputs: An attested inventory read result, Core builder adapter, and safe fact factory.
 * Outputs: A frozen prepared-inventory structure, marked incomplete when read/parse/input-ID/snapshot validation fails.
 * Does not handle: File I/O, inventory reconciliation, or recovery of malformed raw entries.
 * Side effects: Invokes the adapter parser and allocates frozen snapshot/gap arrays.
 */
function prepareInventory(
  document: PreparedDeploymentReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
): PreparedInventory {
  if (!document.ok) {
    return Object.freeze({
      coverageGaps: Object.freeze([]),
      complete: false,
      diagnostics: Object.freeze([codeForDocumentFailure(document.code)]),
      failure: document.code,
    });
  }
  const parsed = parseInventorySnapshot(document.value, builder);
  const inputId = localInputId(document.value, factory);
  const snapshot = parsed.snapshot;
  const diagnostics = parserLimitExceeded(parsed)
    ? Object.freeze([provisioningInputLimitDiagnostic(factory)])
    : inputId === undefined || snapshot === undefined
      ? Object.freeze([codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON")])
      : Object.freeze([]);
  return Object.freeze({
    ...(snapshot === undefined ? {} : { snapshot }),
    coverageGaps: Object.freeze([...parsed.coverageGaps]),
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined && snapshot !== undefined,
    diagnostics,
  });
}

/**
 * Parses an optional closed-provisioning model into model/gap/diagnostic state for prepared reconciliation.
 *
 * Inputs: An optional attested closed-model read result and Core builder adapter.
 * Outputs: A frozen prepared closed-model structure; absence remains empty and read/parser limits become safe failures.
 * Does not handle: File I/O, verification-base coverage proof, or binding/inventory parsing.
 * Side effects: Invokes the adapter parser and allocates frozen output arrays.
 */
function prepareClosedModel(
  document: PreparedDeploymentReadResult | undefined,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
): PreparedClosedModel {
  if (document === undefined) {
    return Object.freeze({ coverageGaps: Object.freeze([]), diagnostics: Object.freeze([]) });
  }
  if (!document.ok) {
    return Object.freeze({
      coverageGaps: Object.freeze([]),
      diagnostics: Object.freeze([codeForDocumentFailure(document.code)]),
      failure: document.code,
    });
  }
  const parsed = parseClosedProvisioningModel(document.value, builder);
  return Object.freeze({
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    coverageGaps: Object.freeze([...parsed.coverageGaps]),
    diagnostics: parserLimitExceeded(parsed)
      ? Object.freeze([provisioningInputLimitDiagnostic(new SafeFactFactory())])
      : Object.freeze([]),
  });
}

/**
 * Reduces an attested binding read to the path-or-fixed-code witness used by closed-model root verification.
 *
 * Inputs: One successful or failed prepared deployment read result.
 * Outputs: Frozen canonical-path success or frozen safe failure code.
 * Does not handle: Reading/statting the binding file or revealing failed paths.
 * Side effects: Allocates and freezes a small witness object.
 */
function preparedBindingDocument(document: PreparedDeploymentReadResult): PreparedBindingDocument {
  return document.ok
    ? Object.freeze({ ok: true as const, canonicalPath: document.canonicalPath })
    : Object.freeze({ ok: false as const, code: document.code });
}

/**
 * Rebinds a private source snapshot's edges and gaps to one declared execution scope.
 *
 * Inputs: A private source snapshot and an execution scope selected by deployment attestation.
 * Outputs: A new private source snapshot with detached references, scope/selector-bound edges, and gaps; it retains factory, discovery metadata, and canonical-root identity from the source snapshot.
 * Does not handle: Source re-extraction, cross-member filtering, or mutation of the original snapshot.
 * Side effects: Allocates detached fact graphs and mapped edge/gap arrays; reference identities are not shared with the source snapshot.
 */
function sourceForExecutionScope(
  source: SourceFacts,
  scope: ExecutionScope,
): SourceFacts {
  const privateScope = detachedFactSnapshot(scope);
  const selector = detachedFactSnapshot(selectorForScope(privateScope));
  return privateSourceSnapshot({
    ...source,
    scope: privateScope,
    selector,
    demandEdges: source.demandEdges.map(/**
      * Copies one demand edge with the member's private execution scope.
      *
      * Inputs: One source demand edge.
      * Outputs: A shallow copied edge bound to `privateScope`.
      * Does not handle: Reference filtering or scope validation.
      * Side effects: Allocates one edge object.
      */ (edge) => ({ ...edge, scope: privateScope })),
    dynamicLookupEdges: Object.freeze(
      source.dynamicLookupEdges.map(/**
        * Copies one dynamic lookup edge with the member's private execution scope.
        *
        * Inputs: One source dynamic lookup edge.
        * Outputs: A shallow copied edge bound to `privateScope`.
        * Does not handle: Domain recomputation or scope validation.
        * Side effects: Allocates one edge object.
        */ (edge) => ({ ...edge, scope: privateScope })),
    ),
    coverageGaps:
      source.coverageGaps.map(/**
        * Copies one coverage gap with the member selector it may affect.
        *
        * Inputs: One source coverage gap.
        * Outputs: A shallow copied gap bound to `selector`.
        * Does not handle: Gap deduplication or scope coverage evaluation.
        * Side effects: Allocates one gap object.
        */ (gap) => ({ ...gap, potentiallyAffects: selector })),
  });
}

/**
 * Joins attested deployment members to provenance-matching cached source snapshots.
 *
 * Inputs: Attested members and the opaque issuance token used to mint member handles.
 * Outputs: A map from issued handles to matching private source facts; malformed matching provenance throws fixed safety failure.
 * Does not handle: Source collection on cache miss, structural member input, or unissued handles.
 * Side effects: Reads module WeakMaps and allocates a member/source map.
 */
function sourceFactsForAttestedMembers(
  members: readonly AttestedDeploymentMember[],
  issuance: unknown,
): ReadonlyMap<IssuedDeploymentMember, SourceFacts> {
  const sources = new Map<IssuedDeploymentMember, SourceFacts>();
  for (const member of members) {
    const handle = issuedDeploymentMember(issuance, member.repositoryId);
    const source = SOURCES_BY_WORKSPACE_MEMBER.get(member.memberHandle);
    if (handle === undefined || source === undefined) {
      continue;
    }
    const memberContext = workspaceRepositoryMemberContext(member.memberHandle);
    if (
      memberContext === undefined ||
      !memberContext.resolution.ok ||
      memberContext.repositoryId !== member.repositoryId ||
      source.canonicalRoot !== memberContext.resolution.canonicalRoot
    ) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    sources.set(handle, source);
  }
  return sources;
}

interface PreflightReservation {
  readonly projectionBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly sharedKeyBudgetExhausted: ReadonlySet<IssuedDeploymentMember>;
  readonly reservedGraphCosts: Map<IssuedDeploymentMember, number>;
  readonly sharedKeys: readonly LogicalKey[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

/**
 * Simulates source and shared-key reservations before committing any member graph to the invocation ledger.
 *
 * Inputs: Handle-indexed source snapshots, attested members, opaque issuance, and mutable invocation budget.
 * Outputs: Exhausted-handle sets, per-handle reservations, shared keys, and fixed diagnostics.
 * Does not handle: Provisioning document reads, Core reconciliation, or caller-supplied source facts.
 * Side effects: Reads member handle capability maps and later mutates the invocation remaining fact budget for accepted work.
 */
function reserveDeploymentPreflight(
  sources: ReadonlyMap<IssuedDeploymentMember, SourceFacts>,
  members: readonly AttestedDeploymentMember[],
  issuance: unknown,
  budget: WorkspaceInvocationContext,
): PreflightReservation {
  const candidates = members
    .flatMap(/**
      * Converts one attested member to a source-reservation candidate only when its issued handle and cached source exist.
      *
      * Inputs: One attested deployment member.
      * Outputs: A zero/one-element candidate array with repository ID, handle, and source.
      * Does not handle: Budget admission or scope validation.
      * Side effects: Reads issued-member and source maps.
      */ (member) => {
      const handle = issuedDeploymentMember(issuance, member.repositoryId);
      const source = handle === undefined ? undefined : sources.get(handle);
      return handle === undefined || source === undefined
        ? []
        : [{ repositoryId: member.repositoryId, handle, source }];
    })
    .sort(/**
      * Orders reservation candidates by repository ID for deterministic budget consumption.
      *
      * Inputs: Two candidate records.
      * Outputs: Their repository ID locale comparison value.
      * Does not handle: Cost comparison or deduplication.
      * Side effects: None.
      */ (left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const projectionBudgetExhausted = new Set<IssuedDeploymentMember>();
  const sharedKeyBudgetExhausted = new Set<IssuedDeploymentMember>();
  const reservedGraphCosts = new Map<IssuedDeploymentMember, number>();
  const diagnostics: SafeDiagnosticCode[] = [];
  const start = budget.factBudgetRemaining;
  let remaining = start;
  const accepted: typeof candidates = [];
  for (const candidate of candidates) {
    const totalCost = scanOnlyProjectionGraphCost(
      candidate.source,
      saturatedFactLimit(DEPLOYMENT_MEMBER_GRAPH_FLOOR, remaining),
    );
    // Every declared member already owns one invocation-reserved scope
    // coverage slot. Charge only the graph above that floor here.
    const additionalCost = Math.max(0, totalCost - DEPLOYMENT_MEMBER_GRAPH_FLOOR);
    if (additionalCost > remaining) {
      projectionBudgetExhausted.add(candidate.handle);
      continue;
    }
    remaining -= additionalCost;
    reservedGraphCosts.set(candidate.handle, totalCost);
    accepted.push(candidate);
  }

  if (projectionBudgetExhausted.size > 0) {
    diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_PROJECTION_BUDGET_EXCEEDED"));
  }
  // A shared key is meaningful only when every declared member with source
  // demand evidence was accepted for this deployment. Never infer a common
  // key from a convenient subset after another member became opaque or
  // budget-exhausted.
  if (
    accepted.length < 2 ||
    projectionBudgetExhausted.size > 0 ||
    candidates.length !== members.length
  ) {
    budget.factBudgetRemaining = remaining;
    return Object.freeze({
      projectionBudgetExhausted,
      sharedKeyBudgetExhausted,
      reservedGraphCosts,
      sharedKeys: Object.freeze([]),
      diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
    });
  }

  const summaries = accepted.map(/**
   * Extracts the already-bounded direct-demand summary from one accepted reservation candidate.
   *
   * Inputs: One accepted candidate with private source facts.
   * Outputs: Its `DirectDemandSummary` object.
   * Does not handle: Summary completeness evaluation or new key extraction.
   * Side effects: None.
   */ (candidate) => candidate.source.directDemandSummary);
  const summaryComplete = summaries.every(/**
   * Tests whether one summary stayed within the source summary caps.
   *
   * Inputs: One direct-demand summary.
   * Outputs: Its `complete` boolean.
   * Does not handle: Key intersection or budget accounting.
   * Side effects: None.
   */ (summary) => summary.complete);
  const summaryWork = summaries.reduce(/**
   * Accumulates the number of stored direct-demand keys for shared-key work budgeting.
   *
   * Inputs: Running key count and one summary.
   * Outputs: The prior count plus that summary's key count.
   * Does not handle: Saturation or intersection output size.
   * Side effects: None.
   */ (total, summary) => total + summary.keys.length, 0);
  const outputUpperBound = Math.min(...summaries.map(/**
   * Projects one summary to its possible shared-key count.
   *
   * Inputs: One direct-demand summary.
   * Outputs: Its key-array length.
   * Does not handle: Intersection itself.
   * Side effects: None.
   */ (summary) => summary.keys.length));
  const sharedCost = Math.max(1, summaryWork + outputUpperBound);
  if (!summaryComplete || sharedCost > remaining) {
    for (const candidate of accepted) {
      sharedKeyBudgetExhausted.add(candidate.handle);
    }
    diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_SHARED_KEY_BUDGET_EXCEEDED"));
    // Do not commit the simulated source reservation: this deployment emitted
    // no source/shared-key fact graph above the invocation-wide fallback
    // floor, so later deployments retain the additional budget.
    reservedGraphCosts.clear();
    return Object.freeze({
      projectionBudgetExhausted,
      sharedKeyBudgetExhausted,
      reservedGraphCosts,
      sharedKeys: Object.freeze([]),
      diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
    });
  }

  const sharedKeys = intersectDirectDemandSummaries(summaries);
  budget.factBudgetRemaining = remaining - sharedCost;
  return Object.freeze({
    projectionBudgetExhausted,
    sharedKeyBudgetExhausted,
    reservedGraphCosts,
    sharedKeys,
    diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
  });
}

/**
 * Intersects precomputed direct-demand summaries using safe namespace/name keys and deterministic order.
 *
 * Inputs: Complete bounded direct-demand summaries from accepted deployment members.
 * Outputs: A frozen sorted array of keys present in every summary; empty for no first summary or no overlap.
 * Does not handle: Dynamic demands, summary cap recovery, or member admission.
 * Side effects: Allocates temporary maps, sets, and arrays.
 */
function intersectDirectDemandSummaries(
  summaries: readonly DirectDemandSummary[],
): readonly LogicalKey[] {
  const first = summaries[0];
  if (first === undefined) return Object.freeze([]);
  let shared = new Map<string, LogicalKey>(
    first.keys.map(/**
      * Keys one logical key by its namespace/name tuple for set intersection.
      *
      * Inputs: One direct-demand logical key.
      * Outputs: A tuple containing the canonical string key and original fact.
      * Does not handle: Key validation or duplicate merging beyond Map construction.
      * Side effects: Feeds a newly allocated `Map` constructor.
      */ (key) => [key.namespace + "\u0000" + String(key.name), key]),
  );
  for (const summary of summaries.slice(1)) {
    const current = new Set(
      summary.keys.map(/**
        * Projects one logical key to the tuple string used for overlap testing.
        *
        * Inputs: One direct-demand logical key.
        * Outputs: Its namespace/name tuple string.
        * Does not handle: Map insertion or validation.
        * Side effects: None.
        */ (key) => key.namespace + "\u0000" + String(key.name)),
    );
    shared = new Map([...shared].filter(/**
      * Retains a previous shared-key entry only when the current summary also contains it.
      *
      * Inputs: One tuple-key/logical-key map entry.
      * Outputs: `true` when the current summary's set contains the tuple key.
      * Does not handle: Value comparison or duplicate resolution.
      * Side effects: Reads the current set.
      */ ([key]) => current.has(key)));
    if (shared.size === 0) break;
  }
  return Object.freeze(
    [...shared.values()].sort(/**
      * Orders final shared keys by namespace/name for deterministic output.
      *
      * Inputs: Two logical keys.
      * Outputs: Their locale comparison result on synthesized labels.
      * Does not handle: Deduplication or namespace validation.
      * Side effects: None.
      */ (left, right) =>
      (left.namespace + ":" + String(left.name)).localeCompare(
        right.namespace + ":" + String(right.name),
      ),
    ),
  );
}

/**
 * Estimates a scan-only member's complete projected fact graph and saturates at the caller's admissible limit.
 *
 * Inputs: Private source facts and optional maximum cost limit.
 * Outputs: At least the deployment fallback floor and otherwise a conservative saturated fact count.
 * Does not handle: Provisioning candidates, actual report materialization, or exact output-object allocation.
 * Side effects: Iterates source fact arrays and invokes graph-cost helpers.
 */
function scanOnlyProjectionGraphCost(
  source: SourceFacts,
  limit = Number.MAX_SAFE_INTEGER,
): number {
  let total = 0;
  const add = /**
   * Adds one projected graph contribution while preserving the enclosing saturation limit.
   *
   * Inputs: One nonnegative estimated fact contribution.
   * Outputs: `undefined`; updates the enclosing total through saturating addition.
   * Does not handle: Input validation or direct report creation.
   * Side effects: Mutates the enclosing `total` variable.
   */ (next: number): void => {
    total = saturatingAdd(total, next, limit);
  };

  for (const reference of source.references) add(secretReferenceGraphCost(reference));
  for (const edge of source.demandEdges) add(demandEdgeGraphCost(edge));
  for (const edge of source.dynamicLookupEdges) add(dynamicLookupEdgeGraphCost(edge));
  for (const gap of source.coverageGaps) add(coverageGapGraphCost(gap));
  add(source.diagnostics.length);

  // A source-edge can merge with another edge in Core, never expand into more
  // direct-demand records. Dynamic domains are bounded before this estimator
  // and are charged at their largest legal expansion.
  const demandRecords = saturatingAdd(
    source.demandEdges.length,
    dynamicDemandRecordUpperBound(source.dynamicLookupEdges, 0, undefined),
    limit,
  );
  const gapCount = source.coverageGaps.length;
  // Each demand record carries its own reference-id array and can repeat the
  // full scope's gap IDs inside a reason. The extra unit covers a possible
  // dynamic-uncertainty reason; it intentionally overestimates rather than
  // materializing an otherwise impossible result to discover the shape.
  const perDemandRecord = 4 + gapCount;
  add(saturatingMultiply(demandRecords, perDemandRecord, limit));

  for (const edge of source.dynamicLookupEdges) {
    // A dynamic record serializes the lookup a second time, plus either a
    // coverage reason or a dynamic-validation reason (at most one issue).
    add(2 + gapCount + dynamicLookupEdgeGraphCost(edge));
  }

  // One target status, one source coverage input, and one scope-coverage
  // fact. Scope coverage repeats every relevant gap ID.
  add(3 + gapCount);
  return Math.max(DEPLOYMENT_MEMBER_GRAPH_FLOOR, total);
}

/**
 * Bounds Core demand records produced by finite or pattern dynamic lookup edges.
 *
 * Inputs: Dynamic edges, selected binding-candidate count, and optional closed model.
 * Outputs: The conservative count of concrete dynamic demand records.
 * Does not handle: Unbounded lookups, fact-budget saturation, or report materialization.
 * Side effects: Iterates edges and optional finite-pattern domains.
 */
function dynamicDemandRecordUpperBound(
  edges: readonly DynamicLookupEdge[],
  bindingCandidateCount: number,
  closedModel: ClosedProvisioningModel | undefined,
): number {
  const finitePatternKeys = closedModel?.finitePatternDomains?.reduce(
    /**
     * Adds one finite pattern domain's key count to the dynamic expansion estimate.
     *
     * Inputs: Running count and one finite pattern domain.
     * Outputs: Their numeric sum.
     * Does not handle: Saturation or key validation.
     * Side effects: None.
     */ (total, domain) => total + domain.keys.length,
    0,
  ) ?? 0;
  let total = 0;
  for (const edge of edges) {
    if (edge.domain.kind === "finite") {
      total += edge.domain.keys.length;
    } else if (edge.domain.kind === "pattern") {
      // Core may expand an adapter-proven pattern from matching binding or
      // closed-model keys. Counting all selected candidates is conservative.
      total += Math.max(
        edge.likelyKeys.length,
        bindingCandidateCount + finitePatternKeys,
      );
    }
  }
  return total;
}

/**
 * Estimates an admitted member's full provisioning/Core graph before Core selection or inventory ownership materializes it.
 *
 * Inputs: Source facts, prepared documents, mutable member selection, and saturated cost limit.
 * Outputs: A conservative saturated graph cost including nested gap/reason/coverage evidence and fixed margin.
 * Does not handle: Actual reconciliation, document I/O, or mutation of the member selection.
 * Side effects: Iterates prepared facts and invokes bounded cost/index helpers.
 */
function preparedMemberProjectionUpperBound(
  source: SourceFacts,
  documents: PreparedDeploymentDocuments,
  member: MutableMemberProvisioningSelection,
  limit: number,
): number {
  const baseline = scanOnlyProjectionGraphCost(source, limit);
  const exactCandidates = resolutionCandidatesForScope(member.scope, member.bindingCandidates);
  const fullDynamicDemand = dynamicDemandRecordUpperBound(
    source.dynamicLookupEdges,
    member.bindingCandidates.length,
    documents.closed.model,
  );
  const baselineDynamicDemand = dynamicDemandRecordUpperBound(
    source.dynamicLookupEdges,
    0,
    undefined,
  );
  const snapshot = documents.inventory.snapshot;
  const generatedCoverageGaps = generatedPreparedCoverageGapUpperBound(documents, member);
  const provisionedCoverageGaps =
    member.closedCoverageGaps.length +
    member.bindingCoverageGaps.length +
    member.inventoryCoverageGaps.length +
    generatedCoverageGaps;
  const provisionedCoverageGraphCost = saturatingAdd(
    saturatingAdd(
      coverageGapListGraphCost(member.closedCoverageGaps, limit),
      coverageGapListGraphCost(member.bindingCoverageGaps, limit),
      limit,
    ),
    saturatingAdd(
      coverageGapListGraphCost(member.inventoryCoverageGaps, limit),
      // Generated app gaps use a complete member selector. Five facts covers
      // the gap node plus its execution, phase, channel, and stage evidence.
      saturatingMultiply(generatedCoverageGaps, 5, limit),
      limit,
    ),
    limit,
  );
  const demandRecordUpperBound = saturatingAdd(
    source.demandEdges.length,
    fullDynamicDemand,
    limit,
  );
  const scopeCoverageUpperBound = preparedScopeCoverageUpperBound(
    member.bindingCandidates,
    snapshot,
    limit,
  );
  let total = baseline;
  total = saturatingAdd(
    total,
    provisionedCoverageGraphCost,
    limit,
  );
  // Scope coverage and every reconciliation reason serialize arrays of gap
  // IDs. A thousand demand records plus a thousand scoped gaps can therefore
  // contain over a million nested references despite a small top-level graph.
  total = saturatingAdd(
    total,
    repeatedCoverageEvidenceUpperBound(
      source,
      demandRecordUpperBound,
      provisionedCoverageGaps,
      scopeCoverageUpperBound,
      limit,
    ),
    limit,
  );
  total = saturatingAdd(total, preparedCoverageInputUpperBound(documents), limit);
  total = saturatingAdd(total, preparedDiagnosticUpperBound(documents, member), limit);
  total = saturatingAdd(
    total,
    bindingCandidateGraphUpperBound(member.bindingCandidates, limit),
    limit,
  );
  total = saturatingAdd(
    total,
    bindingResolutionGraphUpperBound(exactCandidates, limit),
    limit,
  );
  total = saturatingAdd(total, inventorySnapshotGraphUpperBound(snapshot, limit), limit);
  total = saturatingAdd(total, closedModelGraphCost(documents.closed.model), limit);
  total = saturatingAdd(
    total,
    Math.max(0, fullDynamicDemand - baselineDynamicDemand),
    limit,
  );
  total = saturatingAdd(
    total,
    member.bindingCandidates.length + inventoryDeclaredScopeFactCount(snapshot, limit),
    limit,
  );
  const inventoryRecords = inventoryRecordUpperBound(member.bindingCandidates, snapshot, limit);
  total = saturatingAdd(total, inventoryRecords, limit);
  // Every inventory record serializes an unbound/candidate reason and a
  // bound record may additionally repeat all scoped coverage IDs.
  total = saturatingAdd(
    total,
    inventoryRecordReasonUpperBound(inventoryRecords, provisionedCoverageGaps, limit),
    limit,
  );
  total = saturatingAdd(
    total,
    candidateReasonEvidenceUpperBound(
      source,
      member.bindingCandidates,
      documents.closed.model,
      limit,
    ),
    limit,
  );
  return saturatingAdd(total, PREPARED_MEMBER_ESTIMATOR_MARGIN, limit);
}

/**
 * Bounds nested repeated coverage-gap identifiers across scope coverage and affected reconciliation reasons.
 *
 * Inputs: Source facts, demand record count, additional gap count, scope coverage count, and saturation limit.
 * Outputs: Zero without additional gaps or a saturated count for duplicated gap evidence.
 * Does not handle: Creating gap/reason objects or source gap cost.
 * Side effects: Performs bounded arithmetic only.
 */
function repeatedCoverageEvidenceUpperBound(
  source: SourceFacts,
  demandRecords: number,
  additionalGapCount: number,
  scopeCoverageCount: number,
  limit: number,
): number {
  if (additionalGapCount === 0) return 0;
  let total = saturatingMultiply(
    additionalGapCount,
    scopeCoverageCount,
    limit,
  ); // ScopeCoverage.gapIds.
  const affectedRecords = saturatingAdd(
    demandRecords,
    source.dynamicLookupEdges.length,
    limit,
  );
  // One reason node plus every copied gap ID per potentially affected record.
  total = saturatingAdd(
    total,
    saturatingMultiply(affectedRecords, 1 + additionalGapCount, limit),
    limit,
  );
  return total;
}

/**
 * Bounds scope-coverage outputs introduced by source evidence, candidates, and declared inventory scopes.
 *
 * Inputs: Selected binding candidates, optional inventory snapshot, and saturation limit.
 * Outputs: A saturated count beginning with the source scope.
 * Does not handle: Actual coverage-state evaluation or gap duplication.
 * Side effects: Calls inventory declared-scope counter.
 */
function preparedScopeCoverageUpperBound(
  candidates: readonly BindingCandidate[],
  snapshot: InventorySnapshot | undefined,
  limit: number,
): number {
  // Source demand/target evidence contributes one scope. Candidate and
  // declared inventory scopes may add distinct Core ScopeCoverage entries.
  return saturatingAdd(
    1 + candidates.length,
    inventoryDeclaredScopeFactCount(snapshot, limit),
    limit,
  );
}

/**
 * Sums normalized binding-candidate graph costs until the caller's limit is reached.
 *
 * Inputs: Candidate facts and saturation limit.
 * Outputs: Exact accumulated cost below the limit or the limit on exhaustion.
 * Does not handle: Candidate parsing, selection, or mutation.
 * Side effects: Iterates candidate array.
 */
function bindingCandidateGraphUpperBound(
  candidates: readonly BindingCandidate[],
  limit: number,
): number {
  let total = 0;
  for (const candidate of candidates) {
    total = saturatingAdd(total, bindingCandidateGraphCost(candidate), limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Sums coverage-gap graph costs until the caller's saturation limit is reached.
 *
 * Inputs: Coverage gaps and saturation limit.
 * Outputs: Exact accumulated cost below the limit or the limit on exhaustion.
 * Does not handle: Gap generation, distribution, or mutation.
 * Side effects: Iterates the gap array.
 */
function coverageGapListGraphCost(
  gaps: readonly CoverageGap[],
  limit: number,
): number {
  let total = 0;
  for (const gap of gaps) {
    total = saturatingAdd(total, coverageGapGraphCost(gap), limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Bounds candidate/unbound and optional coverage reasons serialized by inventory records.
 *
 * Inputs: Number of possible inventory records, repeated coverage-gap count, and saturation limit.
 * Outputs: Zero for no records or the saturated reason/evidence cost.
 * Does not handle: Inventory matching or per-record reason construction.
 * Side effects: Performs bounded arithmetic only.
 */
function inventoryRecordReasonUpperBound(
  records: number,
  coverageGapCount: number,
  limit: number,
): number {
  if (records === 0) return 0;
  // Candidate/unbound reason plus a possible coverage reason and its IDs.
  return saturatingMultiply(records, 2 + coverageGapCount, limit);
}

/**
 * Bounds candidate-ID evidence by destination frequency instead of a candidates-by-demands Cartesian product.
 *
 * Inputs: Source facts, candidates, optional closed model, and saturation limit.
 * Outputs: A conservative saturated nested candidate-reason cost that remains linear for distinct destinations.
 * Does not handle: Candidate selection, actual reconciliation reasons, or binding document parsing.
 * Side effects: Allocates a destination-count map and iterates source demand/dynamic edges.
 */
function candidateReasonEvidenceUpperBound(
  source: SourceFacts,
  candidates: readonly BindingCandidate[],
  closedModel: ClosedProvisioningModel | undefined,
  limit: number,
): number {
  const candidateCounts = new Map<string, number>();
  let totalCandidates = 0;
  for (const candidate of candidates) {
    const key = destinationKey(candidate.destination);
    if (key === undefined) continue;
    candidateCounts.set(key, saturatingAdd(candidateCounts.get(key) ?? 0, 1, limit));
    totalCandidates = saturatingAdd(totalCandidates, 1, limit);
  }

  let total = 0;
  for (const key of directDemandDestinationKeys(source)) {
    const count = candidateCounts.get(key) ?? 0;
    if (count > 0) {
      total = saturatingAdd(total, 1 + count, limit);
      if (total >= limit) return limit;
    }
  }

  for (const edge of source.dynamicLookupEdges) {
    if (edge.domain.kind === "finite") {
      for (const key of edge.domain.keys) {
        const count = candidateCounts.get("env\u0000" + String(key)) ?? 0;
        if (count > 0) {
          total = saturatingAdd(total, 1 + count, limit);
          if (total >= limit) return limit;
        }
      }
      continue;
    }
    if (edge.domain.kind === "pattern") {
      // A validated pattern can expand against every matching declared
      // destination and any finite closed-model domain. Charging all local
      // candidates is conservative and remains linear per dynamic edge.
      const finiteKeys = closedModel?.finitePatternDomains?.reduce(
        /**
         * Adds one finite closed-model domain's keys to a pattern evidence bound.
         *
         * Inputs: Running count and one finite pattern domain.
         * Outputs: Their numeric sum.
         * Does not handle: Saturation or domain validation.
         * Side effects: None.
         */ (count, domain) => count + domain.keys.length,
        0,
      ) ?? 0;
      total = saturatingAdd(total, totalCandidates + finiteKeys + 1, limit);
      if (total >= limit) return limit;
    }
  }
  return total;
}

/**
 * Collects distinct destination tuple keys for direct/eager source demand edges.
 *
 * Inputs: One private source facts snapshot.
 * Outputs: A set of namespace/name tuple strings for direct/eager references only.
 * Does not handle: Dynamic lookups, destination parsing, or key ordering.
 * Side effects: Allocates a reference index map and result set.
 */
function directDemandDestinationKeys(source: SourceFacts): ReadonlySet<string> {
  const references = new Map(source.references.map(/**
   * Indexes one reference by ID while collecting direct destinations.
   *
   * Inputs: One secret reference.
   * Outputs: Its ID/reference tuple.
   * Does not handle: Demand filtering.
   * Side effects: Feeds a new map constructor.
   */ (reference) => [reference.id, reference]));
  const keys = new Set<string>();
  for (const edge of source.demandEdges) {
    const reference = references.get(edge.referenceId);
    if (
      reference !== undefined &&
      (reference.demand === "direct-read" || reference.demand === "eager-validation") &&
      typeof reference.requested.name === "string"
    ) {
      keys.add(reference.requested.namespace + "\u0000" + reference.requested.name);
    }
  }
  return keys;
}

/**
 * Counts fixed coverage gaps that preparation may generate beyond parsed document gaps.
 *
 * Inputs: Prepared documents and a mutable member selection.
 * Outputs: A small exact upper bound for document failures, ownership uncertainty, fanout uncertainty, and root verification.
 * Does not handle: Parsed coverage-gap lists or gap object construction.
 * Side effects: Reads in-memory flags only.
 */
function generatedPreparedCoverageGapUpperBound(
  documents: PreparedDeploymentDocuments,
  member: MutableMemberProvisioningSelection,
): number {
  return (
    (documents.closed.failure === undefined ? 0 : 1) +
    (documents.bindings.failure === undefined && documents.bindings.inputId !== undefined ? 0 : 1) +
    (documents.inventory.failure === undefined && documents.inventory.inputId !== undefined ? 0 : 1) +
    (member.bindingOwnershipUncertain ? 1 : 0) +
    (member.inventoryOwnershipUncertain ? 1 : 0) +
    (member.coverageGapFanoutUncertain ? 1 : 0) +
    // Root verification can append one scoped binding gap after this reserve.
    (documents.closed.model === undefined ? 0 : 1)
  );
}

/**
 * Counts coverage-input facts that bindings and inventory can contribute across closed-model scopes.
 *
 * Inputs: Prepared deployment documents.
 * Outputs: The exact input-ID times model-scope upper bound.
 * Does not handle: Coverage state evaluation or document parsing.
 * Side effects: Reads prepared model and input-ID fields.
 */
function preparedCoverageInputUpperBound(documents: PreparedDeploymentDocuments): number {
  const modelScopeCount = Math.max(1, documents.closed.model?.scopes.length ?? 0);
  return (
    (documents.bindings.inputId === undefined ? 0 : modelScopeCount) +
    (documents.inventory.inputId === undefined ? 0 : modelScopeCount)
  );
}

/**
 * Counts fixed diagnostics potentially attached to one prepared member analysis.
 *
 * Inputs: Prepared documents and mutable member ownership state.
 * Outputs: An exact count of parser and uncertainty diagnostics.
 * Does not handle: Dynamic source diagnostics or rendering.
 * Side effects: Reads arrays and boolean flags only.
 */
function preparedDiagnosticUpperBound(
  documents: PreparedDeploymentDocuments,
  member: MutableMemberProvisioningSelection,
): number {
  return (
    documents.closed.diagnostics.length +
    documents.bindings.diagnostics.length +
    documents.inventory.diagnostics.length +
    (member.bindingOwnershipUncertain ? 1 : 0) +
    (member.inventoryOwnershipUncertain ? 1 : 0) +
    (member.coverageGapFanoutUncertain ? 1 : 0) +
    (documents.closed.model === undefined ? 0 : 1)
  );
}

/**
 * Counts materialized Core binding resolution partitions, selections, and selector evidence.
 *
 * Inputs: Reconciliation binding resolutions.
 * Outputs: The exact graph contribution count for the supplied materialized resolutions.
 * Does not handle: Resolution creation, saturation, or candidate parsing.
 * Side effects: Iterates resolutions and partitions.
 */
function bindingResolutionGraphCost(
  resolutions: ReconciliationInput["bindingResolutions"],
): number {
  let total = 0;
  for (const resolution of resolutions) {
    total += 1;
    for (const partition of resolution.partitions) {
      // Each selection carries one candidate-ID reference; each partition can
      // also repeat selector evidence generated from its branch condition.
      total += 1 + partition.selections.length + selectorGraphCost(partition.appliesWhen);
    }
  }
  return total;
}

interface BindingResolutionSlotUpperBound {
  count: number;
  nonConditionSelectorKey?: string;
  finiteConditions: boolean;
  readonly conditionDomains: Map<string, Set<string>>;
}

/**
 * Bounds Core binding-resolution output by grouping candidates into slots and finite condition domains without materializing partitions.
 *
 * Inputs: Candidate facts and a saturation limit.
 * Outputs: A conservative saturated count of slots, partitions, and selections.
 * Does not handle: Actual Core resolution, candidate parser diagnostics, or condition evaluation.
 * Side effects: Allocates slot/domain maps and sets while iterating candidates.
 */
function bindingResolutionGraphUpperBound(
  candidates: readonly BindingCandidate[],
  limit: number,
): number {
  const slots = new Map<string, BindingResolutionSlotUpperBound>();
  for (const [index, candidate] of candidates.entries()) {
    const key = bindingResolutionSlotKey(candidate, index);
    const slot = slots.get(key) ?? {
      count: 0,
      finiteConditions: true,
      conditionDomains: new Map<string, Set<string>>(),
    };
    slot.count += 1;
    const selectorKey = nonConditionSelectorKey(candidate.appliesWhen);
    if (slot.nonConditionSelectorKey === undefined) {
      slot.nonConditionSelectorKey = selectorKey;
    } else if (slot.nonConditionSelectorKey !== selectorKey) {
      slot.finiteConditions = false;
    }
    addConditionDomains(slot, candidate.appliesWhen.condition);
    slots.set(key, slot);
  }

  let total = 0;
  for (const slot of slots.values()) {
    const finitePartitions = slot.finiteConditions
      ? finiteConditionPartitionUpperBound(slot.conditionDomains)
      : undefined;
    const partitions = finitePartitions ?? slot.count;
    total = saturatingAdd(total, 1, limit);
    total = saturatingAdd(total, partitions, limit);
    total = saturatingAdd(total, saturatingMultiply(partitions, slot.count, limit), limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Forms the Core-equivalence slot key for one binding candidate, isolating candidates with opaque destination or scope fields.
 *
 * Inputs: A binding candidate and its deterministic input index.
 * Outputs: An opaque per-index key or a tuple key containing known scope/destination fields.
 * Does not handle: Candidate identity validation or condition clauses.
 * Side effects: Sorts a copied stage value list for deterministic key text.
 */
function bindingResolutionSlotKey(candidate: BindingCandidate, index: number): string {
  const destination = destinationKey(candidate.destination);
  const scope = candidate.scope;
  if (
    destination === undefined ||
    scope.phase === "unknown" ||
    scope.channel === "unknown" ||
    scope.stage.kind === "unknown"
  ) {
    // Core cannot establish equality for these scopes/keys, so it treats each
    // candidate as a separate slot. Preserve that conservative boundary.
    return "opaque\u0000" + String(index);
  }
  const stage = scope.stage.kind === "all"
    ? "all"
    : "exact\u0000" + [...scope.stage.values].sort().join("\u0000");
  return [scope.id, scope.phase, scope.channel, stage, destination].join("\u0001");
}

/**
 * Serializes selector fields except condition clauses for slot compatibility comparison.
 *
 * Inputs: A scope selector.
 * Outputs: A deterministic tuple string for execution-unit, phase, stage, and channel selectors.
 * Does not handle: Condition predicates or selector semantics beyond equality encoding.
 * Side effects: Invokes set/stage key helpers that sort copied arrays.
 */
function nonConditionSelectorKey(selector: ScopeSelector): string {
  return [
    selectorSetKey(selector.executionUnitIds),
    selectorSetKey(selector.phases),
    stageSelectorKey(selector.stage),
    selectorSetKey(selector.channels),
  ].join("\u0001");
}

/**
 * Serializes an optional selector value set with cardinality and deterministic sorted values.
 *
 * Inputs: An optional readonly string array.
 * Outputs: `undefined` marker or a cardinality-prefixed tuple string.
 * Does not handle: Value validation, duplicate removal, or semantic selector matching.
 * Side effects: Sorts a copied values array when present.
 */
function selectorSetKey(values: readonly string[] | undefined): string {
  return values === undefined
    ? "undefined"
    : String(values.length) + "\u0000" + [...values].sort().join("\u0000");
}

/**
 * Serializes a stage selector for noncondition slot comparison.
 *
 * Inputs: A scope selector stage variant.
 * Outputs: `exact` plus encoded values, or its nonexact kind string.
 * Does not handle: Stage overlap testing or condition clauses.
 * Side effects: Invokes `selectorSetKey`, which may sort a copied list.
 */
function stageSelectorKey(stage: ScopeSelector["stage"]): string {
  return stage.kind === "exact"
    ? "exact\u0000" + selectorSetKey(stage.values)
    : stage.kind;
}

/**
 * Adds finite all-clause condition values to a slot or marks the slot nonfinite for unknown conditions.
 *
 * Inputs: Mutable slot estimator and one candidate condition predicate.
 * Outputs: `undefined` after recording values or setting the slot's finite flag.
 * Does not handle: Condition truth evaluation, selector comparison, or partition enumeration.
 * Side effects: Mutates slot boolean and condition-domain map/sets.
 */
function addConditionDomains(
  slot: BindingResolutionSlotUpperBound,
  condition: ConditionPredicate,
): void {
  if (condition.kind === "unknown") {
    slot.finiteConditions = false;
    return;
  }
  if (condition.kind !== "all") return;
  for (const clause of condition.clauses) {
    const values = slot.conditionDomains.get(clause.key) ?? new Set<string>();
    values.add(clause.value);
    slot.conditionDomains.set(clause.key, values);
  }
}

/**
 * Multiplies finite condition-domain choices until Core's partition cap would be exceeded.
 *
 * Inputs: Condition-key to observed-value sets.
 * Outputs: Exact finite partition count or `undefined` when the product exceeds Core's maximum.
 * Does not handle: Building assignments or unknown condition predicates.
 * Side effects: Iterates domain sets only.
 */
function finiteConditionPartitionUpperBound(
  domains: ReadonlyMap<string, ReadonlySet<string>>,
): number | undefined {
  let assignments = 1;
  for (const values of domains.values()) {
    const choices = values.size + 1;
    if (assignments > Math.floor(MAX_CONDITION_PARTITIONS / choices)) {
      return undefined;
    }
    assignments *= choices;
  }
  return assignments;
}

/**
 * Counts graph facts in already materialized inventory snapshots and declared scope arrays.
 *
 * Inputs: Inventory snapshot array.
 * Outputs: The exact unsaturated count of snapshot, item, and declared-scope nodes.
 * Does not handle: Missing snapshots, saturation, or inventory matching.
 * Side effects: Iterates snapshots/items.
 */
function inventorySnapshotGraphCost(
  snapshots: readonly InventorySnapshot[],
): number {
  let total = 0;
  for (const snapshot of snapshots) {
    total += 1 + snapshot.items.length;
    for (const item of snapshot.items) {
      total += item.declaredScopes?.length ?? 0;
    }
  }
  return total;
}

/**
 * Counts one optional inventory snapshot's graph nodes with saturation.
 *
 * Inputs: An optional snapshot and saturation limit.
 * Outputs: Zero when absent; otherwise the exact cost below limit or the limit on exhaustion.
 * Does not handle: Snapshot parsing or item matching.
 * Side effects: Iterates items and declared scopes.
 */
function inventorySnapshotGraphUpperBound(
  snapshot: InventorySnapshot | undefined,
  limit: number,
): number {
  if (snapshot === undefined) return 0;
  let total = saturatingAdd(1, snapshot.items.length, limit);
  for (const item of snapshot.items) {
    total = saturatingAdd(total, item.declaredScopes?.length ?? 0, limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Counts declared inventory scope facts with saturation.
 *
 * Inputs: An optional inventory snapshot and saturation limit.
 * Outputs: Zero when absent; otherwise declared-scope count clipped at limit.
 * Does not handle: Inventory items themselves, matching, or scope validation.
 * Side effects: Iterates items.
 */
function inventoryDeclaredScopeFactCount(
  snapshot: InventorySnapshot | undefined,
  limit: number,
): number {
  let total = 0;
  for (const item of snapshot?.items ?? []) {
    total = saturatingAdd(total, item.declaredScopes?.length ?? 0, limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Bounds candidate/item reconciliation records using provider-resource frequencies rather than a Cartesian product.
 *
 * Inputs: Binding candidates, optional inventory snapshot, and saturation limit.
 * Outputs: Zero with no snapshot or a saturated conservative record count.
 * Does not handle: Actual binding resolution, scope relationship evaluation, or inventory parsing.
 * Side effects: Allocates a resource-frequency map and iterates candidates/items.
 */
function inventoryRecordUpperBound(
  candidates: readonly BindingCandidate[],
  snapshot: InventorySnapshot | undefined,
  limit: number,
): number {
  if (snapshot === undefined) return 0;
  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const resource = candidate.providerResourceId;
    if (resource === undefined) continue;
    const key = providerResourceKey(resource.authorityId, resource.canonicalId);
    candidateCounts.set(
      key,
      saturatingAdd(candidateCounts.get(key) ?? 0, 1, limit),
    );
  }
  let total = 0;
  for (const item of snapshot.items) {
    total = saturatingAdd(
      total,
      candidateCounts.get(
        providerResourceKey(item.providerResourceId.authorityId, item.providerResourceId.canonicalId),
      ) ?? 0,
      limit,
    );
    // Core emits either a bound record or an unbound record per declared
    // scope. Counting both possibilities is deliberately conservative.
    total = saturatingAdd(total, Math.max(1, item.declaredScopes?.length ?? 0), limit);
    if (total >= limit) return limit;
  }
  return total;
}

/**
 * Computes the first impossible fact limit immediately above reserved plus remaining capacity without overflowing safe integers.
 *
 * Inputs: Already reserved fact count and currently remaining fact count.
 * Outputs: A saturated `reserved + remaining + 1` limit.
 * Does not handle: Negative inputs, policy validation, or budget mutation.
 * Side effects: Calls saturating arithmetic only.
 */
function saturatedFactLimit(reserved: number, remaining: number): number {
  return saturatingAdd(saturatingAdd(reserved, remaining, Number.MAX_SAFE_INTEGER - 1), 1, Number.MAX_SAFE_INTEGER);
}

/**
 * Adds two projected counts but clamps at a caller-selected limit before numeric overflow.
 *
 * Inputs: Running total, next contribution, and saturation limit.
 * Outputs: The exact sum below limit or the limit when either operand reaches/exceeds it.
 * Does not handle: Negative/NaN validation or mutable budget updates.
 * Side effects: None.
 */
function saturatingAdd(total: number, next: number, limit: number): number {
  if (total >= limit || next >= limit - total) return limit;
  return total + next;
}

/**
 * Multiplies two projected counts but clamps at a caller-selected limit before overflow.
 *
 * Inputs: Two factors and saturation limit.
 * Outputs: Zero for a zero factor, exact product below limit, or limit when the product would exceed it.
 * Does not handle: Negative/NaN validation or floating-point scaling.
 * Side effects: None.
 */
function saturatingMultiply(left: number, right: number, limit: number): number {
  if (left === 0 || right === 0) return 0;
  return left > Math.floor(limit / right) ? limit : left * right;
}

/**
 * Counts materialized closed-model scopes, coverage fields, expected inputs, and finite domains.
 *
 * Inputs: An optional closed provisioning model.
 * Outputs: Zero for absence or the exact unsaturated graph cost for supplied model fields.
 * Does not handle: Model validation, saturation, or scope coverage proof.
 * Side effects: Iterates model scopes/domains and expected-input arrays.
 */
function closedModelGraphCost(model: ClosedProvisioningModel | undefined): number {
  if (model === undefined) return 0;
  let total = 1;
  for (const scope of model.scopes) {
    total += 1;
    const coverage = scope.coverage;
    if (coverage === undefined) continue;
    total +=
      1 +
      coverage.approvedFirstPartyRoots.length +
      coverage.bindingRoots.length +
      coverage.expectedInputs.reduce(
        /**
         * Adds one expected-input node and its extension evidence to the closed-model cost.
         *
         * Inputs: Running cost and one expected adapter input.
         * Outputs: The prior cost plus one input and its extension count.
         * Does not handle: Input validation or saturation.
         * Side effects: None.
         */ (count, input) => count + 1 + (input.extensions?.length ?? 0),
        0,
      ) +
      coverage.permittedExclusions.length +
      coverage.inventoryAuthorities.length +
      coverage.allowedExternalMechanisms.length;
  }
  for (const domain of model.finitePatternDomains ?? []) {
    total += 1 + domain.keys.length;
  }
  return total;
}

/**
 * Counts the complete already-materialized local analysis graph, including nested evidence and report coverage arrays.
 *
 * Inputs: One local analysis snapshot.
 * Outputs: The exact unsaturated count used by post-Core reservation enforcement.
 * Does not handle: Estimating unmaterialized graphs, saturation, or fact construction.
 * Side effects: Iterates fact/report arrays.
 */
function localAnalysisGraphCost(analysis: LocalAnalysis): number {
  const input = analysis.reconciliationInput;
  let total = 0;
  for (const reference of input.references) {
    total += secretReferenceGraphCost(reference);
  }
  for (const edge of input.demandEdges) {
    total += demandEdgeGraphCost(edge);
  }
  for (const edge of input.dynamicLookupEdges ?? []) {
    total += dynamicLookupEdgeGraphCost(edge);
  }
  total += (input.targetStatuses?.length ?? 0);
  for (const candidate of input.bindingCandidates) {
    total += bindingCandidateGraphCost(candidate);
  }
  total += bindingResolutionGraphCost(input.bindingResolutions);
  total += inventorySnapshotGraphCost(input.inventorySnapshots);
  for (const gap of input.coverageGaps ?? []) {
    total += coverageGapGraphCost(gap);
  }
  total += (input.coverageInputs?.length ?? 0);
  total += closedModelGraphCost(input.closedModel);
  total += analysis.diagnostics.length;
  for (const record of analysis.result.records) {
    total += reconciliationRecordGraphCost(record);
  }
  for (const coverage of analysis.result.scopeCoverage) {
    total += 1 + coverage.gapIds.length;
  }
  return total;
}

/**
 * Counts one secret reference and all nested evidence locations it serializes.
 *
 * Inputs: A secret reference fact.
 * Outputs: One parent node plus evidence graph cost.
 * Does not handle: Reference validation or budget saturation.
 * Side effects: Calls `evidenceGraphCost`.
 */
function secretReferenceGraphCost(reference: SecretReference): number {
  return 1 + evidenceGraphCost(reference.evidenceChain);
}

/**
 * Counts one demand edge, its reference linkage, and nested evidence locations.
 *
 * Inputs: A demand edge fact.
 * Outputs: Two fixed edge/link nodes plus evidence graph cost.
 * Does not handle: Edge validation or budget saturation.
 * Side effects: Calls `evidenceGraphCost`.
 */
function demandEdgeGraphCost(edge: DemandEdge): number {
  return 2 + evidenceGraphCost(edge.evidenceChain);
}

/**
 * Counts one dynamic lookup edge, likely-key list, and nested evidence locations.
 *
 * Inputs: A dynamic lookup edge fact.
 * Outputs: Two fixed nodes plus likely key count and evidence graph cost.
 * Does not handle: Dynamic domain expansion or budget saturation.
 * Side effects: Calls `evidenceGraphCost`.
 */
function dynamicLookupEdgeGraphCost(edge: DynamicLookupEdge): number {
  return 2 + edge.likelyKeys.length + evidenceGraphCost(edge.evidenceChain);
}

/**
 * Counts evidence entries and each evidence entry's source-location nodes.
 *
 * Inputs: Evidence-like entries with readonly location arrays.
 * Outputs: The exact unsaturated count of entry and location nodes.
 * Does not handle: Location validation, deduplication, or fact creation.
 * Side effects: Iterates evidence entries.
 */
function evidenceGraphCost(
  evidence: readonly { readonly locations: readonly unknown[] }[],
): number {
  return evidence.reduce(/**
   * Adds one evidence node and all of its location nodes to the accumulated graph cost.
   *
   * Inputs: Running cost and one evidence entry.
   * Outputs: The prior cost plus one entry and its location count.
   * Does not handle: Saturation or evidence validation.
   * Side effects: None.
   */ (total, entry) => total + 1 + entry.locations.length, 0);
}

/**
 * Counts one binding candidate, selector evidence, and optional source location node.
 *
 * Inputs: A binding candidate fact.
 * Outputs: The exact unsaturated candidate graph cost.
 * Does not handle: Candidate resolution, location validation, or saturation.
 * Side effects: Calls `selectorGraphCost`.
 */
function bindingCandidateGraphCost(candidate: BindingCandidate): number {
  return 1 + selectorGraphCost(candidate.appliesWhen) + (candidate.location === undefined ? 0 : 1);
}

/**
 * Counts serialized execution/phase/stage/channel/condition selector values.
 *
 * Inputs: A scope selector fact.
 * Outputs: The exact count of all selector value entries and finite condition clauses.
 * Does not handle: Selector matching, unknown condition cost, or saturation.
 * Side effects: Reads selector arrays only.
 */
function selectorGraphCost(selector: ScopeSelector): number {
  const conditionCost = selector.condition.kind === "all"
    ? selector.condition.clauses.length
    : 0;
  return (
    (selector.executionUnitIds?.length ?? 0) +
    (selector.phases?.length ?? 0) +
    (selector.channels?.length ?? 0) +
    (selector.stage.kind === "exact" ? selector.stage.values.length : 0) +
    conditionCost
  );
}

/**
 * Counts a coverage gap, optional finite key-domain entries, and its selector evidence.
 *
 * Inputs: A coverage gap fact.
 * Outputs: The exact unsaturated graph cost.
 * Does not handle: Gap generation, matching, or saturation.
 * Side effects: Calls `selectorGraphCost`.
 */
function coverageGapGraphCost(gap: CoverageGap): number {
  return 1 + (gap.keyDomain?.kind === "keys" ? gap.keyDomain.keys.length : 0) +
    selectorGraphCost(gap.potentiallyAffects);
}

/**
 * Counts one materialized reconciliation record including kind-specific nested data and reasons.
 *
 * Inputs: A demand, inventory, or dynamic record from local analysis.
 * Outputs: The exact unsaturated record graph cost.
 * Does not handle: Record creation, validation, or saturation.
 * Side effects: Invokes nested edge/reason cost helpers.
 */
function reconciliationRecordGraphCost(
  record: LocalAnalysis["result"]["records"][number],
): number {
  const reasonCost = reconciliationReasonsGraphCost(record.reasons);
  if (record.kind === "demand") {
    return 1 + record.referenceIds.length + reasonCost;
  }
  if (record.kind === "inventory") {
    return 1 + reasonCost;
  }
  // Dynamic records serialize the lookup again in addition to the input edge.
  return 1 + dynamicLookupEdgeGraphCost(record.lookup) + reasonCost;
}

/**
 * Counts reconciliation reason nodes and their referenced gap/candidate ID arrays.
 *
 * Inputs: Reason objects with optional gap and candidate ID arrays.
 * Outputs: Exact unsaturated reason/evidence node count.
 * Does not handle: Reason validation, deduplication, or saturation.
 * Side effects: Iterates reason array.
 */
function reconciliationReasonsGraphCost(
  reasons: readonly {
    readonly gapIds?: readonly SafeIdentifier[];
    readonly candidateIds?: readonly SafeIdentifier[];
  }[],
): number {
  return reasons.reduce(
    /**
     * Adds one reason node and its gap/candidate identifier references.
     *
     * Inputs: Running count and one reconciliation reason.
     * Outputs: The prior count plus reason and optional ID-array lengths.
     * Does not handle: Saturation or ID validation.
     * Side effects: None.
     */ (total, reason) =>
      total +
      1 +
      (reason.gapIds?.length ?? 0) +
      (reason.candidateIds?.length ?? 0),
    0,
  );
}

/**
 * Fails closed to a fixed incomplete member report when actual materialized graph cost exceeds the reservation.
 *
 * Inputs: Prepared context, member handle, source facts, fallback scope, and newly materialized analysis.
 * Outputs: The supplied analysis when it fits its reservation; otherwise a fixed budget-exhausted analysis.
 * Does not handle: New reservation, source discovery, or partial-result truncation.
 * Side effects: Recounts in-memory graph shape and may allocate a fallback analysis.
 */
function enforceReservedMemberGraph(
  context: PreparedDeploymentContext,
  handle: IssuedDeploymentMember,
  source: SourceFacts,
  scope: ExecutionScope,
  analysis: LocalAnalysis,
): LocalAnalysis {
  const reservation = context.reservedGraphCosts.get(handle);
  if (reservation !== undefined && localAnalysisGraphCost(analysis) <= reservation) {
    return analysis;
  }
  // Estimators are deliberately conservative. This independent post-Core
  // assertion is a fail-closed invariant: an unforeseen graph shape is never
  // returned as a partially budgeted successful analysis.
  return budgetExhaustedAnalysis(scope);
}

/**
 * Builds the fixed one-scope incomplete analysis used whenever an invocation budget rejects materialization.
 *
 * Inputs: The execution scope to retain as detached coverage context.
 * Outputs: A frozen `LocalAnalysis` with empty input/records and one incomplete scope-coverage entry.
 * Does not handle: Retaining reason IDs, diagnostics, source facts, or partially materialized output.
 * Side effects: Allocates and freezes detached scope, reconciliation input/result, and reporting objects.
 */
function budgetExhaustedAnalysis(scope: ExecutionScope): LocalAnalysis {
  const privateScope = detachedFactSnapshot(scope);
  const privateInput: ReconciliationInput = {
    references: [],
    demandEdges: [],
    dynamicLookupEdges: [],
    targetStatuses: [],
    bindingCandidates: [],
    bindingResolutions: [],
    inventorySnapshots: [],
    coverageGaps: [],
    coverageInputs: [],
  };
  const reconciliationInput = detachedFactSnapshot(privateInput);
  const result = detachedFactSnapshot({
    records: [],
    scopeCoverage: [{
      scope: privateScope,
      state: "incomplete" as const,
      gapIds: [],
    }],
  });
  return Object.freeze({
    reconciliationInput,
    result,
    reportingInput: Object.freeze({
      result,
      references: reconciliationInput.references,
      demandEdges: reconciliationInput.demandEdges,
    }),
    diagnostics: Object.freeze([]),
  });
}

/**
 * Assigns bounded candidate and coverage-gap planning state to declared member scopes before Core materialization.
 *
 * Inputs: Prepared documents, unique repository/scope pairs, and mutable invocation budget.
 * Outputs: A frozen plan of mutable member selections, reserved coverage cost, and fixed fanout diagnostics; duplicate IDs throw safety failure.
 * Does not handle: Core resolution, inventory assignment, document I/O, or report creation.
 * Side effects: Allocates/mutates member maps/arrays and may decrement invocation budget while distributing coverage gaps.
 */
function planPreparedDeploymentContext(
  documents: PreparedDeploymentDocuments,
  memberScopes: readonly DeploymentMemberScope[],
  budget: WorkspaceInvocationContext,
): PreparedDeploymentPlan {
  const members = new Map<SafeIdentifier, MutableMemberProvisioningSelection>();
  const membersByExecutionUnitId = new Map<
    SafeIdentifier,
    MutableMemberProvisioningSelection[]
  >();
  for (const member of memberScopes) {
    if (
      members.has(member.repositoryId)
    ) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    const selection: MutableMemberProvisioningSelection = {
      scope: member.scope,
      bindingCandidates: [],
      bindingResolutions: [],
      unscopedInventoryOwnerCandidateIds: new Set(),
      effectiveExactBindings: [],
      effectiveProviderResourceKeys: new Set(),
      closedCoverageGaps: [],
      bindingCoverageGaps: [],
      inventoryItems: [],
      inventoryCoverageGaps: [],
      bindingOwnershipUncertain: false,
      inventoryOwnershipUncertain: false,
      coverageGapFanoutUncertain: false,
    };
    members.set(member.repositoryId, selection);
    const byScopeId = membersByExecutionUnitId.get(member.scope.id) ?? [];
    byScopeId.push(selection);
    membersByExecutionUnitId.set(member.scope.id, byScopeId);
  }
  const allMembers = [...members.values()];
  const coverageMembers = allMembers;

  const diagnostics: SafeDiagnosticCode[] = [];
  let bindingMemberAssignments = 0;
  let bindingFanoutExceeded = false;

  for (const candidate of documents.bindings.candidates) {
    const possibleMembers = membersByExecutionUnitId.get(candidate.scope.id);
    if (possibleMembers === undefined) {
      const potentialCount = potentialMemberCount(
        candidate.appliesWhen,
        membersByExecutionUnitId,
        allMembers,
      );
      if (bindingMemberAssignments + potentialCount > MAX_DEPLOYMENT_BINDING_MEMBER_ASSIGNMENTS) {
        bindingFanoutExceeded = true;
        break;
      }
      bindingMemberAssignments += potentialCount;
      markPotentialBindingOwnershipUncertain(
        candidate,
        membersByExecutionUnitId,
        allMembers,
      );
      continue;
    }
    if (
      bindingMemberAssignments + possibleMembers.length >
        MAX_DEPLOYMENT_BINDING_MEMBER_ASSIGNMENTS
    ) {
      bindingFanoutExceeded = true;
      break;
    }
    bindingMemberAssignments += possibleMembers.length;
    for (const member of possibleMembers) {
      const relation = relationToMemberScope(candidate.scope, member.scope);
      if (relation === "covers") {
        member.bindingCandidates.push(candidate);
      } else if (relation === "overlaps") {
        member.bindingOwnershipUncertain = true;
      } else if (selectorMayAffectScope(candidate.appliesWhen, member.scope)) {
        // The declared target and applicability selector disagree. Do not
        // reinterpret either field as a cross-member binding, but preserve
        // uncertainty for the only member the candidate could name.
        member.bindingOwnershipUncertain = true;
      }
    }
  }

  if (bindingFanoutExceeded) {
    for (const member of allMembers) {
      member.bindingCandidates.length = 0;
      member.bindingOwnershipUncertain = true;
    }
    diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_BINDING_FANOUT_EXCEEDED"));
  }

  const coverageGapDistribution = reserveAndDistributeCoverageGaps(
    [
      { gaps: documents.closed.coverageGaps, field: "closedCoverageGaps" as const },
      { gaps: documents.bindings.coverageGaps, field: "bindingCoverageGaps" as const },
      { gaps: documents.inventory.coverageGaps, field: "inventoryCoverageGaps" as const },
    ],
    membersByExecutionUnitId,
    coverageMembers,
    budget,
  );
  if (!coverageGapDistribution.ok) {
    for (const member of coverageMembers) {
      member.coverageGapFanoutUncertain = true;
      member.closedCoverageGaps.length = 0;
      member.bindingCoverageGaps.length = 0;
      member.inventoryCoverageGaps.length = 0;
    }
    diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_COVERAGE_GAP_FANOUT_EXCEEDED"));
  }

  const coverageReservedFacts = new Map<SafeIdentifier, number>();
  for (const [repositoryId, member] of members) {
    const coverageReservation = coverageGapDistribution.costs.get(member) ?? 0;
    if (coverageReservation > 0) {
      coverageReservedFacts.set(repositoryId, coverageReservation);
    }
  }
  return Object.freeze({
    documents,
    members,
    coverageReservedFacts,
    diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
  });
}

/**
 * Materializes Core binding resolutions and inventory ownership only for members whose full reservations succeeded.
 *
 * Inputs: A prepared plan and admitted repository ID set.
 * Outputs: A built context containing frozen member provisioning selections, coverage reservations, and diagnostics.
 * Does not handle: Admitting new members, source/document I/O, or partial output for rejected members.
 * Side effects: Mutates plan member selections, invokes Core resolver, allocates maps/sets/arrays, and assigns inventory items.
 */
function materializePreparedDeploymentContext(
  plan: PreparedDeploymentPlan,
  admittedRepositoryIds: ReadonlySet<SafeIdentifier>,
): BuiltDeploymentContext {
  const members = new Map<SafeIdentifier, MutableMemberProvisioningSelection>();
  const membersByExecutionUnitId = new Map<
    SafeIdentifier,
    MutableMemberProvisioningSelection[]
  >();
  for (const [repositoryId, member] of plan.members) {
    if (!admittedRepositoryIds.has(repositoryId)) continue;
    members.set(repositoryId, member);
    const byScopeId = membersByExecutionUnitId.get(member.scope.id) ?? [];
    byScopeId.push(member);
    membersByExecutionUnitId.set(member.scope.id, byScopeId);
  }
  const allMembers = [...members.values()];
  const diagnostics: SafeDiagnosticCode[] = [];

  for (const member of allMembers) {
    const exactCandidates = resolutionCandidatesForScope(
      member.scope,
      member.bindingCandidates,
    );
    const bindingResolutions = coreBindingResolutionPort.resolve(exactCandidates);
    member.bindingResolutions = bindingResolutions;
    for (const candidate of uniqueEffectiveExactBindingsForScope(
      member.scope,
      exactCandidates,
      bindingResolutions,
    )) {
      member.unscopedInventoryOwnerCandidateIds.add(candidate.id);
      member.effectiveExactBindings.push(candidate);
      const resource = candidate.providerResourceId;
      if (resource !== undefined) {
        member.effectiveProviderResourceKeys.add(
          providerResourceKey(resource.authorityId, resource.canonicalId),
        );
      }
    }
  }

  const snapshot = plan.documents.inventory.snapshot;
  if (snapshot !== undefined) {
    let inventoryMemberAssignments = 0;
    let inventoryFanoutExceeded = false;
    const explicitBindingsByResource = new Map<string, Set<MutableMemberProvisioningSelection>>();
    for (const member of allMembers) {
      for (const candidate of member.effectiveExactBindings) {
        const resource = candidate.providerResourceId;
        if (resource === undefined) continue;
        if (resource.authorityId !== snapshot.authorityId) {
          member.inventoryOwnershipUncertain = true;
          continue;
        }
        const key = providerResourceKey(resource.authorityId, resource.canonicalId);
        const owners = explicitBindingsByResource.get(key) ?? new Set<MutableMemberProvisioningSelection>();
        owners.add(member);
        explicitBindingsByResource.set(key, owners);
      }
    }

    inventoryItems: for (const item of snapshot.items) {
      const declaredScopes = item.declaredScopes;
      if (declaredScopes === undefined || declaredScopes.length === 0) {
        const owners = explicitBindingsByResource.get(
          providerResourceKey(item.providerResourceId.authorityId, item.providerResourceId.canonicalId),
        );
        if (owners === undefined || owners.size === 0) {
          diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_UNATTRIBUTED_INVENTORY"));
          markInventoryOwnershipUncertain(allMembers);
          continue;
        }
        if (inventoryMemberAssignments + owners.size > MAX_DEPLOYMENT_BINDING_MEMBER_ASSIGNMENTS) {
          inventoryFanoutExceeded = true;
          break inventoryItems;
        }
        inventoryMemberAssignments += owners.size;
        for (const owner of owners) {
          owner.inventoryItems.push(item);
        }
        continue;
      }

      const matching = new Set<MutableMemberProvisioningSelection>();
      const affected = new Set<MutableMemberProvisioningSelection>();
      let unknownOwnership = false;
      for (const declaredScope of declaredScopes) {
        const possibleMembers = membersByExecutionUnitId.get(declaredScope.id);
        if (possibleMembers === undefined) {
          if (!isExplicitOutsideScope(declaredScope)) {
            unknownOwnership = true;
          }
          continue;
        }
        if (
          inventoryMemberAssignments + possibleMembers.length >
            MAX_DEPLOYMENT_BINDING_MEMBER_ASSIGNMENTS
        ) {
          inventoryFanoutExceeded = true;
          break inventoryItems;
        }
        inventoryMemberAssignments += possibleMembers.length;
        for (const member of possibleMembers) {
          const relation = relationToMemberScope(declaredScope, member.scope);
          if (relation === "covers") {
            matching.add(member);
          } else if (relation === "overlaps") {
            affected.add(member);
          }
        }
      }

      if (unknownOwnership) {
        markInventoryOwnershipUncertain(allMembers);
        continue;
      }

      if (matching.size === 1 && affected.size === 0) {
        const owner = [...matching][0];
        if (owner !== undefined) {
          owner.inventoryItems.push(item);
        }
        continue;
      }

      if (
        matching.size > 1 &&
        affected.size === 0 &&
        [...matching].every(/**
          * Confirms every multi-owner member has an exact effective binding for the inventory resource.
          *
          * Inputs: One candidate owner selection.
          * Outputs: `true` when that member owns the resource through an exact binding.
          * Does not handle: Scope overlap or inventory authority validation.
          * Side effects: Reads the member's effective resource set.
          */ (member) => memberHasExactBindingForResource(member, item))
      ) {
        for (const member of matching) {
          member.inventoryItems.push(item);
        }
        continue;
      }

      for (const member of matching) {
        member.inventoryOwnershipUncertain = true;
      }
      for (const member of affected) {
        member.inventoryOwnershipUncertain = true;
      }
    }
    if (inventoryFanoutExceeded) {
      for (const member of allMembers) {
        member.inventoryItems.length = 0;
        member.inventoryOwnershipUncertain = true;
      }
      diagnostics.push(memberDiagnostic("WORKSPACE_DEPLOYMENT_INVENTORY_FANOUT_EXCEEDED"));
    }
  }

  const finalized = new Map<SafeIdentifier, MemberProvisioningSelection>();
  const coverageReservedFacts = new Map<SafeIdentifier, number>();
  for (const [repositoryId, member] of members) {
    const coverageReservation = plan.coverageReservedFacts.get(repositoryId);
    if (coverageReservation !== undefined && coverageReservation > 0) {
      coverageReservedFacts.set(repositoryId, coverageReservation);
    }
    const inventorySnapshot = snapshot === undefined
      ? undefined
      : Object.freeze({
          ...snapshot,
          items: Object.freeze([...member.inventoryItems]),
        });
    finalized.set(repositoryId, Object.freeze({
      scope: member.scope,
      bindingCandidates: Object.freeze([...member.bindingCandidates]),
      bindingResolutions: member.bindingResolutions,
      unscopedInventoryOwnerCandidateIds: member.unscopedInventoryOwnerCandidateIds,
      closedCoverageGaps: Object.freeze([...member.closedCoverageGaps]),
      bindingCoverageGaps: Object.freeze([...member.bindingCoverageGaps]),
      ...(inventorySnapshot === undefined ? {} : { inventorySnapshot }),
      inventoryCoverageGaps: Object.freeze([...member.inventoryCoverageGaps]),
      bindingOwnershipUncertain: member.bindingOwnershipUncertain,
      inventoryOwnershipUncertain: member.inventoryOwnershipUncertain,
      coverageGapFanoutUncertain: member.coverageGapFanoutUncertain,
    }));
  }
  return Object.freeze({
    documents: plan.documents,
    members: finalized,
    coverageReservedFacts,
    diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
  });
}

interface CoverageGapDistribution {
  readonly ok: boolean;
  readonly costs: ReadonlyMap<MutableMemberProvisioningSelection, number>;
}

/**
 * Reserves every relevant member copy of parsed coverage gaps before appending any copy to member selections.
 *
 * Inputs: Gap arrays by destination field, member indexes, eligible members, and mutable invocation budget.
 * Outputs: Frozen success with per-member copy costs, or frozen `ok: false` without partial distribution on insufficient budget.
 * Does not handle: Creating parser gaps, Core coverage evaluation, or rerunning budget admission.
 * Side effects: On success decrements budget and mutates selected member gap arrays; allocates sets/maps.
 */
function reserveAndDistributeCoverageGaps(
  distributions: readonly {
    readonly gaps: readonly CoverageGap[];
    readonly field: "closedCoverageGaps" | "bindingCoverageGaps" | "inventoryCoverageGaps";
  }[],
  membersByExecutionUnitId: ReadonlyMap<
    SafeIdentifier,
    readonly MutableMemberProvisioningSelection[]
  >,
  eligibleMembers: readonly MutableMemberProvisioningSelection[],
  budget: WorkspaceInvocationContext,
): CoverageGapDistribution {
  const eligible = new Set(eligibleMembers);
  const costs = new Map<MutableMemberProvisioningSelection, number>();
  let requiredAssignments = 0;

  // Count every materialized member copy before touching any member array.
  // This makes an exhausted fanout a fixed scoped uncertainty rather than a
  // schedule-dependent partial gap graph.
  for (const distribution of distributions) {
    const seen = new Set<CoverageGap>();
    for (const gap of distribution.gaps) {
      if (seen.has(gap)) continue;
      seen.add(gap);
      const affected = coverageGapAffectedMembers(
        gap,
        membersByExecutionUnitId,
        eligibleMembers,
        eligible,
      );
      if (affected.length > budget.factBudgetRemaining - requiredAssignments) {
        return Object.freeze({ ok: false, costs: new Map() });
      }
      requiredAssignments += affected.length;
      for (const member of affected) {
        costs.set(member, (costs.get(member) ?? 0) + 1);
      }
    }
  }
  budget.factBudgetRemaining -= requiredAssignments;

  // Repeat the bounded selector walk only after the full reservation
  // succeeds. Every member receives either its complete relevant gap set or
  // none of it.
  for (const distribution of distributions) {
    const seen = new Set<CoverageGap>();
    for (const gap of distribution.gaps) {
      if (seen.has(gap)) continue;
      seen.add(gap);
      for (const member of coverageGapAffectedMembers(
        gap,
        membersByExecutionUnitId,
        eligibleMembers,
        eligible,
      )) {
        member[distribution.field].push(gap);
      }
    }
  }
  return Object.freeze({ ok: true, costs });
}

/**
 * Selects eligible members whose scope may be affected by one coverage-gap selector.
 *
 * Inputs: One coverage gap, execution-unit index, eligible member list/set.
 * Outputs: A new list of unique eligible selections whose scopes may be affected.
 * Does not handle: Gap distribution, budget reservation, or exact selector coverage proof.
 * Side effects: Allocates temporary member set/array and invokes selector matching.
 */
function coverageGapAffectedMembers(
  gap: CoverageGap,
  membersByExecutionUnitId: ReadonlyMap<
    SafeIdentifier,
    readonly MutableMemberProvisioningSelection[]
  >,
  eligibleMembers: readonly MutableMemberProvisioningSelection[],
  eligible: ReadonlySet<MutableMemberProvisioningSelection>,
): readonly MutableMemberProvisioningSelection[] {
  const possible = new Set<MutableMemberProvisioningSelection>();
  const scopeIds = gap.potentiallyAffects.executionUnitIds;
  if (scopeIds === undefined) {
    for (const member of eligibleMembers) {
      possible.add(member);
    }
  } else {
    for (const scopeId of scopeIds) {
      for (const member of membersByExecutionUnitId.get(scopeId) ?? []) {
        if (eligible.has(member)) {
          possible.add(member);
        }
      }
    }
  }
  return [...possible].filter(/**
    * Retains one possible member when the gap selector may affect its execution scope.
    *
    * Inputs: One mutable member selection.
    * Outputs: `true` when selector overlap is possible.
    * Does not handle: Exact coverage or gap ownership.
    * Side effects: Invokes selector matching.
    */ (member) =>
    selectorMayAffectScope(gap.potentiallyAffects, member.scope),
  );
}

/**
 * Marks members uncertain when an out-of-index candidate's selector could still affect their scopes.
 *
 * Inputs: One binding candidate, execution-unit member index, and all candidate members.
 * Outputs: `undefined` after marking only selector-reachable members uncertain.
 * Does not handle: Candidate assignment, exact scope coverage, or document validation.
 * Side effects: Mutates `bindingOwnershipUncertain` on reachable member selections.
 */
function markPotentialBindingOwnershipUncertain(
  candidate: BindingCandidate,
  membersByExecutionUnitId: ReadonlyMap<
    SafeIdentifier,
    readonly MutableMemberProvisioningSelection[]
  >,
  allMembers: readonly MutableMemberProvisioningSelection[],
): void {
  const scopeIds = candidate.appliesWhen.executionUnitIds;
  const possibleMembers = scopeIds === undefined
    ? allMembers
    : scopeIds.flatMap(/**
      * Retrieves indexed members for one selector execution-unit ID.
      *
      * Inputs: One safe execution-unit identifier.
      * Outputs: Its indexed member list or an empty list when absent.
      * Does not handle: Selector matching or member mutation.
      * Side effects: Reads the execution-unit map.
      */ (scopeId) => membersByExecutionUnitId.get(scopeId) ?? []);
  for (const member of possibleMembers) {
    if (selectorMayAffectScope(candidate.appliesWhen, member.scope)) {
      member.bindingOwnershipUncertain = true;
    }
  }
}

/**
 * Counts member selections that a binding selector could fan out to before allocation.
 *
 * Inputs: A candidate selector, execution-unit index, and full member list.
 * Outputs: All-member count without explicit units or sum of indexed counts for explicit units.
 * Does not handle: Selector phase/stage/channel overlap or duplicate execution-unit IDs.
 * Side effects: Reads member arrays/maps only.
 */
function potentialMemberCount(
  selector: ScopeSelector,
  membersByExecutionUnitId: ReadonlyMap<
    SafeIdentifier,
    readonly MutableMemberProvisioningSelection[]
  >,
  allMembers: readonly MutableMemberProvisioningSelection[],
): number {
  if (selector.executionUnitIds === undefined) {
    return allMembers.length;
  }
  let count = 0;
  for (const scopeId of selector.executionUnitIds) {
    count += membersByExecutionUnitId.get(scopeId)?.length ?? 0;
  }
  return count;
}

/**
 * Recognizes a fully concrete scope that can safely be treated as explicitly outside this deployment.
 *
 * Inputs: One declared inventory execution scope.
 * Outputs: `true` only when phase/channel are known and stage is exact.
 * Does not handle: Matching a member scope or checking execution-unit identity.
 * Side effects: None.
 */
function isExplicitOutsideScope(scope: ExecutionScope): boolean {
  return (
    scope.phase !== "unknown" &&
    scope.channel !== "unknown" &&
    scope.stage.kind === "exact"
  );
}

/**
 * Marks every provided member selection uncertain about inventory ownership.
 *
 * Inputs: Member selections to invalidate for an ambiguous/unattributed inventory condition.
 * Outputs: `undefined` after all selections are marked.
 * Does not handle: Clearing assigned inventory items, diagnostics, or binding ownership.
 * Side effects: Mutates each selection's `inventoryOwnershipUncertain` flag.
 */
function markInventoryOwnershipUncertain(
  members: readonly MutableMemberProvisioningSelection[],
): void {
  for (const member of members) {
    member.inventoryOwnershipUncertain = true;
  }
}

/**
 * Classifies a declared scope as covering, overlapping, or outside one member scope.
 *
 * Inputs: Declared inventory/binding scope and member execution scope.
 * Outputs: `covers`, `overlaps`, or `outside`.
 * Does not handle: Selector applicability or scope mutation.
 * Side effects: Invokes Core scope/overlap predicates.
 */
function relationToMemberScope(
  declared: ExecutionScope,
  member: ExecutionScope,
): "covers" | "overlaps" | "outside" {
  if (scopeCovers(declared, member)) {
    return "covers";
  }
  return scopesMayOverlap(declared, member)
    ? "overlaps"
    : "outside";
}

/**
 * Tests conservative execution-scope overlap when IDs match and known dimensions do not conflict.
 *
 * Inputs: Two execution scopes.
 * Outputs: `true` for possible overlap and `false` for different IDs or incompatible known dimensions/stages.
 * Does not handle: Condition selector applicability or scope coverage proof.
 * Side effects: Invokes Core stage-overlap predicate.
 */
function scopesMayOverlap(
  left: ExecutionScope,
  right: ExecutionScope,
): boolean {
  return (
    left.id === right.id &&
    (left.phase === "unknown" || right.phase === "unknown" || left.phase === right.phase) &&
    (left.channel === "unknown" || right.channel === "unknown" || left.channel === right.channel) &&
    stagesMayOverlap(left.stage, right.stage)
  );
}

/**
 * Selects exactly one effective binding per destination that Core proves covers the member scope.
 *
 * Inputs: A member scope, its candidate bindings, and materialized binding resolutions.
 * Outputs: A list of single selected candidates for destinations with effective exact resolution.
 * Does not handle: Dynamic declarations, inventory item assignment, or source/document parsing.
 * Side effects: Allocates destination-index maps and result array; invokes Core resolution helpers.
 */
function uniqueEffectiveExactBindingsForScope(
  scope: ExecutionScope,
  candidates: readonly BindingCandidate[],
  resolutions: ReconciliationInput["bindingResolutions"],
): readonly BindingCandidate[] {
  const candidatesByDestination = new Map<
    string,
    { readonly destination: BindingCandidate["destination"]; readonly candidates: BindingCandidate[] }
  >();
  for (const candidate of candidates) {
    const key = destinationKey(candidate.destination);
    if (key === undefined) {
      continue;
    }
    const group = candidatesByDestination.get(key) ?? {
      destination: candidate.destination,
      candidates: [],
    };
    group.candidates.push(candidate);
    candidatesByDestination.set(key, group);
  }

  const resolutionsByDestination = new Map<
    string,
    Array<ReconciliationInput["bindingResolutions"][number]>
  >();
  for (const resolution of resolutions) {
    const key = destinationKey(resolution.destination);
    if (key === undefined) {
      continue;
    }
    const group = resolutionsByDestination.get(key) ?? [];
    group.push(resolution);
    resolutionsByDestination.set(key, group);
  }

  const effective: BindingCandidate[] = [];
  for (const [key, group] of candidatesByDestination) {
    const destinationResolutions = resolutionsByDestination.get(key) ?? [];
    if (
      bindingResolutionStatusFor(
        scope,
        group.destination,
        destinationResolutions,
      ) !== "effective"
    ) {
      continue;
    }
    const selected = effectiveBindingCandidatesFor(
      scope,
      group.destination,
      group.candidates,
      destinationResolutions,
    );
    if (selected.length === 1 && selected[0] !== undefined) {
      effective.push(selected[0]);
    }
  }
  return effective;
}

/**
 * Filters exact candidates for one member scope while excluding destinations shadowed by applicable dynamic declarations.
 *
 * Inputs: A member scope and parsed binding candidates.
 * Outputs: Exact candidates whose destinations are not marked dynamic for the scope.
 * Does not handle: Core precedence resolution, selector normalization, or candidate mutation.
 * Side effects: Allocates a destination set and evaluates Core scope/selector predicates.
 */
function resolutionCandidatesForScope(
  scope: ExecutionScope,
  candidates: readonly BindingCandidate[],
): readonly BindingCandidate[] {
  const dynamicDestinations = new Set<string>();
  for (const candidate of candidates) {
    const key = destinationKey(candidate.destination);
    if (
      key !== undefined &&
      candidate.resolution === "dynamic" &&
      scopeCovers(candidate.scope, scope) &&
      selectorMayAffectScope(candidate.appliesWhen, scope)
    ) {
      dynamicDestinations.add(key);
    }
  }
  return candidates.filter(/**
    * Keeps one exact candidate only when no applicable dynamic candidate shares its destination.
    *
    * Inputs: One binding candidate.
    * Outputs: `true` for an exact nonshadowed candidate.
    * Does not handle: Scope coverage of exact candidates or precedence resolution.
    * Side effects: Reads the enclosing dynamic-destination set.
    */ (candidate) => {
    const key = destinationKey(candidate.destination);
    return (
      candidate.resolution === "exact" &&
      (key === undefined || !dynamicDestinations.has(key))
    );
  });
}

/**
 * Encodes a binding destination with a concrete name as a namespace/name lookup key.
 *
 * Inputs: One binding destination fact.
 * Outputs: Tuple string for concrete names or `undefined` for nonstring/unknown names.
 * Does not handle: Name validation, secret redaction, or scope relation.
 * Side effects: None.
 */
function destinationKey(destination: BindingCandidate["destination"]): string | undefined {
  return typeof destination.name === "string"
    ? destination.namespace + "\u0000" + destination.name
    : undefined;
}

/**
 * Tests whether a member's effective exact bindings include an inventory item's provider resource.
 *
 * Inputs: Mutable member selection and one inventory item.
 * Outputs: `true` when its effective resource-key set contains the item's authority/canonical tuple.
 * Does not handle: Scope ownership, inventory authority mismatch, or binding resolution.
 * Side effects: Reads member set and computes a tuple key.
 */
function memberHasExactBindingForResource(
  member: MutableMemberProvisioningSelection,
  item: InventoryItem,
): boolean {
  return member.effectiveProviderResourceKeys.has(
    providerResourceKey(
      item.providerResourceId.authorityId,
      item.providerResourceId.canonicalId,
    ),
  );
}

/**
 * Encodes a provider authority and canonical resource ID into an internal map/set key.
 *
 * Inputs: Safe authority and resource identifiers.
 * Outputs: A delimiter-separated tuple string.
 * Does not handle: Identifier validation, display rendering, or cross-provider equivalence.
 * Side effects: None.
 */
function providerResourceKey(authorityId: SafeIdentifier, canonicalId: SafeIdentifier): string {
  return String(authorityId) + "\u0000" + String(canonicalId);
}

/**
 * Normalizes one fixed internal workspace member diagnostic token through a new safety factory.
 *
 * Inputs: A constant diagnostic token string controlled by this module.
 * Outputs: The corresponding `SafeDiagnosticCode`.
 * Does not handle: Caller-provided arbitrary diagnostic text or reporting.
 * Side effects: Allocates a short-lived `SafeFactFactory`.
 */
function memberDiagnostic(value: string): SafeDiagnosticCode {
  return new SafeFactFactory().diagnosticCode(value);
}

/**
 * Combines prepared documents and one member selection into reconciliation provisioning facts with scoped uncertainty.
 *
 * Inputs: Scope-bound source facts, prepared deployment documents, and finalized member provisioning selection.
 * Outputs: A promise for parsed provisioning arrays/model/coverage inputs/diagnostics; rejects only from async root verification.
 * Does not handle: Document I/O, member admission, source extraction, or public raw document exposure.
 * Side effects: Allocates gap builder/arrays and performs in-memory safe root-coverage checks through a helper.
 */
async function collectPreparedMemberProvisioning(
  source: SourceFacts,
  documents: PreparedDeploymentDocuments,
  member: MemberProvisioningSelection,
): Promise<ParsedProvisioning> {
  const gaps = new AppGapBuilder(source.factory, source.selector, source.coverageGaps.length);
  const diagnostics: SafeDiagnosticCode[] = [];

  if (documents.closed.failure !== undefined) {
    gaps.add("binding", "closed-model-input");
  }
  diagnostics.push(...documents.closed.diagnostics);
  if (documents.bindings.failure !== undefined || documents.bindings.inputId === undefined) {
    gaps.add("binding", "binding-input");
  }
  diagnostics.push(...documents.bindings.diagnostics);
  if (documents.inventory.failure !== undefined || documents.inventory.inputId === undefined) {
    gaps.add("inventory", "inventory-input");
  }
  diagnostics.push(...documents.inventory.diagnostics);

  if (member.bindingOwnershipUncertain) {
    gaps.add("binding", "workspace-member-binding-ownership");
    diagnostics.push(
      source.factory.diagnosticCode("WORKSPACE_MEMBER_BINDING_OWNERSHIP_UNRESOLVED"),
    );
  }
  if (member.inventoryOwnershipUncertain) {
    gaps.add("inventory", "workspace-member-inventory-ownership");
    diagnostics.push(
      source.factory.diagnosticCode("WORKSPACE_MEMBER_INVENTORY_OWNERSHIP_UNRESOLVED"),
    );
  }
  if (member.coverageGapFanoutUncertain) {
    gaps.add("demand", "workspace-member-coverage-gap-fanout");
    diagnostics.push(
      source.factory.diagnosticCode("WORKSPACE_MEMBER_COVERAGE_GAP_FANOUT_EXCEEDED"),
    );
  }

  const closedModel = documents.closed.model;
  const bindingComplete =
    documents.bindings.failure === undefined &&
    documents.bindings.inputId !== undefined &&
    member.bindingCoverageGaps.length === 0 &&
    !member.bindingOwnershipUncertain &&
    !member.coverageGapFanoutUncertain;
  const inventoryComplete =
    documents.inventory.failure === undefined &&
    documents.inventory.inputId !== undefined &&
    member.inventorySnapshot !== undefined &&
    member.inventoryCoverageGaps.length === 0 &&
    !member.inventoryOwnershipUncertain &&
    !member.coverageGapFanoutUncertain;

  const sourceStatus = coverageInput(
    source.factory,
    DEFAULT_SOURCE_INPUT_ID,
    "demand",
    source.coverageGaps.length === 0 ? "complete" : "incomplete",
    source.selector,
  );
  const coverageInputs: CoverageInputStatus[] = [sourceStatus];
  if (documents.bindings.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        documents.bindings.inputId,
        "binding",
        bindingComplete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }
  if (documents.inventory.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        documents.inventory.inputId,
        "inventory",
        inventoryComplete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }

  if (
    closedModel !== undefined &&
    !(await closedModelRootsAreVerifiable(
      source,
      closedModel,
      documents.bindingDocument,
      documents.verificationBase,
    ))
  ) {
    gaps.add("binding", "closed-model-root-verification");
    diagnostics.push(source.factory.diagnosticCode("APP_CLOSED_MODEL_ROOT_UNVERIFIED"));
  }

  return {
    bindingCandidates: member.bindingCandidates,
    bindingResolutions: member.bindingResolutions,
    inventorySnapshots: member.inventorySnapshot === undefined ? [] : [member.inventorySnapshot],
    ...(closedModel === undefined ? {} : { closedModel }),
    coverageGaps: Object.freeze([
      ...member.closedCoverageGaps,
      ...member.bindingCoverageGaps,
      ...member.inventoryCoverageGaps,
      ...gaps.values,
    ]),
    coverageInputs: Object.freeze(coverageInputs),
    diagnostics: Object.freeze(uniqueDiagnostics(diagnostics)),
  };
}

/**
 * Deduplicates and sorts safe diagnostics for deterministic report output.
 *
 * Inputs: A readonly diagnostic code sequence.
 * Outputs: A frozen sorted array containing each code once.
 * Does not handle: Diagnostic validation, severity ordering, or source of codes.
 * Side effects: Allocates a set, copied array, and frozen result.
 */
function uniqueDiagnostics(values: readonly SafeDiagnosticCode[]): readonly SafeDiagnosticCode[] {
  return Object.freeze([...new Set(values)].sort(/**
    * Orders two safe diagnostic codes lexically for deterministic output.
    *
    * Inputs: Two normalized diagnostic code strings.
    * Outputs: Their locale comparison number.
    * Does not handle: Severity or category ordering.
    * Side effects: None.
    */ (left, right) => left.localeCompare(right)));
}

/**
 * Builds scan-only provisioning state with source coverage status and no binding/inventory/closed facts.
 *
 * Inputs: Private source facts whose scope/selector and gaps determine demand coverage.
 * Outputs: A parsed provisioning object with empty provisioning arrays and one source coverage input.
 * Does not handle: Binding/inventory document parsing or closed-model verification.
 * Side effects: Allocates one coverage input and empty arrays.
 */
function emptyProvisioning(source: SourceFacts): ParsedProvisioning {
  return {
    bindingCandidates: [],
    bindingResolutions: [],
    inventorySnapshots: [],
    coverageGaps: [],
    coverageInputs: [
      coverageInput(
        source.factory,
        DEFAULT_SOURCE_INPUT_ID,
        "demand",
        source.coverageGaps.length === 0 ? "complete" : "incomplete",
        source.selector,
      ),
    ],
    diagnostics: [],
  };
}

/**
 * Parses standalone reconcile documents and combines them with source coverage into provisioning input facts.
 *
 * Inputs: Private source facts and local JSON read results for bindings, inventory, optional closed model/base.
 * Outputs: A promise for parsed provisioning facts with fixed coverage gaps/diagnostics; factory/Core safety failures may reject.
 * Does not handle: Document reads, remote providers, implicit verification bases, or raw parse error propagation.
 * Side effects: Invokes adapter parsers, allocates gap/diagnostic arrays, and performs in-memory safe root coverage verification.
 */
async function collectProvisioning(
  source: SourceFacts,
  documents: ReconcileDocuments,
): Promise<ParsedProvisioning> {
  const builder = adaptCoreFactBuilder(source.factory);
  const gaps = new AppGapBuilder(source.factory, source.selector, source.coverageGaps.length);
  const diagnostics: SafeDiagnosticCode[] = [];

  const closed = collectClosedModel(documents.closedModel, builder, gaps, diagnostics);
  const binding = collectBindings(documents.bindings, builder, source.factory, gaps, diagnostics);
  const inventory = collectInventory(documents.inventory, builder, source.factory, gaps, diagnostics);

  const closedModel = closed.model;
  const sourceStatus = coverageInput(
    source.factory,
    DEFAULT_SOURCE_INPUT_ID,
    "demand",
    source.coverageGaps.length === 0 ? "complete" : "incomplete",
    source.selector,
  );

  const coverageInputs: CoverageInputStatus[] = [sourceStatus];
  if (binding.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        binding.inputId,
        "binding",
        binding.complete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }
  if (inventory.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        inventory.inputId,
        "inventory",
        inventory.complete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }

  if (
    closedModel !== undefined &&
    !(await closedModelRootsAreVerifiable(
      source,
      closedModel,
      preparedBindingDocument(documents.bindings),
      documents.verificationBase,
    ))
  ) {
    gaps.add("binding", "closed-model-root-verification");
    diagnostics.push(source.factory.diagnosticCode("APP_CLOSED_MODEL_ROOT_UNVERIFIED"));
  }

  return {
    bindingCandidates: binding.candidates,
    bindingResolutions: coreBindingResolutionPort.resolve(
      resolutionCandidatesForScope(source.scope, binding.candidates),
    ),
    inventorySnapshots: inventory.snapshot === undefined ? [] : [inventory.snapshot],
    ...(closedModel === undefined ? {} : { closedModel }),
    coverageGaps: Object.freeze([...closed.coverageGaps, ...binding.coverageGaps, ...inventory.coverageGaps, ...gaps.values]),
    coverageInputs: Object.freeze(coverageInputs),
    diagnostics: Object.freeze(diagnostics),
  };
}

/**
 * Parses an optional standalone closed-model document and records safe gap/diagnostic consequences.
 *
 * Inputs: Optional local JSON read result, Core builder adapter, mutable gap builder, and diagnostics array.
 * Outputs: Parsed model when available and adapter coverage gaps; absence/read failure returns no model.
 * Does not handle: File I/O, root coverage verification, or binding/inventory parsing.
 * Side effects: Mutates supplied gaps/diagnostics and invokes closed-model parser.
 */
function collectClosedModel(
  document: LocalJsonReadResult | undefined,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly model?: ClosedProvisioningModel;
  readonly coverageGaps: readonly CoverageGap[];
} {
  if (document === undefined) {
    return { coverageGaps: [] };
  }
  if (!document.ok) {
    gaps.add("binding", "closed-model-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { coverageGaps: [] };
  }

  const parsed = parseClosedProvisioningModel(document.value, builder);
  if (parserLimitExceeded(parsed)) {
    gaps.add("binding", "provisioning-input-entry-limit-exceeded");
    diagnostics.push(provisioningInputLimitDiagnostic(new SafeFactFactory()));
  }
  return {
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    coverageGaps: parsed.coverageGaps,
  };
}

/**
 * Parses standalone bindings and records fixed uncertainty for failed/invalid/limited input.
 *
 * Inputs: Binding JSON result, Core builder, fact factory, mutable gap builder, and diagnostics array.
 * Outputs: Candidate/gap/input-ID/complete state; failure yields empty candidates and incomplete state.
 * Does not handle: File I/O, binding resolution, or raw parser error serialization.
 * Side effects: Mutates supplied gaps/diagnostics and invokes binding parser/factory validators.
 */
function collectBindings(
  document: LocalJsonReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly candidates: readonly BindingCandidate[];
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
} {
  if (!document.ok) {
    gaps.add("binding", "binding-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { candidates: [], coverageGaps: [], complete: false };
  }

  const parsed = parseBindingManifest(document.value, builder);
  const inputId = localInputId(document.value, factory);
  if (parserLimitExceeded(parsed)) {
    gaps.add("binding", "provisioning-input-entry-limit-exceeded");
    diagnostics.push(provisioningInputLimitDiagnostic(factory));
  }
  if (inputId === undefined) {
    gaps.add("binding", "binding-input");
    diagnostics.push(codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON"));
  }
  return {
    candidates: parsed.candidates,
    coverageGaps: parsed.coverageGaps,
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined,
  };
}

/**
 * Parses standalone inventory and records fixed uncertainty for failed/invalid/limited input.
 *
 * Inputs: Inventory JSON result, Core builder, fact factory, mutable gap builder, and diagnostics array.
 * Outputs: Snapshot/gap/input-ID/complete state; failure yields no snapshot and incomplete state.
 * Does not handle: File I/O, inventory matching, or raw parser error serialization.
 * Side effects: Mutates supplied gaps/diagnostics and invokes inventory parser/factory validators.
 */
function collectInventory(
  document: LocalJsonReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly snapshot?: InventorySnapshot;
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
} {
  if (!document.ok) {
    gaps.add("inventory", "inventory-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { coverageGaps: [], complete: false };
  }

  const parsed = parseInventorySnapshot(document.value, builder);
  const inputId = localInputId(document.value, factory);
  const snapshot = parsed.snapshot;
  if (parserLimitExceeded(parsed)) {
    gaps.add("inventory", "provisioning-input-entry-limit-exceeded");
    diagnostics.push(provisioningInputLimitDiagnostic(factory));
  }
  if (inputId === undefined || snapshot === undefined) {
    gaps.add("inventory", "inventory-input");
    diagnostics.push(codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON"));
  }
  return {
    ...(snapshot === undefined ? {} : { snapshot }),
    coverageGaps: parsed.coverageGaps,
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined && snapshot !== undefined,
  };
}

/**
 * Detaches private source/provisioning facts, runs Core reconciliation, and packages report input and diagnostics.
 *
 * Inputs: Private source facts and parsed provisioning state.
 * Outputs: A frozen `LocalAnalysis`, or throws `APP_SAFETY_MATERIALIZATION_FAILED` if detachment/Core rejects graph shape.
 * Does not handle: Source/document I/O, raw exception exposure, or mutation of reusable private facts.
 * Side effects: Allocates detached deep-frozen graphs and invokes Core reconciliation.
 */
function reconcileCollected(source: SourceFacts, provisioning: ParsedProvisioning): LocalAnalysis {
  try {
    const privateInput: ReconciliationInput = {
      references: source.references,
      demandEdges: source.demandEdges,
      dynamicLookupEdges: source.dynamicLookupEdges,
      targetStatuses: [{ scope: source.scope, status: "unknown-target" }],
      bindingCandidates: provisioning.bindingCandidates,
      bindingResolutions: provisioning.bindingResolutions,
      inventorySnapshots: provisioning.inventorySnapshots,
      coverageGaps: [...source.coverageGaps, ...provisioning.coverageGaps],
      coverageInputs: provisioning.coverageInputs,
      ...(provisioning.closedModel === undefined ? {} : { closedModel: provisioning.closedModel }),
    };
    // Core receives a detached public graph. Any Core record aliases therefore
    // remain within the public, deep-frozen view and cannot mutate reusable
    // source/provisioning facts retained for an attested deployment.
    const reconciliationInput = detachedFactSnapshot(privateInput);
    const result = detachedFactSnapshot(reconcile(reconciliationInput));
    const reportingInput: ReportingInput = Object.freeze({
      result,
      references: reconciliationInput.references,
      demandEdges: reconciliationInput.demandEdges,
    });
    return Object.freeze({
      reconciliationInput,
      result,
      reportingInput,
      diagnostics: detachedFactSnapshot([...source.diagnostics, ...provisioning.diagnostics]),
    });
  } catch {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
}

/**
 * Copies normalized plain-object/array fact graphs into a distinct recursively frozen graph without accessors or exotic prototypes.
 *
 * Inputs: A normalized fact graph containing primitives, arrays, plain/null-prototype objects, and repeated references.
 * Outputs: A structurally detached immutable graph of the same generic type; unsupported prototype/accessor shapes throw safety failure.
 * Does not handle: General serialization, maps/sets/classes, private discovery state, factories, or raw local documents.
 * Side effects: Allocates clone objects/arrays, freezes every clone, and tracks aliases in a private WeakMap.
 */
function detachedFactSnapshot<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const copy = /**
   * Recursively clones one normalized graph node while preserving internal aliases and rejecting unsafe descriptors.
   *
   * Inputs: One unknown nested fact value.
   * Outputs: Primitive unchanged or a frozen detached array/plain object; throws safety failure for exotic/accessor values.
   * Does not handle: Functions, maps, class instances, symbol properties, or JSON serialization.
   * Side effects: Mutates the enclosing alias WeakMap and allocates/freezes clone containers.
   */ (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return input;
    }
    const existing = seen.get(input);
    if (existing !== undefined) {
      return existing;
    }
    if (Array.isArray(input)) {
      const clone: unknown[] = [];
      seen.set(input, clone);
      for (const item of input) {
        clone.push(copy(item));
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    const clone = Object.create(prototype) as Record<string, unknown>;
    seen.set(input, clone);
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
      }
      Object.defineProperty(clone, key, {
        value: copy(descriptor.value),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(clone);
  };
  return copy(value) as T;
}

/**
 * Produces a private reusable source snapshot with detached public fact arrays but retained discovery/factory internals.
 *
 * Inputs: Source facts assembled during discovery/extraction.
 * Outputs: A frozen `SourceFacts` record whose graph-bearing fields are detached snapshots.
 * Does not handle: Cloning discovery state or factory internals, source I/O, or public serialization.
 * Side effects: Allocates and freezes detached fact graphs.
 */
function privateSourceSnapshot(source: SourceFacts): SourceFacts {
  return Object.freeze({
    factory: source.factory,
    discovery: source.discovery,
    canonicalRoot: source.canonicalRoot,
    scope: detachedFactSnapshot(source.scope),
    selector: detachedFactSnapshot(source.selector),
    references: detachedFactSnapshot(source.references),
    demandEdges: detachedFactSnapshot(source.demandEdges),
    dynamicLookupEdges: detachedFactSnapshot(source.dynamicLookupEdges),
    directDemandSummary: detachedFactSnapshot(source.directDemandSummary),
    coverageGaps: detachedFactSnapshot(source.coverageGaps),
    diagnostics: detachedFactSnapshot(source.diagnostics),
  });
}

/**
 * Creates the broad local runtime execution scope used when standalone scans have no deployment-specific scope.
 *
 * Inputs: A safe fact factory that validates constant scope/component IDs.
 * Outputs: Runtime/environment scope with all stages and fixed local IDs.
 * Does not handle: Deployment stage inference, user-supplied scope IDs, or selector construction.
 * Side effects: Invokes factory identifier validation.
 */
function defaultScope(factory: SafeFactFactory): ExecutionScope {
  return {
    id: requiredIdentifier(factory, DEFAULT_SCOPE_ID),
    componentId: requiredIdentifier(factory, DEFAULT_COMPONENT_ID),
    // Explicitly broad rather than pretending the command knows deployment stage.
    phase: "runtime",
    stage: { kind: "all" },
    channel: "environment",
  };
}

/**
 * Builds the always-applicable selector that exactly describes one execution scope's known dimensions.
 *
 * Inputs: An execution scope.
 * Outputs: A selector containing singleton execution-unit/phase/channel lists, same stage, and `always` condition.
 * Does not handle: Scope validation, condition parsing, or overlap testing.
 * Side effects: Allocates selector/array objects.
 */
function selectorForScope(scope: ExecutionScope): ScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

/**
 * Requires an unknown constant to normalize as a safe generic identifier.
 *
 * Inputs: A fact factory and unknown candidate identifier.
 * Outputs: The safe identifier, or throws fixed safety materialization failure when rejected.
 * Does not handle: Fallback IDs, diagnostics, or caller-provided arbitrary raw values.
 * Side effects: Invokes the factory's identifier validator.
 */
function requiredIdentifier(factory: SafeFactFactory, value: unknown): SafeIdentifier {
  const identifier = factory.genericIdentifier(value);
  if (typeof identifier !== "string") {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  return identifier;
}

class AppGapBuilder {
  readonly #values: CoverageGap[] = [];
  #ordinal: number;

  /**
   * Initializes an app-local coverage-gap builder with a selector and optional existing gap ordinal.
   *
   * Inputs: Fact factory, affected selector, and optional starting ordinal.
   * Outputs: A builder whose next `add` creates uniquely hinted gaps after the start ordinal.
   * Does not handle: Parsing external gaps, selector validation, or report emission.
   * Side effects: Stores private constructor parameters and assigns the ordinal field.
   */
  public constructor(
    private readonly factory: SafeFactFactory,
    private readonly selector: ScopeSelector,
    startOrdinal = 0,
  ) {
    this.#ordinal = startOrdinal;
  }

  /**
   * Returns a frozen shallow copy of every gap materialized by this builder.
   *
   * Inputs: None.
   * Outputs: A readonly frozen coverage-gap array.
   * Does not handle: Deep cloning individual gap facts or clearing builder state.
   * Side effects: Allocates and freezes a copied array.
   */
  public get values(): readonly CoverageGap[] {
    return Object.freeze([...this.#values]);
  }

  /**
   * Materializes and stores one app-scoped coverage gap for a failed local input condition.
   *
   * Inputs: Demand/binding/inventory domain and constant local input ID hint.
   * Outputs: `undefined`, or throws fixed safety failure if the factory rejects gap materialization.
   * Does not handle: Raw parser reasons, user-supplied paths, or gap removal.
   * Side effects: Increments private ordinal and appends one materialized gap to private array.
   */
  public add(
    domain: "demand" | "binding" | "inventory",
    inputId: string,
  ): void {
    this.#ordinal += 1;
    const result = this.factory.materializeCoverageGap({
      idHint: `app-${domain}-gap-${this.#ordinal}`,
      domain,
      inputId,
      pathOrAdapterId: "local-app",
      potentiallyAffects: this.selector,
      reason: "invalid-input-shape",
    });
    if (!result.ok) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    this.#values.push(result.value);
  }
}

/**
 * Reads one discovered source file after initial realpath containment and descriptor-size checks.
 *
 * Inputs: A discovered file containing canonical file/root paths.
 * Outputs: UTF-8 text or `undefined` for initial path escape, nonfile, initial oversize, filesystem failure, or close/read failure.
 * Does not handle: Revalidating the opened target after open, guaranteeing a stable snapshot/post-open containment, enforcing a post-read hard cap during concurrent mutation, source parsing, retries, or detailed I/O diagnostics.
 * Side effects: Resolves the initial path, opens/stats/reads/closes one local descriptor.
 */
async function readDiscoveredSource(file: DiscoveredSourceFile): Promise<string | undefined> {
  try {
    const current = await realpath(file.canonicalPath);
    if (!isSegmentDescendant(file.root.canonicalPath, current)) {
      return undefined;
    }
    const handle = await open(current, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_READ_SOURCE_BYTES) {
        return undefined;
      }
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Replaces extractor-local IDs with file-ordinal namespaced IDs and drops edges whose references cannot be remapped.
 *
 * Inputs: Source extraction result, one-based file ordinal, and fact factory.
 * Outputs: Frozen namespaced references/demand/dynamic arrays plus incomplete flag for dangling edges.
 * Does not handle: Source extraction, cross-file deduplication, or recovery of dangling references.
 * Side effects: Allocates reference-ID map and output arrays; validates generated IDs through factory.
 */
function namespaceExtraction(
  extraction: SourceExtractionResult,
  fileOrdinal: number,
  factory: SafeFactFactory,
): {
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly incomplete: boolean;
} {
  const referenceIds = new Map<SafeIdentifier, SafeIdentifier>();
  const references: SecretReference[] = [];

  for (const [index, reference] of extraction.references.entries()) {
    const id = requiredIdentifier(factory, `source-file-${fileOrdinal}-reference-${index + 1}`);
    referenceIds.set(reference.id, id);
    references.push({ ...reference, id });
  }

  let incomplete = false;
  const demandEdges: DemandEdge[] = [];
  for (const [index, edge] of extraction.demandEdges.entries()) {
    const referenceId = referenceIds.get(edge.referenceId);
    if (referenceId === undefined) {
      incomplete = true;
      continue;
    }
    demandEdges.push({
      ...edge,
      id: requiredIdentifier(factory, `source-file-${fileOrdinal}-demand-${index + 1}`),
      referenceId,
    });
  }

  const dynamicLookupEdges: DynamicLookupEdge[] = [];
  for (const [index, edge] of extraction.dynamicLookupEdges.entries()) {
    const referenceId = referenceIds.get(edge.referenceId);
    if (referenceId === undefined) {
      incomplete = true;
      continue;
    }
    dynamicLookupEdges.push({
      ...edge,
      id: requiredIdentifier(factory, `source-file-${fileOrdinal}-dynamic-${index + 1}`),
      referenceId,
    });
  }

  return {
    references: Object.freeze(references),
    demandEdges: Object.freeze(demandEdges),
    dynamicLookupEdges: Object.freeze(dynamicLookupEdges),
    incomplete,
  };
}

/**
 * Tests whether a discovery skip means first-party source coverage is incomplete for local demand conclusions.
 *
 * Inputs: One safe discovery diagnostic code.
 * Outputs: `true` for budget/read/size/depth/ignore/symlink/generated first-party skips and `false` otherwise.
 * Does not handle: Dependency or outside-root demand, skip object inspection, or reporting.
 * Side effects: Converts the safe code to a string.
 */
function isRelevantDiscoverySkip(code: SafeDiagnosticCode): boolean {
  const value = String(code);
  if (
    value === "BUDGET_EXCEEDED" ||
    value === "UNREADABLE" ||
    value === "OVERSIZE" ||
    value === "DEPTH_EXCEEDED" ||
    value === "IGNORED" ||
    value === "SYMLINK" ||
    value === "GENERATED"
  ) {
    return true;
  }
  return false;
}

/**
 * Builds one coverage-input fact, normalizing a constant string input ID when necessary.
 *
 * Inputs: Fact factory, string/safe input ID, coverage domain/state, and affected selector.
 * Outputs: A `CoverageInputStatus` with a safe identifier.
 * Does not handle: Coverage completeness evaluation, selector cloning, or input document parsing.
 * Side effects: May invoke factory identifier validation.
 */
function coverageInput(
  factory: SafeFactFactory,
  inputId: string | SafeIdentifier,
  domain: CoverageInputStatus["domain"],
  state: CoverageInputStatus["state"],
  selector: ScopeSelector,
): CoverageInputStatus {
  return {
    inputId: typeof inputId === "string" ? requiredIdentifier(factory, inputId) : inputId,
    domain,
    state,
    selector,
  };
}

/**
 * Maps a document input's coverage state to every closed-model scope that declares that input, or one fallback selector.
 *
 * Inputs: Optional closed model, safe input ID, domain/state, and source fallback selector.
 * Outputs: A list of coverage inputs for matching scope selectors or a single fallback input.
 * Does not handle: Closed-model validation, selector overlap proof, or coverage gap creation.
 * Side effects: Allocates selector and status arrays.
 */
function coverageInputsFor(
  model: ClosedProvisioningModel | undefined,
  inputId: SafeIdentifier,
  domain: CoverageInputStatus["domain"],
  state: CoverageInputStatus["state"],
  fallback: ScopeSelector,
): readonly CoverageInputStatus[] {
  const selectors = model?.scopes
    .flatMap(/**
      * Emits one scope selector only when its coverage declares the requested input ID/domain.
      *
      * Inputs: One closed-model scope.
      * Outputs: A one-element selector array or empty array.
      * Does not handle: Selector matching against source scope or coverage state.
      * Side effects: Inspects expected-input arrays.
      */ (scope) =>
      scope.coverage?.expectedInputs.some(
        /**
         * Matches one expected input against the requested safe ID and coverage domain.
         *
         * Inputs: One expected adapter input declaration.
         * Outputs: `true` only for equal input ID and domain.
         * Does not handle: Extension/adapter validation.
         * Side effects: None.
         */ (expected) => expected.inputId === inputId && expected.domain === domain,
      )
        ? [scope.selector]
        : [],
    ) ?? [];
  const effectiveSelectors = selectors.length === 0 ? [fallback] : selectors;
  return effectiveSelectors.map(/**
    * Builds one coverage-input status for a selected closed-model or fallback scope.
    *
    * Inputs: One affected scope selector.
    * Outputs: A status object reusing the requested ID/domain/state.
    * Does not handle: Selector cloning or status validation.
    * Side effects: Allocates one status object.
    */ (selector) => ({ inputId, domain, state, selector }));
}

/**
 * Extracts and validates a top-level `inputId` from an unknown parsed local document.
 *
 * Inputs: Unknown document value and safe fact factory.
 * Outputs: Safe input ID or `undefined` for nonrecords, missing/nonstrings, or invalid identifiers.
 * Does not handle: Full schema validation or document I/O.
 * Side effects: Invokes the factory identifier validator for a string field.
 */
function localInputId(value: unknown, factory: SafeFactFactory): SafeIdentifier | undefined {
  if (!isRecord(value) || typeof value.inputId !== "string") {
    return undefined;
  }
  const inputId = factory.genericIdentifier(value.inputId);
  return typeof inputId === "string" ? inputId : undefined;
}

/**
 * Detects the parser's one fixed input-entry cardinality diagnostic.
 *
 * Inputs: Parser output exposing readonly diagnostic codes.
 * Outputs: `true` when any diagnostic code is `input-entry-limit-exceeded`.
 * Does not handle: Other parser failures, diagnostic conversion, or input limiting itself.
 * Side effects: Iterates diagnostic array.
 */
function parserLimitExceeded(
  result: { readonly diagnostics: readonly { readonly code: string }[] },
): boolean {
  return result.diagnostics.some(/**
    * Selects the fixed parser cardinality-limit diagnostic.
    *
    * Inputs: One parser diagnostic.
    * Outputs: `true` only for the cardinality-limit code.
    * Does not handle: Other diagnostic meanings.
    * Side effects: None.
    */ (diagnostic) => diagnostic.code === "input-entry-limit-exceeded");
}

/**
 * Produces the app-level fixed diagnostic corresponding to parser input-entry truncation.
 *
 * Inputs: A safe fact factory.
 * Outputs: `APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED` as a safe diagnostic code.
 * Does not handle: Counting entries, parsing documents, or user-defined diagnostic values.
 * Side effects: Invokes the factory diagnostic-code validator.
 */
function provisioningInputLimitDiagnostic(factory: SafeFactFactory): SafeDiagnosticCode {
  return factory.diagnosticCode("APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
}

/**
 * Converts an allowed local document failure code to its safe diagnostic-code representation.
 *
 * Inputs: One closed union of local read/size/JSON/budget/snapshot/cardinality failure codes.
 * Outputs: The matching `SafeDiagnosticCode`.
 * Does not handle: Arbitrary error text, unknown codes, or diagnostics from other subsystems.
 * Side effects: None.
 */
function codeForDocumentFailure(
  code:
    | "APP_LOCAL_INPUT_READ_FAILED"
    | "APP_LOCAL_INPUT_TOO_LARGE"
    | "APP_LOCAL_INPUT_INVALID_JSON"
    | "APP_LOCAL_INPUT_BUDGET_EXCEEDED"
    | "APP_LOCAL_INPUT_SNAPSHOT_CHANGED"
    | "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED",
): SafeDiagnosticCode {
  switch (code) {
    case "APP_LOCAL_INPUT_READ_FAILED":
      return "APP_LOCAL_INPUT_READ_FAILED" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_TOO_LARGE":
      return "APP_LOCAL_INPUT_TOO_LARGE" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_INVALID_JSON":
      return "APP_LOCAL_INPUT_INVALID_JSON" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_BUDGET_EXCEEDED":
      return "APP_LOCAL_INPUT_BUDGET_EXCEEDED" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_SNAPSHOT_CHANGED":
      return "APP_LOCAL_INPUT_SNAPSHOT_CHANGED" as SafeDiagnosticCode;
    case "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED":
      return "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED" as SafeDiagnosticCode;
  }
}

/**
 * Verifies every relevant closed scope's approved source roots and binding root against the explicit canonical verification base.
 *
 * Inputs: Private source facts, closed model, prepared binding witness, and optional canonical verification base.
 * Outputs: A promise for `true` only when all relevant coverage paths are safely representable and covered; otherwise `false`.
 * Does not handle: File/document parsing, path creation, strong absence itself, or raw path disclosure.
 * Side effects: Derives safe relative paths through the source factory and iterates scope coverage; no filesystem I/O.
 */
async function closedModelRootsAreVerifiable(
  source: SourceFacts,
  model: ClosedProvisioningModel,
  bindingDocument: PreparedBindingDocument,
  verificationBase: InternalPath | undefined,
): Promise<boolean> {
  const relevantScopes = model.scopes.filter(
    /**
     * Retains a closed model scope only when its selector may affect the source scope.
     *
     * Inputs: One closed-model scope.
     * Outputs: `true` for closed scopes that may affect this source; otherwise `false`.
     * Does not handle: Root/binding coverage path checks.
     * Side effects: Invokes Core selector overlap predicate.
     */ (scope) => scope.closed && selectorMayAffectScope(scope.selector, source.scope),
  );
  if (relevantScopes.length === 0) {
    return true;
  }

  if (verificationBase === undefined) {
    return false;
  }
  const workspace = verificationBase;

  const rootMarker = source.factory.rootRelativePath(".");
  if (rootMarker === undefined) {
    return false;
  }
  const sourceRoots = source.discovery.roots.map(/**
    * Converts one canonical source root to a safe path relative to the explicit verification base.
    *
    * Inputs: One discovered source root.
    * Outputs: Root marker for equal base or a safe path/opaque sentinel from factory.
    * Does not handle: Filesystem stat, base validation, or coverage matching.
    * Side effects: Invokes safe-path factory.
    */ (root) =>
    root.canonicalPath === workspace
      ? rootMarker
      : source.factory.safePath({ approvedRoot: workspace, canonicalPath: root.canonicalPath }),
  );
  if (sourceRoots.some(/**
    * Detects a source root the factory could not safely represent under the base.
    *
    * Inputs: One factory-produced safe path or opaque sentinel.
    * Outputs: `true` only for the opaque path sentinel.
    * Does not handle: Binding path validation.
    * Side effects: None.
    */ (path) => path === OPAQUE_PATH)) {
    return false;
  }

  const bindingPath = bindingDocument.ok
    ? bindingDocument.canonicalPath === workspace
      ? rootMarker
      : source.factory.safePath({
          approvedRoot: workspace,
          canonicalPath: bindingDocument.canonicalPath,
        })
    : undefined;

  return relevantScopes.every(/**
    * Verifies one relevant closed scope covers all source roots and binding path.
    *
    * Inputs: One closed-model scope.
    * Outputs: `true` when coverage exists and both approved-source/binding root conditions hold.
    * Does not handle: Scope selector relevance or filesystem validation.
    * Side effects: Iterates safe root arrays and calls coverage helper.
    */ (scope) => {
    const coverage = scope.coverage;
    if (coverage === undefined || bindingPath === undefined || bindingPath === OPAQUE_PATH) {
      return false;
    }
    return (
      sourceRoots.every(/**
        * Requires at least one declared approved root to cover one discovered source root.
        *
        * Inputs: One safe source root.
        * Outputs: `true` when an approved root covers it.
        * Does not handle: Binding root coverage.
        * Side effects: Iterates declared approved roots.
        */ (root) => coverage.approvedFirstPartyRoots.some(/**
          * Tests one declared approved root against one source root.
          *
          * Inputs: One declared safe root.
          * Outputs: Whether it covers the captured source root.
          * Does not handle: Path normalization.
          * Side effects: Calls `safePathCovers`.
          */ (declared) => safePathCovers(declared, root, rootMarker))) &&
      coverage.bindingRoots.some(/**
        * Tests one declared binding root against the prepared safe binding path.
        *
        * Inputs: One declared safe binding root.
        * Outputs: Whether it covers the captured binding path.
        * Does not handle: Binding read/parse validation.
        * Side effects: Calls `safePathCovers`.
        */ (declared) => safePathCovers(declared, bindingPath, rootMarker))
    );
  });
}

/**
 * Tests root-marker equality or slash-segment descendant coverage between already-safe paths.
 *
 * Inputs: Declared root, candidate path, and canonical root marker.
 * Outputs: `true` for root marker, exact equality, or candidate prefixed by root plus slash.
 * Does not handle: Filesystem resolution, untrusted path strings, or case-insensitive path rules.
 * Side effects: Converts branded safe paths to strings for prefix comparison.
 */
function safePathCovers(root: SafePath, candidate: SafePath, rootMarker: SafePath): boolean {
  return root === rootMarker || root === candidate || String(candidate).startsWith(`${String(root)}/`);
}

/**
 * Narrows an unknown JSON-like value to a non-null non-array object record.
 *
 * Inputs: Any JavaScript value.
 * Outputs: A type predicate for record-shaped objects.
 * Does not handle: Prototype safety, property schema validation, or deep cloning.
 * Side effects: None.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
