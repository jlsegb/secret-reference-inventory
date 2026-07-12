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

  public constructor() {
    super("WORKSPACE_MANIFEST_INVALID");
    this.name = "WorkspaceRuntimeError";
  }
}

/**
 * Scan a validated workspace manifest without executing repository code or
 * exposing any canonical local paths. Repositories are independent failure
 * domains; one bad root cannot turn another repository's evidence into an
 * incomplete or invalid result.
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
  for (const repository of [...collectedRepositories].sort((left, right) =>
    left.declaration.id.localeCompare(right.declaration.id),
  )) {
    repositoriesById.set(
      repository.declaration.id,
      await materializeResolvedRepository(repository, invocation),
    );
  }
  const repositories = resolvedRepositories.map((repository) => {
    const result = repositoriesById.get(repository.declaration.id);
    if (result === undefined) throw new WorkspaceRuntimeError();
    return result;
  });
  const byRepositoryId = new Map(
    repositories.map((repository) => [repository.declaration.id, repository]),
  );
  // Reserve source/input/shared-key work in a stable order. Parallel
  // deployment preparation would make bounded results scheduler-dependent.
  const deploymentsById = new Map<SafeIdentifier, WorkspaceDeploymentScanResult>();
  const deploymentOrder = [...manifest.deployments].sort((left, right) =>
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
  const deployments = manifest.deployments.map((deployment) => {
    const result = deploymentsById.get(deployment.id);
    if (result === undefined) throw new WorkspaceRuntimeError();
    return result;
  });

  return Object.freeze({
    repositories: Object.freeze(repositories.map((repository) => repository.result)),
    deployments: Object.freeze(deployments),
  });
}

/**
 * Adapter for N5's narrow composition port. The types are intentionally
 * structural so the workspace runtime stays independent of app composition.
 */
export function createLocalWorkspaceScanPort(): WorkspaceScanPort<WorkspaceScanResult> {
  return Object.freeze({ scan: scanWorkspace });
}

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

async function aggregateDeployment(
  deployment: WorkspaceDeployment,
  repositories: ReadonlyMap<SafeIdentifier, ResolvedRepositoryResult>,
  invocation: IssuedWorkspaceInvocation,
  repositoryMembers: unknown,
): Promise<WorkspaceDeploymentScanResult> {
  const declaredMembers: readonly DeclaredDeploymentMember[] = deployment.repositories.map(
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
      .map((member) =>
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
      .map((member) =>
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
    async (member) => reconcileDeploymentPartition(member, prepared, issuance),
  );
  members.sort(compareDeploymentMembers);
  return deploymentAggregate(deployment, members, sharedKeys, preparationDiagnostics);
}

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

function deploymentAggregate(
  deployment: WorkspaceDeployment,
  members: readonly WorkspaceDeploymentMemberScanResult[],
  sharedKeys: readonly LogicalKey[],
  diagnostics: readonly SafeDiagnosticCode[],
): WorkspaceDeploymentScanResult {
  const status = members.some((member) => member.status === "invalid")
    ? "invalid"
    : members.some((member) => member.status === "incomplete") || diagnostics.length > 0
      ? "incomplete"
      : "complete";
  return Object.freeze({
    id: deployment.id,
    repositoryIds: Object.freeze([...deployment.repositories].sort((left, right) => left.localeCompare(right))),
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

function compareDeploymentMembers(
  left: WorkspaceDeploymentMemberScanResult,
  right: WorkspaceDeploymentMemberScanResult,
): number {
  return left.repositoryId.localeCompare(right.repositoryId);
}

function invalidWorkspaceForManifestPath(manifest: WorkspaceManifest): WorkspaceScanResult {
  const diagnostic = safeDiagnostic("WORKSPACE_MANIFEST_PATH_UNAVAILABLE");
  return Object.freeze({
    repositories: Object.freeze(
      manifest.repositories.map((repository) => invalidRepository(repository.id, diagnostic)),
    ),
    deployments: Object.freeze(
      manifest.deployments.map((deployment) =>
        Object.freeze({
          id: deployment.id,
          repositoryIds: Object.freeze([...deployment.repositories].sort((left, right) => left.localeCompare(right))),
          status: "invalid" as const,
          diagnostics: Object.freeze([diagnostic]),
          sharedKeys: Object.freeze([]),
          members: Object.freeze(
            deployment.repositories
              .map((repositoryId) => invalidDeploymentMember(repositoryId, diagnostic))
              .sort(compareDeploymentMembers),
          ),
        }),
      ),
    ),
  });
}

function analysisIsIncomplete(analysis: LocalAnalysis): boolean {
  return (
    analysis.result.scopeCoverage.some((coverage) => coverage.state === "incomplete") ||
    analysis.result.records.some((record) => record.coverage === "incomplete")
  );
}

function uniqueDiagnostics(
  diagnostics: readonly SafeDiagnosticCode[],
): readonly SafeDiagnosticCode[] {
  return Object.freeze([...new Set(diagnostics)].sort((left, right) => left.localeCompare(right)));
}

/** Exactly one deterministic aggregate status fits the invocation reservation. */
function compactDeploymentDiagnostics(
  diagnostics: readonly SafeDiagnosticCode[],
): readonly SafeDiagnosticCode[] {
  const unique = uniqueDiagnostics(diagnostics);
  const first = unique[0];
  return first === undefined ? Object.freeze([]) : Object.freeze([first]);
}

function safeDiagnostic(value: string): SafeDiagnosticCode {
  return new SafeFactFactory().diagnosticCode(value);
}

async function mapLimited<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
