import {
  logicalKeyEquals,
  logicalKeySortKey,
  safeKeyPatternMatches,
  selectorCoversScope,
  scopeCovers,
} from "./equality.js";
import type {
  DynamicKeyDomain,
  DynamicLookupEdge,
  FinitePatternDomain,
  LogicalKey,
  SafeIdentifier,
  SafeKeyPattern,
} from "./types.js";

type FiniteDynamicLookupEdge = DynamicLookupEdge & {
  readonly domain: Extract<DynamicKeyDomain, { readonly kind: "finite" }>;
};

type PatternDynamicLookupEdge = DynamicLookupEdge & {
  readonly domain: Extract<DynamicKeyDomain, { readonly kind: "pattern" }>;
};

type UnboundedDynamicLookupEdge = DynamicLookupEdge & {
  readonly domain: Extract<DynamicKeyDomain, { readonly kind: "unbounded" }>;
};

export type DynamicValidationIssueCode =
  | "DYNAMIC_FINITE_DUPLICATE"
  | "DYNAMIC_FINITE_LIKELY_MISMATCH"
  | "DYNAMIC_OVER_BUDGET"
  | "DYNAMIC_PATTERN_INVALID"
  | "DYNAMIC_PATTERN_DOMAIN_CONFLICT"
  | "DYNAMIC_PATTERN_CANDIDATE_MISMATCH"
  | "DYNAMIC_UNBOUNDED_HAS_KEYS";

export interface DynamicValidationIssue {
  readonly code: DynamicValidationIssueCode;
}

export interface ScopedLogicalKey {
  readonly scope: DynamicLookupEdge["scope"];
  readonly key: LogicalKey;
}

/** Context comes from Core/binding facts, not a repository parser or runtime. */
export interface DynamicValidationContext {
  readonly maxFiniteKeyDomain: number;
  readonly knownBindingDestinations?: readonly ScopedLogicalKey[];
  readonly finitePatternDomains?: readonly FinitePatternDomain[];
}

export interface DynamicValidationResult {
  /** Normalized edge, or a conservative unbounded replacement on invalid input. */
  readonly edge: DynamicLookupEdge;
  readonly issues: readonly DynamicValidationIssue[];
  /** Present only for an adapter-proven finite pattern-domain expansion. */
  readonly expandedFiniteKeys: readonly LogicalKey[];
}

/**
 * Structural validation after SafeFactFactory has branded source text. Core
 * validates domain invariants but never materializes raw strings or imports the
 * safety factory.
 */
export function validateDynamicLookupEdge(
  input: DynamicLookupEdge,
  context: DynamicValidationContext,
): DynamicValidationResult {
  const max = normalizeLimit(context.maxFiniteKeyDomain);

  switch (input.domain.kind) {
    case "finite": {
      const finite: FiniteDynamicLookupEdge = { ...input, domain: input.domain };
      return validateFinite(finite, max);
    }
    case "pattern": {
      const pattern: PatternDynamicLookupEdge = { ...input, domain: input.domain };
      return validatePattern(pattern, context, max);
    }
    case "unbounded": {
      const unbounded: UnboundedDynamicLookupEdge = { ...input, domain: input.domain };
      return validateUnbounded(unbounded);
    }
  }
}

function validateFinite(
  input: FiniteDynamicLookupEdge,
  max: number,
): DynamicValidationResult {
  const finiteKeys = input.domain.keys.map(toEnvironmentKey);
  const uniqueFinite = uniqueKeys(finiteKeys);

  if (finiteKeys.length > max) {
    return uncertain(input, "over-budget", "DYNAMIC_OVER_BUDGET");
  }

  if (uniqueFinite.length !== finiteKeys.length) {
    return uncertain(input, "opaque", "DYNAMIC_FINITE_DUPLICATE");
  }

  if (
    uniqueKeys(input.likelyKeys).length !== input.likelyKeys.length ||
    !sameKeySet(input.likelyKeys, uniqueFinite)
  ) {
    return uncertain(input, "opaque", "DYNAMIC_FINITE_LIKELY_MISMATCH");
  }

  return {
    edge: input,
    issues: [],
    expandedFiniteKeys: uniqueFinite,
  };
}

function validatePattern(
  input: PatternDynamicLookupEdge,
  context: DynamicValidationContext,
  max: number,
): DynamicValidationResult {
  const pattern = input.domain.pattern;
  if (!isSafeKeyPattern(pattern)) {
    return uncertain(input, "opaque", "DYNAMIC_PATTERN_INVALID");
  }

  const bindingCandidates = (context.knownBindingDestinations ?? [])
    .filter(({ scope, key }) => scopeCovers(scope, input.scope) && safeKeyPatternMatches(pattern, key))
    .map(({ key }) => key);

  const domainResolution = findApplicablePatternDomain(input, context.finitePatternDomains ?? []);
  if (domainResolution.kind === "conflicting") {
    // A pattern's finite expansion is privileged evidence. Two compatible
    // selectors with different finite domains cannot be collapsed by picking
    // the first array entry; retain only scoped uncertainty.
    return uncertain(input, "opaque", "DYNAMIC_PATTERN_DOMAIN_CONFLICT");
  }
  const modelDomain = domainResolution.domain;
  const modelCandidates = modelDomain?.keys ?? [];

  if (
    uniqueKeys(modelCandidates).length !== modelCandidates.length ||
    modelCandidates.some((key) => !safeKeyPatternMatches(pattern, key))
  ) {
    return uncertain(input, "opaque", "DYNAMIC_PATTERN_CANDIDATE_MISMATCH");
  }

  const allowed = uniqueKeys([...bindingCandidates, ...modelCandidates]);
  const supplied = uniqueKeys(input.likelyKeys);

  if (
    supplied.length !== input.likelyKeys.length ||
    supplied.some((key) => !allowed.some((candidate) => logicalKeyEquals(candidate, key)))
  ) {
    return uncertain(input, "opaque", "DYNAMIC_PATTERN_CANDIDATE_MISMATCH");
  }

  const likelyKeys = uniqueKeys([...allowed, ...supplied]);
  if (likelyKeys.length > max) {
    return uncertain(input, "over-budget", "DYNAMIC_OVER_BUDGET");
  }

  const edge: DynamicLookupEdge = {
    ...input,
    likelyKeys,
  };

  const expandedFiniteKeys =
    input.patternConstraint === "adapter-proven" && modelDomain !== undefined
      ? uniqueKeys(modelDomain.keys)
      : [];

  return { edge, issues: [], expandedFiniteKeys };
}

function validateUnbounded(input: UnboundedDynamicLookupEdge): DynamicValidationResult {
  if (input.likelyKeys.length === 0) {
    return { edge: input, issues: [], expandedFiniteKeys: [] };
  }

  return uncertain(input, "opaque", "DYNAMIC_UNBOUNDED_HAS_KEYS");
}

function findApplicablePatternDomain(
  edge: PatternDynamicLookupEdge,
  domains: readonly FinitePatternDomain[],
):
  | { readonly kind: "none"; readonly domain: undefined }
  | { readonly kind: "unique"; readonly domain: FinitePatternDomain }
  | { readonly kind: "conflicting"; readonly domain: undefined } {
  if (edge.patternConstraint !== "adapter-proven") {
    return { kind: "none", domain: undefined };
  }

  const applicable = domains.filter(
    (domain) =>
      domain.patternId === edge.domain.pattern.patternId &&
      domain.constraint === "adapter-proven" &&
      selectorCoversScope(domain.scope, edge.scope),
  );
  const first = applicable[0];
  if (first === undefined) {
    return { kind: "none", domain: undefined };
  }

  // Equivalent duplicate declarations carry the same finite evidence. Any
  // different expansion is a conflict, even though both selectors cover the
  // lookup scope.
  const firstKeys = uniqueKeys(first.keys);
  if (
    applicable.slice(1).some((candidate) =>
      !sameKeySet(firstKeys, uniqueKeys(candidate.keys)),
    )
  ) {
    return { kind: "conflicting", domain: undefined };
  }
  return { kind: "unique", domain: first };
}

function uncertain(
  input: DynamicLookupEdge,
  reason: Extract<DynamicKeyDomain, { readonly kind: "unbounded" }>["reason"],
  code: DynamicValidationIssueCode,
): DynamicValidationResult {
  const edge: DynamicLookupEdge = {
    id: input.id,
    referenceId: input.referenceId,
    scope: input.scope,
    domain: { kind: "unbounded", reason },
    origin: input.origin,
    likelyKeys: [],
    evidenceChain: input.evidenceChain,
  };

  return {
    edge,
    issues: [{ code }],
    expandedFiniteKeys: [],
  };
}

function toEnvironmentKey(name: SafeIdentifier): LogicalKey {
  return { namespace: "env", name };
}

function uniqueKeys(keys: readonly LogicalKey[]): LogicalKey[] {
  const result: LogicalKey[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const sortKey = logicalKeySortKey(key);
    if (sortKey === undefined || seen.has(sortKey)) {
      continue;
    }

    seen.add(sortKey);
    result.push(key);
  }

  return result;
}

function sameKeySet(left: readonly LogicalKey[], right: readonly LogicalKey[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((key) => right.some((candidate) => logicalKeyEquals(key, candidate)));
}

function isSafeKeyPattern(pattern: SafeKeyPattern): boolean {
  switch (pattern.kind) {
    case "prefix":
      return typeof pattern.prefix === "string" && pattern.prefix.length > 0;
    case "suffix":
      return typeof pattern.suffix === "string" && pattern.suffix.length > 0;
    case "surrounded":
      return (
        typeof pattern.prefix === "string" &&
        pattern.prefix.length > 0 &&
        typeof pattern.suffix === "string" &&
        pattern.suffix.length > 0
      );
  }
}

function normalizeLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
