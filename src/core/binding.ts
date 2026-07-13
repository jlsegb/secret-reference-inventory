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

/**
 * Caps finite condition cross-products so a manifest cannot create unbounded binding partitions.
 *
 * Inputs: Used internally as the maximum permitted symbolic assignment count.
 * Outputs: The fixed limit of 256 partitions.
 * Does not handle: Input parsing limits or dynamic candidate resolution.
 * Side effects: None.
 */
export const MAX_CONDITION_PARTITIONS = 256;

interface ConditionDomain {
  readonly key: SafeIdentifier;
  readonly values: readonly SafeIdentifier[];
}

type ConditionAssignment = ReadonlyMap<SafeIdentifier, SafeIdentifier | undefined>;

/**
 * Partitions comparable binding candidates and resolves precedence without inventing a winner.
 *
 * Inputs: Binding candidates already normalized by an adapter.
 * Outputs: Ordered resolutions with effective, shadowed, conflicting, or unresolved selections per selector partition.
 * Does not handle: Runtime condition evaluation, provider delivery, access permissions, or dynamic candidate claims.
 * Side effects: Allocates and mutates invocation-local slot Maps and arrays; never changes candidate facts.
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

  return [...slots.values()].flatMap(
    /**
     * Resolves one same-destination/scope candidate slot into its single binding resolution.
     *
     * Inputs: Candidates that were conservatively grouped into one slot.
     * Outputs: That slot's zero-or-one resolution sequence.
     * Does not handle: Cross-slot precedence or opaque-scope equivalence.
     * Side effects: Delegates allocation of partition records; does not mutate the slot.
     */
    (slot) => resolveSlot(slot)
  );
}

/**
 * Encodes only fully comparable binding scope and destination fields for Map slotting.
 *
 * Inputs: One binding candidate and its declaration index.
 * Outputs: A stable JSON slot key, or an index-unique opaque key when equality cannot be proven.
 * Does not handle: Raw identifier joining, component identity, or selector-condition equivalence.
 * Side effects: Allocates a small JSON string; does not mutate the candidate.
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

/**
 * Retrieves exact candidates selected by effective partitions that fully cover one demand slot.
 *
 * Inputs: A demand scope/destination, all candidate facts, and their resolved partitions.
 * Outputs: First-resolution-ordered unique exact candidates selected for the demand.
 * Does not handle: Unresolved/conflicting partitions, dynamic candidates, or a choice among multiple branch resources.
 * Side effects: Allocates a candidate-ID Map and result array; neither input collection is modified.
 */
export function effectiveBindingCandidatesFor(
  scope: BindingCandidate["scope"],
  destination: BindingCandidate["destination"],
  candidates: readonly BindingCandidate[],
  resolutions: readonly BindingResolution[],
): readonly BindingCandidate[] {
  const candidateById = new Map(candidates.map(
    /**
     * Indexes a candidate by its safe identifier for partition-selection lookup.
     *
     * Inputs: One binding candidate.
     * Outputs: Its identifier/candidate pair.
     * Does not handle: Duplicate-ID conflict detection; later Map entries deliberately overwrite earlier ones.
     * Side effects: Feeds the newly allocated Map constructor.
     */
    (candidate) => [candidate.id, candidate]
  ));
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
        /**
         * Retains a selection only when this partition names it as its sole effective candidate.
         *
         * Inputs: One candidate-selection status from a partition.
         * Outputs: True for an effective selection.
         * Does not handle: Whether the partition itself covers the demand scope.
         * Side effects: None.
         */
        (selection) => selection.status === "effective",
      );
      if (effective.length !== 1 || effective[0] === undefined) {
        continue;
      }

      const candidate = candidateById.get(effective[0].candidateId);
      if (
        candidate !== undefined &&
        candidate.resolution === "exact" &&
        !selected.some(
          /**
           * Detects a candidate already emitted by an earlier effective partition.
           *
           * Inputs: One candidate retained in the output and the enclosing candidate.
           * Outputs: True when their identifiers match.
           * Does not handle: Candidate equivalence beyond identifier identity.
           * Side effects: Reads the local output array.
           */
          (item) => item.id === candidate.id
        )
      ) {
        selected.push(candidate);
      }
    }
  }

  return selected;
}

/**
 * Summarizes whether resolved partitions completely and unambiguously declare a binding for one demand.
 *
 * Inputs: A demand scope/destination and all precomputed binding resolutions.
 * Outputs: Effective only for complete finite coverage, otherwise conflicting, unresolved, or none.
 * Does not handle: Selecting provider inventory, evaluating runtime conditions, or treating a partial branch winner as exact.
 * Side effects: None.
 */
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
      relevant.every(
        /**
         * Requires every relevant full-scope partition to have a resolved effective outcome.
         *
         * Inputs: One relevant partition.
         * Outputs: True when the partition is effective.
         * Does not handle: Whether the collection covers all condition assignments.
         * Side effects: None.
         */
        (partition) => partition.outcome === "effective"
      ) &&
      selectorsCoverAllConditions(relevant.map(
        /**
         * Extracts a relevant partition's condition selector for complete-branch coverage analysis.
         *
         * Inputs: One relevant binding partition.
         * Outputs: Its applicability selector.
         * Does not handle: Checking that the partition is effective.
         * Side effects: None.
         */
        (partition) => partition.appliesWhen
      ))
    ) {
      return "effective";
    }

    if (relevant.some(
      /**
       * Detects a branch-local winner that cannot alone establish an unconditional demand binding.
       *
       * Inputs: One relevant partition.
       * Outputs: True when that partition is effective.
       * Does not handle: Complete finite-condition coverage.
       * Side effects: None.
       */
      (partition) => partition.outcome === "effective"
    )) {
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

/**
 * Resolves one conservatively grouped binding slot through finite partitioning or overlap grouping.
 *
 * Inputs: Candidates with comparable destination and execution-scope identity.
 * Outputs: An empty sequence for an empty slot, otherwise one resolution using finite or overlapping partitions.
 * Does not handle: Candidate grouping, cross-slot precedence, or candidate mutation.
 * Side effects: Allocates resolution and partition arrays.
 */
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
 * Enumerates bounded finite condition branches before resolving precedence inside each disjoint branch.
 *
 * Inputs: Candidates from one slot with selectors that may contain finite condition clauses.
 * Outputs: Resolved branch partitions, or undefined when conditions or non-condition dimensions cannot be partitioned safely.
 * Does not handle: Unknown conditions, cross-dimension selector overlap, or condition cross-products above the fixed limit.
 * Side effects: Allocates condition-domain and assignment arrays; leaves candidates untouched.
 */
function resolveFiniteConditionPartitions(
  slot: readonly BindingCandidate[],
): readonly BindingResolution["partitions"][number][] | undefined {
  const first = slot[0];
  if (
    first === undefined ||
    slot.some(
      /**
       * Rejects finite branching when a candidate has unknown conditions or differs outside condition clauses.
       *
       * Inputs: One candidate from the slot and the first candidate's selector.
       * Outputs: True when exact branch enumeration would be unsafe.
       * Does not handle: Precedence among candidates that do share finite dimensions.
       * Side effects: None.
       */
      (candidate) =>
        candidate.appliesWhen.condition.kind === "unknown" ||
        !selectorsShareNonConditionDimensions(first.appliesWhen, candidate.appliesWhen),
    )
  ) {
    return undefined;
  }

  const domains = conditionDomains(slot.map(
    /**
     * Projects one candidate to the condition predicate used to build its finite domain.
     *
     * Inputs: One slot candidate.
     * Outputs: Its applicability condition.
     * Does not handle: Selector dimension comparison or condition validation.
     * Side effects: None.
     */
    (candidate) => candidate.appliesWhen.condition
  ));
  const assignments = domains === undefined ? undefined : enumerateConditionAssignments(domains);
  if (domains === undefined || assignments === undefined) {
    return undefined;
  }

  return assignments.map(
    /**
     * Resolves the candidates that apply to one bounded assignment of all observed condition keys.
     *
     * Inputs: One finite condition assignment.
     * Outputs: One binding partition with effective, shadowed, or unresolved selections for that assignment.
     * Does not handle: Assignments that exceeded the global partition limit, which return undefined earlier.
     * Side effects: Allocates an applicable-candidate array and partition object.
     */
    (assignment) => {
    const applicable = slot.filter(
      /**
       * Keeps a candidate whose condition clauses evaluate true under the enclosing finite assignment.
       *
       * Inputs: One slot candidate and the enclosing assignment.
       * Outputs: True when the candidate applies in that branch.
       * Does not handle: Unknown condition predicates, rejected before enumeration.
       * Side effects: None.
       */
      (candidate) =>
        conditionMatchesAssignment(candidate.appliesWhen.condition, assignment),
    );
    const appliesWhen: ScopeSelector = {
      ...first.appliesWhen,
      condition: assignmentCondition(domains, assignment),
    };
    return resolveFiniteConditionPartition(appliesWhen, applicable, slot);
    }
  );
}

/**
 * Resolves precedence for one finite branch and labels every slot candidate as effective, shadowed, unresolved, or inapplicable.
 *
 * Inputs: The branch selector, candidates that apply in it, and all candidates in the slot.
 * Outputs: One complete partition record whose selection list retains all slot candidates in declaration order.
 * Does not handle: Dynamic candidates or empty branches as exact declarations; both yield unresolved selections.
 * Side effects: Allocates a partition and selection records without modifying input arrays.
 */
function resolveFiniteConditionPartition(
  appliesWhen: ScopeSelector,
  applicable: readonly BindingCandidate[],
  slot: readonly BindingCandidate[],
): BindingResolution["partitions"][number] {
  if (applicable.length === 0 || applicable.some(
    /**
     * Detects a branch candidate whose source cannot be represented as an exact binding.
     *
     * Inputs: One candidate applicable to this branch.
     * Outputs: True when its resolution is dynamic.
     * Does not handle: Rank comparison among exact candidates.
     * Side effects: None.
     */
    (candidate) => candidate.resolution === "dynamic"
  )) {
    return {
      appliesWhen,
      outcome: "unresolved",
      selections: slot.map(
        /**
         * Labels every slot candidate relative to an unresolved finite branch.
         *
         * Inputs: One candidate from the full slot.
         * Outputs: An unresolved status for branch members or inapplicable for other candidates.
         * Does not handle: Precedence ranking because dynamic or empty applicability blocks it.
         * Side effects: Allocates one selection record.
         */
        (candidate) => ({
        candidateId: candidate.id,
        status: applicable.some(
          /**
           * Tests whether an enclosing slot candidate is applicable in this branch.
           *
           * Inputs: One applicable candidate and the enclosing slot candidate.
           * Outputs: True for identical candidate identifiers.
           * Does not handle: Candidate semantic equivalence.
           * Side effects: None.
           */
          (current) => current.id === candidate.id
        )
          ? "unresolved"
          : "inapplicable",
      })
      ),
    };
  }

  const resolution = resolvePrecedence(applicable);
  return {
    appliesWhen,
    outcome: resolution.outcome,
    selections: slot.map(
      /**
       * Projects one slot candidate to the precedence status for this finite branch.
       *
       * Inputs: One candidate from the slot.
       * Outputs: Its resolved status, or inapplicable when it does not apply.
       * Does not handle: Precedence computation, performed before projection.
       * Side effects: Allocates one selection record.
       */
      (candidate) => ({
      candidateId: candidate.id,
      status: resolution.statuses.get(candidate.id) ?? "inapplicable",
    })
    ),
  };
}

/**
 * Groups selectors that can be compared under legacy equality before resolving each overlapping group.
 *
 * Inputs: One binding slot that could not be safely expanded into finite condition assignments.
 * Outputs: One partition per equivalent selector group in first-declaration order.
 * Does not handle: Proving that partially overlapping selectors are disjoint; those groups remain unresolved downstream.
 * Side effects: Mutates newly allocated grouping Maps and arrays only.
 */
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
        /**
         * Finds the first malformed-selector group directionally equal to the candidate under historical semantics.
         *
         * Inputs: One existing selector group and the enclosing candidate.
         * Outputs: True when the group's first selector is equivalent to the candidate selector.
         * Does not handle: Canonical selector lookup, which uses the indexed Map branch.
         * Side effects: Reads the group array without changing it.
         */
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
  return groups.map(
    /**
     * Resolves one equivalent-selector group against the complete original slot.
     *
     * Inputs: One grouped selector bucket and the enclosing slot.
     * Outputs: The bucket's binding partition.
     * Does not handle: Group construction or cross-group precedence.
     * Side effects: Delegates partition allocation only.
     */
    (group) => resolvePartition(group.candidates, slot)
  );
}

/**
 * Canonically serializes a selector whose equality dimensions contain no duplicate values.
 *
 * Inputs: One selector already checked for canonical duplicate-free dimensions.
 * Outputs: A JSON key that is equal for order-insensitive equivalent selectors.
 * Does not handle: Noncanonical selectors, which deliberately use legacy directional grouping.
 * Side effects: Allocates sorted copies of selector arrays and a JSON string.
 */
function selectorGroupKey(selector: ScopeSelector): string {
  const values =
    /**
     * Sorts an optional selector value list without mutating the declaration's original array.
     *
     * Inputs: An optional list of selector dimension strings.
     * Outputs: Undefined for an omitted dimension or a freshly sorted copy for a present dimension.
     * Does not handle: Duplicate detection or value validation.
     * Side effects: Allocates a copy for present lists.
     */
    (input: readonly string[] | undefined): readonly string[] | undefined =>
      input === undefined ? undefined : [...input].sort();
  const stage = selector.stage.kind === "exact"
    ? ["exact", ...[...selector.stage.values].sort()]
    : [selector.stage.kind];
  const condition = selector.condition.kind === "all"
    ? [
        "all",
        ...selector.condition.clauses
          .map(
            /**
             * Projects a condition clause to its canonical comparison tuple.
             *
             * Inputs: One equality or inequality clause.
             * Outputs: A key/operator/value tuple used solely for selector-key serialization.
             * Does not handle: Clause satisfiability or duplicate detection.
             * Side effects: Allocates one small tuple.
             */
            (clause) => [clause.key, clause.operator, clause.value]
          )
          .sort(
            /**
             * Orders clause tuples by their serialized representation for deterministic selector keys.
             *
             * Inputs: Two key/operator/value tuples.
             * Outputs: A locale comparison result for their JSON representations.
             * Does not handle: Semantic condition precedence.
             * Side effects: Serializes temporary tuples for comparison.
             */
            (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))
          ),
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

/**
 * Determines whether selector arrays and clauses are duplicate-free enough for symmetric keyed grouping.
 *
 * Inputs: One selector.
 * Outputs: True when every present dimension and finite clause list contains no duplicate entry.
 * Does not handle: Semantic selector equivalence or satisfiability of conflicting clauses.
 * Side effects: Allocates temporary Sets for duplicate checks.
 */
function selectorIsCanonical(selector: ScopeSelector): boolean {
  const unique =
    /**
     * Tests one optional selector list for duplicate textual values.
     *
     * Inputs: An optional string list from a selector dimension.
     * Outputs: True for omitted lists and lists whose Set cardinality equals their array length.
     * Does not handle: Sorting or semantic normalization of values.
     * Side effects: Allocates a Set for present lists.
     */
    (values: readonly string[] | undefined): boolean =>
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
    /**
     * Serializes a condition clause so exact duplicate clauses can be counted.
     *
     * Inputs: One condition clause.
     * Outputs: Its deterministic key/operator/value JSON representation.
     * Does not handle: Logically equivalent but textually distinct clauses.
     * Side effects: Allocates one serialized string.
     */
    (clause) => JSON.stringify([clause.key, clause.operator, clause.value]),
  );
  return new Set(clauses).size === clauses.length;
}

/**
 * Resolves one overlapping selector group while retaining uncertainty caused by outside overlaps or dynamic sources.
 *
 * Inputs: Candidates in one equivalent group and every candidate in the enclosing slot.
 * Outputs: An effective/conflicting precedence partition or an unresolved partition with complete selection statuses.
 * Does not handle: Splitting partially overlapping selectors into finite condition branches.
 * Side effects: Allocates selection and status records; throws only for the impossible empty-group invariant violation.
 */
function resolvePartition(
  applicable: readonly BindingCandidate[],
  slot: readonly BindingCandidate[],
): BindingResolution["partitions"][number] {
  const first = applicable[0];
  if (first === undefined) {
    throw new Error("Binding partition cannot be empty");
  }

  const overlappingElsewhere = slot.some(
    /**
     * Detects a slot candidate outside this group whose selector can overlap the group's first selector.
     *
     * Inputs: One slot candidate and the enclosing group.
     * Outputs: True when an out-of-group candidate may execute in the same selector region.
     * Does not handle: Exact finite branch subdivision.
     * Side effects: Reads the group and selector facts.
     */
    (candidate) =>
      !applicable.some(
        /**
         * Determines whether the enclosing slot candidate is already inside this equivalent group.
         *
         * Inputs: One group member and the enclosing slot candidate.
         * Outputs: True for matching candidate identifiers.
         * Does not handle: Semantic candidate equality.
         * Side effects: None.
         */
        (current) => current.id === candidate.id
      ) &&
      selectorsMayOverlap(candidate.appliesWhen, first.appliesWhen),
  );

  if (
    overlappingElsewhere ||
    first.appliesWhen.condition.kind === "unknown" ||
    applicable.some(
      /**
       * Detects a dynamic source that prevents this group from naming an exact binding winner.
       *
       * Inputs: One applicable group candidate.
       * Outputs: True when its binding resolution is dynamic.
       * Does not handle: Exact-candidate precedence.
       * Side effects: None.
       */
      (candidate) => candidate.resolution === "dynamic"
    )
  ) {
    return {
      appliesWhen: first.appliesWhen,
      outcome: "unresolved",
      selections: slot.map(
        /**
         * Labels slot candidates when outside overlap, unknown conditions, or dynamic sources make the group unresolved.
         *
         * Inputs: One candidate in the enclosing slot.
         * Outputs: Unresolved for group members and inapplicable otherwise.
         * Does not handle: Selecting a precedence winner.
         * Side effects: Allocates one selection record.
         */
        (candidate) => ({
        candidateId: candidate.id,
        status: applicable.some(
          /**
           * Checks whether a slot candidate belongs to the unresolved group.
           *
           * Inputs: One applicable group member and the enclosing slot candidate.
           * Outputs: True when identifiers match.
           * Does not handle: Candidate equivalence beyond identifiers.
           * Side effects: None.
           */
          (current) => current.id === candidate.id
        )
          ? "unresolved"
          : "inapplicable",
      })
      ),
    };
  }

  const resolution = resolvePrecedence(applicable);
  return {
    appliesWhen: first.appliesWhen,
    outcome: resolution.outcome,
    selections: slot.map(
      /**
       * Emits each slot candidate's resolved precedence status for this group.
       *
       * Inputs: One candidate from the enclosing slot.
       * Outputs: The computed effective/shadowed status or inapplicable when absent from the group.
       * Does not handle: Computing rank order; resolvePrecedence already did so.
       * Side effects: Allocates one selection record.
       */
      (candidate) => {
      const status = resolution.statuses.get(candidate.id);
      return {
        candidateId: candidate.id,
        status: status ?? "inapplicable",
      };
      }
    ),
  };
}

/**
 * Chooses a unique highest comparable precedence rank or marks every competing candidate conflicting.
 *
 * Inputs: One nonempty set of candidates applicable to the same selector partition.
 * Outputs: An effective outcome with one winner and shadowed losers, or a conflicting outcome with every candidate conflicting.
 * Does not handle: Dynamic candidates, selector overlap, or tie-breaking by declaration order.
 * Side effects: Allocates status Maps and a sorted candidate copy; never reorders the supplied array.
 */
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
      /**
       * Detects a candidate whose adapter cannot compare it in a total precedence order.
       *
       * Inputs: One partition candidate.
       * Outputs: True when rank comparison is unavailable.
       * Does not handle: Rank ties among comparable candidates.
       * Side effects: None.
       */
      (candidate) => !candidate.precedence.comparable || candidate.precedence.rank === undefined,
    )
  ) {
    return {
      outcome: "conflicting",
      statuses: new Map(candidates.map(
        /**
         * Labels a candidate conflicting when the adapter cannot compare the partition.
         *
         * Inputs: One partition candidate.
         * Outputs: Its identifier with the conflicting status.
         * Does not handle: Selecting or shadowing a winner.
         * Side effects: Feeds the newly allocated status Map.
         */
        (candidate) => [candidate.id, "conflicting"]
      )),
    };
  }

  const sorted = [...candidates].sort(
    /**
     * Orders comparable candidates from highest to lowest declared precedence rank.
     *
     * Inputs: Two candidates with defined comparable ranks.
     * Outputs: A numeric descending-rank comparison.
     * Does not handle: Stable tie-breaking; a tie is reported conflicting below.
     * Side effects: Sorts the newly copied candidate array in place.
     */
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
      statuses: new Map(candidates.map(
        /**
         * Labels every candidate conflicting when no unique precedence winner exists.
         *
         * Inputs: One candidate from a tied or structurally invalid partition.
         * Outputs: Its identifier with the conflicting status.
         * Does not handle: Arbitrary declaration-order tie-breaking.
         * Side effects: Feeds the newly allocated status Map.
         */
        (candidate) => [candidate.id, "conflicting"]
      )),
    };
  }

  return {
    outcome: "effective",
    statuses: new Map(
      sorted.map(
        /**
         * Labels the unique winner effective and all lower-ranked candidates shadowed.
         *
         * Inputs: One candidate in descending precedence order and the selected winner.
         * Outputs: Its identifier/status pair.
         * Does not handle: Candidate applicability outside this partition.
         * Side effects: Feeds the newly allocated status Map.
         */
        (candidate) => [
        candidate.id,
        candidate.id === winner.id ? "effective" : "shadowed",
      ]
      ),
    ),
  };
}

/**
 * Compares every selector dimension other than its condition predicate for exact set equality.
 *
 * Inputs: Two selectors.
 * Outputs: True when their unit, phase, stage, and channel dimensions are exactly equal.
 * Does not handle: Condition comparison, overlap, or omitted-dimension wildcard semantics.
 * Side effects: None.
 */
function selectorsShareNonConditionDimensions(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    sameIdentifierSet(left.executionUnitIds, right.executionUnitIds) &&
    sameStringSet(left.phases, right.phases) &&
    sameStage(left.stage, right.stage) &&
    sameStringSet(left.channels, right.channels)
  );
}

/**
 * Collects the finite observed value domain for each condition key across a selector group.
 *
 * Inputs: Condition predicates from candidates or selectors.
 * Outputs: Deterministically sorted key domains, or undefined when any predicate is unknown.
 * Does not handle: Infinite domains, clause satisfiability, or assignments beyond values explicitly declared.
 * Side effects: Mutates a newly allocated domain Map and per-domain value arrays.
 */
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
    .map(
      /**
       * Freezes a mutable collected domain into an ordered read-only domain record.
       *
       * Inputs: One internal condition-key domain.
       * Outputs: A key plus a frozen sorted copy of its observed values.
       * Does not handle: Additional runtime values absent from the candidate selectors.
       * Side effects: Allocates and freezes a value-array copy.
       */
      (domain) => ({
      key: domain.key,
      values: Object.freeze([...domain.values].sort()),
    })
    )
    .sort(
      /**
       * Orders finite domains by condition key for reproducible assignment enumeration.
       *
       * Inputs: Two normalized condition domains.
       * Outputs: A lexical condition-key comparison.
       * Does not handle: Locale policy or cross-key semantic ordering.
       * Side effects: Sorts the newly allocated mapped array in place.
       */
      (left, right) => left.key.localeCompare(right.key)
    );
}

/**
 * Enumerates each explicit value and an "other" branch for every finite condition key under the partition cap.
 *
 * Inputs: Deterministically ordered finite condition domains.
 * Outputs: Read-only assignment Maps, or undefined before expansion when the next Cartesian product would exceed the cap.
 * Does not handle: Unknown domains, infinite value sets, or partial enumeration after a limit breach.
 * Side effects: Mutates only newly allocated assignment Maps and arrays.
 */
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

/**
 * Converts one finite assignment into clauses describing its exact observed-value or all-other branch.
 *
 * Inputs: Finite condition domains and an assignment selecting one value or undefined for each key.
 * Outputs: An always predicate for no clauses, otherwise equality and inequality clauses for the assignment.
 * Does not handle: Simplifying contradictory clauses or representing values outside the collected finite domains.
 * Side effects: Mutates a newly allocated clause array.
 */
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

/**
 * Evaluates a known finite condition predicate against one symbolic condition assignment.
 *
 * Inputs: A condition predicate and an assignment mapping keys to selected values or other branches.
 * Outputs: True when all clauses permit the assignment; false for unknown predicates or failed clauses.
 * Does not handle: Runtime environment evaluation or values not represented by the symbolic assignment.
 * Side effects: None.
 */
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
  return condition.clauses.every(
    /**
     * Checks one equality or inequality clause against its selected symbolic value.
     *
     * Inputs: One condition clause and the enclosing assignment.
     * Outputs: True when the selected value satisfies the clause.
     * Does not handle: Unknown predicates, which return false before clause traversal.
     * Side effects: Reads the immutable assignment Map.
     */
    (clause) => {
    const selected = assignment.get(clause.key);
    return clause.operator === "equals"
      ? selected === clause.value
      : selected !== clause.value;
    }
  );
}

/**
 * Proves that selectors collectively cover every bounded assignment of their observed condition domains.
 *
 * Inputs: Selectors whose non-condition dimensions have already been constrained by the caller.
 * Outputs: True only when finite assignments can be enumerated and at least one selector matches each assignment.
 * Does not handle: Unknown conditions, unbounded cross-products, or non-condition dimension coverage.
 * Side effects: Allocates temporary domains and assignments.
 */
function selectorsCoverAllConditions(selectors: readonly ScopeSelector[]): boolean {
  const domains = conditionDomains(selectors.map(
    /**
     * Projects a selector to its condition predicate for finite-domain collection.
     *
     * Inputs: One selector.
     * Outputs: Its condition predicate.
     * Does not handle: Selector dimensions or condition matching.
     * Side effects: None.
     */
    (selector) => selector.condition
  ));
  const assignments = domains === undefined ? undefined : enumerateConditionAssignments(domains);
  return (
    assignments !== undefined &&
    assignments.every(
      /**
       * Requires every symbolic assignment to be covered by at least one selector condition.
       *
       * Inputs: One bounded assignment.
       * Outputs: True when some selector condition matches it.
       * Does not handle: Non-condition selector coverage.
       * Side effects: Reads the selector list.
       */
      (assignment) =>
        selectors.some(
          /**
           * Tests one selector's condition against the enclosing assignment.
           *
           * Inputs: One selector and the enclosing finite assignment.
           * Outputs: True when the selector condition matches that assignment.
           * Does not handle: Phase, stage, channel, or execution-unit matching.
           * Side effects: None.
           */
          (selector) => conditionMatchesAssignment(selector.condition, assignment)
        ),
    )
  );
}

/**
 * Compares two selectors for exact equality under Core's order-insensitive finite-set relation.
 *
 * Inputs: Two selectors.
 * Outputs: True when the left selector's non-condition arrays and clauses are directionally accepted by the right selector; canonical duplicate-free selectors make that relation symmetric.
 * Does not handle: Potential overlap, wildcard inclusion, or repairing malformed duplicate arrays whose left-to-right and right-to-left results can differ.
 * Side effects: None.
 */
function selectorsEquivalent(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    selectorsShareNonConditionDimensions(left, right) &&
    sameCondition(left.condition, right.condition)
  );
}

/**
 * Tests whether two selectors might apply in a common execution and condition region.
 *
 * Inputs: Two selectors.
 * Outputs: False only for a proven disjoint unit, phase, channel, stage, or condition dimension.
 * Does not handle: Proving full coverage or resolving unknown conditions.
 * Side effects: None.
 */
function selectorsMayOverlap(left: ScopeSelector, right: ScopeSelector): boolean {
  return (
    identifierSetsMayOverlap(left.executionUnitIds, right.executionUnitIds) &&
    stringSetsMayOverlap(left.phases, right.phases) &&
    stringSetsMayOverlap(left.channels, right.channels) &&
    stagesMayOverlap(left.stage, right.stage) &&
    conditionsMayOverlap(left.condition, right.condition)
  );
}

/**
 * Tests a binding selector against a scope for conservative possible applicability without condition evaluation.
 *
 * Inputs: A selector and an execution scope.
 * Outputs: False for proven dimension exclusion and true for possible stage overlap.
 * Does not handle: Conditional predicate truth or full stage coverage.
 * Side effects: None.
 */
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

/**
 * Tests whether a binding selector covers an entire demand scope after excluding unknown conditions.
 *
 * Inputs: A selector and an execution scope.
 * Outputs: True when the selector may affect the scope, has a known condition, and covers the complete stage predicate.
 * Does not handle: Conditional branch completeness or runtime condition values.
 * Side effects: Allocates a temporary scope object for the shared scope-coverage relation.
 */
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

/**
 * Compares selector stage predicates for exact kind and order-insensitive exact-stage membership.
 *
 * Inputs: Two selector stage predicates.
 * Outputs: True when kinds match and exact-stage values form the same set.
 * Does not handle: Stage overlap or coverage between all and exact predicates.
 * Side effects: None.
 */
function sameStage(left: ScopeSelector["stage"], right: ScopeSelector["stage"]): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== "exact" || right.kind !== "exact") {
    return true;
  }
  return sameIdentifierSet(left.values, right.values);
}

/**
 * Compares finite condition predicates as order-insensitive lists of exact clauses.
 *
 * Inputs: Two condition predicates.
 * Outputs: True for same kind and, for finite predicates, equal clause counts with every left clause present on the right.
 * Does not handle: Logical equivalence between syntactically different clauses or contradictory predicates.
 * Side effects: None.
 */
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
  return left.clauses.every(
    /**
     * Requires one left clause to have a textually identical clause in the right predicate.
     *
     * Inputs: One left condition clause.
     * Outputs: True when any right clause has the same key, operator, and value.
     * Does not handle: Clause multiplicity beyond the enclosing equal-length check.
     * Side effects: Reads the right clause list.
     */
    (clause) =>
      right.clauses.some(
        /**
         * Compares a right clause to the enclosing left clause field by field.
         *
         * Inputs: One right clause and the enclosing left clause.
         * Outputs: True for exact textual clause equality.
         * Does not handle: Semantic simplification or aliases.
         * Side effects: None.
         */
        (candidate) =>
          candidate.key === clause.key &&
          candidate.operator === clause.operator &&
          candidate.value === clause.value,
      ),
  );
}

/**
 * Tests whether two finite condition predicates could both be satisfied by at least one assignment.
 *
 * Inputs: Two condition predicates.
 * Outputs: False only for a direct same-key equality conflict or equality/inequality exclusion; true otherwise, including unknowns.
 * Does not handle: Full SAT solving across compound conditions or runtime value discovery.
 * Side effects: None.
 */
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

/**
 * Compares optional safe-identifier selector lists using the shared string-set equality relation.
 *
 * Inputs: Two optional candidate-identifier lists.
 * Outputs: True when both omission states and all listed identifiers match as arrays of set members.
 * Does not handle: Identifier normalization or duplicate removal.
 * Side effects: None.
 */
function sameIdentifierSet(
  left: readonly BindingCandidate["id"][] | undefined,
  right: readonly BindingCandidate["id"][] | undefined,
): boolean {
  return sameStringSet(left, right);
}

/**
 * Compares optional string arrays as equal-length, order-insensitive membership collections.
 *
 * Inputs: Two optional arrays of the same string subtype.
 * Outputs: True for two omitted arrays or equal-length arrays where every left value appears on the right; malformed duplicate left values can therefore make the relation directional.
 * Does not handle: Duplicate normalization, case folding, wildcard semantics, or symmetric set equality for malformed arrays.
 * Side effects: None.
 */
function sameStringSet<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.length === right.length && left.every(
    /**
     * Requires a left-hand selector value to occur in the right-hand selector list.
     *
     * Inputs: One value from the left array.
     * Outputs: True when the right array contains that value.
     * Does not handle: Array length, checked by the enclosing expression.
     * Side effects: Reads the right array.
     */
    (value) => right.includes(value)
  );
}

/**
 * Tests optional candidate-identifier lists for wildcard or concrete-member overlap.
 *
 * Inputs: Two optional candidate-identifier selector lists.
 * Outputs: True when either list is omitted or they share at least one identifier.
 * Does not handle: Identifier aliases or full selector comparison.
 * Side effects: None.
 */
function identifierSetsMayOverlap(
  left: readonly BindingCandidate["id"][] | undefined,
  right: readonly BindingCandidate["id"][] | undefined,
): boolean {
  return stringSetsMayOverlap(left, right);
}

/**
 * Tests optional string arrays for wildcard or concrete-member overlap.
 *
 * Inputs: Two optional arrays of the same string subtype.
 * Outputs: True when either omission acts as unconstrained or when a left value appears on the right.
 * Does not handle: Case normalization, duplicate removal, or set equality.
 * Side effects: None.
 */
function stringSetsMayOverlap<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  return left === undefined || right === undefined || left.some(
    /**
     * Finds one concrete left-side value shared by the right-side selector list.
     *
     * Inputs: One value from the left selector list.
     * Outputs: True when the right selector list contains it.
     * Does not handle: Omitted wildcard lists, handled before traversal.
     * Side effects: Reads the right selector list.
     */
    (value) => right.includes(value)
  );
}
