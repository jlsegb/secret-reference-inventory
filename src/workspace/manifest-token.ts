import type {
  WorkspaceManifest,
  WorkspaceManifestToken,
} from "./contracts.js";

/**
 * Parser/runtime-only capability registry. This module is deliberately not
 * re-exported by the public workspace barrel: the public parser accepts text,
 * while the runtime accepts only identities issued from parsed text.
 */
const ISSUED_MANIFESTS = new WeakMap<object, WorkspaceManifest>();

export function issueWorkspaceManifestToken(
  manifest: WorkspaceManifest,
): WorkspaceManifestToken {
  const token = manifest as WorkspaceManifestToken;
  ISSUED_MANIFESTS.set(token, manifest);
  return token;
}

/**
 * This performs no property reads or reflection on the supplied value, so it
 * is safe to use as the first boundary check for arbitrary JavaScript input.
 */
export function isIssuedWorkspaceManifestToken(
  input: unknown,
): input is WorkspaceManifestToken {
  return (
    input !== null &&
    typeof input === "object" &&
    ISSUED_MANIFESTS.has(input as object)
  );
}

/** Returns the immutable parser-authored manifest only for an issued token. */
export function manifestForIssuedWorkspaceToken(
  input: unknown,
): WorkspaceManifest | undefined {
  return (
    input !== null && typeof input === "object"
      ? ISSUED_MANIFESTS.get(input as object)
      : undefined
  );
}
