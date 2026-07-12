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
 * Issue all repository identities from one still-verified request before any
 * source scan starts. The capability retains parser-authored IDs and resolved
 * roots only in private identity registries.
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

/** Identity-only member-set lookup; no caller object is inspected. */
export function workspaceRepositoryMembersContext(
  input: unknown,
): WorkspaceRepositoryMembersContext | undefined {
  return MEMBER_SETS.get(input as object)?.context;
}

/** Identity-only retrieval of a member handle for a parser-authored ID. */
export function issuedWorkspaceRepositoryMember(
  input: unknown,
  repositoryId: unknown,
): IssuedWorkspaceRepositoryMember | undefined {
  return typeof repositoryId === "string"
    ? MEMBER_SETS.get(input as object)?.byRepositoryId.get(repositoryId as SafeIdentifier)
    : undefined;
}

/** Identity-only handle lookup for the app/runtime boundary. */
export function workspaceRepositoryMemberContext(
  input: unknown,
): WorkspaceRepositoryMemberContext | undefined {
  return MEMBERS.get(input as object);
}

/** Identity-only, count-only instrumentation used by the scale regression. */
export function workspaceRepositoryMemberAttestationMetrics(
  input: unknown,
): WorkspaceRepositoryMemberAttestationMetrics | undefined {
  return MEMBER_SETS.get(input as object)?.metrics;
}

interface ResolvedMember {
  readonly repository: WorkspaceRepository;
  readonly resolution: WorkspaceRepositoryMemberResolution;
}

async function resolveMembers(
  manifest: WorkspaceManifest,
  manifestBase: InternalPath,
): Promise<{ readonly members: readonly ResolvedMember[]; readonly rootConflictChecks: number }> {
  const results = await mapLimited(
    manifest.repositories,
    32,
    async (repository): Promise<ResolvedMember> => Object.freeze({
      repository,
      resolution: await resolveRepositoryDirectory(manifestBase, repository.root),
    }),
  );
  return applyCanonicalRootConflicts(results);
}

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
 * A sorted ancestor stack detects equal/ancestor roots in O(n log n) time.
 * In contrast to pairwise comparison, it does not repeatedly scan every
 * resolved root as a 10,000-member manifest grows.
 */
function applyCanonicalRootConflicts(
  members: readonly ResolvedMember[],
): { readonly members: readonly ResolvedMember[]; readonly rootConflictChecks: number } {
  const valid = members
    .map((member, index) => ({ member, index }))
    .filter(
      (entry): entry is {
        readonly member: ResolvedMember & {
          readonly resolution: Extract<WorkspaceRepositoryMemberResolution, { readonly ok: true }>;
        };
        readonly index: number;
      } => entry.member.resolution.ok,
    )
    .sort((left, right) => compareCanonicalRoots(
      left.member.resolution.canonicalRoot,
      right.member.resolution.canonicalRoot,
    ));
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
    members: members.map((member, index) =>
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
 * Raw string ordering does not keep descendants contiguous: `/root/a-` sorts
 * before `/root/a/x`, which can pop `/root/a` from an ancestor stack. Compare
 * path segments instead so every parent and its subtree stay adjacent.
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

async function mapLimited<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
