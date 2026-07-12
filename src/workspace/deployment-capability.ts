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
 * Create an identity-only issuance after the caller has already materialized
 * and validated its own data.  No caller payload is accepted or retained.
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

/** No caller token or handle properties are read before identity lookup. */
export function issuedDeploymentMember(
  token: unknown,
  repositoryId: unknown,
): IssuedDeploymentMember | undefined {
  const issuance = ISSUANCES.get(token as object);
  return typeof repositoryId === "string" ? issuance?.members.get(repositoryId) : undefined;
}
