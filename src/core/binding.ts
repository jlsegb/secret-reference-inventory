import {
  logicalKeyEquals,
  scopeCovers,
  stagesMayOverlap,
} from "./equality.js";
import type {
  BindingCandidate,
  BindingCandidateSelection,
  BindingCandidateSelectionStatus,
  BindingPartitionOutcome,
  BindingResolution,
  ConditionClause,
  ConditionPredicate,
  SafeIdentifier,
  ScopeSelector,
} from "./types.js";

/** Bound symbolic partitioning prevents an adapter manifest from exploding work. */
export const MAX_CONDITION_PARTITIONS = 256;

interface ConditionDomain {
  readonly key: SafeIdentifier;
  readonly values: readonly SafeIdentifier[];
}

type ConditionAssignment = ReadonlyMap<SafeIdentifier, SafeIdentifier | undefined>;

/**
 * Resolve data-only binding candidates. The resolver is deliberately
 * conservative: when selector intersections or precedence cannot be proven,
 * it emits an unresolved/conflicting partition instead of choosing a source.
 */
export function resolveBindingCandidates(
  candidates: readonly BindingCandidate[],
): readonly BindingResolution[] {
  // `scopesEquivalent` and `logicalKeyEquals` make unknown dimensions opaque,
  // so only fully comparable candidates enter a shared Map slot. This retains
  // the old first-seen slot and candidate ordering while avoiding a quadratic
  // `slots.find(...)` walk for large manifests with distinct destinations.
  const slots = new Map<string, BindingCandidate[]>();

  for (const [index, candidate] of candidates.entries()) {
    const key = bindingSlotKey(candidate, index);
    const slot = slots.get(key);
    if (slot === undefined) {
      slots.set(key, [candidate]);
    } else {
      slot.push(candidate);
    }
  }

  return [...slots.values()].flatMap((slot) => resolveSlot(slot));
}

/**
 * A Map key only groups candidates that the old equality predicate could
 * group. Any opaque component gets a distinct slot: Core must not infer that
 * two unknown scopes or opaque logical-key names are equal.
 */
function bindingSlotKey(candidate: BindingCandidate, index: number): string {
  const { scope, destination } = candidate;
  if (
    typeof destination.name !== "string" ||
    scope.phase === "unknown" ||
    scope.channel === "unknown" ||
    scope.stage.kind === "unknown"
  ) {
    return `opaque:${index}`;
  }

  const stage = scope.stage.kind === "all"
    ? ["all"]
    : ["exact", ...new Set(scope.stage.values)].sort();
  // JSON encoding avoids a delimiter ambiguity if safe-identifier grammar is
  // widened in a future schema revision.
  return JSON.stringify([
    scope.id,
    scope.phase,
    scope.channel,
    stage,
    destination.namespace,
    destination.name,
  ]);
}

/** Returns every exact, selected candidate whose resolution covers a demand scope. */
export function effectiveBindingCandidatesFor(
  scope: BindingCandidate["scope"],
  destination: BindingCandidate["destination"],
  candidates: readonly BindingCandidate[],
  resolutions: readonly BindingResolution[],
): readonly BindingCandidate[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected: BindingCandidate[] = [];

  for (const resolution of resolutions) {
    if (
      !scopeCovers(resolution.scope, scope) ||
      !logicalKeyEquals(resolution.destination, destination)
    ) {
      continue;
    }

    for (const partition of resolution.partitions) {
      if (partition.outcome !== "effective" || !selectorCoversScope(partition.appliesWhen, scope)) {
        continue;
      }

      const effective = partition.selections.filter(
        (selection) => selection.status === "effective",
      );
      if (effective.length !== 1 || effective[0] === undefined) {
        continue;
      }

      const candidate = candidateById.get(effective[0].candidateId);
      if (
        candidate !== undefined &&
        candidate.resolution === "exact" &&
        !selected.some((item) => item.id === candidate.id)
      ) {
        selected.push(candidate);
      }
    }
  }

  return selected;
}

export function bindingResolutionStatusFor(
  scope: BindingCandidate["scope"],
  destination: BindingCandidate["destination"],
  resolutions: readonly BindingResolution[],
): "effective" | "conflicting" | "unresolved" | "none" {
  let sawConflicting = false;
  let sawUnresolved = false;

  for (const resolution of resolutions) {
    if (
      !scopeCovers(resolution.scope, scope) ||
      !logicalKeyEquals(resolution.destination, destination)
    ) {
      continue;
    }

    const relevant: BindingResolution["partitions"][number][] = [];
    for (const partition of resolution.partitions) {
      if (!selectorMayAffectScope(partition.appliesWhen, scope)) {
        continue;
      }

      if (!selectorCoversScope(partition.appliesWhen, scope)) {
        // A partial-stage/channel selector cannot satisfy the full demand
        // scope, even when it has a locally effective winner.
        sawUnresolved = true;
        continue;
      }
      relevant.push(partition);

      if (partition.outcome === "conflicting") {
        sawConflicting = true;
      }
      if (partition.outcome === "unresolved") {
        sawUnresolved = true;
      }
    }

    if (
      relevant.length > 0 &&
      relevant.every((partition) => partition.outcome === "effective") &&
      selectorsCoverAllConditions(relevant.map((partition) => partition.appliesWhen))
    ) {
      return "effective";
    }

    if (relevant.some((partition) => partition.outcome === "effective")) {
      // A branch winner alone is not an exact declaration for an unconditional
      // code demand. The finite condition partitions must cover every branch.
      sawUnresolved = true;
    }
  }

  if (sawConflicting) {
    return "conflicting";
  }
  if (sawUnresolved) {
    return "unresolved";
  }
  return "none";
}

function resolveSlot(slot: readonly BindingCandidate[]): readonly BindingResolution[] {
  const first = slot[0];
  if (first === undefined) {
    return [];
  }

  const finitePartitions = resolveFiniteConditionPartitions(slot);
  const partitions = finitePartitions ?? resolveOverlappingSelectorGroups(slot);

  return [
    {
      scope: first.scope,
      destination: first.destination,
      partitions,
      accessEvidence: "not-evaluated",
    },
  ];
}

/**
 * Resolve precedence inside disjoint finite condition branches. For example,
 * an unconditional env_file candidate and a BRANCH=main override become two
 * partitions: BRANCH=main (override wins) and BRANCH!=main (base wins).
 */
function resolveFiniteConditionPartitions(
  slot: readonly BindingCandidate[],
): readonly BindingResolution["partitions"][number][] | undefined {
  const first = slot[0];
  if (
    first === undefined ||
    slot.some(
      (candidate) =>
        candidate.appliesWhen.condition.kind === "unknown" ||
        !selectorsShareNonConditionDimensions(first.appliesWhen, candidate.appliesWhen),
    )
  ) {
    return undefined;
  }

  const domains = conditionDomains(slot.map((candidate) => candidate.appliesWhen.condition));
  const assignments = domains === undefined ? undefined : enumerateConditionAssignments(domains);
  if (domains === undefined || assignments === undefined) {
    return undefined;
  }

  return assignments.map((assignment) => {
    const applicable = slot.filter((candidate) =>
      conditionMatchesAssignment(candidate.appliesWhen.condition, assignment),
    );
    const appliesWhen: ScopeSelector = {
      ...first.appliesWhen,
      condition: assignmentCondition(domains, assignment),
    };
    return resolveFiniteConditionPartition(appliesWhen, applicable, slot);
  });
}

function resolveFiniteConditionPartition(
  appliesWhen: ScopeSelector,
  applicable: readonly BindingCandidate[],
  slot: readonly BindingCandidate[],
): BindingResolution["partitions"][number] {
  if (applicable.length === 0 || applicable.some((candidate) => candidate.resolution === "dynamic")) {
    return {
      appliesWhen,
      outcome: "unresolved",
      selections: slot.map((candidate) => ({
        candidateId: candidate.id,
        status: applicable.some((current) => current.id === candidate.id)
          ? "unresolved"
          : "inapplicable",
      })),
    };
  }

  const resolution = resolvePrecedence(applicable);
  return {
    appliesWhen,
    outcome: resolution.outcome,
    selections: slot.map((candidate) => ({
      candidateId: candidate.id,
      status: resolution.statuses.get(candidate.id) ?? "inapplicable",
    })),
  };
}

function resolveOverlappingSelectorGroups(
  slot: readonly BindingCandidate[],
): readonly BindingResolution["partitions"][number][] {
  interface SelectorGroup {
    readonly candidates: BindingCandidate[];
    readonly order: number;
    /** Present only for a selector whose equality relation is symmetric. */
    readonly canonicalKey?: string;
  }
  const groups: SelectorGroup[] = [];
  const canonicalGroups = new Map<string, SelectorGroup>();
  const nonCanonicalGroups: SelectorGroup[] = [];
  for (const candidate of slot) {
    const canonical = selectorIsCanonical(candidate.appliesWhen);
    const key = canonical ? selectorGroupKey(candidate.appliesWhen) : undefined;
    const indexed = key === undefined ? undefined : canonicalGroups.get(key);
    let group: SelectorGroup | undefined;
    if (key === undefined) {
      // The public Core API accepts normalized facts directly. Preserve the
      // legacy asymmetric duplicate-array behavior for malformed direct facts
      // rather than changing a grouping result in the name of optimization.
      group = groups.find(
        (existing) =>
          existing.candidates[0] !== undefined &&
          selectorsEquivalent(existing.candidates[0].appliesWhen, candidate.appliesWhen),
      );
    } else {
      // A canonical selector can only equal the identically keyed canonical
      // group, but an earlier duplicate-bearing group may directionally match
      // it under the historical predicate. Check those exceptional groups in
      // declaration order before taking the O(1) canonical bucket.
      for (const existing of nonCanonicalGroups) {
        if (indexed !== undefined && existing.order > indexed.order) break;
        if (
          existing.candidates[0] !== undefined &&
          selectorsEquivalent(existing.candidates[0].appliesWhen, candidate.appliesWhen)
        ) {
          group = existing;
          break;
        }
      }
      group ??= indexed;
    }
    if (group === undefined) {
      const next: SelectorGroup = {
        candidates: [candidate],
        order: groups.length,
        ...(key === undefined ? {} : { canonicalKey: key }),
      };
      groups.push(next);
      if (key !== undefined) {
        canonicalGroups.set(key, next);
      } else {
        nonCanonicalGroups.push(next);
      }
    } else {
      group.candidates.push(candidate);
    }
  }
  return groups.map((group) => resolvePartition(group.candidates, slot));
}

function selectorGroupKey(selector: ScopeSelector): string {
  const values = (input: readonly string[] | undefined): readonly string[] | undefined =>
    input === undefined ? undefined : [...input].sort();
  const stage = selector.stage.kind === "exact"
    ? ["exact", ...[...selector.stage.values].sort()]
    : [selector.stage.kind];
  const condition = selector.condition.kind === "all"
    ? [
        "all",
        ...selector.condition.clauses
          .map((clause) => [clause.key, clause.operator, clause.value])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ]
    : [selector.condition.kind];
  return JSON.stringify([
    values(selector.executionUnitIds),
    values(selector.phases),
    stage,
    values(selector.channels),
    condition,
  ]);
}

function selectorIsCanonical(selector: ScopeSelector): boolean {
  const unique = (values: readonly string[] | undefined): boolean =>
    values === undefined || new Set(values).size === values.length;
  if (
    !unique(selector.executionUnitIds) ||
    !unique(selector.phases) ||
    !unique(selector.channels) ||
    (selector.stage.kind === "exact" && !unique(selector.stage.values))
  ) {
    return false;
  }
  if (selector.condition.kind !== "all") return true;
  const clauses = selector.condition.clauses.map(
    (clause) => JSON.stringify([clause.key, clause.operator, clause.value]),
  );
  return new Set(clauses).size === clauses.length;
}

function resolvePartition(
  applicable: readonly BindingCandidate[],
  slot: readonly BindingCandidate[],
): BindingResolution["partitions"][number] {
  const first = applicable[0];
  if (first === undefined) {
    throw new Error("Binding partition cannot be empty");
  }

  const overlappingElsewhere = slot.some(
    (candidate) =>
      !applicable.some((current) => current.id === candidate.id) &&
      selectorsMayOverlap(candidate.appliesWhen, first.appliesWhen),
  );

  if (
    overlappingElsewhere ||
    first.appliesWhen.condition.kind === "unknown" ||
    applicable.some((candidate) => candidate.resolution === "dynamic")
  ) {
    return {
      appliesWhen: first.appliesWhen,
      outcome: "unresolved",
      selections: slot.map((candidate) => ({
        candidateId: candidate.id,
        status: applicable.some((current) => current.id === candidate.id)
          ? "unresolved"
          : "inapplicable",
      })),
    };
  }

  const resolution = resolvePrecedence(applicable);
  return {
    appliesWhen: first.appliesWhen,
    outcome: resolution.outcome,
    selections: slot.map((candidate) => {
      const status = resolution.statuses.get(candidate.id);
      return {
        candidateId: candidate.id,
        status: status ?? "inapplicable",
      };
    }),
  };
}

function resolvePrecedence(candidates: readonly BindingCandidate[]): {
  readonly outcome: BindingPartitionOutcome;
  readonly statuses: ReadonlyMap<BindingCandidate["id"], BindingCandidateSelectionStatus>;
} {
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return {
      outcome: "effective",
      statuses: new Map([[candidates[0].id, "effective"]]),
    };
  }

  if (
    candidates.some(
      (candidate) => !candidate.precedence.comparable || candidate.precedence.rank === undefined,
    )
  ) {
    return {
      outcome: "conflicting",
      statuses: new Map(candidates.map((candidate) => [candidate.id, "conflicting"])),
    };
  }

  const sorted = [...candidates].sort(
    (left, right) => (right.precedence.rank ?? 0) - (left.precedence.rank ?? 0),
  );
  const winner = sorted[0];
  const runnerUp = sorted[1];
  if (
    winner === undefined ||
    runnerUp === undefined ||
    winner.precedence.rank === runnerUp.precedence.rank
  ) {
    return {
      outcome: "conflicting",
      statuses: new Map(candidates.map((candidate) => [candidate.id, "conflicting"])),
    };
  }

  return {
    outcome: "effective",
    statuses: new Map(
      sorted.map((candidate) => [
        candidate.id,
        candidate.id === winner.id ? "effective" : "shadowed",
      ]),
    ),
  };
}

function selectorsShareNonConditionDimensions(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    sameIdentifierSet(left.executionUnitIds, right.executionUnitIds) &&
    sameStringSet(left.phases, right.phases) &&
    sameStage(left.stage, right.stage) &&
    sameStringSet(left.channels, right.channels)
  );
}

function conditionDomains(
  conditions: readonly ConditionPredicate[],
): readonly ConditionDomain[] | undefined {
  const domains = new Map<SafeIdentifier, { key: SafeIdentifier; values: SafeIdentifier[] }>();
  for (const condition of conditions) {
    if (condition.kind === "unknown") {
      return undefined;
    }
    if (condition.kind !== "all") {
      continue;
    }
    for (const clause of condition.clauses) {
      const domain = domains.get(clause.key) ?? { key: clause.key, values: [] };
      if (!domain.values.includes(clause.value)) {
        domain.values.push(clause.value);
      }
      domains.set(clause.key, domain);
    }
  }
  return [...domains.values()]
    .map((domain) => ({
      key: domain.key,
      values: Object.freeze([...domain.values].sort()),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function enumerateConditionAssignments(
  domains: readonly ConditionDomain[],
): readonly ConditionAssignment[] | undefined {
  let assignments: Array<Map<SafeIdentifier, SafeIdentifier | undefined>> = [new Map()];
  for (const domain of domains) {
    const choices: Array<SafeIdentifier | undefined> = [...domain.values, undefined];
    if (assignments.length > Math.floor(MAX_CONDITION_PARTITIONS / choices.length)) {
      return undefined;
    }
    const next: Array<Map<SafeIdentifier, SafeIdentifier | undefined>> = [];
    for (const assignment of assignments) {
      for (const choice of choices) {
        const copy = new Map(assignment);
        copy.set(domain.key, choice);
        next.push(copy);
      }
    }
    assignments = next;
  }
  return assignments;
}

function assignmentCondition(
  domains: readonly ConditionDomain[],
  assignment: ConditionAssignment,
): ConditionPredicate {
  const clauses: ConditionClause[] = [];
  for (const domain of domains) {
    const selected = assignment.get(domain.key);
    if (selected !== undefined) {
      clauses.push({ key: domain.key, operator: "equals", value: selected });
    } else {
      for (const value of domain.values) {
        clauses.push({ key: domain.key, operator: "not-equals", value });
      }
    }
  }
  return clauses.length === 0 ? { kind: "always" } : { kind: "all", clauses };
}

function conditionMatchesAssignment(
  condition: ConditionPredicate,
  assignment: ConditionAssignment,
): boolean {
  if (condition.kind === "always") {
    return true;
  }
  if (condition.kind === "unknown") {
    return false;
  }
  return condition.clauses.every((clause) => {
    const selected = assignment.get(clause.key);
    return clause.operator === "equals"
      ? selected === clause.value
      : selected !== clause.value;
  });
}

function selectorsCoverAllConditions(selectors: readonly ScopeSelector[]): boolean {
  const domains = conditionDomains(selectors.map((selector) => selector.condition));
  const assignments = domains === undefined ? undefined : enumerateConditionAssignments(domains);
  return (
    assignments !== undefined &&
    assignments.every((assignment) =>
      selectors.some((selector) => conditionMatchesAssignment(selector.condition, assignment)),
    )
  );
}

function selectorsEquivalent(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    selectorsShareNonConditionDimensions(left, right) &&
    sameCondition(left.condition, right.condition)
  );
}

function selectorsMayOverlap(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    identifierSetsMayOverlap(left.executionUnitIds, right.executionUnitIds) &&
    stringSetsMayOverlap(left.phases, right.phases) &&
    stringSetsMayOverlap(left.channels, right.channels) &&
    stagesMayOverlap(left.stage, right.stage) &&
    conditionsMayOverlap(left.condition, right.condition)
  );
}

function selectorMayAffectScope(selector: ScopeSelector, scope: BindingCandidate["scope"]): boolean {
  if (selector.executionUnitIds !== undefined && !selector.executionUnitIds.includes(scope.id)) {
    return false;
  }
  if (selector.phases !== undefined && !selector.phases.includes(scope.phase)) {
    return false;
  }
  if (selector.channels !== undefined && !selector.channels.includes(scope.channel)) {
    return false;
  }
  return stagesMayOverlap(selector.stage, scope.stage);
}

function selectorCoversScope(selector: ScopeSelector, scope: BindingCandidate["scope"]): boolean {
  if (!selectorMayAffectScope(selector, scope) || selector.condition.kind === "unknown") {
    return false;
  }
  return scopeCovers(
    {
      id: scope.id,
      componentId: scope.componentId,
      phase: scope.phase,
      stage: selector.stage,
      channel: scope.channel,
    },
    scope,
  );
}

function sameStage(left: ScopeSelector["stage"], right: ScopeSelector["stage"]): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== "exact" || right.kind !== "exact") {
    return true;
  }
  return sameIdentifierSet(left.values, right.values);
}

function sameCondition(left: ConditionPredicate, right: ConditionPredicate): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== "all" || right.kind !== "all") {
    return true;
  }
  if (left.clauses.length !== right.clauses.length) {
    return false;
  }
  return left.clauses.every((clause) =>
    right.clauses.some(
      (candidate) =>
        candidate.key === clause.key &&
        candidate.operator === clause.operator &&
        candidate.value === clause.value,
    ),
  );
}

function conditionsMayOverlap(left: ConditionPredicate, right: ConditionPredicate): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return true;
  }
  if (left.kind !== "all" || right.kind !== "all") {
    return true;
  }

  for (const leftClause of left.clauses) {
    for (const rightClause of right.clauses) {
      if (leftClause.key !== rightClause.key) {
        continue;
      }
      if (
        leftClause.operator === "equals" &&
        rightClause.operator === "equals" &&
        leftClause.value !== rightClause.value
      ) {
        return false;
      }
      if (
        leftClause.operator !== rightClause.operator &&
        leftClause.value === rightClause.value
      ) {
        return false;
      }
    }
  }
  return true;
}

function sameIdentifierSet(
  left: readonly BindingCandidate["id"][] | undefined,
  right: readonly BindingCandidate["id"][] | undefined,
): boolean {
  return sameStringSet(left, right);
}

function sameStringSet<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.length === right.length && left.every((value) => right.includes(value));
}

function identifierSetsMayOverlap(
  left: readonly BindingCandidate["id"][] | undefined,
  right: readonly BindingCandidate["id"][] | undefined,
): boolean {
  return stringSetsMayOverlap(left, right);
}

function stringSetsMayOverlap<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  return left === undefined || right === undefined || left.some((value) => right.includes(value));
}
