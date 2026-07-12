import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ExecutionScope, SafeIdentifier } from "../core/index.js";
import type { InternalPath } from "../discovery/index.js";
import { provisioningInputFitsBudget } from "../safety/provisioning-budget.js";

import type {
  ManifestRelativeDescriptor,
  WorkspaceDeployment,
  WorkspaceDeploymentInputs,
} from "./contracts.js";
import {
  issueDeploymentPreparation,
  type IssuedDeploymentPreparation,
} from "./deployment-capability.js";
import { verifyWorkspaceScanRequestContext } from "./scan-request.js";
import {
  issuedWorkspaceRepositoryMember,
  workspaceRepositoryMemberContext,
  workspaceRepositoryMembersContext,
  type IssuedWorkspaceRepositoryMember,
  type WorkspaceRepositoryMembersContext,
} from "./workspace-member-attestation.js";
import {
  MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES,
  MAX_WORKSPACE_INVOCATION_DOCUMENT_DESCRIPTOR_OBSERVATIONS,
  workspaceInvocationDeployment,
  workspaceInvocationContext,
  type IssuedWorkspaceDeploymentDeclaration,
  type IssuedWorkspaceInvocation,
  type WorkspaceDocumentCacheEntry,
  type WorkspaceInvocationContext,
} from "./workspace-invocation.js";

const MAX_ATTESTED_INPUT_BYTES = 5 * 1024 * 1024;
type NumericFileStat = Awaited<ReturnType<typeof stat>> & { readonly size: number };

type AttestedInputFailureCode =
  | "APP_LOCAL_INPUT_READ_FAILED"
  | "APP_LOCAL_INPUT_TOO_LARGE"
  | "APP_LOCAL_INPUT_INVALID_JSON"
  | "APP_LOCAL_INPUT_BUDGET_EXCEEDED"
  | "APP_LOCAL_INPUT_SNAPSHOT_CHANGED"
  | "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED";

export type AttestedJsonReadResult =
  | {
      readonly ok: true;
      readonly canonicalPath: InternalPath;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly code: AttestedInputFailureCode;
    };

export interface AttestedDeploymentMember {
  readonly repositoryId: SafeIdentifier;
  readonly scope?: ExecutionScope;
  /** Exact request-scoped pre-scan member identity, never a public analysis. */
  readonly memberHandle: IssuedWorkspaceRepositoryMember;
}

export interface DeploymentMemberAttestationContext {
  /** Private request identity that issued this deployment capability. */
  readonly request: object;
  readonly invocation: IssuedWorkspaceInvocation;
  /** Private indexed declaration identity minted with the invocation. */
  readonly declarationHandle: IssuedWorkspaceDeploymentDeclaration;
  readonly mode: "scan-only" | "provisioning";
  readonly members: readonly AttestedDeploymentMember[];
  readonly verificationBase: InternalPath;
  readonly inputs?: WorkspaceDeploymentInputs;
}

export interface DeploymentAttestationContext extends DeploymentMemberAttestationContext {
  readonly documents?: {
    readonly bindings: AttestedJsonReadResult;
    readonly inventory: AttestedJsonReadResult;
    readonly closedModel?: AttestedJsonReadResult;
    readonly verificationBase: InternalPath;
  };
}

const ATTESTATIONS = new WeakMap<object, DeploymentAttestationContext>();
const MEMBER_ATTESTATIONS = new WeakMap<object, DeploymentMemberAttestationContext>();

/**
 * First phase: derive exact deployment member handles and declarative mode
 * from an invocation-bound verified request. No deployment documents are read
 * here, so runtime can reserve source/shared-key work first.
 */
export async function attestVerifiedWorkspaceDeploymentMembers(
  invocation: unknown,
  deploymentId: unknown,
  repositoryMembers: unknown,
): Promise<IssuedDeploymentPreparation | undefined> {
  const invocationContext = workspaceInvocationContext(invocation);
  const membersContext = workspaceRepositoryMembersContext(repositoryMembers);
  if (
    invocationContext === undefined ||
    membersContext === undefined ||
    membersContext.request !== invocationContext.request ||
    typeof deploymentId !== "string"
  ) {
    return undefined;
  }
  const indexed = workspaceInvocationDeployment(invocation, deploymentId);
  if (indexed === undefined) {
    return undefined;
  }

  try {
    const members = await attestMembers(
      indexed.declaration,
      repositoryMembers,
      membersContext,
      invocationContext.request,
    );
    if (members === undefined) {
      return undefined;
    }
    const token = issueDeploymentPreparation(members.map((member) => member.repositoryId));
    if (token === undefined) {
      return undefined;
    }
    MEMBER_ATTESTATIONS.set(token, Object.freeze({
      request: invocationContext.request,
      invocation: invocation as IssuedWorkspaceInvocation,
      declarationHandle: indexed.handle,
      mode: indexed.declaration.inputs === undefined ? "scan-only" : "provisioning",
      members,
      verificationBase: invocationContext.requestContext.verifiedRead.canonicalBase,
      ...(indexed.declaration.inputs === undefined ? {} : { inputs: indexed.declaration.inputs }),
    }));
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Second phase: read parsed provisioning documents only after runtime has
 * accepted the source/shared-key preflight. Scan-only deployments attach no
 * documents and therefore perform no local-input I/O.
 */
export async function attestVerifiedWorkspaceDeploymentInputs(
  input: unknown,
): Promise<IssuedDeploymentPreparation | undefined> {
  const members = MEMBER_ATTESTATIONS.get(input as object);
  if (members === undefined) {
    return undefined;
  }
  // A scan-only capability is already complete at the member-attestation
  // phase; it has no documents to verify, read, cache, or parse.
  if (members.mode === "scan-only") {
    return input as IssuedDeploymentPreparation;
  }
  const existing = ATTESTATIONS.get(input as object);
  if (existing !== undefined) {
    return input as IssuedDeploymentPreparation;
  }
  const invocation = workspaceInvocationContext(members.invocation);
  if (
    invocation === undefined ||
    invocation.request !== members.request ||
    !(await verifyInvocationRequest(invocation))
  ) {
    return undefined;
  }
  try {
    const documents = members.inputs === undefined
      ? undefined
      : await attestDocuments(invocation, members.verificationBase, members.inputs);
    ATTESTATIONS.set(input as object, Object.freeze({
      ...members,
      ...(documents === undefined ? {} : { documents }),
    }));
    return input as IssuedDeploymentPreparation;
  } catch {
    return undefined;
  }
}

/**
 * Identity-only consumption lookup. It deliberately dereferences no caller
 * value before the private WeakMap membership check.
 */
export function deploymentAttestationContext(
  input: unknown,
): DeploymentAttestationContext | undefined {
  const full = ATTESTATIONS.get(input as object);
  if (full !== undefined) {
    return full;
  }
  const memberOnly = MEMBER_ATTESTATIONS.get(input as object);
  return memberOnly?.mode === "scan-only" ? memberOnly : undefined;
}

/** Identity-only preflight lookup; documents are deliberately absent here. */
export function deploymentMemberAttestationContext(
  input: unknown,
): DeploymentMemberAttestationContext | undefined {
  return MEMBER_ATTESTATIONS.get(input as object);
}

async function attestMembers(
  deployment: WorkspaceDeployment,
  repositoryMembers: unknown,
  membersContext: WorkspaceRepositoryMembersContext,
  request: object,
): Promise<readonly AttestedDeploymentMember[] | undefined> {
  const scopes = deployment.inputs === undefined
    ? undefined
    : new Map(deployment.inputs.memberScopes.map((member) => [member.repositoryId, member]));
  if (scopes !== undefined && scopes.size !== deployment.repositories.length) {
    return undefined;
  }

  const repositoryIds = new Set<SafeIdentifier>();
  const members: AttestedDeploymentMember[] = [];
  for (const repositoryId of deployment.repositories) {
    const memberScope = scopes?.get(repositoryId);
    const memberHandle = issuedWorkspaceRepositoryMember(repositoryMembers, repositoryId);
    const memberContext = workspaceRepositoryMemberContext(memberHandle);
    if (
      (scopes !== undefined && memberScope === undefined) ||
      memberHandle === undefined ||
      memberContext === undefined ||
      memberContext.request !== request ||
      memberContext.request !== membersContext.request ||
      memberContext.repositoryId !== repositoryId ||
      repositoryIds.has(repositoryId)
    ) {
      return undefined;
    }
    repositoryIds.add(repositoryId);
    members.push(Object.freeze({
      repositoryId,
      ...(memberScope === undefined ? {} : { scope: snapshotScope(memberScope.scope) }),
      memberHandle,
    }));
  }
  return Object.freeze(members);
}

async function attestDocuments(
  invocation: WorkspaceInvocationContext,
  manifestBase: InternalPath,
  inputs: WorkspaceDeploymentInputs,
): Promise<DeploymentAttestationContext["documents"]> {
  const [bindings, inventory, closedModel] = await Promise.all([
    readCachedAttestedJson(invocation, manifestBase, inputs.bindings),
    readCachedAttestedJson(invocation, manifestBase, inputs.inventory),
    inputs.closedModel === undefined
      ? Promise.resolve(undefined)
      : readCachedAttestedJson(invocation, manifestBase, inputs.closedModel),
  ]);
  return Object.freeze({
    bindings,
    inventory,
    ...(closedModel === undefined ? {} : { closedModel }),
    verificationBase: manifestBase,
  });
}

function verifyInvocationRequest(invocation: WorkspaceInvocationContext): Promise<boolean> {
  return verifyWorkspaceScanRequestContext(invocation.requestContext);
}

/**
 * Cache immutable checked JSON results under normalized descriptor semantics
 * and canonical file version inside one invocation. Equivalent declarations
 * share a payload and first-observed file identity; neither kind of cache hit
 * consumes input-byte budget.
 */
function readCachedAttestedJson(
  invocation: WorkspaceInvocationContext,
  manifestBase: InternalPath,
  descriptor: ManifestRelativeDescriptor,
): Promise<AttestedJsonReadResult> {
  const candidate = resolveManifestRelative(manifestBase, descriptor);
  if (candidate === undefined) {
    return Promise.resolve(failedInput());
  }
  const descriptorKey = normalizedDescriptorKey(manifestBase, candidate);
  const descriptorHit = cachedDescriptorRead(invocation, descriptorKey);
  if (descriptorHit !== undefined) {
    return descriptorHit;
  }
  return resolveAndReadCachedAttestedJson(
    invocation,
    manifestBase,
    candidate,
    descriptorKey,
  );
}

async function resolveAndReadCachedAttestedJson(
  invocation: WorkspaceInvocationContext,
  manifestBase: InternalPath,
  candidate: string,
  descriptorKey: string,
): Promise<AttestedJsonReadResult> {
  const previouslyObservedSemantic = invocation.documentDescriptorSemantics.get(descriptorKey);
  try {
    const canonicalPath = await realpath(candidate);
    const before = await stat(canonicalPath);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
      return previouslyObservedSemantic === undefined ? failedInput() : snapshotChangedInput();
    }
    const semanticKey = canonicalSemanticFileKey(manifestBase, canonicalPath);
    if (
      previouslyObservedSemantic !== undefined &&
      previouslyObservedSemantic !== semanticKey
    ) {
      return snapshotChangedInput();
    }
    const key = documentReadIdentity(canonicalPath, before);
    if (!observeSemanticFileIdentity(invocation, descriptorKey, semanticKey, key)) {
      return snapshotChangedInput();
    }
    if (before.size > MAX_ATTESTED_INPUT_BYTES) {
      return tooLargeInput();
    }
    const existing = invocation.documentReads.get(key);
    if (existing !== undefined) {
      touchDocumentRead(invocation, existing);
      cacheDescriptorRead(invocation, descriptorKey, semanticKey, existing);
      return existing.value as Promise<AttestedJsonReadResult>;
    }
    if (before.size > invocation.inputByteBudgetRemaining) {
      return inputBudgetExceeded();
    }
    // Reserve before opening/allocating. The descriptor cache is installed
    // before the checked read yields, so equal verified identities cost once.
    invocation.inputByteBudgetRemaining -= before.size;
    const pending = readAttestedJson(canonicalPath as InternalPath, before as NumericFileStat);
    cacheAttestedRead(invocation, key, semanticKey, descriptorKey, pending);
    return pending;
  } catch {
    return previouslyObservedSemantic === undefined ? failedInput() : snapshotChangedInput();
  }
}

async function readAttestedJson(
  canonicalPath: InternalPath,
  before: NumericFileStat,
): Promise<AttestedJsonReadResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonicalPath, "r");
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, offset, before.size - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > before.size - offset) {
        return failedInput();
      }
      offset += bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), stat(canonicalPath)]);
    if (!sameFileVersion(before, after) || !sameFileVersion(before, pathAfter)) {
      return failedInput();
    }
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
      if (!provisioningInputFitsBudget(parsed)) {
        return provisioningInputEntryLimitExceeded();
      }
      const value = deepFreezeJson(parsed);
      return Object.freeze({ ok: true, canonicalPath: canonicalPath as InternalPath, value });
    } catch {
      return invalidJsonInput();
    }
  } catch {
    return failedInput();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The result was already derived from a checked read; close failure is
        // not allowed to reveal platform-specific error details.
      }
    }
  }
}

function documentReadIdentity(
  canonicalPath: string,
  metadata: Awaited<ReturnType<typeof stat>>,
): string {
  return [
    canonicalPath,
    String(metadata.dev),
    String(metadata.ino),
    String(metadata.size),
    String(metadata.mtimeMs),
    String(metadata.ctimeMs),
  ].join("\u0000");
}

function cacheAttestedRead(
  invocation: WorkspaceInvocationContext,
  key: string,
  semanticKey: string,
  descriptorKey: string,
  pending: Promise<AttestedJsonReadResult>,
): void {
  if (invocation.documentReads.size >= MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES) {
    evictOldestDocumentRead(invocation);
  }
  const entry = {
    identity: key,
    semanticKey,
    value: pending as Promise<unknown>,
    lastAccess: ++invocation.documentReadClock,
  };
  invocation.documentReads.set(key, entry);
  cacheDescriptorRead(invocation, descriptorKey, semanticKey, entry);
}

function cachedDescriptorRead(
  invocation: WorkspaceInvocationContext,
  descriptorKey: string,
): Promise<AttestedJsonReadResult> | undefined {
  const alias = invocation.documentDescriptorReads.get(descriptorKey);
  if (alias === undefined) {
    return undefined;
  }
  // A descriptor alias can never outlive the bounded underlying snapshot.
  // Defend that invariant locally so a future cache implementation cannot
  // accidentally turn an evicted read into an unbounded retained value.
  if (invocation.documentReads.get(alias.entry.identity) !== alias.entry) {
    invocation.documentDescriptorReads.delete(descriptorKey);
    return undefined;
  }
  const access = ++invocation.documentReadClock;
  alias.entry.lastAccess = access;
  alias.lastAccess = access;
  return alias.entry.value as Promise<AttestedJsonReadResult>;
}

/**
 * Keep compact semantic-file observations after the parsed payload LRU evicts
 * an entry. Different declarations and normalized path aliases of the same
 * canonical file therefore cannot fabricate a mixed-time provisioning view.
 */
function observeSemanticFileIdentity(
  invocation: WorkspaceInvocationContext,
  descriptorKey: string,
  semanticKey: string,
  identity: string,
): boolean {
  const mappedSemantic = invocation.documentDescriptorSemantics.get(descriptorKey);
  if (mappedSemantic !== undefined && mappedSemantic !== semanticKey) {
    return false;
  }
  const observed = invocation.documentSemanticObservations.get(semanticKey);
  if (observed !== undefined) {
    if (observed.identity !== identity) {
      return false;
    }
    if (mappedSemantic === undefined) {
      if (
        invocation.documentDescriptorSemantics.size >=
        MAX_WORKSPACE_INVOCATION_DOCUMENT_DESCRIPTOR_OBSERVATIONS
      ) {
        return false;
      }
      invocation.documentDescriptorSemantics.set(descriptorKey, semanticKey);
    }
    return true;
  }
  if (
    invocation.documentSemanticObservations.size >=
      MAX_WORKSPACE_INVOCATION_DOCUMENT_DESCRIPTOR_OBSERVATIONS
  ) {
    // Parser schema bounds this table below the limit. If that invariant ever
    // changes, fail closed rather than evicting the only snapshot evidence.
    return false;
  }
  if (
    mappedSemantic === undefined &&
    invocation.documentDescriptorSemantics.size >=
      MAX_WORKSPACE_INVOCATION_DOCUMENT_DESCRIPTOR_OBSERVATIONS
  ) {
    return false;
  }
  invocation.documentDescriptorSemantics.set(descriptorKey, semanticKey);
  invocation.documentSemanticObservations.set(semanticKey, { identity });
  return true;
}

function touchDocumentRead(
  invocation: WorkspaceInvocationContext,
  entry: WorkspaceDocumentCacheEntry,
): void {
  entry.lastAccess = ++invocation.documentReadClock;
}

function cacheDescriptorRead(
  invocation: WorkspaceInvocationContext,
  descriptorKey: string,
  semanticKey: string,
  entry: WorkspaceDocumentCacheEntry,
): void {
  const current = invocation.documentDescriptorReads.get(descriptorKey);
  if (current !== undefined && current.entry === entry) {
    const access = ++invocation.documentReadClock;
    entry.lastAccess = access;
    current.lastAccess = access;
    return;
  }
  if (invocation.documentDescriptorReads.size >= MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES) {
    let oldestDescriptor: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [candidate, alias] of invocation.documentDescriptorReads) {
      if (alias.lastAccess < oldestAccess) {
        oldestDescriptor = candidate;
        oldestAccess = alias.lastAccess;
      }
    }
    if (oldestDescriptor !== undefined) {
      invocation.documentDescriptorReads.delete(oldestDescriptor);
    }
  }
  const access = ++invocation.documentReadClock;
  entry.lastAccess = access;
  invocation.documentDescriptorReads.set(descriptorKey, { entry, semanticKey, lastAccess: access });
}

function evictOldestDocumentRead(invocation: WorkspaceInvocationContext): void {
  let oldestKey: string | undefined;
  let oldestEntry: WorkspaceDocumentCacheEntry | undefined;
  let oldestAccess = Number.POSITIVE_INFINITY;
  for (const [candidate, entry] of invocation.documentReads) {
    if (entry.lastAccess < oldestAccess) {
      oldestKey = candidate;
      oldestEntry = entry;
      oldestAccess = entry.lastAccess;
    }
  }
  if (oldestKey === undefined || oldestEntry === undefined) {
    return;
  }
  invocation.documentReads.delete(oldestKey);
  for (const [descriptor, alias] of invocation.documentDescriptorReads) {
    if (alias.entry === oldestEntry) {
      invocation.documentDescriptorReads.delete(descriptor);
    }
  }
}

function normalizedDescriptorKey(manifestBase: string, candidate: string): string {
  return ["manifest-relative", manifestBase, candidate].join("\u0000");
}

function canonicalSemanticFileKey(manifestBase: string, canonicalPath: string): string {
  return ["manifest-relative", manifestBase, canonicalPath].join("\u0000");
}

function resolveManifestRelative(
  manifestBase: string,
  descriptor: ManifestRelativeDescriptor,
): string | undefined {
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    descriptor.kind !== "manifest-relative" ||
    typeof descriptor.path !== "string" ||
    descriptor.path.length === 0 ||
    descriptor.path.includes("\\") ||
    isAbsolute(descriptor.path)
  ) {
    return undefined;
  }
  return resolve(manifestBase, descriptor.path);
}

function snapshotScope(scope: ExecutionScope): ExecutionScope {
  const stage = scope.stage.kind === "exact"
    ? Object.freeze({ kind: "exact" as const, values: Object.freeze([...scope.stage.values]) })
    : Object.freeze({ kind: scope.stage.kind });
  return Object.freeze({
    id: scope.id,
    componentId: scope.componentId,
    phase: scope.phase,
    stage,
    channel: scope.channel,
  });
}

function deepFreezeJson(value: unknown): unknown {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push(current[index]);
      }
    } else {
      for (const key in current) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          pending.push((current as Record<string, unknown>)[key]);
        }
      }
    }
    Object.freeze(current);
  }
  return value;
}

function sameFileVersion(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function failedInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_READ_FAILED" });
}

function tooLargeInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_TOO_LARGE" });
}

function invalidJsonInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_INVALID_JSON" });
}

function inputBudgetExceeded(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_BUDGET_EXCEEDED" });
}

function snapshotChangedInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_SNAPSHOT_CHANGED" });
}

function provisioningInputEntryLimitExceeded(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED" });
}
