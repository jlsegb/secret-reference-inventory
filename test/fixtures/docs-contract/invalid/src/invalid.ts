export function intentionallyPrivateFunctionName(): string {
  return "do-not-report-this-source-text";
}

export const missingOutputs =
  /**
   * Demonstrates a missing structured output section.
   *
   * Inputs: A string value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  (value: string): string => value;

export const missingPurpose =
  /**
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  (value: string): string => value;

/**
 * Is deliberately separated from its function to test strict attachment.
 *
 * Inputs: A string value.
 * Outputs: The supplied value.
 * Does not handle: Value normalization.
 * Side effects: None.
 */

export const detachedDocumentation = (value: string): string => value;

/**
 * Documents a variable container rather than its arrow function.
 *
 * Inputs: A string value.
 * Outputs: The supplied value.
 * Does not handle: Value normalization.
 * Side effects: None.
 */
export const documentedVariableContainer = (value: string): string => value;

export const documentedPropertyContainer = {
  /**
   * Documents a property container rather than its arrow function.
   *
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  callback: (value: string): string => value,
};

/**
 * Documents an export container rather than its arrow function.
 *
 * Inputs: A string value.
 * Outputs: The supplied value.
 * Does not handle: Value normalization.
 * Side effects: None.
 */
export default (value: string): string => value;

/**
 * Describes an ambiguous object rather than one function.
 *
 * Inputs: None.
 * Outputs: An object value.
 * Does not handle: Object member documentation.
 * Side effects: None.
 */
export const ambiguous = {
  first: (): string => "first",
  second: (): string => "second",
};
