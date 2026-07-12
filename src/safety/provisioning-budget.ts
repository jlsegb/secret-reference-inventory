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

export function createProvisioningBudget(): ProvisioningBudget {
  return {
    rawRemaining: MAX_PROVISIONING_RAW_ENTRIES,
    normalizedRemaining: MAX_PROVISIONING_NORMALIZED_ENTRIES,
    overflowed: false,
  };
}

/** Reserve parser-observed structural entries before indexing an input array. */
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

/** Reserve every retained fact, selector, diagnostic, or coverage gap. */
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
 * Do not use iteration helpers on repository-controlled arrays. Reading a
 * bounded length first means an oversized sparse array cannot invoke a getter
 * at the first out-of-budget index.
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
 * A non-materializing structural preflight for public fact builders and
 * attested JSON. It uses an explicit stack and indexed arrays, never
 * `Object.values`, spread, `entries`, or `every` over repository data.
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
