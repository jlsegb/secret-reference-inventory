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
 * Scan first-party TypeScript/JavaScript only. It never invokes repository
 * code, reads process environment values, or performs a network request.
 */
export async function scanLocalRoot(root: string): Promise<LocalAnalysis> {
  const source = await collectSourceFacts(root);
  return reconcileCollected(source, emptyProvisioning(source));
}

/**
 * Scan code and reconcile it with explicitly supplied local JSON exports.
 * Parse/read failures become scoped coverage uncertainty instead of a hidden
 * clean result.
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
 * Internal runtime bridge for a request-scoped, pre-attested repository
 * member. The first operation is the private member-handle lookup; public
 * LocalAnalysis values never carry or recover reusable source facts.
 */
export async function scanAttestedLocalWorkspaceMember(
  memberHandle: unknown,
): Promise<LocalAnalysis> {
  const source = await collectAttestedLocalWorkspaceMemberSourceFacts(memberHandle);
  return reconcileCollected(source, emptyProvisioning(source));
}

/**
 * Collect source facts once without invoking Core reconciliation. The private
 * snapshot remains available to later deployment preflight even when the
 * top-level repository report itself must fall back for graph budget reasons.
 */
export async function collectAttestedLocalWorkspaceMemberSource(
  memberHandle: unknown,
): Promise<void> {
  await collectAttestedLocalWorkspaceMemberSourceFacts(memberHandle);
}

/**
 * Materialize one top-level repository report under the invocation-wide graph
 * ledger. Runtime calls this in a stable repository order after source
 * collection; a rejected report is a one-fact incomplete fallback while its
 * private source snapshot remains reusable by declared deployments.
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
 * Internal runtime bridge for an already-issued opaque deployment attestation.
 * It accepts no structural deployment data and records only the lower-level
 * identity-backed context that preparation will consume.
 */
export function registerDeploymentAttestation(attestation: unknown): void {
  const context = deploymentAttestationContext(attestation);
  if (context === undefined) {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  ATTESTED_DEPLOYMENT_CONTEXTS.set(attestation as object, context);
}

/**
 * Preflight source and shared-key work before any deployment document is
 * opened. The lower attestation supplies only exact parser-derived members;
 * no caller-supplied roots, scopes, or fact graphs are accepted.
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

/** True only when a member remains eligible for document-backed reconciliation. */
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

/** Bounded, pre-reserved direct-demand intersection; never walks records. */
export function preflightDeploymentSharedKeys(
  preflight: unknown,
): readonly LogicalKey[] {
  return DEPLOYMENT_PREFLIGHTS.get(preflight as object)?.sharedKeys ?? [];
}

/** Fixed diagnostics derived during source/shared-key preflight. */
export function preflightDeploymentDiagnostics(
  preflight: unknown,
): readonly SafeDiagnosticCode[] {
  return DEPLOYMENT_PREFLIGHTS.get(preflight as object)?.diagnostics ?? [];
}

/**
 * Produce only the fixed incomplete member result when preflight exhausted all
 * materializable members, thereby avoiding provisioning document I/O entirely.
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
 * Attach preflight-reserved sources to an input-attested deployment. The first
 * operation is the full-attestation identity lookup; callers cannot use a
 * preflight from another invocation or deployment.
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
      const declaredMemberScopes: DeploymentMemberScope[] = attested.members.map((member) => {
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
      const materializableMemberScopes = declaredMemberScopes.filter((member) => {
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
      for (const member of [...attested.members].sort((left, right) =>
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
 * Reuses an app-issued source snapshot for one member partition. It never
 * discovers or extracts source again; it only projects existing safe facts to
 * the member's explicit execution scope before Core reconciliation.
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

/** Fixed deployment-level uncertainty that has no safe member owner. */
export function preparedDeploymentDiagnostics(
  prepared: unknown,
): readonly SafeDiagnosticCode[] {
  return PREPARED_DEPLOYMENT_RECONCILIATIONS.get(prepared as object)?.diagnostics ?? [];
}

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

function sourceRootForDiscovery(discovery: DiscoveryResult): InternalPath {
  const root = discovery.roots[0]?.canonicalPath;
  if (root === undefined) {
    throw new AppError("APP_DISCOVERY_FAILED");
  }
  return root;
}

/**
 * Build a bounded direct-demand summary once per repository scan. Deployment
 * aggregation never walks reconciliation records, so repeated memberships do
 * not multiply this work or retain an unbounded key set.
 */
function directDemandSummary(
  references: readonly SecretReference[],
  demandEdges: readonly DemandEdge[],
): DirectDemandSummary {
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
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
      [...keys.values()].sort((left, right) =>
        (left.namespace + ":" + String(left.name)).localeCompare(
          right.namespace + ":" + String(right.name),
        ),
      ),
    ),
    complete: true,
  });
}

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

function preparedBindingDocument(document: PreparedDeploymentReadResult): PreparedBindingDocument {
  return document.ok
    ? Object.freeze({ ok: true as const, canonicalPath: document.canonicalPath })
    : Object.freeze({ ok: false as const, code: document.code });
}

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
    demandEdges: source.demandEdges.map((edge) => ({ ...edge, scope: privateScope })),
    dynamicLookupEdges: Object.freeze(
      source.dynamicLookupEdges.map((edge) => ({ ...edge, scope: privateScope })),
    ),
    coverageGaps:
      source.coverageGaps.map((gap) => ({ ...gap, potentiallyAffects: selector })),
  });
}

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
 * Simulate all member source reservations before committing the invocation
 * ledger. Shared-key work is then reserved over only those accepted members;
 * if it cannot fit, none of their source graphs are materialized or charged.
 */
function reserveDeploymentPreflight(
  sources: ReadonlyMap<IssuedDeploymentMember, SourceFacts>,
  members: readonly AttestedDeploymentMember[],
  issuance: unknown,
  budget: WorkspaceInvocationContext,
): PreflightReservation {
  const candidates = members
    .flatMap((member) => {
      const handle = issuedDeploymentMember(issuance, member.repositoryId);
      const source = handle === undefined ? undefined : sources.get(handle);
      return handle === undefined || source === undefined
        ? []
        : [{ repositoryId: member.repositoryId, handle, source }];
    })
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
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

  const summaries = accepted.map((candidate) => candidate.source.directDemandSummary);
  const summaryComplete = summaries.every((summary) => summary.complete);
  const summaryWork = summaries.reduce((total, summary) => total + summary.keys.length, 0);
  const outputUpperBound = Math.min(...summaries.map((summary) => summary.keys.length));
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

function intersectDirectDemandSummaries(
  summaries: readonly DirectDemandSummary[],
): readonly LogicalKey[] {
  const first = summaries[0];
  if (first === undefined) return Object.freeze([]);
  let shared = new Map<string, LogicalKey>(
    first.keys.map((key) => [key.namespace + "\u0000" + String(key.name), key]),
  );
  for (const summary of summaries.slice(1)) {
    const current = new Set(
      summary.keys.map((key) => key.namespace + "\u0000" + String(key.name)),
    );
    shared = new Map([...shared].filter(([key]) => current.has(key)));
    if (shared.size === 0) break;
  }
  return Object.freeze(
    [...shared.values()].sort((left, right) =>
      (left.namespace + ":" + String(left.name)).localeCompare(
        right.namespace + ":" + String(right.name),
      ),
    ),
  );
}

/**
 * Conservative full graph cost for a scan-only member. It accounts for the
 * normalized source facts as well as Core's demand/dynamic records and one
 * scope-coverage result, not merely the source arrays that happen to be
 * visible in a workspace member report.
 */
function scanOnlyProjectionGraphCost(
  source: SourceFacts,
  limit = Number.MAX_SAFE_INTEGER,
): number {
  let total = 0;
  const add = (next: number): void => {
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

function dynamicDemandRecordUpperBound(
  edges: readonly DynamicLookupEdge[],
  bindingCandidateCount: number,
  closedModel: ClosedProvisioningModel | undefined,
): number {
  const finitePatternKeys = closedModel?.finitePatternDomains?.reduce(
    (total, domain) => total + domain.keys.length,
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
 * Conservative provisioning graph reservation before any Core partition or
 * inventory assignment is materialized. Every summand is capped at the first
 * impossible fact, so hostile documents cannot turn a rejected member into a
 * large preflight allocation.
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
 * Candidate-ID reasons are indexed by destination instead of charged as a
 * blanket candidates × demands product. Distinct 10k-key manifests remain
 * linear, while repeated keys reserve their real nested-evidence fanout.
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
        (count, domain) => count + domain.keys.length,
        0,
      ) ?? 0;
      total = saturatingAdd(total, totalCandidates + finiteKeys + 1, limit);
      if (total >= limit) return limit;
    }
  }
  return total;
}

function directDemandDestinationKeys(source: SourceFacts): ReadonlySet<string> {
  const references = new Map(source.references.map((reference) => [reference.id, reference]));
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

function preparedCoverageInputUpperBound(documents: PreparedDeploymentDocuments): number {
  const modelScopeCount = Math.max(1, documents.closed.model?.scopes.length ?? 0);
  return (
    (documents.bindings.inputId === undefined ? 0 : modelScopeCount) +
    (documents.inventory.inputId === undefined ? 0 : modelScopeCount)
  );
}

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
 * Mirrors Core's slot/finite-domain branching without creating a single
 * partition or selection object. A slot is grouped in linear time and the
 * finite-domain product is capped by Core's own partition limit; otherwise
 * Core can produce at most one overlapping-selector group per candidate.
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

function nonConditionSelectorKey(selector: ScopeSelector): string {
  return [
    selectorSetKey(selector.executionUnitIds),
    selectorSetKey(selector.phases),
    stageSelectorKey(selector.stage),
    selectorSetKey(selector.channels),
  ].join("\u0001");
}

function selectorSetKey(values: readonly string[] | undefined): string {
  return values === undefined
    ? "undefined"
    : String(values.length) + "\u0000" + [...values].sort().join("\u0000");
}

function stageSelectorKey(stage: ScopeSelector["stage"]): string {
  return stage.kind === "exact"
    ? "exact\u0000" + selectorSetKey(stage.values)
    : stage.kind;
}

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
 * Count candidate/item record possibilities through provider-resource
 * frequencies. This is O(candidates + items), never O(candidates × items),
 * and saturates at the caller's first impossible fact.
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

function saturatedFactLimit(reserved: number, remaining: number): number {
  return saturatingAdd(saturatingAdd(reserved, remaining, Number.MAX_SAFE_INTEGER - 1), 1, Number.MAX_SAFE_INTEGER);
}

function saturatingAdd(total: number, next: number, limit: number): number {
  if (total >= limit || next >= limit - total) return limit;
  return total + next;
}

function saturatingMultiply(left: number, right: number, limit: number): number {
  if (left === 0 || right === 0) return 0;
  return left > Math.floor(limit / right) ? limit : left * right;
}

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
        (count, input) => count + 1 + (input.extensions?.length ?? 0),
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

/** Every nested evidence array is graph-budgeted, not just its parent fact. */
function secretReferenceGraphCost(reference: SecretReference): number {
  return 1 + evidenceGraphCost(reference.evidenceChain);
}

function demandEdgeGraphCost(edge: DemandEdge): number {
  return 2 + evidenceGraphCost(edge.evidenceChain);
}

function dynamicLookupEdgeGraphCost(edge: DynamicLookupEdge): number {
  return 2 + edge.likelyKeys.length + evidenceGraphCost(edge.evidenceChain);
}

function evidenceGraphCost(
  evidence: readonly { readonly locations: readonly unknown[] }[],
): number {
  return evidence.reduce((total, entry) => total + 1 + entry.locations.length, 0);
}

function bindingCandidateGraphCost(candidate: BindingCandidate): number {
  return 1 + selectorGraphCost(candidate.appliesWhen) + (candidate.location === undefined ? 0 : 1);
}

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

function coverageGapGraphCost(gap: CoverageGap): number {
  return 1 + (gap.keyDomain?.kind === "keys" ? gap.keyDomain.keys.length : 0) +
    selectorGraphCost(gap.potentiallyAffects);
}

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

function reconciliationReasonsGraphCost(
  reasons: readonly {
    readonly gapIds?: readonly SafeIdentifier[];
    readonly candidateIds?: readonly SafeIdentifier[];
  }[],
): number {
  return reasons.reduce(
    (total, reason) =>
      total +
      1 +
      (reason.gapIds?.length ?? 0) +
      (reason.candidateIds?.length ?? 0),
    0,
  );
}

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
 * A budget fallback is exactly one incomplete scope-coverage status. It
 * deliberately carries no nested identifier reference: the incomplete state
 * itself is the fixed, parser-cardinality-reserved escape hatch. A per-member
 * reason ID would turn every fallback into two graph facts and could exceed
 * the maximum-manifest floor before any source work begins.
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
 * Materialize only members whose complete conservative reservation succeeded.
 * This is the first point that invokes Core's partition resolver or assigns
 * inventory to a member, so rejected plans cannot allocate hidden graphs.
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
        [...matching].every((member) => memberHasExactBindingForResource(member, item))
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
  return [...possible].filter((member) =>
    selectorMayAffectScope(gap.potentiallyAffects, member.scope),
  );
}

/**
 * A target ID outside the deployment is not automatically an error: concrete
 * facts can deliberately describe another repository. If its applicability
 * selector can still reach a member, however, the target/selector conflict is
 * insufficient evidence for a strong member conclusion.
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
    : scopeIds.flatMap((scopeId) => membersByExecutionUnitId.get(scopeId) ?? []);
  for (const member of possibleMembers) {
    if (selectorMayAffectScope(candidate.appliesWhen, member.scope)) {
      member.bindingOwnershipUncertain = true;
    }
  }
}

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

function isExplicitOutsideScope(scope: ExecutionScope): boolean {
  return (
    scope.phase !== "unknown" &&
    scope.channel !== "unknown" &&
    scope.stage.kind === "exact"
  );
}

function markInventoryOwnershipUncertain(
  members: readonly MutableMemberProvisioningSelection[],
): void {
  for (const member of members) {
    member.inventoryOwnershipUncertain = true;
  }
}

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
 * An unscoped inventory item can be attributed only to a single provider
 * resource that Core has already proved effective for the whole member scope.
 * Grouping by destination keeps this linear in parsed candidates/resolutions
 * instead of repeatedly walking every binding slot for every candidate.
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
 * A dynamic declaration for the same destination can never be erased by an
 * exact candidate. Leaving that destination out of Core's exact-resolution
 * set makes Core retain its `dynamic`/inconclusive state instead of fabricating
 * an exact provider relation from a competing declaration.
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
  return candidates.filter((candidate) => {
    const key = destinationKey(candidate.destination);
    return (
      candidate.resolution === "exact" &&
      (key === undefined || !dynamicDestinations.has(key))
    );
  });
}

function destinationKey(destination: BindingCandidate["destination"]): string | undefined {
  return typeof destination.name === "string"
    ? destination.namespace + "\u0000" + destination.name
    : undefined;
}

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

function providerResourceKey(authorityId: SafeIdentifier, canonicalId: SafeIdentifier): string {
  return String(authorityId) + "\u0000" + String(canonicalId);
}

function memberDiagnostic(value: string): SafeDiagnosticCode {
  return new SafeFactFactory().diagnosticCode(value);
}

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

function uniqueDiagnostics(values: readonly SafeDiagnosticCode[]): readonly SafeDiagnosticCode[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

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
 * Copy only normalized fact graphs into a distinct, recursively frozen object
 * graph. This is intentionally not a general serialization utility: private
 * discovery state, factories, maps, and raw local documents never enter it.
 */
function detachedFactSnapshot<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const copy = (input: unknown): unknown => {
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

function selectorForScope(scope: ExecutionScope): ScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

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

  public constructor(
    private readonly factory: SafeFactFactory,
    private readonly selector: ScopeSelector,
    startOrdinal = 0,
  ) {
    this.#ordinal = startOrdinal;
  }

  public get values(): readonly CoverageGap[] {
    return Object.freeze([...this.#values]);
  }

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
 * A skipped first-party path is uncertainty even when discovery cannot retain
 * its file-vs-directory shape. In particular, an ignored directory may hold
 * arbitrary TypeScript. Deliberately excluded dependency/outside-root paths
 * remain outside the local-demand contract.
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

function coverageInputsFor(
  model: ClosedProvisioningModel | undefined,
  inputId: SafeIdentifier,
  domain: CoverageInputStatus["domain"],
  state: CoverageInputStatus["state"],
  fallback: ScopeSelector,
): readonly CoverageInputStatus[] {
  const selectors = model?.scopes
    .flatMap((scope) =>
      scope.coverage?.expectedInputs.some(
        (expected) => expected.inputId === inputId && expected.domain === domain,
      )
        ? [scope.selector]
        : [],
    ) ?? [];
  const effectiveSelectors = selectors.length === 0 ? [fallback] : selectors;
  return effectiveSelectors.map((selector) => ({ inputId, domain, state, selector }));
}

function localInputId(value: unknown, factory: SafeFactFactory): SafeIdentifier | undefined {
  if (!isRecord(value) || typeof value.inputId !== "string") {
    return undefined;
  }
  const inputId = factory.genericIdentifier(value.inputId);
  return typeof inputId === "string" ? inputId : undefined;
}

function parserLimitExceeded(
  result: { readonly diagnostics: readonly { readonly code: string }[] },
): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.code === "input-entry-limit-exceeded");
}

function provisioningInputLimitDiagnostic(factory: SafeFactFactory): SafeDiagnosticCode {
  return factory.diagnosticCode("APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
}

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

async function closedModelRootsAreVerifiable(
  source: SourceFacts,
  model: ClosedProvisioningModel,
  bindingDocument: PreparedBindingDocument,
  verificationBase: InternalPath | undefined,
): Promise<boolean> {
  const relevantScopes = model.scopes.filter(
    (scope) => scope.closed && selectorMayAffectScope(scope.selector, source.scope),
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
  const sourceRoots = source.discovery.roots.map((root) =>
    root.canonicalPath === workspace
      ? rootMarker
      : source.factory.safePath({ approvedRoot: workspace, canonicalPath: root.canonicalPath }),
  );
  if (sourceRoots.some((path) => path === OPAQUE_PATH)) {
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

  return relevantScopes.every((scope) => {
    const coverage = scope.coverage;
    if (coverage === undefined || bindingPath === undefined || bindingPath === OPAQUE_PATH) {
      return false;
    }
    return (
      sourceRoots.every((root) => coverage.approvedFirstPartyRoots.some((declared) => safePathCovers(declared, root, rootMarker))) &&
      coverage.bindingRoots.some((declared) => safePathCovers(declared, bindingPath, rootMarker))
    );
  });
}

function safePathCovers(root: SafePath, candidate: SafePath, rootMarker: SafePath): boolean {
  return root === rootMarker || root === candidate || String(candidate).startsWith(`${String(root)}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
