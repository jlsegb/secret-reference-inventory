import type { ReportingInput, WorkspaceReportingInput } from "../reporters/index.js";

import type {
  WorkspaceScanReportSource,
  WorkspaceScanResultEntry,
} from "./workspace-port.js";

/**
 * Maps N3's safe scan-result contract into the reporter contract. This is the
 * only cross-layer join; neither a canonical manifest path nor raw source text
 * is accepted by the report/viewer path.
 */
export function workspaceScanToReportingInput(
  result: WorkspaceScanReportSource,
): WorkspaceReportingInput {
  return {
    repositories: result.repositories.map((repository) => ({
      id: repository.id,
      state: repository.status,
      report: toReportingInput(repository),
      diagnostics: repository.diagnostics,
    })),
    deployments: result.deployments.map((deployment) => ({
      id: deployment.id,
      repositoryIds: deployment.repositoryIds,
      state: deployment.status,
      sharedKeys: deployment.sharedKeys,
      diagnostics: deployment.diagnostics,
      members: deployment.members.map((member) => ({
        repositoryId: member.repositoryId,
        state: member.status,
        report: toReportingInput(member),
        diagnostics: member.diagnostics,
      })),
    })),
  };
}

function toReportingInput(
  result: Pick<WorkspaceScanResultEntry, "reconciliation" | "references" | "demandEdges">,
): ReportingInput {
  return {
    result: result.reconciliation,
    references: result.references,
    demandEdges: result.demandEdges,
  };
}
