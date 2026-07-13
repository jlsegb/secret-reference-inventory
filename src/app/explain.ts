import type { ExplainCommand } from "../cli/types.js";
import { SafeFactFactory, type SafeIdentifier, type SafePath } from "../safety/index.js";

import { AppError } from "./types.js";

/**
 * Produces a terminal explanation for one safe reference selected from an untrusted rendered JSON report.
 *
 * Inputs: A parsed explain command and an unknown report value expected to be ordinary JSON-shaped data.
 * Outputs: A newline-terminated explanation string, or throws `AppError` for unsupported format, selector, or ordinary JSON-shaped invalid report fields.
 * Does not handle: Reading report files, rehydrating Core facts, rendering non-terminal formats, exposing secret values, or containing raw exceptions from exotic objects, Proxies, or getters reached through direct report property access.
 * Side effects: Allocates a `SafeFactFactory` and validates only in-memory report fields.
 */
export function explainRenderedJsonReport(
  command: ExplainCommand,
  input: unknown,
): string {
  if (command.format !== "terminal") {
    throw new AppError("APP_EXPLAIN_FORMAT_UNSUPPORTED");
  }

  const factory = new SafeFactFactory();
  const selector = parseSelector(command.reference, factory);
  if (selector === undefined || !isRecord(input)) {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }

  if (selector.kind === "key") {
    return explainKey(selector.name, input, factory);
  }
  return explainDynamic(selector.id, input, factory);
}

type ExplainSelector =
  | { readonly kind: "key"; readonly name: SafeIdentifier }
  | { readonly kind: "dynamic"; readonly id: SafeIdentifier };

/**
 * Parses the explain command's safe `env:` or `dynamic:` selector.
 *
 * Inputs: The selector string and a fact factory that validates identifier grammar.
 * Outputs: A key/dynamic selector object, or `undefined` for unsupported prefixes or unsafe identifiers.
 * Does not handle: Looking up the selected report fact or accepting raw environment-variable values.
 * Side effects: Uses the supplied factory to normalize and validate an identifier.
 */
function parseSelector(value: string, factory: SafeFactFactory): ExplainSelector | undefined {
  const environmentPrefix = "env:";
  const dynamicPrefix = "dynamic:";
  if (value.startsWith(environmentPrefix)) {
    const name = factory.environmentKey(value.slice(environmentPrefix.length));
    return typeof name === "string" ? { kind: "key", name } : undefined;
  }
  if (value.startsWith(dynamicPrefix)) {
    const id = factory.genericIdentifier(value.slice(dynamicPrefix.length));
    return typeof id === "string" ? { kind: "dynamic", id } : undefined;
  }
  return undefined;
}

/**
 * Renders one environment-key group and its safe axes and source locations.
 *
 * Inputs: A validated environment key, record-shaped report, and identifier/path validation factory.
 * Outputs: A terminal explanation or the fixed no-match sentence; throws `AppError` when `groups` is not an array.
 * Does not handle: Reconciliation, raw source text, or malformed group members that fail its local field checks.
 * Side effects: Builds an in-memory line array and invokes factory validators on candidate report fields.
 */
function explainKey(name: SafeIdentifier, input: Record<string, unknown>, factory: SafeFactFactory): string {
  if (!Array.isArray(input.groups)) {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }
  const group = input.groups
    .map(asRecord)
    .find(/**
     * Selects the first normalized group whose environment key equals the requested safe key.
     *
     * Inputs: One record-shaped group candidate from the parsed report.
     * Outputs: `true` only when the candidate is an `env` group with the requested normalized key.
     * Does not handle: Rendering or accepting malformed group fields.
     * Side effects: Validates the candidate key through the supplied factory.
     */ (candidate) => isEnvironmentGroup(candidate, name, factory));
  if (group === undefined) {
    return "No safe matching fact found.\n";
  }

  const lines = [`Explain env:${name}`, "", "Axes"];
  const uses = Array.isArray(group.uses) ? group.uses.map(asRecord).filter(isRecord) : [];
  for (const use of uses) {
    const axes = safeAxes(use);
    if (axes !== undefined) {
      lines.push(`  demand=${axes.demand} binding=${axes.binding} inventory=${axes.inventory} coverage=${axes.coverage} disposition=${axes.disposition}`);
    }
  }
  appendSafeSources(lines, group.sources, factory);
  return `${lines.join("\n")}\n`;
}

/**
 * Renders one dynamic lookup and its safe domain and source locations.
 *
 * Inputs: A validated dynamic lookup identifier, record-shaped report, and identifier/path validation factory.
 * Outputs: A terminal explanation or the fixed no-match sentence; throws `AppError` for invalid lookup array/domain shapes.
 * Does not handle: Inferring unbounded key names, reading report files, or rendering raw values.
 * Side effects: Builds an in-memory line array and invokes factory validators on lookup fields.
 */
function explainDynamic(id: SafeIdentifier, input: Record<string, unknown>, factory: SafeFactFactory): string {
  if (!Array.isArray(input.dynamicLookups)) {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }
  const lookup = input.dynamicLookups
    .map(asRecord)
    .find(/**
     * Selects the first normalized lookup whose validated identifier equals the requested one.
     *
     * Inputs: One record-or-undefined lookup candidate produced by the preceding map.
     * Outputs: `true` for the requested identifier and `false` for absent or unsafe candidates.
     * Does not handle: Domain validation or rendering.
     * Side effects: Validates a candidate identifier through the supplied factory.
     */ (candidate) => candidate !== undefined && factory.genericIdentifier(candidate.id) === id);
  if (lookup === undefined) {
    return "No safe matching fact found.\n";
  }

  const lines = [`Explain dynamic:${id}`, "", "Dynamic lookup"];
  const domain = asRecord(lookup.domain);
  if (domain?.kind === "unbounded") {
    lines.push("  unbounded environment lookup; no key names inferred");
  } else if (domain?.kind === "finite" || domain?.kind === "pattern") {
    lines.push(`  ${domain.kind} environment lookup`);
  } else {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }
  appendSafeSources(lines, lookup.sources, factory);
  return `${lines.join("\n")}\n`;
}

/**
 * Tests whether an unknown report group safely represents a requested environment key.
 *
 * Inputs: An optional record-shaped group, validated key, and identifier factory.
 * Outputs: `true` only when a nested key has namespace `env` and normalizes to the requested key.
 * Does not handle: Parsing group uses, sources, or non-environment namespaces.
 * Side effects: Validates the nested key value through the supplied factory.
 */
function isEnvironmentGroup(
  group: Record<string, unknown> | undefined,
  name: SafeIdentifier,
  factory: SafeFactFactory,
): boolean {
  const key = group === undefined ? undefined : asRecord(group.key);
  return key?.namespace === "env" && factory.environmentKey(key.name) === name;
}

/**
 * Appends display-safe source rows from an untrusted report field to an existing explanation.
 *
 * Inputs: A mutable line list, unknown `sources` field, and identifier/path validation factory.
 * Outputs: `undefined`; valid source rows are appended after a Sources heading, while invalid rows are omitted.
 * Does not handle: Missing-array errors, raw paths, source content, duplicate removal, or sorting.
 * Side effects: Mutates `lines` and validates report identifiers and root-relative paths.
 */
function appendSafeSources(lines: string[], input: unknown, factory: SafeFactFactory): void {
  if (!Array.isArray(input)) {
    return;
  }
  const sources = input.map(asRecord).filter(isRecord).flatMap(/**
   * Converts one validated source record into a display row only when every location field is safe.
   *
   * Inputs: One record-shaped candidate from the report's source array.
   * Outputs: A one-element safe source row array, or an empty array when any required identifier/path/position is invalid.
   * Does not handle: Recovering partial locations or preserving invalid report values.
   * Side effects: Validates identifiers and paths through the supplied factory.
   */ (source) => {
    const location = asRecord(source.location);
    const referenceId = factory.genericIdentifier(source.referenceId);
    const path = safeReportPath(location?.path, factory);
    const start = asRecord(location?.start);
    const line = typeof start?.line === "number" ? start.line : undefined;
    const column = typeof start?.column === "number" ? start.column : undefined;
    if (
      typeof referenceId !== "string" ||
      path === undefined ||
      line === undefined ||
      column === undefined ||
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 0 ||
      column < 0
    ) {
      return [];
    }
    return [{ referenceId, path, line, column }];
  });
  if (sources.length === 0) {
    return;
  }
  lines.push("", "Sources");
  for (const source of sources) {
    lines.push(`  ${source.path}:${source.line + 1}:${source.column + 1} (${source.referenceId})`);
  }
}

/**
 * Validates one report path as a root-relative display path.
 *
 * Inputs: An unknown path field and a fact factory.
 * Outputs: A safe root-relative path or `undefined` for nonstrings and unsafe paths.
 * Does not handle: Filesystem access, absolute paths, or path existence.
 * Side effects: Invokes the supplied factory's path validator.
 */
function safeReportPath(value: unknown, factory: SafeFactFactory): SafePath | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return factory.rootRelativePath(value);
}

/**
 * Validates the five rendered reconciliation axes needed for a terminal explanation row.
 *
 * Inputs: One record-shaped use entry from an untrusted report.
 * Outputs: A fully validated axis object or `undefined` if any axis is absent or outside its allowlist.
 * Does not handle: Unknown future axis values, report schema migration, or display formatting.
 * Side effects: None.
 */
function safeAxes(value: Record<string, unknown>):
  | {
      readonly demand: string;
      readonly binding: string;
      readonly inventory: string;
      readonly coverage: string;
      readonly disposition: string;
    }
  | undefined {
  const demand = safeEnum(value.demand, ["present", "declaration-only", "finite-dynamic", "pattern-dynamic", "unbounded-user-controlled", "unbounded-unknown", "absent"]);
  const binding = safeEnum(value.binding, ["exact-declared", "possible", "indirect", "conflicting", "unresolved", "no-static-evidence", "external-unknown", "static-constrained", "dynamic", "not-applicable"]);
  const inventory = safeEnum(value.inventory, ["bound", "inventory-listed-no-static-read", "missing", "missing-under-declared-model", "unbound", "unknown"]);
  const coverage = safeEnum(value.coverage, ["complete", "incomplete"]);
  const disposition = safeEnum(value.disposition, ["informational", "review", "inconclusive"]);
  return demand === undefined || binding === undefined || inventory === undefined || coverage === undefined || disposition === undefined
    ? undefined
    : { demand, binding, inventory, coverage, disposition };
}

/**
 * Accepts a string only when it is one of the caller-provided display allowlist values.
 *
 * Inputs: An unknown report value and immutable allowed string values.
 * Outputs: The original string or `undefined` when it is nonstring or disallowed.
 * Does not handle: Case folding, aliases, coercion, or user-defined enum objects.
 * Side effects: None.
 */
function safeEnum(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

/**
 * Narrows an unknown value to a non-null, non-array object record.
 *
 * Inputs: Any JavaScript value.
 * Outputs: A type predicate for object records.
 * Does not handle: Prototype safety, property validation, or class-instance semantics.
 * Side effects: None.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts an unknown value to a record only through the local structural guard.
 *
 * Inputs: Any JavaScript value.
 * Outputs: The record value or `undefined` when the guard rejects it.
 * Does not handle: Deep validation or cloning.
 * Side effects: None.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
