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
 * Builds a value-free workspace artifact from repository and deployment reporting inputs.
 *
 * Inputs: Repository and deployment reporting inputs produced by workspace orchestration.
 * Outputs: A WorkspaceJsonReport with counts, an incomplete summary flag, and collections ordered by current-runtime default-locale comparators; comparator ties retain prior input order under stable Array.sort.
 * Does not handle: Scanning repositories, reconciliation, deployment discovery, raw-value recovery, or complete runtime validation of nested reports, key entries, array contents, or user-defined property getters.
 * Side effects: Invokes report-model builders; throws WorkspaceReportError for the shallow outer-shape, state, membership, and duplicate checks it reaches, while malformed nested values or getters can instead propagate native exceptions.
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
    repositories.map(
      /**
       * Extracts a sanitized repository id for duplicate detection.
       *
       * Inputs: One normalized workspace repository report.
       * Outputs: Its report-safe identifier.
       * Does not handle: Identifier sanitization or duplicate detection itself.
       * Side effects: None.
       */
      (repository) => repository.id,
    ),
    "WORKSPACE_REPORT_DUPLICATE_REPOSITORY",
  );
  const deployments = input.deployments.map(toDeploymentReport).sort(compareById);
  assertUniqueIds(
    deployments.map(
      /**
       * Extracts a sanitized deployment id for duplicate detection.
       *
       * Inputs: One normalized workspace deployment report.
       * Outputs: Its report-safe identifier.
       * Does not handle: Identifier sanitization or duplicate detection itself.
       * Side effects: None.
       */
      (deployment) => deployment.id,
    ),
    "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT",
  );

  return {
    schemaVersion: WORKSPACE_REPORT_SCHEMA_VERSION,
    summary: {
      repositories: repositories.length,
      deployments: deployments.length,
      incomplete:
        repositories.some(
          /**
           * Detects an incomplete or invalid repository result for workspace summary state.
           *
           * Inputs: One normalized repository report.
           * Outputs: True when its state is not complete.
           * Does not handle: Repository diagnostics or nested deployment membership.
           * Side effects: None.
           */
          (repository) => repository.state !== "complete",
        ) ||
        deployments.some(
          /**
           * Detects an incomplete or invalid deployment result for workspace summary state.
           *
           * Inputs: One normalized deployment report.
           * Outputs: True when its state is not complete.
           * Does not handle: Individual member state inspection or diagnostic rendering.
           * Side effects: None.
           */
          (deployment) => deployment.state !== "complete",
        ),
    },
    repositories,
    deployments,
  };
}

/**
 * Serializes the workspace report as indented, newline-terminated JSON.
 *
 * Inputs: Workspace reporting input accepted by the workspace report builder.
 * Outputs: Pretty JSON text with a trailing newline.
 * Does not handle: File writes, streaming, or workspace orchestration.
 * Side effects: Builds and serializes an in-memory report object.
 */
export function renderWorkspaceJson(input: WorkspaceReportingInput): string {
  return JSON.stringify(buildWorkspaceJsonReport(input), null, 2) + "\n";
}

/**
 * Renders repository and deployment workspace state as a terminal summary.
 *
 * Inputs: Workspace reporting input accepted by the workspace report builder.
 * Outputs: A newline-terminated table with optional deployment and incomplete-state sections in buildWorkspaceJsonReport's current-runtime ordering.
 * Does not handle: Terminal color, stdout writes, per-repository detail rendering, source snippets, or a total cross-runtime ordering for default-locale ties.
 * Side effects: Builds an in-memory workspace report and local line array.
 */
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

/**
 * Validates and projects one repository input into its safe workspace-report entry.
 *
 * Inputs: One item from the workspace repository input list.
 * Outputs: A sanitized repository id, state, optional derived local report, and safe diagnostics.
 * Does not handle: Repository scanning, state inference, recovery of invalid nested reports, or validation of diagnostics as an array before calling safeDiagnostics.
 * Side effects: Invokes buildJsonReport and throws WorkspaceReportError only for a null/non-object input or invalid state; malformed nested report data, diagnostics, or getters can instead propagate native exceptions.
 */
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

/**
 * Validates and projects one deployment plus its repository membership into a safe report entry.
 *
 * Inputs: One workspace deployment input with ids, shared keys, diagnostics, and members.
 * Outputs: A deployment report with repository ids and members ordered by current-runtime default-locale comparators, after the one-to-one membership checks it reaches.
 * Does not handle: Deployment discovery, member report reconciliation, malformed-id recovery, validation of each nested member/key/diagnostic value, or a total ordering for comparator ties.
 * Side effects: Invokes member/key converters and throws WorkspaceReportError for checked outer shape, duplicates, or mismatches; malformed nested data or getters can instead propagate native exceptions.
 */
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
  const repositoryIds = [...rawRepositoryIds].sort(
    /**
     * Orders sanitized repository identifiers for deployment membership output.
     *
     * Inputs: Two safe or opaque repository identifier strings.
     * Outputs: Their locale comparator result.
     * Does not handle: Identifier sanitization, duplicate detection, or a total order; default-locale collation ties retain prior input order under stable Array.sort.
     * Side effects: None.
     */
    (left, right) => left.localeCompare(right),
  );
  const members = input.members.map(toDeploymentMemberReport).sort(compareByRepositoryId);
  assertUniqueIds(
    members.map(
      /**
       * Extracts a deployment member's safe repository id for duplicate detection.
       *
       * Inputs: One normalized deployment member report.
       * Outputs: Its report-safe repository identifier.
       * Does not handle: Membership alignment or identifier sanitization.
       * Side effects: None.
       */
      (member) => member.repositoryId,
    ),
    "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER",
  );
  if (
    members.length !== repositoryIds.length ||
    members.some(
      /**
       * Detects a sorted deployment member that does not match the corresponding declared repository id.
       *
       * Inputs: One sorted member and its index in the deployment member list.
       * Outputs: True when membership is not exactly aligned at that index.
       * Does not handle: Duplicate-member detection or report conversion.
       * Side effects: Reads the captured repository id array.
       */
      (member, index) => member.repositoryId !== repositoryIds[index],
    )
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

/**
 * Validates and projects one deployment-member repository result into report-safe form.
 *
 * Inputs: One member item from a workspace deployment input.
 * Outputs: A sanitized repository id, state, optional local report, and safe diagnostics.
 * Does not handle: Checking deployment membership, scanning, state inference, or complete validation of a nested report or diagnostics collection.
 * Side effects: Invokes buildJsonReport and throws WorkspaceReportError only for a null/non-object input or invalid state; malformed nested data or getters can instead propagate native exceptions.
 */
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

/**
 * Converts a shared deployment key through SafeFactFactory before report serialization.
 *
 * Inputs: One deployment shared-key namespace/name pair.
 * Outputs: A JsonLogicalKey with the input's accepted exact environment/generic spelling or an opaque name.
 * Does not handle: Structural validation of a runtime key value, validation of namespace beyond the env/generic choice, matching keys across repositories, or identifier normalization.
 * Side effects: Allocates a SafeFactFactory, which accepts an exact spelling or returns an opaque identifier; it does not normalize the supplied name.
 */
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

/**
 * Filters an already-array diagnostics collection to fixed safe code shapes and removes duplicates.
 *
 * Inputs: Arbitrary diagnostic values from workspace input.
 * Outputs: Unique safe codes sorted by current-runtime default-locale comparison, substituting UNSAFE_DIAGNOSTIC for unsafe elements; ties retain first-set insertion order under stable Array.sort.
 * Does not handle: Validating that the runtime value is an array, diagnostic message preservation, code lookup, or raw-value recovery.
 * Side effects: None.
 */
function safeDiagnostics(values: readonly unknown[]): string[] {
  return uniqueSorted(
    values.map(
      /**
       * Retains one safe diagnostic code or replaces any unsafe input with a fixed code.
       *
       * Inputs: One arbitrary diagnostic value.
       * Outputs: The safe uppercase code or UNSAFE_DIAGNOSTIC.
       * Does not handle: Message preservation, code validation against a registry, or error throwing.
       * Side effects: Evaluates the secret-like-token detector.
       */
      (value) =>
        typeof value === "string" && SAFE_DIAGNOSTIC.test(value) && !isSecretLikeToken(value)
          ? value
          : "UNSAFE_DIAGNOSTIC",
    ),
  );
}

/**
 * Rechecks an arbitrary workspace identifier before report output.
 *
 * Inputs: Any candidate identifier value.
 * Outputs: The bounded allowed identifier or the opaque marker.
 * Does not handle: Authorization, identifier normalization, or redacted-text recovery.
 * Side effects: None.
 */
function safeIdentifier(value: unknown): string {
  return typeof value === "string" &&
    SAFE_IDENTIFIER.test(value) &&
    !isSecretLikeToken(value)
    ? value
    : OPAQUE;
}

/**
 * Returns unique strings ordered by locale comparison.
 *
 * Inputs: A readonly string collection.
 * Outputs: A new array containing each distinct string once, sorted by current-runtime default-locale comparison; collation ties retain Set insertion order under stable Array.sort.
 * Does not handle: String sanitization, case folding, semantic equivalence, or a total cross-runtime ordering.
 * Side effects: None.
 */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(
    /**
     * Orders already-safe text values for report output.
     *
     * Inputs: Two strings retained after set deduplication.
     * Outputs: Their locale comparator result.
     * Does not handle: Sanitization, locale configuration, case folding, or a total order; a zero collation result retains Set insertion order under stable Array.sort.
     * Side effects: None.
     */
    (left, right) => left.localeCompare(right),
  );
}

/**
 * Deduplicates shared logical keys by namespace/name pair and orders them for output.
 *
 * Inputs: Already-sanitized JSON logical keys.
 * Outputs: One key for each composite namespace/name identity in default-locale display-key order; comparator ties retain Map insertion order under stable Array.sort.
 * Does not handle: Namespace aliases, raw key recovery, merge conflict reporting, or a total cross-runtime ordering.
 * Side effects: Mutates a local Map while retaining the last repeated key object.
 */
function uniqueSortedKeys(values: readonly JsonLogicalKey[]): JsonLogicalKey[] {
  const byKey = new Map<string, JsonLogicalKey>();
  for (const value of values) {
    byKey.set(value.namespace + "\u0000" + value.name, value);
  }
  return [...byKey.values()].sort(
    /**
     * Orders deduplicated shared keys by namespace:name display order.
     *
     * Inputs: Two safe JSON logical keys.
     * Outputs: Their composite display-key comparator result.
     * Does not handle: Raw key comparison, namespace equivalence, or a total order; a zero collation result retains Map insertion order under stable Array.sort.
     * Side effects: None.
     */
    (left, right) =>
      (left.namespace + ":" + left.name).localeCompare(right.namespace + ":" + right.name),
  );
}

/**
 * Orders any report entries exposing an id by that id.
 *
 * Inputs: Two id-bearing report values.
 * Outputs: Their current-runtime default-locale identifier comparator result.
 * Does not handle: Secondary ordering, identifier sanitization, or a full tie break; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareById<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

/**
 * Orders deployment member reports by sanitized repository identifier.
 *
 * Inputs: Two deployment member report entries.
 * Outputs: Their current-runtime default-locale repository-id comparator result.
 * Does not handle: State or report-content tie breaking; a zero result retains prior input order under stable Array.sort.
 * Side effects: None.
 */
function compareByRepositoryId(
  left: WorkspaceJsonDeploymentMemberReport,
  right: WorkspaceJsonDeploymentMemberReport,
): number {
  return left.repositoryId.localeCompare(right.repositoryId);
}

/**
 * Enforces that a report collection has no repeated safe identifiers.
 *
 * Inputs: Identifier strings and the WorkspaceReportError code to use on duplication.
 * Outputs: No value when identifiers are unique.
 * Does not handle: Identifier sanitization, ordering, or disclosure of duplicate values.
 * Side effects: Throws WorkspaceReportError when duplicate count differs from set cardinality.
 */
function assertUniqueIds(
  values: readonly string[],
  code: WorkspaceReportError["code"],
): void {
  if (new Set(values).size !== values.length) {
    throw new WorkspaceReportError(code);
  }
}

/**
 * Narrows an arbitrary value to one of the fixed workspace-report completion states.
 *
 * Inputs: Any runtime value.
 * Outputs: A type guard true for complete, incomplete, or invalid.
 * Does not handle: State transition validation or conversion from aliases.
 * Side effects: None.
 */
function isState(value: unknown): value is WorkspaceReportState {
  return value === "complete" || value === "incomplete" || value === "invalid";
}

/**
 * Right-pads a terminal cell to its requested minimum character width.
 *
 * Inputs: One string and one target width.
 * Outputs: The original string when long enough, otherwise spaces appended to reach width.
 * Does not handle: Unicode display width, truncation, or negative-width validation.
 * Side effects: None.
 */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}
