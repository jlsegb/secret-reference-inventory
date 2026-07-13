/**
 * Hard upper bounds for local provisioning documents. These limits are kept
 * below the workspace graph budget so a single adapter document can never
 * create an unbounded intermediate fact graph before workspace admission.
 */
export const MAX_PROVISIONING_RAW_ENTRIES = 100_000;
export const MAX_PROVISIONING_NORMALIZED_ENTRIES = 100_000;
export const MAX_CLOSED_MODEL_FINITE_KEYS = 100;

export interface ProvisioningBudget {
  rawRemaining: number;
  normalizedRemaining: number;
  overflowed: boolean;
}

/**
 * Starts independent raw-input and retained-fact quotas for one provisioning parse.
 *
 * Inputs: No explicit parameters.
 * Outputs: A mutable budget at both module limits with no overflow latched.
 * Does not handle: Sharing limits across operations, parsing inputs, or materializing facts.
 * Side effects: Allocates and returns a new object; it does not touch caller-owned state.
 */
export function createProvisioningBudget(): ProvisioningBudget {
  return {
    rawRemaining: MAX_PROVISIONING_RAW_ENTRIES,
    normalizedRemaining: MAX_PROVISIONING_NORMALIZED_ENTRIES,
    overflowed: false,
  };
}

/**
 * Claims raw traversal capacity and permanently marks this budget unusable after an invalid or excessive claim.
 *
 * Inputs: A mutable per-operation budget and requested raw-entry count.
 * Outputs: True after subtracting a valid count; false after latching `overflowed`.
 * Does not handle: Validating individual entries or reserving normalized output capacity.
 * Side effects: Mutates `rawRemaining` or `overflowed` on the supplied budget.
 */
export function reserveProvisioningRawEntries(
  budget: ProvisioningBudget,
  count: number,
): boolean {
  if (
    budget.overflowed ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > budget.rawRemaining
  ) {
    budget.overflowed = true;
    return false;
  }
  budget.rawRemaining -= count;
  return true;
}

/**
 * Claims capacity for normalized facts and latches the supplied budget on an invalid or excessive claim.
 *
 * Inputs: A mutable per-operation budget and requested normalized-entry count.
 * Outputs: True after subtracting `count` (one by default); false after latching `overflowed`.
 * Does not handle: Building the normalized facts or reserving raw traversal capacity.
 * Side effects: Mutates `normalizedRemaining` or `overflowed` on the supplied budget.
 */
export function reserveProvisioningNormalizedEntries(
  budget: ProvisioningBudget,
  count = 1,
): boolean {
  if (
    budget.overflowed ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > budget.normalizedRemaining
  ) {
    budget.overflowed = true;
    return false;
  }
  budget.normalizedRemaining -= count;
  return true;
}

/**
 * Admits an array only after reserving its declared length, before any indexed element is read.
 *
 * Inputs: An unknown potential array and the operation's mutable budget.
 * Outputs: The original array when its length fits the raw quota, otherwise undefined.
 * Does not handle: Traversing array elements, validating contents, or defending a later getter read.
 * Side effects: Reads `Array.isArray`/length and mutates the supplied raw-budget counters.
 */
export function reserveProvisioningArray(
  input: unknown,
  budget: ProvisioningBudget,
): readonly unknown[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return reserveProvisioningRawEntries(budget, input.length) ? input : undefined;
}

/**
 * Performs a structural preflight with bounded arrays and individual own-object field lists in one provisioning value.
 *
 * Inputs: An unknown provisioning value rooted at an array, object, or primitive.
 * Outputs: True when traversal finishes, every encountered array fits the shared raw-array quota, and every encountered object has at most the own-field cap; false for a rejected array, overlarge individual object, or thrown property access.
 * Does not handle: A whole-graph object-field quota, cycle detection, or bounded inherited-key traversal. Object field counts reset per object, and a cyclic object graph may not terminate; `for...in` enumerates inherited enumerable keys without charging them to the own-field cap, which is an unbounded resource exposure requiring separate hardening. It also does not validate schema/normalized output or create a stable getter-backed snapshot.
 * Side effects: Allocates a work stack, enumerates enumerable properties (including inherited ones), and reads array/own-object values, which can invoke getters; it mutates only its private budget.
 */
export function provisioningInputFitsBudget(input: unknown): boolean {
  const budget = createProvisioningBudget();
  const pending: unknown[] = [input];

  try {
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== "object") {
        continue;
      }
      if (Array.isArray(value)) {
        if (!reserveProvisioningRawEntries(budget, value.length)) {
          return false;
        }
        for (let index = value.length - 1; index >= 0; index -= 1) {
          pending.push(value[index]);
        }
        continue;
      }

      let fieldCount = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          continue;
        }
        fieldCount += 1;
        if (fieldCount > MAX_PROVISIONING_RAW_ENTRIES) {
          return false;
        }
        pending.push((value as Record<string, unknown>)[key]);
      }
    }
  } catch {
    return false;
  }

  return true;
}
