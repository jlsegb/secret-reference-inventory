import type { ExplainCommand } from "../cli/types.js";
import { SafeFactFactory, type SafeIdentifier, type SafePath } from "../safety/index.js";

import { AppError } from "./types.js";

/**
 * Safely explains a previously rendered JSON report. The report is untrusted
 * input, so this re-validates every displayed identifier/path instead of
 * deserializing it into Core facts.
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

function explainKey(name: SafeIdentifier, input: Record<string, unknown>, factory: SafeFactFactory): string {
  if (!Array.isArray(input.groups)) {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }
  const group = input.groups
    .map(asRecord)
    .find((candidate) => isEnvironmentGroup(candidate, name, factory));
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

function explainDynamic(id: SafeIdentifier, input: Record<string, unknown>, factory: SafeFactFactory): string {
  if (!Array.isArray(input.dynamicLookups)) {
    throw new AppError("APP_EXPLAIN_REPORT_INVALID");
  }
  const lookup = input.dynamicLookups
    .map(asRecord)
    .find((candidate) => candidate !== undefined && factory.genericIdentifier(candidate.id) === id);
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

function isEnvironmentGroup(
  group: Record<string, unknown> | undefined,
  name: SafeIdentifier,
  factory: SafeFactFactory,
): boolean {
  const key = group === undefined ? undefined : asRecord(group.key);
  return key?.namespace === "env" && factory.environmentKey(key.name) === name;
}

function appendSafeSources(lines: string[], input: unknown, factory: SafeFactFactory): void {
  if (!Array.isArray(input)) {
    return;
  }
  const sources = input.map(asRecord).filter(isRecord).flatMap((source) => {
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

function safeReportPath(value: unknown, factory: SafeFactFactory): SafePath | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return factory.rootRelativePath(value);
}

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

function safeEnum(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
