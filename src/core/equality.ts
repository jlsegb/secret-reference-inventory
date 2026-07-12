import type {
  ConditionPredicate,
  ExecutionScope,
  LogicalKey,
  ProviderResourceId,
  SafeKeyPattern,
  ScopeSelector,
  StagePredicate,
} from "./types.js";

/** Typed equality for logical keys; opaque names never match. */
export function logicalKeyEquals(left: LogicalKey, right: LogicalKey): boolean {
  return (
    left.namespace === right.namespace &&
    typeof left.name === "string" &&
    typeof right.name === "string" &&
    left.name === right.name
  );
}

/** Provider resources must match in both the authority and canonical namespace. */
export function providerResourceEquals(
  left: ProviderResourceId,
  right: ProviderResourceId,
): boolean {
  return (
    left.authorityId === right.authorityId && left.canonicalId === right.canonicalId
  );
}

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

  return covered.values.every((value) => covering.values.includes(value));
}

/** A conservative overlap check used only to apply uncertainty/coverage. */
export function stagesMayOverlap(left: StagePredicate, right: StagePredicate): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return true;
  }

  if (left.kind === "all" || right.kind === "all") {
    return true;
  }

  return left.values.some((value) => right.values.includes(value));
}

/** Exact binding compatibility: identity, phase/channel, and full stage coverage. */
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

/** Equality suitable for binding slot grouping, not a raw identifier join. */
export function scopesEquivalent(left: ExecutionScope, right: ExecutionScope): boolean {
  return scopeCovers(left, right) && scopeCovers(right, left);
}

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

/** A condition's truth domain is unknown unless it is a resolved finite predicate. */
function conditionMayOverlap(condition: ConditionPredicate): boolean {
  // An unknown predicate cannot establish exact coverage, but it may execute;
  // uncertainty and coverage must therefore apply conservatively.
  return condition.kind === "unknown" || condition.kind === "always" || condition.kind === "all";
}

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

export function logicalKeySortKey(key: LogicalKey): string | undefined {
  return typeof key.name === "string" ? `${key.namespace}:${key.name}` : undefined;
}
