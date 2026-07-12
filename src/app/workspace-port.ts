import type {
  DemandEdge,
  DynamicLookupEdge,
  LogicalKey,
  ReconciliationResult,
  SafeDiagnosticCode,
  SafeIdentifier,
  SecretReference,
} from "../core/index.js";
import type { WorkspaceScanRequest } from "../workspace/index.js";

export type { WorkspaceScanRequest } from "../workspace/index.js";

export type WorkspaceScanStatus = "complete" | "incomplete" | "invalid";

/**
 * This is the reporting subset N5 needs from N3. It deliberately contains
 * only normalized facts and safe diagnostic codes, never a root, manifest
 * descriptor, raw source/config text, or provider response.
 */
interface WorkspaceScanResultFacts {
  readonly status: WorkspaceScanStatus;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly reconciliation: ReconciliationResult;
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
}

export interface WorkspaceScanResultEntry extends WorkspaceScanResultFacts {
  readonly id: SafeIdentifier;
}

export interface WorkspaceDeploymentMemberScanResultEntry extends WorkspaceScanResultFacts {
  readonly repositoryId: SafeIdentifier;
}

/** Aggregate deployment metadata plus isolated repository-qualified members. */
export interface WorkspaceDeploymentScanResultEntry {
  readonly id: SafeIdentifier;
  readonly status: WorkspaceScanStatus;
  readonly diagnostics: readonly SafeDiagnosticCode[];
  readonly repositoryIds: readonly SafeIdentifier[];
  readonly sharedKeys: readonly LogicalKey[];
  readonly members: readonly WorkspaceDeploymentMemberScanResultEntry[];
}

export interface WorkspaceScanReportSource {
  readonly repositories: readonly WorkspaceScanResultEntry[];
  readonly deployments: readonly WorkspaceDeploymentScanResultEntry[];
}

/**
 * N3 owns the concrete WorkspaceScanResult shape. Keeping the port generic
 * lets CLI composition depend on its public result without duplicating runtime
 * or manifest-resolution behavior in this layer.
 */
export interface WorkspaceScanPort<
  TResult extends WorkspaceScanReportSource = WorkspaceScanReportSource,
> {
  scan(input: WorkspaceScanRequest): Promise<TResult>;
}
