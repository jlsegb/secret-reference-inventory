import { isSecretLikeToken } from "../safety/index.js";
import type { WorkspaceJsonReport } from "../reporters/index.js";
import {
  appendLocalViewerFact,
  appendLocalViewerRepository,
  appendLocalViewerResult,
  createLocalViewerDocumentBuilder,
  issueLocalReportViewerRequest,
  type LocalViewerRepositorySlot,
  type LocalViewerResultSlot,
  ViewerRequestError,
} from "../viewer/internal.js";
import type {
  LocalReportViewerRequest,
  ViewerDisposition,
  ViewerFactTone,
} from "../viewer/types.js";

/**
 * Derives and issues the only viewer request accepted by the local server.
 * This module owns report traversal; it writes scalar fields positionally into
 * an internal builder and never hands a report array/object to the viewer.
 */
export function workspaceReportToViewerRequest(
  report: WorkspaceJsonReport,
  port: number | undefined,
): LocalReportViewerRequest {
  const builder = createLocalViewerDocumentBuilder();
  const repositories = report.repositories;
  for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
    const repository = repositories[repositoryIndex];
    if (repository === undefined) {
      throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
    }
    appendRepositoryReport(builder, repository, repositoryIndex);
  }

  const deployments = report.deployments;
  if (deployments.length > 0) {
    const deploymentRepository = appendLocalViewerRepository(
      builder,
      "workspace-deployments",
      "Deployments",
    );
    for (let deploymentIndex = 0; deploymentIndex < deployments.length; deploymentIndex += 1) {
      const deployment = deployments[deploymentIndex];
      if (deployment === undefined) {
        throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
      }
      appendDeploymentResult(deploymentRepository, deployment, deploymentIndex);
    }
  }

  // Limits are enforced after synthetic Overview/deployment rows are added,
  // and before the listener request is issued.
  return issueLocalReportViewerRequest(builder, port);
}

function appendRepositoryReport(
  builder: ReturnType<typeof createLocalViewerDocumentBuilder>,
  repository: WorkspaceJsonReport["repositories"][number],
  repositoryIndex: number,
): void {
  const viewerRepository = appendLocalViewerRepository(
    builder,
    "repository-" + String(repositoryIndex + 1),
    safeDisplayIdentifier(repository.id, "repository-" + String(repositoryIndex + 1)),
  );
  const state = safeState(repository.state);
  const sourceReport = repository.report;
  const groups = sourceReport === undefined ? undefined : sourceReport.groups;
  const dynamicLookups = sourceReport === undefined ? undefined : sourceReport.dynamicLookups;
  const diagnostics = repository.diagnostics;
  const overview = appendLocalViewerResult(
    viewerRepository,
    "repository-" + String(repositoryIndex + 1) + "-overview",
    "Overview",
    dispositionForState(state),
    summaryForState(state),
  );
  appendFact(overview, "State", state, toneForState(state));
  appendFact(overview, "References", String(groups?.length ?? 0));
  appendFact(overview, "Dynamic lookups", String(dynamicLookups?.length ?? 0));
  appendFact(
    overview,
    "Diagnostics",
    String(diagnostics.length),
    diagnostics.length > 0 ? "warning" : "neutral",
  );

  if (groups !== undefined) {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      if (group === undefined) {
        throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
      }
      const result = appendLocalViewerResult(
        viewerRepository,
        "repository-" + String(repositoryIndex + 1) + "-key-" + String(groupIndex + 1),
        keyLabel(group.key.namespace, group.key.name, groupIndex),
        worstDisposition(group.uses),
        group.shared
          ? "This reference is shared by multiple consumers."
          : "This reference has one known consumer group.",
      );
      appendFact(result, "Consumers", String(group.consumers.length));
      appendFact(result, "Source occurrences", String(group.sources.length));
      appendFact(result, "Findings", String(group.uses.length));
    }
  }

  if (dynamicLookups !== undefined) {
    for (let lookupIndex = 0; lookupIndex < dynamicLookups.length; lookupIndex += 1) {
      const lookup = dynamicLookups[lookupIndex];
      if (lookup === undefined) {
        throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
      }
      const result = appendLocalViewerResult(
        viewerRepository,
        "repository-" + String(repositoryIndex + 1) + "-dynamic-" + String(lookupIndex + 1),
        dynamicLabel(lookup.domain.kind),
        safeDisposition(lookup.disposition),
        lookup.domain.kind === "unbounded"
          ? "No environment key name is inferred for this lookup."
          : "Likely keys are derived from bounded static evidence.",
      );
      appendFact(result, "Origin", safeOrigin(lookup.origin));
      appendFact(result, "Likely keys", String(lookup.likelyKeys.length));
      appendFact(
        result,
        "Coverage",
        safeCoverage(lookup.coverage),
        lookup.coverage === "incomplete" ? "warning" : "neutral",
      );
    }
  }
}

function appendDeploymentResult(
  repository: LocalViewerRepositorySlot,
  deployment: WorkspaceJsonReport["deployments"][number],
  deploymentIndex: number,
): void {
  const state = safeState(deployment.state);
  const result = appendLocalViewerResult(
    repository,
    "deployment-" + String(deploymentIndex + 1),
    safeDisplayIdentifier(deployment.id, "deployment-" + String(deploymentIndex + 1)),
    dispositionForState(state),
    "Explicit deployment aggregation only.",
  );
  appendFact(result, "State", state, toneForState(state));
  appendFact(result, "Repositories", String(deployment.repositoryIds.length));
  appendFact(result, "Shared keys", String(deployment.sharedKeys.length));
  appendFact(
    result,
    "Diagnostics",
    String(deployment.diagnostics.length),
    deployment.diagnostics.length > 0 ? "warning" : "neutral",
  );

  for (let memberIndex = 0; memberIndex < deployment.members.length; memberIndex += 1) {
    const member = deployment.members[memberIndex];
    if (member === undefined) {
      throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
    }
    appendDeploymentMemberResult(repository, deploymentIndex, member, memberIndex);
  }
}

function appendDeploymentMemberResult(
  repository: LocalViewerRepositorySlot,
  deploymentIndex: number,
  member: WorkspaceJsonReport["deployments"][number]["members"][number],
  memberIndex: number,
): void {
  const state = safeState(member.state);
  const report = member.report;
  const result = appendLocalViewerResult(
    repository,
    "deployment-" + String(deploymentIndex + 1) + "-member-" + String(memberIndex + 1),
    "member-" + safeDisplayIdentifier(member.repositoryId, "member-" + String(memberIndex + 1)),
    dispositionForState(state),
    "Explicit deployment aggregation only.",
  );
  appendFact(result, "State", state, toneForState(state));
  appendFact(result, "References", String(report?.groups.length ?? 0));
  appendFact(result, "Dynamic lookups", String(report?.dynamicLookups.length ?? 0));
  appendFact(
    result,
    "Diagnostics",
    String(member.diagnostics.length),
    member.diagnostics.length > 0 ? "warning" : "neutral",
  );
}

function appendFact(
  result: LocalViewerResultSlot,
  label: string,
  value: string,
  tone: ViewerFactTone = "neutral",
): void {
  appendLocalViewerFact(result, label, value, tone);
}

function safeDisplayIdentifier(value: unknown, fallback: string): string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) &&
    !containsSecretLikeToken(value)
  )
    ? value
    : fallback;
}

function keyLabel(namespace: unknown, name: unknown, index: number): string {
  const safeNamespace =
    namespace === "env" || namespace === "config" || namespace === "secret-manager"
      ? namespace
      : "env";
  return safeNamespace + ":" + safeDisplayIdentifier(name, "opaque-" + String(index + 1));
}

function dynamicLabel(kind: unknown): string {
  switch (kind) {
    case "finite":
      return "Dynamic: finite environment-key set";
    case "pattern":
      return "Dynamic: bounded environment lookup";
    default:
      return "Dynamic: unbounded environment lookup";
  }
}

function safeState(value: unknown): "complete" | "incomplete" | "invalid" {
  return value === "complete" || value === "incomplete" || value === "invalid"
    ? value
    : "invalid";
}

function safeDisposition(value: unknown): ViewerDisposition {
  return value === "informational" || value === "review" || value === "inconclusive"
    ? value
    : "inconclusive";
}

function safeOrigin(value: unknown): "lexical" | "user-controlled" | "opaque" {
  return value === "lexical" || value === "user-controlled" || value === "opaque"
    ? value
    : "opaque";
}

function safeCoverage(value: unknown): "complete" | "incomplete" {
  return value === "complete" || value === "incomplete" ? value : "incomplete";
}

function dispositionForState(
  state: "complete" | "incomplete" | "invalid",
): ViewerDisposition {
  return state === "complete" ? "informational" : "inconclusive";
}

function toneForState(
  state: "complete" | "incomplete" | "invalid",
): ViewerFactTone {
  return state === "complete" ? "positive" : "warning";
}

function summaryForState(
  state: "complete" | "incomplete" | "invalid",
): string {
  switch (state) {
    case "complete":
      return "This repository finished with complete scoped coverage.";
    case "incomplete":
      return "This repository has scoped uncertainty that needs review.";
    case "invalid":
      return "This repository result could not be validated.";
  }
}

function worstDisposition(
  uses: readonly { readonly disposition: ViewerDisposition }[],
): ViewerDisposition {
  let sawReview = false;
  for (let index = 0; index < uses.length; index += 1) {
    const use = uses[index];
    if (use === undefined || use.disposition === "inconclusive") {
      return "inconclusive";
    }
    if (use.disposition === "review") {
      sawReview = true;
    }
  }
  return sawReview ? "review" : "informational";
}

function containsSecretLikeToken(text: string): boolean {
  const candidates = text.match(/[A-Za-z0-9._:@/-]+/gu) ?? [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    if (candidate !== undefined && isSecretLikeToken(candidate)) {
      return true;
    }
    if (candidate === undefined) {
      continue;
    }
    for (let index = 1; index < candidate.length; index += 1) {
      if (
        /[._:@/-]/u.test(candidate[index - 1] ?? "") &&
        isSecretLikeToken(candidate.slice(index))
      ) {
        return true;
      }
    }
  }
  return false;
}
