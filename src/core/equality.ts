import type {
  ConditionPredicate,
  ExecutionScope,
  LogicalKey,
  ProviderResourceId,
  SafeKeyPattern,
  ScopeSelector,
  StagePredicate,
} from "./types.js";

/**
 * Compares two logical keys only when both carry the same namespace and concrete name.
 *
 * Inputs: Two logical-key facts, whose names can intentionally be opaque.
 * Outputs: True for equal namespace/name pairs; false for opaque or unequal names.
 * Does not handle: Provider-resource identity, pattern expansion, or case normalization.
 * Side effects: None.
 */
export function logicalKeyEquals(left: LogicalKey, right: LogicalKey): boolean {
  return (
    left.namespace === right.namespace &&
    typeof left.name === "string" &&
    typeof right.name === "string" &&
    left.name === right.name
  );
}

/**
 * Compares provider resources in their authority-qualified canonical namespace.
 *
 * Inputs: Two provider-resource identities.
 * Outputs: True only when both authority and canonical resource identifiers match.
 * Does not handle: Provider aliases, permissions, resource-field selection, or value access.
 * Side effects: None.
 */
export function providerResourceEquals(
  left: ProviderResourceId,
  right: ProviderResourceId,
): boolean {
  return (
    left.authorityId === right.authorityId && left.canonicalId === right.canonicalId
  );
}

/**
 * Decides whether one known stage predicate contains every stage in another predicate.
 *
 * Inputs: A covering predicate and a predicate whose runtime stages need coverage.
 * Outputs: True for all-stage coverage or complete exact-stage containment; false for unknown or insufficient predicates.
 * Does not handle: Runtime stage discovery, conditional execution, or unknown-stage assumptions.
 * Side effects: None.
 */
export function stageCovers(covering: StagePredicate, covered: StagePredicate): boolean {
  if (covering.kind === "unknown" || covered.kind === "unknown") {
    return false;
  }

  if (covering.kind === "all") {
    return true;
  }

  if (covered.kind === "all") {
    return false;
  }

  return covered.values.every(
    /**
     * Checks one required stage against the declared covering-stage list.
     *
     * Inputs: One stage required by the covered predicate.
     * Outputs: True when the covering predicate explicitly lists that stage.
     * Does not handle: Unknown stages or stage aliases.
     * Side effects: Reads the covering predicate's immutable stage array.
     */
    (value) => covering.values.includes(value)
  );
}

/**
 * Tests whether two stage predicates could describe at least one common execution stage.
 *
 * Inputs: Two stage predicates.
 * Outputs: False only for proven-disjoint exact predicates; true whenever overlap or uncertainty remains possible.
 * Does not handle: Resolving an unknown predicate into concrete deployment stages.
 * Side effects: None.
 */
export function stagesMayOverlap(left: StagePredicate, right: StagePredicate): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return true;
  }

  if (left.kind === "all" || right.kind === "all") {
    return true;
  }

  return left.values.some(
    /**
     * Finds one exact stage that occurs in both predicates.
     *
     * Inputs: One stage from the left predicate.
     * Outputs: True when the right predicate lists the same stage.
     * Does not handle: Unknown or all-stage predicates, which the caller handles first.
     * Side effects: Reads the right predicate's immutable stage array.
     */
    (value) => right.values.includes(value)
  );
}

/**
 * Tests whether a binding execution scope fully covers a code-demand execution scope.
 *
 * Inputs: A proposed covering scope and a demanded scope.
 * Outputs: True only for matching unit, known equal phase/channel, and full stage coverage.
 * Does not handle: Cross-unit component equivalence, conditional selectors, or unknown dimensions.
 * Side effects: None.
 */
export function scopeCovers(covering: ExecutionScope, covered: ExecutionScope): boolean {
  return (
    covering.id === covered.id &&
    covering.phase !== "unknown" &&
    covered.phase !== "unknown" &&
    covering.phase === covered.phase &&
    covering.channel !== "unknown" &&
    covered.channel !== "unknown" &&
    covering.channel === covered.channel &&
    stageCovers(covering.stage, covered.stage)
  );
}

/**
 * Determines whether two execution scopes mutually cover each other for Core grouping.
 *
 * Inputs: Two execution scopes.
 * Outputs: True when each scope covers the other under the conservative scope relation.
 * Does not handle: Raw component-ID joins or equivalence through unknown dimensions.
 * Side effects: None.
 */
export function scopesEquivalent(left: ExecutionScope, right: ExecutionScope): boolean {
  return scopeCovers(left, right) && scopeCovers(right, left);
}

/**
 * Determines whether a selector might apply to a scope, preserving uncertainty for coverage analysis.
 *
 * Inputs: A declaration selector and one execution scope.
 * Outputs: False for proven unit/phase/channel/stage exclusion; true when selection or condition uncertainty can still affect the scope.
 * Does not handle: Evaluating runtime condition values or proving exact selector coverage.
 * Side effects: None.
 */
export function selectorMayAffectScope(
  selector: ScopeSelector,
  scope: ExecutionScope,
): boolean {
  if (
    selector.executionUnitIds !== undefined &&
    !selector.executionUnitIds.includes(scope.id)
  ) {
    return false;
  }

  if (selector.phases !== undefined && !selector.phases.includes(scope.phase)) {
    return false;
  }

  if (selector.channels !== undefined && !selector.channels.includes(scope.channel)) {
    return false;
  }

  return stagesMayOverlap(selector.stage, scope.stage) && conditionMayOverlap(selector.condition);
}

/**
 * Determines whether a selector supplies complete non-conditional coverage for a scope.
 *
 * Inputs: A selector and one execution scope.
 * Outputs: True only when dimensions match, the condition is known, and stage coverage is complete.
 * Does not handle: Unknown conditions, partial-stage declarations, or runtime condition evaluation.
 * Side effects: None.
 */
export function selectorCoversScope(selector: ScopeSelector, scope: ExecutionScope): boolean {
  if (
    selector.executionUnitIds !== undefined &&
    !selector.executionUnitIds.includes(scope.id)
  ) {
    return false;
  }

  if (selector.phases !== undefined && !selector.phases.includes(scope.phase)) {
    return false;
  }

  if (selector.channels !== undefined && !selector.channels.includes(scope.channel)) {
    return false;
  }

  if (selector.condition.kind === "unknown") {
    return false;
  }

  return stageCovers(selector.stage, scope.stage);
}

/**
 * Classifies an individual condition predicate as potentially executable for overlap purposes.
 *
 * Inputs: One condition predicate attached to a selector.
 * Outputs: True for unknown, unconditional, and every accepted finite-clause shape, treating each as potentially executable.
 * Does not handle: Comparing finite condition sets or proving clause satisfiability; contradictory all-clause predicates still return true.
 * Side effects: None.
 */
function conditionMayOverlap(condition: ConditionPredicate): boolean {
  // An unknown predicate cannot establish exact coverage, but it may execute;
  // uncertainty and coverage must therefore apply conservatively.
  return condition.kind === "unknown" || condition.kind === "always" || condition.kind === "all";
}

/**
 * Tests an environment logical key against a safety-approved prefix, suffix, or surrounding pattern.
 *
 * Inputs: A validated key pattern and a logical key.
 * Outputs: True when a concrete environment name matches the selected pattern form.
 * Does not handle: Opaque names, non-environment namespaces, regular expressions, or pattern validation.
 * Side effects: None.
 */
export function safeKeyPatternMatches(pattern: SafeKeyPattern, key: LogicalKey): boolean {
  if (key.namespace !== "env" || typeof key.name !== "string") {
    return false;
  }

  switch (pattern.kind) {
    case "prefix":
      return key.name.startsWith(pattern.prefix);
    case "suffix":
      return key.name.endsWith(pattern.suffix);
    case "surrounded":
      return key.name.startsWith(pattern.prefix) && key.name.endsWith(pattern.suffix);
  }
}

/**
 * Produces a deterministic namespace/name sort key for a concrete logical key.
 *
 * Inputs: One logical key.
 * Outputs: A namespace-qualified string for concrete names, or undefined for opaque names.
 * Does not handle: Escaping arbitrary identifiers for persistent storage or ordering provider resources.
 * Side effects: None.
 */
export function logicalKeySortKey(key: LogicalKey): string | undefined {
  return typeof key.name === "string" ? `${key.namespace}:${key.name}` : undefined;
}
