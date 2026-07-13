/**
 * Internal identity channel for deployment preparation.  It deliberately has
 * no application imports and carries only opaque token/member identities; app
 * facts stay in app-owned WeakMaps.
 */
export type IssuedDeploymentPreparation = object;
export type IssuedDeploymentMember = object;

interface Issuance {
  readonly members: ReadonlyMap<string, IssuedDeploymentMember>;
}

const MAX_ISSUED_DEPLOYMENT_MEMBERS = 50_000;
const ISSUANCES = new WeakMap<object, Issuance>();

/**
 * Issues one opaque deployment-preparation capability and one opaque member handle per unique member ID.
 *
 * Inputs: A nonempty array of at most 50,000 unique string repository IDs.
 * Outputs: A preparation token, or undefined for malformed, duplicate, oversized, or trap-throwing input.
 * Does not handle: Validating deployment facts, retaining caller array identity or values other than the copied repository-ID strings, or recovering after property access throws.
 * Side effects: Allocates frozen null-prototype handles and a private Map keyed by the supplied repository-ID strings.
 */
export function issueDeploymentPreparation(memberIds: unknown): IssuedDeploymentPreparation | undefined {
  try {
    if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > MAX_ISSUED_DEPLOYMENT_MEMBERS) {
      return undefined;
    }
    const members = new Map<string, IssuedDeploymentMember>();
    for (const memberId of memberIds) {
      if (typeof memberId !== "string" || members.has(memberId)) {
        return undefined;
      }
      members.set(memberId, Object.freeze(Object.create(null)));
    }
    const token = Object.freeze(Object.create(null));
    ISSUANCES.set(token, Object.freeze({ members }));
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Retrieves an issued member handle from a preparation capability by its parser-authored repository ID.
 *
 * Inputs: An arbitrary preparation candidate and repository-ID candidate.
 * Outputs: The opaque member handle, or undefined for an unknown identity or non-string ID.
 * Does not handle: Reading token properties, accepting copied capabilities, or validating a deployment declaration.
 * Side effects: None; uses only private WeakMap and Map lookups.
 */
export function issuedDeploymentMember(
  token: unknown,
  repositoryId: unknown,
): IssuedDeploymentMember | undefined {
  const issuance = ISSUANCES.get(token as object);
  return typeof repositoryId === "string" ? issuance?.members.get(repositoryId) : undefined;
}
