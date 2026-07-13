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
 * Builds and issues the opaque local-viewer request from a workspace JSON report.
 *
 * Inputs: A workspace JSON report and optional loopback port.
 * Outputs: For a structurally usable report, an app-issued `LocalReportViewerRequest`, or `ViewerRequestError` with `VIEWER_REQUEST_INVALID` for sparse slots/builder validation, `VIEWER_PORT_INVALID` for an invalid port, or `VIEWER_REPOSITORY_LIMIT_EXCEEDED`, `VIEWER_RESULT_LIMIT_EXCEEDED`, or `VIEWER_FACT_LIMIT_EXCEEDED` for capacity overflow; malformed injected runtime shapes can instead throw a raw `TypeError` from direct property access.
 * Does not handle: Starting the HTTP listener, opening a browser, rendering HTML, or mapping construction failures to CLI diagnostics; `handleUi` maps non-limit construction failures, including raw `TypeError`, to `APP_WORKSPACE_VIEWER_FAILED`.
 * Side effects: Allocates and mutates the private viewer document builder, validates every appended scalar, then seals the builder into an opaque request.
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

/**
 * Appends one repository partition, its overview, key groups, and dynamic lookups to the private viewer builder.
 *
 * Inputs: A viewer builder, one repository report entry, and its zero-based position.
 * Outputs: `undefined`; appends a repository slot and result/fact slots, or throws `ViewerRequestError` for sparse group/lookup entries, invalid builder scalars, or repository/result/fact limits.
 * Does not handle: Deployment reports, report parsing, port validation, or listener startup.
 * Side effects: Mutates the builder and allocates viewer slot data after builder scalar validation.
 */
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

/**
 * Appends one deployment summary and all of its member summaries to the synthetic deployment repository.
 *
 * Inputs: A private viewer repository slot, deployment report entry, and its zero-based position.
 * Outputs: `undefined`; appends a deployment result and member results, or throws `ViewerRequestError` for sparse members, invalid builder scalars, or result/fact limits.
 * Does not handle: Repository overview/key rendering, cross-deployment aggregation, or port validation.
 * Side effects: Mutates the provided viewer repository slot through scalar-validating append helpers.
 */
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

/**
 * Appends one deployment member's safe status and counts to the deployment viewer repository.
 *
 * Inputs: A private repository slot, deployment/member indexes, and one member report entry.
 * Outputs: `undefined`; adds the member result with safe labels, state, and summary facts, or throws `ViewerRequestError` if builder validation or a result/fact limit rejects it.
 * Does not handle: Rendering individual references, validating deployment sibling entries, or port validation.
 * Side effects: Mutates the provided viewer repository slot through scalar-validating append helpers.
 */
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

/**
 * Appends one scalar display fact to an already-created private viewer result slot.
 *
 * Inputs: A result slot, label, scalar display value, and optional visual tone.
 * Outputs: `undefined` after forwarding the fact, or throws `ViewerRequestError` if label/value/tone validation or fact capacity rejects it.
 * Does not handle: Label/value sanitization, report traversal, slot creation, or port validation.
 * Side effects: Mutates the result slot owned by the internal viewer builder when validation succeeds.
 */
function appendFact(
  result: LocalViewerResultSlot,
  label: string,
  value: string,
  tone: ViewerFactTone = "neutral",
): void {
  appendLocalViewerFact(result, label, value, tone);
}

/**
 * Chooses a bounded non-secret identifier for a viewer label or a caller-provided opaque fallback.
 *
 * Inputs: An unknown report identifier and already-safe fallback label.
 * Outputs: The identifier only when it matches the strict display grammar and contains no secret-like token; otherwise the fallback.
 * Does not handle: Unicode labels, path display, or recovering redacted identifier content.
 * Side effects: Scans candidate token segments with the safety secret-like-token detector.
 */
function safeDisplayIdentifier(value: unknown, fallback: string): string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) &&
    !containsSecretLikeToken(value)
  )
    ? value
    : fallback;
}

/**
 * Formats one safe logical-key label with a restricted namespace and opaque fallback name.
 *
 * Inputs: Unknown namespace/name fields and the group index used in the fallback.
 * Outputs: A label such as `env:KEY` or `env:opaque-<n>`.
 * Does not handle: Arbitrary namespaces, source paths, or secret-bearing names.
 * Side effects: Validates the name via `safeDisplayIdentifier`.
 */
function keyLabel(namespace: unknown, name: unknown, index: number): string {
  const safeNamespace =
    namespace === "env" || namespace === "config" || namespace === "secret-manager"
      ? namespace
      : "env";
  return safeNamespace + ":" + safeDisplayIdentifier(name, "opaque-" + String(index + 1));
}

/**
 * Selects the static viewer label for a dynamic lookup's domain category.
 *
 * Inputs: An unknown domain-kind field.
 * Outputs: A finite, bounded-pattern, or unbounded lookup label.
 * Does not handle: Enumerating likely keys or validating full dynamic lookup records.
 * Side effects: None.
 */
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

/**
 * Normalizes unknown report state to the viewer's closed state vocabulary.
 *
 * Inputs: An unknown state field.
 * Outputs: `complete`, `incomplete`, or fail-closed `invalid`.
 * Does not handle: Future state aliases or report diagnostics.
 * Side effects: None.
 */
function safeState(value: unknown): "complete" | "incomplete" | "invalid" {
  return value === "complete" || value === "incomplete" || value === "invalid"
    ? value
    : "invalid";
}

/**
 * Normalizes unknown disposition to the viewer's safe disposition vocabulary.
 *
 * Inputs: An unknown disposition field.
 * Outputs: A known disposition or fail-closed `inconclusive`.
 * Does not handle: State-derived disposition or unknown future categories.
 * Side effects: None.
 */
function safeDisposition(value: unknown): ViewerDisposition {
  return value === "informational" || value === "review" || value === "inconclusive"
    ? value
    : "inconclusive";
}

/**
 * Normalizes unknown dynamic-lookup origin to a safe viewer vocabulary.
 *
 * Inputs: An unknown origin field.
 * Outputs: A known origin or fail-closed `opaque`.
 * Does not handle: Origin inference from code evidence.
 * Side effects: None.
 */
function safeOrigin(value: unknown): "lexical" | "user-controlled" | "opaque" {
  return value === "lexical" || value === "user-controlled" || value === "opaque"
    ? value
    : "opaque";
}

/**
 * Normalizes unknown coverage state to complete or fail-closed incomplete.
 *
 * Inputs: An unknown coverage field.
 * Outputs: `complete` only for that exact value; otherwise `incomplete` except exact `incomplete` is preserved.
 * Does not handle: Coverage-gap details or state validity.
 * Side effects: None.
 */
function safeCoverage(value: unknown): "complete" | "incomplete" {
  return value === "complete" || value === "incomplete" ? value : "incomplete";
}

/**
 * Derives a conservative viewer disposition from a normalized repository/deployment state.
 *
 * Inputs: One normalized complete, incomplete, or invalid state.
 * Outputs: `informational` for complete; `inconclusive` otherwise.
 * Does not handle: Per-reference review findings.
 * Side effects: None.
 */
function dispositionForState(
  state: "complete" | "incomplete" | "invalid",
): ViewerDisposition {
  return state === "complete" ? "informational" : "inconclusive";
}

/**
 * Derives the visual fact tone corresponding to a normalized state.
 *
 * Inputs: One normalized complete, incomplete, or invalid state.
 * Outputs: `positive` for complete and `warning` otherwise.
 * Does not handle: Per-diagnostic warning severity.
 * Side effects: None.
 */
function toneForState(
  state: "complete" | "incomplete" | "invalid",
): ViewerFactTone {
  return state === "complete" ? "positive" : "warning";
}

/**
 * Selects the explanatory summary sentence for a normalized repository state.
 *
 * Inputs: One normalized complete, incomplete, or invalid state.
 * Outputs: The matching fixed viewer summary string.
 * Does not handle: Dynamic diagnostics, localization, or deployment summaries.
 * Side effects: None.
 */
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

/**
 * Reduces a key group's findings to its most conservative viewer disposition.
 *
 * Inputs: A readonly list of result-use objects containing viewer dispositions.
 * Outputs: `inconclusive` for sparse/inconclusive entries, otherwise `review` if any entry needs review, else `informational`.
 * Does not handle: Sorting, finding explanations, or mutation of the use list.
 * Side effects: Iterates the supplied list.
 */
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

/**
 * Detects secret-like full tokens and suffixes separated by punctuation in a candidate display string.
 *
 * Inputs: One string selected for possible viewer display.
 * Outputs: `true` when any whole token or delimiter-suffix matches the safety detector.
 * Does not handle: Semantic secret validation, entropy analysis, or reporting the matched token.
 * Side effects: Allocates token-match arrays and invokes the safety detector repeatedly.
 */
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
