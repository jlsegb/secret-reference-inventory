import {
  SafeFactFactory,
  isSafeDisplaySegment,
} from "../safety/index.js";
import type { SafeIdentifier } from "../safety/types.js";
import type {
  DeliveryChannel,
  ExecutionScope,
  Phase,
  StagePredicate,
} from "../core/index.js";

import {
  MAX_WORKSPACE_DEPLOYMENTS,
  MAX_WORKSPACE_DEPLOYMENT_MEMBERS,
  MAX_WORKSPACE_REPOSITORIES,
  MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  type ManifestRelativeDescriptor,
  type WorkspaceDeployment,
  type WorkspaceDeploymentInputs,
  type WorkspaceDeploymentMemberScope,
  type WorkspaceManifest,
  type WorkspaceManifestDiagnostic,
  type WorkspaceManifestDiagnosticCode,
  type WorkspaceManifestParseResult,
  type WorkspaceManifestPath,
  type WorkspaceRelativePath,
  type WorkspaceRepository,
} from "./contracts.js";
import { issueWorkspaceManifestToken } from "./manifest-token.js";

const MAX_MANIFEST_TEXT_LENGTH = 1024 * 1024;
const MAX_RELATIVE_PATH_LENGTH = 1024;

const TOP_LEVEL_FIELDS = ["schemaVersion", "repositories", "deployments"] as const;
const REPOSITORY_FIELDS = ["id", "root"] as const;
const DEPLOYMENT_FIELDS = ["id", "repositories", "inputs"] as const;
const DEPLOYMENT_INPUT_FIELDS = ["bindings", "inventory", "closedModel", "memberScopes"] as const;
const MEMBER_SCOPE_FIELDS = ["repositoryId", "scope"] as const;
const MEMBER_EXECUTION_SCOPE_FIELDS = ["id", "componentId", "phase", "stage", "channel"] as const;
const MEMBER_STAGE_FIELDS = ["kind", "values"] as const;
const MAX_MEMBER_SCOPE_STAGE_VALUES = 128;
const MEMBER_SCOPE_PHASES = new Set<Phase>([
  "runtime",
  "build",
  "test",
  "dev",
  "ci",
]);
const MEMBER_SCOPE_CHANNELS = new Set<DeliveryChannel>([
  "environment",
  "build-substitution",
  "mounted-file",
  "provider-sdk",
]);

type JsonRecord = Record<string, unknown>;

interface ParseState {
  readonly diagnostics: WorkspaceManifestDiagnostic[];
  totalDeploymentMembers: number;
}

interface RepositoryRootIndexNode {
  terminal: boolean;
  readonly children: Map<string, RepositoryRootIndexNode>;
}

interface MemberScopeOverlapBucket {
  allStages: boolean;
  readonly exactStages: Set<SafeIdentifier>;
}

type ParsedInputs =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly value: WorkspaceDeploymentInputs };

type InternalWorkspaceManifestParseResult =
  | {
      readonly ok: true;
      readonly value: WorkspaceManifest;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly WorkspaceManifestDiagnostic[];
    };

const NO_DIAGNOSTICS = Object.freeze([]) as readonly [];

/**
 * Validates a JSON-decoded workspace manifest value into immutable v2 declarations and safe diagnostics.
 *
 * Inputs: A plain JSON value plus a SafeFactFactory for identifier materialization.
 * Outputs: A frozen v2 manifest with no diagnostics, or a frozen diagnostic failure for invalid fields, membership, paths, scopes, or limits.
 * Does not handle: Arbitrary JavaScript records/proxies, filesystem resolution, provisioning-file parsing, or partial successful manifests.
 * Side effects: Allocates repository/deployment arrays, sets, a root trie, and diagnostic records; it does not perform I/O.
 */
function parseTrustedWorkspaceManifestValue(
  input: unknown,
  safety = new SafeFactFactory(),
): InternalWorkspaceManifestParseResult {
  const state: ParseState = { diagnostics: [], totalDeploymentMembers: 0 };
  const root = asTrustedJsonRecord(input);
  if (root === undefined) {
    diagnostic(state, "invalid-input-shape", []);
    return failure(state);
  }

  const rootFieldsValid = validateObjectFields(
    root,
    TOP_LEVEL_FIELDS,
    TOP_LEVEL_FIELDS,
    [],
    state,
  );
  const schemaVersion = readString(root, "schemaVersion", ["schemaVersion"], state);
  const legacyV1 = schemaVersion === "workspace-manifest/v1";
  if (!rootFieldsValid || schemaVersion === undefined || (!legacyV1 && schemaVersion !== WORKSPACE_MANIFEST_SCHEMA_VERSION)) {
    if (schemaVersion !== undefined && !legacyV1 && schemaVersion !== WORKSPACE_MANIFEST_SCHEMA_VERSION) {
      diagnostic(state, "invalid-schema-version", ["schemaVersion"]);
    }
    return failure(state);
  }

  const rawRepositories = readBoundedArray(
    root,
    "repositories",
    ["repositories"],
    state,
    MAX_WORKSPACE_REPOSITORIES,
    "too-many-repositories",
  );
  const rawDeployments = readBoundedArray(
    root,
    "deployments",
    ["deployments"],
    state,
    MAX_WORKSPACE_DEPLOYMENTS,
    "too-many-deployments",
  );
  if (rawRepositories === undefined || rawDeployments === undefined) {
    return failure(state);
  }
  if (rawRepositories.length === 0) {
    diagnostic(state, "empty-repositories", ["repositories"]);
    return failure(state);
  }
  const repositories: WorkspaceRepository[] = [];
  const repositoryIds = new Set<string>();
  const rootIndex = createRepositoryRootIndex();
  for (let index = 0; index < rawRepositories.length; index += 1) {
    const rawRepository = rawRepositories[index];
    const path: WorkspaceManifestPath = ["repositories", index];
    const repository = parseRepository(rawRepository, path, safety, state);
    if (repository === undefined) {
      continue;
    }

    if (repositoryIds.has(repository.id)) {
      diagnostic(state, "duplicate-repository-id", [...path, "id"]);
      continue;
    }
    const rootConflict = findRootConflict(rootIndex, repository.root);
    if (rootConflict !== undefined) {
      diagnostic(state, rootConflict, [...path, "root"]);
      continue;
    }

    repositoryIds.add(repository.id);
    addRepositoryRoot(rootIndex, repository.root);
    repositories.push(repository);
  }

  const deployments: WorkspaceDeployment[] = [];
  const deploymentIds = new Set<string>();
  for (let index = 0; index < rawDeployments.length; index += 1) {
    const rawDeployment = rawDeployments[index];
    const path: WorkspaceManifestPath = ["deployments", index];
    if (legacyV1) {
      const legacyRecord = asTrustedJsonRecord(rawDeployment);
      if (legacyRecord !== undefined && hasOwn(legacyRecord, "inputs")) {
        diagnostic(state, "legacy-provisioning-requires-v2", [...path, "inputs"]);
        continue;
      }
    }
    const deployment = parseDeployment(rawDeployment, path, repositoryIds, safety, state);
    if (deployment === undefined) {
      continue;
    }
    if (deploymentIds.has(deployment.id)) {
      diagnostic(state, "duplicate-deployment-id", [...path, "id"]);
      continue;
    }
    deploymentIds.add(deployment.id);
    deployments.push(deployment);
  }

  if (state.diagnostics.length > 0) {
    return failure(state);
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
      repositories: Object.freeze(repositories),
      deployments: Object.freeze(deployments),
    }),
    diagnostics: NO_DIAGNOSTICS,
  };
}

/**
 * Parses bounded JSON or JSONC manifest text and issues an opaque manifest capability only after full validation.
 *
 * Inputs: Manifest text no longer than one MiB.
 * Outputs: An issued v2 manifest token with no diagnostics, or a fixed invalid-json/validation diagnostic result without parse-error text.
 * Does not handle: Arbitrary object-form input, files, JSONC escape repair, provisioning documents, or error-location/source excerpts.
 * Side effects: Allocates normalized text/JSON structures and stores a successful manifest in the private token registry.
 */
export function parseWorkspaceManifestText(
  text: string,
): WorkspaceManifestParseResult {
  if (typeof text !== "string" || text.length > MAX_MANIFEST_TEXT_LENGTH) {
    return fixedFailure("invalid-json", []);
  }

  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const commentFree = stripJsonComments(normalized);
  if (commentFree === undefined) {
    return fixedFailure("invalid-json", []);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(commentFree));
  } catch {
    return fixedFailure("invalid-json", []);
  }
  try {
    const result = parseTrustedWorkspaceManifestValue(parsed);
    if (result.ok === false) {
      return result;
    }
    return {
      ok: true,
      value: issueWorkspaceManifestToken(result.value),
      diagnostics: NO_DIAGNOSTICS,
    };
  } catch {
    return fixedFailure("invalid-json", []);
  }
}

/**
 * Parses one repository declaration and rejects unsafe IDs, malformed fields, or unsafe relative roots.
 *
 * Inputs: One JSON repository value, its diagnostic path, the safety factory, and shared parse state.
 * Outputs: A frozen repository declaration, or undefined after recording concrete shape/field/identifier/path diagnostics.
 * Does not handle: Filesystem root existence, canonical aliases, or duplicate/cross-root checks.
 * Side effects: Appends diagnostics to parse state and allocates a frozen declaration on success.
 */
function parseRepository(
  input: unknown,
  path: WorkspaceManifestPath,
  safety: SafeFactFactory,
  state: ParseState,
): WorkspaceRepository | undefined {
  const record = asTrustedJsonRecord(input);
  if (record === undefined) {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  const fieldsValid = validateObjectFields(
    record,
    REPOSITORY_FIELDS,
    REPOSITORY_FIELDS,
    path,
    state,
  );

  const rawId = readString(record, "id", [...path, "id"], state);
  const id = materializeIdentifier(rawId, safety);
  if (rawId !== undefined && id === undefined) {
    diagnostic(state, "unsafe-repository-id", [...path, "id"]);
  }
  const root = parseDescriptor(
    readString(record, "root", [...path, "root"], state),
    true,
    [...path, "root"],
    state,
  );

  return !fieldsValid || id === undefined || root === undefined
    ? undefined
    : Object.freeze({ id, root });
}

/**
 * Parses one deployment declaration and its optional v2 provisioning input relation.
 *
 * Inputs: One JSON deployment value, diagnostic path, declared repository IDs, safety factory, and parse state.
 * Outputs: A frozen deployment, or undefined after subordinate membership/input validation records diagnostics.
 * Does not handle: Duplicate deployment IDs, filesystem reads, provisioning schema validation, or reconciliation.
 * Side effects: Updates shared deployment-member accounting through subordinate parsing and appends diagnostics.
 */
function parseDeployment(
  input: unknown,
  path: WorkspaceManifestPath,
  repositoryIds: ReadonlySet<string>,
  safety: SafeFactFactory,
  state: ParseState,
): WorkspaceDeployment | undefined {
  const record = asTrustedJsonRecord(input);
  if (record === undefined) {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  const fieldsValid = validateObjectFields(
    record,
    DEPLOYMENT_FIELDS,
    ["id", "repositories"],
    path,
    state,
  );

  const rawId = readString(record, "id", [...path, "id"], state);
  const id = materializeIdentifier(rawId, safety);
  if (rawId !== undefined && id === undefined) {
    diagnostic(state, "unsafe-deployment-id", [...path, "id"]);
  }

  const repositories = parseDeploymentMembers(
    readBoundedArray(
      record,
      "repositories",
      [...path, "repositories"],
      state,
      MAX_WORKSPACE_DEPLOYMENT_MEMBERS,
      "too-many-deployment-members",
    ),
    [...path, "repositories"],
    repositoryIds,
    safety,
    state,
  );
  const inputs = parseDeploymentInputs(
    readOwn(record, "inputs"),
    hasOwn(record, "inputs"),
    [...path, "inputs"],
    repositories,
    safety,
    state,
  );

  if (
    !fieldsValid ||
    id === undefined ||
    repositories === undefined ||
    inputs.kind === "invalid"
  ) {
    return undefined;
  }

  return Object.freeze({
    id,
    repositories: Object.freeze(repositories),
    ...(inputs.kind === "present" ? { inputs: inputs.value } : {}),
  });
}

/**
 * Validates a nonempty, unique deployment membership list against already declared repositories and global cardinality limits.
 *
 * Inputs: A bounded JSON array, its diagnostic path, declared repository IDs, safety factory, and parse state.
 * Outputs: Safe member IDs in input order, or undefined when any member is unsafe, duplicate, undeclared, empty, or over budget.
 * Does not handle: Repository-root resolution, member execution scopes, or rollback of the cumulative member counter after a later invalid entry.
 * Side effects: Increments parseState.totalDeploymentMembers once after local array-size admission and appends diagnostics.
 */
function parseDeploymentMembers(
  input: readonly unknown[] | undefined,
  path: WorkspaceManifestPath,
  repositoryIds: ReadonlySet<string>,
  safety: SafeFactFactory,
  state: ParseState,
): SafeIdentifier[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input.length === 0) {
    diagnostic(state, "empty-deployment-membership", path);
    return undefined;
  }
  if (state.totalDeploymentMembers + input.length > MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS) {
    diagnostic(state, "too-many-total-deployment-members", path);
    return undefined;
  }
  state.totalDeploymentMembers += input.length;

  const members: SafeIdentifier[] = [];
  const seen = new Set<string>();
  let valid = true;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    const memberPath: WorkspaceManifestPath = [...path, index];
    const member = materializeIdentifier(value, safety);
    if (member === undefined) {
      diagnostic(state, "unsafe-deployment-member", memberPath);
      valid = false;
      continue;
    }
    if (seen.has(member)) {
      diagnostic(state, "duplicate-deployment-member", memberPath);
      valid = false;
      continue;
    }
    if (!repositoryIds.has(member)) {
      diagnostic(state, "undeclared-deployment-member", memberPath);
      valid = false;
      continue;
    }
    seen.add(member);
    members.push(member);
  }
  return valid ? members : undefined;
}

/**
 * Validates the all-or-nothing provisioning-input declaration and its explicit per-member execution scopes.
 *
 * Inputs: The raw inputs value/presence bit, diagnostic path, parsed deployment members, safety factory, and parse state.
 * Outputs: An absent marker, a frozen bindings/inventory/optional closed-model input relation, or an invalid marker.
 * Does not handle: Reading descriptors, proving provider delivery, implicit scopes, or legacy v1 provisioning declarations.
 * Side effects: Appends invalid-deployment-inputs and subordinate descriptor/scope diagnostics to shared state.
 */
function parseDeploymentInputs(
  input: unknown,
  present: boolean,
  path: WorkspaceManifestPath,
  deploymentRepositories: readonly SafeIdentifier[] | undefined,
  safety: SafeFactFactory,
  state: ParseState,
): ParsedInputs {
  if (!present) {
    return { kind: "absent" };
  }
  const record = asTrustedJsonRecord(input);
  if (record === undefined) {
    diagnostic(state, "invalid-deployment-inputs", path);
    return { kind: "invalid" };
  }
  const fieldsValid = validateObjectFields(record, DEPLOYMENT_INPUT_FIELDS, [], path, state);

  const hasBindings = hasOwn(record, "bindings");
  const hasInventory = hasOwn(record, "inventory");
  const hasClosedModel = hasOwn(record, "closedModel");
  const hasMemberScopes = hasOwn(record, "memberScopes");
  if (
    !fieldsValid ||
    hasBindings !== hasInventory ||
    !hasMemberScopes ||
    (!hasBindings && hasClosedModel) ||
    (!hasBindings && !hasInventory && !hasClosedModel && !hasMemberScopes)
  ) {
    diagnostic(state, "invalid-deployment-inputs", path);
    return { kind: "invalid" };
  }

  const bindings = parseDescriptor(
    readString(record, "bindings", [...path, "bindings"], state),
    false,
    [...path, "bindings"],
    state,
  );
  const inventory = parseDescriptor(
    readString(record, "inventory", [...path, "inventory"], state),
    false,
    [...path, "inventory"],
    state,
  );
  const closedModel = hasClosedModel
    ? parseDescriptor(
        readString(record, "closedModel", [...path, "closedModel"], state),
        false,
        [...path, "closedModel"],
        state,
      )
    : undefined;
  const memberScopes = parseDeploymentMemberScopes(
    readOwn(record, "memberScopes"),
    [...path, "memberScopes"],
    deploymentRepositories,
    safety,
    state,
  );

  if (
    bindings === undefined ||
    inventory === undefined ||
    (hasClosedModel && closedModel === undefined) ||
    memberScopes === undefined
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "present",
    value: Object.freeze({
      bindings,
      inventory,
      ...(closedModel === undefined ? {} : { closedModel }),
      memberScopes,
    }),
  };
}

/**
 * Validates a one-to-one repository-to-scope mapping and rejects overlapping execution scopes within a deployment.
 *
 * Inputs: The raw scope array, diagnostic path, parsed deployment repository IDs, safety factory, and parse state.
 * Outputs: Frozen scopes ordered by deployment membership, or undefined after invalid/duplicate/undeclared/overlapping scope diagnostics.
 * Does not handle: Runtime scheduling, cross-deployment scope relationships, or unknown-stage overlap proof beyond conservative rejection.
 * Side effects: Allocates expected/by-repository/overlap Map and Set indexes and appends diagnostics.
 */
function parseDeploymentMemberScopes(
  input: unknown,
  path: WorkspaceManifestPath,
  deploymentRepositories: readonly SafeIdentifier[] | undefined,
  safety: SafeFactFactory,
  state: ParseState,
): readonly WorkspaceDeploymentMemberScope[] | undefined {
  if (!Array.isArray(input) || deploymentRepositories === undefined) {
    diagnostic(state, "invalid-member-scopes", path);
    return undefined;
  }
  if (
    input.length !== deploymentRepositories.length ||
    input.length > MAX_WORKSPACE_DEPLOYMENT_MEMBERS
  ) {
    diagnostic(state, "invalid-member-scopes", path);
    return undefined;
  }

  const expected = new Set(deploymentRepositories);
  const byRepository = new Map<SafeIdentifier, WorkspaceDeploymentMemberScope>();
  const scopeOverlapIndex = new Map<string, MemberScopeOverlapBucket>();
  let valid = true;
  for (let index = 0; index < input.length; index += 1) {
    const itemPath: WorkspaceManifestPath = [...path, index];
    const record = asTrustedJsonRecord(input[index]);
    if (
      record === undefined ||
      !validateObjectFields(record, MEMBER_SCOPE_FIELDS, MEMBER_SCOPE_FIELDS, itemPath, state)
    ) {
      diagnostic(state, "invalid-member-scopes", itemPath);
      valid = false;
      continue;
    }

    const repositoryId = materializeIdentifier(readOwn(record, "repositoryId"), safety);
    if (repositoryId === undefined) {
      diagnostic(state, "unsafe-member-scope", [...itemPath, "repositoryId"]);
      valid = false;
      continue;
    }
    if (!expected.has(repositoryId)) {
      diagnostic(state, "undeclared-member-scope", [...itemPath, "repositoryId"]);
      valid = false;
      continue;
    }
    if (byRepository.has(repositoryId)) {
      diagnostic(state, "duplicate-member-scope", [...itemPath, "repositoryId"]);
      valid = false;
      continue;
    }

    const scope = parseMemberExecutionScope(
      readOwn(record, "scope"),
      [...itemPath, "scope"],
      safety,
      state,
    );
    if (scope === undefined) {
      valid = false;
      continue;
    }
    if (memberScopeOverlaps(scopeOverlapIndex, scope)) {
      diagnostic(state, "overlapping-member-scope", [...itemPath, "scope"]);
      valid = false;
      continue;
    }
    addMemberScope(scopeOverlapIndex, scope);
    byRepository.set(repositoryId, Object.freeze({ repositoryId, scope }));
  }

  if (!valid || byRepository.size !== expected.size) {
    if (byRepository.size !== expected.size) {
      diagnostic(state, "invalid-member-scopes", path);
    }
    return undefined;
  }
  return Object.freeze(
    deploymentRepositories.map(
      /**
       * Restores validated member scopes to the deployment's declared repository order.
       *
       * Inputs: One already validated repository ID.
       * Outputs: Its non-undefined mapped member-scope record.
       * Does not handle: Missing-map recovery, scope validation, or new allocation beyond the outer map result.
       * Side effects: Reads the private local byRepository Map.
       */
      (repositoryId) => byRepository.get(repositoryId) as WorkspaceDeploymentMemberScope
    ),
  );
}

/**
 * Detects whether a candidate member scope overlaps an already accepted scope on ID, phase, channel, and stage.
 *
 * Inputs: The local overlap index and one validated execution scope.
 * Outputs: True for all-stage/exact-stage collision or an unknown-stage candidate in the same ID/phase/channel identity bucket; false for a missing/disjoint bucket or exact-stage set.
 * Does not handle: Cross-deployment conflicts, provider conditions, or treating an unknown stage in a matching identity bucket as safely disjoint.
 * Side effects: Reads Map/Set indexes without mutation.
 */
function memberScopeOverlaps(
  index: ReadonlyMap<string, MemberScopeOverlapBucket>,
  scope: ExecutionScope,
): boolean {
  const bucket = index.get(memberScopeOverlapKey(scope));
  if (bucket === undefined) {
    return false;
  }
  if (scope.stage.kind === "all") {
    return bucket.allStages || bucket.exactStages.size > 0;
  }
  if (scope.stage.kind === "unknown") {
    return true;
  }
  return bucket.allStages || scope.stage.values.some(
    /**
     * Checks whether one exact stage has already been admitted to the same scope-identity bucket.
     *
     * Inputs: One safe exact-stage identifier.
     * Outputs: True when the bucket's exact-stage Set contains it.
     * Does not handle: All-stage or unknown-stage decisions, which are made by the enclosing function.
     * Side effects: Reads the bucket Set without mutation.
     */
    (stage) => bucket.exactStages.has(stage)
  );
}

/**
 * Adds an accepted scope's stage coverage to the local overlap index.
 *
 * Inputs: A mutable overlap Map and an execution scope already cleared for overlap.
 * Outputs: No value; the scope identity bucket thereafter records its all/exact stages.
 * Does not handle: Unknown-stage insertion, duplicate diagnostics, or validation of the scope fields.
 * Side effects: Creates/reuses a bucket, mutates its Set/flag, and writes it to the Map.
 */
function addMemberScope(
  index: Map<string, MemberScopeOverlapBucket>,
  scope: ExecutionScope,
): void {
  const key = memberScopeOverlapKey(scope);
  const bucket = index.get(key) ?? { allStages: false, exactStages: new Set<SafeIdentifier>() };
  if (scope.stage.kind === "all") {
    bucket.allStages = true;
  } else if (scope.stage.kind === "exact") {
    for (const stage of scope.stage.values) {
      bucket.exactStages.add(stage);
    }
  }
  index.set(key, bucket);
}

/**
 * Produces the stable scope-identity key used for deployment-local overlap indexing.
 *
 * Inputs: A validated execution scope.
 * Outputs: A NUL-delimited ID/phase/channel key.
 * Does not handle: Stage identity, display formatting, or validation of strings containing unsafe values.
 * Side effects: Allocates the joined key string.
 */
function memberScopeOverlapKey(scope: ExecutionScope): string {
  return [scope.id, scope.phase, scope.channel].join("\u0000");
}

/**
 * Parses one explicit member execution scope with safe IDs, supported phase/channel, and a validated stage predicate.
 *
 * Inputs: One JSON scope value, diagnostic path, safety factory, and shared parse state.
 * Outputs: A frozen ExecutionScope, or undefined after unsafe-member-scope/field diagnostics.
 * Does not handle: Scope-overlap detection, provider delivery semantics, or runtime component existence.
 * Side effects: Appends diagnostics and allocates a frozen scope on success.
 */
function parseMemberExecutionScope(
  input: unknown,
  path: WorkspaceManifestPath,
  safety: SafeFactFactory,
  state: ParseState,
): ExecutionScope | undefined {
  const record = asTrustedJsonRecord(input);
  if (
    record === undefined ||
    !validateObjectFields(
      record,
      MEMBER_EXECUTION_SCOPE_FIELDS,
      MEMBER_EXECUTION_SCOPE_FIELDS,
      path,
      state,
    )
  ) {
    diagnostic(state, "unsafe-member-scope", path);
    return undefined;
  }

  const id = materializeIdentifier(readOwn(record, "id"), safety);
  const componentId = materializeIdentifier(readOwn(record, "componentId"), safety);
  const phase = readOwn(record, "phase");
  const channel = readOwn(record, "channel");
  const stage = parseMemberStage(readOwn(record, "stage"), [...path, "stage"], safety, state);
  if (
    id === undefined ||
    componentId === undefined ||
    typeof phase !== "string" ||
    !MEMBER_SCOPE_PHASES.has(phase as Phase) ||
    typeof channel !== "string" ||
    !MEMBER_SCOPE_CHANNELS.has(channel as DeliveryChannel) ||
    stage === undefined
  ) {
    diagnostic(state, "unsafe-member-scope", path);
    return undefined;
  }
  return Object.freeze({
    id,
    componentId,
    phase: phase as Phase,
    stage,
    channel: channel as DeliveryChannel,
  });
}

/**
 * Parses an all-stage or bounded exact-stage predicate for a member execution scope.
 *
 * Inputs: One JSON stage value, its diagnostic path, safety factory, and parse state.
 * Outputs: A frozen all/exact StagePredicate, or undefined for malformed, unsafe, duplicate, empty, or oversized stages.
 * Does not handle: Unknown-stage declarations, stage inference, or environment-specific stage resolution.
 * Side effects: Appends diagnostics, allocates normalized arrays/Sets, and sorts successful exact-stage identifiers.
 */
function parseMemberStage(
  input: unknown,
  path: WorkspaceManifestPath,
  safety: SafeFactFactory,
  state: ParseState,
): StagePredicate | undefined {
  const record = asTrustedJsonRecord(input);
  if (record === undefined || typeof readOwn(record, "kind") !== "string") {
    diagnostic(state, "unsafe-member-scope", path);
    return undefined;
  }
  const kind = readOwn(record, "kind");
  if (kind === "all") {
    if (!validateObjectFields(record, ["kind"], ["kind"], path, state)) {
      return undefined;
    }
    return Object.freeze({ kind: "all" });
  }
  if (kind !== "exact") {
    diagnostic(state, "unsafe-member-scope", path);
    return undefined;
  }
  if (!validateObjectFields(record, MEMBER_STAGE_FIELDS, MEMBER_STAGE_FIELDS, path, state)) {
    return undefined;
  }
  const values = readOwn(record, "values");
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_MEMBER_SCOPE_STAGE_VALUES) {
    diagnostic(state, "unsafe-member-scope", [...path, "values"]);
    return undefined;
  }
  const normalized: SafeIdentifier[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = materializeIdentifier(values[index], safety);
    if (value === undefined || seen.has(value)) {
      diagnostic(state, "unsafe-member-scope", [...path, "values", index]);
      return undefined;
    }
    seen.add(value);
    normalized.push(value);
  }
  normalized.sort(
    /**
     * Orders safe stage IDs deterministically before they become an immutable exact-stage predicate.
     *
     * Inputs: Two safe stage identifiers.
     * Outputs: Their locale comparison result using the host default locale behavior.
     * Does not handle: Case normalization, stage validation, or cross-platform locale equivalence guarantees.
     * Side effects: Drives in-place sorting of the enclosing normalized array.
     */
    (left, right) => left.localeCompare(right)
  );
  return Object.freeze({ kind: "exact", values: Object.freeze(normalized) });
}

/**
 * Converts one validated manifest string into a safe manifest-relative descriptor under root-use policy.
 *
 * Inputs: An optional string, whether the root marker is permitted, diagnostic path, and parse state.
 * Outputs: A frozen descriptor, or undefined for absent/unsafe/root-forbidden input.
 * Does not handle: Filesystem containment, descriptor existence, or input-document parsing.
 * Side effects: Appends unsafe-relative-path diagnostics and allocates a descriptor on success.
 */
function parseDescriptor(
  value: string | undefined,
  allowRoot: boolean,
  path: WorkspaceManifestPath,
  state: ParseState,
): ManifestRelativeDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeRelativePath(value);
  if (normalized === undefined || (!allowRoot && normalized === ".")) {
    diagnostic(state, "unsafe-relative-path", path);
    return undefined;
  }
  return Object.freeze({ kind: "manifest-relative", path: normalized });
}

/**
 * Normalizes a slash-delimited relative manifest path while rejecting absolute, control, backslash, unsafe-segment, and overlength forms.
 *
 * Inputs: One raw string path from a JSON manifest field.
 * Outputs: A canonical relative path or the root marker, or undefined for a rejected spelling.
 * Does not handle: Filesystem resolution, symlink containment, Unicode normalization, or case-insensitive path policy.
 * Side effects: Allocates a segment array and normalized joined string.
 */
function normalizeRelativePath(value: string): WorkspaceRelativePath | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0) {
      return undefined;
    }
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.at(-1) !== undefined && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    if (!isSafeDisplaySegment(segment)) {
      return undefined;
    }
    segments.push(segment);
  }

  return (segments.length === 0 ? "." : segments.join("/")) as WorkspaceRelativePath;
}

/**
 * Creates an empty segment trie used to reject duplicate and ancestor/descendant repository descriptors.
 *
 * Inputs: None.
 * Outputs: A mutable nonterminal root node with no children.
 * Does not handle: Populating, querying, or freezing the trie.
 * Side effects: Allocates one Map-backed trie node.
 */
function createRepositoryRootIndex(): RepositoryRootIndexNode {
  return { terminal: false, children: new Map() };
}

/**
 * Finds a duplicate or ambiguous prefix relationship before a repository root is inserted into the descriptor trie.
 *
 * Inputs: The current mutable root trie and one normalized manifest-relative descriptor.
 * Outputs: A duplicate/ambiguous diagnostic code, or undefined for a nonconflicting path.
 * Does not handle: Filesystem aliases, case-preserving display, or trie mutation.
 * Side effects: Reads trie Maps only.
 */
function findRootConflict(
  index: RepositoryRootIndexNode,
  root: ManifestRelativeDescriptor,
): Extract<
  WorkspaceManifestDiagnosticCode,
  "duplicate-repository-root" | "ambiguous-repository-root"
> | undefined {
  let node = index;
  const segments = rootSegments(root);

  for (const segment of segments) {
    if (node.terminal) {
      return "ambiguous-repository-root";
    }
    const child = node.children.get(segment);
    if (child === undefined) {
      return undefined;
    }
    node = child;
  }

  if (node.terminal) {
    return "duplicate-repository-root";
  }
  return node.children.size > 0 ? "ambiguous-repository-root" : undefined;
}

/**
 * Inserts a normalized repository descriptor into the segment trie after conflict checks succeed.
 *
 * Inputs: A mutable root trie and a nonconflicting normalized descriptor.
 * Outputs: No value; the descriptor endpoint becomes terminal.
 * Does not handle: Conflict detection, path normalization, or removal.
 * Side effects: Allocates missing trie nodes and mutates child Maps/terminal state.
 */
function addRepositoryRoot(
  index: RepositoryRootIndexNode,
  root: ManifestRelativeDescriptor,
): void {
  let node = index;
  for (const segment of rootSegments(root)) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = createRepositoryRootIndex();
      node.children.set(segment, child);
    }
    node = child;
  }
  node.terminal = true;
}

/**
 * Derives case-folded path segments for deterministic descriptor-trie operations.
 *
 * Inputs: A normalized manifest-relative descriptor.
 * Outputs: An empty array for root or lowercased slash segments otherwise.
 * Does not handle: Filesystem case-sensitivity detection, Unicode normalization, or path validation.
 * Side effects: Allocates split/map result arrays.
 */
function rootSegments(descriptor: ManifestRelativeDescriptor): readonly string[] {
  if (descriptor.path === ".") {
    return [];
  }
  return String(descriptor.path)
    .split("/")
    .map(
      /**
       * Case-folds one already safe descriptor segment for conservative alias conflict matching.
       *
       * Inputs: One slash-delimited normalized path segment.
       * Outputs: Its en-US lowercase representation.
       * Does not handle: Unicode normalization or filesystem-specific case rules.
       * Side effects: Allocates a lowercased string.
       */
      (segment) => segment.toLocaleLowerCase("en-US")
    );
}

/**
 * Materializes a safe display identifier without allowing arbitrary manifest strings into facts or diagnostics.
 *
 * Inputs: An unknown JSON field value and SafeFactFactory.
 * Outputs: A SafeIdentifier, or undefined when the value is not a safe display segment or factory result.
 * Does not handle: Identifier coercion, secret-value redaction, or diagnostic emission.
 * Side effects: Delegates to the safety factory, which may allocate branded identifier state.
 */
function materializeIdentifier(
  value: unknown,
  safety: SafeFactFactory,
): SafeIdentifier | undefined {
  if (typeof value !== "string" || !isSafeDisplaySegment(value)) {
    return undefined;
  }
  const identifier = safety.genericIdentifier(value);
  return typeof identifier === "string" ? identifier : undefined;
}

/**
 * Validates that a trusted JSON object has only allowed keys and every required key.
 *
 * Inputs: A plain JSON record, allowed/required key lists, diagnostic path, and parse state.
 * Outputs: True only when all keys satisfy both lists.
 * Does not handle: Field type validation, nested shapes, accessor objects, or duplicate JSON keys lost by JSON.parse.
 * Side effects: Allocates an allowed-key Set and appends unknown-field/missing-field diagnostics.
 */
function validateObjectFields(
  record: JsonRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: WorkspaceManifestPath,
  state: ParseState,
): boolean {
  let valid = true;
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) {
      diagnostic(state, "unknown-field", path);
      valid = false;
    }
  }
  for (const key of required) {
    if (!hasOwn(record, key)) {
      diagnostic(state, "missing-field", [...path, key]);
      valid = false;
    }
  }
  return valid;
}

/**
 * Reads one own data-property string from a trusted JSON record while emitting a typed diagnostic for wrong values.
 *
 * Inputs: A plain record, key, diagnostic path, and parse state.
 * Outputs: The string, or undefined for missing/non-string values.
 * Does not handle: Coercion, inherited/accessor properties, or required-field diagnostics.
 * Side effects: Appends invalid-string diagnostics for present non-string values.
 */
function readString(
  record: JsonRecord,
  key: string,
  path: WorkspaceManifestPath,
  state: ParseState,
): string | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = readOwn(record, key);
  if (typeof value !== "string") {
    diagnostic(state, "invalid-string", path);
    return undefined;
  }
  return value;
}

/**
 * Reads and snapshots one own data-property array under a caller-supplied cardinality limit.
 *
 * Inputs: A plain record, key/path/state, maximum length, and the applicable too-large diagnostic code.
 * Outputs: A frozen shallow array snapshot, or undefined for missing/non-array/oversized input.
 * Does not handle: Deep cloning entries, array element validation, sparse/proxy arrays, or required-field diagnostics.
 * Side effects: Iterates and allocates a snapshot; appends invalid-array or supplied too-large diagnostics.
 */
function readBoundedArray(
  record: JsonRecord,
  key: string,
  path: WorkspaceManifestPath,
  state: ParseState,
  maximumLength: number,
  tooLargeCode: Extract<
    WorkspaceManifestDiagnosticCode,
    | "too-many-repositories"
    | "too-many-deployments"
    | "too-many-deployment-members"
  >,
): readonly unknown[] | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = readOwn(record, key);
  if (!Array.isArray(value)) {
    diagnostic(state, "invalid-array", path);
    return undefined;
  }
  if (value.length > maximumLength) {
    diagnostic(state, tooLargeCode, path);
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    snapshot.push(value[index]);
  }
  return Object.freeze(snapshot);
}

/**
 * Recognizes the ordinary/null-prototype non-array records produced by trusted JSON parsing.
 *
 * Inputs: An unknown parsed JSON value.
 * Outputs: A JsonRecord view, or undefined for null, primitives, arrays, or unusual prototypes.
 * Does not handle: Arbitrary JavaScript input, accessors, proxy traps, or recursive validation.
 * Side effects: Reads the object's prototype; safe only because the caller supplies JSON.parse output.
 */
function asTrustedJsonRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as JsonRecord)
    : undefined;
}

/**
 * Tests whether a trusted JSON record has a given own property.
 *
 * Inputs: A plain JSON record and field name.
 * Outputs: True when the field is own, including an own undefined value.
 * Does not handle: Inherited properties, value reads, or arbitrary proxy safety.
 * Side effects: None.
 */
function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Reads only an own data-property value from a trusted JSON record and ignores accessors.
 *
 * Inputs: A plain JSON record and field name.
 * Outputs: The data value, or undefined when absent or implemented as an accessor.
 * Does not handle: Inherited values, invoking getters, or arbitrary Proxy safety.
 * Side effects: Reads the own property descriptor without invoking a getter.
 */
function readOwn(record: JsonRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Appends one frozen, path-copied manifest diagnostic to the current parse state.
 *
 * Inputs: Mutable parse state, a fixed diagnostic code, and a logical manifest path.
 * Outputs: No value.
 * Does not handle: Deduplication, display formatting, source excerpts, or throwing parser errors.
 * Side effects: Mutates state.diagnostics and allocates frozen diagnostic/path arrays.
 */
function diagnostic(
  state: ParseState,
  code: WorkspaceManifestDiagnosticCode,
  path: WorkspaceManifestPath,
): void {
  state.diagnostics.push(Object.freeze({ code, path: Object.freeze([...path]) }));
}

/**
 * Converts accumulated parser diagnostics into the internal immutable failure result.
 *
 * Inputs: Parse state after validation encountered one or more errors.
 * Outputs: An ok:false result with a frozen shallow diagnostic snapshot.
 * Does not handle: Adding a fallback diagnostic, clearing parse state, or public token issuance.
 * Side effects: Allocates the frozen diagnostic array.
 */
function failure(state: ParseState): InternalWorkspaceManifestParseResult {
  return {
    ok: false,
    diagnostics: Object.freeze([...state.diagnostics]),
  };
}

/**
 * Builds a one-diagnostic public parse failure for pre-parse or exception paths.
 *
 * Inputs: A fixed manifest diagnostic code and logical path.
 * Outputs: An immutable ok:false WorkspaceManifestParseResult.
 * Does not handle: Error details, multiple diagnostics, parser recovery, or source serialization.
 * Side effects: Allocates frozen diagnostic and path containers.
 */
function fixedFailure(
  code: WorkspaceManifestDiagnosticCode,
  path: WorkspaceManifestPath,
): WorkspaceManifestParseResult {
  return {
    ok: false,
    diagnostics: Object.freeze([
      Object.freeze({ code, path: Object.freeze([...path]) }),
    ]),
  };
}

/**
 * Removes line and block JSONC comments while preserving quoted-string bytes and line breaks.
 *
 * Inputs: Bounded manifest text after optional BOM removal.
 * Outputs: Comment-free JSON text, or undefined for unterminated string/block-comment state.
 * Does not handle: JSON validation, nested block comments, Unicode escapes, or trailing-comma removal.
 * Side effects: Allocates the output string while scanning every input character.
 */
function stripJsonComments(text: string): string | undefined {
  let output = "";
  let inString = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n" || character === "\r") {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (character === "\\") {
        if (index + 1 >= text.length) {
          return undefined;
        }
        output += next;
        index += 1;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    output += character;
  }

  return inString || blockComment ? undefined : output;
}

/**
 * Removes commas immediately followed by a closing JSON array/object outside quoted strings.
 *
 * Inputs: Comment-free JSONC text.
 * Outputs: JSON text with syntactic trailing commas omitted.
 * Does not handle: JSON validation, comment stripping, malformed escape recovery, or nested parser diagnostics.
 * Side effects: Allocates an output string and scans whitespace after candidate commas.
 */
function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString) {
      output += character;
      if (character === "\\") {
        output += text[index + 1] ?? "";
        index += 1;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/u.test(text[next] ?? "")) {
        next += 1;
      }
      if ((text[next] ?? "") === "}" || (text[next] ?? "") === "]") {
        continue;
      }
    }
    output += character;
  }
  return output;
}
