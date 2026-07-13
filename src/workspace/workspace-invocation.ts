import {
  verifyWorkspaceScanRequestContext,
  workspaceScanRequestContext,
  type WorkspaceScanRequestContext,
} from "./scan-request.js";
import {
  MAX_WORKSPACE_DEPLOYMENTS,
  type WorkspaceDeployment,
} from "./contracts.js";
import { manifestForIssuedWorkspaceToken } from "./manifest-token.js";

/**
 * A single invocation—not a request-lifetime singleton—owns all bounded work
 * and attested local-input caching for one `scanWorkspace` execution.
 */
export type IssuedWorkspaceInvocation = object;

export const MAX_WORKSPACE_INVOCATION_FACTS = 100_000;
/** A repository fallback emits one incomplete scope-coverage status. */
export const WORKSPACE_REPOSITORY_FALLBACK_FACTS = 1;
/**
 * A fallback partition emits one empty incomplete scope-coverage status. No
 * nested reason ID is retained, keeping the maximum-manifest escape hatch to
 * one graph fact per declared member.
 */
export const WORKSPACE_DEPLOYMENT_MEMBER_FALLBACK_FACTS = 1;
/**
 * Runtime compacts every deployment's aggregate diagnostics to one status
 * fact. Reserve that slot up front so a legal maximum-size manifest cannot
 * amplify fallback output beyond the invocation graph cap.
 */
const DEPLOYMENT_AGGREGATE_STATUS_FACTS = 1;
export const MAX_WORKSPACE_INVOCATION_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_WORKSPACE_INVOCATION_DOCUMENT_CACHE_ENTRIES = 2_048;
/** v2 permits at most three provisioning descriptors per deployment. */
export const MAX_WORKSPACE_INVOCATION_DOCUMENT_DESCRIPTOR_OBSERVATIONS =
  MAX_WORKSPACE_DEPLOYMENTS * 3;

/** Opaque invocation-local identity for one parser-authored declaration. */
export type IssuedWorkspaceDeploymentDeclaration = object;

export interface WorkspaceInvocationDeployment {
  readonly declaration: WorkspaceDeployment;
  readonly handle: IssuedWorkspaceDeploymentDeclaration;
}

export interface WorkspaceDocumentCacheEntry {
  /** Canonical file-version identity used by the bounded snapshot cache. */
  readonly identity: string;
  /** Private canonical semantic-file key shared by equivalent descriptors. */
  readonly semanticKey: string;
  readonly value: Promise<unknown>;
  lastAccess: number;
}

export interface WorkspaceDocumentDescriptorAlias {
  /** Points only at an entry still present in `documentReads`. */
  readonly entry: WorkspaceDocumentCacheEntry;
  readonly semanticKey: string;
  lastAccess: number;
}

/**
 * Compact first-observed file-version metadata for one parser descriptor.
 * It intentionally contains no parsed value and no displayable diagnostic.
 */
export interface WorkspaceDocumentSemanticObservation {
  readonly identity: string;
}

export interface WorkspaceInvocationContext {
  readonly request: object;
  readonly requestContext: WorkspaceScanRequestContext;
  /** Mutated only by internal app/attestation modules for this invocation. */
  factBudgetRemaining: number;
  /**
   * One incomplete scope-coverage status is reserved for each parser-declared
   * top-level repository before repository graph admission.
   */
  readonly repositoryFactFloor: number;
  /**
   * One incomplete scope-coverage status is reserved for each parser-declared
   * deployment member before graph-specific work.
   */
  readonly deploymentMemberFactFloor: number;
  /** One compact aggregate status is reserved for each declared deployment. */
  readonly deploymentAggregateStatusFactFloor: number;
  /** Parser declarations are indexed exactly once at invocation minting. */
  readonly deploymentsById: ReadonlyMap<string, WorkspaceInvocationDeployment>;
  /** Internal count-only instrumentation for declaration-index regressions. */
  deploymentLookupCount: number;
  /** Mutated only after a unique descriptor has passed its bounded stat gate. */
  inputByteBudgetRemaining: number;
  /** Canonical file identity -> checked immutable read promise. */
  readonly documentReads: Map<string, WorkspaceDocumentCacheEntry>;
  /**
   * Normalized descriptor path -> an extant checked read. Equivalent
   * declarations share this LRU alias without retaining parser objects.
   */
  readonly documentDescriptorReads: Map<string, WorkspaceDocumentDescriptorAlias>;
  /**
   * Normalized descriptor path -> first canonical semantic-file key. This
   * survives payload LRU eviction so a symlink/path replacement cannot become
   * a new trusted input snapshot for the same declaration.
   */
  readonly documentDescriptorSemantics: Map<string, string>;
  /**
   * Canonical semantic-file key -> first observed version identity. Different
   * deployment declarations and normalized aliases of one file therefore
   * share one snapshot boundary after payload eviction.
   */
  readonly documentSemanticObservations: Map<string, WorkspaceDocumentSemanticObservation>;
  documentReadClock: number;
}

const INVOCATIONS = new WeakMap<object, WorkspaceInvocationContext>();

// Invocation minting accepts only issued, still-verified provenance; callers
// cannot supply a counter, cache, path, or descriptor collection.
/**
 * Mints one bounded workspace-scan invocation from a currently verified opaque request.
 *
 * Inputs: An issued scan request that still attests to its manifest file and base directory.
 * Outputs: An invocation token, or undefined for unissued, changed, malformed, duplicate-deployment, or over-budget manifests.
 * Does not handle: Parsing manifests, accepting caller-owned caches/counters, or emitting diagnostics for rejected invocation setup.
 * Side effects: Re-stats the manifest/base through request verification, allocates declaration indexes and cache Maps, and registers one WeakMap context.
 */
export async function beginVerifiedWorkspaceInvocation(
  request: unknown,
): Promise<IssuedWorkspaceInvocation | undefined> {
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
  const deploymentsById = new Map<string, WorkspaceInvocationDeployment>();
  const repositoryFactFloor =
    manifest.repositories.length * WORKSPACE_REPOSITORY_FALLBACK_FACTS;
  let deploymentMemberFactFloor = 0;
  let deploymentAggregateStatusFactFloor = 0;
  if (repositoryFactFloor > MAX_WORKSPACE_INVOCATION_FACTS) {
    return undefined;
  }
  for (const declaration of manifest.deployments) {
    if (deploymentsById.has(declaration.id)) {
      return undefined;
    }
    deploymentMemberFactFloor +=
      declaration.repositories.length * WORKSPACE_DEPLOYMENT_MEMBER_FALLBACK_FACTS;
    deploymentAggregateStatusFactFloor += DEPLOYMENT_AGGREGATE_STATUS_FACTS;
    if (
      repositoryFactFloor +
        deploymentMemberFactFloor +
        deploymentAggregateStatusFactFloor >
        MAX_WORKSPACE_INVOCATION_FACTS
    ) {
      return undefined;
    }
    deploymentsById.set(declaration.id, Object.freeze({
      declaration,
      handle: Object.freeze(Object.create(null)),
    }));
  }
  const token = Object.freeze(Object.create(null));
  INVOCATIONS.set(token, {
    request: request as object,
    requestContext,
    factBudgetRemaining:
      MAX_WORKSPACE_INVOCATION_FACTS -
      repositoryFactFloor -
      deploymentMemberFactFloor -
      deploymentAggregateStatusFactFloor,
    repositoryFactFloor,
    deploymentMemberFactFloor,
    deploymentAggregateStatusFactFloor,
    deploymentsById,
    deploymentLookupCount: 0,
    inputByteBudgetRemaining: MAX_WORKSPACE_INVOCATION_INPUT_BYTES,
    documentReads: new Map(),
    documentDescriptorReads: new Map(),
    documentDescriptorSemantics: new Map(),
    documentSemanticObservations: new Map(),
    documentReadClock: 0,
  });
  return token;
}

/**
 * Retrieves invocation-local state by opaque identity without examining caller-owned properties.
 *
 * Inputs: Any invocation candidate.
 * Outputs: The private invocation context, or undefined for an unissued identity.
 * Does not handle: Invocation validation, capability reconstruction, or data serialization.
 * Side effects: None; reads the private invocation WeakMap.
 */
export function workspaceInvocationContext(
  input: unknown,
): WorkspaceInvocationContext | undefined {
  return INVOCATIONS.get(input as object);
}

/**
 * Finds one parser-declared deployment through the invocation's prebuilt ID index.
 *
 * Inputs: An invocation capability and a string deployment ID.
 * Outputs: The declaration/opaque-handle pair, or undefined for unknown invocations or IDs.
 * Does not handle: Structural declaration matching, request verification, or exposing the full deployment collection.
 * Side effects: Increments the invocation's count-only deployment lookup metric for valid invocation contexts.
 */
export function workspaceInvocationDeployment(
  invocation: unknown,
  deploymentId: unknown,
): WorkspaceInvocationDeployment | undefined {
  const context = INVOCATIONS.get(invocation as object);
  if (context === undefined || typeof deploymentId !== "string") {
    return undefined;
  }
  context.deploymentLookupCount += 1;
  return context.deploymentsById.get(deploymentId);
}

/**
 * Reports count-only instrumentation for an issued invocation.
 *
 * Inputs: An invocation candidate.
 * Outputs: Frozen declaration and lookup counts, or undefined for an unissued identity.
 * Does not handle: Per-deployment identities, paths, cache contents, or user-facing diagnostics.
 * Side effects: Allocates the frozen metrics result; it does not mutate invocation state.
 */
export function workspaceInvocationMetrics(
  invocation: unknown,
): { readonly deploymentDeclarationCount: number; readonly deploymentLookupCount: number } | undefined {
  const context = INVOCATIONS.get(invocation as object);
  return context === undefined
    ? undefined
    : Object.freeze({
        deploymentDeclarationCount: context.deploymentsById.size,
        deploymentLookupCount: context.deploymentLookupCount,
      });
}
