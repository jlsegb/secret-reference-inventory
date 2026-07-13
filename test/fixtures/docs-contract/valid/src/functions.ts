/**
 * Returns a named result for fixture validation.
 *
 * Inputs: A string label.
 * Outputs: The supplied label.
 * Does not handle: Input normalization.
 * Side effects: None.
 */
export function named(label: string): string {
  return label;
}

export class DocumentedClass {
  /**
   * Creates a documented fixture instance.
   *
   * Inputs: A string label.
   * Outputs: An initialized fixture instance.
   * Does not handle: Label validation.
   * Side effects: Stores the label on the instance.
   */
  public constructor(private label: string) {}

  /**
   * Reads the fixture label.
   *
   * Inputs: None.
   * Outputs: The current label.
   * Does not handle: Label transformation.
   * Side effects: None.
   */
  public get value(): string {
    return this.label;
  }

  /**
   * Replaces the fixture label.
   *
   * Inputs: A replacement string.
   * Outputs: No return value.
   * Does not handle: Label validation.
   * Side effects: Mutates the instance label.
   */
  public set value(label: string) {
    this.label = label;
  }

  /**
   * Joins the fixture label with a suffix.
   *
   * Inputs: A suffix string.
   * Outputs: A combined string.
   * Does not handle: Suffix normalization.
   * Side effects: None.
   */
  public join(suffix: string): string {
    return `${this.label}-${suffix}`;
  }
}

export const objectValue = {
  /**
   * Returns the supplied value from an object method.
   *
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  method(value: string): string {
    return value;
  },
  callback:
    /**
     * Returns the supplied value from an object callback.
     *
     * Inputs: A string value.
     * Outputs: The supplied value.
     * Does not handle: Value normalization.
     * Side effects: None.
     */
    (value: string): string => value,
};

export const expression =
  /**
   * Returns an anonymous function-expression fixture value.
   *
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  function (value: string): string {
  return value;
};

export const arrow =
  /**
   * Returns an anonymous arrow-function fixture value.
   *
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  (value: string): string => value;

export default
  /**
   * Returns an anonymous default-export fixture value.
   *
   * Inputs: A string value.
   * Outputs: The supplied value.
   * Does not handle: Value normalization.
   * Side effects: None.
   */
  (value: string): string => value;

/**
 * Maps values through a documented nested callback.
 *
 * Inputs: A list of string values.
 * Outputs: The same values in a new list.
 * Does not handle: Value normalization.
 * Side effects: Allocates a new list.
 */
export function nested(values: readonly string[]): string[] {
  return values.map(
    /**
     * Returns one nested callback value.
     *
     * Inputs: A string value.
     * Outputs: The supplied value.
     * Does not handle: Value normalization.
     * Side effects: None.
     */
    function nestedCallback(value: string): string {
      return value;
    },
  );
}

export interface TypeOnlyContract {
  run(value: string): string;
}
