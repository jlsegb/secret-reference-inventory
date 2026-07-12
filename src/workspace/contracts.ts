import type { ExecutionScope } from "../core/index.js";
import type { SafeIdentifier } from "../safety/types.js";

/**
 * A local, non-executable workspace declaration. Schema revisions are
 * intentional compatibility boundaries for CLI, orchestration, and reports.
 */
export const WORKSPACE_MANIFEST_SCHEMA_VERSION = "workspace-manifest/v2" as const;

/**
 * Explicit structural limits keep parser work bounded before repository
 * discovery begins. They are intentionally independent of file-scan budgets.
 */
export const MAX_WORKSPACE_REPOSITORIES = 10_000;
export const MAX_WORKSPACE_DEPLOYMENTS = 10_000;
export const MAX_WORKSPACE_DEPLOYMENT_MEMBERS = 10_000;
export const MAX_WORKSPACE_TOTAL_DEPLOYMENT_MEMBERS = 50_000;

/**
 * A validated slash-separated relative descriptor. It is not a filesystem
 * path and has not been resolved or read at this layer.
 */
export type WorkspaceRelativePath = string & {
  readonly __brand: "WorkspaceRelativePath";
};

/**
 * N3 must resolve this descriptor against the manifest location and perform
 * real-path containment checks before it opens anything.
 */
export interface ManifestRelativeDescriptor {
  readonly kind: "manifest-relative";
  readonly path: WorkspaceRelativePath;
}

export interface WorkspaceRepository {
  readonly id: SafeIdentifier;
  readonly root: ManifestRelativeDescriptor;
}

/**
 * A deployment explicitly assigns each member repository the execution scope
 * whose provisioning facts may be reconciled with that member's source facts.
 * Repository membership and execution-scope identity are separate concepts;
 * v2 makes their association declarative rather than inferred from a path or
 * a configuration name.
 */
export interface WorkspaceDeploymentMemberScope {
  readonly repositoryId: SafeIdentifier;
  readonly scope: ExecutionScope;
}

/**
 * Deployment-local provisioning input descriptors. A deployment is scan-only
 * when this field is absent; bindings and inventory are deliberately paired
 * so reconciliation cannot infer one from the other.
 */
export interface WorkspaceDeploymentInputs {
  readonly bindings: ManifestRelativeDescriptor;
  readonly inventory: ManifestRelativeDescriptor;
  readonly closedModel?: ManifestRelativeDescriptor;
  /** One exact entry for every declared deployment repository. */
  readonly memberScopes: readonly WorkspaceDeploymentMemberScope[];
}

export interface WorkspaceDeployment {
  readonly id: SafeIdentifier;
  /** Explicit membership only; path/name heuristics are forbidden. */
  readonly repositories: readonly SafeIdentifier[];
  readonly inputs?: WorkspaceDeploymentInputs;
}

export interface WorkspaceManifest {
  readonly schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA_VERSION;
  readonly repositories: readonly WorkspaceRepository[];
  readonly deployments: readonly WorkspaceDeployment[];
}

/**
 * An issuance-only capability returned by the text parser. The structural
 * fields remain readable for local diagnostics, but runtime acceptance is
 * based on parser-held identity, not this compile-time brand.
 */
declare const workspaceManifestTokenBrand: unique symbol;
export type WorkspaceManifestToken = WorkspaceManifest & {
  readonly [workspaceManifestTokenBrand]: true;
};

/**
 * Paths contain parser-authored field names and numeric array indices only.
 * In particular, unknown manifest property names and raw path/value strings
 * are never copied into a diagnostic.
 */
export type WorkspaceManifestPath = readonly (string | number)[];

export type WorkspaceManifestDiagnosticCode =
  | "invalid-json"
  | "invalid-input-shape"
  | "invalid-schema-version"
  | "legacy-provisioning-requires-v2"
  | "unknown-field"
  | "missing-field"
  | "invalid-string"
  | "invalid-array"
  | "empty-repositories"
  | "too-many-repositories"
  | "too-many-deployments"
  | "too-many-deployment-members"
  | "too-many-total-deployment-members"
  | "unsafe-repository-id"
  | "unsafe-deployment-id"
  | "unsafe-deployment-member"
  | "unsafe-relative-path"
  | "duplicate-repository-id"
  | "duplicate-repository-root"
  | "ambiguous-repository-root"
  | "duplicate-deployment-id"
  | "empty-deployment-membership"
  | "duplicate-deployment-member"
  | "undeclared-deployment-member"
  | "invalid-member-scopes"
  | "unsafe-member-scope"
  | "duplicate-member-scope"
  | "undeclared-member-scope"
  | "overlapping-member-scope"
  | "invalid-deployment-inputs";

export interface WorkspaceManifestDiagnostic {
  readonly code: WorkspaceManifestDiagnosticCode;
  readonly path: WorkspaceManifestPath;
}

export type WorkspaceManifestParseResult =
  | {
      readonly ok: true;
      readonly value: WorkspaceManifestToken;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly WorkspaceManifestDiagnostic[];
    };
