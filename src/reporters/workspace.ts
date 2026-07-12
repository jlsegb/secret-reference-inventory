import {
  SafeFactFactory,
  isSecretLikeToken,
  type Identifier,
} from "../safety/index.js";

import { buildJsonReport } from "./model.js";
import type { JsonLogicalKey } from "./types.js";
import {
  WORKSPACE_REPORT_SCHEMA_VERSION,
  WorkspaceReportError,
  type WorkspaceDeploymentReportingInput,
  type WorkspaceJsonDeploymentMemberReport,
  type WorkspaceJsonDeploymentReport,
  type WorkspaceJsonReport,
  type WorkspaceJsonRepositoryReport,
  type WorkspaceReportingInput,
  type WorkspaceReportState,
} from "./workspace-types.js";

const OPAQUE = "<opaque>";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_DIAGNOSTIC = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * Builds a deterministic, value-free workspace artifact. N3 remains the owner
 * of scan/reconciliation orchestration; this adapter only serializes its
 * already-normalized results.
 */
export function buildWorkspaceJsonReport(
  input: WorkspaceReportingInput,
): WorkspaceJsonReport {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.repositories) ||
    !Array.isArray(input.deployments)
  ) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }

  const repositories = input.repositories.map(toRepositoryReport).sort(compareById);
  assertUniqueIds(
    repositories.map((repository) => repository.id),
    "WORKSPACE_REPORT_DUPLICATE_REPOSITORY",
  );
  const deployments = input.deployments.map(toDeploymentReport).sort(compareById);
  assertUniqueIds(
    deployments.map((deployment) => deployment.id),
    "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT",
  );

  return {
    schemaVersion: WORKSPACE_REPORT_SCHEMA_VERSION,
    summary: {
      repositories: repositories.length,
      deployments: deployments.length,
      incomplete:
        repositories.some((repository) => repository.state !== "complete") ||
        deployments.some((deployment) => deployment.state !== "complete"),
    },
    repositories,
    deployments,
  };
}

export function renderWorkspaceJson(input: WorkspaceReportingInput): string {
  return JSON.stringify(buildWorkspaceJsonReport(input), null, 2) + "\n";
}

export function renderWorkspaceTerminal(input: WorkspaceReportingInput): string {
  const report = buildWorkspaceJsonReport(input);
  const lines = [
    "Workspace secret reference inventory",
    "",
    "Repository  State       Groups  Dynamic",
    "----------  ----------  ------  -------",
  ];

  for (const repository of report.repositories) {
    const groups = repository.report?.groups.length ?? 0;
    const dynamic = repository.report?.dynamicLookups.length ?? 0;
    lines.push(
      pad(repository.id, 10) + "  " +
      pad(repository.state, 10) + "  " +
      pad(String(groups), 6) + "  " +
      String(dynamic),
    );
  }

  if (report.deployments.length > 0) {
    lines.push("", "Deployments");
    for (const deployment of report.deployments) {
      lines.push(
        "  " +
        deployment.id +
        "  " +
        deployment.state +
        "  repositories=" +
        deployment.repositoryIds.join(",") +
        "  shared-keys=" +
        String(deployment.sharedKeys.length),
      );
      for (const member of deployment.members) {
        const groups = member.report?.groups.length ?? 0;
        const dynamic = member.report?.dynamicLookups.length ?? 0;
        lines.push(
          "    " +
          member.repositoryId +
          "  " +
          member.state +
          "  groups=" +
          String(groups) +
          "  dynamic=" +
          String(dynamic),
        );
      }
    }
  }

  if (report.summary.incomplete) {
    lines.push("", "One or more workspace results are incomplete.");
  }
  return lines.join("\n") + "\n";
}

function toRepositoryReport(
  input: WorkspaceReportingInput["repositories"][number],
): WorkspaceJsonRepositoryReport {
  if (input === null || typeof input !== "object" || !isState(input.state)) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }
  return {
    id: safeIdentifier(input.id),
    state: input.state,
    ...(input.report === undefined ? {} : { report: buildJsonReport(input.report) }),
    diagnostics: safeDiagnostics(input.diagnostics ?? []),
  };
}

function toDeploymentReport(
  input: WorkspaceDeploymentReportingInput,
): WorkspaceJsonDeploymentReport {
  if (
    input === null ||
    typeof input !== "object" ||
    !isState(input.state) ||
    !Array.isArray(input.repositoryIds) ||
    !Array.isArray(input.sharedKeys) ||
    !Array.isArray(input.members)
  ) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }
  const rawRepositoryIds = input.repositoryIds.map(safeIdentifier);
  if (new Set(rawRepositoryIds).size !== rawRepositoryIds.length) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }
  const repositoryIds = [...rawRepositoryIds].sort((left, right) => left.localeCompare(right));
  const members = input.members.map(toDeploymentMemberReport).sort(compareByRepositoryId);
  assertUniqueIds(
    members.map((member) => member.repositoryId),
    "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER",
  );
  if (
    members.length !== repositoryIds.length ||
    members.some((member, index) => member.repositoryId !== repositoryIds[index])
  ) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }
  return {
    id: safeIdentifier(input.id),
    repositoryIds,
    state: input.state,
    sharedKeys: uniqueSortedKeys(input.sharedKeys.map(toJsonLogicalKey)),
    diagnostics: safeDiagnostics(input.diagnostics ?? []),
    members,
  };
}

function toDeploymentMemberReport(
  input: WorkspaceDeploymentReportingInput["members"][number],
): WorkspaceJsonDeploymentMemberReport {
  if (input === null || typeof input !== "object" || !isState(input.state)) {
    throw new WorkspaceReportError("WORKSPACE_REPORT_INVALID_INPUT");
  }
  return {
    repositoryId: safeIdentifier(input.repositoryId),
    state: input.state,
    ...(input.report === undefined ? {} : { report: buildJsonReport(input.report) }),
    diagnostics: safeDiagnostics(input.diagnostics ?? []),
  };
}

function toJsonLogicalKey(
  key: WorkspaceDeploymentReportingInput["sharedKeys"][number],
): JsonLogicalKey {
  const safety = new SafeFactFactory();
  const identifier: Identifier = key.namespace === "env"
    ? safety.environmentKey(key.name)
    : safety.genericIdentifier(key.name);
  return {
    namespace: key.namespace,
    name: typeof identifier === "string" ? safeIdentifier(identifier) : OPAQUE,
  };
}

function safeDiagnostics(values: readonly unknown[]): string[] {
  return uniqueSorted(
    values.map((value) =>
      typeof value === "string" && SAFE_DIAGNOSTIC.test(value) && !isSecretLikeToken(value)
        ? value
        : "UNSAFE_DIAGNOSTIC",
    ),
  );
}

function safeIdentifier(value: unknown): string {
  return typeof value === "string" &&
    SAFE_IDENTIFIER.test(value) &&
    !isSecretLikeToken(value)
    ? value
    : OPAQUE;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueSortedKeys(values: readonly JsonLogicalKey[]): JsonLogicalKey[] {
  const byKey = new Map<string, JsonLogicalKey>();
  for (const value of values) {
    byKey.set(value.namespace + "\u0000" + value.name, value);
  }
  return [...byKey.values()].sort((left, right) =>
    (left.namespace + ":" + left.name).localeCompare(right.namespace + ":" + right.name),
  );
}

function compareById<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function compareByRepositoryId(
  left: WorkspaceJsonDeploymentMemberReport,
  right: WorkspaceJsonDeploymentMemberReport,
): number {
  return left.repositoryId.localeCompare(right.repositoryId);
}

function assertUniqueIds(
  values: readonly string[],
  code: WorkspaceReportError["code"],
): void {
  if (new Set(values).size !== values.length) {
    throw new WorkspaceReportError(code);
  }
}

function isState(value: unknown): value is WorkspaceReportState {
  return value === "complete" || value === "incomplete" || value === "invalid";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}
