import type { ReportingInput, WorkspaceReportingInput } from "../reporters/index.js";

import type {
  WorkspaceScanReportSource,
  WorkspaceScanResultEntry,
} from "./workspace-port.js";

/**
 * Maps the safe workspace scan partitions into the reporter's public input shape.
 *
 * Inputs: A workspace scan source containing repository, deployment, and member result partitions.
 * Outputs: A new `WorkspaceReportingInput` retaining only report-safe IDs, statuses, diagnostics, and reporting facts.
 * Does not handle: Canonical manifest paths, raw source text, viewer construction, or scan execution.
 * Side effects: Allocates nested reporting arrays and calls `toReportingInput` for each repository/member.
 */
export function workspaceScanToReportingInput(
  result: WorkspaceScanReportSource,
): WorkspaceReportingInput {
  return {
    repositories: result.repositories.map(/**
     * Converts one repository scan partition to its report-safe projection.
     *
     * Inputs: One repository entry from the workspace scan source.
     * Outputs: A reporter repository object with ID, state, diagnostics, and optional report input.
     * Does not handle: Deployment members or validation of source facts.
     * Side effects: Allocates one projection object and calls `toReportingInput`.
     */ (repository) => ({
      id: repository.id,
      state: repository.status,
      report: toReportingInput(repository),
      diagnostics: repository.diagnostics,
    })),
    deployments: result.deployments.map(/**
     * Converts one deployment scan partition and its members to reporting data.
     *
     * Inputs: One deployment entry from the workspace scan source.
     * Outputs: A reporter deployment object containing safe IDs, status, shared keys, diagnostics, and member projections.
     * Does not handle: Cross-deployment aggregation or source fact validation.
     * Side effects: Allocates a deployment projection and maps member entries.
     */ (deployment) => ({
      id: deployment.id,
      repositoryIds: deployment.repositoryIds,
      state: deployment.status,
      sharedKeys: deployment.sharedKeys,
      diagnostics: deployment.diagnostics,
      members: deployment.members.map(/**
       * Converts one deployment member partition to its report-safe projection.
       *
       * Inputs: One member entry from a scanned deployment.
       * Outputs: A reporter member object with repository ID, state, diagnostics, and optional report input.
       * Does not handle: Repository-level result construction or deployment-wide fields.
       * Side effects: Allocates one member projection and calls `toReportingInput`.
       */ (member) => ({
        repositoryId: member.repositoryId,
        state: member.status,
        report: toReportingInput(member),
        diagnostics: member.diagnostics,
      })),
    })),
  };
}

/**
 * Selects the reconciliation facts that reporter functions consume from a workspace result entry.
 *
 * Inputs: One repository or deployment-member entry with reconciliation, references, and demand edges.
 * Outputs: A `ReportingInput` that reuses those three safe fact collections.
 * Does not handle: Status, diagnostics, IDs, rendering, or any local I/O.
 * Side effects: Allocates a shallow projection object.
 */
function toReportingInput(
  result: Pick<WorkspaceScanResultEntry, "reconciliation" | "references" | "demandEdges">,
): ReportingInput {
  return {
    result: result.reconciliation,
    references: result.references,
    demandEdges: result.demandEdges,
  };
}
