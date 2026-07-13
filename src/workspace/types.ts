import type {
  DemandEdge,
  DynamicLookupEdge,
  LogicalKey,
  ReconciliationResult,
  SafeDiagnosticCode,
  SafeIdentifier,
  SecretReference,
} from "../core/index.js";
/**
 * A repository or explicit deployment outcome. `invalid` means the local
 * workspace declaration could not be acted on for that unit; `incomplete`
 * preserves a partial static result without implying absence.
 */
export type WorkspaceScanStatus = "complete" | "incomplete" | "invalid";

/**
 * An issuance-only workspace scan capability. Its parser token, canonical
 * manifest identity, and base identity live exclusively in a private WeakMap;
 * callers cannot attach a path or substitute a separately parsed manifest.
 */
declare const workspaceScanRequestBrand: unique symbol;
export type WorkspaceScanRequest = {
  readonly [workspaceScanRequestBrand]: true;
};

/** Value-free reconciliation facts shared by repository and member results. */
interface WorkspaceScanFacts {
  readonly status: WorkspaceScanStatus;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly reconciliation: ReconciliationResult;
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
}

/**
 * A value-free repository result. All fields are normalized Core facts and
 * can therefore be mapped directly into the workspace reporter.
 */
export interface WorkspaceRepositoryScanResult extends WorkspaceScanFacts {
  readonly id: SafeIdentifier;
}

/** One repository-qualified reconciliation partition inside a deployment. */
export interface WorkspaceDeploymentMemberScanResult extends WorkspaceScanFacts {
  readonly repositoryId: SafeIdentifier;
}

/**
 * Deployment aggregation is intentionally separate from member reconciliation.
 * It contains only aggregate state, declared membership, direct-demand sharing,
 * and independent member partitions—never a fabricated flattened mapping.
 */
export interface WorkspaceDeploymentScanResult {
  readonly id: SafeIdentifier;
  readonly status: WorkspaceScanStatus;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly repositoryIds: readonly SafeIdentifier[];
  readonly sharedKeys: readonly LogicalKey[];
  readonly members: readonly WorkspaceDeploymentMemberScanResult[];
}

/** The stable N3 result shape consumed structurally by N5's reporting port. */
export interface WorkspaceScanResult {
  readonly repositories: readonly WorkspaceRepositoryScanResult[];
  readonly deployments: readonly WorkspaceDeploymentScanResult[];
}
