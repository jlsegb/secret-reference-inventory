import type {
  LogicalKey,
  SafeDiagnosticCode,
  SafeIdentifier,
} from "../core/index.js";

import type {
  JsonLogicalKey,
  JsonReport,
  ReportingInput,
} from "./types.js";

export const WORKSPACE_REPORT_SCHEMA_VERSION =
  "secret-reference-inventory/workspace-report/v2" as const;

export type WorkspaceReportState = "complete" | "incomplete" | "invalid";

/**
 * N3 maps its isolated repository result into this safe reporting boundary.
 * The report field is normalized facts only and cannot include source text,
 * manifest text, canonical paths, values, or runtime objects.
 */
export interface WorkspaceRepositoryReportingInput {
  readonly id: SafeIdentifier;
  readonly state: WorkspaceReportState;
  readonly report?: ReportingInput;
  readonly diagnostics?: readonly SafeDiagnosticCode[];
}

/**
 * A deployment exists only when N3 has an explicit manifest association.
 * Shared keys are aggregation evidence, not implicit injection evidence.
 */
export interface WorkspaceDeploymentReportingInput {
  readonly id: SafeIdentifier;
  readonly repositoryIds: readonly SafeIdentifier[];
  readonly state: WorkspaceReportState;
  readonly sharedKeys: readonly LogicalKey[];
  readonly diagnostics?: readonly SafeDiagnosticCode[];
  readonly members: readonly WorkspaceDeploymentMemberReportingInput[];
}

/** One isolated repository partition within a deployment report. */
export interface WorkspaceDeploymentMemberReportingInput {
  readonly repositoryId: SafeIdentifier;
  readonly state: WorkspaceReportState;
  readonly report?: ReportingInput;
  readonly diagnostics?: readonly SafeDiagnosticCode[];
}

export interface WorkspaceReportingInput {
  readonly repositories: readonly WorkspaceRepositoryReportingInput[];
  readonly deployments: readonly WorkspaceDeploymentReportingInput[];
}

export interface WorkspaceJsonRepositoryReport {
  readonly id: string;
  readonly state: WorkspaceReportState;
  readonly report?: JsonReport;
  readonly diagnostics: readonly string[];
}

export interface WorkspaceJsonDeploymentReport {
  readonly id: string;
  readonly repositoryIds: readonly string[];
  readonly state: WorkspaceReportState;
  readonly sharedKeys: readonly JsonLogicalKey[];
  readonly diagnostics: readonly string[];
  readonly members: readonly WorkspaceJsonDeploymentMemberReport[];
}

export interface WorkspaceJsonDeploymentMemberReport {
  readonly repositoryId: string;
  readonly state: WorkspaceReportState;
  readonly report?: JsonReport;
  readonly diagnostics: readonly string[];
}

export interface WorkspaceJsonReport {
  readonly schemaVersion: typeof WORKSPACE_REPORT_SCHEMA_VERSION;
  readonly summary: {
    readonly repositories: number;
    readonly deployments: number;
    readonly incomplete: boolean;
  };
  readonly repositories: readonly WorkspaceJsonRepositoryReport[];
  readonly deployments: readonly WorkspaceJsonDeploymentReport[];
}

export class WorkspaceReportError extends Error {
  readonly code:
    | "WORKSPACE_REPORT_INVALID_INPUT"
    | "WORKSPACE_REPORT_DUPLICATE_REPOSITORY"
    | "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT"
    | "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER";

  public constructor(code: WorkspaceReportError["code"]) {
    super(code);
    this.name = "WorkspaceReportError";
    this.code = code;
  }
}
