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

/**
 * Issues the opaque capability that represents one parser-authored workspace manifest.
 *
 * Inputs: An immutable manifest returned by the trusted workspace text parser.
 * Outputs: The same manifest value branded as a WorkspaceManifestToken.
 * Does not handle: Parsing caller text, cloning manifests, or validating arbitrary manifest-shaped objects.
 * Side effects: Registers the token-to-manifest identity in the module-private WeakMap.
 */
export function issueWorkspaceManifestToken(
  manifest: WorkspaceManifest,
): WorkspaceManifestToken {
  const token = manifest as WorkspaceManifestToken;
  ISSUED_MANIFESTS.set(token, manifest);
  return token;
}

/**
 * Tests whether an arbitrary value is an issued manifest capability without inspecting it.
 *
 * Inputs: Any caller-supplied JavaScript value, including a hostile Proxy.
 * Outputs: True only for an object identity currently held by the private issuance WeakMap.
 * Does not handle: Structural manifest validation or recovery of a manifest from a copied token.
 * Side effects: None; WeakMap lookup performs no property read or reflection on the input.
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

/**
 * Retrieves the parser-authored manifest associated with an issued capability.
 *
 * Inputs: An arbitrary candidate token.
 * Outputs: The retained immutable manifest, or undefined when the identity was never issued.
 * Does not handle: Re-parsing text, validating lookalike objects, or exposing the WeakMap.
 * Side effects: None; performs only a private identity lookup.
 */
export function manifestForIssuedWorkspaceToken(
  input: unknown,
): WorkspaceManifest | undefined {
  return (
    input !== null && typeof input === "object"
      ? ISSUED_MANIFESTS.get(input as object)
      : undefined
  );
}
