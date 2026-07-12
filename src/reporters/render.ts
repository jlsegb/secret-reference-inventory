import type {
  JsonAxes,
  JsonDynamicLookup,
  JsonLocation,
  JsonReason,
  JsonReferenceGroup,
  JsonScope,
  JsonSourceOccurrence,
  JsonUse,
  ReportingInput,
  ExplainSelector,
  SarifLog,
  SarifResult,
  SarifRule,
} from "./types.js";
import { SARIF_SCHEMA_VERSION } from "./types.js";
import { buildExplainReport, buildJsonReport } from "./model.js";

const SARIF_RULES: readonly SarifRule[] = [
  {
    id: "SRI001",
    name: "inventory-listed-no-static-read",
    shortDescription: { text: "Inventory-listed resource has no compatible static code read" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI002",
    name: "missing-provisioning-evidence",
    shortDescription: { text: "Code demand lacks compatible local provisioning evidence" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI003",
    name: "inconclusive-secret-usage",
    shortDescription: { text: "Scoped uncertainty prevents a secret-usage conclusion" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI004",
    name: "dynamic-environment-lookup",
    shortDescription: { text: "Dynamic environment-key lookup requires review" },
    defaultConfiguration: { level: "note" },
  },
  {
    id: "SRI005",
    name: "user-controlled-environment-lookup",
    shortDescription: { text: "User-controlled input can select an environment key" },
    defaultConfiguration: { level: "warning" },
  },
];

/** Deterministic, human-readable summary with source and dynamic sections. */
export function renderTerminal(input: ReportingInput): string {
  const report = buildJsonReport(input);
  const lines: string[] = ["Secret reference inventory", ""];

  if (report.groups.length === 0) {
    lines.push("No named source or bound-inventory references found.");
  } else {
    const rows = report.groups.flatMap((group) =>
      group.uses.map((use, index) => [
        index === 0 ? formatKey(group.key) : "",
        use.scope === undefined ? "<unscoped>" : formatScope(use.scope),
        group.shared ? "shared" : "",
        use.targetDiscovery,
        use.demand,
        use.binding,
        use.inventory,
        use.coverage,
        use.constraint,
        use.disposition,
      ]),
    );
    lines.push(
      renderTable(
        [
          "Reference",
          "Consumer",
          "Use",
          "Target",
          "Demand",
          "Binding",
          "Inventory",
          "Coverage",
          "Constraint",
          "Disposition",
        ],
        rows,
      ),
    );

    const groupsWithSources = report.groups.filter((group) => group.sources.length > 0);
    if (groupsWithSources.length > 0) {
      lines.push("", "Sources");
      for (const group of groupsWithSources) {
        lines.push(`  ${formatKey(group.key)}`);
        for (const source of group.sources) {
          lines.push(`    ${formatLocation(source.location)} (${source.referenceId})`);
        }
      }
    }
  }

  if (report.dynamicLookups.length > 0) {
    lines.push("", "Dynamic environment lookups");
    for (const lookup of report.dynamicLookups) {
      lines.push(`  ${formatScope(lookup.scope)}`);
      if (lookup.sources[0] !== undefined) {
        lines.push(`    at ${formatLocation(lookup.sources[0].location)}`);
      }
      if (lookup.domain.kind === "unbounded") {
        const origin = lookup.origin === "user-controlled" ? "user-controlled" : "unbounded";
        lines.push(`    ${origin} environment lookup; no key names inferred`);
      } else {
        lines.push(`    ${lookup.domain.kind} lookup ${lookup.domain.display}`);
        lines.push(
          `    likely keys: ${
            lookup.likelyKeys.length === 0
              ? "none"
              : lookup.likelyKeys.map(formatKey).join(", ")
          }`,
        );
      }
      lines.push(`    disposition: ${lookup.disposition}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Versioned, deterministic JSON; the object has no source text or values. */
export function renderJson(input: ReportingInput): string {
  return `${JSON.stringify(buildJsonReport(input), null, 2)}\n`;
}

/** Standard SARIF 2.1.0 for review tooling. */
export function buildSarif(input: ReportingInput): SarifLog {
  const report = buildJsonReport(input);
  const results: SarifResult[] = [];

  for (const group of report.groups) {
    for (const use of group.uses) {
      const finding = sarifFindingForUse(group, use);
      if (finding === undefined) {
        continue;
      }
      results.push({
        ruleId: finding.ruleId,
        level: finding.level,
        message: { text: finding.message },
        ...sarifLocations(group.sources),
        properties: {
          axes: axesFromUse(use),
          ...(use.scope === undefined ? {} : { scope: use.scope }),
          key: group.key,
          ...(use.inventorySnapshot === undefined
            ? {}
            : { inventorySnapshot: use.inventorySnapshot }),
          reasons: use.reasons,
        },
      });
    }
  }

  for (const lookup of report.dynamicLookups) {
    results.push(sarifDynamicResult(lookup));
  }

  return {
    version: SARIF_SCHEMA_VERSION,
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "secret-reference-inventory",
            informationUri: "https://github.com/openai/secret-reference-inventory",
            rules: SARIF_RULES,
          },
        },
        results: results.sort(compareSarifResult),
      },
    ],
  };
}

export function renderSarif(input: ReportingInput): string {
  return `${JSON.stringify(buildSarif(input), null, 2)}\n`;
}

/** Explain a pre-sanitized key/dynamic selector without ever echoing raw input. */
export function renderExplain(input: ReportingInput, selector: ExplainSelector): string {
  const explanation = buildExplainReport(input, selector);
  if (explanation === undefined) {
    return "No safe matching fact found.\n";
  }

  const lines = [explanation.heading, "", "Axes"];
  for (const axes of explanation.axes) {
    lines.push(
      `  demand=${axes.demand} binding=${axes.binding} inventory=${axes.inventory} coverage=${axes.coverage} disposition=${axes.disposition}`,
    );
  }

  if (explanation.sources.length > 0) {
    lines.push("", "Sources");
    for (const source of explanation.sources) {
      lines.push(`  ${formatLocation(source.location)} (${source.referenceId})`);
    }
  }

  if (explanation.dynamic !== undefined) {
    lines.push("", "Dynamic lookup");
    if (explanation.dynamic.domain.kind === "unbounded") {
      lines.push("  unbounded environment lookup; no key names inferred");
    } else {
      lines.push(`  ${explanation.dynamic.domain.kind}: ${explanation.dynamic.domain.display}`);
      lines.push(
        `  likely keys: ${
          explanation.dynamic.likelyKeys.length === 0
            ? "none"
            : explanation.dynamic.likelyKeys.map(formatKey).join(", ")
        }`,
      );
    }
  }

  const evidence = explanation.evidence.filter((item) => item.evidence.length > 0);
  if (evidence.length > 0) {
    lines.push("", "Evidence");
    for (const item of evidence) {
      lines.push(`  ${item.title}`);
      for (const evidenceItem of item.evidence) {
        const locations = evidenceItem.locations.map(formatLocation).join(", ");
        lines.push(
          `    ${evidenceItem.ruleId} / ${evidenceItem.diagnosticCode}${
            locations.length === 0 ? "" : ` at ${locations}`
          }`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function sarifFindingForUse(
  group: JsonReferenceGroup,
  use: JsonUse,
): { readonly ruleId: string; readonly level: "note" | "warning"; readonly message: string } | undefined {
  if (use.inventory === "inventory-listed-no-static-read") {
    return {
      ruleId: "SRI001",
      level: "warning",
      message: `Inventory-listed resource has no compatible static read for ${formatKey(group.key)}.`,
    };
  }
  if (use.inventory === "missing" || use.inventory === "missing-under-declared-model") {
    return {
      ruleId: "SRI002",
      level: "warning",
      message: `Compatible local provisioning evidence is missing for ${formatKey(group.key)}.`,
    };
  }
  if (use.disposition === "inconclusive") {
    return {
      ruleId: "SRI003",
      level: "warning",
      message: `Secret-usage conclusion is inconclusive for ${formatKey(group.key)}.`,
    };
  }
  return undefined;
}

function sarifDynamicResult(lookup: JsonDynamicLookup): SarifResult {
  const unbounded = lookup.domain.kind === "unbounded";
  const userControlled = unbounded && lookup.origin === "user-controlled";
  const ruleId = userControlled ? "SRI005" : "SRI004";
  const level: "note" | "warning" = userControlled || unbounded ? "warning" : "note";
  const message = unbounded
    ? userControlled
      ? "User-controlled input can select an environment key; no key name is inferred."
      : "Unbounded environment-key lookup; no key name is inferred."
    : `Dynamic ${lookup.domain.kind} environment lookup ${lookup.domain.display} has ${lookup.likelyKeys.length} likely key(s).`;

  return {
    ruleId,
    level,
    message: { text: message },
    ...sarifLocations(lookup.sources),
    properties: {
      axes: axesFromDynamic(lookup),
      scope: lookup.scope,
      dynamic: lookup.domain,
      reasons: lookup.reasons,
    },
  };
}

function sarifLocations(
  sources: readonly JsonSourceOccurrence[],
): Pick<SarifResult, "locations"> {
  const locations = sources
    .map((source) => source.location)
    .filter(
      (location, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.path === location.path &&
            candidate.start.line === location.start.line &&
            candidate.start.column === location.start.column,
        ) === index,
    )
    .map((location) => ({
      physicalLocation: {
        artifactLocation: { uri: location.path },
        region: {
          startLine: toSarifCoordinate(location.start.line),
          startColumn: toSarifCoordinate(location.start.column),
          endLine: toSarifCoordinate(location.end.line),
          endColumn: toSarifCoordinate(location.end.column),
        },
      },
    }));
  return locations.length === 0 ? {} : { locations };
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...rows.map(renderRow)].join("\n");
}

function axesFromUse(use: JsonUse): JsonAxes {
  return {
    targetDiscovery: use.targetDiscovery,
    demand: use.demand,
    binding: use.binding,
    inventory: use.inventory,
    coverage: use.coverage,
    constraint: use.constraint,
    disposition: use.disposition,
  };
}

function axesFromDynamic(lookup: JsonDynamicLookup): JsonAxes {
  return {
    targetDiscovery: lookup.targetDiscovery,
    demand: lookup.demand,
    binding: lookup.binding,
    inventory: lookup.inventory,
    coverage: lookup.coverage,
    constraint: lookup.constraint,
    disposition: lookup.disposition,
  };
}

function formatKey(key: { readonly namespace: string; readonly name: string }): string {
  return `${key.namespace}:${key.name}`;
}

function formatScope(scope: JsonScope): string {
  return `${scope.id}/${scope.phase}/${formatStage(scope)}`;
}

function formatStage(scope: JsonScope): string {
  if (scope.stage.kind === "exact") {
    return scope.stage.values?.join(",") || "<none>";
  }
  return scope.stage.kind;
}

function formatLocation(location: JsonLocation): string {
  return `${location.path}:${location.start.line + 1}:${location.start.column + 1}`;
}

function toSarifCoordinate(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value + 1 : 1;
}

function compareSarifResult(left: SarifResult, right: SarifResult): number {
  const rule = left.ruleId.localeCompare(right.ruleId);
  if (rule !== 0) return rule;
  const leftUri = left.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "";
  const rightUri = right.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "";
  const uri = leftUri.localeCompare(rightUri);
  if (uri !== 0) return uri;
  return left.message.text.localeCompare(right.message.text);
}
