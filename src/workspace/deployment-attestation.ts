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
 * Issues exact request-scoped deployment member handles before any provisioning document is read.
 *
 * Inputs: An issued invocation, a string deployment ID, and the matching issued repository-member set.
 * Outputs: A deployment-preparation token, or undefined for provenance, lookup, scope, member, or capability failures.
 * Does not handle: Provisioning-file I/O, reconciliation, user-provided member identities, or partial member issuance.
 * Side effects: Looks up private indexes, creates opaque handles, and stores a member-only attestation in a WeakMap.
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
    const token = issueDeploymentPreparation(members.map(
      /**
       * Projects the validated repository identity required by the opaque deployment-capability issuer.
       *
       * Inputs: One attested deployment member.
       * Outputs: Its safe repository ID.
       * Does not handle: Scope validation or member-handle issuance.
       * Side effects: None.
       */
      (member) => member.repositoryId
    ));
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
 * Attests a provisioning deployment's declared documents once, then reuses that invocation-local attestation.
 *
 * Inputs: A preparation capability previously issued for one deployment.
 * Outputs: The same token after a scan-only fast path, a cached provisioning-attestation hit, or first full attestation; declared document read/parse/budget failures remain as AttestedJsonReadResult entries, while an unknown token, failed first-attestation provenance check, or unexpected failure returns undefined.
 * Does not handle: Source scanning, provider calls, per-document adapter interpretation, retrying a failed local read, or revalidating provenance on a cached-attestation hit.
 * Side effects: On the first provisioning attestation only, revalidates request provenance, performs bounded local I/O, caches document-result failures as well as successes, and writes the full WeakMap attestation; scan-only and cached hits return before filesystem I/O or revalidation.
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
 * Retrieves a fully usable deployment attestation, including the scan-only member-only case, by opaque identity.
 *
 * Inputs: Any preparation-token candidate.
 * Outputs: Full document context, scan-only member context, or undefined for an unissued/nonattested provisioning token.
 * Does not handle: Property inspection, request revalidation, document reads, or capability forgery.
 * Side effects: None; reads private WeakMaps only.
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

/**
 * Retrieves preflight member context without implying provisioning documents were read.
 *
 * Inputs: Any deployment-preparation token candidate.
 * Outputs: The member-only attestation context, or undefined for an unissued identity.
 * Does not handle: Document attestation, reconciliation, or a public capability view.
 * Side effects: None; reads the private member-attestation WeakMap.
 */
export function deploymentMemberAttestationContext(
  input: unknown,
): DeploymentMemberAttestationContext | undefined {
  return MEMBER_ATTESTATIONS.get(input as object);
}

/**
 * Connects one indexed deployment declaration to already attested repository handles and snapshots its explicit scopes.
 *
 * Inputs: A parser deployment, issued repository-member set/context, and the provenance request identity.
 * Outputs: Frozen attested members in declaration order, or undefined for mismatched handles, duplicate IDs, or incomplete scopes.
 * Does not handle: Filesystem document reads, source analysis, root resolution, or repair of a malformed scope map.
 * Side effects: Allocates local Map/Set/array structures and frozen member/scope snapshots.
 */
async function attestMembers(
  deployment: WorkspaceDeployment,
  repositoryMembers: unknown,
  membersContext: WorkspaceRepositoryMembersContext,
  request: object,
): Promise<readonly AttestedDeploymentMember[] | undefined> {
  const scopes = deployment.inputs === undefined
    ? undefined
    : new Map(deployment.inputs.memberScopes.map(
      /**
       * Keys one parser-authored member-scope record by its repository identity for exact lookup.
       *
       * Inputs: One validated deployment member-scope declaration.
       * Outputs: Its repository-ID/map-entry pair.
       * Does not handle: Duplicate detection or scope snapshotting.
       * Side effects: Allocates the pair array consumed by the new Map constructor.
       */
      (member) => [member.repositoryId, member]
    ));
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

/**
 * Reads the declared binding, inventory, and optional closed-model documents concurrently through invocation-local attestation caches.
 *
 * Inputs: A verified invocation context, canonical manifest base, and parser-authored provisioning descriptors.
 * Outputs: Frozen per-document read results and the same verification base.
 * Does not handle: Interpreting JSON adapter schemas, retrying failures, or scan-only deployments.
 * Side effects: Schedules up to three cached local read/parse operations and allocates a frozen document bundle.
 */
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

/**
 * Rechecks the manifest request snapshot associated with an invocation before provisioning input access.
 *
 * Inputs: An invocation context containing its trusted request context.
 * Outputs: A promise resolving true only while the manifest file/base identity still matches.
 * Does not handle: Document descriptor validation, source snapshots, or diagnostic construction.
 * Side effects: Delegates asynchronous filesystem stat I/O to request verification.
 */
function verifyInvocationRequest(invocation: WorkspaceInvocationContext): Promise<boolean> {
  return verifyWorkspaceScanRequestContext(invocation.requestContext);
}

/**
 * Resolves one manifest-relative provisioning descriptor through bounded snapshot, payload, and descriptor caches.
 *
 * Inputs: An invocation context, its canonical manifest base, and a parser-authored descriptor.
 * Outputs: A promise for checked immutable JSON or a fixed nonleaking read/budget/snapshot failure.
 * Does not handle: Arbitrary descriptor shapes, adapter parsing, cache persistence across invocations, or error-detail propagation.
 * Side effects: May resolve paths, mutate LRU/cache indexes and byte budget, and begin local filesystem I/O.
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

/**
 * Canonicalizes, stats, snapshot-checks, budget-admits, and caches a descriptor cache miss before starting its checked read.
 *
 * Inputs: Invocation context, manifest base, resolved candidate path, and normalized descriptor key.
 * Outputs: A cached/new attested read promise or fixed failed/too-large/budget/snapshot result.
 * Does not handle: JSON schema adaptation, retry policy, path disclosure, or evicted payload recovery without re-attestation.
 * Side effects: Performs realpath/stat I/O, decrements byte budget before reading, and mutates semantic/payload/descriptor cache state.
 */
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

/**
 * Reads exactly a previously statted local JSON file, verifies its post-read identity, bounds its structure, and deep-freezes success.
 *
 * Inputs: A canonical internal path and pre-open numeric file stat snapshot.
 * Outputs: Frozen JSON plus canonical path, or fixed read/invalid-json/entry-limit failure without platform details.
 * Does not handle: Streaming large files, JSON schema validation, value redaction, or retrying short/changed reads.
 * Side effects: Opens, reads, stats, and closes a file descriptor; allocates a byte buffer and freezes every parsed JSON object/array.
 */
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

/**
 * Serializes the file version attributes that uniquely key one cached attested payload within an invocation.
 *
 * Inputs: A canonical path and filesystem stat metadata.
 * Outputs: A NUL-delimited path/device/inode/size/mtime/ctime identity string.
 * Does not handle: Cross-host identity, semantic JSON equality, or display-safe formatting.
 * Side effects: Allocates strings and the joined key.
 */
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

/**
 * Inserts a pending attested read into the bounded payload LRU and attaches its descriptor alias.
 *
 * Inputs: Invocation cache context, version/semantic/descriptor keys, and pending read promise.
 * Outputs: No value; the read becomes reusable through payload and descriptor indexes.
 * Does not handle: Promise failure recovery, cross-invocation caching, or entry-limit diagnostics.
 * Side effects: May evict the oldest payload entry, increments the LRU clock, and mutates cache Maps.
 */
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

/**
 * Returns a live descriptor alias hit only while its backing payload remains in the bounded cache.
 *
 * Inputs: Invocation context and normalized descriptor key.
 * Outputs: The cached attested-read promise, or undefined for absent/stale aliases.
 * Does not handle: Restoring evicted payloads, semantic identity validation, or reading files.
 * Side effects: Deletes stale aliases or updates payload/alias LRU access timestamps.
 */
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
 * Records or verifies the first semantic-file/version identity so aliases and later declarations cannot mix snapshots after LRU eviction.
 *
 * Inputs: Invocation context plus normalized descriptor, canonical semantic-file, and version-identity keys.
 * Outputs: True when the observation is consistent and retained, false for path substitution, version change, or descriptor-observation cap.
 * Does not handle: Payload retention, filesystem re-stat, diagnostic rendering, or cache eviction of semantic observations.
 * Side effects: Mutates bounded semantic descriptor/observation Maps on accepted first observations.
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

/**
 * Marks one live payload cache entry as most recently accessed.
 *
 * Inputs: Invocation context and an entry already in its payload cache.
 * Outputs: No value.
 * Does not handle: Cache membership validation, alias updates, or eviction.
 * Side effects: Increments the invocation LRU clock and mutates entry.lastAccess.
 */
function touchDocumentRead(
  invocation: WorkspaceInvocationContext,
  entry: WorkspaceDocumentCacheEntry,
): void {
  entry.lastAccess = ++invocation.documentReadClock;
}

/**
 * Associates a normalized descriptor with a live payload entry under the bounded descriptor-alias LRU.
 *
 * Inputs: Invocation context, descriptor/semantic keys, and a live payload entry.
 * Outputs: No value; the alias is refreshed or installed.
 * Does not handle: Semantic snapshot validation, payload insertion, or durable cache persistence.
 * Side effects: May evict the least-recent descriptor alias, increments LRU clock, and mutates alias/payload timestamps and Map entries.
 */
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

/**
 * Evicts the least-recently-used payload cache entry and every descriptor alias that points to it.
 *
 * Inputs: An invocation context with zero or more live payload entries.
 * Outputs: No value.
 * Does not handle: Evicting semantic snapshot observations, cancelling an in-flight promise, or retaining aliases to evicted values.
 * Side effects: Iterates cache Maps and deletes one payload plus its matching aliases.
 */
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

/**
 * Builds the descriptor-cache key for one normalized candidate under a specific manifest base.
 *
 * Inputs: A canonical manifest-base string and resolved candidate string.
 * Outputs: A NUL-delimited manifest-relative descriptor key.
 * Does not handle: Canonicalizing the candidate, checking file existence, or redacting paths.
 * Side effects: Allocates the joined key string.
 */
function normalizedDescriptorKey(manifestBase: string, candidate: string): string {
  return ["manifest-relative", manifestBase, candidate].join("\u0000");
}

/**
 * Builds the semantic-file key shared by normalized aliases resolving to one canonical document under a manifest base.
 *
 * Inputs: A canonical manifest base and canonical local file path.
 * Outputs: A NUL-delimited semantic cache key.
 * Does not handle: File stat identity, descriptor-path normalization, or safe display serialization.
 * Side effects: Allocates the joined key string.
 */
function canonicalSemanticFileKey(manifestBase: string, canonicalPath: string): string {
  return ["manifest-relative", manifestBase, canonicalPath].join("\u0000");
}

/**
 * Resolves a defensively shape-checked parser descriptor against the attested manifest base.
 *
 * Inputs: Manifest-base string and a descriptor candidate.
 * Outputs: A resolved local candidate path, or undefined for null, wrong-kind, empty, backslash, or absolute values.
 * Does not handle: Filesystem containment, canonicalization, descriptor normalization, or error diagnostics.
 * Side effects: Allocates a resolved path string on accepted descriptors.
 */
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

/**
 * Copies an execution scope into a frozen attestation snapshot, including exact-stage array isolation.
 *
 * Inputs: A parser-authored validated execution scope.
 * Outputs: A deeply frozen scope shape suitable for a request-scoped member attestation.
 * Does not handle: Scope validation, stage overlap reasoning, or mutation tracking after the caller changes its original object.
 * Side effects: Allocates frozen stage/object/array snapshots.
 */
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

/**
 * Iteratively freezes every reachable own object and array in a parsed provisioning JSON tree.
 *
 * Inputs: A JSON.parse-produced value already admitted by the provisioning entry budget.
 * Outputs: The same root value with all reachable own JSON containers frozen.
 * Does not handle: Cycles/proxies/accessors, arbitrary JavaScript objects, JSON schema validation, or clone isolation.
 * Side effects: Allocates a traversal stack and mutates object extensibility by calling Object.freeze on each visited container.
 */
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

/**
 * Tests whether two stat snapshots describe the same regular-file identity and version.
 *
 * Inputs: Two filesystem stat results.
 * Outputs: True only when both are files with equal device, inode, size, mtime, and ctime.
 * Does not handle: Content hashing, symlink target equivalence, permissions, or cross-platform timestamp precision gaps.
 * Side effects: None.
 */
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

/**
 * Builds the fixed opaque result for local provisioning input read/identity failures.
 *
 * Inputs: None.
 * Outputs: A frozen APP_LOCAL_INPUT_READ_FAILED result.
 * Does not handle: Error detail, retry policy, or source-path disclosure.
 * Side effects: Allocates a frozen result object.
 */
function failedInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_READ_FAILED" });
}

/**
 * Builds the fixed opaque result for one provisioning document exceeding the per-document byte cap.
 *
 * Inputs: None.
 * Outputs: A frozen APP_LOCAL_INPUT_TOO_LARGE result.
 * Does not handle: Byte-budget aggregation, streaming, or path disclosure.
 * Side effects: Allocates a frozen result object.
 */
function tooLargeInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_TOO_LARGE" });
}

/**
 * Builds the fixed opaque result for invalid JSON after a checked local read.
 *
 * Inputs: None.
 * Outputs: A frozen APP_LOCAL_INPUT_INVALID_JSON result.
 * Does not handle: Parser details, JSON recovery, or source-content reporting.
 * Side effects: Allocates a frozen result object.
 */
function invalidJsonInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_INVALID_JSON" });
}

/**
 * Builds the fixed opaque result when the invocation-wide provisioning input byte budget lacks capacity.
 *
 * Inputs: None.
 * Outputs: A frozen APP_LOCAL_INPUT_BUDGET_EXCEEDED result.
 * Does not handle: Budget borrowing, document eviction, or partial read admission.
 * Side effects: Allocates a frozen result object.
 */
function inputBudgetExceeded(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_BUDGET_EXCEEDED" });
}

/**
 * Builds the fixed opaque result for descriptor alias substitution or changed first-observed file version.
 *
 * Inputs: None.
 * Outputs: A frozen APP_LOCAL_INPUT_SNAPSHOT_CHANGED result.
 * Does not handle: Reattesting a new snapshot, error detail, or path disclosure.
 * Side effects: Allocates a frozen result object.
 */
function snapshotChangedInput(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_LOCAL_INPUT_SNAPSHOT_CHANGED" });
}

/**
 * Builds the fixed opaque result for JSON that exceeds the provisioning structural entry limit.
 *
 * Inputs: None.
 * Outputs: A frozen APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED result.
 * Does not handle: Partial parser output, document-specific entry reporting, or source-content disclosure.
 * Side effects: Allocates a frozen result object.
 */
function provisioningInputEntryLimitExceeded(): AttestedJsonReadResult {
  return Object.freeze({ ok: false, code: "APP_PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED" });
}
