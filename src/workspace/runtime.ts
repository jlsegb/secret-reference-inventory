import {
  preflightDeploymentDiagnostics,
  preflightDeploymentSharedKeys,
  preflightHasMaterializableMembers,
  preflightIssuedWorkspaceDeployment,
  prepareIssuedLocalDeploymentReconciliation,
  preparedDeploymentDiagnostics,
  registerDeploymentAttestation,
  reconcilePreflightBudgetExhaustedMember,
  reconcilePreparedLocalDeploymentMember,
  collectAttestedLocalWorkspaceMemberSource,
  scanBudgetedAttestedLocalWorkspaceMember,
  type PreparedLocalDeploymentReconciliation,
  type PreparedWorkspaceDeploymentPreflight,
} from "../app/analysis.js";
import type {
  LocalAnalysis,
} from "../app/types.js";
import type {
  LogicalKey,
  ReconciliationResult,
  SafeDiagnosticCode,
  SafeIdentifier,
} from "../core/index.js";
import type { WorkspaceScanPort } from "../app/workspace-port.js";
import { SafeFactFactory } from "../safety/index.js";

import type { WorkspaceDeployment, WorkspaceManifest, WorkspaceRepository } from "./contracts.js";
import {
  attestVerifiedWorkspaceDeploymentInputs,
  attestVerifiedWorkspaceDeploymentMembers,
} from "./deployment-attestation.js";
import {
  manifestForIssuedWorkspaceToken,
} from "./manifest-token.js";
import { workspaceScanRequestContext } from "./scan-request.js";
import type {
  WorkspaceDeploymentScanResult,
  WorkspaceDeploymentMemberScanResult,
  WorkspaceRepositoryScanResult,
  WorkspaceScanResult,
} from "./types.js";
import { issuedDeploymentMember } from "./deployment-capability.js";
import {
  attestVerifiedWorkspaceRepositoryMembers,
  issuedWorkspaceRepositoryMember,
  workspaceRepositoryMemberContext,
  type IssuedWorkspaceRepositoryMember,
} from "./workspace-member-attestation.js";
import {
  beginVerifiedWorkspaceInvocation,
  type IssuedWorkspaceInvocation,
} from "./workspace-invocation.js";

const MAX_CONCURRENT_REPOSITORY_SCANS = 4;

const EMPTY_RECONCILIATION: ReconciliationResult = Object.freeze({
  records: Object.freeze([]),
  scopeCoverage: Object.freeze([]),
});

const EMPTY_REPOSITORY_RESULT = Object.freeze({
  reconciliation: EMPTY_RECONCILIATION,
  references: Object.freeze([]),
  demandEdges: Object.freeze([]),
  dynamicLookupEdges: Object.freeze([]),
});

type RepositoryResolution =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostic: SafeDiagnosticCode };

interface ResolvedRepositoryResult {
  readonly declaration: WorkspaceRepository;
  readonly memberHandle: IssuedWorkspaceRepositoryMember;
  readonly resolution: RepositoryResolution;
  readonly result: WorkspaceRepositoryScanResult;
  readonly analysis?: LocalAnalysis;
}

interface ResolvedRepository {
  readonly declaration: WorkspaceRepository;
  readonly memberHandle: IssuedWorkspaceRepositoryMember;
  readonly resolution: RepositoryResolution;
}

/** Source collection may run concurrently; graph admission remains ordered. */
interface CollectedRepository extends ResolvedRepository {
  readonly sourceCollected: boolean;
}

interface DeclaredDeploymentMember {
  readonly repositoryId: SafeIdentifier;
  readonly repository?: ResolvedRepositoryResult;
}

/** A fixed, value-free runtime error for a forged or bypassed manifest. */
export class WorkspaceRuntimeError extends Error {
  readonly code = "WORKSPACE_MANIFEST_INVALID" as const;

  /**
   * Creates the fixed workspace runtime error used when an opaque manifest boundary was bypassed.
   *
   * Inputs: None.
   * Outputs: A WorkspaceRuntimeError with only the fixed public code/message.
   * Does not handle: Recoverable manifest validation, path details, or cause chaining.
   * Side effects: Initializes the inherited Error state and name fields.
   */
  public constructor() {
    super("WORKSPACE_MANIFEST_INVALID");
    this.name = "WorkspaceRuntimeError";
  }
}

/**
 * Scans every repository of an issued workspace request and aggregates each declared deployment without executing repository code.
 *
 * Inputs: An opaque request issued from one verified bounded workspace manifest read.
 * Outputs: Frozen independent repository and deployment results, or throws WorkspaceRuntimeError for forged request/manifest boundaries.
 * Does not handle: Arbitrary manifest text, outside-root/runtime-dependency demand, provider access, canonical path exposure, partial recovery from forged capabilities, or atomic filesystem identity/version guarantees across the later root and provisioning reads.
 * Side effects: Revalidates request/provenance through lower layers, runs bounded filesystem source/input work, mutates invocation caches/budgets, and allocates result graphs; the revalidation is a best-effort stat comparison rather than a filesystem transaction.
 */
export async function scanWorkspace(
  request: unknown,
): Promise<WorkspaceScanResult> {
  const requestContext = workspaceScanRequestContext(request);
  if (requestContext === undefined) {
    throw new WorkspaceRuntimeError();
  }
  const manifest = manifestForIssuedWorkspaceToken(requestContext.manifest);
  if (manifest === undefined) {
    throw new WorkspaceRuntimeError();
  }

  // Invocation minting performs the single initial request verification and
  // builds the private deployment declaration index used below.
  const invocation = await beginVerifiedWorkspaceInvocation(request);
  if (invocation === undefined) {
    return invalidWorkspaceForManifestPath(manifest);
  }
  const repositoryMembers = await attestVerifiedWorkspaceRepositoryMembers(request);
  if (repositoryMembers === undefined) {
    return invalidWorkspaceForManifestPath(manifest);
  }

  const resolvedRepositories = await mapLimited(
    manifest.repositories,
    MAX_CONCURRENT_REPOSITORY_SCANS,
    /**
     * Resolves one declaration to its issued repository-member identity before source collection.
     *
     * Inputs: One parser-authored repository declaration.
     * Outputs: A resolved repository shell or throws fixed WorkspaceRuntimeError for an impossible provenance mismatch.
     * Does not handle: Source collection, scan admission, or root filesystem access.
     * Side effects: Reads private member-attestation registries.
     */
    async (repository) => resolveRepository(repository, repositoryMembers),
  );
  const collectedRepositories = await mapLimited(
    resolvedRepositories,
    MAX_CONCURRENT_REPOSITORY_SCANS,
    collectResolvedRepositorySource,
  );
  // Source extraction is independent and bounded above; Core/output admission
  // is intentionally serialized by repository ID so the invocation ledger is
  // deterministic regardless of filesystem scheduling.
  const repositoriesById = new Map<SafeIdentifier, ResolvedRepositoryResult>();
  for (const repository of [...collectedRepositories].sort(
    /**
     * Orders collected repository shells by safe declaration ID before deterministic graph-budget admission.
     *
     * Inputs: Two collected repositories.
     * Outputs: Their ID lexical comparison result.
     * Does not handle: Filesystem order, locale policy, or result materialization.
     * Side effects: Drives in-place sorting of the copied repository array.
     */
    (left, right) =>
    left.declaration.id.localeCompare(right.declaration.id),
  )) {
    repositoriesById.set(
      repository.declaration.id,
      await materializeResolvedRepository(repository, invocation),
    );
  }
  const repositories = resolvedRepositories.map(
    /**
     * Restores materialized repository results to manifest declaration order.
     *
     * Inputs: One originally resolved repository shell.
     * Outputs: Its materialized result or throws the fixed runtime error for an impossible missing map entry.
     * Does not handle: Re-scanning, fallback construction, or recovery from internal index corruption.
     * Side effects: Reads the local materialized-results Map.
     */
    (repository) => {
    const result = repositoriesById.get(repository.declaration.id);
    if (result === undefined) throw new WorkspaceRuntimeError();
    return result;
    }
  );
  const byRepositoryId = new Map(
    repositories.map(
      /**
       * Indexes one materialized repository by its parser-authored safe ID for deployment lookup.
       *
       * Inputs: One materialized repository result.
       * Outputs: Its ID/result map-entry pair.
       * Does not handle: Duplicate declaration IDs or deployment membership validation.
       * Side effects: Allocates a pair array consumed by the Map constructor.
       */
      (repository) => [repository.declaration.id, repository]
    ),
  );
  // Reserve source/input/shared-key work in a stable order. Parallel
  // deployment preparation would make bounded results scheduler-dependent.
  const deploymentsById = new Map<SafeIdentifier, WorkspaceDeploymentScanResult>();
  const deploymentOrder = [...manifest.deployments].sort(
    /**
     * Orders deployments by safe ID so bounded invocation admission cannot depend on manifest scheduling order.
     *
     * Inputs: Two parser deployment declarations.
     * Outputs: Their ID lexical comparison result.
     * Does not handle: Output presentation order, duplicate IDs, or reconciliation.
     * Side effects: Drives in-place sorting of the copied deployment array.
     */
    (left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const deployment of deploymentOrder) {
    deploymentsById.set(deployment.id, await aggregateDeployment(
      deployment,
      byRepositoryId,
      invocation,
      repositoryMembers,
    ));
  }
  const deployments = manifest.deployments.map(
    /**
     * Restores aggregate deployment results to manifest declaration order.
     *
     * Inputs: One parser deployment declaration.
     * Outputs: Its aggregate result or throws the fixed runtime error for an impossible missing index entry.
     * Does not handle: Reconciliation retries, new admission, or fault recovery.
     * Side effects: Reads the local deployment-results Map.
     */
    (deployment) => {
    const result = deploymentsById.get(deployment.id);
    if (result === undefined) throw new WorkspaceRuntimeError();
    return result;
    }
  );

  return Object.freeze({
    repositories: Object.freeze(repositories.map(
      /**
       * Projects an internal materialized repository wrapper to its public report partition.
       *
       * Inputs: One materialized repository result wrapper.
       * Outputs: Its WorkspaceRepositoryScanResult.
       * Does not handle: Deployment aggregation, cloning nested analysis facts, or result validation.
       * Side effects: None.
       */
      (repository) => repository.result
    )),
    deployments: Object.freeze(deployments),
  });
}

/**
 * Creates the narrow composition port that exposes the workspace scanner without importing application orchestration.
 *
 * Inputs: None.
 * Outputs: A frozen port whose scan method is scanWorkspace.
 * Does not handle: CLI argument parsing, viewer startup, request issuance, or dependency injection.
 * Side effects: Allocates and freezes the adapter object.
 */
export function createLocalWorkspaceScanPort(): WorkspaceScanPort<WorkspaceScanResult> {
  return Object.freeze({ scan: scanWorkspace });
}

/**
 * Resolves a parser repository declaration to the request-bound opaque member handle and normalized resolution status.
 *
 * Inputs: One parser repository declaration and issued repository-member set.
 * Outputs: A resolved shell, or throws WorkspaceRuntimeError when private handle provenance is inconsistent.
 * Does not handle: Source collection, filesystem root probing, or invalid-result construction.
 * Side effects: Reads private member identity registries.
 */
async function resolveRepository(
  declaration: WorkspaceRepository,
  repositoryMembers: unknown,
): Promise<ResolvedRepository> {
  const memberHandle = issuedWorkspaceRepositoryMember(repositoryMembers, declaration.id);
  const member = workspaceRepositoryMemberContext(memberHandle);
  if (memberHandle === undefined || member === undefined || member.repositoryId !== declaration.id) {
    throw new WorkspaceRuntimeError();
  }
  return { declaration, memberHandle, resolution: repositoryResolution(member) };
}

/**
 * Collects source evidence for a valid resolved repository while isolating its collection failure from sibling repositories.
 *
 * Inputs: A resolved repository shell.
 * Outputs: The shell annotated sourceCollected true/false.
 * Does not handle: Graph materialization, deployment reconciliation, or converting collection errors to public diagnostics.
 * Side effects: Invokes attested local source collection, which may perform bounded filesystem I/O and cache source facts.
 */
async function collectResolvedRepositorySource(
  repository: ResolvedRepository,
): Promise<CollectedRepository> {
  if (repository.resolution.ok === false) {
    return { ...repository, sourceCollected: false };
  }
  try {
    await collectAttestedLocalWorkspaceMemberSource(repository.memberHandle);
    return { ...repository, sourceCollected: true };
  } catch {
    return { ...repository, sourceCollected: false };
  }
}

/**
 * Converts a collected repository shell into an independent scan result under the invocation fact budget.
 *
 * Inputs: A collected repository and its issued invocation.
 * Outputs: A result/optional analysis pair, marking root/collection/scan failures invalid with a fixed diagnostic.
 * Does not handle: Retrying failed source collection, deployment aggregation, or throwing platform error details.
 * Side effects: Runs budgeted source analysis, which may read cached facts and decrement invocation graph budget.
 */
async function materializeResolvedRepository(
  repository: CollectedRepository,
  invocation: IssuedWorkspaceInvocation,
): Promise<ResolvedRepositoryResult> {
  const { declaration, resolution } = repository;
  if (resolution.ok === false) {
    return {
      declaration,
      memberHandle: repository.memberHandle,
      resolution,
      result: invalidRepository(declaration.id, resolution.diagnostic),
    };
  }

  if (!repository.sourceCollected) {
    const diagnostic = safeDiagnostic("WORKSPACE_REPOSITORY_SCAN_FAILED");
    return {
      declaration,
      memberHandle: repository.memberHandle,
      resolution,
      result: invalidRepository(declaration.id, diagnostic),
    };
  }

  try {
    const analysis = await scanBudgetedAttestedLocalWorkspaceMember(
      repository.memberHandle,
      invocation,
    );
    return {
      declaration,
      memberHandle: repository.memberHandle,
      resolution,
      result: repositoryResultFromAnalysis(declaration.id, analysis),
      analysis,
    };
  } catch {
    const diagnostic = safeDiagnostic("WORKSPACE_REPOSITORY_SCAN_FAILED");
    return {
      declaration,
      memberHandle: repository.memberHandle,
      resolution,
      result: invalidRepository(declaration.id, diagnostic),
    };
  }
}

/**
 * Maps internal repository-root resolution states to fixed safe runtime diagnostics.
 *
 * Inputs: A non-null request-bound repository-member context.
 * Outputs: Success or one invalid diagnostic for conflict, not-directory, or unavailable root.
 * Does not handle: Filesystem revalidation, original error details, or source analysis.
 * Side effects: Allocates frozen status/diagnostic structures through the safety factory.
 */
function repositoryResolution(
  member: NonNullable<ReturnType<typeof workspaceRepositoryMemberContext>>,
): RepositoryResolution {
  if (member.resolution.ok) return Object.freeze({ ok: true });
  return {
    ok: false,
    diagnostic: safeDiagnostic(
      member.resolution.code === "conflict"
        ? "WORKSPACE_REPOSITORY_ROOT_CONFLICT"
        : member.resolution.code === "not-directory"
          ? "WORKSPACE_REPOSITORY_ROOT_NOT_DIRECTORY"
          : "WORKSPACE_REPOSITORY_ROOT_UNAVAILABLE",
    ),
  };
}

/**
 * Projects one local analysis into the workspace repository-report partition and derives its complete/incomplete status.
 *
 * Inputs: A safe repository ID and completed local analysis facts.
 * Outputs: A frozen repository result retaining analysis facts and dynamic lookups with a derived status.
 * Does not handle: Invalid-result fallback, diagnostic deduplication, or deployment reconciliation.
 * Side effects: Allocates/freeze-copies diagnostics and the result object.
 */
function repositoryResultFromAnalysis(
  id: SafeIdentifier,
  analysis: LocalAnalysis,
): WorkspaceRepositoryScanResult {
  return Object.freeze({
    id,
    status: analysisIsIncomplete(analysis) ? "incomplete" : "complete",
    diagnostics: Object.freeze([...analysis.diagnostics]),
    reconciliation: analysis.result,
    references: analysis.reconciliationInput.references,
    demandEdges: analysis.reconciliationInput.demandEdges,
    dynamicLookupEdges: analysis.reconciliationInput.dynamicLookupEdges ?? EMPTY_REPOSITORY_RESULT.dynamicLookupEdges,
  });
}

/**
 * Builds the empty invalid repository partition for one safe diagnostic.
 *
 * Inputs: A safe repository ID and fixed safe diagnostic code.
 * Outputs: A frozen invalid result with empty reconciliation/reference/demand/dynamic collections.
 * Does not handle: Partial scan evidence, multiple diagnostics, or recovery.
 * Side effects: Allocates/freeze-wraps the diagnostic list and outer result.
 */
function invalidRepository(
  id: SafeIdentifier,
  diagnostic: SafeDiagnosticCode,
): WorkspaceRepositoryScanResult {
  return Object.freeze({
    id,
    status: "invalid",
    diagnostics: Object.freeze([diagnostic]),
    ...EMPTY_REPOSITORY_RESULT,
  });
}

/**
 * Attests, preflights, conditionally reads provisioning, and reconciles one deployment into ordered member partitions.
 *
 * Inputs: A parser deployment, repository-result index, issued invocation, and issued repository-member set.
 * Outputs: A frozen aggregate that is complete, incomplete, or invalid per member/preparation outcomes.
 * Does not handle: Provider delivery verification, cross-deployment sharing, arbitrary member IDs, or exception detail disclosure.
 * Side effects: Mints/consumes opaque attestation capabilities, may perform bounded provisioning I/O/cache work, and schedules bounded reconciliation.
 */
async function aggregateDeployment(
  deployment: WorkspaceDeployment,
  repositories: ReadonlyMap<SafeIdentifier, ResolvedRepositoryResult>,
  invocation: IssuedWorkspaceInvocation,
  repositoryMembers: unknown,
): Promise<WorkspaceDeploymentScanResult> {
  const declaredMembers: readonly DeclaredDeploymentMember[] = deployment.repositories.map(
    /**
     * Associates each declared deployment repository ID with its already materialized result when available.
     *
     * Inputs: One parser-authored deployment repository ID.
     * Outputs: A declared-member shell with an optional repository result.
     * Does not handle: Member capability issuance, source scans, or invalid-result construction.
     * Side effects: Reads the repository-result Map and allocates a shell object.
     */
    (repositoryId) => {
      const repository = repositories.get(repositoryId);
      return repository === undefined ? { repositoryId } : { repositoryId, repository };
    },
  );
  let issuance: object;
  let preflight: PreparedWorkspaceDeploymentPreflight;
  let prepared: PreparedLocalDeploymentReconciliation;
  try {
    const attestation = await attestVerifiedWorkspaceDeploymentMembers(
      invocation,
      deployment.id,
      repositoryMembers,
    );
    if (attestation === undefined) {
      throw new WorkspaceRuntimeError();
    }
    issuance = attestation;
    preflight = preflightIssuedWorkspaceDeployment(issuance, invocation);
  } catch {
    const diagnostic = safeDiagnostic("WORKSPACE_DEPLOYMENT_RECONCILIATION_FAILED");
    const members = declaredMembers
      .map(
        /**
         * Preserves an existing invalid/missing repository partition or replaces an available one with reconciliation failure.
         *
         * Inputs: One declared deployment-member shell.
         * Outputs: A member result derived from repository state or fixed reconciliation diagnostic.
         * Does not handle: Retrying attestation or emitting multiple diagnostics.
         * Side effects: Allocates invalid member results where needed.
         */
        (member) =>
        member.repository === undefined
          ? deploymentMemberFromRepository(member)
          : invalidDeploymentMember(member.repositoryId, diagnostic),
      )
      .sort(compareDeploymentMembers);
    return deploymentAggregate(deployment, members, [], [diagnostic]);
  }
  const preflightDiagnostics = preflightDeploymentDiagnostics(preflight);
  const sharedKeys = preflightDeploymentSharedKeys(preflight);

  if (!preflightHasMaterializableMembers(preflight)) {
    const members = await mapLimited(
      declaredMembers,
      MAX_CONCURRENT_REPOSITORY_SCANS,
      /**
       * Reconciles one member through the preflight budget-exhausted path without provisioning documents.
       *
       * Inputs: One declared member shell.
       * Outputs: Its incomplete/invalid/derived member partition.
       * Does not handle: Provisioning document attestation or aggregate status calculation.
       * Side effects: Calls application preflight reconciliation, which can allocate facts/diagnostics.
       */
      async (member) => reconcilePreflightPartition(member, preflight, issuance),
    );
    members.sort(compareDeploymentMembers);
    return deploymentAggregate(deployment, members, sharedKeys, preflightDiagnostics);
  }

  try {
    if (deployment.inputs === undefined) {
      // Scan-only declarations never need document attestation. Their member
      // capability is already invocation-indexed and preflight-reserved.
      registerDeploymentAttestation(issuance);
    } else {
      const attestation = await attestVerifiedWorkspaceDeploymentInputs(issuance);
      if (attestation === undefined || attestation !== issuance) {
        throw new WorkspaceRuntimeError();
      }
      registerDeploymentAttestation(issuance);
    }
    prepared = prepareIssuedLocalDeploymentReconciliation(issuance, preflight);
  } catch {
    const diagnostic = safeDiagnostic("WORKSPACE_DEPLOYMENT_RECONCILIATION_FAILED");
    const members = declaredMembers
      .map(
        /**
         * Preserves unavailable member state or converts available members to fixed reconciliation failure after preparation errors.
         *
         * Inputs: One declared deployment-member shell.
         * Outputs: A repository-derived or fixed-invalid member result.
         * Does not handle: Retrying document attestation or preserving partial prepared facts.
         * Side effects: Allocates invalid member results where required.
         */
        (member) =>
        member.repository === undefined
          ? deploymentMemberFromRepository(member)
          : invalidDeploymentMember(member.repositoryId, diagnostic),
      )
      .sort(compareDeploymentMembers);
    return deploymentAggregate(deployment, members, [], [...preflightDiagnostics, diagnostic]);
  }
  const preparationDiagnostics = preparedDeploymentDiagnostics(prepared);
  const members = await mapLimited(
    declaredMembers,
    MAX_CONCURRENT_REPOSITORY_SCANS,
    /**
     * Reconciles one ready member through the prepared local provisioning relation.
     *
     * Inputs: One declared deployment-member shell.
     * Outputs: Its complete/incomplete/invalid member partition.
     * Does not handle: Deployment aggregate construction, document preparation, or sibling-member ordering.
     * Side effects: Calls application reconciliation, which may materialize facts and diagnostics.
     */
    async (member) => reconcileDeploymentPartition(member, prepared, issuance),
  );
  members.sort(compareDeploymentMembers);
  return deploymentAggregate(deployment, members, sharedKeys, preparationDiagnostics);
}

/**
 * Produces one member partition when preflight has no materializable provisioning path but still has reservation-aware evidence.
 *
 * Inputs: Declared member, prepared preflight, and deployment issuance.
 * Outputs: Repository-derived, budget-exhausted reconciliation-derived, or fixed invalid member result.
 * Does not handle: Provisioning document reads, prepared reconciliation, or aggregate status.
 * Side effects: May call application preflight reconciliation and allocate analysis-derived facts.
 */
async function reconcilePreflightPartition(
  member: DeclaredDeploymentMember,
  preflight: PreparedWorkspaceDeploymentPreflight,
  issuance: unknown,
): Promise<WorkspaceDeploymentMemberScanResult> {
  if (member.repository === undefined) {
    return invalidDeploymentMember(
      member.repositoryId,
      safeDiagnostic("WORKSPACE_DEPLOYMENT_MEMBER_UNAVAILABLE"),
    );
  }
  if (member.repository.resolution.ok === false || member.repository.analysis === undefined) {
    return deploymentMemberFromRepository(member);
  }
  try {
    const analysis = await reconcilePreflightBudgetExhaustedMember(
      preflight,
      issuedDeploymentMember(issuance, member.repositoryId),
    );
    return deploymentMemberFromAnalysis(member.repositoryId, analysis);
  } catch {
    return invalidDeploymentMember(
      member.repositoryId,
      safeDiagnostic("WORKSPACE_DEPLOYMENT_RECONCILIATION_FAILED"),
    );
  }
}

/**
 * Produces one member partition from a fully prepared deployment reconciliation relation.
 *
 * Inputs: Declared member, prepared reconciliation, and deployment issuance.
 * Outputs: Repository-derived, reconciliation-derived, or fixed invalid member result.
 * Does not handle: Input attestation, shared-key preflight, retries, or aggregate status.
 * Side effects: May call application reconciliation and allocate analysis-derived facts.
 */
async function reconcileDeploymentPartition(
  member: DeclaredDeploymentMember,
  prepared: PreparedLocalDeploymentReconciliation,
  issuance: unknown,
): Promise<WorkspaceDeploymentMemberScanResult> {
  if (member.repository === undefined) {
    return invalidDeploymentMember(
      member.repositoryId,
      safeDiagnostic("WORKSPACE_DEPLOYMENT_MEMBER_UNAVAILABLE"),
    );
  }
  if (member.repository.resolution.ok === false || member.repository.analysis === undefined) {
    return deploymentMemberFromRepository(member);
  }
  try {
    const analysis = await reconcilePreparedLocalDeploymentMember(
      prepared,
      issuedDeploymentMember(issuance, member.repositoryId),
    );
    return deploymentMemberFromAnalysis(member.repositoryId, analysis);
  } catch {
    return invalidDeploymentMember(
      member.repositoryId,
      safeDiagnostic("WORKSPACE_DEPLOYMENT_RECONCILIATION_FAILED"),
    );
  }
}

/**
 * Reframes an already materialized repository partition as a deployment member while preserving its status/evidence.
 *
 * Inputs: One declared member with optional repository result.
 * Outputs: The repository-derived member result, or a fixed unavailable-member invalid result.
 * Does not handle: Reconciliation, scope matching, or adding deployment diagnostics.
 * Side effects: Allocates a frozen member wrapper.
 */
function deploymentMemberFromRepository(
  member: DeclaredDeploymentMember,
): WorkspaceDeploymentMemberScanResult {
  if (member.repository === undefined) {
    return invalidDeploymentMember(
      member.repositoryId,
      safeDiagnostic("WORKSPACE_DEPLOYMENT_MEMBER_UNAVAILABLE"),
    );
  }
  const { id: _id, ...result } = member.repository.result;
  return Object.freeze({
    ...result,
    repositoryId: member.repositoryId,
  });
}

/**
 * Reframes local analysis into a deployment member partition for the supplied repository identity.
 *
 * Inputs: Safe repository ID and local analysis.
 * Outputs: A frozen member result with the repository result's ID replaced by repositoryId.
 * Does not handle: Aggregate status, reconciliation execution, or analysis mutation.
 * Side effects: Allocates a repository result and frozen member wrapper.
 */
function deploymentMemberFromAnalysis(
  repositoryId: SafeIdentifier,
  analysis: LocalAnalysis,
): WorkspaceDeploymentMemberScanResult {
  const { id: _id, ...result } = repositoryResultFromAnalysis(repositoryId, analysis);
  return Object.freeze({
    ...result,
    repositoryId,
  });
}

/**
 * Builds a deployment member partition from the standard empty invalid repository result.
 *
 * Inputs: Safe repository ID and one fixed diagnostic code.
 * Outputs: A frozen invalid deployment member result.
 * Does not handle: Partial evidence, multiple diagnostics, or retry information.
 * Side effects: Allocates intermediate repository result and member wrapper.
 */
function invalidDeploymentMember(
  repositoryId: SafeIdentifier,
  diagnostic: SafeDiagnosticCode,
): WorkspaceDeploymentMemberScanResult {
  const { id: _id, ...result } = invalidRepository(repositoryId, diagnostic);
  return Object.freeze({
    ...result,
    repositoryId,
  });
}

/**
 * Builds the bounded deployment aggregate and derives status from member invalid/incomplete states and preparation diagnostics.
 *
 * Inputs: Parser deployment, ordered member results, already computed shared keys, and diagnostics.
 * Outputs: Frozen aggregate with compacted at-most-one diagnostic and sorted repository IDs.
 * Does not handle: Reconciliation, shared-key calculation, per-diagnostic retention, or explaining omitted diagnostics.
 * Side effects: Allocates sorted IDs and freezes aggregate/collection wrappers.
 */
function deploymentAggregate(
  deployment: WorkspaceDeployment,
  members: readonly WorkspaceDeploymentMemberScanResult[],
  sharedKeys: readonly LogicalKey[],
  diagnostics: readonly SafeDiagnosticCode[],
): WorkspaceDeploymentScanResult {
  const status = members.some(
    /**
     * Detects whether any aggregate member is invalid.
     *
     * Inputs: One deployment member result.
     * Outputs: True when its status is invalid.
     * Does not handle: Incomplete status or aggregate diagnostics.
     * Side effects: None.
     */
    (member) => member.status === "invalid"
  )
    ? "invalid"
    : members.some(
      /**
       * Detects whether any otherwise-valid aggregate member remains incomplete.
       *
       * Inputs: One deployment member result.
       * Outputs: True when its status is incomplete.
       * Does not handle: Invalid status or aggregate diagnostics.
       * Side effects: None.
       */
      (member) => member.status === "incomplete"
    ) || diagnostics.length > 0
      ? "incomplete"
      : "complete";
  return Object.freeze({
    id: deployment.id,
    repositoryIds: Object.freeze([...deployment.repositories].sort(
      /**
       * Orders declared repository IDs deterministically in the aggregate surface.
       *
       * Inputs: Two safe repository IDs.
       * Outputs: Their lexical comparison result.
       * Does not handle: Membership validation or member-result ordering.
       * Side effects: Drives in-place sorting of the copied IDs.
       */
      (left, right) => left.localeCompare(right)
    )),
    status,
    // Invocation minting reserves one aggregate status slot per deployment.
    // Keep this surface compact even when several internal uncertainty paths
    // contribute diagnostics, so legal maximum membership cannot exceed the
    // global graph bound through aggregate-only output.
    diagnostics: compactDeploymentDiagnostics(diagnostics),
    sharedKeys,
    members: Object.freeze([...members]),
  });
}

/**
 * Orders deployment member partitions by safe repository ID.
 *
 * Inputs: Two deployment member scan results.
 * Outputs: Their repository-ID lexical comparison result.
 * Does not handle: Status prioritization, diagnostic ordering, or equality tie breaking beyond ID equality.
 * Side effects: None.
 */
function compareDeploymentMembers(
  left: WorkspaceDeploymentMemberScanResult,
  right: WorkspaceDeploymentMemberScanResult,
): number {
  return left.repositoryId.localeCompare(right.repositoryId);
}

/**
 * Produces an all-invalid workspace result when the once-issued manifest file/base can no longer be trusted.
 *
 * Inputs: The parser-authored manifest retained by the issued request.
 * Outputs: Frozen invalid partitions for every declared repository/deployment/member with one fixed path-unavailable diagnostic.
 * Does not handle: Reattesting a new manifest path, preserving prior scan facts, or revealing the changed path.
 * Side effects: Allocates/freeze-wraps fallback result collections.
 */
function invalidWorkspaceForManifestPath(manifest: WorkspaceManifest): WorkspaceScanResult {
  const diagnostic = safeDiagnostic("WORKSPACE_MANIFEST_PATH_UNAVAILABLE");
  return Object.freeze({
    repositories: Object.freeze(
      manifest.repositories.map(
        /**
         * Creates the fixed invalid repository fallback for one manifest declaration.
         *
         * Inputs: One parser-authored repository declaration.
         * Outputs: Its empty invalid repository partition.
         * Does not handle: Source scanning or individual root diagnostics.
         * Side effects: Allocates an invalid result wrapper.
         */
        (repository) => invalidRepository(repository.id, diagnostic)
      ),
    ),
    deployments: Object.freeze(
      manifest.deployments.map(
        /**
         * Creates one fixed invalid deployment fallback with invalid member partitions.
         *
         * Inputs: One parser-authored deployment declaration.
         * Outputs: Its frozen invalid deployment aggregate.
         * Does not handle: Provisioning I/O, reconciliation, or retention of prior facts.
         * Side effects: Allocates nested fallback arrays/objects.
         */
        (deployment) =>
        Object.freeze({
          id: deployment.id,
          repositoryIds: Object.freeze([...deployment.repositories].sort(
            /**
             * Orders fallback repository IDs deterministically for report stability.
             *
             * Inputs: Two safe repository IDs.
             * Outputs: Their lexical comparison result.
             * Does not handle: Member fallback creation or ID validation.
             * Side effects: Drives sorting of a copied ID array.
             */
            (left, right) => left.localeCompare(right)
          )),
          status: "invalid" as const,
          diagnostics: Object.freeze([diagnostic]),
          sharedKeys: Object.freeze([]),
          members: Object.freeze(
            deployment.repositories
              .map(
                /**
                 * Creates the fixed invalid member fallback for one declared repository ID.
                 *
                 * Inputs: One safe deployment repository ID.
                 * Outputs: Its empty invalid member partition.
                 * Does not handle: Repository result reuse or reconciliation.
                 * Side effects: Allocates an invalid member wrapper.
                 */
                (repositoryId) => invalidDeploymentMember(repositoryId, diagnostic)
              )
              .sort(compareDeploymentMembers),
          ),
        }),
      ),
    ),
  });
}

/**
 * Determines whether any local analysis coverage record prevents a complete repository status.
 *
 * Inputs: A local analysis with reconciliation scope coverage and records.
 * Outputs: True when any scope or reconciliation record is incomplete.
 * Does not handle: Invalid status, dynamic-edge semantics, or diagnostics outside coverage facts.
 * Side effects: Iterates analysis arrays without mutation.
 */
function analysisIsIncomplete(analysis: LocalAnalysis): boolean {
  return (
    analysis.result.scopeCoverage.some(
      /**
       * Detects an incomplete scope-coverage status in the current analysis.
       *
       * Inputs: One reconciliation scope-coverage fact.
       * Outputs: True when its state is incomplete.
       * Does not handle: Record coverage or diagnostic classification.
       * Side effects: None.
       */
      (coverage) => coverage.state === "incomplete"
    ) ||
    analysis.result.records.some(
      /**
       * Detects an incomplete reconciliation record in the current analysis.
       *
       * Inputs: One reconciliation record.
       * Outputs: True when its coverage is incomplete.
       * Does not handle: Scope-coverage status or record rendering.
       * Side effects: None.
       */
      (record) => record.coverage === "incomplete"
    )
  );
}

/**
 * Deduplicates and lexically orders safe diagnostics for deterministic compact deployment output.
 *
 * Inputs: A diagnostic-code list.
 * Outputs: A frozen sorted list containing each code once.
 * Does not handle: Severity ordering, aggregate truncation, or unsafe code materialization.
 * Side effects: Allocates a Set, copied array, sort workspace, and frozen output.
 */
function uniqueDiagnostics(
  diagnostics: readonly SafeDiagnosticCode[],
): readonly SafeDiagnosticCode[] {
  return Object.freeze([...new Set(diagnostics)].sort(
    /**
     * Orders two safe diagnostic codes deterministically after deduplication.
     *
     * Inputs: Two safe diagnostic-code strings.
     * Outputs: Their lexical comparison result.
     * Does not handle: Severity ranking or code validation.
     * Side effects: Drives sorting of a copied diagnostic array.
     */
    (left, right) => left.localeCompare(right)
  ));
}

/**
 * Compacts aggregate deployment diagnostics to the one deterministic slot reserved by invocation admission.
 *
 * Inputs: A list of safe deployment diagnostics.
 * Outputs: An empty frozen list or one-element frozen list containing the first deduplicated lexical code.
 * Does not handle: Preserving every underlying diagnostic, severity selection, or adding an overflow marker.
 * Side effects: Allocates through uniqueDiagnostics and freezes the one-slot result.
 */
function compactDeploymentDiagnostics(
  diagnostics: readonly SafeDiagnosticCode[],
): readonly SafeDiagnosticCode[] {
  const unique = uniqueDiagnostics(diagnostics);
  const first = unique[0];
  return first === undefined ? Object.freeze([]) : Object.freeze([first]);
}

/**
 * Materializes one trusted fixed runtime diagnostic string as a SafeDiagnosticCode.
 *
 * Inputs: A module-authored diagnostic constant.
 * Outputs: The safety-factory diagnostic code.
 * Does not handle: Caller-controlled error text, redaction, or diagnostic validation failure reporting.
 * Side effects: Allocates a short-lived SafeFactFactory and its branded result.
 */
function safeDiagnostic(value: string): SafeDiagnosticCode {
  return new SafeFactFactory().diagnosticCode(value);
}

/**
 * Maps values with a fixed maximum number of active async workers while retaining input ordering.
 *
 * Inputs: An input array, concurrency limit, and async mapper.
 * Outputs: A result array ordered like values after every mapper succeeds.
 * Does not handle: Cancellation, mapper-error recovery, limit validation, or scheduler-independent mapper side effects.
 * Side effects: Allocates worker promises/results and mutates the shared next index/result slots.
 */
async function mapLimited<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    /**
     * Claims one unprocessed index at a time for the enclosing bounded mapper.
     *
     * Inputs: The unused Array.from worker index.
     * Outputs: A promise resolved when no input indexes remain for this worker.
     * Does not handle: Catching mapper exceptions or external synchronization.
     * Side effects: Increments the shared next counter and writes mapped values into result slots.
     */
    async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index] as T);
    }
    }
  );
  await Promise.all(workers);
  return results;
}
