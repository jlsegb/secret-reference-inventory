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
 * Internal-only parser for values created by JSON.parse in
 * parseWorkspaceManifestText. Do not export an object-form parser: arbitrary
 * JavaScript records can contain proxies, accessors, and reflection traps.
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
 * Parse JSON or JSONC text without serializing parser errors. Comments and
 * trailing commas are stripped only outside quoted JSON strings.
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
    deploymentRepositories.map((repositoryId) => byRepository.get(repositoryId) as WorkspaceDeploymentMemberScope),
  );
}

/**
 * `repositoryId -> scope` is the explicit v2 association. Indexing by the
 * dimensions Core uses for scope identity makes overlap validation linear in
 * declared exact-stage values, including a 10k-member manifest.
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
  return bucket.allStages || scope.stage.values.some((stage) => bucket.exactStages.has(stage));
}

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

function memberScopeOverlapKey(scope: ExecutionScope): string {
  return [scope.id, scope.phase, scope.channel].join("\u0000");
}

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
  normalized.sort((left, right) => left.localeCompare(right));
  return Object.freeze({ kind: "exact", values: Object.freeze(normalized) });
}

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

function createRepositoryRootIndex(): RepositoryRootIndexNode {
  return { terminal: false, children: new Map() };
}

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

function rootSegments(descriptor: ManifestRelativeDescriptor): readonly string[] {
  if (descriptor.path === ".") {
    return [];
  }
  return String(descriptor.path)
    .split("/")
    .map((segment) => segment.toLocaleLowerCase("en-US"));
}

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

/** JSON.parse produces ordinary records; this helper is never public-facing. */
function asTrustedJsonRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as JsonRecord)
    : undefined;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOwn(record: JsonRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function diagnostic(
  state: ParseState,
  code: WorkspaceManifestDiagnosticCode,
  path: WorkspaceManifestPath,
): void {
  state.diagnostics.push(Object.freeze({ code, path: Object.freeze([...path]) }));
}

function failure(state: ParseState): InternalWorkspaceManifestParseResult {
  return {
    ok: false,
    diagnostics: Object.freeze([...state.diagnostics]),
  };
}

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
