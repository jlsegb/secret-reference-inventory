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

/**
 * Supplies bounded Core facts that can constrain a dynamic environment-key lookup.
 *
 * Inputs: The finite-domain limit plus optional binding destinations and adapter-proven pattern domains.
 * Outputs: Read-only validation context consumed while normalizing one dynamic lookup.
 * Does not handle: Parsing source expressions, consulting runtime configuration, or validating raw identifiers.
 * Side effects: None.
 */
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
 * Validates one already-safe dynamic lookup and replaces unsound finite claims with scoped uncertainty.
 *
 * Inputs: A branded dynamic lookup fact and bounded Core facts that can prove finite candidates.
 * Outputs: The retained or downgraded lookup, issue codes, and adapter-proven finite expansion when justified.
 * Does not handle: Source parsing, raw secret values, runtime interpolation, or unbounded-key enumeration.
 * Side effects: None; returned lookup objects may be fresh copies when normalization changes a domain.
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

/**
 * Verifies that a finite dynamic domain is unique, bounded, and identical to its declared likely keys.
 *
 * Inputs: One finite lookup and the positive maximum number of allowed keys.
 * Outputs: The original lookup with unique expanded keys, or an opaque/unbounded replacement with one issue.
 * Does not handle: Pattern-domain evidence, binding lookup, or recovery of duplicate source keys.
 * Side effects: Allocates temporary normalized key arrays without mutating the input fact.
 */
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

/**
 * Verifies a pattern lookup against matching binding destinations and one nonconflicting adapter-proven domain.
 *
 * Inputs: One pattern lookup, its Core validation context, and the finite-domain limit.
 * Outputs: A normalized pattern lookup with allowed likely keys, or an opaque/unbounded replacement and issue.
 * Does not handle: Arbitrary regular expressions, runtime-selected pattern values, or resolving conflicting domains.
 * Side effects: Allocates candidate and deduplicated key arrays; does not alter context or input arrays.
 */
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
    .filter(
      /**
       * Retains a declared binding destination only when its scope covers the lookup and its key fits the pattern.
       *
       * Inputs: One scope/key binding-destination pair from the validation context.
       * Outputs: True when the pair contributes a finite candidate to this lookup.
       * Does not handle: Conditional binding precedence or provider-resource identity.
       * Side effects: Reads the immutable lookup and pattern facts.
       */
      ({ scope, key }) => scopeCovers(scope, input.scope) && safeKeyPatternMatches(pattern, key)
    )
    .map(
      /**
       * Projects a matching binding-destination pair to its logical key.
       *
       * Inputs: One already-approved scope/key pair.
       * Outputs: Its logical key for later deduplication.
       * Does not handle: Scope validation or pattern matching, which the preceding filter completed.
       * Side effects: None.
       */
      ({ key }) => key
    );

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
    modelCandidates.some(
      /**
       * Detects an adapter-proven model key that violates the lookup's declared pattern.
       *
       * Inputs: One key from the resolved finite pattern domain.
       * Outputs: True when the key cannot legally belong to the pattern expansion.
       * Does not handle: Validating the pattern syntax, which occurred before domain lookup.
       * Side effects: None.
       */
      (key) => !safeKeyPatternMatches(pattern, key)
    )
  ) {
    return uncertain(input, "opaque", "DYNAMIC_PATTERN_CANDIDATE_MISMATCH");
  }

  const allowed = uniqueKeys([...bindingCandidates, ...modelCandidates]);
  const supplied = uniqueKeys(input.likelyKeys);

  if (
    supplied.length !== input.likelyKeys.length ||
    supplied.some(
      /**
       * Detects a caller-supplied likely key that no declared or model candidate permits.
       *
       * Inputs: One deduplicated likely key from the lookup.
       * Outputs: True when no allowed candidate has the same concrete logical identity.
       * Does not handle: Opaque-name equivalence or additional source-expression evaluation.
       * Side effects: Reads the temporary allowed-key array.
       */
      (key) => !allowed.some(
        /**
         * Compares one allowed candidate to the supplied key under logical-key equality.
         *
         * Inputs: One permitted candidate and the enclosing supplied key.
         * Outputs: True when their concrete namespace/name identities match.
         * Does not handle: Pattern matching or candidate admission.
         * Side effects: None.
         */
        (candidate) => logicalKeyEquals(candidate, key)
      )
    )
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

/**
 * Rejects annotations that try to attach finite likely keys to an unbounded lookup.
 *
 * Inputs: One lookup whose domain is already declared unbounded.
 * Outputs: The unchanged lookup for an empty likely-key list, otherwise an opaque replacement and issue.
 * Does not handle: Proving a finite domain from source or binding facts.
 * Side effects: None; an invalid lookup is replaced with a fresh uncertainty object.
 */
function validateUnbounded(input: UnboundedDynamicLookupEdge): DynamicValidationResult {
  if (input.likelyKeys.length === 0) {
    return { edge: input, issues: [], expandedFiniteKeys: [] };
  }

  return uncertain(input, "opaque", "DYNAMIC_UNBOUNDED_HAS_KEYS");
}

/**
 * Selects a unique adapter-proven finite domain that fully covers a pattern lookup's execution scope.
 *
 * Inputs: One adapter-proven pattern lookup and all declared finite pattern domains.
 * Outputs: No domain immediately for a non-adapter-proven constraint or no covering domain, one domain for matching expansions, or a conflict marker for different expansions.
 * Does not handle: Upgrading non-adapter-proven constraints, partial selector coverage, or merging conflicting expansions.
 * Side effects: Allocates a filtered domain array without modifying the supplied declarations.
 */
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
    /**
     * Keeps a finite domain only when it has the same pattern identity, adapter proof, and full scope coverage.
     *
     * Inputs: One finite pattern-domain declaration.
     * Outputs: True when that declaration can constrain the enclosing lookup.
     * Does not handle: Comparing its key expansion with other applicable declarations.
     * Side effects: Reads the immutable lookup and declaration facts.
     */
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
    applicable.slice(1).some(
      /**
       * Detects one otherwise-compatible finite declaration whose key set conflicts with the first declaration.
       *
       * Inputs: One additional applicable finite pattern-domain declaration.
       * Outputs: True when its deduplicated keys differ from the first declaration's key set.
       * Does not handle: Choosing a precedence winner between conflicting adapter declarations.
       * Side effects: Allocates a temporary deduplicated key list for the candidate.
       */
      (candidate) => !sameKeySet(firstKeys, uniqueKeys(candidate.keys)),
    )
  ) {
    return { kind: "conflicting", domain: undefined };
  }
  return { kind: "unique", domain: first };
}

/**
 * Converts an invalid dynamic claim into an unbounded lookup limited to its original scope and reference.
 *
 * Inputs: The original lookup, an unbounded-domain reason, and one validation issue code.
 * Outputs: A fresh lookup with no likely keys plus the single reason code and no finite expansion.
 * Does not handle: Retaining unsafe finite evidence, widening uncertainty outside the original scope, or emitting diagnostics.
 * Side effects: Allocates a replacement lookup and issue array; leaves the input unchanged.
 */
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

/**
 * Wraps a safe identifier as a concrete environment logical key.
 *
 * Inputs: One already-branded environment-key identifier.
 * Outputs: A logical key in the environment namespace.
 * Does not handle: Identifier validation, non-environment namespaces, or opaque names.
 * Side effects: Allocates a small logical-key object.
 */
function toEnvironmentKey(name: SafeIdentifier): LogicalKey {
  return { namespace: "env", name };
}

/**
 * Preserves the first occurrence of each concrete logical key while discarding opaque and duplicate keys.
 *
 * Inputs: A logical-key sequence in source or declaration order.
 * Outputs: A newly allocated, first-seen-ordered sequence of unique concrete keys.
 * Does not handle: Canonicalizing case, retaining opaque names, or validating namespace semantics.
 * Side effects: Mutates only newly allocated result and seen-key collections.
 */
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

/**
 * Tests two logical-key arrays for equal length and order-independent concrete membership.
 *
 * Inputs: Two logical-key sequences expected to contain finite candidates.
 * Outputs: True when each left key has an equal key on the right and lengths match.
 * Does not handle: Duplicate normalization, opaque-name equality, or multiplicity beyond array length.
 * Side effects: None.
 */
function sameKeySet(left: readonly LogicalKey[], right: readonly LogicalKey[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    /**
     * Requires one left key to occur in the right-hand sequence.
     *
     * Inputs: One left-hand logical key.
     * Outputs: True when some right-hand key has equal concrete identity.
     * Does not handle: Duplicate removal or array-length comparison.
     * Side effects: Reads the right-hand array.
     */
    (key) => right.some(
      /**
       * Compares one right-hand candidate with the enclosing left key.
       *
       * Inputs: One right-hand key and the enclosing left key.
       * Outputs: True when their logical identities match.
       * Does not handle: Membership of other keys.
       * Side effects: None.
       */
      (candidate) => logicalKeyEquals(key, candidate)
    )
  );
}

/**
 * Checks the structural nonemptiness rules for a previously typed safe-key pattern.
 *
 * Inputs: One prefix, suffix, or surrounding pattern fact.
 * Outputs: True when every required literal segment is a nonempty string.
 * Does not handle: Matching keys, semantic pattern policy, or sanitizing unsafe source text.
 * Side effects: None.
 */
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

/**
 * Converts an invalid finite-domain limit into the smallest conservative positive limit.
 *
 * Inputs: A numeric caller option.
 * Outputs: The original positive safe integer, or one when the option is zero, negative, fractional, or unsafe.
 * Does not handle: Reporting invalid configuration to a caller.
 * Side effects: None.
 */
function normalizeLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
