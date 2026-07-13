import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { SafeIdentifier } from "../core/index.js";
import { isSegmentDescendant, type InternalPath } from "../discovery/index.js";

import type {
  ManifestRelativeDescriptor,
  WorkspaceManifest,
  WorkspaceRepository,
} from "./contracts.js";
import { manifestForIssuedWorkspaceToken } from "./manifest-token.js";
import {
  verifyWorkspaceScanRequestContext,
  workspaceScanRequestContext,
} from "./scan-request.js";

/**
 * An opaque, request-scoped repository identity. A new verified workspace
 * request always receives new handles, even when it resolves to the same
 * local directory as an earlier request.
 */
export type IssuedWorkspaceRepositoryMember = object;
export type IssuedWorkspaceRepositoryMembers = object;

export type WorkspaceRepositoryMemberResolution =
  | { readonly ok: true; readonly canonicalRoot: InternalPath }
  | {
      readonly ok: false;
      readonly code: "unavailable" | "not-directory" | "conflict";
    };

export interface WorkspaceRepositoryMemberContext {
  readonly request: object;
  readonly repositoryId: SafeIdentifier;
  readonly resolution: WorkspaceRepositoryMemberResolution;
}

export interface WorkspaceRepositoryMembersContext {
  readonly request: object;
  readonly members: readonly WorkspaceRepositoryMemberContext[];
}

/** Internal scale instrumentation; it contains counts only, never paths. */
export interface WorkspaceRepositoryMemberAttestationMetrics {
  readonly repositoryCount: number;
  readonly rootResolutionCount: number;
  readonly rootConflictChecks: number;
}

interface MemberSet {
  readonly context: WorkspaceRepositoryMembersContext;
  readonly byRepositoryId: ReadonlyMap<SafeIdentifier, IssuedWorkspaceRepositoryMember>;
  readonly metrics: WorkspaceRepositoryMemberAttestationMetrics;
}

const MEMBER_SETS = new WeakMap<object, MemberSet>();
const MEMBERS = new WeakMap<object, WorkspaceRepositoryMemberContext>();

/**
 * Attests every parser-declared repository root and issues request-scoped opaque member identities before scanning source.
 *
 * Inputs: An issued scan request whose manifest/base identity still verifies.
 * Outputs: A member-set capability, or undefined for unissued/changed requests, absent manifests, or unexpected resolution failure.
 * Does not handle: Source discovery, re-parsing the manifest, or resolving user-supplied roots; the returned opaque member-set hides paths, but internal member contexts intentionally retain successful canonical roots for the runtime.
 * Side effects: Re-stats request provenance, concurrently realpaths/stats repository candidates, detects canonical-root conflicts, and fills private WeakMaps.
 */
export async function attestVerifiedWorkspaceRepositoryMembers(
  request: unknown,
): Promise<IssuedWorkspaceRepositoryMembers | undefined> {
  const requestContext = workspaceScanRequestContext(request);
  if (requestContext === undefined || request === null || typeof request !== "object") {
    return undefined;
  }
  if (!(await verifyWorkspaceScanRequestContext(requestContext))) {
    return undefined;
  }
  const manifest = manifestForIssuedWorkspaceToken(requestContext.manifest);
  if (manifest === undefined) {
    return undefined;
  }

  try {
    const resolved = await resolveMembers(
      manifest,
      requestContext.verifiedRead.canonicalBase,
    );
    const token = Object.freeze(Object.create(null));
    const byRepositoryId = new Map<SafeIdentifier, IssuedWorkspaceRepositoryMember>();
    const contexts: WorkspaceRepositoryMemberContext[] = [];
    for (const entry of resolved.members) {
      const handle = Object.freeze(Object.create(null));
      const context = Object.freeze({
        request: request as object,
        repositoryId: entry.repository.id,
        resolution: entry.resolution,
      });
      MEMBERS.set(handle, context);
      byRepositoryId.set(entry.repository.id, handle);
      contexts.push(context);
    }
    MEMBER_SETS.set(token, Object.freeze({
      context: Object.freeze({ request: request as object, members: Object.freeze(contexts) }),
      byRepositoryId,
      metrics: Object.freeze({
        repositoryCount: resolved.members.length,
        rootResolutionCount: resolved.members.length,
        rootConflictChecks: resolved.rootConflictChecks,
      }),
    }));
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Retrieves the request-scoped member context for an issued member-set capability.
 *
 * Inputs: Any member-set candidate.
 * Outputs: Frozen parser-ID/resolution contexts, or undefined for an unissued identity.
 * Does not handle: Handle lookup by ID, path inspection, or caller-provided member data.
 * Side effects: None; uses a private WeakMap identity lookup.
 */
export function workspaceRepositoryMembersContext(
  input: unknown,
): WorkspaceRepositoryMembersContext | undefined {
  return MEMBER_SETS.get(input as object)?.context;
}

/**
 * Retrieves one opaque repository-member handle from a member-set capability.
 *
 * Inputs: A member-set candidate and a string parser-authored repository ID.
 * Outputs: The corresponding handle, or undefined for a non-string/unknown ID or unissued set.
 * Does not handle: Reading fields from a caller object, resolving repository roots, or matching aliases.
 * Side effects: None; performs private WeakMap and Map lookups.
 */
export function issuedWorkspaceRepositoryMember(
  input: unknown,
  repositoryId: unknown,
): IssuedWorkspaceRepositoryMember | undefined {
  return typeof repositoryId === "string"
    ? MEMBER_SETS.get(input as object)?.byRepositoryId.get(repositoryId as SafeIdentifier)
    : undefined;
}

/**
 * Retrieves the private resolution context behind an issued repository-member handle.
 *
 * Inputs: Any member-handle candidate.
 * Outputs: The internal request-bound ID and resolution status (including canonicalRoot on a successful resolution), or undefined when the handle was not issued.
 * Does not handle: A public capability view, source scanning, or structural handle validation.
 * Side effects: None; performs a private WeakMap lookup.
 */
export function workspaceRepositoryMemberContext(
  input: unknown,
): WorkspaceRepositoryMemberContext | undefined {
  return MEMBERS.get(input as object);
}

/**
 * Retrieves count-only repository-attestation scale metrics for an issued member-set capability.
 *
 * Inputs: Any member-set candidate.
 * Outputs: Repository, resolution, and root-conflict-check counts, or undefined for an unissued identity.
 * Does not handle: Exposing IDs, roots, file metadata, or individual conflict decisions.
 * Side effects: None; reads the private WeakMap.
 */
export function workspaceRepositoryMemberAttestationMetrics(
  input: unknown,
): WorkspaceRepositoryMemberAttestationMetrics | undefined {
  return MEMBER_SETS.get(input as object)?.metrics;
}

interface ResolvedMember {
  readonly repository: WorkspaceRepository;
  readonly resolution: WorkspaceRepositoryMemberResolution;
}

/**
 * Resolves every manifest repository with a bounded concurrency pool before applying canonical-root conflict rules.
 *
 * Inputs: A parser-authored manifest and the already attested canonical manifest base.
 * Outputs: One resolution per declared repository plus the exact number of ancestor-stack conflict checks.
 * Does not handle: Retrying unavailable roots, source-file discovery, or suppressing conflicting repository declarations.
 * Side effects: Schedules filesystem realpath/stat work through a 32-worker bounded mapper and allocates result arrays.
 */
async function resolveMembers(
  manifest: WorkspaceManifest,
  manifestBase: InternalPath,
): Promise<{ readonly members: readonly ResolvedMember[]; readonly rootConflictChecks: number }> {
  const results = await mapLimited(
    manifest.repositories,
    32,
    /**
     * Resolves one parser-authored repository declaration for the bounded member-resolution batch.
     *
     * Inputs: One manifest repository declaration.
     * Outputs: A frozen declaration/resolution pair, including unavailable or not-directory status.
     * Does not handle: Cross-repository conflict detection or source scans.
     * Side effects: Awaits filesystem resolution/stat work for that repository.
     */
    async (repository): Promise<ResolvedMember> => Object.freeze({
      repository,
      resolution: await resolveRepositoryDirectory(manifestBase, repository.root),
    }),
  );
  return applyCanonicalRootConflicts(results);
}

/**
 * Resolves and validates one trusted manifest-relative repository directory without imposing manifest-base containment.
 *
 * Inputs: The canonical manifest base and one trusted parser-authored root descriptor, whose retained leading `..` may target a sibling/outside-base directory.
 * Outputs: A frozen canonical-root success, unavailable failure, or not-directory failure.
 * Does not handle: Relative-path normalization beyond parser validation, manifest-base containment, retries, symlink reporting, or conflict detection.
 * Side effects: Resolves a local candidate then performs filesystem realpath and stat I/O; all I/O errors collapse to unavailable.
 */
async function resolveRepositoryDirectory(
  manifestBase: InternalPath,
  descriptor: ManifestRelativeDescriptor,
): Promise<WorkspaceRepositoryMemberResolution> {
  const candidate = resolveManifestRelative(manifestBase, descriptor);
  if (candidate === undefined) {
    return Object.freeze({ ok: false, code: "unavailable" });
  }
  try {
    const canonicalRoot = await realpath(candidate);
    const metadata = await stat(canonicalRoot);
    return metadata.isDirectory()
      ? Object.freeze({ ok: true, canonicalRoot: canonicalRoot as InternalPath })
      : Object.freeze({ ok: false, code: "not-directory" });
  } catch {
    return Object.freeze({ ok: false, code: "unavailable" });
  }
}

/**
 * Marks equal or ancestor/descendant canonical roots as conflicting with a segment-ordered ancestor stack.
 *
 * Inputs: One ordered-by-declaration list of repository resolutions, including unavailable/non-directory entries.
 * Outputs: The same-order member list with conflicting valid roots replaced by conflict status and a conflict-check count.
 * Does not handle: Filesystem revalidation, raw path disclosure, duplicate parser IDs, or conflict repair.
 * Side effects: Allocates sorted/filter/map result collections and a temporary ancestor stack; it does not perform I/O.
 */
function applyCanonicalRootConflicts(
  members: readonly ResolvedMember[],
): { readonly members: readonly ResolvedMember[]; readonly rootConflictChecks: number } {
  const valid = members.map(
    /**
     * Couples each resolved member with its original declaration index for stable conflict replacement.
     *
     * Inputs: One resolved member and its source-array index.
     * Outputs: An object carrying both values.
     * Does not handle: Resolution validation or conflict detection.
     * Side effects: Allocates one transient pairing object.
     */
    (member, index) => ({ member, index })
  )
    .filter(
      /**
       * Retains only members whose directory resolution contains a canonical root.
       *
       * Inputs: One indexed member/resolution pair.
       * Outputs: A type-refined true result for successful resolutions and false otherwise.
       * Does not handle: Detecting equal or nested roots.
       * Side effects: None.
       */
      (entry): entry is {
        readonly member: ResolvedMember & {
          readonly resolution: Extract<WorkspaceRepositoryMemberResolution, { readonly ok: true }>;
        };
        readonly index: number;
      } => entry.member.resolution.ok,
    )
    .sort(
      /**
       * Orders successful roots by path segments so a parent's descendants remain adjacent.
       *
       * Inputs: Two successful indexed repository resolutions.
       * Outputs: The segment-aware lexical comparison result.
       * Does not handle: Locale ordering, filesystem case folding, or conflict marking.
       * Side effects: None.
       */
      (left, right) => compareCanonicalRoots(
      left.member.resolution.canonicalRoot,
      right.member.resolution.canonicalRoot,
      )
    );
  const conflicts = new Set<number>();
  const ancestors: Array<typeof valid[number]> = [];
  let rootConflictChecks = 0;

  for (const entry of valid) {
    const root = entry.member.resolution.canonicalRoot;
    while (ancestors.length > 0) {
      rootConflictChecks += 1;
      if (isSegmentDescendant(
        ancestors[ancestors.length - 1]!.member.resolution.canonicalRoot,
        root,
      )) {
        break;
      }
      ancestors.pop();
    }
    const ancestor = ancestors[ancestors.length - 1];
    if (ancestor !== undefined) {
      conflicts.add(ancestor.index);
      conflicts.add(entry.index);
    }
    ancestors.push(entry);
  }

  if (conflicts.size === 0) {
    return Object.freeze({ members, rootConflictChecks });
  }
  return Object.freeze({
    members: members.map(
      /**
       * Replaces only marked entries with an opaque conflict status while preserving declaration order.
       *
       * Inputs: One original member resolution and its declaration index.
       * Outputs: The original member or a frozen conflict replacement.
       * Does not handle: Explaining the conflicting root or mutating the original member.
       * Side effects: Allocates frozen replacement objects for conflicts.
       */
      (member, index) =>
        conflicts.has(index)
        ? Object.freeze({
            repository: member.repository,
            resolution: Object.freeze({ ok: false as const, code: "conflict" as const }),
          })
        : member,
    ),
    rootConflictChecks,
  });
}

/**
 * Compares canonical roots by path segments so each ancestor and subtree remains contiguous for conflict detection.
 *
 * Inputs: Two canonical local path strings.
 * Outputs: Negative, zero, or positive segment-order comparison.
 * Does not handle: Canonicalization, case-insensitive filesystem policy, or locale-aware comparison.
 * Side effects: Splits both paths into transient segment arrays.
 */
function compareCanonicalRoots(left: string, right: string): number {
  const leftSegments = left.split(sep);
  const rightSegments = right.split(sep);
  const common = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < common; index += 1) {
    const leftSegment = leftSegments[index]!;
    const rightSegment = rightSegments[index]!;
    if (leftSegment < rightSegment) return -1;
    if (leftSegment > rightSegment) return 1;
  }
  return leftSegments.length - rightSegments.length;
}

/**
 * Resolves a trusted parser-produced manifest-relative descriptor against an attested base without imposing containment.
 *
 * Inputs: A canonical manifest-base string and a trusted parser-produced descriptor; it is not a hostile Proxy/getter-bearing caller object.
 * Outputs: A resolved local candidate path, potentially outside the manifest base when a leading `..` is retained, or undefined for ordinary null, wrong-kind, empty, backslash, or absolute descriptors.
 * Does not handle: Hostile-object/property-access safety, filesystem existence, manifest-base or symlink containment, descriptor normalization, or path diagnostics.
 * Side effects: Allocates a resolved path string on accepted descriptors; property access may throw if a future caller bypasses the parser trust boundary.
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
 * Maps values with at most the requested number of concurrently active asynchronous workers.
 *
 * Inputs: An input array, positive concurrency limit, and async mapper.
 * Outputs: Results in original input order after every mapper settles successfully.
 * Does not handle: Mapper failure recovery, cancellation, adaptive limits, or validation of a nonsensical limit.
 * Side effects: Allocates a result array and concurrent worker promises; mapper side effects are caller-defined.
 */
async function mapLimited<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    /**
     * Claims successive input indexes and stores each awaited mapped result in its original slot.
     *
     * Inputs: The Array.from worker index, which is intentionally unused.
     * Outputs: A promise resolving after this worker exhausts the shared index counter.
     * Does not handle: Catching mapper rejection or synchronizing externally shared mapper state.
     * Side effects: Increments the enclosing next counter and writes entries into the enclosing results array.
     */
    async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T);
    }
    }
  );
  await Promise.all(workers);
  return results;
}
